/**
 * Shared query building functions for Agent B endpoints
 * SQL Server 2008 compatible (compatibility level 100)
 */

import {
  buildLocationFilter,
  buildSubtypesFilter,
  buildTenureFilter,
  buildCompanyFilter,
  buildDepartmentFilter,
  buildBranchFilter,
  buildNidFilter,
  buildSizeFilter,
  buildLandFilter,
  buildVariantFilter,
  buildAlertSinceFilter,
  buildAlertOwnerFilter
} from './agentb-filters.js';
import { resolveVariantScope } from './siteModePropertyScope.js';

/* --------------------------------------------------------------------- */
/*  Query Building Functions                                              */
/* --------------------------------------------------------------------- */

/**
 * Build active properties subquery for an advertiser with filters.
 *
 * @param {Object} filters - Filter parameters
 * @param {Object} [opts]
 * @param {string} [opts.mode] - Advertiser site_mode
 * @returns {Object} - { sql: string, locationParams: object, variantParams: object }
 */
function buildActivePropertiesForAdvertiserSubquery(filters = {}, { mode } = {}) {
  const { location, subtypes, tenure, sizeMin, sizeMax, landMin, landMax, variant, auctionDate, since, alertOwnerNid, cid, bid, did, nid } = filters;

  const locationFilter = buildLocationFilter(location);
  const subtypesCondition = buildSubtypesFilter(subtypes);
  const tenureCondition = buildTenureFilter(tenure);
  const companyCondition = buildCompanyFilter(cid);
  const branchCondition = buildBranchFilter(bid);
  const departmentCondition = buildDepartmentFilter(did);
  // each-alert is NOT scoped by p.Dealswith — that nid filter is dropped for it.
  // Instead it scopes by the alert OWNER (a.n) via buildAlertOwnerFilter below.
  const nidCondition = variant === 'each-alert' ? '' : buildNidFilter(nid);
  const sizeCondition = buildSizeFilter(sizeMin, sizeMax);
  const landCondition = buildLandFilter(landMin, landMax);
  const variantFilter = buildVariantFilter(variant, auctionDate);
  const alertSinceFilter = buildAlertSinceFilter(since, variant);
  const alertOwnerFilter = buildAlertOwnerFilter(alertOwnerNid, variant);
  // each-alert REQUIRES an owner (hash → else logged-in agent's nid). With no owner
  // resolvable the list is meaningless, so force an empty result rather than leak all.
  const eachAlertOwnerGuard = (variant === 'each-alert' && alertOwnerFilter.sql === '') ? '1 = 0' : '';

  const filterConditions = [
    locationFilter.sql,
    subtypesCondition,
    tenureCondition,
    companyCondition,
    branchCondition,
    departmentCondition,
    nidCondition,
    sizeCondition,
    landCondition,
    variantFilter.sql,
    alertSinceFilter.sql,
    alertOwnerFilter.sql,
    eachAlertOwnerGuard
  ].filter(condition => condition !== '');

  const scope = resolveVariantScope(variant, mode);
  const { sql } = scope.buildActivePropertiesSubquery(filterConditions);

  return {
    sql,
    locationParams: locationFilter.params,
    variantParams: { ...variantFilter.params, ...alertSinceFilter.params, ...alertOwnerFilter.params }
  };
}

/**
 * Build map properties query for an advertiser with filters.
 * Returns only essential columns for map display (pid, latitude, longitude, status).
 * SQL Server 2008 compatible — uses TOP N instead of modern pagination.
 *
 * @param {Object} filters - Filter parameters
 * @param {number} maxResults - Maximum number of results to return (default: 10000)
 * @param {string|null} userId
 * @param {Object} [opts]
 * @param {string} [opts.mode] - Advertiser site_mode
 * @returns {Object} - { sql: string, locationParams: object, hasUser: boolean }
 */
