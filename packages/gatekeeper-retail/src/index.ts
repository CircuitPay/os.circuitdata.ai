// Retail data worker: one canonical retail dataset per tenant, served read-only to agents and
// gadgets through the ambient `RETAIL_DATA` binding and managed in the Data area app.

import { handleRequest } from "./connectors/http.js";

export { RetailConnection } from "./connectors/connection-do.js";
export { RetailWebhookRoute } from "./connectors/webhook-route-do.js";
export { RetailDataset } from "./dataset/dataset-do.js";
export { RetailGatekeeper } from "./gatekeeper.js";
export { GatekeeperVendor, RetailAccount, RetailVerifier } from "./vendor.js";

/**
 * The router forwards `/gatekeeper/retail/*` here: provider OAuth callbacks and signed webhooks
 * (contracts/http-routes.md). Everything else is 404.
 */
export default {
  fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx.exports);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
