# Research: Data-Focused Output Formats (Dashboards, Reports and Sheets)

Phase 0 of `plan.md`. Each entry is a decision with its rationale and the alternatives weighed.
Everything marked *read* was read in the code on 2026-11-25; nothing here was assumed from the
earlier exploration draft, which this file replaces.

Abbreviations: `BB` = `packages/bundled-blueprints`, `WB` = `packages/workshop-backend`,
`WS` = `packages/workshop-shared`, `WF` = `packages/workshop-frontend`.

## What exists today (read)

- Three bundled blueprints (`BB/blueprints/workspace-{docs,sheets,slides}`), each `client.ts` +
  `server.ts` + `lib/*.ts` + `README.md`, bundled by esbuild into one `client.js` and one
  `server.js`. All declare `"bindings": {}`. All are legacy UIs (no default export; globals
  `gadget`, `RpcTarget`, `RpcStub`).
- Gadget libraries `ui` (client), `sync` (client + server), `zip` (server), `pptx` (server, Slides
  only). A blueprint may import nothing else: no npm, no CSS files, no dynamic imports.
- A gadget's server is a Durable Object facet loaded with `env = { GADGET, GIT, ...its own binding
  edges }`, `globalOutbound: null` (`WB/src/overseer.ts` `getEnvForLoader`). The UI runs in an
  opaque-origin iframe with `connect-src 'none'` and `img-src data:`.
- A gatekeeper binding in a gadget's env is already the session: `await env.RETAIL_DATA.run(sql,
  params)` works with no setup. Retail reads authorize with a baseline scope, so they never wait for
  approval; each read writes one observation record.
- `RETAIL_DATA` reaches a workspace as an unnamed `tenantAmbient` capsule, folded into each chat's
  env. No code binds an ambient capsule into a gadget, a blueprint cannot declare such a binding
  (`BlueprintBinding` has `gatekeeper | aiModel | agentSpawner`), and blueprint export skips edges
  that target one.
- A blueprint dropped from the bundle keeps its KV record, its `AdminConfig.formats` entry and its
  featured entry (`WB/src/admin-settings.ts`, comment above `#promoteBundledFormats`).
- PDF export of a gadget is "browser mode": the kernel loads the gadget's own client in a headless
  browser with print media and `globalThis.gadgetExportFormatId` set. `packages/pdf-renderer` is
  unrelated (it rasterizes PDFs for the Google gatekeeper).
- A gadget learns nothing about who is calling it. Roles are the kernel's: `build`, `use` (full RPC
  access to the gadget), and `view` (a static snapshot facet with `env: {}`).

## R1. The format set

**Decision**: `BB/blueprints/` holds exactly `workspace-dashboard` (`format.dashboard`),
`workspace-report` (`format.report`) and `workspace-sheets` (`format.spreadsheet`, unchanged).
`workspace-docs`, `workspace-slides`, `libraries/pptx` and the `commonmark` dev dependencies are
deleted. `OUTPUT_ICONS` keeps `fileText` and `presentation`.

**Rationale**: the user asked for this set. Existing documents and decks copy their code into the
workspace's own git store at creation and carry their label and icon on the gadget record, so they
run without the blueprint (FR-003); the icons must stay for them to keep drawing.

**Alternatives**: keep Docs/Slides installed but unpromoted (rejected: the constitution's fork rule
is to remove obsolete code, and the user chose replacement).

## R2. Retiring a dropped bundled blueprint on upgrade

**Decision**: the installer withdraws what it promoted. After `#promoteBundledFormats`,
`AdminSettings` computes `promotedFormatBlueprints` minus the current bundle's ids and, for each,
removes its `AdminConfig.formats` entry and its featured-mirror entry, then drops the id from
`promotedFormatBlueprints`. The blueprint's KV record and release pack are left in place.

**Rationale**: `promotedFormatBlueprints` already records exactly the promotions the installer made,
which is what the existing comment says a withdrawal would need. Leaving the record keeps "update
from blueprint" and users' library entries resolving, and deletes nothing a person made. After
this, Docs and Slides are in neither the New menu, the agent's every-turn format note nor
`listBlueprints` (US5 scenario 5), and an operator may still promote the orphan by hand (FR-006).

