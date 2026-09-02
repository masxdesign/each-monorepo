# @4prop/listing

Shared query builders for the property-listing surface — the listing, map, search and detail pages.

> **Why `listing` but `agentb-*.js`?** The package is named for its domain. The routes it backs are
> still mounted at `/api/crm/mag/agentb` (path parity keeps cutover a base-URL change), and the
> filenames keep the `agentb-` prefix so they stay **byte-identical** to bizchat's
> `routes/helpers/` copies — that `diff -q` is the duplication guard while bizchat is the live
> fallback. Rename the files only once bizchat's copies are deleted.

This package is **SQL construction only**. Every export is a pure function returning a query string
or a filter fragment. It holds no database connection, no driver, and no framework coupling beyond
`express-validator` for the filter validators.

## The one rule: never import `mssql`

```js
// ✗ NEVER
import sql from 'mssql'

// ✓ ALWAYS — the host passes its own copy in
export function bindCompanyDepartmentFilterParams(request, filters, sql) { … }
```

### Why

The monorepo resolves two different mssql majors:

```
node_modules/mssql                                 -> 11.0.1   (hoisted — bizchat gets this)
apps/backend/property-pub/code/node_modules/mssql  -> 12.1.1   (nested)
node_modules/tedious                               -> 19.2.0   (one copy, shared)
```

A type object minted by one wrapper and handed to the other's `Request` is the documented failure
mode — `parameter.type.validate is not a function` (see `@4prop/stripe`'s README, which solved the
same problem by dropping explicit types entirely).

That failure does **not** currently reproduce in this tree, because both wrappers delegate to the
single hoisted `tedious@19.2.0`:

| | result |
|---|---|
| v11 `Request` + v12 `Int` | OK |
| v12 `Request` + v11 `Int` | OK |

But that is luck, not design — it holds only while tedious stays hoisted and single. One
`npm install` that nests a second copy brings the failure back.

So this package does not rely on it. `mssql` is a **peerDependency** and is never imported; the
host injects its own `sql`, guaranteeing every type object is minted by the copy that owns the
`Request` using it. Version-proof by construction.

The payoff: **all explicit types are preserved.** That matters — several bindings are silently
wrong under type inference:

- `sql.BigInt` on `pid` / `grade_user_id` — inference gives `Int`, which overflows for large pids
- `sql.VarChar(20)` on cid/bid/did/nid — ids like `220116104533` exceed 32-bit int range, and
  inference to `NVarChar` also changes collation on the `CHARINDEX` filters against `Dealswith`
- `sql.VarChar(12)` on `alertSince` — the bounded length is load-bearing

### Guard

```bash
grep -rn "from 'mssql'" packages/backend-shared/agentb/src/   # must return nothing
```

## Usage

```js
import { validateFilters, buildMapPropertiesQuery } from '@4prop/listing'
import sql from 'mssql'          // the HOST imports it, not the package

const pool = await getConnection()
const request = pool.request()
bindCompanyDepartmentFilterParams(request, filters, sql)   // host's own sql
```

Subpath imports are available if you prefer them to the barrel:

```js
import { buildMapPropertiesQuery } from '@4prop/listing/queries'
```

## Contents

| Module | Lines | What it does |
|---|---|---|
| `agentb-filters.js` | 802 | Filter fragment builders + `express-validator` chains |
| `siteModePropertyScope.js` | 656 | Site-mode → property-scope resolution, county/region aggregation |
| `agentb-requirements-queries.js` | 406 | EACH-alert requirements queries |
| `agentb-queries.js` | 307 | Listing, map and detail query construction |

## Consumers

- **property-pub** — `src/routes/agentb/` (the first-party listing surface)
- **bizchat** — still serves the same routes from its own `src/routes/helpers/` copies

> ⚠️ **bizchat's copies are currently duplicated, not shared.** They are kept as a live fallback
> while property-pub's implementation is proven. A fix applied to one and not the other will
> diverge silently. Once property-pub is serving the SPA, repoint bizchat at this package (or
> delete its routes) and remove the duplicates.

## What deliberately stays in bizchat

`api-mag-agentb-shortlists.js` is **not** here and should not be moved. Its share-jobs pull BullMQ,
Redis and the messaging stack; extracting it would drag that infrastructure into a shared package.
