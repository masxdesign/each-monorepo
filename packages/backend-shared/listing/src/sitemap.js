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
import { getListingVariantSlugForPropertyType, labelToSlug, pluralizeLabel } from '@4prop/seo-enhance/navTarget';
import { buildVariantFilter } from './agentb-filters.js';

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

/**
 * Minimum properties for a NON-curated town URL to be listed (curated towns need 1).
 *
 * Sized against dev data for 4prop_site: ≥1 → 676 towns / ~11k URLs, ≥5 → 522
 * towns / ~4.6k URLs. Five keeps three quarters of the towns while dropping the
 * one-to-four-property pages a crawler is least likely to index.
 */
export const MIN_TOWN_PROPERTIES = 5;

/** Minimum properties (per tenure) for a subtype page to be listed. Same bar as towns. */
export const MIN_SUBTYPE_PROPERTIES = 5;

/**
 * In-scope property counts per subtype id and tenure:
 * `{ '61': { any: 40, rent: 31, sale: 9 } }`.
 *
 * `p.pstids` is a `,a,b,` CSV of subtype ids, split in JS for the same reason as
 * company cids (no STRING_SPLIT; CHARINDEX joins cannot use an index). A property
 * with two subtypes counts once for each, which is what each subtype page shows.
 */
export async function loadScopedSubtypeCounts(pool, scope, advertiserId) {
  const request = pool.request();
  if (advertiserId != null) request.input('advertiser_id', advertiserId);
  const { recordset } = await request.query(`
    WITH ActiveProps AS (${scope.buildActivePropertiesPidCtidCte()})
    SELECT p.pstids AS pstids, p.tenure AS tenure, COUNT(DISTINCT p.pid) AS n
    FROM a_rpPropertyNewAll_p22 p
    INNER JOIN ActiveProps ap ON ap.pid = p.pid
    WHERE p.status NOT IN (2, 7) AND p.pstids IS NOT NULL AND p.pstids <> ''
    GROUP BY p.pstids, p.tenure
  `);
  return parseSubtypeCounts(recordset);
}

/** Rows of `{ pstids, tenure, n }` → `{ subtypeId: { any, rent, sale } }`. */
export function parseSubtypeCounts(rows) {
  const counts = {};
  for (const row of rows ?? []) {
    const n = Number(row.n) || 0;
    if (!n) continue;
    const tenure = Number(row.tenure) || 0;
    const rent = (tenure & 3) > 0;
    const sale = (tenure & 12) > 0;
    for (const token of new Set(String(row.pstids ?? '').split(','))) {
      const id = token.trim();
      if (!/^\d+$/.test(id)) continue;
      const c = (counts[id] ??= { any: 0, rent: 0, sale: 0 });
      c.any += n;
      if (rent) c.rent += n;
      if (sale) c.sale += n;
    }
  }
  return counts;
}

/**
 * Listing variants that are SEO routes in their own right — the route gate
 * (listingRouteGate.js) gives them a server-rendered head. `/auctions` and
 * `/pop-up-shops` are app-only views with no SSR head, so they stay out.
 */
export const SITEMAP_VARIANTS = ['businesses-for-sale'];

/**
 * In-scope property count per SITEMAP_VARIANTS entry, e.g. `{ 'businesses-for-sale': 41 }`.
 *
 * The predicate is agentb's own buildVariantFilter — the one the listing page runs
 * — so the sitemap lists a variant exactly when the page would show something.
 * Pool injected, as for loadScopedCompanyIds.
 */
