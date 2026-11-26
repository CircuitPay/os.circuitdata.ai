# Feature Specification: Data Page (Upload, Map and Browse Retail Data)

**Feature Branch**: `008-data-page`

**Created**: 2026-11-25

**Status**: Draft (ready for `/speckit.plan`)

**Input**: User description: "We need to add a Data top level dashboard item. That page will serve as an entry point for the two built features (Upload a POS CSV; Map into the retail schema). This feature should at minimum allow us to upload a csv, perform the basic mapping, and view the data in the mapped schema."

**Builds on**: `specs/006-retail-data-layer` (the organization's retail dataset, CSV import, column mapping, preview, import report and undo, all built), `specs/004-organization-file-management` (uploaded files live in the organization's Files), `specs/001-clerk-tenant-identity` (organizations and their administrators).

**Feeds**: `specs/007-data-output-formats` (Dashboards and Reports read what this page loads).

## Summary

The pieces for getting retail data into the product exist, but a person cannot find them and cannot
see the result:

- **No way in.** "Data" appears in the navigation only after an organization's administrator has
  turned it on from the Connectors page. Until then nothing in the product says the feature exists,
  and a member who lands on an empty Dashboard is told to go somewhere that is not in their menu.
- **Upload is two levels down.** Once Data is on, importing a file is on the second tab of the
  Data area, behind an overview of storage and sources.
- **Nothing shows the data.** After an import the member sees counts (rows written, updated,
  rejected) but never the orders, line items or products themselves. The only way to look at the
  mapped data is to ask the agent or build a dashboard.

This feature makes **Data** a permanent top-level item in the navigation and gives it a page built
around one path: **upload a CSV → confirm how its columns map → see the data in the retail tables**.

| Part | State today | This feature |
| --- | --- | --- |
| Data in the navigation | Only after an administrator enables it | Always there, with a guided start |
| Turning Data on | On the Connectors page | Also on the Data page itself |
| Upload a POS CSV | Built, on the Imports tab | The page's primary action |
| Map into the retail schema | Built: proposed mapping, editor, preview, import, report, undo | A basic path that needs only the required fields confirmed; the full editor stays available |
| View the mapped data | Not built | New: browse each retail table, and jump from an import to its rows |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find Data and get started (Priority: P1)

A member signs in and sees **Data** in the main navigation, beside Workspaces and Outputs. Opening
it shows what state their organization's data is in and the one thing to do next: turn it on, upload
a first file, or look at what is there.

**Why this priority**: Without a visible way in, none of the built import features can be reached
by a new organization, and the Dashboards and Reports that depend on them stay empty.

**Independent Test**: Sign in to an organization that has never used Data. Confirm Data is in the
navigation, opens to a page that explains it, and lets an administrator turn it on from there
without visiting another page.

**Acceptance Scenarios**:

