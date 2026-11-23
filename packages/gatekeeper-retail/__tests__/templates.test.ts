// Built-in templates (FR-010, T038): a Toast export set (a missing file is refused before preview;
// the next day's set repeats an edited check, which is updated rather than duplicated), Shopify's
// continuation rows filled down, and Square's item detail export with currency symbols, negative
// discounts and a refund row.

import { describe, expect, it } from "vitest";
import { count, importFiles, refusal, stage } from "./import-helpers.js";
import { inspect, newDataset } from "./helpers.js";

const csv = (rows: string[][]) => `${rows.map(row => row.join(",")).join("\n")}\n`;

function toastSet(day: "16" | "17") {
  const orders = [["Location", "Order Id", "Order #", "Checks", "Opened", "# of Guests", "Discount Amount", "Amount", "Tax", "Tip",
    "Gratuity", "Total", "Voided", "Paid", "Closed"]];
  const items = [["Location", "Order Id", "Order #", "Check Id", "Item Selection Id", "Menu Item", "Sales Category", "SKU",
    "Gross Price", "Discount", "Net Price", "Qty", "Tax", "Void?"]];
  const payments = [["Location", "Payment Id", "Order Id", "Paid Date", "Amount", "Tip", "Refund Amount", "Refund Date", "Type",
    "Card Type", "Status"]];
  const modifiers = [["Location", "Order Id", "Item Selection Id", "Modifier", "Parent Menu Selection Item ID", "Sales Cateogry",
    "Gross Price", "Qty", "Void?"]];
  if (day === "17") {
    orders.push(["Downtown", "100000002", "13", "1", "11/17/2026 12:00:00", "1", "0.00", "8.00", "0.64", "1.00", "0.00", "9.64", "false",
      "11/17/2026 12:30:00", "11/17/2026 12:31:00"]);
    items.push(["Downtown", "100000002", "13", "c-2", "sel-3", "Salad", "Food", "", "8.00", "0.00", "8.00", "1", "0.64", "false"]);
    payments.push(["Downtown", "pay-2", "100000002", "11/17/2026 12:30:00", "8.64", "1.00", "0.00", "", "Cash", "", "CAPTURED"]);
  }
  // The check of the 16th; on the 17th it reappears with a larger tip.
  const tip = day === "16" ? "3.00" : "5.00";
  const total = day === "16" ? "24.60" : "26.60";
  orders.push(["Downtown", "100000001", "12", "1", "11/16/2026 18:05:00", "2", "0.00", "20.00", "1.60", tip, "0.00", total, "false",
    "11/16/2026 19:00:00", "11/16/2026 19:01:00"]);
  items.push(
    ["Downtown", "100000001", "12", "c-1", "sel-1", "Burger", "Food", "BRG", "14.00", "0.00", "14.00", "1", "1.12", "false"],
    ["Downtown", "100000001", "12", "c-1", "sel-2", "Fries", "Food", "", "6.00", "0.00", "6.00", "1", "0.48", "false"],
  );
  payments.push(["Downtown", "pay-1", "100000001", "11/16/2026 19:00:00", "21.60", tip, "0.00", "", "Credit", "VISA", "CAPTURED"]);
  modifiers.push(["Downtown", "100000001", "mod-1", "Extra cheese", "sel-1", "Food", "1.00", "1", "false"]);
  return {
    orders: { name: "OrderDetails.csv", text: csv(orders) },
    items: { name: "ItemSelectionDetails.csv", text: csv(items) },
    payments: { name: "PaymentDetails.csv", text: csv(payments) },
    modifiers: { name: "ModifiersSelectionDetails.csv", text: csv(modifiers) },
  };
}

