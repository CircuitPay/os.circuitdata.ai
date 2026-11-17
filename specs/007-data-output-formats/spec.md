# Feature Specification: Data-Focused Output Formats (Dashboards, Reports, and Notebooks)

**Feature Branch**: `007-data-output-formats`

**Created**: 2026-11-17

**Status**: Draft (exploration; not ready for planning until the clarifications below are answered)

**Input**: User description: "Typical Cloudflare OS ships default blueprints for workspace docs, slides and sheets. This implementation wants to be more data focused: keep slides, but add dashboards / reports and potentially notebooks (not sure if that's necessary). Assume we will have a data connection through one of the gatekeepers."

**Depends on**: `specs/006-retail-data-layer`. The data these formats read is the organization's canonical retail dataset (locations, customers, products, orders, line items, transactions, inventory) and its standard metrics, served read-only through a gatekeeper binding. The data layer is built first.

**Builds on**: the bundled blueprints and format curation (`packages/bundled-blueprints`, `docs/blueprints.md`), gatekeeper bindings and the observation/approval model (`AGENTS.md`), `specs/001-clerk-tenant-identity` and `specs/003-tenant-branding-blueprint-isolation` (tenant-scoped data never crosses tenants). `research.md` beside this file records the options weighed and why.

## Summary

Today a deployment offers three standard output formats: Docs, Sheets and Slides. All three hold
*static* content: when the Slides starter deck shows a "connected chart", the agent drew it once
from data it read, and it never changes again. None of the bundled blueprints declares a data
binding.

This feature adds output formats whose content is *computed from a connected data source* and stays
current:

| Format | What it is | Priority |
| --- | --- | --- |
| **Dashboard** | A live grid of tiles (headline numbers, charts, tables), each driven by a saved query against a connected source, with shared filters and refresh. | P1 |
| **Report** | A narrative document with data-backed tables and charts, frozen *as of* a point in time, that can be regenerated (manually or on a schedule) and exported. | P2 |
| **Data in Slides** | Slides gains a chart/table block driven by the same saved queries, so a deck can be refreshed before it is presented. | P2 |
| **Notebook** | Ordered query + note cells with their outputs. Recommended **not** to build now (see User Story 6 and research D5). | P3 / deferred |

All data formats share one idea, the **saved query**: a named, reviewable read against a specific
connected source, whose result the format renders. The agent writes and edits saved queries in
natural language; a person can always see what a tile is computed from.

## Clarifications

Open; answer before `/speckit.plan`:

### Session 2026-11-17

- Q1: Which data gatekeeper(s) must the first release support? → A: The retail data layer (spec 006). Users connect Stripe, Square or Toast, or upload POS CSVs; that data is mapped into canonical retail tables, and those tables are what Dashboards, Reports and Slides read. Formats target the canonical schema and standard metrics, not any provider directly.

Open:
- Q2: When someone other than the owner opens a shared dashboard, whose access does its data come from? → [NEEDS CLARIFICATION: (A) the owner's connection, live: viewers see whatever the owner's queries return, so sharing the dashboard shares that data; (B) snapshot only: viewers see the last refresh the owner ran, and only the owner (or editors) can refresh; (C) viewers must bring their own connection. Research D4 recommends B as the default, with A an explicit per-dashboard choice by the owner.]
- Q3: Are notebooks in scope for this feature? → [NEEDS CLARIFICATION: the recommendation (research D5) is to defer them: the Workshop chat with the agent already is an exploratory notebook, and a dashboard or report is where a finished analysis should land. Revisit if analysts ask for reproducible step-by-step analysis that outlives a chat.]

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask for a dashboard over my connected data (Priority: P1)

A member who has connected a data source (through a data gatekeeper) chooses **New → Dashboard**, or
asks the agent "build me a dashboard of weekly signups and revenue by plan". The agent inspects the
source's schema, proposes a handful of tiles, writes a saved query for each, and lays them out. The
member sees the dashboard fill with live numbers and charts within seconds.

**Why this priority**: This is the format that makes the product "data focused". It exercises the
whole chain: connection, saved query, rendering and refresh. Everything else reuses it.

