/**
 * Sitemap URL construction and XML rendering — shared by property-pub (which
 * serves sitemaps) and bizchat (which pre-generates them nightly).
 *
 * ── Why this is a shared package and not a copy ────────────────────────────
 * Both services must agree, byte for byte, on which URLs an advertiser's sitemap
 * advertises. property-pub falls back to building a sitemap live when the
 * pre-generated file is missing, so the two paths render the SAME document for
 * the same advertiser — a divergence would mean the sitemap changes shape
 * depending on whether the cron happened to have run.
 *
 * siteModePropertyScope.js in this same package carries the cautionary tale: that
 * predicate WAS copied between the two services, the copy went stale against a
 * retired table, and the nightly manifests silently disagreed with the live site
 * about what an advertiser publishes. A sitemap built from a stale URL rule is the
 * same bug one layer out — it advertises pages the server then 404s.
 *
 * ── What lives here vs. what stays in property-pub ─────────────────────────
 * Here: pure functions of (advertiser, manifests) → URLs → XML. No filesystem, no
 * database, no request. The manifest READER is injected, because the two services
 * resolve the uploads path differently.
 *
 * Not here: reading files, counting properties, robots.txt, and the request-time
 * plumbing — those stay in property-pub's src/ssr/sitemap.js.
 */

import { createSlug } from '@4prop/seo-enhance/seoCreateSlug';
import { resolveSummaryFilename } from '@4prop/seo-enhance/locations/manifest';
import { resolveTypes } from '@4prop/seo-enhance/locations/types';
import { getListingVariantSlugForPropertyType } from '@4prop/seo-enhance/navTarget';

/** Tenure key in the manifest → the URL suffix the route gate accepts. */
export const TENURE_SUFFIX = { rent: '-for-rent', sale: '-for-sale' };

/**
 * URLs per detail SHARD.
 *
 * The spec's hard limits are 50,000 URLs and 50MB per file. 25,000 is half that,
 * deliberately: a `/details/:pid` line is ~70 bytes, so a full shard is ~1.8MB —
 * comfortably inside both bounds with room for pids to grow longer, and small
 * enough that one shard is a quick fetch for a crawler.
 *
 * Shards are numbered from 1 and sliced from a pid list ordered NEWEST FIRST, so
 * shard 1 holds the most recently added properties. A crawler that only ever gets
 * through the first shard still sees the freshest stock.
 *
 * CHANGING THIS RENUMBERS EVERY SHARD. A pid moves between shards and previously
 * advertised shard URLs may 404, so treat it as a URL-structure change: crawlers
 * re-discover from the index, but not instantly.
 */
export const DETAIL_SHARD_SIZE = 25000;

/**
 * Hard ceiling on properties enumerated per advertiser, across all shards.
 *
 * Not a spec limit — a backstop on the single unbounded input here (one DB query
 * over the whole property table). At 25k per shard this is 40 shards, far beyond
 * anything the current catalogue (~34,000) needs. Exceeding it logs; it should
 * never be reached silently.
 */
export const DETAIL_URL_CAP = 1000000;

/** XML-escape. Only the five predefined entities are legal in XML. */
export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The listing URL set for one advertiser, as `{ loc, lastmod }` rows.
 *
 * Mirrors the shapes the route gate claims (listingRouteGate.js), so every URL
 * emitted here is one that actually renders a listing page with its own head:
 *
 *   /                          the site root
 *   /<type>                    bare type            e.g. /offices
 *   /<type>/<county>           type + location      e.g. /offices/city-of-london
 *   /for-(sale|rent)           bare tenure
 *   /for-(sale|rent)/<county>  tenure + location
 *   /<type>-for-(sale|rent)    type + tenure
 *   /<type>-for-(sale|rent)/<county>
 *
 * Only combinations the manifest reports as NON-EMPTY are emitted, so the sitemap
 * never advertises a page that renders "no results". That is also why the URL set
 * is DERIVED rather than a cross-product of types × locations: the cross-product
 * would be mostly empty pages, which is worse than no sitemap.
 *
 * @param {object}   advertiser        Row with at least `site_mode`.
 * @param {number}   advertiserId
 * @param {string}   origin            Absolute canonical origin, no trailing slash.
 * @param {object}   deps
 * @param {(filename: string) => Promise<object|null>} deps.readManifest
 *        Reads one locations manifest by BASENAME, or null when missing/malformed.
 *        Injected because the two services resolve the uploads path differently.
 * @param {() => Promise<object[]>} deps.getPropertyTypesCatalog
 * @param {() => Promise<string[]>} [deps.readPopularLocationSlugs]
 *        The curated town slugs. Omitted → no town URLs (counties are unaffected).
 * @param {() => Promise<object|null>} [deps.readTownCounts]
 *        The `{ towns: { slug: { tenure: { typeId: n } } } }` payload written by
 *        bizchat's town-counts generator. Omitted or null → town URLs are NOT
 *        gated, i.e. today's behaviour, so a missing file degrades to the status
 *        quo rather than removing every town URL.
 */