function buildMapPropertiesQuery(filters = {}, maxResults = 10000, userId = null, { mode } = {}) {
  const { location, subtypes, tenure, sizeMin, sizeMax, landMin, landMax, variant, auctionDate, since, alertOwnerNid, cid, bid, did, nid } = filters;

  const locationFilter = buildLocationFilter(location);
  const subtypesCondition = buildSubtypesFilter(subtypes);
  const tenureCondition = buildTenureFilter(tenure);
  const companyCondition = buildCompanyFilter(cid);
  const branchCondition = buildBranchFilter(bid);
  const departmentCondition = buildDepartmentFilter(did);
  // each-alert scopes by alert OWNER (a.n), not p.Dealswith — drop the nid filter here.
  const nidCondition = variant === 'each-alert' ? '' : buildNidFilter(nid);
  const sizeCondition = buildSizeFilter(sizeMin, sizeMax);
  const landCondition = buildLandFilter(landMin, landMax);
  const variantFilter = buildVariantFilter(variant, auctionDate);
  const alertSinceFilter = buildAlertSinceFilter(since, variant);
  const alertOwnerFilter = buildAlertOwnerFilter(alertOwnerNid, variant);
  // each-alert REQUIRES an owner; force empty when unresolved (see listing builder).
  const eachAlertOwnerGuard = (variant === 'each-alert' && alertOwnerFilter.sql === '') ? '1 = 0' : '';

  const filterConditions = [
    locationFilter.sql,
    subtypesCondition,
    tenureCondition,
    companyCondition,
    branchCondition,
    departmentCondition,
    nidCondition,
    sizeCondition,
    landCondition,
    variantFilter.sql,
    alertSinceFilter.sql,
    alertOwnerFilter.sql,
    eachAlertOwnerGuard
  ].filter(condition => condition !== '');

  const gradeJoin = buildUserGradeJoin(userId, { pidExpr: 'p.pid' });

  const innerBucket = gradeJoin.hasUser
    ? `, CASE
        WHEN g.grade IS NULL AND p.status = 0 THEN 0
        WHEN g.grade IS NULL AND p.status = 1 THEN 1
        WHEN g.grade IS NOT NULL THEN 2
        ELSE 3
      END AS tier`
    : `, CASE
        WHEN p.status = 0 THEN 0
        WHEN p.status = 1 THEN 1
        ELSE 2
      END AS tier`;
  const outerOrderBy = `ORDER BY tier ASC, pid ASC`;

  const scope = resolveVariantScope(variant, mode);
  const { scheduleJoin, whereClause: scopeWhere } = scope.buildMapScopeParts();

  let whereClause = scopeWhere;

  if (filterConditions.length > 0) {
    whereClause += ` AND ${filterConditions.join(' AND ')}`;
  }

  if (gradeJoin.whereExtra) {
    whereClause += ` AND ${gradeJoin.whereExtra}`;
  }

  const sql = `
    SELECT pid, latitude, longitude, status
    FROM (
      SELECT DISTINCT TOP ${maxResults}
        p.pid,
        p.latitude,
        p.longitude,
        p.status
        ${innerBucket}
      FROM a_rpPropertyNewAll_p22 p
      ${scheduleJoin}
      ${gradeJoin.joinClause}
      WHERE ${whereClause}
      ORDER BY p.pid ASC
    ) m
    ${outerOrderBy}
  `;

  return {
    sql,
    locationParams: locationFilter.params,
    variantParams: { ...variantFilter.params, ...alertSinceFilter.params, ...alertOwnerFilter.params },
    hasUser: gradeJoin.hasUser,
  };
}

/**
 * Build SQL fragments for joining user-specific grades onto a property row.
 *
 * When userId is a positive integer, callers get:
 *   - joinClause:   LEFT JOIN clause aliased as `g`, keyed on (@grade_user_id, ap.advertiser_id, ap.pid)
 *   - selectExpr:   a column expression to include in SELECT (aliased grade + updated_at + neg_id)
 *   - whereExtra:   predicate to AND into the outer WHERE that excludes rows the user rejected
 *   - orderByPrefix: fragment to prepend to ORDER BY so the 3-tier bucket
 *                    (ungraded available → graded → ungraded LET/SOLD) is the
 *                    primary sort layer
 *   - hasUser:      true
 *
 * When userId is absent, the order-by prefix collapses to a 2-tier bucket
 * keyed only on status (available → LET/SOLD), so anonymous users still get
 * LET/SOLD pushed to the bottom. `joinClause`, `selectExpr` and `whereExtra`
 * remain empty in that case.
 *
 * `pidExpr` / `statusExpr` let callers choose the aliases their query uses
 * (e.g. "ap.pid" vs "p.pid"). Defaults match the active-properties subquery alias.
 */
