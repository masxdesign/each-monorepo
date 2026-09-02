/**
 * Query + filter builders for the EACH-alert REQUIREMENTS listing.
 *
 * Ports the requirements path (@i=0) of the legacy stored proc a_rcAlertListing:
 *
 *   SELECT DISTINCT <cols>
 *   FROM a_rpEACHAlert a
 *   LEFT JOIN a_rpRequirementsJ r ON r.RID = a.a
 *   WHERE a.i = 0
 *     AND (a.m IN ('','x') OR LEFT(a.m,6) < LEFT(dbo.FJ(GETDATE()),6))   -- maturity gate
 *     AND r.RID IS NOT NULL
 *     [AND a.d > @alertSince]                                           -- optional "since"
 *   ORDER BY r.RID DESC
 *
 * Requirements are a different entity from properties (table a_rpRequirementsJ,
 * 85 cols, money-typed sizes, no lat/long, no property status filter), so these
 * builders are intentionally separate from the property-oriented agentb-filters /
 * agentb-queries. Shared building blocks are reused where the shape matches:
 *  - buildAlertSinceFilter (references alias `a`, identical for req + prop)
 *  - the CHARINDEX-CSV and bitwise-tenure patterns (re-expressed against alias `r`)
 *
 * SQL Server 2008 compatible.
 */

import {
  buildAlertSinceFilter,
  buildAlertOwnerFilter,
  COMMERCIAL_PSTID,
  COMMERCIAL_TYPES_ARRAY,
} from './agentb-filters.js';

/**
 * Requirement table the proc joins. NOTE: this exists in PROD but NOT in DEV
 * (dev only has a_rpRequirements). Dev needs a synonym/view:
 *   CREATE SYNONYM dbo.a_rpRequirementsJ FOR dbo.a_rpRequirements;
 * before this endpoint can run there.
 */
const REQUIREMENTS_TABLE = 'a_rpRequirementsJ';

/**
 * Columns selected for each requirement row. Mirrors the legacy
 * DB_EACH_REQ_COLUMNS_STR (trimmed to columns verified to exist on
 * a_rpRequirementsJ). dateCreated/dateUpdated are derived from z1/z3 via
 * dbo.Fecha_YYMMDDHHMMSS, exactly as the proc does for requirements.
 */
const REQUIREMENT_COLUMNS = [
  'RID',
  'status',
  'types',
  'PSTIDs',
  'ClientName',
  'PCs',
  'CTIDs',
  'Regions',
  'streets',
  'TownsWithPC',
  'attachments',
  'SizeUnit',
  'SizeMin',
  'SizeMax',
  'IsExternal',
  'SizeUnitExt',
  'SizeMinExt',
  'SizeMaxExt',
  'priceMin',
  'priceMax',
  'rentMin',
  'rentMax',
  'rentperiod',
  'tenure',
  'Dealswith',
  'DIDs',
  'BIDs',
  'CIDs',
  'hash',
  'ai',
];

/* --------------------------------------------------------------------- */
/*  Requirement filter builders (alias `r`)                              */
/* --------------------------------------------------------------------- */

/**
 * Subtype filter — CHARINDEX CSV match on r.PSTIDs.
 * Mirrors buildSubtypesFilter (properties) incl. the COMMERCIAL_PSTID sentinel,
 * which resolves against r.types (property TYPE ids) rather than r.PSTIDs —
 * see buildSubtypesFilter for the full rationale and the PHP source of truth.
 * @param {Array} subtypes
 * @returns {string}
 */
function buildReqSubtypesFilter(subtypes) {
  if (!Array.isArray(subtypes) || subtypes.length === 0) return '';

  const conditions = [];

  // Sentinel 1000 → match the commercial property TYPES on r.types.
  if (subtypes.includes(COMMERCIAL_PSTID)) {
    const typeConditions = COMMERCIAL_TYPES_ARRAY.map(
      typeId => `CHARINDEX(',${typeId},', ',' + ISNULL(r.types, '') + ',') > 0`
    );
    conditions.push(`(${typeConditions.join(' OR ')})`);
  }

  // Every other id is a real subtype → match r.PSTIDs as usual.
  const realSubtypes = [...new Set(subtypes.filter(s => s !== COMMERCIAL_PSTID))]
    .filter(n => Number.isInteger(n));
  for (const s of realSubtypes) {
    conditions.push(`CHARINDEX(',${s},', ',' + ISNULL(r.PSTIDs, '') + ',') > 0`);
  }

  if (conditions.length === 0) return '';

  return `(${conditions.join(' OR ')})`;
}

