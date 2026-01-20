# @4prop/db-utils

Shared database utilities for CIDS/DIDs parsing and company lookups.

## Installation

This package is part of the monorepo workspace. Add to your project's `package.json`:

```json
{
  "dependencies": {
    "@4prop/db-utils": "*"
  }
}
```

Then run `npm install` from the monorepo root.

## Usage

### Extract IDs from CSV strings

```javascript
import { normaliseList, extractCidsFromProperties } from '@4prop/db-utils';

// Parse CSV string to array of numbers
const ids = normaliseList('1,2,3,4'); // [1, 2, 3, 4]

// Extract CIDs from properties array
const properties = [{ CIDs: ',123,456,' }, { CIDs: ',789,' }];
const cids = extractCidsFromProperties(properties); // ['123', '456', '789']
```

### Company lookups

```javascript
import { getCompaniesByCids, extractFirstCid } from '@4prop/db-utils/companyQueries';

// Get company details by CIDs
const companiesMap = await getCompaniesByCids(pool, [123, 456]);
// Map { 123 => { cid: 123, name: 'Company A' }, 456 => { cid: 456, name: 'Company B' } }

// Extract first CID from CIDS string
const firstCid = extractFirstCid(',123,456,'); // 123
```

### SQL fragments

```javascript
import { EXTRACT_FIRST_CID_SQL } from '@4prop/db-utils/companyQueries';

// Use in SQL queries (SQL Server 2008 compatible)
const query = `
  SELECT p.pid, ${EXTRACT_FIRST_CID_SQL} AS first_cid
  FROM a_rpPropertyNewAll_p22 p
`;
```

## API

### extractIds.js (default export)

- `normaliseList(input, options)` - Parse CSV string or array, with deduplication and type coercion
- `extractIdsFromProperties(properties, fieldNames)` - Extract IDs from array of objects
- `extractCidsFromProperties(properties)` - Convenience wrapper for CIDs
- `extractDidsFromProperties(properties)` - Convenience wrapper for DIDs
- `extractCidsOrDidsFromProperties(properties)` - Extract both in one pass

### companyQueries.js

- `EXTRACT_FIRST_CID_SQL` - SQL fragment for extracting first CID (SQL Server 2008 compatible)
- `getCompaniesByCids(pool, cids)` - Get company details by CIDs
- `extractFirstCid(cids)` - JavaScript version to extract first CID from string
