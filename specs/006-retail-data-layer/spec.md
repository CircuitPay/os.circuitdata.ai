# Feature Specification: Retail Data Layer

**Feature Branch**: `006-retail-data-layer`

**Created**: 2026-11-17

**Status**: Draft (clarified; ready for `/speckit.plan`)

**Input**: User description: "Work on the data layer first. This is set for retail data: users will connect integrations (Stripe / Square / Toast) or manually upload POS CSV data. That data is then mapped into customers / orders / line items / products / transactions / inventory tables. Those tables will be used for the dashboards, reporting and analysis."

**Builds on**: `specs/001-clerk-tenant-identity` (tenants), `specs/003-tenant-branding-blueprint-isolation` (no data crosses tenants), `specs/004-organization-file-management` (CSV files arrive through the tenant file area), gatekeepers and the observation model (`AGENTS.md`).

**Feeds**: `specs/007-data-output-formats` (Dashboards, Reports, data in Slides), which reads only the canonical tables defined here.

Companion documents: `data-model.md` (draft canonical schema) and `research.md` (options and recommendations).

## Summary

A retailer's sales data is scattered across the systems they run: a payments processor (Stripe), a
point-of-sale (Square, Toast), and exports from systems we do not integrate with. This feature gives
each organization **one canonical retail dataset**: the same tables, the same column meanings, the
same definitions of "net sales", whichever systems the data came from.

Three layers, in order:

1. **Ingest**: bring records in from a connected integration (initial backfill, then incremental
   sync) or from an uploaded CSV. Keep what arrived, unchanged, so it can be re-mapped later.
2. **Map**: turn source records into canonical rows: `locations`, `customers`, `products`,
   `orders`, `line_items`, `transactions`, `inventory`. Integrations use built-in mappings; CSVs use a
   column mapping the user confirms (the agent proposes it).
3. **Serve**: expose the canonical tables, plus a small set of standard metrics and daily rollups,
   to the agent and to gadgets (dashboards, reports) as a **read-only** data source.

## Clarifications

### Session 2026-11-17

- Q1: Who owns the retail dataset? → A: The **organization**. There is one dataset per tenant (an organization, or a personal workspace for a user without one). Every member reads the same data; administrators manage connections and deletion; data stays with the organization when a member leaves. This needs the organization-held account seam in the kernel (research D1, option A1).

- Q2: What scale must the first release hold per organization? → A: Up to **10 locations with 3 years of history** each. Larger chains are out of scope for the first release; the storage design must say how it would grow (research D3).

- Q3: How will we get Toast access? → A: **CSV only for now.** There is no Toast API integration in this release. Toast restaurants import Toast's own data exports through built-in Toast templates. A Toast connector can follow once partner or per-restaurant API access is in hand, reusing the same mapping to canonical tables.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a POS or payments integration (Priority: P1)

An organization administrator opens **Data** (a new area of the Workshop), chooses **Connect Square**
(or Stripe), completes the provider's sign-in, and picks which locations to include. The
product starts importing history, shows progress, and from then on keeps the data current without the
user doing anything.

**Why this priority**: Live integrations are the main way data arrives and the reason the dataset
stays current. Square is the strongest first target: self-serve OAuth, read-only scopes, and APIs for
orders, catalog, customers, payments and inventory.

**Independent Test**: Connect a Square sandbox account with known test orders. Confirm the canonical
tables contain those orders, their line items, products, payments and customers with the right
totals; create a new sandbox order and confirm it appears within the sync interval.

**Acceptance Scenarios**:

1. **Given** an administrator, **When** they connect an integration, **Then** only read access is requested from the provider, and the provider's consent screen says so.
2. **Given** a new connection, **When** the backfill runs, **Then** the Data area shows progress by table (records fetched, mapped, rejected) and an estimated completion, and the user can leave and come back.
3. **Given** a connection after backfill, **When** new or changed records appear at the provider (new order, refund, edited customer), **Then** they reach the canonical tables within the sync interval, updated in place rather than duplicated.
4. **Given** a provider outage, rate limit, or revoked access, **When** sync fails, **Then** the connection shows its status and last successful sync, retries automatically for transient failures, and asks an administrator to reconnect for permanent ones; data already imported stays available.
5. **Given** an administrator, **When** they disconnect an integration, **Then** sync stops and they choose to keep or delete the data it imported.