export async function loadScopedVariantCounts(pool, scope, advertiserId) {
  const counts = {};
  const cte = scope.buildActivePropertiesPidCtidCte();
  for (const variant of SITEMAP_VARIANTS) {
    const { sql } = buildVariantFilter(variant);
    if (!sql) continue;
    const request = pool.request();
    if (advertiserId != null) request.input('advertiser_id', advertiserId);
    const { recordset } = await request.query(`
      WITH ActiveProps AS (${cte})
      SELECT COUNT(DISTINCT p.pid) AS n
      FROM a_rpPropertyNewAll_p22 p
      INNER JOIN ActiveProps ap ON ap.pid = p.pid
      WHERE p.status NOT IN (2, 7) AND ${sql}
    `);
    counts[variant] = Number(recordset?.[0]?.n) || 0;
  }
  return counts;
}

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
 * @param {() => Promise<Record<string, {any:number, rent:number, sale:number}>>} [deps.readSubtypeCounts]
 *        In-scope property count per subtype id and tenure (loadScopedSubtypeCounts).
 *        Omitted → no subtype URLs.
 * @param {() => Promise<Record<string, number>>} [deps.readVariantCounts]
 *        In-scope property count per SITEMAP_VARIANTS entry (loadScopedVariantCounts).
 *        Omitted → no variant URLs.
 */
