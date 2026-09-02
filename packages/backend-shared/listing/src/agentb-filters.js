/**
 * Shared filter building functions for Agent B endpoints
 * SQL Server 2008 compatible (compatibility level 100)
 */

import { body, validationResult } from 'express-validator';

/** Max values in a string-list `locationFilter` row (town/suburb/postcode/area). */
export const LOCATION_STRING_LIST_MAX = 50;
/** Max length per string in a string-list row (after trim). */
export const LOCATION_STRING_LIST_MAX_LEN = 128;
/** Max length per ctid token (numeric or alphanumeric, e.g. AB, PH). */
export const CTID_VALUE_MAX_LEN = 20;

/**
 * Sentinel "subtype" id meaning "any commercial property type". Not a real row in
 * the subtypes catalogue — see buildSubtypesFilter for how it is resolved.
 * Mirrors COMMERCIAL_PSTID in 4prop seo/constants.php.
 */
export const COMMERCIAL_PSTID = 1000;

/**
 * Property TYPE ids the COMMERCIAL_PSTID sentinel expands to:
 * AutoTrade, Office, Welfare, Retail, Leisure, Hotel, Industrial.
 * These are `p.types` ids — NOT `p.pstids` subtype ids.
 * Mirrors COMMERCIAL_TYPES_ARRAY in 4prop seo/constants.php.
 */
export const COMMERCIAL_TYPES_ARRAY = [0, 8, 9, 2, 7, 3, 4];

const CTID_ALPHANUMERIC_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIntegerCtidValue(value) {
  return Number.isInteger(value) || (typeof value === 'string' && /^\d+$/.test(value.trim()));
}

/**
 * Alphanumeric county ctid (non-numeric), e.g. AB, PH, ZE.
 * @param {unknown} value
 * @returns {boolean}
 */
function isAlphanumericCtidValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= CTID_VALUE_MAX_LEN &&
    CTID_ALPHANUMERIC_PATTERN.test(trimmed) &&
    !/^\d+$/.test(trimmed)
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCtidFilterValue(value) {
  return isIntegerCtidValue(value) || isAlphanumericCtidValue(value);
}

/**
 * @param {unknown[]} values
 */
function assertValidCtidFilterValues(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('ctid searchText array must not be empty');
  }
  for (const value of values) {
    if (!isCtidFilterValue(value)) {
      throw new Error(
        'ctid values must be integers or alphanumeric strings (e.g. AB, PH)'
      );
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      throw new Error('ctid strings must be non-empty after trim');
    }
  }
}

/**
 * @param {unknown} raw
 * @returns {number|string}
 */
function normalizeCtidFilterParam(raw) {
  if (Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return parseInt(raw.trim(), 10);
  }
  return String(raw).trim();
}

/**
 * Same rules for `location` (paginated agentb) and `locationFilter` (map / shared middleware).
 * @param {unknown} value
 * @throws {Error}
 */
