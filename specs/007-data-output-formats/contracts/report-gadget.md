# Contract: the Report gadget (`format.report`)

`packages/bundled-blueprints/blueprints/workspace-report/`. Built on the `data`, `sync` and `ui`
libraries. Every public method of `Gadget` is callable by the iframe and by the agent;
`files/README.md` documents the agent-facing ones.

## `blueprint.json`

```json
{
  "$comment": "output.id is \"document\" on purpose: it is the grouping key on the Outputs page, where reports file alongside documents made before this format existed.",
  "blueprintId": "format.report",
  "title": "Workspace Reports",
  "description": "Use for a written, dated deliverable built from the organization's retail data: headings, narrative, and tables and charts frozen as of the day it was generated. Regenerate for fresh numbers; earlier editions stay readable. Exports to PDF.",
  "agentHint": "Use for a written or dated deliverable (for example a monthly sales report) and for any request for a document. This deployment has no slide or presentation format: offer a Report instead.",
  "output": { "id": "document", "noun": "Report", "plural": "Reports", "icon": "fileText" },
  "author": { "type": "user", "name": "Circuit", "id": "formats@circuitdata.ai" },
  "revision": 1,
  "created": "2026-11-25T00:00:00.000Z",
  "version": 1,
  "lastUpdated": "2026-11-25T00:00:00.000Z",
  "bindings": {
    "RETAIL_DATA": {
      "title": "Retail data",
      "description": "Your organization's sales, products, customers and inventory. Connected automatically when your organization has turned Data on.",
      "type": "ambient",
      "vendorId": "retail"
    }
  }
}
```

## Files

```
files/README.md          agent-facing API and rules
files/client.ts          the UI (legacy entry)
files/server.ts          Gadget (Durable Object, [restore] for schedules) and ExportHandler
files/lib/protocol.ts    types shared by both sides
files/lib/starter.ts     the "Monthly sales report" starter sections
files/lib/editions.ts    building an edition, comparing results, review flags, retention
__tests__/server.test.ts, editions.test.ts, client.test.ts
```

## Stored state

| Key | Value |
|---|---|
| `meta` | `{ revision, title, period: DateRangeFilter, locations: number[], letterhead: Letterhead, sectionOrder: string[], editions: EditionSummary[], lastModified }` |
| `s:<sectionId>` | `Section` |
| `e:<editionId>` | `Edition` |
| `status` | the last `DataStatus` and when it was read |
| `undo` | `{ past: Snapshot[]; future: Snapshot[] }`, each at most 50 (structure and text, never editions) |
| `runs` | the last 50 schedule `runId`s handled, with the edition each produced |

```ts
type Section =
  | { id: string; version: number; kind: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; version: number; kind: "text"; text: string;            // Markdown-lite, <= 20,000 characters
      /** The edition this text was last written or confirmed against. */
      reviewedEdition: string | null }
  | { id: string; version: number; kind: "data"; title: string; visual: VisualSpec; query: SavedQuery;
      /** Draw beside neighbouring data blocks of width "third" or "half". */
      width: "full" | "half" | "third" };

type Letterhead = { name?: string; logo?: string /* data:image/png|jpeg|svg+xml, <= 200 KB */; accent?: string /* #rrggbb */ };

type EditionSummary = { id: string; asOf: number; period: { from: string; to: string }; pinned: boolean;
                        createdBy: "member" | "agent" | "schedule" };

type Edition = EditionSummary & {
  title: string;
  letterhead: Letterhead;
  completeThrough: string | null;
  /** Every section as it was, in order; data sections carry their outcome. */
  blocks: (Section & { outcome?: QueryOutcome })[];
  /** Fingerprint of each data block's rows, by section id, for comparing editions. */
  fingerprints: Record<string, string>;
};
```

Limits: at most 60 sections; at most 24 editions (FR-026); title ≤ 200 characters; `letterhead.name`
≤ 120 characters.

An edition is written once under `e:<id>` and never rewritten except for its `pinned` flag, which
lives in `meta.editions`. When a 25th edition would be stored, the oldest unpinned one is deleted;
when all 24 are pinned, generating throws `All 24 editions are pinned. Unpin one to generate a new
edition.`

