# Feature Specification: Data-Focused Output Formats (Dashboards, Reports and Sheets)

**Feature Branch**: `007-data-output-formats`

**Created**: 2026-11-17

**Updated**: 2026-11-25 (format set changed to Dashboards, Reports and Sheets; open questions closed)

**Status**: Planned (see `plan.md`; four items adjusted during planning, listed under Clarifications)

**Input**: User description: "Set the bundled blueprints/formats to reports dashboards and sheets"

Earlier input, still in force where it does not conflict: "This implementation wants to be more data focused: add dashboards / reports. Assume we will have a data connection through one of the gatekeepers."

**Depends on**: `specs/006-retail-data-layer` (built). The data these formats read is the organization's canonical retail dataset (locations, customers, products, orders, line items, transactions, inventory), its daily rollups and its standard metrics, served read-only to the agent and to gadgets.

**Builds on**: the bundled blueprints and format curation (`packages/bundled-blueprints`, `docs/blueprints.md`), `specs/001-clerk-tenant-identity` and `specs/003-tenant-branding-blueprint-isolation` (tenant data never crosses tenants). `research.md` beside this file records the options weighed.

## Summary

A deployment today offers three standard output formats: Docs, Sheets and Slides. All three hold
static content, and none reads a data source.

This feature changes the standard set to three formats aimed at a retailer's data:

| Format | What it is | Status |
| --- | --- | --- |
| **Dashboard** | A live grid of tiles (headline numbers, charts, tables), each driven by a saved query against the organization's retail data, with shared filters and refresh. | New, P1 |
| **Report** | A narrative document with data-backed tables and charts, frozen *as of* a point in time, that can be regenerated and exported to PDF. | New, P1 |
| **Sheets** | The existing spreadsheet, for ad-hoc tabular work a person types or pastes in. | Kept, unchanged |

Docs and Slides stop being part of what the deployment ships. Report takes over the "written
document" role; nothing takes over presentations.

Dashboards and Reports share one idea, the **saved query**: a named, reviewable read of the retail
dataset whose result the format renders. The agent writes and edits saved queries from natural
language, and a person can always see what a number is computed from.

## Clarifications

### Session 2026-11-17

- Q1: Which data source must the first release support? → A: The retail data layer (spec 006). Formats target its canonical tables and standard metrics, never a provider directly.

### Session 2026-11-25

- Q2: When someone other than the owner opens a shared dashboard or report, whose access does its data come from? → A: **The viewer's own.** The retail dataset is held by the organization, so every member already has read access to it, and spec 006 admits a viewer only when their own organization holds that dataset. A dashboard therefore refreshes live for any member of the owner's organization, and shows nothing (no cached results either) to anyone outside it. No delegation of the owner's access is involved.
- Q3: Are notebooks in scope? → A: **No.** Chat with the agent is the exploratory surface, and a Report that shows its queries covers the durable part (research D5).
- Q4: Which formats does the deployment ship? → A: **Dashboards, Reports and Sheets.** Docs and Slides are removed from the bundled set. The "data in Slides" story from the earlier draft is dropped with them.

### Session 2026-11-25 (planning)

Planning (`plan.md`, `research.md`) found four places where the first draft asked for something the platform has no mechanism for. Each was narrowed to what the platform does, rather than widening the kernel:

