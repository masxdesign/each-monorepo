/**
 * Per–site_mode rules for which properties are "active" for an advertiser (agentb, map, counties CLI).
 * SQL Server 2008 compatible.
 *
 * To add a new site_mode: register here and in SITE_MODE_VALUES (api-mag-advertisers.js).
 */

export const DEFAULT_SITE_MODE = 'advertiser_site';

/** London region id in dbo.counties.r (dbo.regions.REGID). */
export const LONDON_COUNTY_REGION_R = 1;

const STATUS_FILTER = 'p.status NOT IN (2, 7)';

/**
 * Booking states that disqualify a schedule row from advertising.
 *
 * Scheduling and payment both live in `a_stripeSchedulers` now, so this is a
 * plain predicate on the joined row rather than the correlated NOT EXISTS this
 * replaced — that subquery existed only to reach across from `a_magSchedulers`
 * into adbilling, and re-scoped the booking window by hand to pick the booking
 * running today. Joining the one table makes that self-correlation redundant:
 * the row already IS today's booking.
 *
 * - `activated_at IS NOT NULL` — a booking holds no price until activation
 *   (pricing_pattern_id is NULL before it), so an unpaid one must not advertise.
 * - `cancelled_at IS NULL` — a cancelled booking has no claim on the listing.
 * - `paused_at IS NOT NULL` means a weekly charge failed; it must stop
 *   advertising until paid. Cleared when a later charge on that booking succeeds.
 *
 * Backed by the filtered index IX_a_stripeSchedulers_paused (migration 012);
 * this runs on every property query on the site, not just billing ones.
 */
const BOOKING_LIVE_FILTER = `s.activated_at IS NOT NULL
    AND s.cancelled_at IS NULL
    AND s.paused_at IS NULL`;

/**
 * EACH-alert property listing — ports the property path (@i=1) of the legacy
 * stored proc a_rcAlertListing. Properties that carry a non-matured EACH alert.
 * Status set differs from STATUS_FILTER (the proc excludes 41,40,9,8).
 */
const EACH_ALERT_STATUS_FILTER = 'p.status NOT IN (41, 40, 9, 8)';
const EACH_ALERT_JOIN = 'INNER JOIN a_rpEACHAlert a ON a.a = p.PID';
// Property-alert membership + maturity gate. Today's YYMMDD comes from SQL
// (LEFT(dbo.FJ(GETDATE()),6)) to match the proc and avoid host/DB timezone drift.
const EACH_ALERT_MEMBERSHIP = `a.i = 1 AND (a.m IN ('', 'x') OR LEFT(a.m, 6) < LEFT(dbo.FJ(GETDATE()), 6))`;

/** Tenure variants for location manifest generation (bitfield on p.tenure). */
export const TENURE_VARIANTS = {
  any: { suffix: '_any', whereSql: '' },
  rent: { suffix: '_rent', whereSql: '(p.tenure & 3) > 0' },
  sale: { suffix: '_sale', whereSql: '(p.tenure & 12) > 0' },
};

/** @typedef {'any'|'rent'|'sale'} TenureVariantKey */

/**
 * @param {string[]} filterConditions - SQL AND fragments from agentb user filters
 * @returns {string}
 */
function appendFilterConditions(whereClause, filterConditions) {
  if (!filterConditions?.length) {
    return whereClause;
  }
  return `${whereClause} AND ${filterConditions.join(' AND ')}`;
}

function createFourPropScope() {
  return {
    buildActivePropertiesSubquery(filterConditions) {
      const whereClause = appendFilterConditions(STATUS_FILTER, filterConditions);
      return {
        sql: `(
        SELECT DISTINCT p.pid,
          NULL AS start_date,
          NULL AS end_date,
          NULL AS week_no,
          @advertiser_id AS advertiser_id
        FROM a_rpPropertyNewAll_p22 p
        WHERE ${whereClause}
      )`,
      };
    },

    buildMapScopeParts() {
      return {
        scheduleJoin: '',
        whereClause: STATUS_FILTER,
      };
    },

    buildActivePropertiesPidCtidCte({ tenureWhere = '' } = {}) {
      const tenureAnd = tenureWhere ? ` AND ${tenureWhere}` : '';
      return `SELECT DISTINCT p.pid, p.ctids, p.types, p.pstids
        FROM a_rpPropertyNewAll_p22 p
        WHERE ${STATUS_FILTER}${tenureAnd}`;
    },
  };
}