/** Tenure bitfield filter on r.tenure. @param {number} tenure @returns {string} */
function buildReqTenureFilter(tenure) {
  if (!tenure || tenure === 0) return '';
  return `(r.tenure & @tenure) > 0`;
}

/** Company filter — cid in r.CIDs CSV. @returns {string} */
function buildReqCompanyFilter(cid) {
  const n = typeof cid === 'string' ? parseInt(cid, 10) : cid;
  if (!Number.isInteger(n) || n <= 0) return '';
  return `CHARINDEX(',' + CAST(@cid AS VARCHAR(20)) + ',', ',' + ISNULL(r.CIDs, '') + ',') > 0`;
}

/** Branch filter — bid in r.BIDs CSV. @returns {string} */
function buildReqBranchFilter(bid) {
  const n = typeof bid === 'string' ? parseInt(bid, 10) : bid;
  if (!Number.isInteger(n) || n <= 0) return '';
  return `CHARINDEX(',' + CAST(@bid AS VARCHAR(20)) + ',', ',' + ISNULL(r.BIDs, '') + ',') > 0`;
}

/** Department filter — did in r.DIDs CSV. @returns {string} */
function buildReqDepartmentFilter(did) {
  const n = typeof did === 'string' ? parseInt(did, 10) : did;
  if (!Number.isInteger(n) || n <= 0) return '';
  return `CHARINDEX(',' + CAST(@did AS VARCHAR(20)) + ',', ',' + ISNULL(r.DIDs, '') + ',') > 0`;
}

/**
 * Single-requirement filter — r.RID = @rid. Used by the requirement deep-link page
 * (/requirements/:rid). This NARROWS the caller's existing scope, it never widens it:
 * the each-alert owner filter (a.n = @alertOwnerNid) and its `1 = 0` guard still apply,
 * so a rid outside the caller's alert feed simply returns no rows.
 *
 * RID is VARCHAR(50) on a_rpRequirementsJ and values run to 12 digits, so it is
 * compared as a string (bound VarChar(20)) rather than parsed to a Number.
 * @returns {string}
 */
function buildReqRidFilter(rid) {
  const s = String(rid ?? '').trim();
  if (!/^\d{1,20}$/.test(s)) return '';
  return `r.RID = @rid`;
}

/**
 * Dealing-negotiator filter — nid in r.Dealswith CSV. Mirrors the property
 * endpoint's buildNidFilter (which matches p.Dealswith): selects "requirements
 * I'm the dealing agent on". Used by the `my-dealing` mode ONLY — the each-alert
 * path deliberately drops it (it scopes by the alert OWNER a.n instead).
 * @param {number|string|null|undefined} nid
 * @returns {string}
 */
function buildReqNidFilter(nid) {
  const n = typeof nid === 'string' ? parseInt(nid, 10) : nid;
  if (!Number.isInteger(n) || n <= 0) return '';
  return `CHARINDEX(',' + CAST(@nid AS VARCHAR(20)) + ',', ',' + ISNULL(r.Dealswith, '') + ',') > 0`;
}

/**
 * Location filter for requirements. Requirements have no building/street/town
 * address fields like properties; they store target areas as CSV id columns.
 * Supported: county ids (r.CTIDs) and region ids (r.Regions). `location` is an
 * array of [values[], columnIndices[]] rows (ANDed), matching the property
 * endpoint's shape but with a requirement-specific column map:
 *   6 -> CTIDs (county ids), 8 -> Regions (region ids)
 * @param {Array|null} location
 * @returns {{ sql: string, params: Object }}
 */
function buildReqLocationFilter(location) {
  if (!Array.isArray(location) || location.length === 0) {
    return { sql: '', params: {} };
  }

  const columnMap = { 6: 'CTIDs', 8: 'Regions' };
  const conditions = [];
  const params = {};
  let paramIndex = 0;

  for (const row of location) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [values, columnIndices] = row;
    if (!Array.isArray(values) || !Array.isArray(columnIndices)) continue;

    const cols = columnIndices.filter(idx => columnMap[idx]);
    if (cols.length === 0) continue;

    const rowConditions = [];
    for (const raw of values) {
      const token = String(raw ?? '').trim();
      if (!/^\d+$/.test(token)) continue; // ctid/regid are numeric ids
      const paramName = `req_location_${paramIndex}`;
      params[paramName] = token;
      paramIndex++;
      for (const idx of cols) {
        rowConditions.push(
          `CHARINDEX(',' + @${paramName} + ',', ',' + ISNULL(r.${columnMap[idx]}, '') + ',') > 0`
        );
      }
    }

    if (rowConditions.length > 0) {
      conditions.push(`(${rowConditions.join(' OR ')})`);
    }
  }

  return {
    sql: conditions.length > 0 ? conditions.join(' AND ') : '',
    params,
  };
}