- Q5: What can a view-only member do? → A: A view-only share is a frozen copy of the gadget (a kernel rule), so its holder sees the dashboard or report as it was shared and cannot filter against live data or refresh. A collaborator who can use the gadget can do everything it offers. (US4 scenario 4.)
- Q6: When does turning the data off take effect? → A: At the workspace's next open, which is when the platform withdraws a disabled data connection (the same rule spec 006 has for chats). From then on nothing is read and nothing cached is shown. (FR-022.)
- Q7: What does publishing a dashboard or report as a blueprint carry? → A: The format's code and its starter layout. A blueprint never carries a gadget's stored content, so the tiles, sections, results and editions a person built stay behind. (FR-023.)
- Q8: Whose branding is on a PDF? → A: The report's own letterhead (name, logo, accent colour), set once on the report by a person or the agent. The organization's workspace branding does not reach gadgets today; feeding it to them is a follow-up. (FR-028, US2 scenario 6.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask for a dashboard over my retail data (Priority: P1)

A member whose organization has retail data chooses **New → Dashboard**, or asks the agent "build me
a dashboard of last month's sales by day and my top products". The agent inspects the dataset,
proposes a handful of tiles, writes a saved query for each, and lays them out. The member sees the
dashboard fill with numbers and charts within seconds.

**Why this priority**: This is the format that makes the product data focused, and it exercises the
whole chain: dataset, saved query, rendering and refresh. Reports reuse all of it.

**Independent Test**: Import a CSV with known totals. Ask for a dashboard with one headline number,
one time-series chart and one table. Confirm each tile's values match the known totals, and that
each tile names the query it runs.

**Acceptance Scenarios**:

1. **Given** an organization with retail data, **When** a member creates a Dashboard from the New menu, **Then** it opens with a starter "Sales overview" layout already showing their data (net sales, orders, average order value, sales by day, top products, refunds).
2. **Given** a dashboard, **When** the member asks the agent for specific metrics, **Then** the agent adds tiles, each with a saved query, a visual type and a title, and the tiles show results.
3. **Given** a tile, **When** the member opens its details, **Then** they see the query, the period it covers, when it last ran, how many rows it returned and how long it took.
4. **Given** an organization whose retail data is not enabled, or is enabled but empty, **When** a member creates a Dashboard, **Then** they are told which of the two it is and are pointed to the Data area, rather than shown a broken or empty grid.
5. **Given** a query the dataset refuses (unknown column, scan too large, not read-only), **When** the tile runs, **Then** that tile alone shows the refusal in plain language with a "fix with agent" action, and other tiles are unaffected.
6. **Given** a standard figure (net sales, orders, average order value, units sold, gross margin, refunds), **When** a tile shows it, **Then** it uses the dataset's shared definition of that metric, so the number matches the same figure in every other dashboard and report.

---

### User Story 2 - Produce a report as of a date (Priority: P1)

A member asks for "the October sales report". The agent writes a document with headings, narrative
text, and data-backed tables and charts. The report is pinned to its **as-of** time: reopening it
next week shows the October numbers as they were, not today's. The member can regenerate it (same
structure, fresh data, new as-of time), keep earlier editions, and export it to PDF.

**Why this priority**: Reports are how data leaves the product: to an owner, a manager, an
accountant. They need numbers that do not move under the reader. With Docs removed, Report is also
the deployment's only written-document format, so it ships with the first release.

**Independent Test**: Generate a report from imported data, import more data for the same period,
reopen the report and confirm the numbers did not change. Regenerate and confirm a new edition shows
the new numbers while the old edition is still readable.

**Acceptance Scenarios**:

1. **Given** an organization with retail data, **When** a member creates a Report from the New menu, **Then** it opens with a starter "Monthly sales report" structure for the most recent complete month.
2. **Given** a report, **When** the member reads it, **Then** every data block shows its as-of time and the period it covers.
3. **Given** a produced edition, **When** the underlying data changes, **Then** the edition's numbers and charts do not change.
4. **Given** a report, **When** the member chooses Regenerate, **Then** a new edition is created from the same queries and structure, and narrative text that states numbers which have since changed is flagged for review.
5. **Given** a report, **When** the member edits narrative text, headings or the order of sections, **Then** the change is saved, shared with other editors and undoable, as document editing is today.
6. **Given** a report, **When** exported to PDF, **Then** the text, charts and tables appear as rendered, with the as-of time and the report's letterhead on the document.
7. **Given** a period the dataset marks as not yet complete (a source has not reported up to the end of it), **When** a report covers that period, **Then** the report says so beside the affected figures.