function buildUserGradeJoin(userId, { pidExpr = 'ap.pid', statusExpr = 'p.status' } = {}) {
  const userIdNum = typeof userId === 'string' ? Number(userId) : userId;
  const hasUser = Number.isInteger(userIdNum) && userIdNum > 0;

  if (!hasUser) {
    return {
      hasUser: false,
      joinClause: '',
      selectExpr: '',
      whereExtra: '',
      orderByPrefix: `CASE
        WHEN ${statusExpr} = 0 THEN 0
        WHEN ${statusExpr} = 1 THEN 1
        ELSE 2
      END ASC`,
    };
  }

  return {
    hasUser: true,
    joinClause: `LEFT JOIN a_magUserPropertyGrades g
      ON g.user_id = @grade_user_id
      AND g.pid = ${pidExpr}
    LEFT JOIN a_magAdvertisers ga
      ON ga.id = g.advertiser_id`,
    selectExpr: `g.grade AS user_grade, g.updated_at AS user_grade_updated_at, g.neg_id AS user_grade_neg_id, g.advertiser_id AS grade_advertiser_id, ga.company AS grade_advertiser_name, (SELECT STUFF((SELECT ',' + CAST(sg.shortlist_id AS NVARCHAR) FROM a_magUserShortlistGrades sg WHERE sg.user_id = @grade_user_id AND sg.pid = ${pidExpr} FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '')) AS shortlist_ids`,
    whereExtra: `(g.grade IS NULL OR g.grade <> 3)`,
    orderByPrefix: `CASE
      WHEN g.grade IS NULL AND ${statusExpr} = 0 THEN 0
      WHEN g.grade IS NULL AND ${statusExpr} = 1 THEN 1
      WHEN g.grade IS NOT NULL THEN 2
      ELSE 3
    END ASC`,
  };
}

/**
 * 4prop_site detail subquery — no a_stripeSchedulers (matches fourPropScope list shape).
 */
function buildFourPropPropertyDetailSubquery(pidWhereClause) {
  return `(
    SELECT
      p.pid,
      NULL AS start_date,
      NULL AS end_date,
      NULL AS week_no,
      NULL AS fixed_week_rate,
      @advertiser_id AS advertiser_id
    FROM a_rpPropertyNewAll_p22 p
    WHERE ${pidWhereClause}
  )`;
}

/**
 * Scheduled-site detail subquery — prefer request advertiser schedule, else any, else NULL.
 */
function buildScheduledPropertyDetailSubquery(pidWhereClause) {
  return `(
    SELECT
      p.pid,
      s.start_date,
      s.end_date,
      s.week_no,
      s.advertiser_id
    FROM a_rpPropertyNewAll_p22 p
    OUTER APPLY (
      SELECT TOP 1
        s.start_date,
        DATEADD(WEEK, s.week_no, s.start_date) AS end_date,
        s.week_no,
        s.advertiser_id
      FROM a_stripeSchedulers s
      WHERE s.PID = p.pid
        -- Skip a booking that is not live: unactivated (holds no price yet),
        -- cancelled, or paused for non-payment.
        -- Filters the SCHEDULE, not the property: this subquery deliberately
        -- returns the row even with no schedule at all (OUTER APPLY, no date
        -- filter), so a direct link to a detail page keeps working. Dropping
        -- the property here would 404 a URL that resolves fine today; dropping
        -- only the schedule leaves the page rendering with no live booking
        -- attached, which is exactly what a paused slot is.
        AND s.activated_at IS NOT NULL
        AND s.cancelled_at IS NULL
        AND s.paused_at IS NULL
      ORDER BY
        CASE WHEN s.advertiser_id = @advertiser_id THEN 0 ELSE 1 END ASC,
        s.start_date DESC
    ) s
    WHERE ${pidWhereClause}
  )`;
}

/**
 * Property + schedule columns for GET /:pid and POST /pids, aligned with list site_mode.
 * @param {string} pidWhereClause
 * @param {string|null|undefined} siteMode - a_magAdvertisers.site_mode
 */
function buildPropertyDetailScheduleSubquery(pidWhereClause, siteMode) {
  if (siteMode === '4prop_site') {
    return buildFourPropPropertyDetailSubquery(pidWhereClause);
  }
  return buildScheduledPropertyDetailSubquery(pidWhereClause);
}

/* --------------------------------------------------------------------- */
/*  Exports                                                               */
/* --------------------------------------------------------------------- */

export {
  buildActivePropertiesForAdvertiserSubquery,
  buildMapPropertiesQuery,
  buildUserGradeJoin,
  buildPropertyDetailScheduleSubquery,
};