export function assertValidLocationFilterRows(value) {
  if (!Array.isArray(value)) {
    throw new Error('location filter must be an array');
  }

  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new Error('Each location item must be [searchText, columnIndices]');
    }

    const [searchText, columnIndices] = item;

    if (!Array.isArray(columnIndices)) {
      throw new Error('columnIndices must be an array');
    }

    for (const idx of columnIndices) {
      if (!Number.isInteger(idx)) {
        throw new Error('columnIndices must contain integers');
      }
    }

    if (typeof searchText !== 'string' && !Array.isArray(searchText)) {
      throw new Error('searchText must be string or array');
    }

    if (Array.isArray(searchText)) {
      if (searchText.length === 0) {
        throw new Error('searchText array must not be empty');
      }

      const allIntegers = searchText.every(Number.isInteger);
      const allStrings = searchText.every((s) => typeof s === 'string');
      const allCtidValues = searchText.every(isCtidFilterValue);
      const ctidColOnly =
        columnIndices.length > 0 && columnIndices.every((idx) => idx === 6);

      if (allIntegers) {
        if (columnIndices.length === 0) {
          throw new Error('columnIndices must not be empty for ID list search');
        }
        for (const idx of columnIndices) {
          if (idx !== 5 && idx !== 6) {
            throw new Error(
              'Integer ID list only allows column indices 5 (cn) or 6 (ctids)'
            );
          }
        }
      } else if (allCtidValues && ctidColOnly) {
        assertValidCtidFilterValues(searchText);
      } else if (allStrings) {
        if (searchText.length > LOCATION_STRING_LIST_MAX) {
          throw new Error(
            `searchText string array must have at most ${LOCATION_STRING_LIST_MAX} values`
          );
        }
        for (const s of searchText) {
          if (s.trim().length === 0) {
            throw new Error('searchText strings must be non-empty after trim');
          }
          if (s.length > LOCATION_STRING_LIST_MAX_LEN) {
            throw new Error(
              `searchText strings must be at most ${LOCATION_STRING_LIST_MAX_LEN} characters`
            );
          }
        }
        const stringListCols = new Set([2, 3, 4, 7]);
        if (columnIndices.length === 0) {
          throw new Error('columnIndices must not be empty for string list search');
        }
        for (const idx of columnIndices) {
          if (!stringListCols.has(idx)) {
            throw new Error(
              'String list only allows column indices 2 (towncity), 3 (suburblocality), 4 (matchpostcode), 7 (area)'
            );
          }
        }
      } else {
        throw new Error(
          'searchText array must be all integers (cn/ctids), all strings (town/postcode/area), or ctid values (int or alphanumeric) with index 6 only'
        );
      }
    } else {
      // Scalar string: address columns 0–4 or area 7 (not 5,6)
      if (!columnIndices.every(idx => Number.isInteger(idx) && idx >= 0 && idx <= 7 && idx !== 5 && idx !== 6)) {
        throw new Error('Scalar string search only allows column indices 0–4 or 7');
      }
    }
  }
}

/* --------------------------------------------------------------------- */
/*  Validation Middleware                                                 */
/* --------------------------------------------------------------------- */

/**
 * Validation middleware for filters
 * Validates all body parameters for agent B property queries
 */
const validateFilters = () => {
  return [
    // Page validation
    body('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be an integer >= 1')
      .toInt(),

    // Page size validation
    body('pageSize')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('pageSize must be between 1 and 100')
      .toInt(),

    // Sort validation
    body('sort')
      .optional()
      .isInt({ min: -7, max: 7 }).withMessage('sort must be between -7 and 7')
      .toInt(),

    // Location filter validation - complex nested array structure
    body('locationFilter')
      .optional()
      .isArray().withMessage('locationFilter must be an array')
      .custom((value) => {
        assertValidLocationFilterRows(value);
        return true;
      }),

    // Subtypes validation
    body('subtypes')
      .optional()
      .isArray().withMessage('subtypes must be an array')
      .custom((value) => {
        for (const item of value) {
          if (!Number.isInteger(item)) {
            throw new Error('subtypes must contain integers');
          }
        }
        return true;
      }),

    // Size min/max validation
    body('sizeMin')
      .optional()
      .custom((value) => {
        const num = parseInt(value);
        if (isNaN(num)) {
          throw new Error('sizeMin must be a valid integer');
        }
        // Prevent overflow in SQL Server
        if (num > 1000000000) {
          throw new Error('sizeMin exceeds maximum value');
        }
        return true;
      })
      .customSanitizer(value => {
        const num = parseInt(value);
        return (num > 1000000000) ? 0 : num;
      }),

    body('sizeMax')
      .optional()
      .custom((value) => {
        const num = parseInt(value);
        if (isNaN(num)) {
          throw new Error('sizeMax must be a valid integer');
        }
        if (num > 1000000000) {
          throw new Error('sizeMax exceeds maximum value');
        }
        return true;
      })
      .customSanitizer(value => {
        const num = parseInt(value);
        return (num > 1000000000) ? 0 : num;
      }),

    // Land min/max validation
    body('landMin')
      .optional()
      .custom((value) => {
        const num = parseInt(value);
        if (isNaN(num)) {
          throw new Error('landMin must be a valid integer');
        }
        if (num > 1000000000) {
          throw new Error('landMin exceeds maximum value');
        }
        return true;
      })
      .customSanitizer(value => {
        const num = parseInt(value);
        return (num > 1000000000) ? 0 : num;
      }),

    body('landMax')
      .optional()
      .custom((value) => {
        const num = parseInt(value);
        if (isNaN(num)) {
          throw new Error('landMax must be a valid integer');
        }
        if (num > 1000000000) {
          throw new Error('landMax exceeds maximum value');
        }
        return true;
      })
      .customSanitizer(value => {
        const num = parseInt(value);
        return (num > 1000000000) ? 0 : num;
      }),

    // Tenure validation
    body('tenure')
      .optional()
      .isInt().withMessage('tenure must be an integer')
      .toInt(),

    // Variant validation — restricts SQL emission to known Browse modes.
    body('variant')
      .optional({ nullable: true })
      .isString().withMessage('variant must be a string')
      .isIn(['listing', 'auctions', 'businesses-for-sale', 'pop-up-shops', 'each-alert'])
      .withMessage("variant must be one of 'listing', 'auctions', 'businesses-for-sale', 'pop-up-shops', 'each-alert'"),

    // AuctionDate validation — YYMMDD. Only meaningful when variant === 'auctions'.
    body('auctionDate')
      .optional({ nullable: true })
      .isString().withMessage('auctionDate must be a string')
      .matches(AUCTION_DATE_PATTERN).withMessage('auctionDate must be a 6-digit YYMMDD string'),

    // Since validation — YYMMDD..YYMMDDHHMMSS. Only meaningful when variant === 'each-alert'.
    body('since')
      .optional({ nullable: true })
      .isString().withMessage('since must be a string')
      .matches(ALERT_SINCE_PATTERN).withMessage('since must be 6-12 digits (YYMMDD..YYMMDDHHMMSS)'),

    // Agency catalogue — company (cid), optional branch (bid) and department (did) filters.
    body('cid')
      .optional({ nullable: true })
      .isInt({ min: 1 }).withMessage('cid must be a positive integer')
      .toInt(),

    body('bid')
      .optional({ nullable: true })
      .isInt({ min: 1 }).withMessage('bid must be a positive integer')
      .toInt(),

    body('did')
      .optional({ nullable: true })
      .isInt({ min: 1 }).withMessage('did must be a positive integer')
      .toInt(),

    body('nid')
      .optional({ nullable: true })
      .isInt({ min: 1 }).withMessage('nid must be a positive integer')
      .toInt(),
  ];
};

