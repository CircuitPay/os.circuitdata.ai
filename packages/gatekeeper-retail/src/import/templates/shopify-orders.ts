// The built-in Shopify orders export (Orders → Export):
// https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders
// One row per line item; continuation rows leave the order's fields blank, so they fill down from
// the order's first row. `Refunded Amount` is a refund without itemization.

import type { BuiltinTemplate } from "./index.js";

export const SHOPIFY_ORDERS: BuiltinTemplate = {
  key: "shopify_orders",
  name: "Shopify orders",
  version: 1,
  signature: ["Name", "Financial Status", "Lineitem name", "Lineitem quantity", "Lineitem price", "Total"],
  mapping: {
    version: 1,
    settings: { timezone: "UTC", currency: "USD", dateFormat: "yyyy-MM-dd HH:mm:ss", decimalMark: "." },
    // The proposer falls back to "Name" when an export has no "Id" column.
    orderKey: "Id",
    fillOrderFieldsDown: true,
    targets: [
      { target: "orders.order_number", from: "Name" },
      { target: "orders.opened_at", from: "Created at", transform: "datetime" },
      { target: "orders.closed_at", from: "Paid at", transform: "datetime" },
      { target: "orders.currency", from: "Currency" },
      {
        target: "orders.status", from: "Financial Status",
        valueMap: {
          paid: "completed", refunded: "refunded", partially_refunded: "partially_refunded", voided: "voided",
          pending: "open", authorized: "open", partially_paid: "open", expired: "voided",
        },
      },
      { target: "orders.channel", from: null, constant: "online" },
      { target: "orders.discount_amount", from: "Discount Amount", transform: "money" },
      { target: "orders.service_charge_amount", from: "Shipping", transform: "money" },
      { target: "orders.tax_amount", from: "Taxes", transform: "money" },
      { target: "orders.total_amount", from: "Total", transform: "money" },
      { target: "locations.name", from: "Location" },
      { target: "customers.email", from: "Email" },
      { target: "customers.phone", from: "Phone" },
      { target: "customers.first_name", from: "Billing Name", transform: "split_name_first" },
      { target: "customers.last_name", from: "Billing Name", transform: "split_name_last" },
      { target: "customers.marketing_opt_in", from: "Accepts Marketing", transform: "boolean" },
      { target: "line_items.name", from: "Lineitem name" },
      { target: "line_items.quantity", from: "Lineitem quantity", transform: "quantity" },
      { target: "line_items.unit_price_amount", from: "Lineitem price", transform: "money" },
      { target: "line_items.discount_amount", from: "Lineitem discount", transform: "money" },
      { target: "products.sku", from: "Lineitem sku" },
      { target: "transactions.amount", from: "Total", transform: "money" },
      { target: "transactions.occurred_at", from: "Paid at", transform: "datetime" },
      {
        target: "transactions.tender", from: "Payment Method",
        valueMap: { "shopify payments": "card", "credit card": "card", cash: "cash", "gift card": "gift_card", paypal: "wallet" },
      },
      { target: "transactions.refund_amount", from: "Refunded Amount", transform: "money" },
    ],
  },
};
