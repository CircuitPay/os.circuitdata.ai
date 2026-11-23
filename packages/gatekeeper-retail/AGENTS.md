# Retail data

Retail data — a tenant-held account (organization or personal workspace) whose `RETAIL_DATA` session
lets agents `describe`, `query` (read-only SQL through `src/dataset/sql-guard.ts` over masked public
views) and compute standard metrics over sales, products, customers and inventory loaded from Square,
Stripe and CSV. `docs/retail-data.md` is the operator guide; `specs/006-retail-data-layer/` is the
design record.

- `RetailDataset` (one SQLite DO per dataset) is the single writer of storage tables, views, rollups
  and runs; every method names the dataset id it expects. Provider credentials never leave
  `RetailConnection`. Raw records go to the `RETAIL_RAW` R2 bucket so mappings can be rebuilt.
- The Data app (`app/`, single-file React SPA) calls `RetailAppApi`, which re-reads
  `TenantAccess.current()` on **every** method: administrator-only actions (connect, settings, erase,
  match review) check `canManage` per call, never a cached role.
- Matching never links by itself: email/SKU proposals are pre-ticked, name-only ones are not, and only
  a confirmation sets `canonical_*_id`.
