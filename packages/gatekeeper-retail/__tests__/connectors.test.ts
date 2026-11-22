// Provider connections (T051, US1): the connect handoff refuses a phished ticket, webhooks are
// verified before parsing, a revoked grant needs an administrator, a 429 backs off, and
// disconnecting with "delete data" removes only that source. Every provider request is mocked.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetailAppApi } from "../src/app-api.js";
import type { WorkItem } from "../src/connectors/planner.js";
import { SQUARE_SCOPES } from "../src/connectors/square.js";
import { createSource, ingestRun, inspect, line, location, newDataset, order } from "./helpers.js";

const BASE = "https://workshop.example/gatekeeper/retail";
const SQUARE = "https://connect.squareup.com";

class FakeAccess extends RpcTarget {
  constructor(private readonly canManage: boolean) {
    super();
  }

  async current(): Promise<{ canManage: boolean }> {
    return { canManage: this.canManage };
  }
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (url: URL, init: RequestInit) => Reply | undefined;

/** The mocked provider: per-route handlers, overridable per test, and a log of every request. */
let routes: Map<string, Handler>;
let requests: { method: string; url: URL; body: string }[];

function squareDefaults(): Map<string, Handler> {
  const order = {
    id: "SQ-O1", location_id: "L1", state: "COMPLETED", created_at: "2026-11-10T15:00:00Z",
    closed_at: "2026-11-10T15:05:00Z", updated_at: "2026-11-10T15:05:00Z",
    total_money: { amount: 1100, currency: "USD" }, total_tax_money: { amount: 100, currency: "USD" },
    line_items: [{
      uid: "li1", name: "Latte", quantity: "2", base_price_money: { amount: 500, currency: "USD" },
      gross_sales_money: { amount: 1000, currency: "USD" }, total_tax_money: { amount: 100, currency: "USD" },
    }],
  };
  return new Map<string, Handler>([
    ["POST /oauth2/token", () => ({
      body: {
        access_token: "square-access", refresh_token: "square-refresh", merchant_id: "M1",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    })],
    ["POST /oauth2/token/status", () => ({ body: { scopes: [...SQUARE_SCOPES], merchant_id: "M1" } })],
    ["POST /oauth2/revoke", () => ({ body: { success: true } })],
    ["GET /v2/merchants/M1", () => ({ body: { merchant: { id: "M1", business_name: "Corner Cafe" } } })],
    ["GET /v2/locations", () => ({
      body: { locations: [{ id: "L1", name: "Main", timezone: "America/New_York", currency: "USD", status: "ACTIVE" }] },
    })],
    ["POST /v2/catalog/search", () => ({ body: {} })],
    ["POST /v2/customers/search", () => ({ body: {} })],
    ["POST /v2/inventory/counts/batch-retrieve", () => ({ body: {} })],
    ["POST /v2/inventory/changes/batch-retrieve", () => ({ body: {} })],
    ["POST /v2/orders/search", (_url, init) => {
      // Only the newest window holds the order.
      const query = JSON.parse(String(init.body)) as { query: { filter: { date_time_filter: { created_at?: { end_at: string } } } } };
      const end = query.query.filter.date_time_filter.created_at?.end_at;
      const newest = !end || Date.parse(end) > Date.now() - 60_000;
      return { body: newest ? { orders: [order] } : {} };
    }],
    ["GET /v2/orders/SQ-O1", () => ({ body: { order } })],
    ["GET /v2/payments", () => ({ body: {} })],
    ["GET /v2/refunds", () => ({ body: {} })],
  ]);
}

beforeEach(() => {
  routes = squareDefaults();
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? "GET";
    requests.push({ method, url, body: typeof init.body === "string" ? init.body : String(init.body ?? "") });
    if (url.origin !== SQUARE) throw new Error(`test: unexpected fetch ${method} ${url}`);
    const reply = routes.get(`${method} ${url.pathname}`)?.(url, init);
    if (!reply) throw new Error(`test: unexpected fetch ${method} ${url}`);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function appApi(datasetId: string, canManage = true, providers: ("square" | "stripe")[] = ["square", "stripe"]): RetailAppApi {
  return new RetailAppApi({
    dataset: newDatasetStub(datasetId),
    datasetId,
    access: new RpcStub(new FakeAccess(canManage)) as never,
    memberId: "admin-1",
    connections: env.RETAIL_CONNECTION,
    sharingDomain: "test",
    providers,
    baseUrl: BASE,
  });
}

function newDatasetStub(datasetId: string) {
  return env.RETAIL_DATASET.getByName(`test\0dataset\0${datasetId}`);
}

/** Starts a flow and completes the provider callback: the ticket the handoff page carries. */
async function startAndCallback(api: RetailAppApi): Promise<{ nonce: string; ticket: string }> {
  const { url, nonce } = await api.beginConnect("square");
  const state = new URL(url).searchParams.get("state")!;
  const response = await SELF.fetch(`${BASE}/oauth/square?code=auth-code&state=${encodeURIComponent(state)}`);
  const html = await response.text();
  expect(response.status).toBe(200);
  const ticket = /var ticket = "([0-9a-f]{64})"/.exec(html)?.[1];
  expect(ticket).toBeDefined();
  expect(html).toContain("https://workshop.example");
  return { nonce, ticket: ticket! };
}

/** Connects Square to a fresh dataset and chooses its one location. */
async function connected() {
  const { props, dataset } = newDataset();
  const api = appApi(props.datasetId);
  const { nonce, ticket } = await startAndCallback(api);
  const { sourceId } = await api.redeemConnectHandoff(ticket, nonce);
  const name = (await dataset.sourceConnection(props.datasetId, sourceId))!.connectionName!;
  const connection = env.RETAIL_CONNECTION.getByName(name);
  return { props, dataset, api, sourceId, connection, name };
}

async function sourceStatus(api: RetailAppApi, sourceId: number) {
  const overview = await api.getOverview();
  return { source: overview.sources.find(source => source.id === sourceId)!, failures: overview.failuresNeedingAdmin };
}

function workItem(connection: DurableObjectStub, key: string): Promise<WorkItem<unknown> | undefined> {
  return runInDurableObject(connection, (_instance, state) => state.storage.kv.get<WorkItem<unknown>>(`work:${key}`));
}

/** Runs the connection's alarm until `done()` or the step budget is spent. */
async function runAlarms(connection: DurableObjectStub, done: () => Promise<boolean>, steps = 60): Promise<void> {
  for (let step = 0; step < steps && !await done(); step++) {
    // Make whatever is queued due now.
    await runInDurableObject(connection, async (_instance, state) => {
      for (const [key, item] of state.storage.kv.list<WorkItem<unknown>>({ prefix: "work:" })) {
        if (key === "work:sync" || key === "work:reread" || key === "work:refresh" || key === "work:housekeeping") continue;
        state.storage.kv.put(key, { ...item, dueAt: 0 });
      }
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(connection);
  }
  expect(await done()).toBe(true);
}

async function squareSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("test-square-signature-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${BASE}/webhooks/square${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe("connect handoff", () => {
  it("refuses a ticket redeemed in another organization's Data area (phished handoff)", async () => {
    const attacker = newDataset();
    const victim = newDataset();
    // The attacker starts a flow and the victim completes the provider's consent with it.
    const { ticket, nonce } = await startAndCallback(appApi(attacker.props.datasetId));
    // The victim's popup lands on the handoff page and redeems over the victim's own session.
    await expect(appApi(victim.props.datasetId).redeemConnectHandoff(ticket, nonce))
      .rejects.toThrow(/not started from this organization/);
    expect((await appApi(victim.props.datasetId).getOverview()).sources).toEqual([]);
    expect((await appApi(attacker.props.datasetId).getOverview()).sources).toEqual([]);
  });

  it("refuses a wrong nonce, revokes the staged grant, and is single use", async () => {
    const { props } = newDataset();
    const api = appApi(props.datasetId);
    const { ticket } = await startAndCallback(api);
    await expect(api.redeemConnectHandoff(ticket, "0".repeat(64))).rejects.toThrow(/could not be completed/);
    expect(requests.some(request => request.url.pathname === "/oauth2/revoke")).toBe(true);
    // The ticket is spent.
    await expect(api.redeemConnectHandoff(ticket, "0".repeat(64))).rejects.toThrow(/not started from this organization/);
    expect((await api.getOverview()).sources).toEqual([]);
  });

  it("refuses an expired or replayed OAuth state, and a grant with write scopes", async () => {
    const { props } = newDataset();
    const api = appApi(props.datasetId);
    const { url } = await api.beginConnect("square");
    const state = new URL(url).searchParams.get("state")!;
    routes.set("POST /oauth2/token/status", () => ({ body: { scopes: [...SQUARE_SCOPES, "ORDERS_WRITE"] } }));
    const overScoped = await SELF.fetch(`${BASE}/oauth/square?code=c&state=${encodeURIComponent(state)}`);
    expect(overScoped.status).toBe(400);
    expect(await overScoped.text()).toContain("read-only");
    expect(requests.some(request => request.url.pathname === "/oauth2/revoke")).toBe(true);
    const replayed = await SELF.fetch(`${BASE}/oauth/square?code=c&state=${encodeURIComponent(state)}`);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toContain("expired");
  });

  it("refuses members: connecting is for administrators", async () => {
    const { props } = newDataset();
    await expect(appApi(props.datasetId, false).beginConnect("square")).rejects.toThrow(/Only organization administrators/);
  });

  it("refuses a provider the deployment has no credentials for", async () => {
    const { props } = newDataset();
    const api = appApi(props.datasetId, true, ["square"]);
    await expect(api.beginConnect("stripe")).rejects.toThrow(/not configured/);
    expect((await api.getOverview()).connectableProviders).toEqual(["square"]);
  });

  it("commits the grant on a matching redemption and backfills the chosen locations", async () => {
    const { props, api, sourceId, connection } = await connected();
    expect((await sourceStatus(api, sourceId)).source).toMatchObject({ kind: "square", label: "Corner Cafe", status: "connecting" });
    expect(await api.listProviderLocations(sourceId)).toEqual([
      { id: "L1", name: "Main", timezone: "America/New_York", currency: "USD", active: true },
    ]);
    await api.chooseLocations(sourceId, ["L1"]);
    expect((await sourceStatus(api, sourceId)).source.status).toBe("backfilling");
    await runAlarms(connection, async () => (await workItem(connection, "backfill")) === undefined);
    expect((await sourceStatus(api, sourceId)).source.status).toBe("active");
    const rows = await inspect<{ source_record_id: string; total_amount: number }>(
      newDatasetStub(props.datasetId), "SELECT source_record_id, total_amount FROM store_orders WHERE source_id = ?", sourceId);
    expect(rows).toEqual([{ source_record_id: "SQ-O1", total_amount: 1100 }]);
    // The newest window was read first.
    const searches = requests.filter(request => request.url.pathname === "/v2/orders/search")
      .map(request => (JSON.parse(request.body) as { query: { filter: { date_time_filter: { created_at: { end_at: string } } } } })
        .query.filter.date_time_filter.created_at.end_at);
    expect(Date.parse(searches[0]!)).toBeGreaterThan(Date.parse(searches.at(-1)!));
  });
});

describe("webhooks", () => {
  it("rejects unsigned and forged Square events before parsing, and routes signed ones", async () => {
    const { api, sourceId, connection } = await connected();
    await api.chooseLocations(sourceId, ["L1"]);
    const body = JSON.stringify({
      merchant_id: "M1", type: "order.updated", event_id: "evt-1", data: { type: "order", id: "SQ-O1" },
    });
    const unsigned = await SELF.fetch(`${BASE}/webhooks/square`, { method: "POST", body });
    expect(unsigned.status).toBe(401);
    const forged = await SELF.fetch(`${BASE}/webhooks/square`, {
      method: "POST", body, headers: { "x-square-hmacsha256-signature": await squareSignature(`${body} `) },
    });
    expect(forged.status).toBe(401);
    // Not even malformed JSON is parsed without a valid signature.
    const garbage = await SELF.fetch(`${BASE}/webhooks/square`, {
      method: "POST", body: "{not json", headers: { "x-square-hmacsha256-signature": "AAAA" },
    });
    expect(garbage.status).toBe(401);
    expect(await workItem(connection, "refetch:order:SQ-O1")).toBeUndefined();

    const signed = await SELF.fetch(`${BASE}/webhooks/square`, {
      method: "POST", body, headers: { "x-square-hmacsha256-signature": await squareSignature(body) },
    });
    expect(signed.status).toBe(200);
    expect(await workItem(connection, "refetch:order:SQ-O1")).toMatchObject({ payload: { kind: "refetch" } });
    // The same event again is a duplicate.
    await runInDurableObject(connection, (_instance, state) => state.storage.kv.delete("work:refetch:order:SQ-O1"));
    await SELF.fetch(`${BASE}/webhooks/square`, {
      method: "POST", body, headers: { "x-square-hmacsha256-signature": await squareSignature(body) },
    });
    expect(await workItem(connection, "refetch:order:SQ-O1")).toBeUndefined();
  });

  it("rejects an oversized body", async () => {
    const response = await SELF.fetch(`${BASE}/webhooks/square`, {
      method: "POST", body: "x".repeat(1024 * 1024 + 1), headers: { "x-square-hmacsha256-signature": "AAAA" },
    });
    expect(response.status).toBe(413);
  });

  it("rejects Stripe events with a bad or stale signature", async () => {
    const body = JSON.stringify({ id: "evt_1", account: "acct_1", data: { object: { object: "charge", id: "ch_1" } } });
    const sign = async (timestamp: number) => {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
      return `t=${timestamp},v1=${Array.from(mac, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect((await SELF.fetch(`${BASE}/webhooks/stripe`, { method: "POST", body })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/webhooks/stripe`, {
      method: "POST", body, headers: { "stripe-signature": await sign(now - 600) },
    })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/webhooks/stripe`, {
      method: "POST", body, headers: { "stripe-signature": await sign(now) },
    })).status).toBe(200);
  });
});

describe("sync failures", () => {
  it("moves a source whose grant was revoked (401) to needs_reconnect", async () => {
    const { api, sourceId, connection } = await connected();
    await api.chooseLocations(sourceId, ["L1"]);
    routes.set("GET /v2/locations", () => ({ status: 401, body: { errors: [{ code: "UNAUTHORIZED" }] } }));
    routes.set("POST /oauth2/token", () => ({ status: 401, body: { errors: [{ code: "UNAUTHORIZED" }] } }));
    await runAlarms(connection, async () => (await sourceStatus(api, sourceId)).source.status === "needs_reconnect", 3);
    const { failures } = await sourceStatus(api, sourceId);
    expect(failures).toEqual([expect.objectContaining({ sourceId, code: "UNAUTHORIZED" })]);
    // Nothing keeps reading with the dead grant.
    expect(await workItem(connection, "backfill")).toBeUndefined();
    expect(await workItem(connection, "sync")).toBeUndefined();
    await expect(api.syncNow(sourceId)).rejects.toThrow(/Reconnect/);
  });

  it("backs off on 429, at least as long as Retry-After", async () => {
    const { api, sourceId, connection } = await connected();
    await api.chooseLocations(sourceId, ["L1"]);
    routes.set("GET /v2/locations", () => ({ status: 429, body: { errors: [{ code: "RATE_LIMITED" }] }, headers: { "retry-after": "120" } }));
    const before = Date.now();
    await runInDurableObject(connection, async (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(connection);
    const item = await workItem(connection, "backfill");
    expect(item?.attempts).toBe(1);
    expect(item!.dueAt - before).toBeGreaterThanOrEqual(120_000);
    expect((await sourceStatus(api, sourceId)).source.status).toBe("retrying");
    // The next failure doubles the base backoff, still capped at an hour.
    await runInDurableObject(connection, async (_instance, state) => {
      state.storage.kv.put("work:backfill", { ...item!, dueAt: 0 });
      await state.storage.setAlarm(Date.now());
    });
    routes.set("GET /v2/locations", () => ({ status: 429, body: {} }));
    await runDurableObjectAlarm(connection);
    const again = await workItem(connection, "backfill");
    expect(again?.attempts).toBe(2);
    expect(again!.dueAt - Date.now()).toBeGreaterThanOrEqual(59_000);
    expect(again!.dueAt - Date.now()).toBeLessThanOrEqual(3_600_000);
  });
});

describe("disconnect", () => {
  it("with delete removes only that source's rows, raw objects and rollups", async () => {
    const { props, dataset, api, sourceId, connection, name } = await connected();
    expect(await env.RETAIL_WEBHOOK_ROUTE.getByName("route\0square\0M1").connections()).toContain(name);
    await api.chooseLocations(sourceId, ["L1"]);
    await runAlarms(connection, async () => (await workItem(connection, "backfill")) === undefined);
    // A CSV source in the same dataset, with its own raw file.
    const csvId = await createSource(dataset, props.datasetId, "Toast export");
    const { runId } = await ingestRun(dataset, props.datasetId, csvId, {
      locations: [location()],
      orders: [order({ sourceRecordId: "csv-1", totalAmount: 700 })],
      lineItems: [line({ sourceRecordId: "csv-1-l", orderRef: "csv-1" })],
    });
    await dataset.putRawObject(props.datasetId, { sourceId: csvId, runId, kind: "csv_file" }, new Blob(["a,b\n"]).stream(), 4);
    const prefix = `ds/${props.datasetId}/src/`;
    expect((await env.RETAIL_RAW.list({ prefix: `${prefix}${sourceId}/` })).objects.length).toBeGreaterThan(0);

    await api.disconnect(sourceId, { deleteData: true });
    expect(requests.some(request => request.url.pathname === "/oauth2/revoke")).toBe(true);
    await runAlarms(connection, async () =>
      runInDurableObject(connection, (_instance, state) => [...state.storage.kv.list({ limit: 1 })].length === 0));

    const orders = await inspect<{ source_id: number }>(dataset, "SELECT source_id FROM store_orders");
    expect(orders).toEqual([{ source_id: csvId }]);
    const salesSources = await inspect<{ source_id: number }>(dataset, "SELECT DISTINCT source_id FROM store_daily_source_coverage");
    expect(salesSources).toEqual([{ source_id: csvId }]);
    const sales = await inspect<{ n: number }>(dataset, "SELECT SUM(orders) AS n FROM store_daily_sales");
    expect(sales).toEqual([{ n: 1 }]);
    expect((await env.RETAIL_RAW.list({ prefix: `${prefix}${sourceId}/` })).objects).toEqual([]);
    expect((await env.RETAIL_RAW.list({ prefix: `${prefix}${csvId}/` })).objects.length).toBe(1);
    const { source } = await sourceStatus(api, sourceId);
    expect(source).toMatchObject({ status: "disconnected", coverageFrom: null });
    // Nothing of the connection is routed any more.
    expect(await env.RETAIL_WEBHOOK_ROUTE.getByName("route\0square\0M1").connections()).not.toContain(name);
  });

  it("without delete keeps the source's data", async () => {
    const { props, api, sourceId, connection } = await connected();
    await api.chooseLocations(sourceId, ["L1"]);
    await runAlarms(connection, async () => (await workItem(connection, "backfill")) === undefined);
    await api.disconnect(sourceId, { deleteData: false });
    await runAlarms(connection, async () =>
      runInDurableObject(connection, (_instance, state) => [...state.storage.kv.list({ limit: 1 })].length === 0));
    const rows = await inspect<{ n: number }>(newDatasetStub(props.datasetId), "SELECT COUNT(*) AS n FROM store_orders WHERE source_id = ?", sourceId);
    expect(rows).toEqual([{ n: 1 }]);
    expect((await sourceStatus(api, sourceId)).source.status).toBe("disconnected");
  });
});
