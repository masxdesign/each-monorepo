# Plan: Group Properties by Company in Preview Dialog

## Summary
Update the Property Scheduler preview dialog to group properties by company/agency using an accordion pattern. Properties will be grouped by their first company ID from the CIDS field, with stats (To Insert / To Skip / Total) shown per company.

---

## Part 1: Create Shared Package `@4prop/db-utils`

### 1.1 Create Package Structure

**New folder**: `packages/backend-shared/db-utils/`

```
db-utils/
├── package.json
├── README.md
└── src/
    ├── extractIds.js      # Moved from bizchat
    └── companyQueries.js  # New - company lookup helpers
```

### 1.2 Package Configuration

**File**: `packages/backend-shared/db-utils/package.json`

```json
{
  "name": "@4prop/db-utils",
  "version": "1.0.0",
  "description": "Shared database utilities for CIDS/DIDs parsing and company lookups",
  "type": "module",
  "exports": {
    ".": "./src/extractIds.js",
    "./extractIds": "./src/extractIds.js",
    "./companyQueries": "./src/companyQueries.js"
  },
  "peerDependencies": {
    "mssql": "^11.0.0"
  }
}
```

### 1.3 Move extractIds.js

**From**: `apps/backend/bizchat/code/src/utils/extractIds.js`
**To**: `packages/backend-shared/db-utils/src/extractIds.js`

Exports:
- `normaliseList(input, options)` - General CSV/array parser
- `extractIdsFromProperties(properties, fieldNames)` - Extract IDs from properties
- `extractCidsFromProperties(properties)` - Convenience wrapper for CIDs
- `extractDidsFromProperties(properties)` - Convenience wrapper for DIDs

### 1.4 Create companyQueries.js

**File**: `packages/backend-shared/db-utils/src/companyQueries.js`

```javascript
import { normaliseList } from './extractIds.js';

/**
 * SQL fragment to extract first company ID from CIDS field
 * CIDS format: ",123,456," (with leading/trailing commas)
 * SQL Server 2008 compatible
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
 * @param {Array<number>} cids - Array of company IDs
 * @returns {Promise<Map<number, {cid, name}>>} Map of cid -> company info
 */
export async function getCompaniesByCids(pool, cids) {
  const ids = normaliseList(cids, { coerce: 'number' });
  if (!ids.length) return new Map();

  const result = await pool.request().query(`
    SELECT cid, name
    FROM a_rcCompany
    WHERE cid IN (${ids.join(',')})
  `);

  const map = new Map();
  result.recordset.forEach(row => map.set(row.cid, row));
  return map;
}

/**
 * Extract first CID from CIDS string (JavaScript version)
 * @param {string} cids - Comma-separated CIDs like ",123,456,"
 * @returns {number|null} First CID or null
 */
export function extractFirstCid(cids) {
  if (!cids || typeof cids !== 'string') return null;
  const match = cids.match(/^,(\d+),/);
  return match ? parseInt(match[1], 10) : null;
}
```

### 1.5 Update Workspace Config

**File**: `package.json` (monorepo root) - Add to workspaces array:

```json
"workspaces": [
  "packages/backend-shared/oauth",
  "packages/backend-shared/db-utils",  // Add this
  ...
]
```

### 1.6 Update Consumers

**bizchat**: Update imports from local to package
```javascript
// Before
import { normaliseList, extractCidsFromProperties } from '../utils/extractIds.js';

// After
import { normaliseList, extractCidsFromProperties } from '@4prop/db-utils';
```

**property-pub**: Add dependency to package.json
```json
"dependencies": {
  "@4prop/db-utils": "*",
  ...
}
```

---

## Part 2: Backend - Property Scheduler Updates

### 2.1 Update propertySchedulerService.js

**File**: `apps/backend/property-pub/code/src/features/propertyScheduler/services/propertySchedulerService.js`

**Changes:**

1. Import from new package:
```javascript
import { extractFirstCid, getCompaniesByCids } from '@4prop/db-utils/companyQueries';
```

2. Update `getPropertyDetails()` to also fetch `cids` field

3. Update cache structure to include company grouping:
```javascript
previewCache.set(sessionId, {
  allItems,           // [{pid, action, cid}, ...]
  companiesMap,       // Map<cid, {cid, name, toInsertCount, toSkipCount, total}>
  total,
  toInsertCount,
  toSkipCount,
  createdAt
});
```

4. **New function**: `previewBulkInsertByCompany()`
```javascript
export async function previewBulkInsertByCompany({ selectQuery, start_date, week_no, sessionId = null }) {
  // Uses same caching as previewBulkInsert
  // Returns: { companies: [...], total, toInsertCount, toSkipCount, sessionId }
}
```

5. **New function**: `getCompanyPreviewProperties()`
```javascript
export async function getCompanyPreviewProperties({ sessionId, companyId, cursor = 0, limit = 50 }) {
  // Fetches properties for a specific company from cached session
  // Returns: { items: [...], nextCursor, total }
}
```

