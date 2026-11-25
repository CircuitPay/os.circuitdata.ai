# Contract: kernel changes (ambient blueprint bindings, retiring bundled formats)

Ships as its own commit group (`workshop-shared` + `workshop-backend`), reviewable apart from the
blueprints and the frontend. Every new exported member is doc-commented (constitution I). Research
R2, R3 and R13 explain the shape.

## 1. `packages/workshop-shared/src/api.ts`

A fourth variant of `BlueprintBinding`:

```ts
} | {
  /**
   * Filled by the workspace's own always-available resource of this vendor (an "ambient" or
   * "tenantAmbient" capsule, see GatekeeperCreationSpec), never by a person: nobody picks an
   * account for it and no assignment may name it. The Workshop binds it when the gadget is
   * created and whenever the resource (re)appears; while the workspace has no such resource the
   * gadget's env simply lacks the name, which the gadget's code must tolerate. Declaring it grants
   * nothing: the resource is in the workspace only because its owner, their organization's
   * administrator or the deployment's operator enabled it.
   */
  type: "ambient";

  /** The vendor's id (GATEKEEPER_<ID> suffix, lowercased), e.g. "retail". */
  vendorId: string;
});
```

`OutputFormatOffer.requiresSetup` doc: "true when the blueprint declares a binding a person must
fill; ambient bindings never count".

`newWorkspaceFromBlueprint` doc: an assignment that names an ambient binding is refused.

No other shared type changes. `BlueprintBindingAssignment` gains nothing.

## 2. `packages/workshop-backend`

