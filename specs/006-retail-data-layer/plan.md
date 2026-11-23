# Implementation Plan: Retail Data Layer

**Branch**: `006-retail-data-layer` | **Date**: 2026-11-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-retail-data-layer/spec.md`

## Summary

Each tenant (an organization, or a personal workspace) gets one canonical retail dataset.

**Where it lives.** A new gatekeeper, `packages/gatekeeper-retail`, owns the dataset. Its account is
a **tenant-held account**: the kernel calls the vendor's argument-free `createAccount()` once per
tenant, keeps the result in the tenant's `UserDirectoryDurableObject`, and installs it into every
member's workspaces as an ambient `RETAIL_DATA` capsule. It does this only after an organization
administrator has enabled it. The kernel change is one small PR that reuses existing pieces:

- the ambient capsule path (`ensureAmbientCapsules` / `prepareChatBindings`);
- the `#assertResourceEnabled` chokepoint;
- `provisioning-policy.ts`;
- the per-call role re-read of `TenantFilesApi`.

**Storage.** The dataset is one SQLite Durable Object (`RetailDataset`). It uses a compact storage
encoding behind public views, and each run keeps daily rollups current. Raw records go to R2
(`RETAIL_RAW`), so any mapping can be rebuilt without re-fetching. The schema also lets the store
split by location without consumers noticing; the first build task, a load test at 10 locations
× 3 years, decides whether that split is needed.

**Ingestion** comes from three places:

- **Square**: OAuth with read scopes, backfill, then webhook-triggered refetches plus a 15-minute
  poll.
- **Stripe**: a public Stripe App with OAuth and read permissions. Stripe Connect cannot grant
  platforms read-only access.
- **CSV files picked from the tenant file area**: built-in templates for Toast export sets, Square
  Item Detail and Shopify orders, plus templates members save.

**Mappings** are declarative JSON documents. The agent can propose one through the binding, and a
person confirms it after a preview.

**Serving.** The binding offers `describe`, guarded `run(sql)`, `metric`, `coverage`, `lineage` and
the mapping-proposal pair. Guarded SQL is safe because of four layers:

1. a real parser accepting one SELECT, with allow-listed views and functions;
2. a query-plan check;
3. execution inside a transaction that rolls back on any detected change;
4. row and byte caps.

**The Data area** is the account's management app at `/gatekeepers/retail`. It covers sources, sync
progress, imports, templates, coverage, lineage and settings. Its permissions are re-checked against
the member's live role on every call.

## Technical Context

**Language/Version**: TypeScript 7 (tsgo), Cloudflare Workers (compat date 2026-09-04), React 19 SPA (gatekeeper app) and Workshop frontend.

**Primary Dependencies**:

- Existing: capnweb / capnweb-validate, `@gadgets/gatekeeper-kit` (connect-handshake, connect-nonce, credential-stage, credentials, oauth-client, observers, response-body), `@gadgets/observability`, zod (catalog), Kumo, Phosphor, vite-plugin-singlefile (as in gatekeeper-context).
- New: `csv-parse` (MIT; streaming in workerd verified), `@guanmingchiu/sqlparser-ts` (Apache-2.0, sqlparser-rs WASM; workerd check in task 1, fallback `node-sql-parser`), `fflate` (zip and gzip; transitive today, now direct). All new dependencies are subject to `minimumReleaseAge`.

**Storage**:

- SQLite Durable Objects in the new worker: `RetailDataset` (one per dataset), `RetailConnection` (one per provider connection), `RetailWebhookRoute` (one per provider account) and `RetailGatekeeper` (facet). They ship as one migration tag, `v1`, `new_sqlite_classes`.
- R2: `RETAIL_RAW`, the first gatekeeper with an R2 binding (research R10, fallback decided).
- Kernel: a typed-storage KV collection `tenantAccounts` in the existing `UserDirectoryDurableObject`. No new kernel DO class, so no kernel migration.

**Testing**:

- `gatekeeper-retail`: a workerd vitest project with `capnwebValidate()` for the DOs, guard, ingest, metrics and observers, and a node project for parsers, mapping, the mapping editor and the app.
- `workshop-backend`: `__integration__/tenant-gatekeepers.test.ts`, which tests two or three tenants over real RPC using the `clerkFixture` pattern from `tenant-files.test.ts`.
- `workshop-frontend`: vitest + jsdom for the host bridge and the handoff page.
- The release golden manifest is regenerated.

**Target Platform**: Cloudflare Workers + browser.

**Project Type**: Web application. Kernel (`workshop-backend`, `workshop-shared`) + a new gatekeeper worker (`gatekeeper-retail`) + UI (`workshop-frontend`).

**Performance Goals**:

- SC-001: 30 days of orders in 10 minutes. The backfill fetches the newest data first, at 1,000 orders per `SearchOrders` page.
- SC-005: new orders within 15 minutes for 95% of them. Webhook refetch, plus a poll of 15 minutes or less.
- SC-006: metrics in under 2 s for one location over one year, and under 5 s for 10 locations over 3 years. Metrics read the rollups.
- SC-003: a templated import in under 1 minute.

**Constraints**:

- The SQLite object is capped at 10 GB. The store also has to live with 100 bound parameters, a 100 KB statement and 100 columns, and with no read-only mode and no way to interrupt a query (all verified).
- CPU is 30 s per invocation by default; the worker sets `limits.cpu_ms = 300000`. Alarms get 15 minutes of wall time. Memory is 128 MB, so files stream.
- Provider credentials never leave `RetailConnection` (FR-021).
- Kernel diffs stay small (constitution I).

**Scale/Scope**:

- Up to 10 locations × 3 years per tenant: ≈ 3M orders, 15M line items, 4.5M transactions, estimated at 5.5 GB (55% of the cap).
- CSV files up to the tenant file limit (100 MB, about 500k rows).
- Raw quota of 20 GiB per dataset by default, set by the operator.

All Technical Context unknowns are resolved in `research.md`, and none is left as NEEDS
CLARIFICATION. Three items are confirmed in build task 1, each with its fallback already decided:

- sqlparser WASM inside workerd (R4);
- pipelined stream relay (R8);
- R2 provisioning for gatekeepers by the deploy service (R10).

## Constitution Check

*Pre-research gate: passed with one justified item (Complexity Tracking). Re-checked after Phase 1 design: unchanged.*

| Principle | Status | Notes |
|---|---|---|
| I. Kernel bar | Pass (1 justified) | The kernel change is limited to `contracts/kernel-seam.md`, in its own PR. It reuses `createAccount()`, the ambient-capsule path, `#assertResourceEnabled`, `provisioning-policy.ts`, the directory DO and erasure, and the per-call role re-read pattern of `getFilesApi`. The new mechanism is that an account can be held by a **tenant** rather than a user; Complexity Tracking explains why. Every new `workshop-shared` export gets a doc comment. There is no mirror interface and no `as unknown as`: `TenantAccess` is a real RPC interface, and `TenantFileDelivery` is plain data. The feature's bulk (connectors, mapping, SQL, UI) stays outside the kernel. |
| II. Capability security | Pass | `tenantScoped` only makes a vendor eligible. The account is ambient only because of a directory record written through the organization-admin capability, or because of the operator's `enabled` mode, so the gatekeeper cannot assert its own ambience (FR-002a). The class is minted through `#assertResourceEnabled`. No method takes a tenant id. Provider credentials stay in `RetailConnection`, and webhooks are signed triggers that only cause refetches. Reads are observations, and the one agent write (a mapping suggestion) goes through `submitAction`. Read-only is enforced by four layers inside the gatekeeper. PII is masked in views. Provider OAuth reuses the ticket + nonce handoff, so a phished flow cannot attach a victim's provider account to an attacker's dataset. The role is re-read on every call. Auth configuration is untouched, and nothing is added to `AdminConfig`. A **pre-existing** gap, found during research: the per-user singleton path (`user.ts:1642-1649`) does not call `#assertResourceEnabled`. The new tenant path does. Fixing the old path is a separate change and is reported, not folded into this one. |
| III. RPC discipline | Pass | `@validateRpc()` is on `TenantGatekeepersApiImpl`, `TenantAccessImpl`, the vendor, account, gatekeeper, verifier and `RetailAppApi`. Approval-queue stubs are `dup()`'d. The host disposes frames and `TenantFilesApi` stubs. File streams are promise-pipelined (`downloadFile` → `receiveTenantFiles`). No bare stub is held in `useState`. |
| IV. Observability | Pass | Loggers: `gatekeeper.retail` (`vendorId: "retail"`) and `workshop.tenant.gatekeepers`. Events are listed in `contracts/http-routes.md`. Logs contain no tokens, headers, bodies, SQL parameters or row values. Sync failures that need an administrator go to `reportIssue`. Usage events (imports, syncs, queries) go to `recordAnalytics`/metrics with counts only. |
| V. Frontend conventions | Pass | Load the `frontend-conventions` skill before any UI work. The Data app is in `gatekeeper-retail/app/`, organised by feature (sources, imports, templates, coverage). Host-bridge and handoff changes go in `workshop-frontend`. Everything uses Kumo with semantic tokens, and the mapping editor and preview are keyboard and screen-reader operable (FR-023). |
| VI. Tests | Pass | Refusal tests: mutating SQL, storage-table access, cross-dataset reads, cross-tenant observers, non-admin enable and admin actions, demoted admin, phished handoff, forged or unsigned webhooks, undo conflicts. Plus idempotency, money and metric math, business dates, the load test, and the manual quickstart run. |
| VII. Config integrity | Pass | `cloudflare.config.ts` uses the shared factory; `wrangler.jsonc` is generated; migrations are tagged `v1`. `manifest-lib.ts`: retail joins `SINGLETON` and gets `sharingDomain = $PUBLIC_BASE_URL`, and sits in `NO_DEFAULT_CRED_INPUTS` until the Square stage adds `deploy-inputs.json`. The golden file is regenerated and reviewed, and `run-dev-server.ts` and `preview/staging-config.ts` are updated alongside. The app build tasks declare `VITE_FRONTEND_ERROR_REPORTING` as gatekeeper-context does. |
| Workflow: `write-gatekeeper` | Gate | `contracts/retail-binding.md` is the proposed `types.d.ts`. **Implementation of the gatekeeper waits for operator API approval (skill Step 3).** The kernel PR and the load-test spike do not depend on it. |

