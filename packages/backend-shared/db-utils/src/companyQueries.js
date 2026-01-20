import { normaliseList } from './extractIds.js';

/**
 * SQL fragment to extract first company ID from CIDS field
 * CIDS format: ",123,456," (with leading/trailing commas)
 * SQL Server 2008 compatible
 *
 * Usage: SELECT ${EXTRACT_FIRST_CID_SQL} AS first_cid FROM table p
 */
export const EXTRACT_FIRST_CID_SQL = `
  CASE
    WHEN LEN(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END)) > 0
    AND ISNUMERIC(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END)) = 1
    THEN CAST(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END) AS BIGINT)
    ELSE NULL
  END
`;

/**
 * Get company details by CIDs
 * @param {object} pool - MSSQL connection pool
 * @param {Array<string|number>} cids - Array of company IDs
 * @returns {Promise<Map<string, {cid: string, name: string}>>} Map of cid -> company info
 */
export async function getCompaniesByCids(pool, cids) {
  const ids = normaliseList(cids, { coerce: 'string' });
  if (!ids.length) return new Map();

  // Use parameterized query to avoid SQL injection and handle large IDs
  const request = pool.request();
  const placeholders = ids.map((id, i) => {
    request.input(`cid${i}`, id);
    return `@cid${i}`;
  }).join(', ');

  const result = await request.query(`
    SELECT cid, name
    FROM a_rcCompany
    WHERE cid IN (${placeholders})
  `);

  const map = new Map();
  result.recordset.forEach(row => map.set(String(row.cid), { cid: row.cid, name: row.name }));
  return map;
}

/**
 * Extract first CID from CIDS string (JavaScript version)
 * @param {string} cids - Comma-separated CIDs like ",123,456,"
 * @returns {string|null} First CID as string or null
 */
export function extractFirstCid(cids) {
  if (!cids || typeof cids !== 'string') return null;
  // CIDS format is ",123,456," - extract first number after leading comma
  const match = cids.match(/^,(\d+),/);
  return match ? match[1] : null;
}