/* --------------------------------------------------------------------- */
/*  Filter Building Functions                                             */
/* --------------------------------------------------------------------- */

/**
 * Build location filter SQL conditions with parameterized queries
 * Supports string search, string-array exact IN (columns 2,3,4,7), and ID array search (5,6)
 * @param {Array} locationFilter - Array of [searchText, columnIndices] pairs
 * @returns {Object} - { sql: string, params: object }
 */
function buildLocationFilter(locationFilter) {
  if (!locationFilter || !Array.isArray(locationFilter)) {
    return { sql: '', params: {} };
  }

  const conditions = [];
  const params = {};
  let paramIndex = 0;

  const columnMap = {
    0: 'street',
    1: 'building',
    2: 'towncity',
    3: 'suburblocality',
    4: 'matchpostcode',
    5: 'cn',
    6: 'ctids',
    7: 'a'
  };

  for (const locationItem of locationFilter) {
    if (!Array.isArray(locationItem) || locationItem.length !== 2) continue;

    const [searchText, columnIndices] = locationItem;

    if (!Array.isArray(columnIndices) || columnIndices.length === 0) continue;

    if (typeof searchText === 'string') {
      // String search: LIKE on address columns (0-3), exact match on postcode columns (4,7)
      const validIndices = columnIndices.filter(idx => (idx >= 0 && idx <= 4) || idx === 7);
      if (validIndices.length === 0) continue;

      const paramName = `str_location_${paramIndex}`;
      const columnConditions = validIndices.map(idx => {
        // Exact match for postcode (4) and area code (7), LIKE for others
        if (idx === 4 || idx === 7) {
          return `p.${columnMap[idx]} = @${paramName}`;
        } else {
          return `p.${columnMap[idx]} LIKE @${paramName} + '%'`;
        }
      });

      conditions.push(`(${columnConditions.join(' OR ')})`);
      params[paramName] = searchText;
      paramIndex++;

    } else if (Array.isArray(searchText) && searchText.length > 0) {
      const allIntegers = searchText.every(Number.isInteger);
      const allCtidValues = searchText.every(isCtidFilterValue);
      const ctidColOnly =
        columnIndices.includes(6) && columnIndices.every((idx) => idx === 6);

      if (allIntegers) {
        // Array of IDs: Parameterized CHARINDEX on CSV columns (5,6)
        const validIndices = columnIndices.filter(idx => (idx === 5 || idx === 6) && columnMap[idx]);
        if (validIndices.length === 0) continue;

        const columnConditions = [];

        for (const idx of validIndices) {
          for (const id of searchText) {
            const paramName = `id_location_${paramIndex}`;
            columnConditions.push(`CHARINDEX(',' + CAST(@${paramName} AS VARCHAR(20)) + ',', ',' + ISNULL(p.${columnMap[idx]}, '') + ',') > 0`);
            params[paramName] = id;
            paramIndex++;
          }
        }

        if (columnConditions.length > 0) {
          conditions.push(`(${columnConditions.join(' OR ')})`);
        }
      } else if (allCtidValues && ctidColOnly) {
        const columnConditions = [];

        for (const raw of searchText) {
          const paramName = `id_location_${paramIndex}`;
          columnConditions.push(
            `CHARINDEX(',' + CAST(@${paramName} AS VARCHAR(20)) + ',', ',' + ISNULL(p.ctids, '') + ',') > 0`
          );
          params[paramName] = normalizeCtidFilterParam(raw);
          paramIndex++;
        }

        if (columnConditions.length > 0) {
          conditions.push(`(${columnConditions.join(' OR ')})`);
        }
      } else if (searchText.every(s => typeof s === 'string')) {
        // Exact IN list on towncity (2), suburblocality (3), matchpostcode (4), area (7)
        const stringListCols = new Set([2, 3, 4, 7]);
        const trimmedUnique = [];
        const seen = new Set();
        for (const s of searchText) {
          const t = String(s).trim();
          if (t.length === 0) continue;
          if (seen.has(t)) continue;
          seen.add(t);
          trimmedUnique.push(t);
        }
        if (trimmedUnique.length === 0) continue;

        const validIndices = columnIndices.filter(idx => stringListCols.has(idx) && columnMap[idx]);
        if (validIndices.length === 0) continue;

        const listGroup = paramIndex++;
        const placeholders = trimmedUnique.map(
          (_, i) => `@strlist_location_${listGroup}_${i}`
        );
        trimmedUnique.forEach((val, i) => {
          params[`strlist_location_${listGroup}_${i}`] = val;
        });

        const columnConditions = validIndices.map(
          idx => `p.${columnMap[idx]} IN (${placeholders.join(', ')})`
        );
        conditions.push(`(${columnConditions.join(' OR ')})`);
      }
    }
  }

  return {
    sql: conditions.length > 0 ? conditions.join(' AND ') : '',
    params: params
  };
}

