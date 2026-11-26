import { describe, expect, it } from "vitest";
import { propose } from "../src/import/propose.js";

const DEFAULTS = { timezone: "America/Toronto", currency: "CAD" };

describe("proposing a mapping from common POS headers", () => {
  it.each(["Receipt #", "Receipt No", "Check #", "Ticket Number", "Transaction #", "Order ID"])(
    "groups items into orders by %s",
    (header) => {
      const headers = [header, "Date", "Item", "Qty", "Unit Price", "Total"];
      const { mapping } = propose(
        [{ headers, sampleRows: [["R-10231", "10/01/2026 08:12", "Flat white", "2", "4.50", "9.81"]] }],
        [],
        DEFAULTS,
      );
      expect(mapping?.orderKey).toBe(header);
      expect(mapping?.fingerprint).toBeUndefined();
    },
  );

  it("reads database-style snake_case headers", () => {
    const headers = ["order_id", "product_id", "product_name", "quantity", "unit_price", "item_discount", "order_date", "store_location"];
    const { mapping } = propose(
      [{ headers, sampleRows: [["1", "340", "Potatoes", "1", "5.67", "0.0", "2025-03-11", "Store 10"]] }],
      [],
      DEFAULTS,
    );
    expect(mapping?.orderKey).toBe("order_id");
    expect(Object.fromEntries(mapping!.targets.map(target => [target.target, target.from]))).toEqual({
      "orders.opened_at": "order_date",
      "locations.name": "store_location",
      "line_items.name": "product_name",
      "line_items.quantity": "quantity",
      "line_items.unit_price_amount": "unit_price",
      "line_items.discount_amount": "item_discount",
      "products.sku": "product_id",
    });
  });

  it("treats each row as an order, identified by its fields, when no column names an order", () => {
    const headers = ["Date", "Item", "Qty", "Total"];
    const { mapping } = propose(
      [{ headers, sampleRows: [["10/01/2026 08:12", "Flat white", "2", "9.81"]] }],
      [],
      DEFAULTS,
    );
    expect(mapping?.orderKey).toBeNull();
    expect(mapping?.fingerprint?.length).toBeGreaterThan(0);
  });
});
