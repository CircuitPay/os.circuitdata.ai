# Research: Retail Data Layer

Exploration notes behind `spec.md`. All three clarifications are decided: organization ownership
(D1), 10 locations × 3 years (D3), and Toast through CSV only (D5).

## D1. Where the dataset lives, and who owns it (Q1)

**What the repo does today**

- Gatekeeper accounts are **per user**. An auto-provisioned gatekeeper mints its account through
  `GatekeeperVendor.createAccount()`, which takes no identity (`user.ts`), and the account is stored in
  that user's Durable Object. `gatekeeper-context` scopes data by the account id plus a
  deployment-wide `sharingDomain`; nothing in a gatekeeper knows about a tenant.
- The only **per-organization** data store is the kernel's `UserDirectoryDurableObject` (one per
  tenant). Tenant Files keeps its index there and hands out a `TenantFilesApi` capability whose tenant
  is fixed when it is minted from the verified session (`docs/tenant-files.md`).

**Options**

| | Where | Pros | Cons |
|---|---|---|---|
| A1 | New `gatekeeper-retail` package holding connectors, mapping, store and management UI. The kernel gets one small seam: an **organization-held account**, minted once per tenant, stored in the tenant directory and handed to every member's workspace as an ambient binding. | Keeps the bulk out of the kernel; reuses the gatekeeper binding, observation and management-UI machinery spec 007 already assumes; the "organization connection" seam is reusable (an org-shared Stripe or Google connection) | New kernel concept; needs care with the capability rule (the admin enables it, the gatekeeper never claims ambience) |
| A2 | Kernel-hosted store like Tenant Files (a `RetailDataApi` capability from `AuthenticatedApi`) | Mirrors an existing pattern exactly | Large kernel diff (connectors, mapping and SQL serving in the kernel) against the kernel bar; gadgets then need a second way to reach data |
| B | `gatekeeper-retail` with per-user accounts, as gatekeepers work today | No kernel change at all | Data belongs to whoever connected; staff cannot share one dataset except through shared gadgets; leaving the org takes the data with you |

**Decision (2026-11-17): A1.** The dataset is owned by the organization. The organization-held account
is the one kernel change, and it ships as its own small PR, reviewed apart from the gatekeeper.

What that seam needs to settle in `/speckit.plan`:

- **Where the account lives**: in the tenant's `UserDirectoryDurableObject`, beside the `files` table,
  minted by `createAccount()` the first time an administrator enables the data layer for the tenant.
- **How members get it**: when a member's workspace prepares its chat bindings, the Workshop adds the
  tenant's account as an ambient record, the same path auto-provisioned per-user singletons use today
  (`prepareChatBindings`), resolved from the verified session's tenant on each use, so a removed member
  loses it on the next read.
- **Admin versus member capabilities**: members get the read session only; the management UI
  (connections, deletion, PII setting) is minted only for organization administrators
  (`startAppUi({ isAdmin })` already carries that flag).
- **Erasure**: the existing organization-deletion path also erases the account's dataset.

## D2. Integrations are separate gatekeepers, or connectors inside one

**Recommendation**: connectors live **inside** `gatekeeper-retail` (`connectors/square.ts`,
`stripe.ts`, `toast.ts`), each holding its own OAuth credentials and webhook endpoint under
`/gatekeeper/retail/...`.

**Rationale**: the mapping, raw-record store and sync scheduling are shared, and the provider
credentials never need to reach the agent: the agent reads canonical data, not Square. Separate
`gatekeeper-square` etc. would make sense if the agent also needed raw provider access (for example,
to issue refunds). That can come later and reuse the same OAuth code.

**Trade-off**: one gatekeeper needs three OAuth apps' credentials. `deploy-inputs.json` supports
custom inputs per package, so the deploy wizard can ask for each provider's client id and secret,
optional per provider.

## D3. Storage engine (Q2)