/**
 * Build subtypes filter SQL conditions using CHARINDEX for CSV matching
 *
 * The sentinel id 1000 ("Commercial Property") is NOT a subtype — it is a
 * catch-all that means "any commercial property TYPE". It is handled here as a
 * special case matched against `p.types`, while every other id keeps matching
 * `p.pstids`; the two sets are OR'd together.
 *
 * This mirrors the 4prop PHP source of truth, which keeps the sentinel and the
 * type list as two distinct constants (seo/constants.php):
 *
 *   define('COMMERCIAL_PSTID', 1000);
 *   define('COMMERCIAL_TYPES_ARRAY', [0, 8, 9, 2, 7, 3, 4]);
 *
 * and, in Entities/Properties.php, REMOVES 1000 from the subtype array before
 * splicing those ids into the TYPE array — so they are filtered as `types:`,
 * never as `pstids:`.
 *
 * Applying the type ids to `p.pstids` instead (as this did previously) fails
 * silently rather than loudly: ids 0-9 are all real subtype ids in the Rural /
 * Retail types, so the query still returns plausible-looking rows. On the
 * `/commercial` catalogue that scored 281 properties instead of ~31.5k, and it
 * surfaced woodland and fisheries listings as "Commercial".
 *
 * @param {Array} subtypes - Array of subtype IDs
 * @returns {string} - SQL condition string
 */