| File | Change |
|---|---|
| `src/storage-schema/overseer-storage.ts` | `GadgetRecord.ambientBindings?: Record<string, string>` (binding name → vendor id), doc-commented: what the gadget's blueprint declared, kept so the binding can be made again when the resource returns. |
| `src/overseer.ts` `createGadget` | `blueprint` parameter gains `ambientBindings?: Record<string, string>`; when non-empty it is stored on the record and `bindAmbientDeclarations(record.id)` runs after the record is written. |
| `src/overseer.ts` `initializeFromBlueprint` | sets `record.ambientBindings` from `metadata.bindings` beside `record.output`, then `bindAmbientDeclarations(gadgetId)`. |
| `src/overseer.ts` `fetchBlueprint` | returns `ambientBindings` (the blueprint's ambient declarations). Its notes and `merge.missingBindings` leave out an ambient binding the workspace can fill now; one it cannot fill is listed with the wording in §4. |
| `src/overseer.ts` new `bindAmbientDeclarations(gadgetId?)` | For the given gadget, or every gadget record: for each `[name, vendorId]` in `ambientBindings` with no edge named `name` (pending or not), find the gatekeeper record whose `creationSpec.type` is `"ambient"` or `"tenantAmbient"` and whose `vendorId` matches; if found, `bindWorkpiece(gadget.id, name, capsule.id)`. A name that fails to bind is logged (`event: "ambient.binding.failed"`, ids only) and skipped. |
| `src/overseer.ts` `ensureAmbientCapsules` | calls `bindAmbientDeclarations()` after both reconciles settle. |
| `src/overseer.ts` `unbindWorkpiece`, `renameBinding` | unbind deletes `ambientBindings[name]`; rename moves the key. A person's unbind therefore stays unbound. |
| `src/overseer.ts` `collectBindingMetadata` | an edge whose target's `creationSpec.type` is `"ambient"` or `"tenantAmbient"` is exported as `{ title: <capsule resourceTitle or the binding name>, description: <edge annotation description or "">, type: "ambient", vendorId }` instead of being skipped. |
| `src/overseer.ts` `describeBindingKind`, `#missingBlueprintBindings` | handle the variant (`always-available resource: <vendorId>`); a declared ambient name with an edge is not missing. |
| `src/agent.ts` `formatMissingBlueprintBindings` | case `"ambient"`: see §4. The `createGadget` tool passes `blueprint.ambientBindings` through `hooks.createGadget`. |
| `src/agent.ts` system prompt | the example "a doc, a deck, a tracker" becomes "a report, a dashboard, a tracker". No other prompt change. |
| `src/admin-config.ts` `listFormatOffers` | `requiresSetup: Object.values(metadata.bindings).some(b => b.type !== "ambient")`. |
| `src/server.ts` `newWorkspaceFromBlueprint` | an assignment whose declared binding is `ambient` throws `Binding "<name>" is connected automatically and cannot be assigned.` |
| `src/admin-settings.ts` | §3 and §5. |

## 3. Retiring dropped bundled formats (`AdminSettings`)

New private step run by `#installBundledBlueprints` after `#promoteBundledFormats`:

```
dropped = promotedFormatBlueprints \ { entry.blueprintId for entry of BUNDLED_BLUEPRINTS }
if dropped is empty: return
#mutateAdminConfig(null, current => ({ ...current, formats: current.formats.filter(f => !dropped.has(f.blueprintId)) }))
for id of dropped: storage.featuredBlueprints.delete(id)
#writeFeaturedSnapshot()
storage.promotedFormatBlueprints.put(promoted minus dropped)
```

- The blueprint's `BLUEPRINTS` record and `BLUEPRINT_CONTENT` pack are not touched.
- Order matters for retries: the config and mirror are written before the stamp, so a failure
  repeats the whole step, and every write is idempotent.
- Not an admin action, so nothing is written to the admin audit log (as promotion is not).
- The comment above `#promoteBundledFormats` that says the converse "isn't handled" is replaced by
  a description of this step.

## 4. Agent-facing wording

`formatMissingBlueprintBindings`, case `"ambient"`:

> `the workspace's always-available "<vendorId>" resource; this workspace does not have it, so
> the gadget runs without it until it is enabled (nothing for you to wire)`

`fetchBlueprint` notes when every declared binding is ambient and filled:
`The blueprint's bindings were connected automatically.`

## 5. Seeding a format's agent hint

`BB/src/manifest.ts` accepts an optional `agentHint` string (1–400 characters, the budget `MAX_AGENT_HINT` gives a format hint) in
`blueprint.json`; `BB/src/generate.ts` carries it on `BundledBlueprint` and includes it in the
install fingerprint inputs only through `bundledBlueprintsManifestVersion()`'s presentation
fingerprint (so editing it reinstalls, as a description edit does).

`#promoteBundledFormats` writes `{ blueprintId, enabled: true, ...(entry.agentHint ? { agentHint:
entry.agentHint } : {}) }` for a format it promotes for the first time. It never changes the hint
of a format already in `AdminConfig.formats`.

## 6. Frontend (`packages/workshop-frontend`)

- `BlueprintLandingPage.tsx`: an ambient binding is listed read-only as "Connected automatically"
  with its title and description; it has no picker, is never part of the assignments sent, and
  never blocks the Create button.
- `components/BlueprintCard.tsx`: ambient bindings add no "needs" badge.
- `components/AppShell/HomeTaskSuggestions.tsx`: the Docs and Slides suggestions are replaced by a
  dashboard and a report suggestion.
- `components/format/AdminFormatsPanel.tsx`: the example copy names "New Dashboard" and
  "New Report".

## Invariants (each covered by a test that attempts the forbidden or broken case)

1. A gadget created from a blueprint that declares `{type: "ambient", vendorId: V}` under `N` has
   an edge `N` to the workspace's capsule of `V` when the workspace has one, on both the
   `newWorkspaceFromBlueprint` path and the agent's `createGadget` path, and none otherwise.
2. A workspace with no capsule of `V` binds nothing; the same gadget gains the edge at the next
   `ensureAmbientCapsules()` after the capsule appears, and regains it after the capsule is removed
   and re-added (a new capsule id).
3. Declaring an ambient binding never creates a capsule: a tenant that has not enabled `V`, or an
   operator mode of `disabled`, leaves `env[N]` absent.
4. A person's unbind is not undone by the reconcile.
5. `listOutputFormats()` reports `requiresSetup: false` for a blueprint whose only bindings are
   ambient, and `true` when it also declares any other kind.
6. `newWorkspaceFromBlueprint` refuses an assignment for an ambient binding.
7. Publishing a gadget whose edge targets an ambient capsule yields `bindings[N].type ===
   "ambient"`; no account id, dataset id or capsule id is in the published metadata.
8. A collaborator from another tenant is still refused by `open()` and, belt and braces, by the
   observer check, for a gadget bound this way (the existing spec 006 tests keep passing with a
   bound gadget in the workspace).
9. After an upgrade that drops a bundled id the installer had promoted, that id is in neither
   `AdminConfig.formats` nor the featured mirror, its KV record still exists, and a second run
   changes nothing. An id an admin promoted by hand that was never bundled is untouched.
10. A bundled format promoted for the first time carries its manifest `agentHint`; a format
    already curated keeps the hint it has.