Starter content, created the first time `meta` is read and absent: title "Monthly sales report",
period `{ preset: "lastMonth" }`, and these sections:

| Section | Kind | Content |
|---|---|---|
| Monthly sales report | heading 1 | |
| Summary | heading 2 | |
| (summary text) | text | "Write a short summary of the month here, or ask the agent to draft one from the figures below." |
| Net sales, Orders, Average order value, Refunds | data, kpi, half each (two rows of two) | metric with compare |
| Sales by day | data, line, full | metric `net_sales` by `day` |
| Top products | data, table, half | metric `net_sales` by `product`, limit 10 |
| Sales by location | data, bar, half | metric `net_sales` by `location` |
| Discounts by week | data, table, half | metric `discounts` by `week` |
| Refunds by week | data, table, half | metric `refunds` by `week` |

## Data access modes

Same rule as the Dashboard (`contracts/dashboard-gadget.md`). In `off` mode `open()` returns no
edition content (`editions: []`, `edition: null`) but deletes nothing; editions are shown again
when the binding returns. In `snapshot` mode stored editions are served and nothing can be
generated or edited.

## RPC

### For the UI

```ts
subscribe(callback: SubscriberCallbacks, client?: { clientId?: string }): Promise<Opened>;
open(args?: { editionId?: string }): Promise<Opened>;
getEdition(args: { id: string }): Promise<Edition>;
undo(): Promise<Changed | null>;
redo(): Promise<Changed | null>;

type Opened = {
  meta: Meta; sections: Section[];
  data: DataStatus & { mode: "live" | "off" | "snapshot"; anchor?: string };
  /** The latest edition, or the one asked for; null when none exists or data is off. */
  edition: Edition | null;
  /** Section ids whose text should be reviewed against the latest edition. */
  review: string[];
  /** Data section ids added or changed since the latest edition. */
  stale: string[];
  canUndo: boolean; canRedo: boolean;
};
interface SubscriberCallbacks {
  changed(event: Changed): unknown;          // { revision, meta, sections, review, stale, canUndo, canRedo, senderId? }
  generated(event: { edition: EditionSummary; review: string[] }): unknown;
}
```

### For the agent (and the UI)

| Method | Notes |
|---|---|
| `describeData()` | As the Dashboard's. |
| `getReport()` | `{ meta, sections, latestEdition: EditionSummary \| null, review, stale }`. |
| `readEdition({ id? })` | The edition (latest by default) with each data block's columns and rows, so the agent can write narrative from the actual figures. |
| `addSection({ section, after? })` | `section` is a `Section` without `id`/`version`. Returns `{ sectionId, revision }`. |
| `updateSection({ id, ...fields })` | Returns `{ revision, before, after }`. Changing a text section's `text` sets its `reviewedEdition` to the latest edition's id. |
| `removeSection({ id })`, `moveSection({ id, after })` | Return `{ revision }`. |
| `setTitle({ title })`, `setPeriod({ period, locations? })`, `setLetterhead({ letterhead })` | Return `{ revision }`. The logo is validated (type, size) and stored as given. |
| `markReviewed({ ids })` | Clears the review flag of those text sections. |
| `generate({ createdBy? })` | Resolves the period against the anchor, runs every data section (at most 4 in flight), stores a new edition and returns `{ edition: EditionSummary, review, failed: string[] }`. A data section that fails is stored with its `QueryFailure`; the edition is still produced. Throws when data is off, empty, or the report has no data section. |
| `pinEdition({ id, pinned })`, `deleteEdition({ id })` | Return `{ revision }`. Pinning exempts an edition from retention. Deleting is a person's or the agent's explicit removal and may remove any edition, including the latest. |
| `previewQuery({ query, visual?, period? })` | Runs without saving. |

### Scheduling

```ts
// server.ts
async [restore](params: { type: "regenerate"; monthly?: "first" }): Promise<ScheduledTaskHook>
```

The restored hook's `onSchedule(firing)`:

1. returns at once if `firing.runId` is in `runs` (a retry of a run already handled);
2. with `monthly: "first"`, returns without generating unless the firing's local day of month (in
   `firing.timeZone`) is 1–7;
3. otherwise calls the same code path as `generate({ createdBy: "schedule" })` and records the
   `runId`.