function buildSubtypesFilter(subtypes) {
  if (!Array.isArray(subtypes) || subtypes.length === 0) {
    return '';
  }

  const conditions = [];

  // Sentinel 1000 → match the commercial property TYPES on p.types.
  if (subtypes.includes(COMMERCIAL_PSTID)) {
    const typeConditions = COMMERCIAL_TYPES_ARRAY.map(typeId =>
      `CHARINDEX(',${typeId},', ',' + ISNULL(p.types, '') + ',') > 0`
    );
    conditions.push(`(${typeConditions.join(' OR ')})`);
  }

  // Every other id is a real subtype → match p.pstids as usual.
  const realSubtypes = [...new Set(subtypes.filter(s => s !== COMMERCIAL_PSTID))];
  for (const subtype of realSubtypes) {
    conditions.push(`CHARINDEX(',${subtype},', ',' + ISNULL(p.pstids, '') + ',') > 0`);
  }

  if (conditions.length === 0) {
    return '';
  }

  return `(${conditions.join(' OR ')})`;
}

/**
 * Build tenure filter SQL conditions using bitwise operations
 * @param {number} tenure - Tenure bitwise flag
 * @returns {string} - SQL condition string
 */
function buildTenureFilter(tenure) {
  if (!tenure || tenure === 0) {
    return '';
  }

  return `(p.tenure & @tenure) > 0`;
}

/**
 * Build company filter — matches cid in comma-delimited p.cids CSV.
 * Legacy pattern: CIDS LIKE '%,{cid},%'
 * @param {number|string|null|undefined} cid - Company id
 * @returns {string} - SQL condition string
 */
function buildCompanyFilter(cid) {
  const cidNum = typeof cid === 'string' ? parseInt(cid, 10) : cid;
  if (!Number.isInteger(cidNum) || cidNum <= 0) {
    return '';
  }

  return `CHARINDEX(',' + CAST(@cid AS VARCHAR(20)) + ',', ',' + ISNULL(p.cids, '') + ',') > 0`;
}

/**
 * Build department filter — matches did in comma-delimited p.dids CSV.
 * @param {number|string|null|undefined} did - Department id
 * @returns {string} - SQL condition string
 */
function buildDepartmentFilter(did) {
  const didNum = typeof did === 'string' ? parseInt(did, 10) : did;
  if (!Number.isInteger(didNum) || didNum <= 0) {
    return '';
  }

  return `CHARINDEX(',' + CAST(@did AS VARCHAR(20)) + ',', ',' + ISNULL(p.dids, '') + ',') > 0`;
}

/**
 * Build branch filter — matches bid in comma-delimited p.bids CSV.
 * @param {number|string|null|undefined} bid - Branch id
 * @returns {string} - SQL condition string
 */
function buildBranchFilter(bid) {
  const bidNum = typeof bid === 'string' ? parseInt(bid, 10) : bid;
  if (!Number.isInteger(bidNum) || bidNum <= 0) {
    return '';
  }

  return `CHARINDEX(',' + CAST(@bid AS VARCHAR(20)) + ',', ',' + ISNULL(p.bids, '') + ',') > 0`;
}

/**
 * Build negotiator ("deals with") filter — matches nid in p.Dealswith, the
 * dealing-negotiator list (comma-wrapped, e.g. ",47730,"). This is the same
 * field the "My listing" badge checks, so /my-dealing and the badge agree.
 * NOTE: this is deliberately NOT p.NIDAdmin — that's the admin negotiator, a
 * different role that rarely matches the dealing agent.
 * @param {number|string|null|undefined} nid - Negotiator id
 * @returns {string} - SQL condition string
 */
function buildNidFilter(nid) {
  const nidNum = typeof nid === 'string' ? parseInt(nid, 10) : nid;
  if (!Number.isInteger(nidNum) || nidNum <= 0) {
    return '';
  }

  return `CHARINDEX(',' + CAST(@nid AS VARCHAR(20)) + ',', ',' + ISNULL(p.Dealswith, '') + ',') > 0`;
}