/**
 * The scheduled-scope join and predicate, exported so callers that assemble
 * their own SQL (the nightly locations / latest-shuffled generators in bizchat)
 * express "currently advertised" with the SAME strings the scope builders use,
 * rather than hand-copying the booking rules and drifting from them.
 *
 * `@advertiser_id` must be bound by the caller.
 */
export const SCHEDULE_JOIN_SQL = 'LEFT JOIN a_stripeSchedulers s ON s.PID = p.pid';

export const SCHEDULED_WHERE_CORE_SQL = `s.advertiser_id = @advertiser_id
    AND GETDATE() >= s.start_date
    AND GETDATE() <= DATEADD(WEEK, s.week_no, s.start_date)
    AND ${BOOKING_LIVE_FILTER}`;

function createScheduledScope() {
  const scheduleJoin = SCHEDULE_JOIN_SQL;
  const scheduledWhereCore = SCHEDULED_WHERE_CORE_SQL;

  return {
    buildActivePropertiesSubquery(filterConditions) {
      const whereClause = appendFilterConditions(
        `${scheduledWhereCore} AND ${STATUS_FILTER}`,
        filterConditions,
      );
      return {
        sql: `(
        SELECT DISTINCT p.pid,
          s.start_date,
          DATEADD(WEEK, s.week_no, s.start_date) AS end_date,
          s.week_no,
          s.advertiser_id
        FROM a_rpPropertyNewAll_p22 p
        ${scheduleJoin}
        WHERE ${whereClause}
      )`,
      };
    },

    buildMapScopeParts() {
      // No dev-only escape hatch: an unscheduled, show-everything view is what
      // `4prop_site` mode is for, so a developer who wants one points the
      // advertiser at that mode rather than having this branch on NODE_ENV.
      // Dev and prod therefore build identical SQL here.
      return {
        scheduleJoin,
        whereClause: `${scheduledWhereCore} AND ${STATUS_FILTER}`,
      };
    },

    buildActivePropertiesPidCtidCte({ tenureWhere = '' } = {}) {
      const tenureAnd = tenureWhere ? ` AND ${tenureWhere}` : '';
      return `SELECT DISTINCT p.pid, p.ctids, p.types, p.pstids
        FROM a_rpPropertyNewAll_p22 p
        ${scheduleJoin}
        WHERE ${scheduledWhereCore}
          AND ${STATUS_FILTER}${tenureAnd}`;
    },
  };
}

/**
 * EACH-alert scope — modelled on fourPropScope (no a_stripeSchedulers join, synthesized
 * NULL schedule columns) but joins a_rpEACHAlert and applies the EACH status + maturity
 * gates. Selected by variant === 'each-alert' (see resolveVariantScope), independent of
 * the advertiser's site_mode — the proc has no advertiser-scheduling concept.
 *
 * An optional `a.d > @alertSince` predicate arrives via filterConditions (alias `a`),
 * so param binding stays in the route and this SQL embeds no params.
 */
function createEachAlertScope() {
  const baseWhere = `${EACH_ALERT_STATUS_FILTER} AND ${EACH_ALERT_MEMBERSHIP}`;
  return {
    buildActivePropertiesSubquery(filterConditions) {
      const whereClause = appendFilterConditions(baseWhere, filterConditions);
      return {
        sql: `(
        SELECT DISTINCT p.pid,
          NULL AS start_date,
          NULL AS end_date,
          NULL AS week_no,
          @advertiser_id AS advertiser_id
        FROM a_rpPropertyNewAll_p22 p
        ${EACH_ALERT_JOIN}
        WHERE ${whereClause}
      )`,
      };
    },

    buildMapScopeParts() {
      // EACH_ALERT_JOIN occupies the scheduleJoin slot so the map SQL template
      // (FROM a_rpPropertyNewAll_p22 p ${scheduleJoin}) needs no changes.
      return {
        scheduleJoin: EACH_ALERT_JOIN,
        whereClause: baseWhere,
      };
    },
  };
}