**Alternatives**: also delete the KV record and R2 pack (rejected: destructive, and a pending chat
gadget or library entry may still name the id); a hard-coded list of retired ids (rejected: a
deployment using `BUNDLED_BLUEPRINTS_DIR` has its own set).

## R3. Connecting a gadget to the organization's data with no wiring (FR-008)

**Decision**: one new `BlueprintBinding` variant, `{ type: "ambient"; vendorId: string }`: "filled
by the workspace's own always-available resource of this vendor, never by a person". The kernel
changes are:

1. `GadgetRecord.ambientBindings?: Record<bindingName, vendorId>`, copied from the blueprint when a
   gadget is created from it (New menu and agent paths).
2. One reconcile, `bindAmbientDeclarations()`: for every gadget with a declared name that has no
   edge, bind it (`bindWorkpiece`) to the workspace's `ambient` or `tenantAmbient` capsule of that
   vendor, if there is one. It runs when a gadget is created from a blueprint and at the end of
   `ensureAmbientCapsules()`.
3. Blueprint export emits the variant for an edge whose target is an ambient capsule, instead of
   dropping it.
4. `requiresSetup` ignores ambient bindings; the agent's blueprint notes and the landing page say
   "connected automatically".

See `contracts/kernel-seam.md`.

**Rationale**:

- It reuses the existing edge mechanism end to end: env building, the observer scope
  (`#gadgetReach`), restart-on-widening, the Connections UI and unbind all work unchanged, because
  the result is an ordinary edge.
- The record field is what lets a dashboard reconnect after the organization turns the data off
  and on again: capsule removal deletes every edge to it and re-enabling mints a new capsule id.
- Capability check (constitution II): the declaration grants nothing by itself. The capsule exists
  only because the tenant's administrator (or the operator's mode) enabled it, it is already in
  every chat of the workspace, and the gadget that receives it is sandboxed with no network. A
  gatekeeper still cannot assert its own ambience.
- A gadget the agent creates in a chat gets the edge at creation, so the preview shows data before
  the member accepts the changes.

**Alternatives**:

- Resolve declared names dynamically inside `visibleBindings` with no stored edge (rejected: 15
  call sites, including unbind and rename, would see edges that are not in storage).
- Leave it to the agent's `setGadgetBinding` (rejected: the New menu has no agent, so FR-008 fails
  there).
- Auto-fill ordinary `gatekeeper` bindings from a capsule of the same vendor (rejected: silently
  changes what an existing binding kind means, and `requiresSetup` could not tell them apart).

## R4. Whose access; what happens when it goes away (FR-021, FR-022)

**Decision**: access is decided by the kernel at admission, as spec 006 built it. The gadget adds
three behaviours of its own:

- `env.RETAIL_DATA` absent while `env.GADGET` is present means the data is off for this workspace:
  the server returns `data.status = "off"`, purges cached results (Dashboard) and withholds
  editions (Report) until the binding returns.
- `env.GADGET` absent means the code is running as a view-only snapshot (`env: {}`): it serves the
  copied state read-only and never queries.
- Any call on the binding that fails with a connection-removed error is treated as "off".

**Rationale**: `Overseer.open` refuses anyone outside the owner's tenant before anything else, and a
collaborator on a gadget that reaches the capsule is verified against their own tenant's dataset.
The gadget cannot do better: it has no viewer identity. The kernel removes a disabled capsule at
the workspace's next open, exactly as spec 006 invariant 4 states for chats, so "next read" in
FR-022 means "next read after the workspace is next opened".

**Consequence recorded in the spec**: a view-only share is a frozen copy by kernel design, so its
holder sees the dashboard as shared and cannot refresh; `use` collaborators can do everything the
gadget offers, including edits. US4 scenario 4 is reworded to match.

**Alternatives**: a per-read tenant check in the retail gatekeeper (a spec 006 change; out of scope
and tracked as a follow-up); per-viewer authorization in the gadget (impossible without identity).