### 2.2 Update routes.js

**File**: `apps/backend/property-pub/code/src/features/propertyScheduler/routes.js`

**New endpoints:**

```javascript
// Get preview grouped by company (returns company stats, not individual properties)
router.post('/preview/by-company', async (req, res, next) => {
  const { advertiser_id, start_date, week_no, sessionId } = req.body;
  // Validates, loads query, calls previewBulkInsertByCompany
});

// Get properties for a specific company (lazy load when accordion expands)
router.post('/preview/company/:companyId/properties', async (req, res, next) => {
  const { companyId } = req.params;
  const { sessionId, cursor, limit } = req.body;
  // Calls getCompanyPreviewProperties
});
```

---

## Part 3: Frontend Updates

### 3.1 Update Service Functions

**File**: `apps/frontend/4prop-crm-react/src/services/propertySchedulerService.js`

```javascript
export const previewBulkInsertByCompany = async ({ advertiser_id, start_date, week_no, sessionId }) => {
  const { data } = await propertyPubClient.post('/api/property-scheduler/preview/by-company', {
    advertiser_id, start_date, week_no, sessionId
  });
  return data;
};

export const getCompanyPreviewProperties = async ({ sessionId, companyId, cursor = 0, limit = 50 }) => {
  const { data } = await propertyPubClient.post(
    `/api/property-scheduler/preview/company/${companyId}/properties`,
    { sessionId, cursor, limit }
  );
  return data;
};
```

### 3.2 Update PropertySchedulerForm.jsx

**File**: `apps/frontend/4prop-crm-react/src/components/PropertyScheduler/PropertySchedulerForm.jsx`

**Replace** the VirtualizedInfiniteTable in the preview dialog with an accordion-based grouped view:

1. Add state for expanded companies:
```javascript
const [expandedCompanies, setExpandedCompanies] = useState(new Set());
```

2. Use new query for company-grouped preview:
```javascript
const { data: companyPreview } = useQuery({
  queryKey: ['property-scheduler-preview-companies', previewParams],
  queryFn: () => previewBulkInsertByCompany(previewParams),
  enabled: previewOpen && !!previewParams,
});
```

3. Update Dialog content structure:
```jsx
<Dialog>
  <DialogContent className="max-w-5xl max-h-[90vh]">
    <DialogHeader>...</DialogHeader>

    {/* Overall Stats */}
    <StatsGrid stats={companyPreview} />

    {/* Company Accordion List */}
    <div className="flex-1 overflow-y-auto">
      {companyPreview?.companies.map(company => (
        <CompanyAccordionItem
          key={company.company_id}
          company={company}
          isExpanded={expandedCompanies.has(company.company_id)}
          onToggle={() => toggleCompany(company.company_id)}
          sessionId={companyPreview.sessionId}
        />
      ))}
    </div>

    <DialogFooter>...</DialogFooter>
  </DialogContent>
</Dialog>
```

4. **CompanyAccordionItem** component (inline or separate file):
   - Header: Company Name | To Insert (green) | To Skip (yellow) | Total (blue)
   - Expanded: VirtualizedInfiniteTable with lazy-loaded properties

---

## Files Summary

| Action | File |
|--------|------|
| **Create** | `packages/backend-shared/db-utils/package.json` |
| **Create** | `packages/backend-shared/db-utils/src/extractIds.js` (move from bizchat) |
| **Create** | `packages/backend-shared/db-utils/src/companyQueries.js` |
| **Create** | `packages/backend-shared/db-utils/README.md` |
| **Modify** | `package.json` (root - add workspace) |
| **Modify** | `apps/backend/bizchat/code/package.json` (add @4prop/db-utils) |
| **Modify** | `apps/backend/bizchat/code/src/...` (update imports) |
| **Modify** | `apps/backend/property-pub/code/package.json` (add @4prop/db-utils) |
| **Modify** | `apps/backend/property-pub/.../propertySchedulerService.js` |
| **Modify** | `apps/backend/property-pub/.../routes.js` |
| **Modify** | `apps/frontend/.../propertySchedulerService.js` |
| **Modify** | `apps/frontend/.../PropertySchedulerForm.jsx` |

---

## Implementation Order

1. **Create shared package** (`@4prop/db-utils`)
2. **Update root workspace config**
3. **Run npm install** from monorepo root
4. **Update bizchat imports** (verify no breakage)
5. **Add backend service functions** (property-pub)
6. **Add backend routes** (property-pub)
7. **Add frontend service functions**
8. **Update frontend preview dialog**

---

## Verification

1. **Shared package works:**
   - `npm install` from root completes without errors
   - bizchat still works with updated imports

2. **Backend endpoints work:**
   - `POST /api/property-scheduler/preview/by-company` returns company-grouped stats
   - `POST /api/property-scheduler/preview/company/:id/properties` returns properties

3. **Frontend works:**
   - Preview dialog shows companies in accordion
   - Clicking company expands to show properties
   - Insert button uses correct count
   - Insert operation succeeds