**Independent Test**: Connect a test database with known rows. Ask for a dashboard with one number,
one time-series chart and one table. Confirm each tile shows values that match a direct query of the
test data, and that each tile names its source and query.

**Acceptance Scenarios**:

1. **Given** a member with a connected data source, **When** they create a Dashboard, **Then** they get an empty dashboard that offers to connect or pick a source and to ask the agent for tiles.
2. **Given** an empty dashboard bound to a source, **When** the member asks the agent for specific metrics, **Then** the agent adds tiles, each with a saved query, a visual type and a title, and the tiles show results.
3. **Given** a tile, **When** the member opens its details, **Then** they see the source it reads, the query text, when it last ran, how many rows it returned and how long it took.
4. **Given** a member with **no** data source connected, **When** they create a Dashboard, **Then** they are guided to connect one (or to build from sample data), rather than shown a broken grid.
5. **Given** a query the source rejects (bad column, timeout, permission), **When** the tile runs, **Then** that tile alone shows the error in plain language with a "fix with agent" action; other tiles are unaffected.

---

### User Story 2 - Explore with filters and refresh (Priority: P1)

A viewer changes the dashboard's date range or picks a value for a shared filter (region, plan,
team). Every tile that uses that filter re-runs and updates together. They can refresh on demand, and
the dashboard says how fresh its data is.

**Why this priority**: A dashboard that cannot be sliced or refreshed is a picture. Filters are what
make one dashboard answer many questions without asking the agent each time.

**Independent Test**: Add a date-range filter and two tiles that use it and one that does not.
Change the range; confirm only the two tiles re-run and their results match direct queries for that
range.

**Acceptance Scenarios**:

1. **Given** a dashboard with a date-range filter, **When** a viewer changes the range, **Then** every tile that declares the filter re-runs with the new range, and tiles that do not are left alone.
2. **Given** a filter value typed or picked by a viewer, **When** it reaches a query, **Then** it is passed as a parameter, never pasted into query text, so no filter value can change what a query does.
3. **Given** a dashboard, **When** a viewer chooses Refresh, **Then** all tiles re-run and the "updated" time changes; while running, tiles keep their previous values with a busy indicator.
4. **Given** results older than the dashboard's freshness setting, **When** it is opened, **Then** it shows the cached results immediately, marked with their age, and refreshes in the background.
5. **Given** two viewers on the same dashboard, **When** one edits the layout or a tile, **Then** the other sees the change live (as Docs, Sheets and Slides already behave). Filter selections are per viewer and do not move other viewers' filters.

---

### User Story 3 - Edit tiles directly or through the agent (Priority: P1)

A member rearranges and resizes tiles, changes a chart from bars to a line, renames a tile, or asks
the agent "split revenue by plan" or "why did signups dip in March?". Small changes are direct
manipulation; anything that needs a new query goes through the agent.

**Why this priority**: Matches how the existing formats work (edit directly or with natural
language) and keeps query authoring where the schema knowledge is: in the agent.

**Independent Test**: Move and resize a tile, switch its chart type and undo; ask the agent to add a
breakdown and confirm a new or changed query appears with its result.

**Acceptance Scenarios**:

1. **Given** edit mode, **When** the member drags or resizes a tile, **Then** the layout snaps to the grid and the change is shared and undoable.
2. **Given** a tile, **When** the member changes its visual type among those that fit its result's shape, **Then** it re-renders without re-running the query.
3. **Given** a request to the agent that changes a query, **When** the agent applies it, **Then** the member can see the before and after query text and undo the change.
4. **Given** a member who can only view, **When** they open the dashboard, **Then** they can filter and (per Q2) refresh, but cannot change tiles, queries or layout.

---

### User Story 4 - Produce a report as of a date (Priority: P2)

A member asks for "the October sales report". The agent writes a document with headings, narrative
text, and data-backed tables and charts. The report is pinned to its **as-of** time: reopening it next
week shows the October numbers, not today's. The member can regenerate it (same structure, fresh
data, new as-of time), keep previous editions, export it to PDF, and optionally have it regenerated on
a schedule.