/**
 * Build sqft overlap filter without dbo.a_fnSizeOK — that function CONVERTs MONEY
 * sqft columns to INT and throws SQL error 237 on out-of-range property rows.
 * @param {string} minParam - Bound SQL parameter name for minimum filter
 * @param {string} maxParam - Bound SQL parameter name for maximum filter
 * @param {string} minCol - Property minimum sqft column
 * @param {string} maxCol - Property maximum sqft column
 * @param {number} min - Parsed minimum filter value (0 = no bound)
 * @param {number} max - Parsed maximum filter value (0 = no bound)
 * @returns {string}
 */
function buildSqftOverlapFilter(minParam, maxParam, minCol, maxCol, min, max) {
  if (min === 0 && max === 0) {
    return '';
  }

  const parts = [];
  if (min > 0) {
    parts.push(`(ISNULL(CAST(${maxCol} AS FLOAT), 0) = 0 OR CAST(${maxCol} AS FLOAT) >= @${minParam})`);
  }
  if (max > 0) {
    parts.push(`(ISNULL(CAST(${minCol} AS FLOAT), 0) = 0 OR CAST(${minCol} AS FLOAT) <= @${maxParam})`);
  }
  return parts.length ? `(${parts.join(' AND ')})` : '';
}

/**
 * Build size filter SQL conditions for internal sqft overlap.
 * @param {string|number} sizeMin - Minimum internal size
 * @param {string|number} sizeMax - Maximum internal size
 * @returns {string} - SQL condition string
 */
function buildSizeFilter(sizeMin, sizeMax) {
  const min = parseInt(sizeMin) || 0;
  const max = parseInt(sizeMax) || 0;

  return buildSqftOverlapFilter('sizeMin', 'sizeMax', 'p.minintsqft', 'p.maxintsqft', min, max);
}

/**
 * Build land filter SQL conditions for external sqft overlap.
 * @param {string|number} landMin - Minimum external size (land)
 * @param {string|number} landMax - Maximum external size (land)
 * @returns {string} - SQL condition string
 */
function buildLandFilter(landMin, landMax) {
  const min = parseInt(landMin) || 0;
  const max = parseInt(landMax) || 0;

  return buildSqftOverlapFilter('landMin', 'landMax', 'p.minextsqft', 'p.maxextsqft', min, max);
}

/**
 * Allowed Browse variants that emit a `p`-predicate via buildVariantFilter.
 * 'each-alert' is deliberately absent: it is handled by eachAlertScope (a dedicated
 * subquery with its own JOIN + status filter), not by a folded-in predicate, so
 * buildVariantFilter('each-alert', …) must stay a harmless no-op.
 */
const VARIANTS_WITH_PREDICATE = new Set(['auctions', 'businesses-for-sale', 'pop-up-shops']);

/** YYMMDD — exactly six digits. Anything else is rejected before reaching SQL. */
const AUCTION_DATE_PATTERN = /^\d{6}$/;

/** EACH-alert "since" lower bound on a.d — 6 to 12 digits (YYMMDD..YYMMDDHHMMSS). */
const ALERT_SINCE_PATTERN = /^\d{6,12}$/;

/**
 * Build a listing-variant SQL predicate.
 *
 * Variants are mutually exclusive — only the matching predicate is emitted.
 * `auctionDate` (YYMMDD) is honoured only when variant === 'auctions'; when
 * present, it replaces the broad 6-digit LIKE with a fixed-date match.
 *
 * @param {string|undefined} variant
 * @param {string|undefined} auctionDate
 * @returns {{ sql: string, params: Object }}
 */
function buildVariantFilter(variant, auctionDate) {
  if (!variant || !VARIANTS_WITH_PREDICATE.has(variant)) {
    return { sql: '', params: {} };
  }

  if (variant === 'businesses-for-sale') {
    return {
      sql: `CHARINDEX(',192,', ',' + ISNULL(p.ai, '') + ',') > 0`,
      params: {},
    };
  }

  if (variant === 'pop-up-shops') {
    return {
      sql: `CHARINDEX(',19,', ',' + ISNULL(p.pstids, '') + ',') > 0`,
      params: {},
    };
  }

  // variant === 'auctions'
  if (typeof auctionDate === 'string' && AUCTION_DATE_PATTERN.test(auctionDate)) {
    return {
      sql: `p.info2 LIKE '%' + @auctionDate + '%'`,
      params: { auctionDate },
    };
  }

  return {
    sql: `p.info2 LIKE '%[0-9][0-9][0-9][0-9][0-9][0-9]%'`,
    params: {},
  };
}