## R5. A shared `data` gadget library

**Decision**: `BB/libraries/data/` with `server.ts` (saved-query model, parameter binding, running
against `RetailData`, typing and caps, period resolution) and `client.ts` (formatting, SVG charts,
tables, the accessible summary, shared CSS). Dashboard and Report import it; the build inlines it.
See `contracts/data-library.md`.

**Rationale**: two formats need one meaning for "a query, its parameters, its result, how it
renders". One implementation of parameter binding is one place to get injection right. Libraries
are not kernel code.

**Alternatives**: duplicate per blueprint (rejected, above); a library per concern (rejected: a
client entry may not import a server entry, and one library with two entries already separates
them).

## R6. The saved query

**Decision**: two kinds.

- `metric`: a standard metric name, optional `groupBy`, optional previous-period comparison. Runs
  `RetailData.metric()`. Standard figures always use this kind (FR-010).
- `sql`: one read-only `SELECT`/`WITH` statement with **named** parameters (`:from`, `:to`,
  `:locations`, and literals the query declares). The library tokenizes the text (skipping string
  literals and comments), replaces each name with `?` placeholders and builds the positional
  parameter array. `:locations` expands to one `?` per selected location id. Runs
  `RetailData.run()`.

**Rationale**: values never enter the query text (FR-012, SC-007): only `?` characters are
inserted. The retail SQL guard refuses anything that is not a single read; the library also refuses
text that does not start with `SELECT` or `WITH` before sending it (FR-011), so a refusal costs no
round trip.