---

### User Story 3 - Explore a dashboard with filters and refresh (Priority: P1)

A viewer changes the dashboard's date range or picks a location. Every tile that uses that filter
re-runs and updates together. They can refresh on demand, and the dashboard says how fresh its data
is.

**Why this priority**: A dashboard that cannot be sliced or refreshed is a picture. Filters let one
dashboard answer many questions without asking the agent each time.

**Independent Test**: Add a date-range filter, two tiles that use it and one that does not. Change
the range and confirm only the two tiles re-run and that their results match the known totals for
that range.

**Acceptance Scenarios**:

1. **Given** a dashboard with a date-range filter, **When** a viewer changes the range, **Then** every tile that declares the filter re-runs with the new range, and tiles that do not are left alone.
2. **Given** a filter value typed or picked by a viewer, **When** it reaches a query, **Then** it is passed as a value, never pasted into the query text, so no filter value can change what a query does.
3. **Given** a dashboard, **When** a viewer chooses Refresh, **Then** all tiles re-run and the "updated" time changes; while running, tiles keep their previous values with a busy indicator.
4. **Given** results older than the dashboard's freshness setting, **When** it is opened, **Then** it shows the last results immediately, marked with their age, and refreshes in the background.
5. **Given** two members on the same dashboard, **When** one edits the layout or a tile, **Then** the other sees the change live. Filter selections are per viewer and do not move other viewers' filters.

---

### User Story 4 - Edit tiles directly or through the agent (Priority: P2)

A member rearranges and resizes tiles, changes a chart from bars to a line, renames a tile, or asks
the agent "split net sales by location" or "why did sales dip in the second week?". Small changes
are direct manipulation; anything that needs a new query goes through the agent.

**Why this priority**: It matches how the existing formats work (edit directly or in natural
language). The first dashboards can be built entirely through the agent, so this follows Story 1.

**Independent Test**: Move and resize a tile, switch its chart type and undo; ask the agent to add a
breakdown and confirm a changed query appears with its result.

**Acceptance Scenarios**:

1. **Given** edit mode, **When** the member drags or resizes a tile, **Then** the layout snaps to the grid and the change is shared and undoable.
2. **Given** a tile, **When** the member changes its visual type among those that fit its result's shape, **Then** it re-renders without re-running the query.
3. **Given** a request to the agent that changes a query, **When** the agent applies it, **Then** the member can see the query text before and after, and undo the change.
4. **Given** a member holding a view-only share, **When** they open the dashboard, **Then** they see it as it was shared, marked as a read-only copy, and cannot change tiles, queries or layout or refresh its data.

---

### User Story 5 - The deployment offers Dashboards, Reports and Sheets (Priority: P1)

A member opens the New menu and sees Dashboard, Report and Sheet. When they ask the agent for
something computed from their data, the agent chooses a Dashboard or a Report; when they ask for a
table to fill in by hand, it chooses a Sheet. Docs and Slides are no longer offered.

**Why this priority**: The format set is what the user asked for, and it is what makes a new
organization's first experience data focused. It is small once the two new formats exist.

**Independent Test**: On a fresh deployment, open the New menu and confirm exactly the three
formats appear. Ask the agent for "a dashboard", "a report" and "a table to track my suppliers" and
confirm it creates the matching format each time.

**Acceptance Scenarios**:

1. **Given** a fresh deployment, **When** a member opens the New menu, **Then** it lists Dashboard, Report and Sheet, and nothing else that the deployment ships.
2. **Given** a request for a figure, chart or summary of the organization's data, **When** the agent picks a format, **Then** it uses Dashboard for something to keep current and Report for a dated deliverable, and does not draw a one-off static chart in a Sheet.
3. **Given** a request for hand-entered tabular work, **When** the agent picks a format, **Then** it uses Sheets.
4. **Given** a request for a slide deck or presentation, **When** the agent responds, **Then** it says the deployment has no presentation format and offers a Report instead.
5. **Given** a deployment that was running before this change, **When** it is upgraded, **Then** Docs and Slides disappear from the New menu and from the agent's list of formats, and documents and decks that members already created still open and can still be edited.
6. **Given** an operator, **When** they open the admin Formats panel, **Then** the three formats are the standard set, and the operator can still add or remove formats from the menu as today.

---

### User Story 6 - Regenerate a report on a schedule (Priority: P3)

A member sets the monthly sales report to regenerate on the first Monday of each month. When the
time arrives, a new edition is produced and the member is notified.

**Why this priority**: Useful once reports are in regular use, but a member can regenerate by hand
until then.

**Independent Test**: Give a report a schedule a few minutes ahead, wait, and confirm a new edition
exists with a later as-of time and the earlier edition is still readable.

**Acceptance Scenarios**:

1. **Given** a report with a schedule, **When** the time arrives, **Then** a new edition is produced and the owner is notified.
2. **Given** a schedule the agent proposed, **When** the member has not turned it on, **Then** nothing runs; a schedule is enabled by a person, never by the agent alone.

---

### Edge Cases

- A query returns more rows than can be shown: the tile or block stops at the cap, says so, and suggests aggregating. It never freezes the browser or fills the gadget's storage.
- A query would scan the whole history without a date filter: the dataset refuses it, and the tile shows the refusal with the suggestion to narrow the range or use a daily summary.
- The organization's administrator turns the retail data off, or the operator disables it: tiles show "data unavailable" with who can turn it back on, and cached results are no longer shown to anyone.
- A member leaves the organization: they lose access to its dashboards' and reports' data on their next read, including cached results and past editions.
- A dashboard or report is published as a blueprint, or created from one in another organization: it arrives as the format with its starter layout, reads the *new* organization's data, and carries none of the author's tiles, sections, results or editions.
- Money in more than one currency: tiles and blocks never add amounts in different currencies; they split by currency or ask for one.
- Gross margin where some products have no cost: the figure is shown with a "partial" marker and the share of units it covers.
- Customer names, emails and phone numbers: shown masked unless the organization's administrator has allowed unmasked access; aggregates over customers are unaffected.
- Days the dataset flags as possible gaps (no orders on a day that normally trades): charts mark them, so a missing import is not read as a slow day.
- A filter value that contains quotes or query text: it is treated as a value.
- A query the agent writes is not read-only: it is never run.
- Two editors change the same tile or section at once: the last write wins for that tile or section, both see the result, and undo is shared.
- A very wide table or a chart with many series: the visual degrades legibly (scrolling table, "top N + other") rather than overlapping.
- The member switches organization while a dashboard is open: nothing from the previous organization remains on screen.
- A report has reached its limit of kept editions: the oldest unpinned edition is removed and the member is told before regenerating.

## Requirements *(mandatory)*

### Functional Requirements

**The format set**

- **FR-001**: The deployment MUST ship exactly three bundled formats: **Dashboard**, **Report** and **Sheets**, and MUST offer all three as standard formats on a fresh deployment without operator action.
- **FR-002**: Docs and Slides MUST be removed from what the deployment ships, together with anything that exists only to serve them. Nothing in the product MUST continue to offer, promote or steer the agent toward them.
- **FR-003**: Documents and decks created before the change MUST keep opening and remain editable; removing a format from the bundle MUST NOT delete or break gadgets already created from it.
- **FR-004**: Each new format MUST declare its output kind (name, plural and icon) using the existing icon set, so it appears in the New menu, workspace tabs, chat cards and the Outputs page like the existing formats, with no new kinds of output added to the platform.
- **FR-005**: Sheets MUST keep its current behaviour. This feature MUST NOT add data connections to Sheets.
- **FR-006**: The operator's existing ability to curate which formats are offered MUST keep working over the new set.

