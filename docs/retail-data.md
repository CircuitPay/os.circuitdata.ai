# Retail data (`gatekeeper-retail`)

The retail data layer gives an organization (or a personal workspace) one shared dataset of its
sales, products, customers and inventory, loaded from Square, Stripe and CSV exports, and read by
agents through the `RETAIL_DATA` binding. Members manage it on the **Data** page (`/data`, always
in the navigation where sign-in has organizations; `/gatekeepers/retail` redirects there). The
design record is `specs/006-retail-data-layer/` (spec, plan, research, data model and contracts);
`specs/008-data-page/` adds the page itself. This page is the operator's view.

## The Data page

- **Before Data is on**, the page explains it. An organization's administrator (or a personal
  workspace's owner) turns it on there with **Turn on Data**; the kernel re-checks the role on that
  call. Other members are told to ask an administrator. The Connectors page's control still works.
- **Home** leads with **Upload a CSV** (files from the computer are kept in Files). Once data is in,
  it shows each table's row count, the dates covered and the recent imports, then the storage,
  failures and sources the old Overview showed.
- **Basic mapping** comes first in an import: one column picker per field the import needs (order
  identifier, date, total, or item and quantity), the timezone, currency and date format, then
  Preview and Import. **More options** opens the full mapping editor over the same choices.
- **Browse** lists the rows of orders, line items, payments, products, customers, locations and
  inventory, 100 at a time, narrowed by dates, by source or import, and by name; a row opens with
  its related rows and the file and row it came from. It is read-only, reads the public views
  (customers masked as for the agent), and a large table with no filter opens on its last 30 days
  (`RETAIL_SCAN_ROW_LIMIT`).
- Templates, Coverage, Sources and Settings are unchanged tabs.

## Deploying

`gatekeeper-retail` is a worker like any other gatekeeper: `pnpm configs:generate` produces its
wrangler config, the release manifest picks it up from `wrangler.jsonc`, and the router serves it at
`/gatekeeper/retail/*` once its `GATEKEEPER_RETAIL` service binding exists.

| Input | Kind | Notes |
|---|---|---|
| `RETAIL_RAW` | R2 bucket `gadgets-retail-raw` | Original CSV files and provider pages, keyed `ds/<datasetId>/…`, so any mapping can be rebuilt without re-fetching. Provisioned by the release. |
| `SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET`, `SQUARE_WEBHOOK_SIGNATURE_KEY` | secrets | Square application ID, secret and webhook signature key. |
| `STRIPE_CLIENT_ID`, `STRIPE_APP_SECRET`, `STRIPE_WEBHOOK_SECRET` | secrets, not in `deploy-inputs.json` | Stripe App OAuth client ID, platform secret key, Connect webhook signing secret. Left out of the deploy wizard until the Stripe App passes Marketplace review; set them as worker secrets to enable Stripe. Without them the Data area offers no Stripe connection. |
| `RETAIL_RAW_QUOTA_BYTES` | optional var | Raw-record quota per dataset; default 20 GiB. |
| `RETAIL_SCAN_ROW_LIMIT` | optional var | Fact-table size above which a query without a selective filter is refused; default 250,000 rows. |

The deploy wizard reads the secrets from `packages/gatekeeper-retail/deploy-inputs.json`, which also
carries the setup steps below. A provider whose secrets are missing simply cannot be connected; CSV
imports work without either.

### Square

1. In the [Square Developer Console](https://developer.squareup.com/apps), create an application.
2. Under **OAuth**, add the redirect URL `{PUBLIC_BASE_URL}/gatekeeper/retail/oauth/square` for
   Production (use the Sandbox tab and a `sandbox-` application ID to test against the sandbox).
3. Under **Webhooks → Subscriptions**, add `{PUBLIC_BASE_URL}/gatekeeper/retail/webhooks/square` for
   the order, payment, refund, customer, catalog and inventory events.
4. Copy the application ID, application secret and the subscription's signature key into the deploy
   inputs. Only read scopes are requested; a grant with more is refused.

### Stripe

1. Publish a [Stripe App](https://dashboard.stripe.com/apps) that requests only read permissions
   (`charge_read`, `payment_intent_read`, `refund_read`, `customer_read`, `invoice_read`,
   `checkout_session_read`, `product_read`, `price_read`, `payout_read`, `balance_transaction_read`,
   `event_read`) and uses OAuth install links. Public release waits on Stripe's Marketplace review.
2. Add `{PUBLIC_BASE_URL}/gatekeeper/retail/oauth/stripe` to the app's allowed redirect URLs.
3. Add a Connect webhook endpoint at `{PUBLIC_BASE_URL}/gatekeeper/retail/webhooks/stripe` for charge,
   refund, customer, invoice, `checkout.session`, product, price and payout events. A `/v1/events`
   poll backs up missed deliveries.
4. Copy the OAuth client ID, platform secret key and the endpoint's signing secret into the deploy
   inputs.

## Limits

- One SQLite Durable Object per dataset, capped at 10 GB; administrators are warned at 70%. Sized
  for about 10 locations × 3 years (≈ 5.5 GB).
- Queries return at most 10,000 rows and 16 MB (defaults 1,000 rows and 4 MB), with 100 bound
  parameters; they are read-only, run through a SQL guard over the public views, and large fact
  tables need a selective filter (`RETAIL_SCAN_ROW_LIMIT`).
- CSV imports take up to 10 files at once, each up to the tenant file limit (100 MB, about 500k
  rows), and count against the raw quota.
- Provider backfills read 1–3 years (administrator setting, default 3).
- The worker raises `limits.cpu_ms` to 300,000 because imports and rollup recomputes run in alarms.

## Design summary

- **Ownership.** The account is held by the tenant (organization or personal workspace), not a user,
  so every member's workspaces see the same dataset. Rights are re-read through `TenantAccess` on
  every Data-area call: members view, import and template; administrators connect providers, change
  settings, erase, and review matches.
- **Objects.** `RetailDataset` (one per dataset) is the single writer of storage tables, public
  views, rollups and run history. `RetailConnection` (one per provider connection) holds the
  credentials, which never leave it, and drives backfill, sync and webhook refetch.
  `RetailWebhookRoute` maps a provider account to its connections.
- **Lineage and undo.** Every row records its source, source record id, run and mapping version.
  CSV imports keep pre-images, so an import can be undone until a later run changes its rows; a
  corrected template can be re-applied as a rebuild run over the raw records.
- **Metrics.** Standard metrics (net sales, orders, units, margin, repeat customer rate, …) read
  daily rollups and publish their SQL through `describe()`.
- **Personal data.** The `customers` view is masked by default; hashed emails and phones stay
  available for joins. An administrator may unmask it in **Settings**, and the change is recorded.
- **Cross-source matching.** Customers with the same email hash and products with the same SKU in
  two sources are proposed pre-ticked; records sharing only a name are proposed unticked. Nothing is
  linked until an administrator confirms; a confirmation sets `canonical_customer_id` /
  `canonical_product_id`, an undo clears it, and `repeat_customer_rate` counts linked customers as
  one person.
- **Erasure.** Erasing (from **Settings**, by typing a confirmation phrase, or when the tenant is
  deleted) revokes every provider grant, then deletes the raw records and every row in alarm steps.
  The account stays enabled and empty.
