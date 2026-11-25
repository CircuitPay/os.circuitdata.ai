# Implementation Plan: Data-Focused Output Formats (Dashboards, Reports and Sheets)

**Branch**: `007-data-output-formats` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-data-output-formats/spec.md`

## Summary

Replace the deployment's bundled formats (Docs, Sheets, Slides) with Dashboard, Report and Sheets.
Dashboard and Report are new bundled blueprints whose Durable Object reads the organization's
retail dataset through `env.RETAIL_DATA` and renders saved queries as tiles and data blocks; both
share a new `data` gadget library (saved-query model, parameter binding, SVG charts). A small
kernel change lets a blueprint declare a binding that the workspace's own always-available
resource fills with no wiring, and lets the installer withdraw a format it promoted once the bundle
no longer ships it. Docs, Slides and the `pptx` library are deleted.

## Technical Context

**Language/Version**: TypeScript 6 (strict), es2022 gadget bundles, Node 26 for tooling

**Primary Dependencies**: Cloudflare Workers (Durable Objects, facets, Worker Loader), Cap'n Web
RPC, the `sync` and `ui` gadget libraries, `gatekeeper-retail`'s `RETAIL_DATA` binding. No new npm
dependency (gadget libraries may not have any); `commonmark` and `@types/commonmark` are removed.

**Storage**: each gadget's own Durable Object key-value storage (tiles, cached results, sections,
editions); overseer storage (`GadgetRecord.ambientBindings`); `AdminSettings` storage and the
`BLUEPRINTS` KV mirror (format curation)

**Testing**: vitest. `bundled-blueprints`: Node and jsdom projects with a stub of
`cloudflare:workers`. `workshop-backend`: unit tests and the workerd integration harness.
`workshop-frontend`: vitest + Testing Library.

**Target Platform**: Cloudflare Workers (workerd); gadget UIs in an opaque-origin sandboxed iframe
(`connect-src 'none'`, `img-src data:`)

**Project Type**: pnpm monorepo: kernel packages plus bundled gadget blueprints

**Performance Goals**: a dashboard of 8 tiles shows cached results in under 2 seconds and
completes a refresh in under 10 seconds for one location with a year of data (SC-005); a monthly
report generates in under 30 seconds

**Constraints**: no network, npm or CSS files inside a gadget; every read is one observation
record, so no polling; results capped at 500 rows and 100 KB per tile; the dataset's 100 bound
parameters per query; browser-mode export has a 30 second budget; kernel diffs small
(constitution I)

**Scale/Scope**: 40 tiles per dashboard, 60 sections and 24 editions per report; the spec 006
target of 10 locations × 3 years. About 2 new blueprints, 1 new library, ~10 kernel touch points,
~8 frontend touch points, 2 blueprints and 1 library deleted.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 (below).*

| Principle | Status | Notes |
|---|---|---|
| I. Kernel bar | Pass | One new `BlueprintBinding` variant and one `GadgetRecord` field, both doc-commented. Binding reuses `bindWorkpiece`; retirement reuses `#mutateAdminConfig`, the featured mirror and `promotedFormatBlueprints`. No mirrored RPC interfaces, no casts. Kernel work is its own commit group (tasks Phase 2). Organization branding for gadgets was *not* added because it would widen `GadgetHost` (research R11). |
| II. Capability security | Pass | An ambient declaration grants nothing: the capsule exists only through tenant-administrator or operator configuration and is minted through the existing `#assertResourceEnabled` path; the gatekeeper asserts nothing. Reads stay observations through the existing `ObservationGate`. No credential reaches a gadget. Tenancy stays the kernel's decision (`Overseer.open`, observer admission); the gadget makes none from client-reported values. Invariants 3 and 8 of `contracts/kernel-seam.md` are refusal tests. |
| III. RPC discipline | Pass | No new RPC interface in the kernel. Gadget subscribers are disposed by the `sync` library's registry. No React state holds a stub. |
| IV. Observability | Pass | The one new log (`ambient.binding.failed`) carries ids only, through the overseer's module logger. Query text and rows are never logged by the kernel; the gadget surfaces a query's error only to its own viewers. |
| V. Frontend conventions | Pass | Frontend edits (landing page, card, suggestions, panel copy) load the `frontend-conventions` skill and use Kumo components already on those screens. Gadget UIs are not React and are outside this principle; they follow the bundled-blueprint conventions. |
| VI. Tests | Pass | Refusal tests for assignment of an ambient binding, binding without a capsule, cross-tenant open with a bound gadget, write queries, hostile parameters, mutations in snapshot mode. The changed paths are exercised in workerd by the backend suite and by a manual run (quickstart). |
| VII. Config and release | Pass | No Worker config, binding or migration changes. The bundled-blueprint generated module is rebuilt by the existing task; the release golden manifest is unaffected (verified in tasks Phase 8). |