const scheduledScope = createScheduledScope();
const fourPropScope = createFourPropScope();
const eachAlertScope = createEachAlertScope();

export const SITE_MODE_PROPERTY_SCOPES = {
  '4prop_site': fourPropScope,
  advertiser_site: scheduledScope,
  agentab: scheduledScope,
};

/**
 * @param {string|null|undefined} mode - a_magAdvertisers.site_mode
 */
export function resolveSiteModePropertyScope(mode) {
  return SITE_MODE_PROPERTY_SCOPES[mode] ?? SITE_MODE_PROPERTY_SCOPES[DEFAULT_SITE_MODE];
}

/**
 * Resolve the property scope for a request. The 'each-alert' variant overrides the
 * advertiser's site_mode entirely; every other variant falls back to site_mode.
 * @param {string|null|undefined} variant - Browse variant from the request body
 * @param {string|null|undefined} mode - a_magAdvertisers.site_mode
 */
export function resolveVariantScope(variant, mode) {
  if (variant === 'each-alert') {
    return eachAlertScope;
  }
  return resolveSiteModePropertyScope(mode);
}

/** SQL predicate: property row ap matches county row c (exact or CSV ctids). */
export const COUNTY_CTID_MATCH_SQL = `(
  ap.ctids = CAST(c.ctid AS VARCHAR(20))
  OR CHARINDEX(',' + CAST(c.ctid AS VARCHAR(20)) + ',', ',' + ISNULL(ap.ctids, '') + ',') > 0
)`;

/** SQL to load dbo.regions id → name for counties CLI regionMap. */
export const REGIONS_LOOKUP_SQL = `
  SELECT REGID, region
  FROM dbo.regions
  ORDER BY REGID ASC
`;

/**
 * Build county aggregation query wrapping the active-properties CTE.
 * @param {string} activePropsCteSql - body of ActiveProps CTE (no WITH keyword)
 * @returns {string}
 */
export function buildCountiesAggregationQuery(activePropsCteSql) {
  const activePropsCte = `ActiveProps AS (
    ${activePropsCteSql}
  )`;

  return `
    WITH ${activePropsCte}
    SELECT
      c.ctid,
      c.county,
      c.r,
      COUNT(DISTINCT ap.pid) AS propertyCount
    FROM dbo.counties c
    INNER JOIN ActiveProps ap ON ${COUNTY_CTID_MATCH_SQL}
    GROUP BY c.ctid, c.county, c.r
    HAVING COUNT(DISTINCT ap.pid) > 0
    ORDER BY propertyCount DESC, c.county ASC
  `;
}

/**
 * Build county + property type/subtype rows for per-county ID aggregation.
 * @param {string} activePropsCteSql - body of ActiveProps CTE (no WITH keyword)
 * @returns {string}
 */
export function buildCountyPropertyTypesQuery(activePropsCteSql) {
  const activePropsCte = `ActiveProps AS (
    ${activePropsCteSql}
  )`;

  return `
    WITH ${activePropsCte}
    SELECT
      c.ctid,
      ap.pid,
      ap.types,
      ap.pstids
    FROM dbo.counties c
    INNER JOIN ActiveProps ap ON ${COUNTY_CTID_MATCH_SQL}
  `;
}

/**
 * Distinct active property count from county–property join rows (no extra SQL).
 * @param {Array<{ pid: unknown }>} rows - from buildCountyPropertyTypesQuery
 * @returns {number}
 */
export function countDistinctPropertyIds(rows) {
  const set = new Set();
  for (const row of rows) {
    if (row.pid != null) {
      set.add(row.pid);
    }
  }
  return set.size;
}

/**
 * @param {Array<{ REGID: unknown, region: string }>} rows - from REGIONS_LOOKUP_SQL
 * @param {Iterable<number>} [activeRegionIds] - when set, only these r / REGID keys are included
 * @returns {Record<string, string>} region id (string) → region name
 */
export function buildRegionMapFromRows(rows, activeRegionIds) {
  const allowed = activeRegionIds
    ? new Set([...activeRegionIds].map((r) => String(r)))
    : null;

  const map = {};
  for (const row of rows) {
    const id = normalizeRegion(row.REGID);
    const key = String(id);
    if (allowed && !allowed.has(key)) {
      continue;
    }
    map[key] = row.region;
  }
  return map;
}

