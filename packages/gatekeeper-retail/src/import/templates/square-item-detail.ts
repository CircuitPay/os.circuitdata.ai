// The built-in Square "Item Detail" export (Dashboard → Transactions → Export → Item Detail CSV).
// Square publishes no column reference and headers vary by region, so the template matches on a
// minimal signature and the proposer resolves the remaining columns by alias. Money cells carry a
// currency symbol; discounts are exported as negative amounts; refund rows are returns of items.

import type { BuiltinTemplate } from "./index.js";

export const SQUARE_ITEM_DETAIL: BuiltinTemplate = {
  key: "square_item_detail",
  name: "Square item detail",
  version: 1,
  signature: ["Date", "Time", "Item", "Qty", "Gross Sales", "Transaction ID"],
  mapping: {
    version: 1,
    settings: { timezone: "UTC", currency: "USD", dateFormat: "yyyy-MM-dd", decimalMark: "." },
    orderKey: "Transaction ID",
    refundWhen: { column: "Event Type", values: ["Refund"] },
    targets: [
      { target: "orders.closed_at", from: "Date", transform: "date" },
      { target: "orders.closed_at", from: "Time", transform: "time" },
      { target: "locations.name", from: "Location" },
      { target: "orders.channel", from: "Channel", valueMap: { "point of sale": "in_store", online: "online", "online store": "online" } },
      { target: "line_items.name", from: "Item" },
      { target: "line_items.quantity", from: "Qty", transform: "quantity" },
      { target: "line_items.gross_amount", from: "Gross Sales", transform: "money" },
      { target: "line_items.discount_amount", from: "Discounts", transform: "negate_money" },
      { target: "line_items.tax_amount", from: "Tax", transform: "money" },
      { target: "products.sku", from: "SKU" },
      { target: "products.category", from: "Category" },
      { target: "products.variant_name", from: "Price Point Name" },
      { target: "customers.source_record_id", from: "Customer ID" },
      { target: "customers.first_name", from: "Customer Name", transform: "split_name_first" },
      { target: "customers.last_name", from: "Customer Name", transform: "split_name_last" },
    ],
  },
};
