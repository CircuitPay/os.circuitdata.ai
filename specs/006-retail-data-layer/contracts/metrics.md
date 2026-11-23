# Contract: standard metrics (FR-017, US3.3)

There is one definition per metric. `metric()` runs it, `describe()` publishes it, and every
dashboard, report and agent answer uses it. Spec 007's standard tiles must use these definitions
rather than their own SQL (007 FR-009).

Scope rules for all metrics:

- **Sales metrics** count only non-voided orders. Those are orders with `status` in
  `completed`, `refunded` or `partially_refunded` and `deleted_at IS NULL`. Voided line items
  (`is_voided`) are excluded too.
- **Dates**: order measures are attributed to the order's `business_date`. Refund measures are
  attributed to the refund's `business_date`, as Square and Toast report them.
- **Currency**: money metrics are always grouped by currency, and amounts in different currencies
  are never added.
- **Source**: metrics read only the rollup views (`daily_sales`, `daily_product_sales`,
  `customer_summary`), which every run keeps current (research R17).

| Metric | Unit | Definition | Rollup expression |
|---|---|---|---|
| `gross_sales` | money | Σ line `gross_amount` (quantity × unit price incl. modifiers), before discounts; excludes tax, tips, service charges | `SUM(gross_amount)` |
| `discounts` | money | Σ line- and order-level discounts | `SUM(discount_amount)` |
| `refunds` | money | Σ the sales portion of succeeded refund transactions (`sales_amount`; excludes refunded tax and tips) | `SUM(refund_amount)` |
| `net_sales` | money | `gross_sales − discounts − refunds` | `SUM(gross_amount) − SUM(discount_amount) − SUM(refund_amount)` |
| `tax` | money | Σ order tax collected | `SUM(tax_amount)` |
| `tips` | money | Σ order tips | `SUM(tip_amount)` |
| `service_charges` | money | Σ order service charges | `SUM(service_charge_amount)` |
| `orders` | count | non-voided orders | `SUM(orders)` |
| `average_order_value` | money | `net_sales / orders`, rounded half-even to the minor unit; null when `orders = 0` | derived |
| `units_sold` | quantity | Σ quantity on non-voided lines − Σ `refund_items.quantity` | `SUM(units) − SUM(refunded_units)` |
| `gross_margin` | money | `net_sales − Σ(units × unit_cost)` over units with a known cost; `partial = true` and `costCoverage` < 1 when any unit lacks a cost | `daily_product_sales`: `SUM(net_amount) − SUM(cost_amount)` where cost known |
| `repeat_customer_rate` | ratio | identified customers (merged through confirmed `canonical_customer_id`) with ≥ 2 orders in the range ÷ those with ≥ 1; null when none | computed from `orders` grouped by customer (indexed), not from a rollup |

Grouping support:

| groupBy | Metrics |
|---|---|
| `day`, `week`, `month`, `location`, `channel` | all except `repeat_customer_rate` (only `location`, `month`) |
| `product`, `category` | `gross_sales`, `discounts`, `refunds`, `net_sales`, `units_sold`, `gross_margin` |

Square names "returns" what this contract calls refunds, and "discounts & comps" what it calls
discounts. Square's own Net sales = Gross sales − Returns − Discounts & comps, which matches
`net_sales` here. SC-002 checks every metric against each source system's own summary for the same
business dates.

Refused metric queries:

- a range over 3 years
- an unknown metric or groupBy
- `product`/`category` with an order-level metric
- a `currency` that is not ISO 4217
