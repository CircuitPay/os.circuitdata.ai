// The interface of the Data area's management app `ui`, the capability getGatekeeperApp("retail")
// returns. `pnpm cf-os api` types `get-gatekeeper-app retail ui ...` by it: its generator
// (packages/api-schema/scripts/generate.ts) reads every gatekeeper's `src/app-api.ts` for `AppApi`.
// The implementation is `RetailAppApi` in app-ui.ts.
export type { RetailAppClient as AppApi } from "./app-api-types.js";
