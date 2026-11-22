# Contract: gatekeeper HTTP routes

The router forwards `/gatekeeper/retail/*` to the retail worker's `fetch`
(`packages/router/src/index.ts:28-35`). There is no other public surface. `BASE_URL` is
`$PUBLIC_BASE_URL/gatekeeper/retail` (`manifest-lib.ts:497`).

| Route | Method | Purpose | Checks |
|---|---|---|---|
| `/gatekeeper/retail/oauth/square` | GET | Square OAuth redirect (`code`, `state`) | `state` names a pending flow in a `RetailConnection` DO, unexpired and single-use (kit `connect-handshake`/`connect-nonce`). Exchanges the code with the server-held secret, checks that the granted scopes match the requested read scopes, and stages the credentials. Responds with `connectHandoffPageHtml` (ticket → `/connect/handoff#…`). Any failure gives a plain error page, and nothing is staged. |
| `/gatekeeper/retail/oauth/stripe` | GET | Stripe App OAuth redirect | Same checks. Requires `stripe_user_id` and the read permissions only. |
| `/gatekeeper/retail/webhooks/square` | POST | Square event notifications | Body capped at 1 MiB (`readBytesCapped`). HMAC-SHA-256 of `notificationUrl + rawBody` with `SQUARE_WEBHOOK_SIGNATURE_KEY`, compared in constant time against `x-square-hmacsha256-signature`, **before** parsing. `merchant_id` → `RetailWebhookRoute` DO → for each connection, queue a refetch of `{type, id}`. Event ids are de-duplicated for 24 h. Answers 200 quickly; work happens on the connection's alarm. |
| `/gatekeeper/retail/webhooks/stripe` | POST | Stripe App events | `Stripe-Signature` verified with `STRIPE_WEBHOOK_SECRET`, with a 5-minute tolerance. `event.account` → route DO. Then the same as above. |
| anything else | * | — | 404 |

Webhook bodies are triggers, never data. The connection refetches each object with its own
credentials, so a forged event that passed the signature check could cause a refetch and nothing
more.

Logging (`gatekeeper.retail`, `vendorId: "retail"`):

- `oauth.callback.{staged,refused}`
- `webhook.{accepted,rejected_signature,unrouted}`
- `sync.{started,completed,failed,rate_limited}`
- `import.{started,completed,failed,cancelled,undone}`
- `query.refused`
- `dataset.{size_warning,erased}`

The fields are ids, counts, durations and reason codes. Logs never contain tokens, headers, bodies,
SQL parameters or row values. Sync failures that need an administrator also go to
`reportIssue("retail.sync", err, …)`.