/* --------------------------------------------------------------------- */
/*  Sort                                                                  */
/* --------------------------------------------------------------------- */

/**
 * ORDER BY for the requirements ROW_NUMBER window. The proc orders by RID DESC;
 * we expose a small sort vocabulary over the columns requirements actually have.
 * 1=dateUpdated(z3), 2=dateCreated(z1), default=RID. Positive=ASC, negative=DESC.
 * @param {number} sort
 * @returns {string}
 */
function buildReqOrderBy(sort = -1) {
  const columnId = Math.abs(parseInt(sort) || 1);
  const direction = parseInt(sort) > 0 ? 'ASC' : 'DESC';

  switch (columnId) {
    case 1: // dateUpdated (z3)
      return `CASE WHEN r.z3 IS NULL THEN 1 ELSE 0 END ASC, r.z3 ${direction}, r.RID DESC`;
    case 2: // dateCreated (z1)
      return `CASE WHEN r.z1 IS NULL THEN 1 ELSE 0 END ASC, r.z1 ${direction}, r.RID DESC`;
    default: // RID (proc default is RID DESC)
      return `r.RID ${direction}`;
  }
}

/* --------------------------------------------------------------------- */
/*  Query assembly                                                        */
/* --------------------------------------------------------------------- */

/**
 * Build the `my-dealing` DISTINCT-RID subquery: "requirements I'm the dealing agent
 * on". Mirrors the property endpoint's my-dealing semantics (p.Dealswith match) but
 * against r.Dealswith, and — like properties — does NOT require EACH-alert membership,
 * so there is no a_rpEACHAlert join, no maturity gate, and no `since` (those reference
 * the alert table, which isn't joined here). Scoped by the logged-in agent's nid; with
 * no nid the guard forces an empty result rather than leaking every requirement.
 *
 * @param {Object} filters
 * @returns {{ sql: string, params: Object }}
 */
function buildMyDealingMembershipSubquery(filters = {}) {
  const { location, subtypes, tenure, nid, cid, bid, did, rid } = filters;

  const locationFilter = buildReqLocationFilter(location);
  const nidFilter = buildReqNidFilter(nid);
  // my-dealing REQUIRES a dealing nid; with none, force an empty result.
  const nidGuard = nidFilter === '' ? '1 = 0' : '';

  const filterConditions = [
    locationFilter.sql,
    buildReqSubtypesFilter(subtypes),
    buildReqTenureFilter(tenure),
    buildReqCompanyFilter(cid),
    buildReqBranchFilter(bid),
    buildReqDepartmentFilter(did),
    // Narrows to one requirement (deep link); the nid guard above still scopes it.
    buildReqRidFilter(rid),
    nidFilter,
    nidGuard,
  ].filter(c => c !== '');

  const whereClause = filterConditions.length > 0 ? filterConditions.join(' AND ') : '1 = 1';

  const sql = `(
    SELECT DISTINCT r.RID AS rid
    FROM ${REQUIREMENTS_TABLE} r
    WHERE ${whereClause}
  )`;

  return { sql, params: { ...locationFilter.params } };
}

/**
 * Build the inner DISTINCT-RID subquery (EACH-alert requirements membership) plus
 * any requirement filters. Returns { sql, params } where sql is a parenthesised
 * subquery aliased downstream as `ar`. No advertiser scheduling — requirements
 * have no advertiser concept (matches the proc).
 *
 * `mode === 'my-dealing'` delegates to {@link buildMyDealingMembershipSubquery}
 * (Dealswith scoping, no alert join). Default is the each-alert membership path.
 *
 * @param {Object} filters
 * @returns {{ sql: string, params: Object }}
 */