**Why this priority**: Reports are how data leaves the product: to a manager, a board, a customer.
They need stable numbers that do not move under a reader. They reuse the saved queries and rendering
from Story 1, so they come second.

**Independent Test**: Generate a report from test data, change the test data, reopen the report and
confirm the numbers did not change; regenerate and confirm a new edition shows the new numbers while
the old edition is still readable.

**Acceptance Scenarios**:

1. **Given** a connected source, **When** the member asks for a report, **Then** they get a document whose data blocks each show their as-of time and source.
2. **Given** a published edition, **When** the underlying data changes, **Then** the edition's numbers do not change.
3. **Given** a report, **When** the member chooses Regenerate, **Then** a new edition is created from the same queries and structure; narrative text the agent wrote about numbers is flagged for review when the numbers it describes changed.
4. **Given** a report, **When** exported to PDF, **Then** the charts and tables appear as rendered, with the as-of time on the document.
5. **Given** a report with a schedule (for example, "first Monday of the month, 8:00 America/Toronto"), **When** the time arrives, **Then** a new edition is produced and the owner is notified; the schedule is enabled by the user, never by the agent alone (as with Scheduled Tasks today).

---

### User Story 5 - Put live data in a slide deck (Priority: P2)

In Slides, a member asks for "a slide with quarterly revenue by region". The agent adds a chart block
that is driven by a saved query rather than drawn once. Before presenting, the member refreshes the
deck's data; the chart updates in place and keeps its position and style. Export to PDF and PowerPoint
includes the chart as it currently renders.

**Why this priority**: Slides is kept as a format, and its own starter deck already promises
"turn internal data into presentation-ready charts". This delivers that promise with the shared data
blocks, and costs little once Story 1 exists.

**Independent Test**: Add a data chart to a slide, change the test data, refresh the deck, confirm
the chart changes; export to PowerPoint and confirm the chart is present.

**Acceptance Scenarios**:

1. **Given** a deck and a connected source, **When** the agent adds a data chart, **Then** it is an ordinary block (movable, resizable, deletable) that also records its saved query.
2. **Given** a deck with data blocks, **When** the member chooses Refresh data, **Then** each data block re-runs and the deck records when.
3. **Given** a deck opened by a viewer, **When** they present it, **Then** they see the last refreshed values; presenting never triggers a query on its own.
4. **Given** an export to PDF or PowerPoint, **When** it runs, **Then** each data chart and table appears as rendered at its last refresh.

---

### User Story 6 - Notebook (Priority: P3, recommended deferral)

An analyst wants a reproducible, step-by-step analysis: a cell that queries, a note explaining it, a
cell that charts the result, then another query building on it, all kept and re-runnable later.

**Why this priority**: Real, but narrower. In this product the agent chat already *is* an
exploratory notebook (the agent runs queries and code, and each read is recorded as an observation).
What chat lacks is a durable, re-runnable artifact; a dashboard or report covers that for most
people. A notebook that runs user-written code inside a gadget would also duplicate the agent's code
execution with a second sandbox. See research D5.

**Independent Test** (if pursued): Build a three-cell notebook (query, note, chart over the query),
reopen it later and re-run all cells, confirm the outputs regenerate in order.

**Acceptance Scenarios** (if pursued): kept deliberately minimal: query cells and note cells only, run
top to bottom; one cell may use an earlier cell's result as a parameter; outputs are cached with
their run time. Arbitrary code cells are out of scope.

---

### Edge Cases

