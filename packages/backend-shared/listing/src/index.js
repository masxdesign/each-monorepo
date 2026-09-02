/**
 * @4prop/listing — shared query builders for the property-listing surface.
 *
 * Named for the domain, not the endpoint. The routes it backs are still mounted
 * at /api/crm/mag/agentb, and the filenames below still carry the `agentb-`
 * prefix so they stay byte-identical to bizchat's routes/helpers/ copies while
 * those remain the live fallback. Rename them once bizchat's copies are gone.
 *
 * Everything here is pure SQL construction: functions that return query strings
 * and filter fragments. There is no database connection, no driver, and no
 * framework coupling beyond `express-validator` for the filter validators.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ NEVER `import sql from 'mssql'` IN THIS PACKAGE.                        │
 * │                                                                         │
 * │ bizchat resolves mssql v11 (hoisted at the workspace root) and          │
 * │ property-pub v12 (nested). A type object minted by one wrapper reaching  │
 * │ the other's Request is the documented failure mode                      │
 * │ ("parameter.type.validate is not a function" — see @4prop/stripe).      │
 * │                                                                         │
 * │ Instead, the HOST passes its own `sql` in, so every type object is      │
 * │ always minted by the same copy that owns the Request consuming it.      │
 * │ `bindCompanyDepartmentFilterParams(request, filters, sql)` is the       │
 * │ existing example of the pattern — follow it for anything added here.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Re-exported wholesale rather than by name: these modules own their public
 * surface, and hand-listing it here would silently drift the moment one of them
 * adds an export.
 */

export * from './agentb-filters.js'
export * from './siteModePropertyScope.js'
export * from './agentb-queries.js'
export * from './agentb-requirements-queries.js'
