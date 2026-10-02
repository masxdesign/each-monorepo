/**
 * Town URL gating in buildAdvertiserUrls: curated towns need ≥1 property, every
 * other counted town needs MIN_TOWN_PROPERTIES. Plus the company sitemap helpers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdvertiserUrls, MIN_TOWN_PROPERTIES,
  parseCompanyCounts, buildKnownCompaniesQuery, buildCompanyUrls, buildIndexChildren,
  loadScopedCompanyIds, COMPANY_LOOKUP_CHUNK,
  MIN_SUBTYPE_PROPERTIES, parseSubtypeCounts,
} from './sitemap.js';

const ORIGIN = 'https://www.example.com';
const OFFICE = 8;

const summary = {
  generatedAt: '2026-10-02T00:00:00.000Z',
  typeIds: [OFFICE],
  propertyCount: { rent: 100, sale: 100 },
  files: { rent: 'x_rent.json', sale: 'x_sale.json' },
};

const tenureManifest = {
  counties: [{ county: 'Kent', count: 40, typeIds: [OFFICE], typeCounts: { [OFFICE]: 40 } }],
};

/** One town per tenure bucket, keyed by tenure → { typeId: n }. */
const town = (n) => ({ any: { [OFFICE]: n }, rent: { [OFFICE]: n }, sale: {} });

const catalog = [{
  id: OFFICE,
  label: 'Office',
  subtypes: [
    { id: 61, label: 'Serviced Office', parentId: OFFICE },
    { id: 62, label: 'Office', parentId: OFFICE }, // same slug as the type
    { id: 63, label: 'Bars/Pubs', parentId: OFFICE }, // createSlug ≠ labelToSlug
  ],
}];

async function paths({ curated = [], towns = null, variants, subtypes } = {}) {
  const urls = await buildAdvertiserUrls({ site_mode: '4prop_site' }, null, ORIGIN, {
    readManifest: async (name) => (name.endsWith('.json') && name.startsWith('x_') ? tenureManifest : summary),
    getPropertyTypesCatalog: async () => catalog,
    readPopularLocationSlugs: async () => curated,
    readTownCounts: async () => (towns ? { towns } : null),
    readVariantCounts: variants ? async () => variants : undefined,
    readSubtypeCounts: subtypes ? async () => subtypes : undefined,
  });
  return new Set(urls.map(({ loc }) => loc.slice(ORIGIN.length)));
}

describe('buildAdvertiserUrls town gating', () => {
  test('a non-curated town at the threshold is listed', async () => {
    const got = await paths({ towns: { bedford: town(MIN_TOWN_PROPERTIES) } });
    assert.ok(got.has('/offices/bedford'));
    assert.ok(got.has('/offices-for-rent/bedford'));
    assert.ok(got.has('/for-rent/bedford'));
    assert.ok(!got.has('/for-sale/bedford'), 'no sale stock → no sale URL');
  });

  test('a non-curated town below the threshold is not listed', async () => {
    const got = await paths({ towns: { bedford: town(MIN_TOWN_PROPERTIES - 1) } });
    assert.ok(![...got].some((p) => p.endsWith('/bedford')));
  });

  test('a curated town keeps the ≥1 rule', async () => {
    const got = await paths({ curated: ['bedford'], towns: { bedford: town(1) } });
    assert.ok(got.has('/offices-for-rent/bedford'));
  });

  test('a town slug that is also a county is not re-gated as a town', async () => {
    const got = await paths({ towns: { kent: town(1) } });
    assert.ok(got.has('/offices-for-rent/kent'), 'county URL from the manifest stays');
  });

  test('/businesses-for-sale only when the variant has stock', async () => {
    assert.ok((await paths({ variants: { 'businesses-for-sale': 3 } })).has('/businesses-for-sale'));
    assert.ok(!(await paths({ variants: { 'businesses-for-sale': 0 } })).has('/businesses-for-sale'));
    assert.ok(!(await paths()).has('/businesses-for-sale'));
  });

  test('subtype pages: singular slug, national only, gated per tenure', async () => {
    const n = MIN_SUBTYPE_PROPERTIES;
    const got = await paths({ subtypes: { 61: { any: n, rent: n, sale: n - 1 }, 62: { any: 99, rent: 99, sale: 99 } } });
    assert.ok(got.has('/serviced-office'));
    assert.ok(got.has('/serviced-office-for-rent'));
    assert.ok(!got.has('/serviced-office-for-sale'), 'below threshold for sale');
    assert.ok(![...got].some((p) => p.startsWith('/serviced-offices')), 'never the plural');
    assert.ok(![...got].some((p) => /^\/serviced-office.*\/./.test(p)), 'never crossed with a location');
  });

  test('punctuated subtype: always the createSlug form, bare and tenure', async () => {
    const n = MIN_SUBTYPE_PROPERTIES;
    const got = await paths({ subtypes: { 63: { any: n, rent: n, sale: n } } });
    assert.ok(got.has('/bars-pubs'));
    assert.ok(got.has('/bars-pubs-for-rent'));
    assert.ok(got.has('/bars-pubs-for-sale'));
    assert.ok(![...got].some((p) => p.startsWith('/barspubs')), 'never the labelToSlug form');
  });

  test('a subtype whose slug is a type slug adds nothing new', async () => {
    const without = await paths();
    const withSub = await paths({ subtypes: { 62: { any: 99, rent: 99, sale: 99 } } });
    assert.deepEqual([...withSub].sort(), [...without].sort());
  });

  test('listing URLs carry no lastmod', async () => {
    const urls = await buildAdvertiserUrls({ site_mode: '4prop_site' }, null, ORIGIN, {
      readManifest: async (name) => (name.startsWith('x_') ? tenureManifest : summary),
      getPropertyTypesCatalog: async () => catalog,
    });
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.lastmod === null));
  });

  test('no counts file → no extra towns', async () => {
    const got = await paths();
    assert.ok(![...got].some((p) => p.endsWith('/bedford')));
  });
});