**Data and saved queries**

- **FR-007**: Dashboards and Reports MUST read data only through the organization's retail data binding attached to that gadget. No format may hold credentials or reach data any other way.
- **FR-008**: A Dashboard or Report created in an organization whose retail data is enabled MUST be connected to that data without the member having to wire anything.
- **FR-009**: Every computed element (dashboard tile, report data block) MUST be driven by a **saved query** that records the query, the parameters it accepts and the shape of its result. A person MUST be able to view all of these.
- **FR-010**: Standard figures (net sales, gross sales, discounts, refunds, tax, tips, orders, average order value, units sold, gross margin, repeat customer rate) MUST come from the dataset's shared metric definitions rather than a query written per tile.
- **FR-011**: The formats MUST run reads only, and MUST NOT run any query the dataset identifies as changing data.
- **FR-012**: Viewer-supplied values (filters) MUST reach queries only as parameter values.
- **FR-013**: Results MUST be capped in rows and size, and the cap MUST be visible when hit.
- **FR-014**: Each read MUST be recorded the way reads of the retail dataset already are, and row contents MUST NOT appear in server logs.

**Rendering and interaction**

- **FR-015**: The formats MUST render at least: a single value with a comparison to the previous period, line or area chart, bar chart (grouped and stacked), table, and text. Charts MUST render with no fetch from outside the product.
- **FR-016**: Dashboards MUST support shared filters (at least a date range and a location picker), applied to every tile that declares them.
- **FR-017**: A dashboard MUST open with its last results immediately, labelled with their age, and refresh according to its freshness setting.
- **FR-018**: Layout, tile, section and query edits MUST sync live between editors with shared undo, as the existing formats do.
- **FR-019**: A failing query MUST affect only its own element, with a plain-language explanation and a hand-off to the agent.
- **FR-020**: Money MUST be shown in its currency and never summed across currencies; partial figures and incomplete periods MUST be marked as such.

**Sharing and isolation**

- **FR-021**: Every viewer's reads MUST be authorized against the viewer's own membership of the organization that holds the data. A viewer outside that organization MUST see no data, no cached results and no report editions.
- **FR-022**: Losing access (the member leaves, the organization turns the data off, the operator disables it) MUST stop new reads and stop showing cached results and editions. A member who leaves loses access at once; turning the data off takes effect when the workspace is next opened.
- **FR-023**: Publishing a dashboard or report as a blueprint MUST carry the format and its starter layout only, and MUST NOT carry a person's tiles or sections, results, cached data, editions or letterhead.
- **FR-024**: No data, cache, result or edition may cross organizations.

**Reports**

- **FR-025**: A report edition MUST be immutable once produced: its numbers, charts and as-of time do not change when data changes.
- **FR-026**: Regenerating MUST create a new edition and keep earlier ones readable, up to a retention limit of 24 editions per report.
- **FR-027**: Narrative text in a report MUST be editable by a person and by the agent, and text that states figures MUST be flagged for review when a regeneration changes those figures.
- **FR-028**: Reports MUST export to PDF with text and data blocks rendered as shown, the as-of time, and the report's letterhead (name, logo and accent colour held by the report).
- **FR-029**: Scheduled regeneration MUST reuse the product's existing scheduled-task mechanism and its rule that a person enables each schedule.

**Starter content and the agent**

- **FR-030**: Dashboard MUST ship a "Sales overview" starter layout and Report a "Monthly sales report" starter structure, both built on the standard metrics, so a new organization sees its own numbers as soon as its first import lands.
- **FR-031**: The agent MUST be able to create, edit and explain tiles, queries, sections and reports, and its guidance MUST steer requests about the organization's data to Dashboard or Report, and hand-entered tabular work to Sheets.
- **FR-032**: All new UI MUST be keyboard and screen-reader operable, and every chart MUST have a text alternative (a summary and access to the underlying table).