| Option | Fits | Limits |
|---|---|---|
| **Durable Object SQLite, one per dataset** | Synchronous SQL, transactional upserts, no extra infra; the repo already uses DO SQLite throughout | 10 GB per object; single-threaded; heavy scans compete with sync writes |
| D1 database per dataset | Same SQLite, managed | Creating databases at runtime needs the Cloudflare API with an account token; not provisioned per tenant by the release pipeline today |
| R2 + Iceberg (R2 Data Catalog) queried with R2 SQL | Columnar; years of history for large chains | Query latency and SQL coverage are still maturing; upserts and corrections are harder; more moving parts |
| External Postgres/warehouse via Hyperdrive | Familiar to analysts | Customer-managed infra; contradicts "connect Square and go" |

**Sizing**: a busy single location does ~100k orders and ~500k line items a year. At ~300 bytes a row
across all tables plus raw records, that is roughly 300–400 MB a year, so ~10 locations × 3 years
(~10 GB) is the practical ceiling of one object.

**Recommendation**: DO SQLite per dataset for the first release, with **raw records in R2** (keyed
`<dataset>/<source>/<run>/…`), not in SQLite, so the 10 GB budget goes to canonical rows and rollups.
Rollups keep dashboard reads off the large tables.

**Decision (2026-11-17): the target is 10 locations × 3 years.** Re-estimating for canonical rows only
(raw records in R2): a busy location-year is ~100k orders, ~500k line items and ~150k transactions,
about 750k rows at ~250 bytes, plus indexes and rollups at roughly 1.5×, so ~280 MB. 30 location-years
is **~8.5 GB, close to the 10 GB cap**. A typical small retailer is well under that, but the target
customer is not guaranteed to be typical, so the plan must not rely on a single object fitting:

- **Start with one object per dataset**, and measure. The first planning task is the SC-006a load test
  with synthetic data at the target, which settles real row sizes and query times.
- **Design the schema so it can be split by location** without changing what consumers see: every
  fact table carries `location_id`, and rollups and metrics are computed per location and then
  combined. If the load test shows less than 25% headroom, the dataset becomes one coordinator object
  (locations, customers, products, rollups, metric API) plus one object per location for orders, line
  items, transactions and inventory. Cross-location SQL then runs over rollups, or fans out per
  location.
- **Watch storage**: each dataset reports its size, and an administrator is warned at 70% of the cap.
- **Beyond the target** (larger chains, longer history): move closed years to an R2/Iceberg history
  tier. Out of scope for the first release.

## D4. Read-only serving