describe("Toast export set", () => {
  it("refuses a set with a required file missing before preview, naming the file", async () => {
    const { props, dataset } = newDataset();
    const set = toastSet("16");
    const importId = await stage(dataset, props.datasetId, [set.orders, set.items]);
    const staged = await dataset.getImport(props.datasetId, importId);
    expect(staged.templateMatches[0]).toMatchObject({ name: "Toast export set", origin: "builtin" });
    expect(staged.files.map(file => file.role)).toEqual(["OrderDetails", "ItemSelectionDetails"]);
    expect(staged.missingRequiredFiles).toEqual(["PaymentDetails"]);
    const message = "The file set is missing PaymentDetails; add it to the import.";
    expect(await refusal(dataset.previewImport(props.datasetId, importId, staged.deterministicMapping))).toBe(message);
    expect(await refusal(dataset.startImport(props.datasetId, importId, staged.deterministicMapping, undefined,
      { memberId: "member-1", canManage: false }))).toBe(message);
  });

  it("imports a set, then updates the next day's repeated check instead of duplicating it", async () => {
    const { props, dataset } = newDataset();
    const first = toastSet("16");
    const day16 = await importFiles(dataset, props.datasetId, [first.payments, first.modifiers, first.items, first.orders]);
    expect(day16.run.status).toBe("succeeded");
    expect(day16.run.counts.orders).toMatchObject({ written: 1 });
    expect(day16.run.counts.line_items).toMatchObject({ written: 2 });
    expect(day16.run.counts.transactions).toMatchObject({ written: 1 });
    const burger = await inspect<{ modifiers: string; gross_amount: number; unit_price_amount: number }>(
      dataset, "SELECT modifiers, gross_amount, unit_price_amount FROM store_line_items WHERE source_record_id = 'sel-1'");
    expect(burger).toEqual([{ modifiers: JSON.stringify([{ name: "Extra cheese", price_amount: 100, quantity: 1 }]), gross_amount: 1400, unit_price_amount: 1400 }]);
    const location = await inspect<{ name: string; kind: string; day_cutoff_minutes: number }>(
      dataset, "SELECT name, kind, day_cutoff_minutes FROM store_locations");
    expect(location).toEqual([{ name: "Downtown", kind: "restaurant", day_cutoff_minutes: 240 }]);

    const second = toastSet("17");
    const day17 = await importFiles(dataset, props.datasetId, [second.orders, second.items, second.payments],
      { target: day16.run.sourceId });
    expect(day17.run.counts.orders).toMatchObject({ written: 1, updated: 1 });
    expect(await count(dataset, "orders")).toBe(2);
    expect(await count(dataset, "line_items")).toBe(3);
    const orders = await inspect<{ source_record_id: string; business_date: string; tip_amount: number; total_amount: number }>(
      dataset, "SELECT source_record_id, business_date, tip_amount, total_amount FROM store_orders ORDER BY source_record_id");
    expect(orders).toEqual([
      { source_record_id: "100000001", business_date: "2026-11-16", tip_amount: 500, total_amount: 2660 },
      { source_record_id: "100000002", business_date: "2026-11-17", tip_amount: 100, total_amount: 964 },
    ]);
  });
});

describe("Shopify orders", () => {
  const header = ["Name", "Email", "Financial Status", "Paid at", "Accepts Marketing", "Currency", "Subtotal", "Shipping", "Taxes",
    "Total", "Discount Amount", "Created at", "Lineitem quantity", "Lineitem name", "Lineitem price", "Lineitem sku",
    "Lineitem discount", "Billing Name", "Payment Method", "Refunded Amount", "Id", "Location", "Phone"];
  const text = csv([
    header,
    ["#1001", "jane@example.com", "paid", "2026-11-10 12:00:00 -0500", "yes", "USD", "30.00", "5.00", "2.40", "37.40", "0.00",
      "2026-11-10 11:58:00 -0500", "1", "T-shirt", "20.00", "TS-1", "0.00", "Jane Smith", "Shopify Payments", "0.00", "5001", "", ""],
    ["#1001", "", "", "", "", "", "", "", "", "", "", "", "1", "Mug", "10.00", "MUG-1", "0.00", "", "", "", "", "", ""],
    ["#1002", "bob@example.com", "partially_refunded", "2026-11-11 09:00:00 -0500", "no", "USD", "15.00", "0.00", "1.20", "16.20",
      "0.00", "2026-11-11 08:59:00 -0500", "1", "Cap", "15.00", "CAP-1", "0.00", "Bob Lee", "Shopify Payments", "5.00", "5002", "", ""],
  ]);

  it("fills order fields down to continuation rows", async () => {
    const { props, dataset } = newDataset();
    const { run } = await importFiles(dataset, props.datasetId, [{ name: "orders_export.csv", text }]);
    expect(run.status).toBe("succeeded");
    expect(run.counts.orders).toMatchObject({ written: 2, rejected: 0 });
    expect(run.counts.line_items).toMatchObject({ written: 3, rejected: 0 });
    const orders = await inspect<{ source_record_id: string; order_number: string; status: string; channel: string; total_amount: number; tax_amount: number; service_charge_amount: number; gross_amount: number }>(
      dataset, "SELECT source_record_id, order_number, status, channel, total_amount, tax_amount, service_charge_amount, gross_amount FROM store_orders ORDER BY id");
    expect(orders).toEqual([
      { source_record_id: "5001", order_number: "#1001", status: "completed", channel: "online", total_amount: 3740, tax_amount: 240, service_charge_amount: 500, gross_amount: 3000 },
      { source_record_id: "5002", order_number: "#1002", status: "partially_refunded", channel: "online", total_amount: 1620, tax_amount: 120, service_charge_amount: 0, gross_amount: 1500 },
    ]);
    const transactions = await inspect<{ source_record_id: string; kind: string; amount: number; tender: string | null }>(
      dataset, "SELECT source_record_id, kind, amount, tender FROM store_transactions ORDER BY id");
    expect(transactions).toEqual([
      { source_record_id: "5001:payment", kind: "payment", amount: 3740, tender: "card" },
      { source_record_id: "5002:payment", kind: "payment", amount: 1620, tender: "card" },
      { source_record_id: "5002:payment:refund", kind: "refund", amount: 500, tender: null },
    ]);
    expect(await count(dataset, "customers")).toBe(2);
    const masked = await inspect<{ email: string }>(dataset, "SELECT email FROM customers ORDER BY id");
    expect(masked).toEqual([{ email: "j***@example.com" }, { email: "b***@example.com" }]);
  });
});