## Project Structure

### Documentation (this feature)

```text
specs/006-retail-data-layer/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── kernel-seam.md          # tenant-held accounts (kernel PR)
│   ├── retail-binding.md       # RETAIL_DATA types.d.ts proposal (needs operator approval)
│   ├── metrics.md              # standard metric definitions
│   ├── mapping-document.md     # mapping JSON + built-in templates
│   ├── data-area-api.md        # management UI capability, permissions, host bridge
│   └── http-routes.md          # OAuth callbacks, webhooks, logging
└── tasks.md                    # /speckit.tasks (not created here)
```

### Source Code (repository root)

```text
packages/workshop-shared/src/
├── gatekeeper.ts                 # + VendorDescription.tenantScoped, TenantAppContext, TenantAccess,
│                                 #   AppUiContext.tenant, TenantFileDelivery
└── api.ts                        # + TenantAmbientCreationSpec, TenantGatekeeperInfo,
                                  #   TenantGatekeepersApi, AuthenticatedApi.getTenantGatekeepersApi

packages/workshop-backend/
├── src/
│   ├── tenant-gatekeepers.ts     # NEW  TenantGatekeepersApiImpl, TenantAccessImpl
│   ├── user-directory.ts         # + tenantAccounts collection, enable/disable/list/class/appUi/verifier,
│   │                             #   eraseTenant revokes
│   ├── storage-schema/           # + directory KV schema for tenantAccounts
│   ├── server.ts                 # + getTenantGatekeepersApi(); tenant apps in list/getGatekeeperApp
│   ├── user.ts                   # + getTenantSingletonGatekeeperClass (via #assertResourceEnabled);
│   │                             #   skip tenantScoped in per-user provisioning
│   ├── overseer.ts               # + tenantAmbient in ensureAmbientCapsules, prepareChatBindings,
│   │                             #   observer flow, blueprint export
│   └── auth/clerk-webhook.ts     # + user.deleted erases personal directory
└── __integration__/tenant-gatekeepers.test.ts   # NEW

packages/gatekeeper-retail/       # NEW worker
├── cloudflare.config.ts          # RETAIL_RAW r2; limits.cpu_ms 300000; migrations v1
├── deploy-inputs.json            # Square stage: SQUARE_*; Stripe stage: STRIPE_*
├── vite.config.ts  vite.app.config.ts  build-app.ts  tsconfig*.json
├── vitest.config.ts              # workerd
├── vitest.node.config.ts         # node
├── app/                          # Data area SPA (Kumo)
│   ├── main.tsx  bridge.ts
│   ├── sources/  imports/  templates/  coverage/  settings/
├── src/
│   ├── index.ts                  # entrypoint exports + fetch router (oauth, webhooks)
│   ├── vendor.ts                 # GatekeeperVendor (autoProvisionsAccount, tenantScoped), RetailAccount,
│   │                             #   RetailVerifier
│   ├── gatekeeper.ts             # RetailGatekeeper facet: startSession, getAgentCatalog, actions, observers
│   ├── session.ts                # RetailData session impl (observations, caps)
│   ├── app-api.ts                # RetailAppApi (permissions per call)
│   ├── dataset/
│   │   ├── dataset-do.ts         # RetailDataset DO
│   │   ├── schema.ts             # storage tables, views, indexes, migrations-in-DO
│   │   ├── ingest.ts             # upsert by source key, pre-images, dirty days
│   │   ├── rollups.ts            # day recompute
│   │   ├── metrics.ts            # metric SQL (contracts/metrics.md)
│   │   ├── sql-guard.ts          # parse + allow-list + plan check + tx guard + caps
│   │   ├── masking.ts            # hashes, masks, customers view
│   │   └── raw-store.ts          # R2 RawStore (fallback: SQLite archive DO)
│   ├── import/
│   │   ├── sniff.ts  decode.ts  csv-stream.ts   # encoding, delimiter, header, footer; csv-parse
│   │   ├── mapping.ts            # zod schema, validation, interpreter
│   │   ├── propose.ts            # template match + header aliases
│   │   ├── import-loop.ts        # alarm-driven R2 range loop
│   │   └── templates/            # toast.ts, square-item-detail.ts, shopify-orders.ts
│   ├── connectors/
│   │   ├── connection-do.ts      # RetailConnection DO: credentials, planner alarm, checkpoints
│   │   ├── planner.ts            # scheduler-style single-alarm planner (copied pattern)
│   │   ├── webhook-route-do.ts   # RetailWebhookRoute DO
│   │   ├── square.ts  square-map.ts
│   │   └── stripe.ts  stripe-map.ts
│   ├── observability.ts
│   ├── types.d.ts                # contracts/retail-binding.md
│   ├── types.txt -> types.d.ts
│   └── generated/app.txt
└── __tests__/                    # guard, ingest, metrics, business date, templates, isolation, load/

packages/workshop-frontend/src/
├── SandboxedGatekeeperApp.tsx    # + pickTenantFiles, openConnectPopup host methods
├── ConnectHandoffPage.tsx        # + kind "app" redemption
├── files/TenantFilePicker.tsx    # NEW dialog reusing the files feature's list/upload
└── (Connectors page)             # + "Enable for organization" for tenant-scoped vendors

scripts/release/manifest-lib.ts   # SINGLETON, sharingDomain, NO_DEFAULT_CRED_INPUTS
scripts/release/testdata/golden-manifest.json
scripts/run-dev-server.ts  scripts/preview/staging-config.ts
docs/retail-data.md               # NEW operator + design doc
AGENTS.md                         # + packages/gatekeeper-retail entry
```

