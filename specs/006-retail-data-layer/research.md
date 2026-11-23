# Research: Retail Data Layer

Phase 0 of `/speckit.plan`. It settles every open question in `spec.md` and the Technical Context of
`plan.md`. The spec's three clarifications (Q1 organization ownership, Q2 10 locations × 3 years,
Q3 Toast through CSV only) are taken as given. Each entry gives **Decision / Rationale / Alternatives**.

Sources: repo code (cited `path:line`), current provider docs (linked), and throwaway experiments
run against workerd 1.20261001.1 (the repo's version) and 1.20261117.1 under `/tmp`, not in the repo.
Anything not observed directly is marked `[INFERENCE]`.

---

## R1. Where the dataset lives (Q1): an organization-held gatekeeper account

**Decision**: A new `packages/gatekeeper-retail` holds connectors, mapping, storage, serving and the
Data area UI. The kernel gains one seam, a **tenant-held account**: the vendor's
`createAccount()` (unchanged and argument-free) is called once per tenant. The resulting
`Fetcher<GatekeeperUser>` is stored in the tenant's `UserDirectoryDurableObject`, not in a member's
user DO. From there it reaches every member's workspaces as an ambient capsule. The full contract is
in `contracts/kernel-seam.md`.

**Rationale** (what the code does today):

- Accounts are per user. `createAccount()` is called only in
  `UserDurableObject.#createAutoProvisionedAccount` (`workshop-backend/src/user.ts:1560-1573`), and
  the account is stored in that user's `connectedAccounts` (`storage-schema/user-storage.ts:15-26,153-155`).
- When a member leaves, `endMembership` revokes **every** account in that member's DO
  (`user.ts:335-339`, `auth/clerk-webhook.ts:79-86`). An account held by the administrator who
  connected it would therefore take the organization's dataset with them. Spec edge case "A member
  leaves" forbids that.
- The per-tenant directory DO already holds the tenant's branding and files
  (`user-directory.ts:31-62`). It is erased by `organization.deleted` → `eraseTenant`
  (`user-directory.ts:350-373`, `clerk-webhook.ts:94-100`). Typed-storage KV can persist stubs
  (`packages/typed-storage/src/index.ts:404-435`). SQL cannot, so the account goes in a KV
  collection beside the SQL tables.
- The ambient path already exists. `ensureAmbientCapsules` installs a class as a facet and keeps the
  account where it is (`overseer.ts:6994-7049`), and `prepareChatBindings` folds capsules into the
  chat seed under `suggestedBindingName` (`overseer.ts:7205-7281`). The seam adds a second source of
  ambient records, the directory, to that same path.

**What the seam must respect** (found during research):

- The overseer has no session or role. It knows the tenant (`tenantOfProfileId(owner)`,
  `overseer.ts:7892`), and agent turns can run with nobody present. So "a removed member loses access
  on their next read" (FR-002a) is enforced where it already is: the kernel refuses the removed
  member's sessions (`server.ts:224-248`, `user.ts:327-339`). Their workspaces stay with the tenant
  (`user.ts:333`), and so does their access to the tenant's dataset. That matches "data stays with
  the organization".
- `AppUiContext.isAdmin` means **deployment operator** (`server.ts:199-218`, `803-812`), and the
  Context Library gates public collections on it (`context-api.ts:116,127`). The organization role
  therefore travels in a new `AppUiContext.tenant` field, re-checked on every call through a
  kernel-minted `TenantAccess` capability. This follows `TenantFilesApiImpl.#actor()`
  (`tenant-files.ts:203-217`), which re-reads `orgRole` on every call. `isAdmin` keeps its current
  meaning.
- `#assertResourceEnabled` (`user.ts:2205-2217`) is the chokepoint constitution II names. The tenant
  singleton class is therefore requested **through the owner's user DO**
  (`getTenantSingletonGatekeeperClass`). That method calls `#assertResourceEnabled(vendorId)` before
  asking the directory. Note: the existing per-user singleton path (`getSingletonGatekeeperClass`,
  `user.ts:1642-1649`) does not call it today. That gap is pre-existing, outside this feature, and
  reported in the plan.
- Only a directory record written through the organization-admin capability makes the account
  ambient. The vendor flag `VendorDescription.tenantScoped` only makes a vendor *eligible*, and
  nothing the account's `describe()` returns makes it ambient. No tenant id is passed to
  `createAccount()`. The gatekeeper mints its own random `datasetId`, as Context does
  (`library-gatekeeper.ts:393-396`).
- The deployment-level mode reuses `provisioning-policy.ts` unchanged:
  - `disabled`: no tenant may enable it, and existing records go dormant.
  - `optional` (the default): an organization administrator enables it.
  - `enabled`: created for every tenant on first use, which is an operator's configuration and therefore allowed by AGENTS.md.

**Alternatives considered**:

- **A2: kernel-hosted store** (a `RetailDataApi` like Tenant Files). Rejected because it would put connectors, mapping and SQL serving in the kernel (constitution I), and gadgets would need a second way to reach data.
- **B: per-user accounts.** Rejected because data would leave with the connecting member (`endMembership`).
- **Reusing `{type:"ambient", accountId}`.** Rejected because its per-member `accountId` and per-member verifier lookup (`overseer.ts:9065-9087`) do not describe a shared account. A `tenantAmbient` creation spec keyed by `vendorId` does.

## R2. Deployments without Clerk

**Decision**: The data layer is offered only on Clerk deployments, the same rule as Tenant Files.

**Rationale**: Deployments without Clerk have only the unnamed legacy directory, which the branding
and files features already refuse (`user-directory.ts:105-106,151-155`). There is no tenant there to
own a dataset.

**Alternatives**: a per-user fallback, which would bring back the problem rejected in R1-B.

## R3. Storage engine and scale (Q2)

**Decision**: One SQLite Durable Object (`RetailDataset`) per dataset, using a compact encoding:

- integer surrogate keys
- epoch-second timestamps
- integer money in minor units
- quantities as integer ten-thousandths
- `business_date` as `YYYY-MM-DD` text

Public **views** turn these into the canonical names and friendly types (`data-model.md`). Raw
records go to R2, not SQLite. Every fact row carries `location_id`, so the store can later split by
location without consumers noticing. **The first build task is the SC-006a load test.** If it shows
less than 25% headroom at 10 locations × 3 years, the split goes in before any connector:

- a coordinator object holding dimensions, rollups and metrics;
- one object per location holding orders, line items, transactions and inventory.

**Rationale**:

- Platform limits, documented and measured:
  - 10 GB per object; `SQLITE_FULL` once it is full; reads and deletes still work.
  - 100 columns, 100 bound parameters, a 100 KB statement and an 8 MB row.
  - expression depth 100, and at most 5 terms in a compound SELECT.

  Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ and workerd
  `src/workerd/util/sqlite.c++:1484-1498`. Measured: 101 parameters → `too many SQL variables`,
  101 KB → `SQLITE_TOOBIG`.
- Estimate with the compact encoding, per busy location-year (100k orders, 500k line items, 150k
  transactions):
  - rows: about 170 B per order, 160 B per line item and 120 B per transaction, ~115 MB in all;
  - with the unique source key, the date/location index and the line→order index: ~185 MB;
  - 30 location-years: ~5.5 GB, 55% of the cap, which leaves ~45% headroom against the 25% that SC-006a requires.

  The earlier 280 MB per location-year assumed text ids and timestamps. That figure would have put
  the dataset at 84% of the cap, which is why the encoding is now a requirement rather than a
  preference. `[INFERENCE]` These are estimates, and the load test is the check.
- Each dataset reports `sql.databaseSize`, which works and was measured. An administrator is warned
  at 70% of the cap.

**Load test (build task 1, gate G2): passed; no split by location.** The harness
(`packages/gatekeeper-retail/__tests__/load/load.test.ts`, `RETAIL_LOAD_SCALE=0.1 pnpm --filter
@gadgets/gatekeeper-retail test:load`) ingests 10 locations × 3 years through the real batch path,
rollups included, in local workerd 1.20261001.1. At scale 0.1 (295,920 orders, 2.2M canonical
rows) the database was 420 MB, which extrapolates linearly to ~4.2 GB at full scale: 42% of the cap,
58% headroom against the 25% SC-006a requires (scale 0.01 projected 4.7 GB, because the
fixed-size rollups weigh more). Ingest ran at ~21k rows/s. `net_sales` over one location-year took
63 ms and over 10 locations × 3 years 18 ms; `units_sold` by category and `gross_margin` over 3
years ~450 ms; `repeat_customer_rate` over a year 25 ms; a guarded `run()` with a month's
`business_date` range 9–180 ms. `[INFERENCE]` Production SQLite I/O is slower than a local disk, so
the full-scale run (`RETAIL_LOAD_SCALE=1`, which also asserts the gates) remains the check before
connectors ship.

**Alternatives**:

- **D1 per dataset**: databases are created at runtime with an account token, and the release pipeline does not provision them.
- **R2 Data Catalog / Iceberg**: upserts and corrections are hard, and latency is immature. It is the growth tier for closed years, outside the first release.
- **External Postgres**: the customer would have to manage infrastructure.
- **Sharding from day one**: arbitrary SQL that crosses shards cannot run as one statement. Splitting is held back until the measurement demands it.

## R4. Read-only serving without a read-only role

**Decision**: `run(sql, params)` is enforced in the dataset DO by four layers:

1. **Parse** with `@guanmingchiu/sqlparser-ts` (sqlparser-rs compiled to WASM, Apache-2.0).
   - Require exactly one statement whose top level is a query with no data-modifying body. `WITH x AS (…) DELETE` parses as a Query whose body is Delete, so it is refused.
   - Refuse `WITH RECURSIVE`, which can exhaust the CPU budget.
   - Allow-list the relations: the public views and the query's own CTE names. Table-valued functions such as `pragma_table_info` show up as relation names and are refused.
   - Allow-list the functions.
2. **Plan check**: `EXPLAIN QUERY PLAN` refuses a full scan of a large fact table. A scan of a view
   over `line_items` / `orders` / `transactions` with no usable index, when the table holds more than
   `RETAIL_SCAN_ROW_LIMIT` rows, is refused with a suggestion to use `metric()` or narrow
   `business_date`. This covers US3.4, because the platform has no way to interrupt a query.
3. **Execute** inside `ctx.storage.transactionSync`, recording `total_changes()` and a `sqlite_schema`
   fingerprint before and after. Any difference throws, which rolls the statement back.
4. **Cap** while iterating: stop at `maxRows + 1` and at a byte budget, consume the cursor
   synchronously, and never call `toArray()` on caller SQL.

Masking is not a query rewrite. The `customers` view is created masked or unmasked from the
dataset's PII setting and is recreated when an administrator changes it (R12).

**Rationale** (experiments, exact output):

- `PRAGMA query_only = 1` gives `not authorized: SQLITE_AUTH`, and an `INSERT` afterwards still
  succeeds. There is no read-only mode and no JS authorizer hook.
- `exec("SELECT 1; DELETE FROM u")` runs both statements. The multi-statement rule is why parsing
  comes first.
- The transactional guard caught and rolled back `SELECT;DELETE`, `DROP TABLE`, `CREATE TABLE` and
  `UPDATE … RETURNING` (`write detected`, row count and table unchanged afterwards).

Parser comparison:

- `node-sql-parser` 5.4 fails on `FILTER (WHERE …)`, `WINDOW w AS`, `IS NOT DISTINCT FROM` and
  `VALUES`, and `tableList()` returns `[]` for `FROM json_each(…)` / `pragma_table_info(…)`. A table
  allow-list built on it would silently pass table-valued functions.
- `sql-parser-cst` is GPL-2.0-or-later.
- sqlparser-rs parsed every test case. It is 1.03 MB gzipped, and Workers allow 64 MiB uncompressed
  with no compressed-size limit (https://developers.cloudflare.com/workers/platform/limits/).

**Check (build task 1): passed in workerd.** sqlparser-rs WASM loads inside workerd 1.20261001.1
and parses every R4 case, including `FILTER`, `WINDOW`, `IS NOT DISTINCT FROM` and `VALUES`
(`packages/gatekeeper-retail/__tests__/spike-sqlparser.test.ts`). The package's own `init()` cannot
run there (it fetches or reads the `.wasm` from disk), so the worker imports the precompiled module
(`CompiledWasm`, Wrangler's default `**/*.wasm` rule) and calls the wasm-bindgen glue's `initSync`
directly. Those subpaths are not in the package's `exports`, so a pnpm patch
(`patches/@guanmingchiu__sqlparser-ts@0.63.0.patch`) exports them. The vitest pool needs the same
`CompiledWasm` rule in its `modulesRules`. The `node-sql-parser` fallback is not needed.

**Alternatives**:

- Metric API only: too narrow for agent exploration and custom tiles.
- Regex deny-list, as in `gatekeeper-supabase` (`supabase.ts:229-258`): Supabase calls its own "best-effort… not the primary control", and here nothing sits behind it.

## R5. The binding surface (feeds spec 007)

**Decision**:

- The agent and gadget binding (`RETAIL_DATA`) has these methods: `describe()`, `run(sql, params, { maxRows, maxBytes })`, `metric(name, query)`, `coverage(…)`, `lineage(table, id)`, `pendingImports()` and `proposeImportMapping(importId, mapping)`.
- `run()` returns `{ columns: [{ name, type, currencyColumn? }], rows, truncated }`.
- Spec 007's draft `timeoutMs` is not accepted. The time bound is the plan check plus the platform CPU limit. 007's adapter must not promise a timeout the source cannot keep.

The full contract is in `contracts/retail-binding.md`.

**Rationale**: This matches 007's source contract (`specs/007-data-output-formats/research.md:48-55`)
plus `metric()`. That is the one method 007 FR-009 requires.

**Alternatives**:

- One capability per table: more stubs, and no resource granularity anyone asked for.
- Per-location bindings: nothing in the spec calls for them. They can be added later as a narrower resource URL.

## R6. Observer strategy and observations

**Decision**:

- **Observer strategy B**, using the kit's `aclObservers`. The dataset is one ACL unit. The
  collaborator's verifier comes from their **own tenant's** account, and `addObserver` checks
  `hasDatasetAccess(datasetId)`.
- Every `run`/`metric`/`coverage`/`lineage`/`pendingImports` call is authorized with
  `authorizeObservation()` after the read and before the return. The description holds the views
  touched and the row count, never row data.
- `getAgentCatalog()` lists views and metric names only. Per the skill, it is not an observation
  (`library-gatekeeper.ts:321-331`).

**Rationale**:

- Everyone who can open a workspace is in its tenant (`overseer.ts:9569-9574`), so one membership
  check covers every row.
- Strategy C would need sub-resources with distinct ACLs, and there are none.

**Alternatives**: A (private only), which would block sharing dashboards inside the organization.

## R7. The one agent write: proposing a mapping

**Decision**:

- `proposeImportMapping(importId, mapping)` submits an action through the approval queue and is
  listed in `getAutoApprovableActions()`. When applied, it stores a **draft** mapping on a staged
  import. Nothing is written to canonical tables until a member confirms the draft in the Data area
  after a preview (FR-009).
- The Data area's "Ask the agent" button uses the existing host method `openPrompt(prompt)`
  (`workshop-frontend/src/SandboxedGatekeeperApp.tsx:294-296`, used by the scheduler app at
  `gatekeeper-scheduler/app/SchedulerPage.tsx:208`). It opens a new chat that names the staged
  import.
- `getAgentCatalog()` lists staged imports awaiting a mapping.
- A deterministic proposer (saved templates by header signature, then a header-alias dictionary)
  runs first, so a known export never needs the agent (SC-003, one minute).

**Rationale**:

- The skill requires every caller-initiated state change to go through `submitAction()`. Even a
  harmless draft is better visible in the action log than invisible.
- The binding writes no dataset data, so FR-016's "read-only through that path" holds for the
  dataset.
- `openPrompt` already exists, so nothing new is needed to reach the agent from the Data area.

**Alternatives**:

- The gatekeeper calls a model itself: that is a new model-access seam for gatekeepers in the kernel.
- No agent, deterministic only: fails FR-009.

## R8. CSV files come from the tenant file area (FR-007)

**Decision**: The file is delivered by the host, at the user's request:

1. The Data area asks the Workshop host page for files through a new host-bridge method,
   `pickTenantFiles({ accept, multiple })`. The bridge is the existing MessagePort RPC,
   `GatekeeperAppHostImpl` (`SandboxedGatekeeperApp.tsx:321-330`).
2. The Workshop shows its own picker over `TenantFilesApi`: pick existing files, or upload new ones
   into Files first, so they count against the Files quota (spec Assumptions).
3. The host then calls the app capability's `receiveTenantFiles(files)` with each file's metadata
   and a `ReadableStream`. Each stream is the promise-pipelined result of
   `filesApi.downloadFile(id)`.
4. The gatekeeper copies each stream into its own R2 raw store before replying. The original file is
   the raw record (FR-006), and the import then runs in the background from R2, with no browser
   needed.

**Rationale**:

- No gatekeeper ever holds a `TenantFilesApi`, which would be authority over every file in the tenant.
- The user's pick is the authority. The tenant is the session's own, because both capabilities come
  from the same `AuthenticatedApi`.
- The kernel backend is unchanged. Only frontend code and one doc-commented shared type
  (`TenantFileDelivery`) are added.

**Open check (build task 1, fallback decided)**: `[INFERENCE]` A promise from `downloadFile` passed
as an argument on the same Cap'n Web session should resolve on the backend, so the bytes go
R2 → backend → gatekeeper without passing through the browser. If the spike shows the stream relayed
through the browser, it still works: a 100 MB file crosses the WebSocket twice and is slower. The
picker then shows progress, and the plan accepts that cost for the first release.

**Alternatives**:

- Upload straight into the Data area: fails FR-007 and the quota assumption.
- Hand the gatekeeper a `TenantFilesApi`: too broad.
- A kernel single-file capability: more kernel for the same result.

## R9. CSV parsing and background import

**Decision**:

- **Decoding**: `TextDecoderStream`. Try `utf-8` with `fatal: true` on the first megabyte. On
  failure, fall back to `windows-1252`. A BOM selects UTF-16LE/BE. The member can override the
  encoding.
- **Parsing**: `csv-parse/browser/esm` 7.x (MIT), fed chunk by chunk with `bom: true`.
- **Sniffing**: delimiter (`,` `;` `\t` `|` tested on the first 64 KB), header row (first row whose
  cells are mostly non-numeric and distinct within the first 20) and footer totals (trailing rows
  whose id column is blank and which contain "total"). All are hand-written and all can be
  overridden.
- **Background loop**: imports run as an alarm loop **in the dataset DO**. Each alarm reads one
  4–8 MB R2 range, starting at the byte offset just after the last complete record. That offset
  comes from csv-parse's `info.bytes`, so a quoted newline never straddles a resume. The alarm
  parses, maps and upserts the batch inside `transactionSync`, then persists the cursor (`raw_object`,
  byte offset, counts) and re-arms.
- **Cancellation** sets a flag that the next alarm honours.
- **CPU**: `limits.cpu_ms = 300000` for the worker.

**Rationale** (workerd 1.20261117 experiments):

- papaparse cannot stream there (`FileReaderSync is not defined`).
- `d3-dsv` `csvParse` throws `Code generation from strings disallowed`.
- `csv-parse` produced correct rows, including quoted CRLF.
- TextDecoder supports `windows-1252`, `iso-8859-15`, `utf-16le/be`, `shift_jis`, `gbk`, `big5`, and
  fatal UTF-8 throws on byte `0xE9`.
- Memory is 128 MB, so a 100 MB file must stream.
- Alarms get 15 minutes of wall time and up to 6 automatic retries. The loop catches its own errors
  and re-arms (https://developers.cloudflare.com/durable-objects/api/alarms/).
- Writes have to go through the single-writer dataset DO anyway.

**Alternatives**:

- Queues: messages cap at 128 KB, so a queue only carries offsets, adding a hop. Also, `queues` is
  not in `manifest-lib.ts` `HANDLED_CONFIG_KEYS` (`:245-257`), so the release would fail closed.
- Workflows: step results cap at 1 MiB, and the repo has no precedent for them.

## R10. Raw record store

**Decision**: A new R2 bucket binding, `RETAIL_RAW`, on the retail gatekeeper. Keys:

- `ds/<datasetId>/src/<sourceId>/run/<runId>/<seq>`
- CSV: the original file bytes.
- Providers: one gzipped NDJSON object per fetched page.

The dataset DO indexes every object (`raw_objects`) and counts its bytes against a raw-storage quota
(`RETAIL_RAW_QUOTA_BYTES`, default 20 GiB per dataset, set by the operator).

**Rationale**:

- The 10 GB SQLite budget is kept for canonical rows (R3).
- Release support exists:
  - `manifest-lib.ts` renders any package's `r2_buckets` as `$R2_<BINDING>_NAME` (`:11,427-432`).
  - Terraform provisions R2 generically per `pkg:binding` (`infra/terraform/modules/instance/locals.tf:61-70`, `storage.tf:19`).

  The bucket name is `<instance>-<binding>`, so the binding name must be unique across packages.
  `RETAIL_RAW` is.

**Open check (fallback decided)**: this is the first gatekeeper with an R2 binding, and
`[INFERENCE]` the external deploy service may not yet provision R2 for gatekeepers. The release task
confirms it with the deploy-service owners. If it cannot ship in time, raw records go into a
per-source `RetailRawArchive` SQLite DO (10 GB each) behind the same `RawStore` interface.

## R11. Time, business date, money

**Decision**:

- **Business dates and local hours** are computed in JS at ingest and stored as columns. The
  conversion uses `Intl.DateTimeFormat` with the location's IANA zone and its `day_cutoff`.
- **Toast**: its exports have **no business-date column** (correcting the earlier draft). The
  business date is taken from the export set's date (the date folder of a scheduled export, or a
  date the member confirms once per import), and each order's `Opened` time plus the cutoff is the
  check.
- **Money**:
  - Stored as integer minor units with an ISO 4217 code, normalized to upper case (Stripe sends lower case).
  - CSV decimals are converted with an exponent table, with zero-decimal currencies such as JPY at exponent 0.
  - Currency symbols and thousands separators are stripped according to the template's locale.
  - BigInt never reaches SQL.
- **Quantities**: integer ten-thousandths, which is Toast's precision.

**Rationale**:

- SQLite's `localtime` returns UTC inside workerd, measured.
- Full ICU is present: 418 zones, DST-correct.
- `Temporal` is unavailable at the repo's compat date, and the repo's workerd rejects the flag.
  `temporal-polyfill` 1.0.2 is already used by the scheduler, but `Intl` is enough here.
- BigInt parameters throw, and integers above 2^53 lose precision, measured.
- Toast fields: https://doc.toasttab.com/doc/platformguide/adminDataExportFieldReference.html.

## R12. Personal data (FR-019)

**Decision**:

- At ingest, `customers` stores the raw PII plus `email_hash` and `phone_hash`: an HMAC-SHA-256 with a
  per-dataset key generated at creation, so the hashes can be used for joins and matching.
- It also stores display masks such as `j***@example.com`, `***-***-1234` and `J. S.`.
- The public `customers` view exposes the masked columns, under the canonical names, unless the
  dataset's `pii_unmasked` setting is on. Only an organization administrator can change that
  setting, and every change is recorded with the actor and the time.
- The same view serves the agent and gadgets. The gatekeeper cannot tell them apart, and dashboards
  need aggregates rather than identities (FR-019 allows aggregates).
- Staged-import samples shown to the agent mask cells that look like emails or phone numbers, and
  columns that map or are guessed to map to PII.
- `run_rejections` never stores values from PII columns.

**Rationale**: Masking in the stored view needs no SQL rewrite, and so cannot be bypassed by query
text. The guard (R4) already refuses the storage tables.

## R13. Square connector

**Decision**:

- **OAuth**: code flow with a server-held secret, which avoids PKCE's single-use refresh tokens. The
  connector requests `MERCHANT_PROFILE_READ ORDERS_READ ITEMS_READ CUSTOMERS_READ PAYMENTS_READ
  INVENTORY_READ` and records the list, because Square cannot report a token's scopes later.
- **Token refresh**: every 7 days or sooner, on the connection's alarm. A token older than 8 days
  raises the connection's status to "needs attention".
- **Backfill**: the newest 30 days first (SC-001), then older windows down to the configured years.
  `SearchOrders` with at most 10 `location_ids` per call, `limit` 1000, with the date filter and sort
  on the same field.
- **Incremental sync**: a `SearchOrders` cursor on `updated_at`, with a 10-minute overlap, at least
  every 15 minutes. A daily pass re-reads the last 3 days.
- **Other incremental reads**:
  - `ListPayments` with `updated_at_begin_time`
  - `ListPaymentRefunds`
  - `SearchCatalogObjects` with `begin_time` and `include_deleted_objects`
  - `SearchCustomers` filtered on `updated_at`
  - `BatchRetrieveInventoryChanges` with `updated_after`
- **Webhooks**: an app-level subscription posts to `/gatekeeper/retail/webhooks/square`.
  - The signature (`x-square-hmacsha256-signature`, an HMAC over the notification URL plus the raw
    body) is checked in constant time before parsing.
  - `merchant_id` routes the event through a `RetailWebhookRoute` DO.
  - Each event only queues "refetch object X". Webhook bodies are never treated as data.
- **429**: exponential backoff with jitter, using a scheduler-style planner (R15).

**Rationale**:

- https://developer.squareup.com/docs/oauth-api/best-practices (30-day expiry, refresh at 7 days, alert at 8)
- https://developer.squareup.com/reference/square/orders-api/search-orders (10 locations, limit 1000, cursor repeats the query)
- https://developer.squareup.com/docs/webhooks/step3validate
- https://developer.squareup.com/docs/webhooks/v2webhook-events-tech-ref (thin `order.*` payloads; `catalog.version.updated` carries only a timestamp)

**Reconciliation aid** (SC-002, optional): the Square Reporting API `Sales` view, scope
`REPORTING_READ`. It is used only in test tooling, because its GA status is unconfirmed.

## R14. Stripe connector

**Decision**: Connect through a **public Stripe App with the OAuth install flow** and `*_read`
permissions only:

- `charge_read`, `payment_intent_read`, `refund_read`, `customer_read`, `invoice_read`,
  `checkout_session_read`, `product_read`, `price_read`, `payout_read`, `balance_transaction_read`,
  `event_read`.
- Access tokens last 1 hour. Refresh tokens last 1 year and rotate on every refresh, under the kit's
  `CredentialCoordinator` mutex.
- Backfill by `created` windows with `limit=100` and `starting_after`, below 25 requests/s per endpoint.
- Steady state: webhooks (`Stripe-Signature`, verified with the app secret, de-duplicated by event id)
  plus `/v1/events` polling as the backstop. A reconnect after more than 30 days runs a full backfill.

Stripe ships after Square. The Marketplace review lead time is a schedule risk, not a design risk.

**Rationale**:

- Connect OAuth `read_only` is **not available to platforms**: "Platforms must set `scope` to
  read_write… read_only, is available only to applications registered as extensions"
  (https://docs.stripe.com/connect/oauth-standard-accounts). Requesting `read_write` would break
  FR-003.
- The Stripe App OAuth flow: https://docs.stripe.com/stripe-apps/api-authentication/oauth.

**Alternatives**: a pasted restricted API key. The connector cannot verify that the key is
read-only, there is no consent screen (US1.1), and rotation is manual. Rejected even for the pilot.

## R15. Sync scheduling

**Decision**:

- Each provider connection is its own `RetailConnection` DO, holding credentials (kit
  `CredentialCoordinator`), per-resource checkpoints, status and backoff.
- It uses one alarm with a scheduler-style planner, copied from `gatekeeper-scheduler`, which does
  not export it:
  - a watchdog alarm at now + 5 minutes before any work;
  - due work items in a small batch;
  - capped exponential backoff, `min(60s·2^(n-1), 1h)`;
  - an immediate alarm plus batched teardown on revoke.

  Sources: `schedule-driver.ts:32,273-292,549-581` and `driver-state.ts:8-10,209-213`.
- Fetched pages go to R2, and then to the dataset DO as `ingestBatch(runId, records)` RPCs that are
  idempotent per batch.

**Rationale**:

- Credentials stay in the connection DO and never reach the dataset DO or the binding (FR-021).
- A slow provider never holds the dataset DO's single writer.

## R16. Undo, re-map, concurrency

**Decision**:

- **Undo (FR-011)**:
  - Each import run writes **pre-images** to `row_versions`: `before = null` for inserts, the prior
    row for updates.
  - Undo restores them in reverse order. It is refused, naming the later runs, if any of the import's
    rows was changed by a later run.
  - Pre-images are kept for `RETAIL_UNDO_RETENTION_DAYS`, 30 by default. After that, the run shows
    "can no longer be undone".
  - Syncs do not keep pre-images. They are not undoable units, since the provider is the truth.
- **Re-map (US5)**: a rebuild run re-reads the template's raw objects from R2, upserts by source key,
  and then deletes rows that the template produced before but the rebuild did not. A rebuild
  generation number on each row marks them. A new built-in mapping version starts the same rebuild,
  per source.
- **Concurrency**: all writes go through the dataset DO in `transactionSync` batches. Batches from
  concurrent runs interleave, the last batch to commit wins at the row level, and every row records
  its `run_id`. That matches the spec's edge case.

## R17. Rollups and metrics

**Decision**:

- Each batch marks `(location_id, business_date)` pairs dirty. After the batch, those days of
  `daily_sales`, `daily_product_sales` and `daily_source_coverage` are recomputed **in full** from
  the fact tables, and `customer_summary` is recomputed for the customers touched.
- Metrics are SQL over the rollups, with definitions published by `describe()` (`contracts/metrics.md`).
- Refunds are attributed to the refund's business date, as Square and Toast report them.
- Line-level returns live in a `refund_items` table, so `units_sold` and product-level net sales are
  exact.

**Rationale**:

- Recomputing a whole location-day (about 300 orders) is cheap and cannot drift, unlike incremental
  deltas.
- SC-002 needs the provider's own date attribution.
- `median`/`percentile`/`log10`/`generate_series` are unavailable in DO SQLite, measured, so metrics
  avoid them.

## R18. Gatekeeper package conventions

**Decision**: Copy `gatekeeper-context`'s shape:

- Vendor with `autoProvisionsAccount`.
- Account with `singleton` and `providesUi`.
- `startAppUi` returning `{ iframeHtml: APP_HTML, ui }`.
- A React app in `app/`, bundled single-file into `src/generated/app.txt` by `vite.app.config.ts`.
- Two vitest projects: workerd (with `capnwebValidate()`) and node.

Sources: `library-gatekeeper.ts:131-154,372-398`, `vite.config.ts:10-70`, `vite.app.config.ts:24-52`.

Use gatekeeper-kit for:

- `connect-handshake` and `connect-nonce`
- `credential-stage`
- `credentials`
- `oauth-client`
- `observers`
- `response-body` (`readBytesCapped`)

Webhook HMAC is implemented locally with `crypto.subtle`, after GitHub's (`github-hooks.ts:275-289`).
The kit has no such helper.

Release wiring (`scripts/release/manifest-lib.ts`):

- Join `SINGLETON`, because the account declares a singleton (`:283-300`).
- Receive `sharingDomain = $PUBLIC_BASE_URL` like Context (`:486-490`), with `run-dev-server.ts` and
  `preview/staging-config.ts` alongside.
- Sit in `NO_DEFAULT_CRED_INPUTS` until the Square stage adds `deploy-inputs.json`:
  `SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY`.
- The Stripe stage adds `STRIPE_CLIENT_ID`, `STRIPE_APP_SECRET`, `STRIPE_WEBHOOK_SECRET`.

`DeployInput` has no `optional` flag (`:150-165`), so a deployment that installs a release
containing a connector must supply that connector's credentials. Recorded as a known trade-off.
Optional inputs would change the deploy-service contract and are left to a follow-up if operators
want CSV-only installs.

New dependencies, all subject to the repo's `minimumReleaseAge: 1440`:

- `csv-parse` (MIT)
- `@guanmingchiu/sqlparser-ts` (Apache-2.0)
- `fflate`, already transitive, for zipped Toast exports and gzipped raw pages.
- `zod`, from the catalog, for the mapping document.

## R19. Provider connect handoff for a tenant-held connection

**Decision**: Provider OAuth inside the gatekeeper follows `docs/connect-handoff.md`, using the
existing pieces:

1. `beginConnect(provider)` on the Data-area capability. It requires `canManage`, and returns
   `{ url, nonce }`. The connection DO stores `nonceHash`.
2. The app asks the host to open the popup: new host method `openConnectPopup({ url, nonce })`, which
   reuses `openDisownedPopup` and writes `{ kind: "app", appId, nonce }` to the popup's
   sessionStorage.
3. The callback, `/gatekeeper/retail/oauth/<provider>`, exchanges the code, **stages** the credentials
   and ends on `connectHandoffPageHtml`, which sends the popup to `/connect/handoff#<ticket>`.
4. `ConnectHandoffPage`, for `kind: "app"`, obtains `getGatekeeperApp(appId)` over the popup's own
   session and calls `ui.redeemConnectHandoff(ticket, nonce)`. The dataset checks four things:
   - the ticket belongs to this dataset;
   - the nonce matches the same flow;
   - both are unexpired and single-use;
   - the caller can manage.

   Only then does it commit.

**Rationale**: A victim who finishes an attacker's flow holds a ticket their own session's dataset
refuses. This is the same guarantee the kernel flow gives (`docs/connect-handoff.md`, "The threat,
and the ticket"). If retail's OAuth state were tied only to the UI capability, an attacker could link
a victim's Square account to the attacker's dataset.

## R20. Erasure (FR-022)

**Decision**:

- **Organization**: `eraseTenant` revokes each tenant-held account before purging. It throws on
  failure, so the Clerk webhook retries, as it does for files. `RetailAccount.revoke()` then:
  1. marks the dataset `erasing` (reads refused);
  2. revokes provider tokens and deletes each `RetailConnection`;
  3. removes `RetailWebhookRoute` entries;
  4. deletes the R2 prefix `ds/<datasetId>/` in alarm batches;
  5. calls `ctx.storage.deleteAll()`.
- **Personal tenant**: `user.deleted` also erases directory `u_<id>`. Today it erases only the user
  DO (`clerk-webhook.ts:87-93`), and files survive. This fixes that for files and for the dataset.

## Resolved Technical Context unknowns

| Unknown | Resolved by |
|---|---|
| Ownership seam and its kernel diff | R1, R2, `contracts/kernel-seam.md` |
| Storage engine and scale headroom | R3 (load test is build task 1) |
| Read-only enforcement on DO SQLite | R4 |
| SQL parser | R4 (workerd check with a decided fallback) |
| CSV parser, encoding and resumable background import | R9 |
| CSV source = tenant file area | R8 |
| Raw record storage | R10 (fallback decided) |
| Timezone and business date | R11 |
| Stripe read-only access | R14 |
| Square scopes, sync and webhooks | R13 |
| Toast export shape | R11, `contracts/mapping-document.md` (built-in Toast template) |
| Agent mapping proposal | R7 |
| Observer strategy | R6 |
| Erasure | R20 |