**Post-design re-check**: unchanged. The design adds no parallel mechanism: ambient declarations
become ordinary edges, hints use the existing `FormatCuration.agentHint`, schedules use the
existing Scheduled Tasks hook, PDF uses the existing browser-mode export.

## Project Structure

### Documentation (this feature)

```text
specs/007-data-output-formats/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── kernel-seam.md
│   ├── data-library.md
│   ├── dashboard-gadget.md
│   └── report-gadget.md
├── checklists/requirements.md
└── tasks.md                      # /speckit.tasks
```

### Source Code (repository root)

```text
packages/bundled-blueprints/
├── blueprints/
│   ├── workspace-dashboard/      # NEW  blueprint.json, files/{README.md,client.ts,server.ts,lib/*}, __tests__/
│   ├── workspace-report/         # NEW  same layout
│   ├── workspace-sheets/         # unchanged
│   ├── workspace-docs/           # DELETED
│   └── workspace-slides/         # DELETED
├── libraries/
│   ├── data/                     # NEW  client.ts, server.ts, src/*, __tests__/*, README.md
│   ├── sync/, ui/, zip/          # unchanged (READMEs reworded)
│   └── pptx/                     # DELETED
├── src/manifest.ts, generate.ts  # optional agentHint
└── __tests__/stubs/cloudflare-workers.ts   # adds the `restore` symbol

packages/workshop-shared/src/api.ts                    # BlueprintBinding "ambient" variant, doc edits
packages/workshop-backend/src/
├── storage-schema/overseer-storage.ts                 # GadgetRecord.ambientBindings
├── overseer.ts                                        # createGadget, initializeFromBlueprint, fetchBlueprint,
│                                                      # bindAmbientDeclarations, ensureAmbientCapsules,
│                                                      # unbind/rename, collectBindingMetadata, describeBindingKind
├── agent.ts                                           # formatMissingBlueprintBindings, createGadget tool, one prompt example
├── admin-config.ts                                    # requiresSetup
├── admin-settings.ts                                  # retire dropped formats, seed agentHint
└── server.ts                                          # refuse assigning an ambient binding
packages/workshop-backend/__tests__, __integration__   # new and re-keyed tests

packages/workshop-frontend/src/
├── BlueprintLandingPage.tsx, components/BlueprintCard.tsx          # ambient bindings shown, never picked
├── components/AppShell/HomeTaskSuggestions.tsx                     # dashboard and report suggestions
└── components/format/AdminFormatsPanel.tsx                         # example copy

packages/integration-tests, packages/workshop-evals, packages/api-cli   # tests and one eval re-keyed
docs/blueprints.md, README.md, packages/bundled-blueprints/README.md, libraries/*/README.md
```

**Structure Decision**: the existing monorepo layout. New gadget code lives beside Sheets in
`packages/bundled-blueprints/blueprints/`, shared gadget code in `libraries/data/`, and the kernel
change in the files that already own blueprint bindings and format curation. No new package.

## Phases

- **Phase 0 (done)**: `research.md`, decisions R1–R15.
- **Phase 1 (done)**: `data-model.md`, `contracts/`, `quickstart.md`.
- **Phase 2**: `tasks.md` (`/speckit.tasks`). Order: kernel seam and removal first (they unblock
  everything and are reviewable alone), the `data` library, then Dashboard and Report in parallel,
  then curation, docs and verification.

## Spec adjustments made during planning

Planning found four places where the spec asked for something the platform does not have a
mechanism for. Each is recorded in `spec.md` (Clarifications, session 2026-11-25, planning) and in
research:

| Spec item | Was | Now | Why |
|---|---|---|---|
| US4 scenario 4 | a view-only member can filter and refresh | a view-only share is a frozen copy; `use` collaborators can do everything | view-only is a kernel snapshot with an empty env (R4) |
| FR-022 | access loss takes effect on the next read | on the next read after the workspace is next opened | the kernel removes a disabled capsule at open, as spec 006 does for chats (R4) |
| FR-023 | a published blueprint carries tiles and queries | it carries the format's code and starter layout, never a person's tiles, results or editions | a blueprint is code, never storage (research, known limits) |
| FR-028 | PDF carries the organization's branding | PDF carries the report's own letterhead (name, logo, accent) | branding does not reach gadgets and adding it would widen the kernel API (R11) |

## Complexity Tracking

No constitution violations to justify.