### Key Entities

- **Format**: A bundled blueprint the deployment offers as a standard kind of output. After this feature: Dashboard, Report, Sheets.
- **Saved Query**: A named read of the retail dataset: the query or standard metric, its declared parameters, the shape of its result, and its last run (time, duration, row count, error).
- **Result**: A cached, typed table produced by running a saved query with specific parameter values at a specific time.
- **Tile / Data Block**: A visual (single value, chart, table, text) placed in a Dashboard or Report, bound to a saved query and mapping result columns to visual roles (x, y, series, value).
- **Filter**: A dashboard-level control (date range, location) whose value is passed to queries that declare the matching parameter. Its selection is per viewer.
- **Dashboard**: A grid layout of tiles plus filters and a freshness setting.
- **Report**: A structure of sections, narrative text and data blocks.
- **Edition**: One immutable rendering of a report as of a time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a fresh deployment, the New menu lists exactly Dashboard, Report and Sheet, with no operator setup.
- **SC-002**: A member with imported data gets a first working dashboard of three or more tiles from a single natural-language request in under 2 minutes, without editing a query by hand.
- **SC-003**: A member gets a monthly sales report from a single request in under 3 minutes, and exports it to PDF in under 30 seconds.
- **SC-004**: For a test dataset with known totals, 100% of standard figures on the starter dashboard and the starter report match those totals to the cent.
- **SC-005**: A dashboard with 8 tiles opens showing its last results in under 2 seconds and completes a full refresh in under 10 seconds for one location with a year of data.
- **SC-006**: A report edition shows identical numbers before and after the underlying data changes, in 100% of tested cases.
- **SC-007**: In tests that feed query fragments and quotes as filter values, 0 change the meaning of a query; in tests that ask the agent for a query that changes data, 0 such queries reach the dataset from a format.
- **SC-008**: In isolation testing across three organizations, 0 results, caches or editions are visible outside their organization, and a removed member stops seeing an organization's data on their next read.
- **SC-009**: After upgrading a deployment that has existing documents and decks, 100% of them still open and accept edits.
- **SC-010**: At least 80% of test users can say where a tile's number comes from by using the tile's details alone.

## Assumptions

- **The data source is the retail dataset** (Q1). It is the only source in this release. Other data sources can be added later behind the same saved-query idea; none is designed here.
- **"Set the bundled formats" means replace, not add**: Docs and Slides leave the shipped set and their code is removed rather than hidden, in line with the project's rule against keeping obsolete paths. Existing gadgets are independent copies of their format, so they keep working without the bundle. If Docs or Slides should instead stay installed but unpromoted, FR-002 changes and nothing else does.
- **No presentation format**: with Slides gone, PowerPoint export goes too. Reports export to PDF only.
- **Sheets stays static**: pulling a query result into a sheet is a natural follow-up and is not part of this feature.
- **Access is the organization's** (Q2): because the dataset belongs to the organization and each viewer is checked against it, a dashboard is live for every member and there is no "owner's connection" to delegate or snapshot.
- **Clerk deployments only**: organization-held retail data exists only where sign-in provides organizations, so Dashboards and Reports show their "no data" state on a deployment without it.
- **Speed comes from the dataset's daily summaries**: starter content and standard tiles use the shared metrics and daily rollups; custom tiles fall back to guarded queries with a date filter.
- **Charts are drawn inside the gadget**: gadgets cannot load outside scripts, so charting ships with the formats.
- **Not in scope**: notebooks (Q3); writing data back from a dashboard; alerts and thresholds; joining the retail dataset with another source; embedding dashboards outside the product; public share links; a visual query builder; migrating existing documents into Reports.
- **Dependencies**: the retail data layer (spec 006), bundled-blueprint build and install, format curation, the existing collaboration behaviour of bundled formats, the platform's PDF export of gadgets, and Scheduled Tasks (Story 6 only).