**Structure Decision**: Three reviewable units, matching AGENTS.md's split-by-concern rule:

1. **Kernel PR**: `workshop-shared` + `workshop-backend`, the tenant-held account.
2. **Gatekeeper** (`gatekeeper-retail`), in stage PRs.
3. **Workshop UI**: host bridge, handoff, file picker, enable control.

The gatekeeper depends on the kernel PR only for tenant ownership. Its store and import engine can be
built and tested against a test harness first.

## Delivery stages

| # | Stage | Delivers | Gate |
|---|---|---|---|
| 0 | Spikes | SC-006a load test on the storage design; sqlparser WASM in workerd; pipelined stream relay; R2 provisioning for gatekeepers confirmed with the deploy-service owners | Split by location if headroom is under 25%; apply the decided fallbacks if a spike fails |
| 1 | Kernel PR | `contracts/kernel-seam.md` and its invariant tests | Kernel review |
| 2 | Store + serving | `RetailDataset` schema, views, ingest, lineage, rollups, metrics, guarded SQL, masking, binding session, observers, erasure | **Operator approval of `retail-binding.md`** before this starts |
| 3 | CSV import + Data area | Host file delivery, sniff/parse, mapping, preview, background loop, report, undo, templates (Toast, Square Item Detail, Shopify), agent proposal, coverage UI | Toast built-in template checked against real sample exports |
| 4 | Square | OAuth + handoff, backfill, webhooks, poll, refresh, mapping, `deploy-inputs.json` | Sandbox end-to-end (quickstart 6–8) |
| 5 | Stripe | Stripe App OAuth, backfill, webhooks + events, mapping | Stripe Marketplace review |
| 6 | Matching (Story 6) | Proposals, confirm, undo | — |

CSV comes before Square because it needs no provider approval, exercises the whole map → store →
serve path, and lets spec 007 start against realistic data early.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| New kernel mechanism: tenant-held gatekeeper accounts (`tenantAccounts` in the directory DO, the `tenantAmbient` creation spec, `TenantGatekeepersApi`, `AppUiContext.tenant`) | Q1 makes the organization own the dataset, and FR-002 requires the organization role to be checked on each action | Per-user accounts (the existing mechanism) are revoked when the holder leaves (`user.ts:335-339`). Reusing the `ambient` spec misdescribes a shared account (per-member `accountId` and verifier). Reusing `isAdmin` would make every organization admin a Context Library operator. A kernel-hosted store would move the whole feature into the kernel. |
| Fourth DO-backed component in one gatekeeper (`RetailWebhookRoute`) | Provider webhooks are signed per app, not per connection, and one provider account can feed several datasets | A KV map is eventually consistent (up to 60 s), and webhooks would be dropped while it catches up. GitHub's per-DO webhook URL does not fit app-level subscriptions. |