/**
 * Human-readable county label for JSON / UI.
 * Strips leading area-code prefixes ("IV - Inverness" → "Inverness") and
 * postcode tokens embedded in London-style names (aligned with property-pub-react
 * cleanCountyName).
 *
 * @param {string} county - raw dbo.counties.county
 * @returns {string}
 */
export function formatCountyDisplayName(county) {
  if (!county || typeof county !== 'string') {
    return county || '';
  }

  const raw = county.trim();
  let name = raw;

  const codeDashMatch = name.match(/^[A-Z]{1,3}\s*-\s*(.+)$/i);
  if (codeDashMatch) {
    name = codeDashMatch[1].trim();
  }

  const postcodeToken = /[A-Z]{1,2}\d+[A-Z]?(?:-(?:[A-Z]{1,2})?\d+[A-Z]?)?/gi;
  name = name
    .replace(/\bexcl\b[^,]*/gi, '')
    .replace(postcodeToken, '')
    .replace(/&/g, '')
    .replace(/\s*,\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return name || raw;
}

/**
 * Map per-county SQL rows into JSON counties array (one entry per dbo.counties row).
 *
 * `typeCounts` (when typeCountsByCtid is supplied) maps each type id present in the
 * county to its distinct-pid count for that county. Multi-type properties count under
 * each of their types, so these can sum to more than `count` (see countPidsByTypeIdByCtid).
 *
 * @param {Array<{ ctid: unknown, county: string, r: unknown, propertyCount: number }>} rows
 * @param {Map<string, number[]>} [typeIdsByCtid]
 * @param {Map<string, number[]>} [subtypeIdsByCtid]
 * @param {Map<string, Record<string, number>>} [typeCountsByCtid]
 * @returns {Array<{ county: string, r: number, ctid: Array<number|string>, count: number, typeIds: number[], typeCounts: Record<string, number>, subtypeIds: number[] }>}
 */
export function buildCountiesJsonFromRows(
  rows,
  typeIdsByCtid = new Map(),
  subtypeIdsByCtid = new Map(),
  typeCountsByCtid = new Map(),
) {
  const counties = rows.map((row) => {
    const normalizedCtid = normalizeCtid(row.ctid);
    const ctidKey = String(normalizedCtid);
    return {
      ctid: [normalizedCtid],
    county: formatCountyDisplayName(row.county),
    r: normalizeRegion(row.r),
    count: row.propertyCount,
    typeIds: typeIdsByCtid.get(ctidKey) ?? [],
    typeCounts: typeCountsByCtid.get(ctidKey) ?? {},
    subtypeIds: subtypeIdsByCtid.get(ctidKey) ?? [],
    };
  });

  counties.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.county.localeCompare(b.county);
  });

  return counties;
}

/**
 * Parse comma-delimited ID strings like "1,2,7" into unique numeric IDs.
 *
 * Property TYPE id 0 is valid ("Auto Trade"), so type aggregation passes
 * `allowZero: true`. Subtype/pstid 0 is not a real subtype (it means "none"),
 * so the default keeps the `id > 0` filter for those.
 *
 * @param {unknown} value
 * @param {{ allowZero?: boolean }} [opts]
 * @returns {number[]}
 */
