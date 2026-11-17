# Research: Data-Focused Output Formats

Exploration notes behind `spec.md`. Q1 is answered (the source is the retail data layer, spec 006);
Q2 and Q3 remain, and the decisions below are recommendations until they are answered.

> **Update 2026-11-17**: D2 below was written before the data layer was decided. The first (and for
> now only) source is spec 006's retail dataset binding, whose surface is `describe()`, `run()` and
> `metric()` (006 research D4). The Supabase notes are kept as the model for a later SQL adapter.
> Stage 1 below therefore builds the `data` library against the retail binding, not Supabase.

## What exists today

- **Bundled blueprints** (`packages/bundled-blueprints/blueprints/`): `workspace-docs`
  (`format.document`), `workspace-sheets` (`format.spreadsheet`), `workspace-slides`
  (`format.slides`). Each is a `client.ts` (iframe UI) + `server.ts` (Durable Object store) +
  `lib/protocol.ts`, built on the shared `ui` and `sync` libraries; Slides also uses `pptx` for
  export. All three declare `"bindings": {}`: none reads a data source at runtime.
- **Slides "connected charts"** in the starter deck are a promise, not a feature: the agent reads
  data in chat and draws an SVG/blocks once.
- **Output kinds** are presentation-only and come from the closed `OUTPUT_ICONS` set in
  `workshop-shared/src/api.ts`, which already includes `chartBar`, `table` and `notebook`. New formats
  need **no kernel change** to declare themselves.
- **Data gatekeepers**: `gatekeeper-supabase` exposes `SupabaseProject.getDatabase()` with read-only
  `query()` (logged as an observation) and approval-queued `execute()`. Rows come back as JSON;
  `numeric`/`bigint` and timestamps arrive as strings with no column-type metadata, so the formats must
  type columns themselves. `gatekeeper-mcp-portal` can front arbitrary tools; `gatekeeper-cloudflare`
  has observability reads. There is no warehouse (BigQuery/Snowflake) gatekeeper yet.
- **Scheduling**: `gatekeeper-scheduler` registers persistent callbacks; hooks start disabled and the
  user enables them in Connections. Reports reuse this rather than adding a timer.
- **Blueprint bindings**: a blueprint records each binding's *shape* (vendor, resource pattern),
  never the connection. On instantiation the user assigns their own account; on the agent path, the
  agent wires bindings with `setGadgetBinding`.

## D1. Where the data work lives: a shared `data` gadget library

**Decision**: add `packages/bundled-blueprints/libraries/data/` holding the saved-query model,
result typing/caching, the source adapter interface, and the chart/table renderers. Dashboard,
Report and Slides import it; the build inlines it, as it does `ui`/`sync`/`pptx`.

**Rationale**: three formats need identical semantics for "a query, its parameters, its result, how
it renders". A library keeps that one implementation, and the libraries mechanism already exists for
exactly this. It is not kernel code, so the review bar is the gatekeeper/UI one.

**Alternatives**: a single "data" blueprint the others embed (gadgets cannot embed each other's UI
cleanly); duplicating per blueprint (three copies of the parameter-binding rule is three chances to
get injection wrong).

## D2. The source contract (Q1)

**Recommendation**: a narrow interface inside the library:

```
describe(): tables and columns with types
run(sql, params, { maxRows, timeoutMs }): { columns: [{ name, type }], rows, truncated }
```

with one adapter per gatekeeper. Ship the **Supabase** adapter first (it exists, it is SQL, reads are
already observations and writes already approval-gated). A Postgres-wire/Hyperdrive, D1, BigQuery or
Snowflake gatekeeper later is one adapter.

**Open question for Q1**: is Supabase actually the data the target customers have? If the real data
is in a warehouse, the first deliverable is arguably a warehouse gatekeeper, not the dashboard.

**Checked**: Supabase's `query(sql, params?)` binds positional `$1, $2, …` parameters and runs as a
restricted read-only role, and `listTables`/`describeTable` cover `describe()`. So FR-006 (reads only)
and FR-007 (bound parameters) are enforced by the gatekeeper itself for the first source, with the
adapter's own checks as a second line. Any future adapter must offer the same two guarantees or
not be accepted.

**Non-SQL sources** (MCP tools, REST APIs): possible later as adapters that map a tool call + JSON path
to a table. Not in the first release: "query text" stops being reviewable in a uniform way.