/**
 * Build the optional EACH-alert "since" predicate (a.d > @alertSince).
 *
 * References alias `a` (a_rpEACHAlert), which exists only in eachAlertScope, so this is
 * gated on variant === 'each-alert' to guarantee it can never leak into a non-EACH
 * subquery even if `since` is sent with another variant. Returns the SQL fragment +
 * the param to bind; an empty fragment when not applicable.
 *
 * @param {string|undefined} since - validated 6-12 digit lower bound on a.d
 * @param {string|undefined} variant
 * @returns {{ sql: string, params: Object }}
 */
function buildAlertSinceFilter(since, variant) {
  if (variant !== 'each-alert') {
    return { sql: '', params: {} };
  }
  if (typeof since !== 'string' || !ALERT_SINCE_PATTERN.test(since)) {
    return { sql: '', params: {} };
  }
  return { sql: 'a.d > @alertSince', params: { alertSince: since } };
}

/**
 * Build the EACH-alert OWNER predicate (a.n = @alertOwnerNid).
 *
 * This is the faithful port of the legacy proc's negotiator scoping: the proc matched
 * a_rpEACHAlert.n (the alert's OWNER negotiator) — resolved from the email-link hash —
 * NOT the property's Dealswith list. Here the owner nid is resolved upstream (hash, else
 * the logged-in agent's nid) and passed in. References alias `a`, so gated to each-alert.
 *
 * @param {number|string|null|undefined} ownerNid - resolved alert-owner negotiator id
 * @param {string|undefined} variant
 * @returns {{ sql: string, params: Object }}
 */
function buildAlertOwnerFilter(ownerNid, variant) {
  if (variant !== 'each-alert') {
    return { sql: '', params: {} };
  }
  const str = String(ownerNid ?? '').trim();
  if (!/^\d+$/.test(str)) {
    return { sql: '', params: {} };
  }
  return { sql: 'a.n = @alertOwnerNid', params: { alertOwnerNid: str } };
}

/**
 * Bind location filter params from buildLocationFilter (mssql request).
 * id_location_* uses VarChar — ctids may be numeric or alphanumeric (AB, PH).
 * @param {import('mssql').Request} request
 * @param {Record<string, unknown>} locationParams
 * @param {typeof import('mssql')} sql
 */
export function bindLocationFilterParams(request, locationParams, sql) {
  if (!locationParams || typeof locationParams !== 'object') return;

  for (const [paramName, searchValue] of Object.entries(locationParams)) {
    if (paramName.startsWith('str_location_') || paramName.startsWith('strlist_location_')) {
      request.input(paramName, sql.NVarChar, searchValue);
    } else if (paramName.startsWith('id_location_')) {
      request.input(paramName, sql.VarChar(CTID_VALUE_MAX_LEN), String(searchValue));
    }
  }
}

/**
 * Bind @cid / @bid / @did / @nid when company, branch, department or
 * negotiator filters are active.
 * Bound as VarChar(20): the id columns (cid/bid/did/nid) are varchar(20) and some
 * ids exceed 32-bit int range (e.g. timestamp-style bids like 220116104533),
 * so sql.Int would overflow. The filter SQL CASTs the param to VARCHAR anyway.
 * @param {import('mssql').Request} request
 * @param {{ cid?, bid?, did?, nid? }} filters
 * @param {typeof import('mssql')} sql
 */
export function bindCompanyDepartmentFilterParams(request, { cid, bid, did, nid } = {}, sql) {
  const bindId = (name, value) => {
    const str = String(value ?? '').trim();
    if (/^\d+$/.test(str)) {
      request.input(name, sql.VarChar(20), str);
    }
  };

  bindId('cid', cid);
  bindId('bid', bid);
  bindId('did', did);
  bindId('nid', nid);
}

/* --------------------------------------------------------------------- */
/*  Exports                                                               */
/* --------------------------------------------------------------------- */

export {
  validateFilters,
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
  buildAlertOwnerFilter,
  AUCTION_DATE_PATTERN,
  ALERT_SINCE_PATTERN
};