1. **Given** a signed-in member of an organization (or the owner of a personal workspace), **When** they look at the main navigation, **Then** Data is listed whether or not the organization has turned it on, and it appears once, not twice.
2. **Given** an organization that has not turned Data on, **When** an administrator opens Data, **Then** the page says what Data is for, and offers **Turn on Data**; choosing it turns Data on and shows the start of the upload path without leaving the page.
3. **Given** an organization that has not turned Data on, **When** a member who is not an administrator opens Data, **Then** the page says an administrator needs to turn it on, and offers nothing the member cannot do.
4. **Given** Data is on and nothing has been imported, **When** a member opens Data, **Then** the page leads with **Upload a CSV** and says which kinds of file work.
5. **Given** Data is on and holds data, **When** a member opens Data, **Then** they see how much is there (each table's row count, the dates covered, the most recent imports), with **Upload a CSV** and **Browse data** as the two main actions.
6. **Given** the deployment's operator has switched Data off for everyone, **When** anyone opens Data, **Then** the page says it is unavailable on this deployment.
7. **Given** a member switches to another organization, **When** the navigation and the Data page redraw, **Then** they reflect the new organization and nothing of the previous one remains on screen.

---

### User Story 2 - Upload a CSV and map it the basic way (Priority: P1)

A member chooses **Upload a CSV**, picks a file from their computer (or one already in Files), and
is shown the columns found, a sample of rows, and a proposed match from each column to a field of
the retail tables. If the fields the import cannot do without are matched, they press **Preview**,
check the totals, and press **Import**. They are told when it is finished.

**Why this priority**: This is the minimum the feature must do, and the step every later one
depends on.

**Independent Test**: Upload a CSV with one row per line item and common header names (order id,
date, item, quantity, price, total). Without opening the full mapping editor, reach a preview whose
order count and total match the file, import it, and see the finished report.

**Acceptance Scenarios**:

1. **Given** the Data page, **When** a member chooses Upload a CSV, **Then** they can pick a file from their computer or from Files in the same step, and a file picked from their computer is kept in Files.
2. **Given** a picked file, **When** it has been read, **Then** the member sees its columns, a sample of rows, and for each required field either the column proposed for it or a clear "not matched yet".
3. **Given** every required field is matched, **When** the member has changed nothing, **Then** Preview is available at once; they are not made to review optional fields first.
4. **Given** a required field is not matched, **When** the member picks a column for it from a list of the file's columns, **Then** the field is matched and Preview becomes available once none are left.
5. **Given** the file does not say them, **When** the member reaches the basic mapping, **Then** the timezone and currency are shown with sensible starting values and can be changed before Preview.
6. **Given** a preview, **When** the member reads it, **Then** they see how many orders, line items, products and customers it would create, the sales total to compare with their POS, and any rows that would be rejected with the reason.
7. **Given** a preview the member accepts, **When** they press Import, **Then** the import runs in the background, the page shows its progress, and the member may leave and return.
8. **Given** a finished import, **When** the member views its report, **Then** they see rows written, updated, skipped and rejected, with **View the imported data** leading to those rows (Story 3).
9. **Given** a file that matches a saved or built-in template (a Toast export set, a Square item detail export, a Shopify orders export, or a mapping the organization saved earlier), **When** it is picked, **Then** the mapping is filled in from the template and the member goes straight to Preview.
10. **Given** a mapping the basic path cannot express (several files joined together, value translations, parsing overrides), **When** the member needs it, **Then** **More options** opens the full mapping editor with their choices so far kept, and **Ask the agent** remains available.
11. **Given** a file that is not a readable CSV (empty, binary, or over the size limit), **When** it is picked, **Then** the member is told why in plain language and nothing is staged.

---

### User Story 3 - View the data in the retail tables (Priority: P1)

A member chooses **Browse data** and sees the retail tables: orders, line items, products,
customers, payments, locations and inventory. Picking one shows its rows in a grid with the retail
column names, newest first. They can narrow by date and by which import or source the rows came
from, page through, and open one row to see everything about it and where it came from.

**Why this priority**: It is the only way to confirm that a file was understood correctly, short
of building something on top of it. It completes the minimum the feature must do.

**Independent Test**: After importing a file with a known number of orders, open Orders in Browse
data, narrow to that import, and confirm the row count and a spot-checked order's date, total and
line items match the file.

**Acceptance Scenarios**:

1. **Given** Data holds rows, **When** a member opens Browse data, **Then** each retail table is listed with a one-line description and its row count, and an empty table says so rather than being hidden.
2. **Given** a table, **When** the member opens it, **Then** its rows are shown in a grid with the retail schema's column names, with money shown in its currency and dates and times shown readably.
3. **Given** a table with more rows than fit, **When** the member pages forward and back, **Then** they move through all of them in a stable order, and the page says where they are (for example "201–300 of 4,812").
4. **Given** a table that carries dates, **When** the member sets a date range, **Then** only rows in that range are shown and the count updates.
5. **Given** several imports or sources, **When** the member narrows to one, **Then** only rows it produced are shown; arriving from an import's report (Story 2, scenario 8) opens the table already narrowed to that import.
6. **Given** a row, **When** the member opens it, **Then** they see every field, the related rows one step away (an order's line items and payments; a line item's order and product), and the file and row number it came from.
7. **Given** the customers table, **When** a member views it, **Then** names, emails and phone numbers are masked unless the organization's administrator has allowed them to be shown.
8. **Given** a member typing in a search box on products or customers, **When** they search, **Then** rows whose name (or SKU, for products) contains the text are shown; what they type is treated as text to find and nothing else.
9. **Given** a very large table, **When** the member browses without a date range, **Then** the page still responds promptly by showing the most recent period first and saying so, rather than timing out.
10. **Given** an import that was undone, **When** the member browses, **Then** its rows are gone.

---

### User Story 4 - Keep track of imports and fix mistakes (Priority: P2)

A member returns to Data and sees their recent imports with their status. An import still running
shows progress; a finished one opens its report; one that went wrong can be undone.

**Why this priority**: Already built in spec 006. This story is about reaching it from the new
page, not building it.

**Independent Test**: Start an import, leave the page, return, and find it listed with its
progress or result; undo it and confirm its rows are gone from Browse data.

**Acceptance Scenarios**:

1. **Given** the Data page, **When** imports exist, **Then** the most recent are listed with file name, who imported, when, status and row counts, and each opens its report.
2. **Given** an import waiting for a mapping, **When** the member returns, **Then** it is listed as unfinished and resumes where it stopped.
3. **Given** a finished import that later imports have not changed, **When** the member chooses Undo, **Then** its rows are removed after a confirmation that names what will be removed.
4. **Given** everything else the Data area offers today (templates, coverage and gaps, connected sources, settings, matching), **When** the member needs it, **Then** it is still reachable from the Data page, with nothing removed.

---

### Edge Cases

- The same file is uploaded twice: the member is told it was imported before and that importing again updates rather than duplicates (spec 006), before anything is written.
- Two members import at once: both imports are listed for both of them; neither blocks the other.
- An administrator turns Data off while a member has the page open: the next action tells them Data was turned off, and the page returns to the "not turned on" state.
- A member's administrator rights are removed while the page is open: the Turn on Data button and administrator-only actions stop working on the next press, with a plain explanation.
- The file has a header row that is not the first row, a delimiter other than a comma, or an unusual encoding: what was detected is shown and can be changed under More options; it is never silently misread.
- A column is matched to two fields, or a required field is matched to a column that is empty in the sample: the member is warned before Preview.
- A required field has no plausible column at all (for example a file with no order identifier): the member is told what the import will do instead (treat each row as one order) or that the file cannot be imported as it is.
- Browse data on a table with no dates (products, customers, locations): the date range control is not shown.
- A value too long for a grid cell: it is shortened in the grid and shown in full when the row is opened.
- A member opens a link to a row that no longer exists (undone import): they are told it is gone and returned to the table.
- A deployment without organizations (no sign-in through organizations): Data is not in the navigation, as today.

## Requirements *(mandatory)*

### Functional Requirements

**Navigation and entry**

- **FR-001**: The main navigation MUST list **Data** for every signed-in member of an organization and every owner of a personal workspace, whether or not Data has been turned on, exactly once.
- **FR-002**: The Data page MUST show one of these states and nothing from another: unavailable on this deployment; not turned on (administrator view); not turned on (member view); on and empty; on with data.
- **FR-003**: An organization's administrator (or a personal workspace's owner) MUST be able to turn Data on from the Data page. The right to do so MUST be checked at the moment of the action, never from what the page believed when it loaded. Nobody else may turn it on, and the page MUST NOT be able to turn it on by itself.
- **FR-004**: The Data page with data MUST show each retail table's row count, the range of business dates covered, and the most recent imports with their status.
- **FR-005**: Everything the Data area offers today (imports list, templates, coverage, sources, settings, matching) MUST remain reachable from the Data page.
- **FR-006**: Other parts of the product that send a member to Data (for example an empty Dashboard's "import a CSV or connect a source in Data") MUST lead to this page.

**Upload and basic mapping**

- **FR-007**: A member MUST be able to start an import from the Data page's primary action by picking a file from their computer or from Files in one step. A file from their computer MUST be stored in Files and count against its quota.
- **FR-008**: After a file is picked, the page MUST show its detected columns, a sample of its rows, and a proposed match for each field, using a matching saved or built-in template when there is one.
- **FR-009**: The basic mapping MUST present the required fields first (a date, an order total, and for item-level files an item name and quantity, plus the column that identifies an order when there is one) and MUST let the member match each by picking from the file's columns.
- **FR-010**: Preview MUST be available as soon as every required field is matched, without requiring any action on optional fields, and MUST be unavailable while one is not, saying which.
- **FR-011**: The basic mapping MUST show the timezone, currency and date format it will use and let the member change them.
- **FR-012**: The preview MUST show the counts of rows it would create per table, the sales total, and rejected rows with reasons, before anything is written.
- **FR-013**: The member MUST be able to switch from the basic mapping to the full mapping editor and to the agent's suggestion at any point without losing the matches made so far.
- **FR-014**: Import MUST run in the background with visible progress, MUST survive the member leaving the page, and MUST end in the existing report with Undo.
- **FR-015**: A file that cannot be read as a CSV, is empty, or exceeds the size limit MUST be refused with a plain explanation, and nothing MUST be staged for it.

**Browsing the mapped data**

- **FR-016**: A member MUST be able to browse the rows of each retail table: orders, line items, products, customers, payments, locations and inventory.
- **FR-017**: Rows MUST be shown under the retail schema's column names, with money formatted in its currency, timestamps in the location's time, and absent values shown as absent.
- **FR-018**: Browsing MUST page through a whole table in a stable order (newest first where the table has dates), 100 rows at a time, showing the position and total.
- **FR-019**: Browsing MUST support narrowing by business date range (tables that have one), by the import or source that produced the rows, and by a text search on name or SKU for products and name for customers.
- **FR-020**: Opening a row MUST show all its fields, its directly related rows, and where it came from (source, import, file and row number).
- **FR-021**: Browsing MUST be read-only. No action on this page may change, add or delete a retail row; the only way to remove data stays Undo of an import and the existing administrator actions.
- **FR-022**: Customer names, emails and phone numbers MUST be masked in browsing unless the organization's administrator has allowed unmasked access, exactly as they are for the agent.
- **FR-023**: Text a member types into a filter or search MUST be treated only as a value to match. It MUST NOT be able to change which table or columns are read or to read anything outside the organization's dataset.
- **FR-024**: Browsing a large table MUST stay within the dataset's existing read limits. Where a table is too large to list unfiltered, the page MUST start on the most recent period and say that it has.
- **FR-025**: An import's report MUST link to the rows it produced, opening the relevant table narrowed to that import.

**Isolation and access**

- **FR-026**: Every member of the organization MUST be able to upload, map, import and browse. Turning Data on or off, connecting sources, changing settings and erasing remain administrator-only, as today.
- **FR-027**: No row, file, mapping or import of one organization may be visible to another. Switching organization MUST clear the page before the new organization's content is shown.
- **FR-028**: Row contents MUST NOT appear in server logs. Reads made by a person browsing are the person's own and are not recorded as agent observations.
- **FR-029**: All new UI MUST be operable by keyboard and screen reader, including the column pickers, the data grid (headers announced, position announced when paging) and the row detail.

### Key Entities

- **Data page state**: Which of the five states the organization is in, and whether the signed-in person may turn Data on.
- **Staged import**: A picked file waiting for its mapping: its columns, sample rows, proposed matches, and settings. Exists today.
- **Basic mapping**: The matches for the required fields plus timezone, currency and date format. A subset of the full mapping; switching to the full editor keeps it.
- **Retail table**: One of orders, line items, products, customers, payments, locations, inventory, with a description, columns and row count.
- **Browse view**: A table, a page position, and the narrowing in force (date range, import or source, search text).
- **Row detail**: One row's fields, its related rows, and its origin (source, import, file, row number).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member who has never used Data finds it in the navigation and reaches the upload step in at most 2 clicks once Data is on; an administrator turns Data on and reaches the upload step in at most 3.
- **SC-002**: With a CSV whose headers are common POS names, a member goes from picking the file to a finished import in under 3 minutes without opening the full mapping editor, in at least 9 of 10 test files.
- **SC-003**: After an import, a member can find a specific order from the file in Browse data in under 1 minute, and its date, total and line items match the file in 100% of spot checks.
- **SC-004**: For a test file with known totals, the preview's order count and sales total, the import report's counts, and the row counts shown in Browse data narrowed to that import all agree.
- **SC-005**: A page of any retail table appears in under 2 seconds for a dataset of one location with a year of data, and paging to the next 100 rows takes under 1 second.
- **SC-006**: In tests that type quotes, query fragments and wildcard characters into the search and filters, 0 return rows outside the chosen table or change what is read.
- **SC-007**: In isolation testing across three organizations, 0 rows, files, imports or mappings of one organization are visible in another's Data page.
- **SC-008**: In tests where a non-administrator attempts to turn Data on (through the page or by repeating an administrator's request), 0 succeed.
- **SC-009**: Every feature of the Data area that exists before this change is still reachable afterwards (templates, coverage, sources, settings, matching, undo), verified one by one.
- **SC-010**: At least 8 of 10 first-time test users complete upload, mapping and viewing their data without help.

## Assumptions

- **"Top level dashboard item" means a main navigation item** named Data, in the same list as Home, Workspaces, Blueprints and Outputs. It is not a new kind of Dashboard (spec 007).
- **One Data page, not two.** The existing Data area becomes this page: its overview is replaced by the entry described here, and its other tabs stay. Members do not get a second place that also manages data.
- **Organizations only.** Data is offered where sign-in provides organizations and personal workspaces. A deployment without them does not show Data, as today.
- **Who may turn Data on is unchanged**: an organization's administrator or a personal workspace's owner, subject to the operator's deployment-wide switch. This feature only adds a second place to do it.
- **"Basic mapping" covers single-file imports** with one row per line item or one row per order. Multi-file sets and unusual files use the templates and the full editor that already exist.
- **Required fields are spec 006's**: a business date (or a timestamp to derive it), a currency (or the setting) and an order total; for item-level files an item name and quantity. Timezone and currency default to the organization's existing locations, else UTC and USD, as the import already does.
- **Browsing is for checking, not analysis.** Paging, a date range, narrowing by import or source, and a name search are in scope. Sorting by arbitrary columns, column filters, saved views, charts and exporting the grid are not; Dashboards, Reports and the agent cover analysis.
- **Read limits are the dataset's own**: the browse view lists within the limits spec 006 set for reads, which is why very large tables open on a recent period.
- **Not in scope**: editing rows; deleting individual rows; new file formats (Excel, JSON); new built-in templates; connecting Square or Stripe from the entry path (the Sources tab keeps that); sample data for trying the product without a file.
- **Dependencies**: the retail data layer and its Data area (spec 006), organization Files (spec 004), organizations and administrator roles (spec 001), and the navigation's existing listing of management apps.