export async function buildAdvertiserUrls(advertiser, advertiserId, origin, deps) {
  const {
    readManifest, getPropertyTypesCatalog, readPopularLocationSlugs, readTownCounts,
  } = deps;
  const siteMode = advertiser?.site_mode ?? 'advertiser_site';

  let summary;
  try {
    summary = await readManifest(resolveSummaryFilename(siteMode, advertiserId ?? advertiser?.id));
  } catch {
    summary = null; // advertiser_site with no usable id
  }
  if (!summary) return [];

  const lastmod = typeof summary.generatedAt === 'string'
    ? summary.generatedAt.slice(0, 10)
    : null;

  // typeId → URL slug, for the advertiser's own type set only.
  const typeIds = Array.isArray(summary.typeIds) ? summary.typeIds : [];
  const slugByTypeId = new Map();
  if (typeIds.length) {
    try {
      const propertyTypes = await getPropertyTypesCatalog();
      for (const type of resolveTypes({ typeIds, propertyTypes })) {
        const slug = getListingVariantSlugForPropertyType(type);
        if (slug) slugByTypeId.set(type.id, slug);
      }
    } catch {
      // No catalog → no type URLs. The tenure and root URLs below still stand.
    }
  }

  const urls = new Map(); // path → lastmod, deduped (a path can be reached twice)
  const add = (path) => { if (!urls.has(path)) urls.set(path, lastmod); };

  // slug → per-tenure typeCounts, harvested from the county rows below. The
  // curated location list is not all towns: 4 of the 60 are counties/regions
  // (London, Essex, West Yorkshire, Hampshire) which have no postcode-table row
  // and so are absent from the town-counts file. Gating them against the county
  // rows the manifests ALREADY carry means all 60 are gated, with no second
  // source of truth — a region like London simply sums its sub-counties.
  const countyTypeCounts = new Map(); // slug → { tenure → { typeId: n } }
  const noteCounty = (slug, tenure, typeCounts) => {
    if (!slug || !typeCounts) return;
    const entry = countyTypeCounts.get(slug) ?? {};
    const bucket = entry[tenure] ?? {};
    for (const [typeId, n] of Object.entries(typeCounts)) {
      bucket[typeId] = (Number(bucket[typeId]) || 0) + (Number(n) || 0);
    }
    entry[tenure] = bucket;
    countyTypeCounts.set(slug, entry);
  };

  add('/');
  for (const slug of slugByTypeId.values()) add(`/${slug}`);

  for (const tenure of ['rent', 'sale']) {
    // propertyCount gates the whole tenure: an advertiser with 0 sale properties
    // gets no `-for-sale` URLs at all rather than a page of empty results.
    if (!(Number(summary.propertyCount?.[tenure]) > 0)) continue;

    const suffix = TENURE_SUFFIX[tenure];
    add(`/for-${tenure === 'rent' ? 'rent' : 'sale'}`);
    for (const slug of slugByTypeId.values()) add(`/${slug}${suffix}`);

    const full = await readManifest(summary.files?.[tenure] ?? `${advertiserId}_${tenure}.json`);
    for (const county of Array.isArray(full?.counties) ? full.counties : []) {
      if (!(Number(county.count) > 0)) continue;
      const locSlug = createSlug(String(county.county ?? ''));
      if (!locSlug) continue;

      add(`/for-${tenure === 'rent' ? 'rent' : 'sale'}/${locSlug}`);
      noteCounty(locSlug, tenure, county.typeCounts);
      noteCounty(locSlug, 'any', county.typeCounts);

      // Only the types this county actually has, per the manifest's own typeIds —
      // not every type the advertiser carries.
      for (const typeId of Array.isArray(county.typeIds) ? county.typeIds : []) {
        const slug = slugByTypeId.get(typeId);
        if (!slug) continue;
        add(`/${slug}/${locSlug}`);
        add(`/${slug}${suffix}/${locSlug}`);
      }
    }
  }

  // ── Town URLs, from the curated popular-locations list ────────────────────
  //
  // Only crossed with the advertiser's OWN types, and only for tenures they have
  // properties in — the same restraint applied to counties above.
  //
  // GATED on real counts, exactly as the county rows are. Two sources, because the
  // curated list is not homogeneous:
  //
  //   towns (56 of 60)  → the town-counts file, counted through the postcode table
  //   counties/regions  → the county typeCounts already in the tenure manifests
  //                       (London, Essex, West Yorkshire, Hampshire have no
  //                       postcode-table row, so they are absent from that file)
  //
  // WITHOUT the counts file the gate is SKIPPED, not failed closed: town URLs are
  // emitted ungated, which is precisely the previous behaviour. That matters
  // because it makes this safe to ship before the generator has ever run.
  //
  // Why it exists: measured against production, 807 of 1,753 town URLs (46%)
  // rendered zero properties — concentrated in niche types (rural-for-rent,
  // hotels-for-rent) rather than particular towns, because every curated town was
  // crossed with every type the advertiser carries.
  const townSlugs = readPopularLocationSlugs ? await readPopularLocationSlugs() : [];
  const townCounts = readTownCounts ? await readTownCounts() : null;
  const townsIndex = townCounts?.towns ?? null;

  /** Does `locSlug` have at least one property of `typeId` for `tenure`? */
  const locationHasType = (locSlug, tenure, typeId) => {
    if (!townsIndex) return true; // no data → ungated, i.e. previous behaviour
    const fromTown = townsIndex[locSlug]?.[tenure]?.[String(typeId)];
    if (Number(fromTown) > 0) return true;
    // Not a town (or absent from it): fall back to the county rows harvested above.
    const fromCounty = countyTypeCounts.get(locSlug)?.[tenure]?.[String(typeId)];
    if (Number(fromCounty) > 0) return true;
    // A curated location the town file knows nothing about AND that is not a
    // county row is unverifiable, so leave it ungated rather than silently drop it.
    return !townsIndex[locSlug] && !countyTypeCounts.has(locSlug);
  };

  for (const locSlug of townSlugs) {
    for (const [typeId, slug] of slugByTypeId) {
      if (locationHasType(locSlug, 'any', typeId)) add(`/${slug}/${locSlug}`);
    }
    for (const tenure of ['rent', 'sale']) {
      if (!(Number(summary.propertyCount?.[tenure]) > 0)) continue;
      // The bare tenure+location page shows every type, so it is non-empty if ANY
      // type is — cheaper and more accurate than re-deriving a total.
      const anyType = [...slugByTypeId.keys()].some((id) => locationHasType(locSlug, tenure, id));
      if (anyType) add(`/for-${tenure}/${locSlug}`);
      for (const [typeId, slug] of slugByTypeId) {
        if (locationHasType(locSlug, tenure, typeId)) {
          add(`/${slug}${TENURE_SUFFIX[tenure]}/${locSlug}`);
        }
      }
    }
  }

  return [...urls].map(([path, mod]) => ({ loc: `${origin}${path}`, lastmod: mod }));
}