---

### User Story 2 - Upload a POS CSV export (Priority: P1)

A member uploads `sales_october.csv`, exported from their POS. The product reads the headers and a
sample, and the agent proposes how each column maps to the canonical tables ("`Txn Date` → order
date, `Item` → product name, `Qty` → quantity …"). The member reviews a preview of the resulting
orders and line items, fixes anything wrong, and imports. They save the mapping as a template so next
month's file imports in one step.

**Why this priority**: Many small retailers run a POS we will not integrate with, or want history from
before they connected. CSV is the universal fallback, and the only path for Toast in this release.

A Toast restaurant's export is several related files (orders/checks, item selections, modifiers,
payments) rather than one. The member uploads them together and the product recognises the set,
joins the files by Toast's order and check ids, and imports them as one unit.

**Independent Test**: Upload a CSV with one row per line item (order fields repeated on each row).
Confirm it produces the right number of orders and line items, that order totals match, and that
uploading the same file again changes nothing.

**Acceptance Scenarios**:

1. **Given** an uploaded CSV, **When** the member starts an import, **Then** they see the detected columns, a sample of rows, and a proposed mapping per column, with unmapped and required-but-missing fields called out.
2. **Given** a CSV with one row per line item, **When** it is mapped, **Then** rows sharing an order identifier become one order with several line items, and products and customers named in it are created or matched.
3. **Given** a mapping, **When** the member previews it, **Then** they see the canonical rows it would produce, row-level problems (bad dates, non-numeric amounts, unknown currency), and totals to compare with the POS's own report, before anything is written.
4. **Given** a mapping, **When** the member saves it as a template, **Then** a later file with the same headers is recognised and the template is offered.
5. **Given** the same file (or an overlapping export) imported twice, **When** rows carry the same source identifiers, **Then** they update the existing rows rather than duplicating them; files without identifiers fall back to a content fingerprint and the member is warned that edits to old rows cannot be matched.
6. **Given** settings the file does not state, **When** the member imports, **Then** they confirm the timezone, currency and date format once per template.
7. **Given** an import, **When** it finishes, **Then** an import report lists rows written, updated, skipped and rejected with reasons, and the import can be undone as a whole.
8. **Given** a set of Toast export files for the same date range, **When** the member uploads them together, **Then** the Toast template is offered for the set, line items, modifiers and payments are attached to the right orders, and a file missing from the set (for example payments) is named before import rather than producing orders without payments.
9. **Given** consecutive daily Toast exports, **When** they are imported one after another, **Then** orders that appear in two exports (edited or reopened checks) are updated, not duplicated.

---

### User Story 3 - Query the canonical data (Priority: P1)