describe("Square item detail", () => {
  const header = ["Date", "Time", "Time Zone", "Category", "Item", "Qty", "Price Point Name", "SKU", "Modifiers Applied",
    "Gross Sales", "Discounts", "Net Sales", "Tax", "Transaction ID", "Payment ID", "Device Name", "Notes", "Details",
    "Event Type", "Location", "Dining Option", "Customer ID", "Customer Name", "Customer Reference ID", "Unit", "Count",
    "Itemization Type", "Channel"];
  const row = (values: Record<string, string>) => header.map(column => values[column] ?? "");
  const text = csv([
    header,
    row({ Date: "2026-11-12", Time: "08:15:02", Category: "Coffee", Item: "Latte", Qty: "2", "Price Point Name": "Large", SKU: "LAT-L",
      "Gross Sales": "$9.00", Discounts: "-$1.00", "Net Sales": "$8.00", Tax: "$0.72", "Transaction ID": "TX1", "Event Type": "Payment",
      Location: "Main St", Channel: "Point of Sale" }),
    row({ Date: "2026-11-12", Time: "08:15:02", Category: "Bakery", Item: "Croissant", Qty: "1", "Price Point Name": "Regular", SKU: "CRO",
      "Gross Sales": "$3.50", Discounts: "$0.00", "Net Sales": "$3.50", Tax: "$0.28", "Transaction ID": "TX1", "Event Type": "Payment",
      Location: "Main St", Channel: "Point of Sale" }),
    row({ Date: "2026-11-13", Time: "10:00:00", Category: "Coffee", Item: "Latte", Qty: "-1", "Price Point Name": "Large", SKU: "LAT-L",
      "Gross Sales": "-$4.50", Discounts: "$0.00", "Net Sales": "-$4.50", Tax: "-$0.36", "Transaction ID": "TX1", "Event Type": "Refund",
      Location: "Main St", Channel: "Point of Sale" }),
  ]);

  it("matches the export, derives the order total, and records the refund row as a return", async () => {
    const { props, dataset } = newDataset();
    const importId = await stage(dataset, props.datasetId, [{ name: "items-2026-11-12.csv", text }]);
    const staged = await dataset.getImport(props.datasetId, importId);
    expect(staged.templateMatches[0]).toMatchObject({ name: "Square item detail", origin: "builtin" });
    expect(staged.deterministicMapping?.orderKey).toBe("Transaction ID");

    const { run } = await importFiles(dataset, props.datasetId, [{ name: "items-2026-11-12.csv", text }]);
    expect(run.status).toBe("succeeded");
    expect(run.mappingVersion).toBe("builtin:square_item_detail:v1");
    const orders = await inspect<{ gross_amount: number; discount_amount: number; tax_amount: number; total_amount: number; channel: string; business_date: string }>(
      dataset, "SELECT gross_amount, discount_amount, tax_amount, total_amount, channel, business_date FROM store_orders");
    expect(orders).toEqual([{ gross_amount: 1250, discount_amount: 100, tax_amount: 100, total_amount: 1250, channel: "in_store", business_date: "2026-11-12" }]);
    const lines = await inspect<{ name: string; quantity_e4: number; unit_price_amount: number; gross_amount: number }>(
      dataset, "SELECT name, quantity_e4, unit_price_amount, gross_amount FROM store_line_items ORDER BY id");
    expect(lines).toEqual([
      { name: "Latte", quantity_e4: 20_000, unit_price_amount: 450, gross_amount: 900 },
      { name: "Croissant", quantity_e4: 10_000, unit_price_amount: 350, gross_amount: 350 },
    ]);
    const refunds = await inspect<{ kind: string; amount: number; sales_amount: number; tax_amount: number; business_date: string }>(
      dataset, "SELECT kind, amount, sales_amount, tax_amount, business_date FROM store_transactions");
    expect(refunds).toEqual([{ kind: "refund", amount: 486, sales_amount: 450, tax_amount: 36, business_date: "2026-11-13" }]);
    const returned = await inspect<{ quantity_e4: number; sales_amount: number; business_date: string }>(
      dataset, "SELECT quantity_e4, sales_amount, business_date FROM store_refund_items");
    expect(returned).toEqual([{ quantity_e4: 10_000, sales_amount: 450, business_date: "2026-11-13" }]);
    expect(await count(dataset, "products")).toBe(2);
  });
});
