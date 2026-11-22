// Sync correctness against provider list semantics: Stripe's events backstop applies every event
// oldest first across pages, Stripe orders are mapped with all their line-item pages, and a Square
// order re-read after a line was removed no longer counts that line.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mapLocation, mapOrder } from "../src/connectors/square-map.js";
import { StripeConnector, type StripeCreds } from "../src/connectors/stripe.js";
import type { ReadContext, ResourceQuery } from "../src/connectors/provider.js";
import type { IngestBatch } from "../src/dataset/ingest.js";
import { createSource, ingestRun, inspect, newDataset } from "./helpers.js";

const CREDS: StripeCreds = {
  accessToken: "sk-access", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(),
  accountId: "acct_1", livemode: false,
};
const CONTEXT: ReadContext = { locationIds: [], now: Date.now(), known: async () => new Set() };

type StripeObject = Record<string, unknown>;

/** A Stripe list endpoint over `items` (newest first), honouring limit / starting_after / ending_before. */
function listPage(items: StripeObject[], url: URL): { data: StripeObject[]; has_more: boolean } {
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const after = url.searchParams.get("starting_after");
  const before = url.searchParams.get("ending_before");
  if (before) {
    const end = items.findIndex(item => item.id === before);
    const start = Math.max(0, end - limit);
    return { data: items.slice(start, end), has_more: start > 0 };
  }
  const start = after ? items.findIndex(item => item.id === after) + 1 : 0;
  return { data: items.slice(start, start + limit), has_more: start + limit < items.length };
}

function stubStripe(routes: Record<string, (url: URL) => unknown>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`test: unexpected fetch ${url}`);
    return new Response(JSON.stringify(handler(url)), { headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs a resource's query to completion, as the connection's pass does, collecting each page's batch. */
async function drain(connector: StripeConnector, resource: "events" | "invoices", query: ResourceQuery) {
  const batches: IngestBatch[] = [];
  let next: ResourceQuery | null = query;
  let highs: string[] = [];
  for (let guard = 0; next && guard < 50; guard++) {
    const page = await connector.fetchPage(CREDS, resource, next, CONTEXT);
    batches.push(page.batch);
    if (page.high) highs = [...highs, page.high];
    next = page.next;
  }
  return { batches, highs };
}

describe("Stripe events backstop", () => {
  it("applies every event in a window of several pages, oldest first", async () => {
    // 250 updates of one customer, newest first as Stripe lists them; the newest name must win and
    // every event must be applied exactly once.
    const events = Array.from({ length: 250 }, (_, index) => {
      const n = 250 - index;
      return {
        id: `evt_${n}`, created: 1_700_000_000 + n,
        data: { object: { object: "customer", id: "cus_1", name: `Name ${n}` } },
      };
    });
    stubStripe({ "/v1/events": url => listPage(events, url) });
    const connector = new StripeConnector({ clientId: "ca_1", appSecret: "sk_app" });

    const { batches, highs } = await drain(connector, "events", { updatedSince: "2023-01-01T00:00:00Z" });

    const applied = batches.flatMap(batch => batch.customers ?? []).map(customer => customer.firstName);
    expect(applied).toHaveLength(250);
    expect(applied).toEqual(Array.from({ length: 250 }, () => "Name"));
    const lastNames = batches.flatMap(batch => batch.customers ?? []).map(customer => customer.lastName);
    expect(lastNames).toEqual(Array.from({ length: 250 }, (_, index) => String(index + 1)));
    // High-water marks only move forward.
    expect(highs).toEqual(highs.toSorted());
    expect(highs.at(-1)).toBe(new Date((1_700_000_000 + 250) * 1000).toISOString());
  });
});

describe("Stripe orders", () => {
  it("reads every page of an invoice's line items before mapping", async () => {
    const line = (n: number) => ({
      id: `il_${n}`, object: "line_item", amount: 1000, quantity: 1, currency: "usd", description: `Item ${n}`,
    });
    const invoice = {
      id: "in_1", object: "invoice", status: "paid", currency: "usd", created: 1_700_000_000,
      status_transitions: { paid_at: 1_700_000_100 }, subtotal: 3000, total: 3000, tax: 0,
      lines: { object: "list", data: [line(1)], has_more: true },
    };
    const rest = [line(2), line(3)];
    stubStripe({
      "/v1/invoices": url => listPage([invoice], url),
      "/v1/invoices/in_1/lines": url => listPage([line(1), ...rest], url),
    });
    const connector = new StripeConnector({ clientId: "ca_1", appSecret: "sk_app" });

    const { batches } = await drain(connector, "invoices", {});

    const lines = batches.flatMap(batch => batch.lineItems ?? []);
    expect(lines.map(item => item.sourceRecordId)).toEqual(["in_1:il_1", "in_1:il_2", "in_1:il_3"]);
    expect(batches.flatMap(batch => batch.orders ?? [])[0]).toMatchObject({ totalAmount: 3000, linesComplete: true });
  });
});

describe("Square order updates", () => {
  it("stops counting a line removed from an open order when the order is read again", async () => {
    const { props, dataset } = newDataset();
    const sourceId = await createSource(dataset, props.datasetId, "Square", "square");
    const money = (amount: number) => ({ amount, currency: "USD" });
    const latte = { uid: "li1", name: "Latte", quantity: "1", base_price_money: money(1000), gross_sales_money: money(1000) };
    const muffin = { uid: "li2", name: "Muffin", quantity: "1", base_price_money: money(500), gross_sales_money: money(500) };
    const squareOrder = (lines: object[], total: number, state: string) => ({
      id: "SQ-O1", location_id: "L1", state, created_at: "2026-11-10T15:00:00Z",
      closed_at: state === "COMPLETED" ? "2026-11-10T15:30:00Z" : undefined,
      total_money: money(total), line_items: lines,
    });
    const location = mapLocation({ id: "L1", name: "Main", timezone: "America/New_York", currency: "USD" })!;
    const batchOf = (order: object): IngestBatch => {
      const mapped = mapOrder(order);
      return { locations: [location], orders: [mapped.order!], lineItems: mapped.lineItems };
    };

    await ingestRun(dataset, props.datasetId, sourceId, batchOf(squareOrder([latte, muffin], 1500, "OPEN")), "sync");
    await ingestRun(dataset, props.datasetId, sourceId, batchOf(squareOrder([latte], 1000, "COMPLETED")), "sync");

    const [order] = await inspect<{ gross_amount: number; total_amount: number }>(
      dataset, "SELECT gross_amount, total_amount FROM store_orders");
    expect(order).toEqual({ gross_amount: 1000, total_amount: 1000 });
    const lines = await inspect<{ source_record_id: string; deleted: number }>(dataset,
      "SELECT source_record_id, deleted_at IS NOT NULL AS deleted FROM store_line_items ORDER BY source_record_id");
    expect(lines.map(row => [row.source_record_id.endsWith("li2"), row.deleted])).toEqual([[false, 0], [true, 1]]);
  });
});
