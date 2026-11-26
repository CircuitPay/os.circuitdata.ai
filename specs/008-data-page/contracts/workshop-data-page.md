# Contract: the Data entry in the Workshop

`packages/workshop-frontend`. No kernel or shared-API change: everything below uses
`AuthenticatedApi.getTenantGatekeepersApi()` and `getGatekeeperApp()` as they are.

## `src/features/data/dataArea.ts`

```ts
/** The vendor id of the organization's retail dataset (packages/gatekeeper-retail). */
export const DATA_VENDOR_ID = "retail";

export type DataArea =
  | { state: "loading" }
  | { state: "absent" }                                   // no Clerk, or the vendor is not bound
  | { state: "unavailable" }                              // operator mode "disabled"
  | { state: "off"; mayManage: boolean; enable(): Promise<void> }
  | { state: "on" };

/** The organization's Data state, refetched when the session (organization) changes. */
export function useDataArea(): DataArea;
```

- Reads `getTenantGatekeepersApi()`; null → `absent`. Otherwise `list()` and picks `vendorId ===
  DATA_VENDOR_ID`; missing → `absent`.
- The capability is held wrapped (`{ api }`) and disposed on cleanup and session change.
- `enable()` calls `api.enable(DATA_VENDOR_ID)`, then `refreshGatekeeperApps(authenticatedApi)` and
  re-reads `list()`. A refusal (demoted administrator, operator change) rejects with the server's
  message; the caller shows it.
- All mounted callers share one request per session (as `useGatekeeperApps` does), and `enable()`
  makes every mounted caller re-read.

## Navigation

- `components/AppShell/Sidebar.tsx`: a `SidebarItem` **Data** (`to="/data/$"`, `matchPrefix`, Phosphor
  `Database` icon) after Outputs whenever `useDataArea().state` is not `absent` or `loading`. The
  dynamic gatekeeper app list skips `DATA_VENDOR_ID`.
- `components/Header.tsx`: the same in the desktop and mobile lists.

## Route `src/routes/data.$.tsx` → `/data/$`

Document title "Data". Renders `DataPage` (`src/features/data/DataPage.tsx`):

| `DataArea` | Shown |
| --- | --- |
| loading | a centred loader |
| absent | "Data is not available on this deployment." |
| unavailable | "Data is turned off on this deployment." |
| off, mayManage | heading "Data", what Data is for (upload POS exports or connect Square/Stripe, then browse the data, and use it in Dashboards, Reports and chats), **Turn on Data**; on success the page becomes the app; on failure an error banner with the message |
| off, not mayManage | the same explanation and "An administrator of your organization needs to turn Data on." with no button |
| on | `<GatekeeperAppPage appId={DATA_VENDOR_ID} path={path} />` |

## Redirect

`src/routes/gatekeepers_.$appId.$.tsx`: `beforeLoad` redirects `appId === DATA_VENDOR_ID` to
`/data/$` with the same splat (old links and the Connectors page keep working).

## Connectors page

`TenantGatekeepersSection` keeps its enable/disable control. After a toggle it also tells
`useDataArea` callers to re-read.

## Tests (jsdom, colocated)

- `DataPage.test.tsx`: each of the six states renders its content; **Turn on Data** calls `enable`
  once and then shows the app host; a rejected `enable` shows the message and keeps the button; a
  member without `mayManage` sees no button.
- `dataArea.test.ts`: null capability → absent; vendor missing → absent; mode disabled →
  unavailable; enabled → on; session change disposes the old capability and re-reads.
- `Sidebar.test.tsx` (or the nearest existing nav test): Data is listed once when the retail app is
  also in `listGatekeeperApps()`, and not at all when `absent`.