DO SQLite has no read-only role (Supabase's gatekeeper relies on a read-only Postgres role). Options:

1. **Metric/semantic API**: `metric(name, { from, to, groupBy, filters })` over rollups. Safe by
   construction, fast, and consistent definitions. Covers most dashboard tiles.
2. **Guarded SQL**: accept one `SELECT` statement and enforce it with a real parser (allow-list of
   statement type, tables and functions; no `PRAGMA`, `ATTACH` or writes), executed with row and time
   caps. Needed for agent exploration and custom tiles.

**Recommendation**: both: the metric API for spec 007's standard tiles, guarded SQL for everything
else. Verify during planning whether `PRAGMA query_only` is honoured by `ctx.storage.sql`; if it is, it
becomes a second line of defence behind the parser, not a replacement for it.

The binding surface spec 007 consumes then becomes: `describe()`, `run(sql, params, caps)`,
`metric(...)`. That matches 007's source contract plus one method.

## D5. Providers

| | Access | Notes and risks |
|---|---|---|
| **Square** | Self-serve OAuth; read scopes for merchant profile, orders, items, customers, payments, inventory | Best first target. Webhooks for orders, catalog, customers, inventory. Search Orders by location and updated time for incremental sync. |
| **Stripe** | OAuth via Stripe Connect with read-only scope, or a restricted API key | Payments-centric: orders only from Invoices or Checkout. Webhooks for incremental; `created`/`updated` list filters for backfill. |
| **Toast** | No self-serve OAuth. Partner program integration, or restaurant-issued API credentials | **Decision (2026-11-17): CSV only for this release.** See "Toast through CSV" below. |

All of the above to be verified against current provider docs when planning; access terms change.

### Toast through CSV

Toast restaurants can get scheduled data exports: a set of CSVs per business day (as we understand
it: order details, check details, item selection details, modifier selection details, payment
details, and a menu/items report), delivered by SFTP or downloaded from Toast's back office. **To
verify during planning**, using real sample exports: exact file names, columns, id columns that join
them, and how voids, refunds and edited checks appear.

What this means for the import pipeline (D6):

- **Multi-file sets** are a first-class import unit: the user selects several files, the template
  recognises each by its headers, and they are joined on Toast's order/check/selection ids before
  mapping. A set missing a required file is refused with the missing file named.
- **Business date** comes from Toast's own business-date column rather than being computed from a
  cutoff.
- **Repeated days**: daily exports can repeat or revise checks; the Toast GUIDs are the source ids,
  so re-import updates in place.
- **No customers or inventory** are expected from the sales export set; customer rows come only if
  the restaurant uploads a guest export.
- **Later**: SFTP pickup (the restaurant points Toast's export at an inbox we host) would make Toast
  near-automatic without API access. Worth its own spec once the CSV path works.
- **When API access arrives**: a Toast connector maps the same records into the same canonical rows,
  so the CSV mapping doubles as the connector's mapping reference.

Sync mechanics for every connector: backfill in pages from a Durable Object alarm loop, with a
checkpoint per resource; webhooks enqueue "refetch this record" (never trust webhook bodies as the
data); a periodic poll catches missed webhooks; rate limits are respected with backoff.

## D6. CSV import pipeline

1. **Read** the file from the tenant file area as a stream (spec 004 already streams bytes over RPC)
   and sniff encoding, delimiter and header row.
2. **Propose** a mapping: the agent gets headers + ~20 sample rows (PII masked) and returns a mapping
   in a structured form (target table.column ← source column + transform: date format, money parse,
   sign, split). Deterministic matching against saved templates runs first; the agent is only asked
   when no template matches.
3. **Preview** the canonical rows and per-row errors, plus totals (orders, net sales by day) to compare
   with the POS's own report.
4. **Import** in the background in batches; raw rows go to R2; canonical upserts by
   `(source, template, source_id)`; rows without an id get a fingerprint of their mapped key fields.
5. **Report and undo**: each import is a run; undo deletes rows whose lineage is only that run and
   restores rows it updated (kept as previous versions for the retention period).

Mapping is data, not code: a mapping is a declarative JSON document, so the agent proposes it and a
person confirms it, but nothing agent-written executes inside the import.

## D7. Personal data

Customers carry names, emails and phones, and agent reads go to the model provider. Recommendation:
mask PII columns in agent reads (hash for joins, `j***@example.com` for display) unless an
organization administrator allows it; dashboards show aggregates; raw records containing PII are kept
in R2 under the dataset's prefix and erased with the organization.

## Suggested stages

1. **Store and model**: dataset DO, canonical schema, lineage, rollups, metric API, guarded SQL, tests (idempotent upserts, refund and void math, business date, currencies).
2. **CSV import**: file stream, sniffing, mapping document, preview, background import, report and undo, built-in templates.
3. **Square connector**: OAuth, backfill, webhooks + poll, mapping. Proves the integration path end to end.
4. **Ownership seam (Q1)**: the organization-held account (kernel PR on its own), Data area UI, admin permissions.
5. **Stripe connector**, then cross-source matching (Story 6). Toast stays on CSV, with built-in Toast templates delivered in stage 2.

CSV comes before Square on purpose: it needs no partner approvals, exercises the whole map → store →
serve path, and lets spec 007's dashboard work start against real-looking data early.
