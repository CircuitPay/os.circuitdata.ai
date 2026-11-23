// The built-in Toast export set (contracts/mapping-document.md, FR-010). Field names follow Toast's
// data export reference: https://doc.toasttab.com/doc/platformguide/adminDataExportFieldReference.html
// Toast exports carry no business-date column, so the set's date is used (research R11): the
// proposer fills `settings.fileDate` from the orders' `Opened` times and the member confirms it.

import type { BuiltinTemplate } from "./index.js";

const ORDERS = "OrderDetails";
const ITEMS = "ItemSelectionDetails";
const PAYMENTS = "PaymentDetails";
const MODIFIERS = "ModifiersSelectionDetails";

const from = (file: string, column: string) => ({ file, column });

const YES_NO_VOIDED = { true: "voided", yes: "voided", false: "completed", no: "completed" };

export const TOAST: BuiltinTemplate = {
  key: "toast",
  name: "Toast export set",
  version: 1,
  mapping: {
    version: 1,
    settings: {
      timezone: "UTC",
      currency: "USD",
      dateFormat: "MM/dd/yyyy HH:mm:ss",
      decimalMark: ".",
      businessDate: "from_file_date",
    },
    files: [
      { role: ORDERS, required: true, headerSignature: ["Location", "Order Id", "Order #", "Opened", "Total", "Voided"] },
      { role: ITEMS, required: true, headerSignature: ["Order Id", "Item Selection Id", "Menu Item", "Qty", "Gross Price", "Void?"] },
      { role: PAYMENTS, required: true, headerSignature: ["Payment Id", "Order Id", "Amount", "Tip", "Refund Amount"] },
      {
        role: MODIFIERS, required: false,
        headerSignature: ["Parent Menu Selection Item ID", "Modifier", "Gross Price", "Sales Cateogry"],
      },
    ],
    orderKey: from(ORDERS, "Order Id"),
    joins: [
      { from: from(ITEMS, "Order Id"), to: from(ORDERS, "Order Id") },
      { from: from(PAYMENTS, "Order Id"), to: from(ORDERS, "Order Id") },
      { from: from(MODIFIERS, "Parent Menu Selection Item ID"), to: from(ITEMS, "Item Selection Id") },
    ],
    targets: [
      { target: "locations.name", from: from(ORDERS, "Location") },
      { target: "locations.kind", from: null, constant: "restaurant" },
      { target: "orders.order_number", from: from(ORDERS, "Order #") },
      { target: "orders.opened_at", from: from(ORDERS, "Opened"), transform: "datetime" },
      { target: "orders.closed_at", from: from(ORDERS, "Closed"), transform: "datetime" },
      { target: "orders.guest_count", from: from(ORDERS, "# of Guests") },
      { target: "orders.status", from: from(ORDERS, "Voided"), valueMap: YES_NO_VOIDED },
      { target: "orders.gross_amount", from: from(ORDERS, "Amount"), transform: "money" },
      { target: "orders.discount_amount", from: from(ORDERS, "Discount Amount"), transform: "money" },
      { target: "orders.tax_amount", from: from(ORDERS, "Tax"), transform: "money" },
      { target: "orders.tip_amount", from: from(ORDERS, "Tip"), transform: "money" },
      { target: "orders.service_charge_amount", from: from(ORDERS, "Gratuity"), transform: "money" },
      { target: "orders.total_amount", from: from(ORDERS, "Total"), transform: "money" },

      { target: "line_items.source_record_id", from: from(ITEMS, "Item Selection Id") },
      { target: "line_items.name", from: from(ITEMS, "Menu Item") },
      { target: "line_items.quantity", from: from(ITEMS, "Qty"), transform: "quantity" },
      { target: "line_items.gross_amount", from: from(ITEMS, "Gross Price"), transform: "money" },
      { target: "line_items.discount_amount", from: from(ITEMS, "Discount"), transform: "money" },
      { target: "line_items.tax_amount", from: from(ITEMS, "Tax"), transform: "money" },
      { target: "line_items.is_voided", from: from(ITEMS, "Void?"), transform: "boolean" },
      { target: "products.sku", from: from(ITEMS, "SKU") },
      { target: "products.category", from: from(ITEMS, "Sales Category") },

      { target: "line_items.modifier_name", from: from(MODIFIERS, "Modifier") },
      { target: "line_items.modifier_price_amount", from: from(MODIFIERS, "Gross Price"), transform: "money" },
      { target: "line_items.modifier_quantity", from: from(MODIFIERS, "Qty"), transform: "quantity" },

      { target: "transactions.source_record_id", from: from(PAYMENTS, "Payment Id") },
      { target: "transactions.amount", from: from(PAYMENTS, "Amount"), transform: "money" },
      { target: "transactions.tip_amount", from: from(PAYMENTS, "Tip"), transform: "money" },
      { target: "transactions.occurred_at", from: from(PAYMENTS, "Paid Date"), transform: "datetime" },
      {
        target: "transactions.tender", from: from(PAYMENTS, "Type"),
        valueMap: { credit: "card", debit: "card", cash: "cash", "gift card": "gift_card", other: "other" },
      },
      { target: "transactions.card_brand", from: from(PAYMENTS, "Card Type") },
      { target: "transactions.refund_amount", from: from(PAYMENTS, "Refund Amount"), transform: "money" },
      { target: "transactions.refund_occurred_at", from: from(PAYMENTS, "Refund Date"), transform: "datetime" },
    ],
  },
};