function buildRequirementMembershipSubquery(filters = {}) {
  if (filters.mode === 'my-dealing') {
    return buildMyDealingMembershipSubquery(filters);
  }

  const { location, subtypes, tenure, since, alertOwnerNid, cid, bid, did, rid } = filters;

  const ridFilter = buildReqRidFilter(rid);

  const locationFilter = buildReqLocationFilter(location);
  // A rid deep-link addresses ONE requirement, which may predate the `since` date the
  // link happens to carry. Dropping the date filter here keeps the link resolvable; the
  // owner filter below still scopes it to the caller's own alert feed.
  const alertSinceFilter = ridFilter !== ''
    ? { sql: '', params: {} }
    : buildAlertSinceFilter(since, 'each-alert');
  // Owner scoping (a.n) — faithful to the proc's @h path. The Dealswith nid filter
  // (buildReqNidFilter) is intentionally dropped for each-alert, mirroring properties.
  const alertOwnerFilter = buildAlertOwnerFilter(alertOwnerNid, 'each-alert');
  // each-alert REQUIRES an owner (hash → else logged-in agent's nid); with none, force
  // an empty result rather than leak the whole each-alert requirement set.
  const eachAlertOwnerGuard = alertOwnerFilter.sql === '' ? '1 = 0' : '';

  const filterConditions = [
    locationFilter.sql,
    buildReqSubtypesFilter(subtypes),
    buildReqTenureFilter(tenure),
    buildReqCompanyFilter(cid),
    buildReqBranchFilter(bid),
    buildReqDepartmentFilter(did),
    // Narrows to one requirement (deep link); the owner filter + guard still scope it.
    ridFilter,
    alertSinceFilter.sql,
    alertOwnerFilter.sql,
    eachAlertOwnerGuard,
  ].filter(c => c !== '');

  // EACH-alert requirements membership + maturity gate (no property status filter).
  const baseWhere = `a.i = 0 AND (a.m IN ('', 'x') OR LEFT(a.m, 6) < LEFT(dbo.FJ(GETDATE()), 6)) AND r.RID IS NOT NULL`;
  const whereClause = filterConditions.length > 0
    ? `${baseWhere} AND ${filterConditions.join(' AND ')}`
    : baseWhere;

  const sql = `(
    SELECT DISTINCT r.RID AS rid
    FROM a_rpEACHAlert a
    INNER JOIN ${REQUIREMENTS_TABLE} r ON r.RID = a.a
    WHERE ${whereClause}
  )`;

  return {
    sql,
    params: { ...locationFilter.params, ...alertSinceFilter.params, ...alertOwnerFilter.params },
  };
}

/**
 * Build the full paginated requirements query (data recordset + total recordset),
 * matching the property endpoint's two-recordset shape.
 *
 * @param {Object} filters
 * @param {Object} opts
 * @param {number} opts.offset
 * @param {number} opts.pageSize
 * @param {number} opts.sort
 * @param {boolean} [opts.ridsOnly]
 * @returns {{ sql: string, params: Object }}
 */
function buildEachAlertRequirementsQuery(filters = {}, { offset, pageSize, sort = -1, ridsOnly = false } = {}) {
  const membership = buildRequirementMembershipSubquery(filters);

  const dateCols = `,(CASE WHEN r.z1 IS NOT NULL THEN dbo.Fecha_YYMMDDHHMMSS(r.z1) ELSE NULL END) AS dateCreated`
    + `,(CASE WHEN r.z3 IS NOT NULL THEN dbo.Fecha_YYMMDDHHMMSS(r.z3) ELSE NULL END) AS dateUpdated`;

  const innerSelect = ridsOnly
    ? 'r.RID'
    : REQUIREMENT_COLUMNS.map(c => `r.[${c}]`).join(',\n        ') + dateCols;

  const appliedSort = buildReqOrderBy(sort);

  const dataSelect = ridsOnly ? 'rd.RID' : 'rd.*';

  const sql = `
    /* Paginated requirements data */
    SELECT ${dataSelect} FROM (
      SELECT
        ${innerSelect},
        ROW_NUMBER() OVER (ORDER BY ${appliedSort}) AS row_num
      FROM ${membership.sql} ar
      INNER JOIN ${REQUIREMENTS_TABLE} r ON r.RID = ar.rid
    ) rd
    WHERE rd.row_num > @offset AND rd.row_num <= @offset + @pageSize;

    /* Total count */
    SELECT COUNT(*) AS total
    FROM ${membership.sql} ar;
  `;

  return {
    sql,
    params: { ...membership.params, offset, pageSize },
  };
}

export {
  buildEachAlertRequirementsQuery,
  buildReqLocationFilter,
  buildReqSubtypesFilter,
  buildReqTenureFilter,
  buildReqNidFilter,
  buildReqOrderBy,
  REQUIREMENTS_TABLE,
  REQUIREMENT_COLUMNS,
};