The README tells the agent how to register it from `executeCode` with the Scheduled Tasks binding
and that the member must enable the hook. The gadget itself never calls the scheduler.

### Export

`ExportHandler.getExportFormats()` returns PDF in browser mode (id `pdf`) and Markdown in server
mode (id `markdown`, `.md`): the latest edition's headings and text as written, each data block as
a Markdown table of displayed values.

## Comparing editions and the review flag (`lib/editions.ts`)

- A data block's fingerprint is a stable hash of its columns' names and its rows (and its
  `previous` rows); a failed block's fingerprint is `"error"`.
- After a generation, a text section is in `review` when: it contains at least one digit; the new
  edition's fingerprints differ from those of the edition named by its `reviewedEdition` (or it has
  none and an earlier edition exists) for at least one data section present in both; and it has not
  been edited or marked reviewed since.
- `stale` lists data sections whose `query`, `visual.sort`, `visual.limit` or presence differs from
  the latest edition's copy.

## UI behaviour (`client.ts`)

- **Header**: title, edition picker ("As of 3 Nov 2026, 09:12 — October 2026", newest first, pin
  marker), Regenerate, Edit, Undo/Redo (edit mode). A banner when viewing an earlier edition:
  "You are reading an earlier edition. Its numbers are as of <time>." with "Back to latest".
- **Page**: letterhead (logo, name, accent rule), title, "As of <time> · <period>", then sections.
  The latest view shows current text with the latest edition's results; a data section in `stale`
  shows "Not in the latest edition yet. Regenerate to include it." An earlier edition shows its
  own blocks exactly as stored.
- **Data blocks**: as Dashboard tiles (visual, notes, details disclosure, show as table), each
  with "As of <time> · <period>". When the period ends after `completeThrough`: "Data is complete
  through <date>; later days may be missing." A failed block shows the error and the hand-off
  text.
- **Review flags**: a flagged text section shows "The numbers changed since this was written.
  Review the text." with **Mark as reviewed**.
- **No edition yet**: "This report has not been generated yet." with **Generate**. `off` and
  `empty` states as the Dashboard's; `snapshot` shows "Read-only copy" and no Regenerate.
- **Edit mode**: click a heading or text section to edit it in place (a textarea for
  Markdown-lite, saved on blur and after a pause); move up/down and delete per section; add
  heading, text; period and location controls; letterhead name, accent and logo upload (read as a
  data URL with the `ui` library's image helpers). Data sections are added and changed through the
  agent; their title and visual type are editable directly.
- **Live updates**: `changed` replaces structure and text unless the section is being edited
  locally (the local draft wins and is saved next); `generated` offers "A new edition is
  available" when the viewer is on an earlier one, and otherwise shows it.
- **Export / print**: prints the edition being viewed from stored results: letterhead, title,
  as-of line on the first page, sections in one column (`third`/`half` blocks keep their rows),
  `@page { margin: 0.7in }`, light palette, no controls, review flags and stale notes omitted. The
  module's top-level `await` resolves after the edition is drawn.
- **Accessibility**: as the Dashboard's; headings are real `h1`–`h3` in order; the edition picker
  is a labelled select; flags and banners are in an `aria-live="polite"` region.

## Tests

| File | Proves |
|---|---|
| `editions.test.ts` | fingerprints are stable and order-sensitive; review rule (digit, changed, cleared by edit or mark); stale detection; retention removes the oldest unpinned and refuses when all are pinned |
| `server.test.ts` | starter content; section CRUD, move and validation; `generate` stores an edition whose blocks do not change when the fake reader's data changes afterwards and sections are edited; a second `generate` makes a second edition and the first stays readable; a failing block does not stop the edition; off mode withholds editions without deleting them and refuses `generate`; snapshot mode serves editions and refuses mutations; schedule hook is idempotent on `runId` and honours `monthly: "first"`; letterhead logo validation; hostile period and location values reach the reader only as parameters |
| `client.test.ts` (jsdom) | latest view shows current text with edition results; choosing an earlier edition shows its stored text and numbers and the banner; review flag and Mark as reviewed; no-edition, off and empty states; export mode prints the viewed edition with letterhead and as-of line and no controls |