**Alternatives**: positional `?` in saved text (rejected: a multi-select filter needs a variable
number of placeholders); passing a JSON array with `json_each` (rejected: table-valued functions
are outside the guard's allow-list).

## R7. Labels for ids

**Decision**: `metric()` groups by `location_id` and `product_id`. The library resolves them to
names with one extra read each: all locations once per run (also the filter's option list), and
products only for the rows that survive the tile's `limit`.

**Rationale**: keeps standard figures on the shared definitions while showing names. One read per
dimension, not per row.

## R8. Charts

**Decision**: hand-written SVG string builders in the `data` library: single value with
comparison, line, area, bar (grouped and stacked), plus an HTML table and a text block. Every chart
has `role="img"`, a generated text summary and a "show as table" alternative (FR-032).

**Rationale**: no npm and no external fetch are available to a gadget, five chart types are needed,
and SVG prints as rendered into the PDF export. Pure string builders are testable in Node.

**Alternatives**: lift the Sheets chart code (rejected: it is entangled with the grid and its
ranges); bundle a charting package (impossible: the build rejects `node_modules` inputs).

## R9. Caching and freshness (FR-017)

**Decision**: the Dashboard stores each tile's last result for the dashboard's default filters,
plus up to eight recent results per tile for other filter values, each capped at 500 rows and
100 KB. Opening returns cached results at once; the client refreshes tiles older than the
freshness setting (default 15 minutes) in the background. There is no polling.

**Rationale**: every read is one observation record in the workspace's action log, and in a chat
preview one chat note. A KPI with a comparison is two reads. Polling would flood both.

## R10. Reports: structure, editions, review flags

**Decision**: a report is an ordered list of sections (`heading`, `text`, `data`). **Generate**
resolves the report's period, runs every data section and stores an immutable **edition**: a copy
of every section as it was, each data block's result, the as-of time and the period. The page shows
the current text with the latest edition's results, or any earlier edition as it was. At most 24
editions are kept; a pinned edition is never pruned.

A text section is flagged "review" when a new edition's results differ from the edition the text
was last written or confirmed against, and the text contains a digit.

**Rationale**: immutability by copy (FR-025) needs no versioning scheme. The flag rule is a
heuristic: the gadget cannot know which sentence states which number, so it flags text that states
any number when any number changed, and a person or the agent clears it.

**Alternatives**: editions as git commits (rejected: content is storage, not code); placeholders in
text bound to tiles (rejected: turns narrative into a template language).

## R11. PDF export and letterhead (FR-028)

**Decision**: both formats export PDF in browser mode from their own client with `@media print`
styles. A Report prints the edition being viewed from stored results, never re-querying. The
letterhead (organization name, logo as a data URL, accent colour) is held by the report and set
once by a person or the agent.

**Rationale**: the export page runs with a 30 second budget against the same Durable Object, so it
must not depend on live reads. Organization branding does not reach a gadget today: `GadgetHost`
has one method and no branding, and adding it would mean a new shared API member, a second
implementation in the export page and a tenant lookup in the overseer, for one cosmetic field. The
kernel bar (constitution I) says not to.

**Recorded in the spec**: FR-028 now says "the report's letterhead" rather than "the organization's
branding". Feeding tenant branding to gadgets is a follow-up for whoever owns spec 003.

## R12. Scheduled regeneration (US6, FR-029)

**Decision**: the Report's server defines `[restore](params)` for `{ type: "regenerate",
monthly?: "first" }`, returning a `ScheduledTaskHook` whose `onSchedule` generates an edition,
idempotent on `runId`. The agent registers it through the existing Scheduled Tasks binding in the
chat (`env.SCHEDULER.calendarAt(...)`) as that gatekeeper's contract describes, and a person
enables the hook. The gadget needs no scheduler binding. "First Monday of the month" is a weekly
Monday rule plus `monthly: "first"`, which makes the callback skip unless the day is 1–7.

**Rationale**: this is exactly the mechanism the scheduler documents, including the
person-enables rule, with no new code outside the gadget. The scheduler has no monthly rule.

## R13. Agent guidance (FR-031)

**Decision**: three places, none a kernel prompt rule:

- each blueprint's `description` (shown by `listBlueprints`) and `files/README.md` (the API the
  agent reads);
- a new optional `agentHint` in `blueprint.json`, which the installer writes into the format's
  curation entry when it first promotes it, so the every-turn format note says when to use each
  format, and the Report's hint says the deployment has no presentation format;
- one reworded example in the system prompt ("a doc, a deck, a tracker").

**Rationale**: `describeStandardFormats()` prints only the noun, the id and the admin's hint, and
the hint defaults to empty. Seeding it from the manifest uses the existing curation field and stays
editable by the operator. An upgraded deployment keeps the hint its Sheets entry already has.

## R14. UI entry style, theme and hand-off to the agent

**Decision**: both clients are legacy UIs like the existing three (globals, top-level await as the
export's ready signal). They follow `prefers-color-scheme` with their own CSS variables. "Fix with
agent" shows a ready-made request and copies it to the clipboard for the member to paste into the
chat.

**Rationale**: a `main(gadget, host)` UI must import `capnweb`, which the bundled build rejects, and
the only thing `host` offers is opening a spawned agent's chat. A gadget cannot open the chat
composer or prefill it.

## R15. Tests (constitution VI)

**Decision**:

- `BB`: Node tests for the library (parameter binding with hostile values, read-only refusal,
  period resolution, chart output and summaries), server tests for both gadgets over in-memory
  storage with a scripted `RETAIL_DATA` (starter content, caching, off/empty/snapshot states,
  edition immutability, retention, review flags, schedule idempotency), jsdom tests for both
  clients (render, filters reach the server as values, off state hides results).
- `WB`: unit tests for the reconcile, export, `requiresSetup` and retirement; an integration test
  that instantiates a blueprint declaring an ambient binding in a tenant with and without the
  account, and re-enables it.
- Existing tests keyed on `format.document` move to `format.spreadsheet` or to the new ids.

## Known limits carried into the plan

- Turning the data off takes effect for a gadget at the workspace's next open (R4).
- A blueprint carries code, never storage: a published dashboard brings the format and its starter
  layout, not the tiles a person built. FR-023 is reworded to say so.
- Local development has no Browser Rendering binding unless configured, so PDF export is verified
  in the kernel's existing export tests and on a deployed instance.
- A chat that started before the organization enabled retail data does not gain `RETAIL_DATA`
  (`prepareChatBindings` adds later capsules only for `ambient`). This is a spec 006 defect; gadgets
  are unaffected because the reconcile in R3 binds them on open.