describe('company sitemap helpers', () => {
  test('parseCompanyCounts splits CSV lists and sums per cid', () => {
    const got = parseCompanyCounts([
      { cids: ',494,1365,', n: 3 },
      { cids: ',1365,', n: 2 },
      { cids: ',0,abc,,250009115457,', n: 1 },
    ]);
    assert.deepEqual(Object.fromEntries(got), { 494: 3, 1365: 5, 250009115457: 1 });
  });

  test('buildKnownCompaniesQuery quotes digits-only ids (cid is VARCHAR)', () => {
    const sql = buildKnownCompaniesQuery(['494', "1; DROP TABLE x", '1365']);
    assert.match(sql, /IN \('494','1365'\)/);
    assert.ok(!sql.includes('DROP'));
    assert.equal(buildKnownCompaniesQuery(['x']), null);
  });

  test('buildCompanyUrls sorts numerically, including ids past 2^53-safe int range', () => {
    const got = buildCompanyUrls(['250009115457', '1365', '494'], ORIGIN).map((u) => u.loc);
    assert.deepEqual(got, [
      `${ORIGIN}/company/494`, `${ORIGIN}/company/1365`, `${ORIGIN}/company/250009115457`,
    ]);
  });

  test('index names the companies child only when there are companies', () => {
    const none = buildIndexChildren(ORIGIN, 10).children.map((c) => c.loc);
    const some = buildIndexChildren(ORIGIN, 10, null, { companies: 3 }).children.map((c) => c.loc);
    assert.ok(!none.includes(`${ORIGIN}/sitemap-companies.xml`));
    assert.ok(some.includes(`${ORIGIN}/sitemap-companies.xml`));
  });

  test('loadScopedCompanyIds keeps only cids that exist in a_rcCompany, chunked', async () => {
    const many = Array.from({ length: COMPANY_LOOKUP_CHUNK + 5 }, (_, i) => String(i + 1));
    const queries = [];
    const pool = {
      request() {
        const inputs = {};
        return {
          input(name, value) { inputs[name] = value; return this; },
          async query(sql) {
            queries.push({ sql, inputs });
            if (sql.includes('ActiveProps')) {
              return { recordset: [{ cids: `,${many.join(',')},`, n: 1 }] };
            }
            // Pretend only even cids are real companies.
            const ids = [...sql.matchAll(/'(\d+)'/g)].map((m) => m[1]);
            return { recordset: ids.filter((id) => Number(id) % 2 === 0).map((cid) => ({ cid })) };
          },
        };
      },
    };
    const scope = { buildActivePropertiesPidCtidCte: () => 'SELECT 1 AS pid' };
    const got = await loadScopedCompanyIds(pool, scope, 42);

    assert.equal(got.length, Math.floor(many.length / 2));
    assert.ok(got.every((cid) => Number(cid) % 2 === 0));
    assert.equal(queries.length, 3, 'one scope query + two lookup chunks');
    assert.equal(queries[0].inputs.advertiser_id, 42);
  });
});

describe('parseSubtypeCounts', () => {
  test('splits pstids and buckets by tenure bitmask', () => {
    const got = parseSubtypeCounts([
      { pstids: ',61,70,', tenure: 1, n: 4 },  // rent
      { pstids: ',61,', tenure: 4, n: 2 },     // sale
      { pstids: ',61,', tenure: 5, n: 1 },     // both
      { pstids: ',x,,', tenure: 1, n: 9 },
    ]);
    assert.deepEqual(got, {
      61: { any: 7, rent: 5, sale: 3 },
      70: { any: 4, rent: 4, sale: 0 },
    });
  });
});