- A query returns 2 million rows: the format refuses to render beyond a row and byte cap, says so on the tile, and suggests aggregating; it never freezes the browser or fills the gadget's storage.
- A query runs for minutes or the source is down: the tile times out with a clear message; cached results remain visible with their age.
- The connection behind a dashboard is revoked, expires, or the owner leaves the organization: tiles show "source unavailable" with how to reconnect; cached results are not shown to viewers once the owner's access is gone (no stale leak past revocation).
- A dashboard is created from a blueprint in another workspace: it arrives with its tiles and queries but with no data until the new owner binds their own source; it never inherits the author's connection.
- The source schema changes (column renamed or dropped): affected tiles fail individually with the error and a "fix with agent" action.
- Money in mixed currencies (a multi-country organization): tiles never add amounts in different currencies; they split by currency or ask for one.
- A metric whose inputs are partial (gross margin with missing product costs): the tile shows the value with a "partial" marker and how much is missing.
- A filter value that contains SQL or quotes: it is a parameter, so it is treated as a value.
- A query the agent writes is not read-only (UPDATE, DELETE, DDL): the data formats never run it; reads only. Changes to data, if ever wanted, go through the gatekeeper's existing approval queue and never from a tile.
- Two editors change the same tile at once: last write wins per tile, both see the result, and undo is shared (as in Slides today).
- A very wide table or many series: the visual degrades legibly (scrolling table, "top N + other" series) rather than overlapping.
- A tenant switch while a dashboard is open: nothing from the previous tenant remains on screen (spec 003 rule).

## Requirements *(mandatory)*

### Functional Requirements

**Formats and curation**

- **FR-001**: The deployment MUST ship a **Dashboard** bundled blueprint and a **Report** bundled blueprint, installed and offered as standard output formats exactly as Docs, Sheets and Slides are today.
- **FR-002**: Slides MUST remain a standard format and gain data-backed chart and table blocks (Story 5). Docs and Sheets MUST remain installed; whether they stay in the New menu is the admin's existing format-curation decision, not a code change.
- **FR-003**: Each new format MUST declare its output kind (grouping id, noun, plural, icon) using the existing icon set (for example `chartBar` for Dashboards, `fileText` or `notebook` for Reports); the feature MUST NOT require new kernel output kinds.

**Data sources and saved queries**