export function parseCommaDelimitedIds(value, { allowZero = false } = {}) {
  if (!value || typeof value !== 'string') {
    return [];
  }

  const set = new Set();
  for (const raw of value.split(',')) {
    const token = raw.trim();
    if (!/^\d+$/.test(token)) {
      continue;
    }
    const id = parseInt(token, 10);
    if (Number.isFinite(id) && (allowZero ? id >= 0 : id > 0)) {
      set.add(id);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Build a subtype-id → type-id lookup from the 4prop subtypes catalog.
 *
 * Each catalog row is [id, name, aliases1, aliases2, typeId] (see getSubtypes).
 * This is the SAME type↔subtype relationship the listing endpoint uses: the
 * listing expands a property-type slug into all of that type's subtype ids and
 * filters on p.pstids, so a property is "of type T" iff one of its pstids maps
 * to T here — regardless of what p.types says. Manifest type aggregation must use
 * this mapping to agree with the listing counts.
 *
 * @param {Array<[number, string, string, string, number]>} subtypes
 * @returns {Map<number, number>} subtypeId → typeId
 */
export function buildSubtypeToTypeIdMap(subtypes) {
  const map = new Map();
  for (const row of subtypes ?? []) {
    if (!Array.isArray(row) || row.length < 5) {
      continue;
    }
    const subtypeId = normalizeNumericId(row[0], { allowZero: true });
    const typeId = normalizeNumericId(row[4], { allowZero: true });
    if (subtypeId != null && typeId != null) {
      map.set(subtypeId, typeId);
    }
  }
  return map;
}

/**
 * Map a property's pstids CSV to the set of property-type ids it belongs to,
 * via the subtype→type lookup. Mirrors the listing's subtype-driven matching.
 *
 * @param {unknown} pstidsCsv - p.pstids
 * @param {Map<number, number>} subtypeToTypeId
 * @returns {number[]} sorted unique type ids
 */
export function parsePstidsToTypeIds(pstidsCsv, subtypeToTypeId) {
  if (!(subtypeToTypeId instanceof Map) || subtypeToTypeId.size === 0) {
    return [];
  }
  const typeIds = new Set();
  for (const subtypeId of parseCommaDelimitedIds(pstidsCsv)) {
    const typeId = subtypeToTypeId.get(subtypeId);
    if (typeId != null) {
      typeIds.add(typeId);
    }
  }
  return [...typeIds].sort((a, b) => a - b);
}

/**
 * Aggregate unique property type IDs per county ctid.
 *
 * Type membership is derived from each property's pstids via the subtype→type
 * lookup (parsePstidsToTypeIds), NOT from p.types — this matches the listing
 * endpoint, which filters by subtype. A property tagged with an Auto-Trade
 * subtype but missing type 0 in p.types still surfaces Auto Trade for the county.
 *
 * @param {Array<{ ctid: unknown, pstids: unknown }>} rows
 * @param {Map<number, number>} subtypeToTypeId - from buildSubtypeToTypeIdMap
 * @returns {Map<string, number[]>}
 */
export function aggregateTypeIdsByCtid(rows, subtypeToTypeId) {
  const idsByCtid = new Map();

  for (const row of rows) {
    const ctid = String(normalizeCtid(row.ctid));
    const parsed = parsePstidsToTypeIds(row.pstids, subtypeToTypeId);
    if (parsed.length === 0) {
      continue;
    }

    if (!idsByCtid.has(ctid)) {
      idsByCtid.set(ctid, new Set());
    }
    const bucket = idsByCtid.get(ctid);
    for (const id of parsed) {
      bucket.add(id);
    }
  }

  const out = new Map();
  for (const [ctid, idSet] of idsByCtid.entries()) {
    out.set(ctid, [...idSet].sort((a, b) => a - b));
  }
  return out;
}

/**
 * Count distinct active properties per property type ID, per county ctid.
 *
 * Type membership is derived from each property's pstids via the subtype→type
 * lookup (parsePstidsToTypeIds), NOT p.types — so these counts match the listing
 * endpoint (which filters by subtype). A property whose subtypes span multiple
 * types is counted once under EACH of those types, so per-type counts for a
 * county can sum to more than the county's distinct-pid `count`. Distinct-pid
 * semantics match the county `count` (COUNT(DISTINCT ap.pid)): a pid joined to a
 * county more than once still counts once per type.
 *
 * @param {Array<{ ctid: unknown, pid: unknown, pstids: unknown }>} rows - from buildCountyPropertyTypesQuery
 * @param {Map<number, number>} subtypeToTypeId - from buildSubtypeToTypeIdMap
 * @returns {Map<string, Record<string, number>>} ctid → { typeId(string): distinct pid count }
 */
export function countPidsByTypeIdByCtid(rows, subtypeToTypeId) {
  /** @type {Map<string, Map<number, Set<unknown>>>} */
  const pidsByTypeByCtid = new Map();

  for (const row of rows) {
    if (row.pid == null) {
      continue;
    }
    const typeIds = parsePstidsToTypeIds(row.pstids, subtypeToTypeId);
    if (typeIds.length === 0) {
      continue;
    }
    const ctid = String(normalizeCtid(row.ctid));

    if (!pidsByTypeByCtid.has(ctid)) {
      pidsByTypeByCtid.set(ctid, new Map());
    }
    const byType = pidsByTypeByCtid.get(ctid);
    for (const typeId of typeIds) {
      if (!byType.has(typeId)) {
        byType.set(typeId, new Set());
      }
      byType.get(typeId).add(row.pid);
    }
  }

  /** @type {Map<string, Record<string, number>>} */
  const out = new Map();
  for (const [ctid, byType] of pidsByTypeByCtid.entries()) {
    const counts = {};
    for (const typeId of [...byType.keys()].sort((a, b) => a - b)) {
      counts[String(typeId)] = byType.get(typeId).size;
    }
    out.set(ctid, counts);
  }
  return out;
}

/**
 * Aggregate unique property subtype IDs (pstids) per county ctid.
 * @param {Array<{ ctid: unknown, pstids: unknown }>} rows
 * @returns {Map<string, number[]>}
 */
export function aggregateSubtypeIdsByCtid(rows) {
  const idsByCtid = new Map();

  for (const row of rows) {
    const ctid = String(normalizeCtid(row.ctid));
    const parsed = parseCommaDelimitedIds(row.pstids);
    if (parsed.length === 0) {
      continue;
    }

    if (!idsByCtid.has(ctid)) {
      idsByCtid.set(ctid, new Set());
    }
    const bucket = idsByCtid.get(ctid);
    for (const id of parsed) {
      bucket.add(id);
    }
  }

  const out = new Map();
  for (const [ctid, idSet] of idsByCtid.entries()) {
    out.set(ctid, [...idSet].sort((a, b) => a - b));
  }
  return out;
}

/**
 * @param {unknown} id
 * @param {{ allowZero?: boolean }} [opts] - type id 0 ("Auto Trade") is valid;
 *   subtype id 0 is not. Pass allowZero for type collection.
 * @returns {number | null}
 */
function normalizeNumericId(id, { allowZero = false } = {}) {
  if (id == null || id === '') {
    return null;
  }
  const n = typeof id === 'number' ? id : parseInt(String(id), 10);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : null;
}

/**
 * Union of deduped numeric IDs from a field on each county row.
 * @param {Array<{ typeIds?: unknown[], subtypeIds?: unknown[] }>} counties
 * @param {'typeIds' | 'subtypeIds'} field
 * @returns {number[]}
 */
function collectIdsFromCounties(counties, field, { allowZero = false } = {}) {
  const ids = new Set();
  for (const county of counties ?? []) {
    for (const id of county[field] ?? []) {
      const n = normalizeNumericId(id, { allowZero });
      if (n != null) {
        ids.add(n);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Union of all property type IDs across counties (e.g. for summary manifest).
 * @param {Array<{ typeIds?: unknown[] }>} counties
 * @returns {number[]}
 */
export function collectTypeIdsFromCounties(counties) {
  return collectIdsFromCounties(counties, 'typeIds', { allowZero: true });
}

/**
 * Union of all property subtype IDs across counties (e.g. for summary manifest).
 * @param {Array<{ subtypeIds?: unknown[] }>} counties
 * @returns {number[]}
 */
export function collectSubtypeIdsFromCounties(counties) {
  return collectIdsFromCounties(counties, 'subtypeIds');
}

/**
 * @param {unknown} r - dbo.counties.r or dbo.regions.REGID
 * @returns {number}
 */
function normalizeRegion(r) {
  const n = typeof r === 'number' ? r : parseInt(String(r), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid region r value: ${r}`);
  }
  return n;
}

/**
 * Counties.ctid may be numeric (52) or alphanumeric (CF, AB) per dbo.counties.
 * @param {unknown} ctid
 * @returns {number|string}
 */
function normalizeCtid(ctid) {
  if (ctid == null || ctid === '') {
    throw new Error(`Invalid ctid value: ${ctid}`);
  }
  if (typeof ctid === 'number' && Number.isFinite(ctid)) {
    return ctid;
  }
  const s = String(ctid).trim();
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10);
  }
  return s;
}