/**
 * `/details/:pid` rows for one shard of an already-resolved pid list.
 *
 * No `lastmod`: the property row has no reliable modified timestamp to hand, and a
 * wrong lastmod is worse than none — it teaches a crawler to ignore the field.
 */
export function buildDetailUrlsFromPids(pids, origin, { shard = 1, basePath = '' } = {}) {
  const { offset, limit } = detailShardWindow(shard);
  return pids
    .slice(offset, offset + limit)
    .map((pid) => ({ loc: `${origin}${basePath}/details/${pid}`, lastmod: null }));
}

/** Render a `<urlset>` — the leaf document, one `<url>` per page. */
export function renderSitemapXml(urls) {
  const body = urls.map(({ loc, lastmod }) => (
    `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

/**
 * The sitemap INDEX — `/sitemap.xml`.
 *
 * A `<sitemapindex>` is a list of sitemap files, not of pages. Crawlers fetch it,
 * then fetch each `<loc>` in turn. It is the spec's answer to a catalogue that
 * outgrows one file, and it costs one extra round trip.
 *
 * `lastmod` on a child is optional but useful: it lets a crawler skip a shard it
 * has already seen unchanged. We only set it where we have an honest value (the
 * manifest's generatedAt, for the listings child) — never invented.
 */
export function renderSitemapIndexXml(children) {
  const body = children.map(({ loc, lastmod }) => (
    `  <sitemap><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</sitemap>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</sitemapindex>
`;
}

/**
 * How many detail shards an advertiser needs.
 *
 * Counting is much cheaper than enumerating — a COUNT over an indexed predicate
 * versus materialising every pid — so property-pub's INDEX route asks this and the
 * SHARD routes do the enumeration.
 */
export function detailShardCount(propertyCount) {
  const n = Number(propertyCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(Math.min(n, DETAIL_URL_CAP) / DETAIL_SHARD_SIZE);
}

/** Zero-based offset + row count for shard `n` (1-based). */
export function detailShardWindow(shard) {
  return { offset: (shard - 1) * DETAIL_SHARD_SIZE, limit: DETAIL_SHARD_SIZE };
}

/**
 * The child sitemaps an advertiser's index should name, given a property count.
 *
 * `/sitemap-listings.xml` is always present (every advertiser has at least a root
 * URL). Detail shards are added only for properties actually in scope, so an
 * advertiser with no live bookings gets an index with one child rather than a
 * broken link to an empty shard.
 */
export function buildIndexChildren(origin, total, lastmod = null) {
  const shards = detailShardCount(total);
  const children = [{ loc: `${origin}/sitemap-listings.xml`, lastmod }];
  for (let n = 1; n <= shards; n += 1) {
    // No lastmod on detail shards: the property rows carry no reliable modified
    // timestamp, and a wrong one teaches a crawler to ignore the field.
    children.push({ loc: `${origin}/sitemap-details-${n}.xml`, lastmod: null });
  }
  return { children, shards };
}