- **FR-004**: A data format MUST read data only through a gatekeeper binding the user (or the agent with the user's approval of the connection) attached to that gadget. No format may embed credentials or reach a source any other way.
- **FR-005**: Every computed element (tile, report block, slide data block) MUST be driven by a **saved query** that records: the binding it reads, the query text, the parameters it accepts, and its output shape. A person MUST be able to view all of these.
- **FR-006**: The data formats MUST run reads only. They MUST refuse to run any query the source identifies as mutating, and MUST NOT call a gatekeeper's write or approval-queued operations.
- **FR-007**: Viewer-supplied values (filters) MUST reach queries only as bound parameters.
- **FR-008**: Results MUST be capped (rows and bytes, with deployment defaults) and the cap MUST be visible when hit.
- **FR-009**: The source contract the formats depend on MUST be small (describe tables and columns, run a parameterized read, ask for a standard metric, return typed rows) so that it is satisfied by the retail data layer's binding (spec 006, research D4) and, later, by other data gatekeepers through an adapter. Standard tiles (net sales, orders, AOV, units, margin) MUST use the data layer's metric definitions rather than their own SQL.
- **FR-010**: Each data read MUST be recorded the way gatekeeper reads are today (as an observation), and MUST NOT log row data in server logs.

**Rendering and interaction**

- **FR-011**: The formats MUST render at least: single value with comparison (KPI), line/area, bar (grouped/stacked), table, and text/markdown tiles. Charts MUST render inside the gadget sandbox with no external network fetch.
- **FR-012**: Dashboards MUST support shared filters (at least a date range and single/multi-select values), applied to every tile that declares them.
- **FR-013**: Results MUST be cached in the gadget so a dashboard opens with its last results immediately, labelled with their age, and refreshes per the dashboard's freshness setting.
- **FR-014**: Layout, tile, and query edits MUST sync live between editors with shared undo, matching the existing formats.
- **FR-015**: A failing query MUST affect only its own element, with a plain-language error and an agent hand-off.

**Sharing, isolation and freshness**

- **FR-016**: Whose access a shared dashboard uses MUST follow the answer to Q2, and that choice MUST be visible to the owner when sharing.
- **FR-017**: Revoking or losing the binding's access MUST stop new reads immediately and MUST stop showing cached results to anyone but the owner.
- **FR-018**: Publishing a data gadget as a blueprint MUST carry its tiles, queries and binding *shape* but never its connection, cached results, or report editions.
- **FR-019**: No data, cache or query result MAY cross tenants (spec 003).

**Reports**

- **FR-020**: A report edition MUST be immutable once produced: its numbers, charts and as-of time do not change when data changes.
- **FR-021**: Regenerating MUST create a new edition and keep earlier ones readable (with a retention cap).
- **FR-022**: Reports MUST export to PDF (and to a document format if Docs already supports one) with data blocks rendered.
- **FR-023**: Scheduled regeneration MUST use the existing Scheduled Tasks gatekeeper and its user-enables-the-hook rule.

**Agent**

- **FR-024**: The agent MUST be able to create, edit and explain tiles, queries and reports through the gadget's programmatic API (as it does for Slides over the `GADGET` binding), and its guidance MUST steer data requests to Dashboard or Report rather than a static doc or sheet.
- **FR-025**: All new UI MUST be keyboard and screen-reader operable; charts MUST have a text alternative (a summary and access to the underlying table).

### Key Entities

- **Data Source**: A gatekeeper binding attached to a gadget that can describe its schema and run parameterized reads. Owned by the user who connected it; never part of a blueprint.
- **Saved Query**: A named read: source binding name, query text, declared parameters, output column types, row cap, last run (time, duration, row count, error).
- **Result**: A cached, typed table produced by running a saved query with specific parameter values at a specific time.
- **Tile / Data Block**: A visual (KPI, chart, table, text) placed in a Dashboard, Report or Slide, bound to a saved query and mapping result columns to visual roles (x, y, series, value).
- **Filter**: A dashboard-level control (date range, select) whose value is passed to queries that declare the matching parameter. Per-viewer state.
- **Dashboard**: A grid layout of tiles plus filters, a freshness setting and a sharing mode (Q2).
- **Report** and **Edition**: A report is a structure (sections, narrative, data blocks); an edition is one immutable rendering of it as of a time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member with a connected source gets a first working dashboard of 3+ tiles from a single natural-language request in under 2 minutes, without editing any query by hand.
- **SC-002**: A dashboard with 8 tiles opens showing cached results in under 2 seconds, and completes a full refresh against a responsive source in under 10 seconds.
- **SC-003**: In tests that feed SQL fragments and quotes as filter values, 0 change the meaning of a query.
- **SC-004**: In tests that ask the agent for a write query in a tile, 0 mutating statements reach the source from a data format.
- **SC-005**: A report edition shows identical numbers before and after the underlying data changes, in 100% of tested cases.
- **SC-006**: A data chart added to Slides survives PDF and PowerPoint export in 100% of tested decks.
- **SC-007**: In isolation testing across three tenants, 0 results, caches or editions are visible outside their tenant; after a connection is revoked, viewers stop seeing its data within 5 seconds.
- **SC-008**: At least 80% of test users can explain where a tile's number comes from by using the tile's details alone.

## Assumptions

- **The data source is the retail dataset** (Q1): spec 006 provides it, read-only, with standard metrics and daily rollups. Dashboards default to rollups and metrics for speed and fall back to guarded SQL for custom tiles.
- **Retail starter content**: each format ships starter layouts for the retail model (for example a "Daily sales" dashboard: net sales, orders, AOV, sales by location, top products, refunds; a "Monthly sales report"), so a new organization sees value as soon as its first import lands.
- **Other sources later**: Supabase and other SQL gatekeepers can be added later as adapters behind the same source contract; non-SQL sources (APIs, MCP tools) likewise.
- **Charts are drawn in-sandbox**: gadgets cannot fetch external scripts, so charting code is bundled into the blueprint (through a shared gadget library), and must also feed the existing PDF/PowerPoint exporters.
- **Docs and Sheets stay**: they are not removed from the code; admins may remove them from the New menu with existing curation.
- **Not in scope**: writing data back from a dashboard; alerting/thresholds that notify (a natural follow-up using Scheduled Tasks); joining across two sources in one query; embedding dashboards outside the product; public share links; a visual (no-code) query builder; notebooks unless Q3 says otherwise.
- **Dependencies**: bundled-blueprint build and install, gadget libraries (`ui`, `sync`, `pptx`), format curation, gatekeeper bindings and observations, Scheduled Tasks, and tenant isolation.