The agent, a dashboard, or a report asks questions of the canonical tables ("net sales by location
by week", "top 20 products by margin last month", "repeat customer rate") and gets consistent answers,
whichever sources the data came from.

**Why this priority**: This is the contract spec 007 depends on. Without it, every dashboard
re-derives "net sales" its own way.

**Independent Test**: Load the same set of sales through Square and through a CSV into two test
organizations; confirm the standard metrics return identical results for both.

**Acceptance Scenarios**:

1. **Given** the canonical dataset, **When** a consumer runs a read query, **Then** it gets typed results (money as exact amounts with currency, timestamps with timezone, dates as business dates).
2. **Given** a query that would change data, **When** it is submitted through the read interface, **Then** it is refused.
3. **Given** a standard metric (for example net sales, gross sales, discounts, refunds, tax, tips, orders, average order value, units sold, gross margin), **When** any consumer asks for it, **Then** the same definition is used everywhere, and the definition is readable.
4. **Given** a query over the whole history, **When** it runs, **Then** it completes within the read time limit or is refused with a suggestion to use a rollup or narrow the range.
5. **Given** an agent reading customer rows, **When** results include personal data (name, email, phone), **Then** those fields are masked unless the organization has allowed the agent to see them (see Assumptions).

---

### User Story 4 - See where the data came from and whether it is complete (Priority: P2)

A manager sees that last Tuesday looks low and wants to know whether that is real. The Data area
shows each source's coverage (which dates and locations each source has data for), last sync,
rejected records, and gaps, so they can tell "slow day" from "missing data".

**Why this priority**: Trust in every number on every dashboard depends on it, but the dataset works
without it.

**Independent Test**: Import a CSV with one missing day and a few invalid rows; confirm the gap and the
rejections are shown, and each canonical row can be traced back to its source record.

**Acceptance Scenarios**:

1. **Given** the Data area, **When** a member opens it, **Then** they see each source, its status, last sync or import, record counts per table, and the date range it covers per location.
2. **Given** a canonical row, **When** a member (or the agent) asks where it came from, **Then** the source, source record id, import or sync run, and mapping version are available.
3. **Given** days with no orders for a location that normally trades, **When** coverage is shown, **Then** they are flagged as possible gaps.

---

### User Story 5 - Fix a mapping and re-run it (Priority: P2)

A member realises the CSV mapping put tips into the discount column. They correct the template and
re-apply it to the files already imported with it, and every dashboard reflects the fix.

**Why this priority**: Mapping mistakes are inevitable; keeping the original records makes them cheap
to fix instead of requiring re-uploads.

**Independent Test**: Import with a wrong mapping, correct it, re-apply, and confirm the canonical rows
change and no duplicates appear.

**Acceptance Scenarios**:

1. **Given** a corrected template, **When** the member re-applies it, **Then** the canonical rows produced by that template are rebuilt from the kept source records.
2. **Given** a new version of a built-in integration mapping, **When** it ships, **Then** affected data can be rebuilt without re-fetching from the provider.

---

### User Story 6 - The same customer or product across sources (Priority: P3)

A customer who pays online through Stripe and in store through Square appears once, and a product sold
through both channels is counted together.

**Why this priority**: Valuable for customer analysis (lifetime value, repeat rate), but most first
customers will run a single POS, and wrong merges are worse than none.

**Acceptance Scenarios**:

1. **Given** customers from two sources with the same verified email, **When** matching runs, **Then** they are linked to one canonical customer, and the link can be undone.
2. **Given** products with the same SKU in two sources, **When** matching runs, **Then** they are linked; products matched only by name are proposed, never linked automatically.

---

### Edge Cases

- **Refunds, voids, exchanges and partial refunds**: a refund is a transaction against the original order, not a negative order; a voided order is kept with its status and excluded from sales metrics.
- **Split tenders**: one order paid by card and gift card produces one order and two payment transactions.
- **Business day vs calendar day**: restaurants close after midnight; orders are assigned a business date using the location's timezone and day cutoff (Toast reports by business date).
- **Multiple currencies**: amounts keep their currency; metrics never add amounts in different currencies together.
- **Modifiers and variants**: "Latte, large, oat milk" becomes a line item for a product variant with modifiers, with modifier prices included, not separate unrelated lines.
- **Tax-inclusive vs tax-exclusive prices**: recorded per order so net sales are computed correctly either way.
- **Deleted or merged records at the provider**: a deleted customer or product is soft-deleted, so historical orders keep their references.
- **Late edits**: an order edited at the POS days later is updated in place on the next sync.
- **Huge CSVs**: a file at the tenant file limit (100 MB, roughly 500k rows) imports in the background with progress and can be cancelled.
- **Malformed CSVs**: wrong encoding, a delimiter other than a comma, quoted newlines, a header that is not on the first row, footer total rows: detected or configurable, never silently mis-parsed.
- **Two imports or a sync and an import touching the same rows at once**: applied one after another; the last one to finish wins at the row level, and both are recorded.
- **Organization deleted**: its dataset, raw records and connections are erased (as tenant files are).
- **A member leaves**: data they imported, and connections they set up, stay with the organization. A connection made by a departed administrator keeps syncing until another administrator reconnects or removes it.
- **A user in several organizations**: each organization's dataset is separate; switching the active organization switches the dataset every dashboard and the agent read (spec 005).

## Requirements *(mandatory)*

### Functional Requirements

**Ownership and isolation**

- **FR-001**: Each tenant MUST have exactly one dataset, decided by the verified sign-in and never by a value the browser or a gadget supplies. No canonical row, raw record, mapping or credential is ever readable outside its tenant (spec 003).
- **FR-002**: Connecting and disconnecting integrations and deleting data MUST be limited to organization administrators, checked on every action against the current role; importing CSVs and reading data MUST be open to any member. In a personal workspace the owner may do everything.
- **FR-002a**: The dataset MUST reach a member's workspaces as an ambient data binding only because the organization's administrator enabled it; the data gatekeeper MUST NOT be able to make itself ambient, and removing a member MUST revoke their access on their next read.

**Ingestion**

- **FR-003**: The product MUST support Square and Stripe integrations, each requesting read-only provider access. Toast is supported through CSV import only in this release (Q3).
- **FR-004**: Each integration MUST perform an initial backfill (default: 3 years, configurable down) and then incremental sync, by provider webhooks where available with periodic polling as a backstop, at a default interval no longer than 15 minutes.
- **FR-005**: Sync and import MUST be idempotent: re-processing a source record updates its canonical rows instead of adding new ones.
- **FR-006**: Every source record MUST be kept in its original form, linked to the sync run or import that brought it, so canonical tables can be rebuilt without re-fetching or re-uploading.
- **FR-007**: CSV import MUST read files from the tenant file area (spec 004), detect encoding, delimiter and header row, and support files up to the tenant file limit in the background with progress and cancellation.
- **FR-008**: CSV import MUST let one file populate several tables (orders, line items, products, customers) from denormalized rows grouped by an order identifier, AND let a set of related files be imported as one unit, joined by shared identifiers (needed for Toast's multi-file exports).
- **FR-009**: The agent MUST be able to propose a CSV mapping from headers and sample rows; a person MUST confirm it, after a preview, before anything is written.
- **FR-010**: Mappings MUST be saveable as templates, recognised on later files by header match, and versioned; built-in templates MUST exist for Toast's data exports (as a multi-file set) and for Square's and Shopify's item-level sales exports.
- **FR-011**: Every import MUST produce a report (written, updated, skipped, rejected with reasons) and MUST be undoable as a unit.

**Canonical model**

- **FR-012**: The dataset MUST provide `locations`, `customers`, `products`, `orders`, `line_items`, `transactions` and `inventory` tables as defined in `data-model.md`, with the same columns and meanings regardless of source.
- **FR-013**: Every canonical row MUST record its source, source record id, and the run and mapping version that produced it.
- **FR-014**: Money MUST be stored as exact integer minor units with an ISO currency code; timestamps in UTC with the location's timezone available; orders MUST carry a business date.
- **FR-015**: Refunds, voids, discounts, tax, tips, service charges and split tenders MUST be represented as described in `data-model.md` so that standard metrics are computable without source-specific logic.

**Serving**

- **FR-016**: The dataset MUST be readable by the agent and by gadgets through a gatekeeper binding (so spec 007's source contract applies unchanged), and MUST be read-only through that path.
- **FR-017**: The dataset MUST provide named standard metrics with published definitions, and daily rollups (by location, by product, by customer) kept current with each sync and import.
- **FR-018**: Each read MUST be bounded (rows, bytes, time) and recorded as an observation, without logging row contents.
- **FR-019**: Personal data columns (customer name, email, phone, address) MUST be masked in agent reads by default; dashboards and reports MAY show aggregates over them.

**Operations**

- **FR-020**: The Data area MUST show each source's status, last sync or import, coverage by date and location, record counts and rejections, and MUST surface failures that need an administrator.
- **FR-021**: Provider credentials MUST be held only by the integration that uses them, never in the canonical store, and MUST NOT be readable by the agent or gadgets.
- **FR-022**: Erasing an organization MUST erase its dataset, raw records, templates and connections.
- **FR-023**: All new UI MUST be keyboard and screen-reader operable, including the mapping editor and preview.

### Key Entities

- **Dataset**: The canonical retail data of one tenant. Holds the canonical tables, rollups, raw records, templates and run history.
- **Source**: Where records come from: an integration connection (Square, Stripe) or a CSV upload (including Toast exports). Has a status and coverage.
- **Sync Run / Import**: One execution of fetching or importing; records counts, errors and the mapping version used; the unit of undo for imports.
- **Raw Record**: A source record exactly as received, with its source id and the run that brought it.
- **Mapping** and **Template**: The rules turning raw records into canonical rows. Built-in per integration; user-confirmed and saved for CSVs. Versioned.
- **Canonical tables**: `locations`, `customers`, `products`, `orders`, `line_items`, `transactions`, `inventory` (see `data-model.md`).
- **Metric**: A named, documented calculation over canonical tables (net sales, AOV, …), shared by every consumer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator connects Square and sees their last 30 days of orders in the canonical tables within 10 minutes for a location with up to 10,000 orders a month.
- **SC-002**: For test data loaded through an integration and through CSV, net sales, order count, units sold and refunds match the source system's own sales summary to the cent for 100% of tested days.
- **SC-003**: A member imports a first CSV (mapping, preview, import) in under 5 minutes with the agent's proposed mapping, and a later file with a saved template in under 1 minute.
- **SC-004**: Re-importing a file or re-running a sync produces 0 duplicate canonical rows.
- **SC-005**: New orders at a connected provider reach the canonical tables within 15 minutes in 95% of cases.
- **SC-006**: Standard metric queries over one year of data for one location return in under 2 seconds, and over 3 years across 10 locations in under 5 seconds.
- **SC-006a**: A synthetic organization at the scale target (10 busy locations, 3 years: about 3M orders and 15M line items) loads, syncs and answers SC-006 queries within the storage limit, with at least 25% headroom.
- **SC-007**: In isolation testing across three organizations, 0 rows, raw records, templates or credentials are visible outside their owner.
- **SC-008**: 0 attempts to modify data through the read interface succeed.

## Assumptions

- **Retail and restaurant focus**: the canonical model covers retail and food service sales. Not covered: accounting ledgers, payroll and labour, e-commerce fulfilment and shipping, loyalty programmes, purchasing and suppliers.
- **Stripe's role**: Stripe is treated as a payments and online-sales source (customers, payments, refunds, payouts, invoice and checkout line items), not as a POS. Stripe-only merchants get orders where Stripe has them (invoices, Checkout sessions); otherwise payments without line items.
- **Inventory**: the first release stores current stock levels per product and location, refreshed on sync, plus stock changes where the provider gives them (Square does). Toast restaurants get inventory only if they upload a stock export; Toast sales exports carry none. Costs come from the provider where available, else from a CSV product import, so gross margin may be partial and is labelled as such.
- **Personal data**: masked for the agent by default (FR-019); an organization administrator can allow unmasked access. Uploaded CSVs with personal data are subject to the same rule once mapped.
- **CSV files** arrive through the tenant file area (spec 004) and count against its quota; the raw records kept for re-mapping count against a separate dataset limit.
- **Not in scope**: writing back to providers (refunds, catalog edits), real-time streaming under one minute, cross-organization benchmarks, forecasting, and merging customers across sources automatically (Story 6 proposes; a person confirms).
- **Dependencies**: Clerk tenants and organization roles, tenant file area, gatekeeper OAuth and connect flow, Scheduled Tasks or Durable Object alarms for polling, and the gatekeeper observation model.
