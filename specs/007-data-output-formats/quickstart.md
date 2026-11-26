# Quickstart: validating the data formats

Each scenario maps to a user story or success criterion in `spec.md`. Interfaces are in
`contracts/`, state in `data-model.md`.

## Prerequisites

- `pnpm install`.
- For the manual scenarios: a Clerk-enabled instance (`docs/clerk-signin.md`) with retail data
  enabled for the organization (Connectors → **Enable for organization**) and one CSV imported in
  **Data** with a known total (`specs/006-retail-data-layer/quickstart.md`, scenario 2).
- For PDF export: an instance with the Browser Rendering binding (a deployed instance; local
  `pnpm dev-server` reports "Gadget export is not configured for this deployment").

## Automated

```sh
pnpm --filter @gadgets/bundled-blueprints test:run            # data library, Dashboard, Report, Sheets, build
pnpm exec vp run -F @gadgets/bundled-blueprints build          # the five type-check programs
pnpm --filter @gadgets/workshop-backend test:run               # kernel unit + integration (builds the bundle first)
pnpm --filter @gadgets/workshop-frontend test:run
pnpm --filter @gadgets/integration-tests test:run
pnpm lint
```

What the suites must show:

| Area | Expected |
|---|---|
| Format set (US5, SC-001) | The generated bundle holds exactly `format.dashboard`, `format.report`, `format.spreadsheet`; every bundled `client.js` has an `@media print` block and every `server.js` exports `ExportHandler`. |
| Upgrade (US5.5, SC-009) | With `format.document` and `format.slides` stamped as promoted and present in `AdminConfig.formats` and the featured mirror, one install run removes both from each, keeps their KV records, and a second run changes nothing. |
| Auto-connection (FR-008) | Every invariant in `contracts/kernel-seam.md`: bound on both creation paths when the capsule exists, unbound otherwise, rebound after the capsule is removed and re-added, a person's unbind respected, `requiresSetup` false, assignment refused, export emits the ambient variant. |
| Parameters (SC-007) | Hostile filter and literal values produce byte-identical SQL text to benign ones and arrive only as bound values; write statements never reach the reader. |
| Standard figures (FR-010, SC-004) | Starter tiles and blocks call `metric()` with the shared names; a fake reader with known totals yields those totals on the KPI tiles to the cent. |
| Filters (US3) | Changing a filter re-runs only tiles that use it; unchanged tiles keep their cached outcome. |
| Access (FR-021/022) | `off` mode purges cached results (Dashboard) and withholds editions (Report); `snapshot` mode serves stored state and refuses reads and mutations. |
| Editions (SC-006) | An edition's blocks are identical before and after the underlying data and the sections change; a second generation leaves the first readable; retention prunes the oldest unpinned. |
| Schedule (US6) | The restored hook generates once per `runId` and skips outside the first week with `monthly: "first"`. |

## Manual scenarios

1. **Format set (US5)**: on a fresh instance the New menu lists Dashboard, Report and Sheet. Ask
   the agent for "a dashboard of last month's sales", "the October sales report", "a table to
   track my suppliers" and "a slide deck for Monday": it creates a Dashboard, a Report, a Sheet,
   and for the deck says there is no presentation format and offers a Report.
2. **Dashboard from the menu (US1.1, FR-008)**: New → Dashboard. It opens on "Sales overview" with
   your numbers, with no connection step. Compare Net sales and Orders with the CSV's known totals.
3. **Dashboard through the agent (US1.2, SC-002)**: "Add a tile showing units sold by category as
   a bar chart." The tile appears with a result in the chat's preview; open its details to see the
   query, period, last run, rows and duration.
4. **Filters and refresh (US3)**: change the date range to a custom week: only tiles that use the
   date range show the busy indicator. Pick one location. Press Refresh: "Updated" changes. Open
   the dashboard in a second browser as another member: filters there are independent.
5. **A failing tile (US1.5)**: ask the agent to add a tile with a query on a column that does not
   exist. That tile shows the dataset's explanation and **Fix with agent**; the others still draw.
6. **Edit (US4)**: Edit → drag a tile, resize it with Shift+arrow keys, change bars to a line,
   rename, Undo twice. Ask the agent to "split net sales by location": the details show the new
   query.
7. **Report (US2)**: New → Report → Generate. Every data block shows "As of … · October 2026".
   Ask the agent to "draft the summary from the figures". Import another CSV for the same month,
   reopen: the numbers are unchanged. Regenerate: a new edition shows the new numbers, the summary
   is flagged for review, and the first edition is still in the picker.
8. **PDF (US2.6)**: Export → PDF from a Report with a letterhead name and logo set: the PDF shows
   the letterhead, the as-of line, and the charts and tables as on screen. Export a Dashboard to
   PDF: tiles in two columns with the filter summary.
9. **Incomplete period (US2.7)**: generate a report for the current month: blocks note "Data is
   complete through <date>".
10. **Data turned off (FR-022)**: as the administrator, Connectors → Disable for organization.
    Reopen the workspace: the dashboard says the data is not turned on and shows no numbers; the
    report shows no editions. Enable again and reopen: both work, and the report's editions are
    back.
11. **Another organization (FR-021, SC-008)**: a member of organization B cannot open the
    workspace. Publish the dashboard as a blueprint and create it in B: it opens on the starter
    layout with B's data (or the "not turned on" state), with none of A's tiles or numbers.
12. **View-only share**: share the dashboard view-only with a member: they see the numbers as
    shared, a "Read-only copy" badge, and no Refresh.
13. **Schedule (US6)**: ask the agent to "regenerate this report on the first Monday of each month
    at 8:00 America/Toronto". A hook card appears, disabled; enable it. (To see it fire, ask for a
    one-off run two minutes ahead instead.)
14. **Upgrade (US5.5, SC-009)**: on an instance that had Docs and Slides, deploy this release. The
    New menu no longer lists them; an existing document and deck still open and accept edits.

## Verification record (2026-11-25)

Run on the implementation branch:

- **Automated**: `bundled-blueprints` 1,153 tests and its five type-check programs; `workshop-backend` unit (3,217) and integration (80) suites, including the ten kernel-seam invariants; `workshop-frontend` 2,308; `integration-tests` 289; `api-cli` 208; `pnpm lint` with the workspace build; the release golden manifest is unchanged.
- **Local instance** (`pnpm dev-server`, password account, so no organization and no retail data): the instance had Docs and Slides promoted from before, and after startup `list-output-formats` offered Sheet, Dashboard and Report only, while `get-blueprint format.document` still returned its record (scenario 14's menu half). `new-workspace-from-blueprint format.dashboard` and `format.report` created workspaces with no setup step; the gadgets returned their starter content, the "not turned on" state, their export formats, and refused a write query and `describeData` in plain language.
- **Browser** (the built `client.js` of each format under the sandbox's content security policy, fed by the real servers over a scripted month of sales): the starter dashboard with an added tile and a failing tile, light and dark themes, a filter change re-running tiles through `runTiles`, keyboard move and resize, the fix-with-agent hand-off, the off state, the report's latest view with a letterhead, and export mode (controls gone, one `open()` call, printed to PDF by Chromium).

Not run, because each needs a Clerk-enabled instance with retail data enabled and imported, or the Browser Rendering binding: manual scenarios 1–13 against real data, the platform's own PDF export of a gadget, a live schedule firing, and the agent choosing formats in a real chat.
