# Data Model: Retail Data Layer (draft)

The canonical schema every source maps into and every dashboard reads. This draft is for review, not
a migration. Names are what consumers (the agent, dashboards, reports) see.

## Conventions

- **Keys**: every table has `id` (canonical, opaque, stable), `source` (`square` | `stripe` | `toast` |
  `csv`), `source_account` (the connection or template id), `source_id` (the provider's or file's id).
  `(source, source_account, source_id)` is unique; that uniqueness is what makes re-sync and
  re-import idempotent.
- **Lineage**: `run_id` (the sync run or import that last wrote the row), `mapping_version`,
  `ingested_at`, `updated_at`.
- **Money**: integer minor units (`*_amount`, e.g. 1299 = $12.99) plus `currency` (ISO 4217) on the
  row. Never floats. Metrics never add across currencies.
- **Time**: `*_at` timestamps are UTC; `locations.timezone` (IANA) gives local time; `orders.business_date`
  is the local trading day after applying `locations.day_cutoff`.
- **Deletes**: soft (`deleted_at`) so history keeps its references.
- **Personal data**: columns marked **PII** are masked for agent reads by default.

## Tables

### `locations`
A store, restaurant, or online channel.

| column | type | notes |
|---|---|---|
| name | text | |
| kind | text | `store` \| `restaurant` \| `online` \| `other` |
| timezone | text | IANA, e.g. `America/Toronto` |
| day_cutoff | time | business-day boundary, default `04:00` for restaurants, `00:00` otherwise |
| currency | text | default currency |
| address_* | text | city, region, country, postal code |

### `customers`
| column | type | notes |
|---|---|---|
| first_name, last_name | text | **PII** |
| email, phone | text | **PII**; normalized (lowercase, E.164) for matching |
| created_at | timestamp | first seen at the source |
| marketing_opt_in | bool, nullable | |
| canonical_customer_id | id, nullable | set when matched across sources (Story 6) |

### `products`
One row per sellable variant; `parent_product_id` groups variants ("Latte" → "Latte, large").

| column | type | notes |
|---|---|---|
| name, variant_name | text | |
| parent_product_id | id, nullable | |
| sku, barcode | text, nullable | SKU is the cross-source match key |
| category | text, nullable | the source's category or menu group |
| price_amount, currency | int, text | current list price |
| unit_cost_amount | int, nullable | for margin; may come from a CSV |
| is_active | bool | |

### `orders`
A sale (or a ticket or check, for restaurants).

| column | type | notes |
|---|---|---|
| location_id | id | |
| customer_id | id, nullable | |
| order_number | text | the number staff and receipts show |
| status | text | `open` \| `completed` \| `voided` \| `refunded` \| `partially_refunded` |
| channel | text | `in_store` \| `online` \| `delivery` \| `other` |
| opened_at, closed_at | timestamp | |
| business_date | date | for reporting by trading day |
| currency | text | |
| gross_amount | int | sum of line items before discounts |
| discount_amount | int | order-level and line-level discounts |
| service_charge_amount | int | |
| tax_amount | int | |
| tip_amount | int | |
| total_amount | int | what the customer was charged |
| prices_include_tax | bool | |

### `line_items`
| column | type | notes |
|---|---|---|
| order_id | id | |
| product_id | id, nullable | null for custom/open-price items |
| name | text | as sold, even if the product is later renamed |
| quantity | decimal | can be fractional (weight-based items) |
| unit_price_amount | int | including modifier prices |
| gross_amount, discount_amount, tax_amount | int | |
| modifiers | json | `[{ name, price_amount }]` |
| unit_cost_amount | int, nullable | cost at time of sale if known |

### `transactions`
Money movements tied to orders: payments and refunds, and (from Stripe) payouts and fees.

| column | type | notes |
|---|---|---|
| order_id | id, nullable | null for payouts or unattached payments |
| location_id | id, nullable | |
| kind | text | `payment` \| `refund` \| `payout` \| `fee` \| `adjustment` |
| tender | text, nullable | `card` \| `cash` \| `gift_card` \| `wallet` \| `other` |
| card_brand | text, nullable | never card numbers |
| amount | int | positive; `kind` gives the direction |
| fee_amount | int, nullable | processor fee where known |
| currency | text | |
| occurred_at | timestamp | |
| status | text | `succeeded` \| `failed` \| `pending` |

### `inventory`
Current stock per product and location; one row each, replaced on sync.

| column | type | notes |
|---|---|---|
| product_id, location_id | id | |
| quantity_on_hand | decimal | |
| state | text | `in_stock` \| `low` \| `out_of_stock` (when only a state is known, e.g. Toast) |
| as_of | timestamp | when the source last reported it |

`inventory_movements` (product, location, quantity change, reason, occurred_at) is added where the
source provides changes (Square does). Toast reports only availability.

## Derived

- **Rollups**: `daily_sales` (business_date × location: orders, gross, discounts, net, tax, tips,
  refunds, units), `daily_product_sales` (× product), `customer_summary` (first/last order, order count,
  lifetime net). Rebuilt for the affected days after each run.
- **Standard metrics** (single shared definitions):
  - `net_sales` = gross − discounts − refunds (excl. tax, tips, service charges)
  - `orders` = completed orders (voids excluded)
  - `aov` = net_sales / orders
  - `units_sold` = Σ line quantity on completed orders, minus refunded units
  - `gross_margin` = net_sales − Σ(unit cost × units); partial when costs are missing, and says so
  - `repeat_customer_rate` = customers with ≥2 orders in period / customers with ≥1

## Source → canonical (first pass)

Toast is CSV-only in this release (its column describes the data exports, not the API).

| Canonical | Square | Stripe | Toast (export files) | CSV |
|---|---|---|---|---|
| locations | Locations | — (one "online" location) | Restaurants | template setting or column |
| customers | Customers | Customers | Guests (restricted) | columns |
| products | Catalog items + variations | Products + Prices | Menus / menu items | item columns |
| orders | Orders | Invoices, Checkout Sessions | Orders (checks) | grouped by order id column |
| line_items | Order line items | Invoice / session line items | Check selections | each row |
| transactions | Payments, Refunds | Charges, Refunds, Payouts, Balance txns | Order payments | tender columns |
| inventory | Inventory counts + changes | — | Stock (availability) | stock export |

All provider names above are to be verified against current provider docs during `/speckit.plan`.
