# Contract: the Data area (management UI capability and host bridge)

The Data area is the retail account's management app, hosted by the Workshop at
`/gatekeepers/retail`. It appears in the header and the sidebar through `listGatekeeperApps`, titled
"Data". It is a single-file React SPA in `packages/gatekeeper-retail/app/`. Its `ui` capability is
returned by `startAppUi(ctx)` and is internal to this gatekeeper, so it is not part of
`workshop-shared`. It is listed here because it carries the permission rules of FR-002.

## Permissions

`ctx.tenant.access.current()` is called **at the start of every method**. A personal workspace's
owner may do everything.

| Action | Member | Org admin |
|---|---|---|
| View the overview, sources, runs, reports, coverage, lineage, templates | ✓ | ✓ |
| Stage, map, preview and run a CSV import; save or edit a template; re-apply a template (rebuild) | ✓ | ✓ |
| Undo an import | own imports | any |
| Cancel a running import | own imports | any |
| Connect, reconnect or disconnect a provider; choose locations; set the backfill depth; sync now | — | ✓ |
| Delete a source's data; erase the whole dataset | — | ✓ |
| Change `pii_unmasked` | — | ✓ |
| Confirm, reject or undo cross-source matches (Story 6) | — | ✓ |

A refused call throws `"Only organization administrators can …"`. Calls are never filtered without
saying so.

## `RetailAppApi` (the `ui` capability, `@validateRpc()`)

| Method | Behaviour |
|---|---|
| `getOverview()` | `{ canManage, sources[], storage: { usedBytes, capBytes, rawUsedBytes, rawQuotaBytes, warn }, settings: { piiUnmasked, backfillYears }, failuresNeedingAdmin[] }` (FR-020) |
| `listRuns({ sourceId?, after?, limit? })` / `getRun(id)` | Status, counts per table, `progress { phase, done, total, etaSeconds }`, and undo eligibility. The UI polls `getRun` every 2 s while a run is active (US1.2, Edge "huge CSVs"). |
| `listRejections(runId, { after?, limit? })` | Rejected rows with reason codes (FR-011, US4). |
| `getCoverage({ from?, to?, locationIds? })` | Same shape as the binding's `coverage()` (US4). |
| `getLineage(table, id)` | Same shape as the binding's `lineage()` (US4.2). |
| **Imports** | |
| `receiveTenantFiles(sourceId \| { newSourceLabel }, files: TenantFileDelivery[])` | Called by the **host**, not the iframe. Copies each stream into R2 (the raw record) before returning, sniffs it, matches templates by header signature, and returns `{ importId }`. Refused for more than 10 files, a file over the tenant file limit, or exceeding the raw quota. |
| `getImport(id)` | Files, sniff results, headers, 20 sample rows (unmasked here, since members may see their own file), template matches, the deterministic mapping, the agent's suggestion if any, and the missing required files of a set. |
| `askAgentPrompt(id)` | The prompt text the app passes to the host's `openPrompt()` ("Propose a column mapping for pending import N …"). |
| `preview(id, mapping)` | Validates the mapping. Over the whole file, or the first 50,000 rows for larger files (said so in the result), returns the canonical row counts per table, the first 50 rows per table, the row problems by reason with examples, and totals per business date (orders, gross, discounts, refunds, net, tax, tips) for comparison with the POS report (US2.3). Nothing is written. |
| `startImport(id, mapping, { saveAsTemplate?: { name } \| { templateId } })` | Creates the run and starts the alarm loop. Saving creates a new template version (FR-010). Returns `{ runId }`. |
| `cancelRun(runId)` | Takes effect between batches. |
| `undoImport(runId)` | Refused with the names of later runs that changed its rows, or when its pre-images have expired (research R16). |
| **Templates** | |
| `listTemplates()`, `getTemplate(id)`, `saveTemplateVersion(id, mapping)`, `deleteTemplate(id)` | Built-in templates are read-only and can be copied. Deleting a template keeps the data it imported. |
| `reapplyTemplate(templateId, { versionId })` | Rebuild run over every raw object imported with that template (US5). |
| **Connections** (admin) | |
| `beginConnect(provider: "square" \| "stripe")` | Returns `{ url, nonce }` for the host's `openConnectPopup` (research R19). |
| `redeemConnectHandoff(ticket, nonce)` | Called by the Workshop's `/connect/handoff` page over the popup's own session. Checks that the ticket belongs to this dataset's flow and that the nonce matches the same flow, unexpired and single-use, then commits the staged credentials. Returns `{ sourceId }`. A refused redemption revokes the staged grant. |
| `listProviderLocations(sourceId)` / `chooseLocations(sourceId, ids)` | Starts the backfill (US1). |
| `setBackfillYears(n)` | 1–3. |
| `syncNow(sourceId)` | |
| `reconnect(sourceId)` | Same as `beginConnect`. Credentials are staged and committed on redemption. A reconnect to a different provider account is refused. |
| `disconnect(sourceId, { deleteData: boolean })` | Stops sync and revokes the provider token. With `deleteData`, deletes that source's rows, its raw objects and its affected rollups (US1.5). |
| **Settings and erasure** (admin) | |
| `setPersonalDataUnmasked(on)` | Recreates the `customers` view; the change is recorded. |
| `eraseDataset({ confirm: ERASE_CONFIRMATION })` | The administrator types the fixed phrase `ERASE_CONFIRMATION` ("erase all retail data"; a dataset has no label of its own). Revokes every provider grant, then erases all rows and raw objects; the account stays enabled and empty. |
| **Matching** (Story 6, admin) | |
| `listMatchProposals({ kind })`, `confirmMatch(id)`, `rejectMatch(id)`, `undoMatch(id)` | Email (verified) and SKU proposals are pre-ticked. Name-only proposals never are, and are never auto-linked. |

## Host bridge additions (`workshop-frontend`, `SandboxedGatekeeperApp.tsx`)

`GatekeeperAppHostImpl` (`SandboxedGatekeeperApp.tsx:321-330`) and each app's mirrored host type
gain:

| Host method | Behaviour |
|---|---|
| `pickTenantFiles({ accept: string[], multiple: boolean, target: unknown })` | Opens a Workshop dialog listing the tenant's Files (search, paging) with an Upload action that stores new files in Files first. On confirm, calls `frame.ui.receiveTenantFiles(target, deliveries)`, where each `stream` is the promise-pipelined `filesApi.downloadFile(id)` (research R8), and returns its result to the app. Returns null if the member cancels. The host never passes a `TenantFilesApi` on. |
| `openConnectPopup({ url, nonce })` | Opens the popup with `openDisownedPopup` and writes `{ kind: "app", appId, nonce }` to its sessionStorage (`docs/connect-handoff.md`). Rejects URLs that are not `https:`. |

`ConnectHandoffPage` gains `kind: "app"`. It calls `getGatekeeperApp(appId)` over the popup's
session, then `ui.redeemConnectHandoff(ticket, nonce)`, reports success or refusal, and disposes the
frame.

## Accessibility (FR-023)

- The mapping editor is a table: one row per source column, with a labelled Kumo `Select` for the
  target and the transform.
- Required-but-missing targets are listed in a live region.
- The preview tables have captions and header cells. Problems are links that move focus to the
  offending row.
- Progress uses `role="progressbar"` with text values.
- Every action is reachable by keyboard, and dialogs trap and restore focus.
