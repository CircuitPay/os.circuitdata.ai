# Implementation Plan: Data Page (Upload, Map and Browse Retail Data)

**Branch**: `008-data-page` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-data-page/spec.md`

## Summary

Make **Data** a permanent navigation item backed by a Workshop route `/data` that shows the
organization's Data state and lets an administrator turn it on in place, then hosts the existing
Data app there. In the Data app, replace Overview with a **Home** built around Upload a CSV, add a
**basic mapping** panel in front of the existing mapping editor, and add a **Browse** tab backed by
three new read-only methods on the Data app capability. No kernel change.

## Technical Context

**Language/Version**: TypeScript 6 (strict); React 19 in the Workshop and the Data app

**Primary Dependencies**: Kumo UI, Phosphor icons, TanStack Router (Workshop), Cap'n Web, Durable
Objects with SQLite (`gatekeeper-retail`)

**Storage**: the dataset's SQLite (two indexes per browsable table, added by a migration); nothing
else new

**Testing**: vitest: workerd pool for `gatekeeper-retail` server code, jsdom for the Data app and
the Workshop, Node for pure helpers

**Target Platform**: Cloudflare Workers; the Data app in the Workshop's sandboxed app frame

**Project Type**: pnpm monorepo (Workshop frontend + one gatekeeper + one bundled blueprint string)

**Performance Goals**: a page of 100 rows in under 2 s for one location with a year of data; next
page under 1 s (SC-005)

**Constraints**: browse SQL is built only from fixed definitions with bound values; the scan limit
(`RETAIL_SCAN_ROW_LIMIT`) governs unfiltered reads of large tables; the app frame has no network
except its capability

**Scale/Scope**: 7 browsable tables; ~3 Workshop files new, ~3 changed; ~10 Data app files new, ~5
changed; 1 server module new, 3 changed

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1.*

| Principle | Status | Notes |
|---|---|---|
| I. Kernel bar | Pass | No change to `workshop-backend` or `workshop-shared`. Turning Data on reuses `TenantGatekeepersApi.enable()`; hosting reuses `getGatekeeperApp()`. |
| II. Capability security | Pass | The administrator check stays in the kernel, per call. The browse methods sit behind `RetailAppApi`'s per-call membership re-read and read only the tenant's own dataset through its public (masked) views. No caller-supplied SQL; all values bound. The new methods are the app capability, not the agent session, so no observation model changes. |
| III. RPC discipline | Pass | New methods on an existing `@validateRpc()` class; the Workshop holds the `TenantGatekeepersApi` stub wrapped in state and disposes it. |
| IV. Observability | Pass | `browse.rows` logs table, counts and duration only. |
| V. Frontend conventions | Pass | Both React surfaces load the `frontend-conventions` skill; Kumo components; accessible grid, paging announcements and labelled pickers (FR-029). |
| VI. Tests | Pass | Refusal tests: non-administrator cannot turn Data on (button absent, kernel already tested); hostile search/filter values; unknown tables and columns. Changed paths exercised in workerd and jsdom, and the built app in a browser. |
| VII. Config and release | Pass | No Worker config, binding or migration-tag change. The dataset's own schema migration is versioned in code as before. |

**`write-gatekeeper` skill**: its API-review stop applies to a gatekeeper's agent-facing session
API. This feature leaves `src/types.d.ts` untouched and adds member-facing methods to the Data app
capability; the contract in `contracts/data-app-api.md` is that review.

## Project Structure

### Documentation (this feature)

```text
specs/008-data-page/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── workshop-data-page.md
│   ├── data-app-api.md
│   └── data-app-ui.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/workshop-frontend/src/
├── features/data/dataArea.ts, DataPage.tsx (+ tests)      # NEW
├── routes/data.$.tsx                                      # NEW
├── routes/gatekeepers_.$appId.$.tsx                       # redirect retail → /data
├── components/AppShell/Sidebar.tsx, components/Header.tsx # Data item; skip retail in app list
└── features/tenant-gatekeepers/TenantGatekeepersSection.tsx  # refresh Data state after toggling

packages/gatekeeper-retail/
├── src/app-api-types.ts, src/app-ui.ts                    # browse types and methods
├── src/dataset/browse.ts (NEW), dataset-do.ts, schema.ts  # browse queries; index migration
├── __tests__/browse.test.ts                               # NEW
└── app/
    ├── App.tsx                                            # Home and Browse tabs, cross-panel navigation
    ├── home/HomePage.tsx, uploadCsv.ts (+ tests)          # NEW (absorbs OverviewPage content)
    ├── imports/BasicMapping.tsx, basicFields.ts (+ tests)# NEW
    ├── imports/ImportView.tsx, ImportsPage.tsx, RunReport.tsx  # basic panel first; request prop; rows link
    └── browse/BrowsePage.tsx, RowGrid.tsx, RowDetailView.tsx (+ tests)  # NEW

packages/bundled-blueprints/blueprints/workspace-{dashboard,report}/files/client.ts  # "not turned on" wording
```

**Structure Decision**: existing packages only; the entry and its states live in the Workshop, the
data features in the Data app that already owns imports.

## Complexity Tracking

No violations.