## D3. Charts inside the sandbox

**Decision**: render charts as SVG produced by library code bundled into the gadget.

**Rationale**: gadgets cannot fetch scripts (the Slides README: "The sandbox prohibits modal dialogs
and external fetches"). SVG also flows into the existing exporters: PDF via the print renderer;
PowerPoint needs native shapes, because `pptx` currently **omits** SVG blocks, so the library emits
a chart description that both an SVG renderer and a `pptx` adapter (bars/lines as native shapes, or a
rasterized PNG fallback) can consume.

**Options to evaluate in `/speckit.plan`**: a small hand-rolled renderer for the five chart types in
FR-011 (predictable output, easy pptx mapping), versus bundling a library such as a trimmed
Vega-Lite/Observable Plot (more chart types, larger bundle, harder native pptx export). Leaning
hand-rolled for v1 because pptx fidelity is a success criterion.

## D4. Whose access a shared dashboard uses (Q2)

A binding belongs to the gadget, and the gadget's server runs reads with it. So when a dashboard is
shared, any viewer whose action causes a read is reading with the **owner's** connection. That is
the same as sharing the data the queries can reach, possibly more than the tiles show if viewers can
change filters.

| Option | Pros | Cons |
| --- | --- | --- |
| A. Live, owner's access | Always current; simplest | Sharing = delegating read access; filter changes are new reads on the owner's behalf |
| B. Snapshot; owner/editors refresh | Viewers see exactly what the owner saw; no delegated reads | Viewers' filters only work over cached results (or are disabled) |
| C. Viewer brings own connection | Cleanest security | Most viewers won't have one; breaks "send a dashboard to my manager" |

**Recommendation**: B by default, A as an explicit owner choice when sharing ("viewers can refresh
using my connection"), consistent with the capability rule that delegation is always an explicit user
act. Filters in mode B apply to cached results only when the cached query was run unfiltered at the
needed grain; otherwise they are disabled for viewers.

## D5. Notebooks (Q3)

**Recommendation: defer.**

- The Workshop chat already provides the exploratory loop: the agent runs `executeCode`, reads
  sources as observations, and shows results. A notebook gadget would be a second exploration surface
  competing with the main one.
- Code cells would mean running user/agent-authored code inside a gadget against a live binding: a
  second execution sandbox to secure and explain. Query + note cells only would be safe but then it
  is close to a Report with visible queries.
- The durable value of a notebook (reproducible, re-runnable, shareable) is covered by "a Report whose
  data blocks show their queries" plus regeneration.

**Cheap middle ground if wanted later**: a "show your work" mode on Reports that lists each data
block's query in order with its output, which is most of a query-only notebook for little extra.

**Revisit if** users are analysts who need to keep and rerun multi-step analyses outside chat, or if
chat-to-artifact export ("save this analysis") becomes a frequent request.

## D6. Reports vs extending Docs

**Decision**: a separate Report blueprint, sharing the `data` library, rather than adding data blocks
to Docs.

**Rationale**: Docs is a markdown document with live collaborative editing; Reports need immutable
editions with as-of times, regeneration and retention. Bolting editions onto Docs would change Docs'
model for every user. A Report can still reuse Docs' markdown library for its narrative sections.

**Alternative**: data blocks in Docs as live (non-edition) charts. Possible later, cheap once the
library exists; not needed to be data focused.

## D7. Agent guidance

Formats are picked by the agent from the deployment's curated list. The system guidance should say:
"for anything computed from connected data that should stay current, use Dashboard; for a dated
deliverable, use Report; use Slides for presenting, adding data blocks rather than drawn charts."
This lives in admin agent instructions / format descriptions, not kernel code.

## Suggested delivery stages (for `/speckit.plan` to refine)

1. `data` library: source contract, Supabase adapter, parameter binding, result typing and caps, SVG renderers, tests (injection, mutating-query refusal, Supabase type coercion).
2. Dashboard blueprint: grid, tiles, saved queries, cache, refresh, filters, agent API (Stories 1–3).
3. Sharing mode (Q2) and revocation behaviour; tenant isolation tests.
4. Slides data blocks + pptx/PDF export of charts (Story 5).
5. Report blueprint with editions, PDF export, scheduled regeneration (Story 4).