export async function buildAdvertiserUrls(advertiser, advertiserId, origin, deps) {
  const {
    readManifest, getPropertyTypesCatalog, readPopularLocationSlugs, readTownCounts,
    readVariantCounts, readSubtypeCounts,
  } = deps;
  const siteMode = advertiser?.site_mode ?? 'advertiser_site';

  let summary;
  try {
    summary = await readManifest(resolveSummaryFilename(siteMode, advertiserId ?? advertiser?.id));
  } catch {
    summary = null; // advertiser_site with no usable id
  }
  if (!summary) return [];

  // No per-URL lastmod. The only date to hand was the manifest's generatedAt — i.e.
  // "tonight", stamped on every URL every night. A lastmod that always says "changed
  // today" is exactly what teaches a crawler to ignore the field site-wide.
  const lastmod = null;

  // typeId → URL slug, for the advertiser's own type set only.
  const typeIds = Array.isArray(summary.typeIds) ? summary.typeIds : [];
  const slugByTypeId = new Map();
  let propertyTypes = [];
  if (typeIds.length) {
    try {
      propertyTypes = await getPropertyTypesCatalog();
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

  // ── Subtype pages: /<subtype>, /<subtype>-for-(sale|rent) — national only ──
  //
  // The slug is createSlug(subtype label) — the port of PHP's create_slug, i.e.
  // 4prop's canonical scheme — and SINGULAR: the plural of a subtype 301s to it on
  // 4prop, so it must never be emitted.
  //
  // For 26 punctuated labels ("Bars/Pubs", "Amenity Land & Lakes") createSlug and
  // the SPA's labelToSlug disagree (`bars-pubs` vs `barspubs`). createSlug is the
  // one both hosts serve: 4prop 301s the labelToSlug form to it, and property-pub's
  // route gate registers it (listingRouteGate.js buildSlugMap).
  //
  // Gated at MIN_SUBTYPE_PROPERTIES per tenure, and NOT crossed with locations:
  // 128 subtypes × tenures × towns would be tens of thousands of thin pages.
  // Subtypes whose slug is also a TYPE slug (Hotel, Office, Unspecified) are
  // skipped — that URL is the type's page, already listed above.
  if (readSubtypeCounts && slugByTypeId.size) {
    let subtypeCounts = {};
    try { subtypeCounts = (await readSubtypeCounts()) ?? {}; } catch { subtypeCounts = {}; }

    const typeSlugs = new Set();
    for (const type of propertyTypes) {
      if (!type?.label) continue;
      typeSlugs.add(createSlug(type.label));
      typeSlugs.add(labelToSlug(type.label));
      typeSlugs.add(labelToSlug(pluralizeLabel(type.label)));
    }

    for (const type of propertyTypes) {
      if (!slugByTypeId.has(Number(type?.id))) continue; // advertiser's own types only
      for (const subtype of Array.isArray(type.subtypes) ? type.subtypes : []) {
        const slug = subtype?.label ? createSlug(String(subtype.label)) : '';
        if (!slug || typeSlugs.has(slug)) continue;
        const counts = subtypeCounts[String(subtype.id)];
        if (!counts) continue;

        if (Number(counts.any) >= MIN_SUBTYPE_PROPERTIES) add(`/${slug}`);
        for (const tenure of ['rent', 'sale']) {
          if (!(Number(summary.propertyCount?.[tenure]) > 0)) continue;
          if (Number(counts[tenure]) >= MIN_SUBTYPE_PROPERTIES) add(`/${slug}${TENURE_SUFFIX[tenure]}`);
        }
      }
    }
  }

  // First-class listing variants (/businesses-for-sale), only when non-empty.
  if (readVariantCounts) {
    let variantCounts = {};
    try { variantCounts = (await readVariantCounts()) ?? {}; } catch { variantCounts = {}; }
    for (const variant of SITEMAP_VARIANTS) {
      if (Number(variantCounts[variant]) > 0) add(`/${variant}`);
    }
  }

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

  // ── Town URLs beyond the curated list: every counted town with real stock ──
  //
  // The town-counts file covers EVERY town in 4prop's master locations.json (not
  // just the curated 60), so non-curated towns are taken from its keys. They get a
  // stricter gate than the curated ones: a page must have at least
  // MIN_TOWN_PROPERTIES properties. Listing every town with ≥1 property is what
  // PHP's sitemap did — ~11k mostly one-or-two-property pages on www.4prop.com,
  // which Search Console then filed under "Crawled/Discovered – currently not
  // indexed". The curated towns keep the `> 0` rule above, so no URL they
  // already advertise disappears.
  //
  // No counts file → no extra towns: there is nothing to enumerate or gate on.
  const curatedSlugs = new Set(townSlugs);
  const townCount = (locSlug, tenure, typeId) => Number(townsIndex?.[locSlug]?.[tenure]?.[String(typeId)]) || 0;

  for (const locSlug of Object.keys(townsIndex ?? {})) {
    // Curated slugs were handled above; county slugs already came from the manifests.
    if (curatedSlugs.has(locSlug) || countyTypeCounts.has(locSlug)) continue;

    for (const [typeId, slug] of slugByTypeId) {
      if (townCount(locSlug, 'any', typeId) >= MIN_TOWN_PROPERTIES) add(`/${slug}/${locSlug}`);
    }
    for (const tenure of ['rent', 'sale']) {
      if (!(Number(summary.propertyCount?.[tenure]) > 0)) continue;
      // The bare tenure page shows every type, so it is gated on the total. A
      // property tagged with two types counts twice here — a small overstatement
      // that only matters right at the threshold.
      let total = 0;
      for (const [typeId, slug] of slugByTypeId) {
        const n = townCount(locSlug, tenure, typeId);
        total += n;
        if (n >= MIN_TOWN_PROPERTIES) add(`/${slug}${TENURE_SUFFIX[tenure]}/${locSlug}`);
      }
      if (total >= MIN_TOWN_PROPERTIES) add(`/for-${tenure}/${locSlug}`);
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
 * has already seen unchanged — but only when honest. Every child is regenerated
 * nightly whether or not its content changed, so the generation date is not one,
 * and today no child carries it.
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
export function buildIndexChildren(origin, total, lastmod = null, { companies = 0 } = {}) {
  const shards = detailShardCount(total);
  const children = [{ loc: `${origin}/sitemap-listings.xml`, lastmod }];
  for (let n = 1; n <= shards; n += 1) {
    // No lastmod on detail shards: the property rows carry no reliable modified
    // timestamp, and a wrong one teaches a crawler to ignore the field.
    children.push({ loc: `${origin}/sitemap-details-${n}.xml`, lastmod: null });
  }
  // Only when there is something in it — same rule as the detail shards: an index
  // never points at an empty (404ing) child.
  if (companies > 0) children.push({ loc: `${origin}/sitemap-companies.xml`, lastmod: null });
  return { children, shards };
}

// ── Company catalogue URLs — /company/:cid ──────────────────────────────────
//
// A company is listed when it has ≥1 property in the advertiser's scope AND exists
// in a_rcCompany (the table the company page takes its name/logo from). The second
// check matters: /company/<any number> renders 200, so an unknown cid would be a
// soft 404. No minimum-stock threshold (unlike towns): company-name searches are
// navigational, so the page earns its place with a single listing.
//
// SQL only, per this package's contract — each service runs it on its own pool.

/**
 * Companies with stock in scope: one row per distinct `p.cids` list, with how many
 * properties carry it. `p.cids` is a `,a,b,` CSV; it is split in JS
 * (parseCompanyCounts) because this database has no STRING_SPLIT and a CHARINDEX
 * match against a_rcCompany cannot use an index (it timed out in production).
 *
 * @param {string} cte  The scope's buildActivePropertiesPidCtidCte() output.
 */
export function buildScopedCompanyCountsQuery(cte) {
  return `
    WITH ActiveProps AS (${cte})
    SELECT p.cids AS cids, COUNT(DISTINCT p.pid) AS n
    FROM a_rpPropertyNewAll_p22 p
    INNER JOIN ActiveProps ap ON ap.pid = p.pid
    WHERE p.status NOT IN (2, 7) AND p.cids IS NOT NULL AND p.cids <> ''
    GROUP BY p.cids
  `;
}

/** `[{ cids: ',494,1365,', n: 3 }]` → Map<cid, propertyCount>. Non-numeric tokens dropped. */
export function parseCompanyCounts(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const n = Number(row.n) || 0;
    for (const token of new Set(String(row.cids ?? '').split(','))) {
      const cid = token.trim();
      if (!/^\d+$/.test(cid) || cid === '0' || /^0+$/.test(cid)) continue;
      counts.set(cid, (counts.get(cid) ?? 0) + n);
    }
  }
  return counts;
}

/** IN-list size per known-companies query — under mssql's 2,100-parameter cap even if parameterised. */
export const COMPANY_LOOKUP_CHUNK = 1000;

/**
 * `SELECT cid FROM a_rcCompany WHERE cid IN (…)` for one chunk of cids.
 *
 * The ids are INLINED: parseCompanyCounts only ever yields /^\d+$/ strings, and
 * this function re-checks, so nothing but digits reaches the SQL. They are quoted
 * because a_rcCompany.cid is VARCHAR — a numeric IN list would make SQL Server
 * convert every row's cid to a number and fail on any non-numeric one.
 */
export function buildKnownCompaniesQuery(cids) {
  const ids = cids.map(String).filter((cid) => /^\d+$/.test(cid));
  if (!ids.length) return null;
  return `SELECT DISTINCT LTRIM(RTRIM(c.cid)) AS cid FROM a_rcCompany c WHERE c.cid IN (${ids.map((id) => `'${id}'`).join(',')})`;
}

/**
 * Company ids to list for one advertiser scope: has stock in scope AND is a real
 * company. Both services call this — bizchat nightly, property-pub on its fallback
 * path — so they cannot disagree about which companies exist.
 *
 * The pool is INJECTED (anything with `.request().input().query()`), so this
 * package still imports no DB driver.
 *
 * @param {object} pool
 * @param {{ buildActivePropertiesPidCtidCte: Function }} scope  resolveSiteModePropertyScope(siteMode)
 * @param {number|null} advertiserId  Bound as @advertiser_id for the scheduled scopes.
 * @returns {Promise<string[]>}
 */
export async function loadScopedCompanyIds(pool, scope, advertiserId) {
  const request = pool.request();
  if (advertiserId != null) request.input('advertiser_id', advertiserId);
  const { recordset } = await request.query(
    buildScopedCompanyCountsQuery(scope.buildActivePropertiesPidCtidCte()),
  );
  const withStock = [...parseCompanyCounts(recordset).keys()];

  const known = [];
  for (let i = 0; i < withStock.length; i += COMPANY_LOOKUP_CHUNK) {
    const sql = buildKnownCompaniesQuery(withStock.slice(i, i + COMPANY_LOOKUP_CHUNK));
    if (!sql) continue;
    const result = await pool.request().query(sql);
    for (const row of result.recordset ?? []) known.push(String(row.cid));
  }
  return [...new Set(known)];
}

/** `/company/:cid` rows, ascending by cid so the file is stable run to run. */
export function buildCompanyUrls(cids, origin, { basePath = '' } = {}) {
  return [...cids]
    .map(String)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    .map((cid) => ({ loc: `${origin}${basePath}/company/${cid}`, lastmod: null }));
}
