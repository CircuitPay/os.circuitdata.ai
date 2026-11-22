// The Stripe connector (research R14): a public Stripe App with the OAuth install flow and `*_read`
// permissions only. Access tokens last 1 hour; refresh tokens rotate on every refresh, under the
// kit's `CredentialCoordinator` (the connection's). Backfill reads `created` windows with
// `limit=100` and `starting_after`; the steady state is webhooks plus `/v1/events` as the backstop.

import { CredentialsExpiredError } from "@gadgets/gatekeeper-kit/credentials";
import type { IngestBatch } from "../dataset/ingest.js";
import {
  ProviderError, providerJson,
  type Connector, type ExchangedGrant, type FetchedPage, type ProviderLocation, type ReadContext,
  type RefetchTarget, type ResourceQuery, type SyncResource,
} from "./provider.js";
import {
  STRIPE_FEE_TYPES, isStripeObject, mapAccountLocation, mapCharge, mapCheckoutSession, mapFee, mapInvoice,
  mapPayout, mapStripeCustomer, mapStripePrice, mapStripeProduct, mapStripeRefund, stripeLocationId,
  type StripeObject,
} from "./stripe-map.js";

const API = "https://api.stripe.com";
const AUTHORIZE = "https://marketplace.stripe.com/oauth/v2/authorize";
/** Stripe's documented access-token lifetime, used when a response omits `expires_in`. */
const ACCESS_TOKEN_MS = 3_600_000;
/** A reconnect after this long runs a full backfill (research R14): `/v1/events` keeps 30 days. */
export const STRIPE_EVENTS_RETENTION_MS = 30 * 86_400_000;

/** The event types the events backstop and webhooks act on, and the object each refetches. */
export const STRIPE_EVENT_OBJECTS: Readonly<Record<string, string>> = {
  charge: "charge",
  refund: "refund",
  "charge.refund": "refund",
  customer: "customer",
  invoice: "invoice",
  "checkout.session": "checkout.session",
  product: "product",
  price: "price",
  payout: "payout",
};

/** A Stripe App grant as the connection stores it. */
export type StripeCreds = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  obtainedAt: number;
  accountId: string;
  livemode: boolean;
};

export type StripeConfig = { clientId: string; appSecret: string };

/** Reads the Stripe App configuration, or throws when the deployment has none. */
export function stripeConfig(env: Cloudflare.Env): StripeConfig {
  const clientId = env.STRIPE_CLIENT_ID;
  const appSecret = env.STRIPE_APP_SECRET;
  if (!clientId || !appSecret) throw new Error("Stripe is not configured on this deployment.");
  return { clientId, appSecret };
}

function stripeErrorCode(body: unknown): string | undefined {
  if (!isStripeObject(body)) return undefined;
  const error = body.error;
  const code = isStripeObject(error) ? error.code ?? error.type : error;
  return typeof code === "string" ? code : undefined;
}

export class StripeConnector implements Connector<StripeCreds> {
  readonly kind = "stripe" as const;
  readonly label = "Stripe";
  readonly fullResources: readonly SyncResource[] = ["locations", "products", "customers"];
  readonly windowedResources: readonly SyncResource[] = [
    "invoices", "checkout_sessions", "payments", "refunds", "payouts", "fees",
  ];
  readonly incrementalResources: readonly SyncResource[] = ["events"];
  readonly refreshSkewMs = 5 * 60_000;

  readonly #config: StripeConfig;

  constructor(config: StripeConfig) {
    this.#config = config;
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchange(params: URLSearchParams, _redirectUri: string): Promise<ExchangedGrant<StripeCreds>> {
    const code = params.get("code");
    if (!code) throw new Error("Stripe did not return an authorization code.");
    const obtainedAt = Date.now();
    const body = await this.#token({ grant_type: "authorization_code", code });
    const creds = tokenCreds(body, obtainedAt);
    // A Stripe App token acts within the app's declared permissions, which are all `*_read`; a
    // Connect `read_write` token must never be accepted in its place (FR-003).
    if (!creds || body.scope === "read_write") {
      if (creds) await this.revoke(creds).catch(() => undefined);
      throw new Error("The Stripe grant does not match the read-only access requested.");
    }
    const account = await this.#get(creds, "/v1/account").then(({ body }) => body).catch(() => ({}));
    const location = mapAccountLocation(creds.accountId, account);
    return { creds, externalAccountId: creds.accountId, externalAccountLabel: location.name };
  }

  expiresAt(creds: StripeCreds): number {
    return creds.expiresAt;
  }

  isStale(): boolean {
    // Refresh tokens last a year and rotate on use; the hourly refresh keeps them fresh.
    return false;
  }

  async refresh(creds: StripeCreds): Promise<StripeCreds> {
    let body: Record<string, unknown>;
    const obtainedAt = Date.now();
    try {
      body = await this.#token({ grant_type: "refresh_token", refresh_token: creds.refreshToken });
    } catch (error) {
      if (error instanceof ProviderError && (error.failure === "auth" || error.status === 400)) {
        throw new CredentialsExpiredError("The Stripe grant was revoked.", { cause: error });
      }
      throw error;
    }
    const minted = tokenCreds(body, obtainedAt);
    if (!minted) throw new ProviderError("Stripe", "transient", 200, "malformed");
    return { ...minted, accountId: creds.accountId };
  }

  async revoke(creds: StripeCreds): Promise<void> {
    try {
      await providerJson("Stripe", `${API}/v1/oauth/deauthorize`, {
        method: "POST",
        headers: { "Authorization": this.#basic(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.#config.clientId, stripe_user_id: creds.accountId }),
      }, stripeErrorCode);
    } catch (error) {
      if (error instanceof ProviderError && error.failure === "auth") return;
      throw error;
    }
  }

  async listLocations(creds: StripeCreds): Promise<ProviderLocation[]> {
    const { body } = await this.#get(creds, "/v1/account").catch(() => ({ body: {} }));
    const location = mapAccountLocation(creds.accountId, body);
    return [{ id: location.sourceRecordId, name: location.name, timezone: location.timezone, currency: location.currency, active: true }];
  }

  async fetchPage(creds: StripeCreds, resource: SyncResource, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    const locationRef = stripeLocationId(creds.accountId);
    switch (resource) {
      case "locations": {
        const { body, text } = await this.#get(creds, "/v1/account").catch(() => ({ body: {}, text: "{}" }));
        return { batch: { locations: [mapAccountLocation(creds.accountId, body)] }, raw: text, fetched: 1, next: null, high: null };
      }
      case "products": return this.#products(creds, query);
      case "customers":
        return this.#list(creds, "/v1/customers", query, {}, objects => ({
          customers: objects.map(mapStripeCustomer).filter(record => record !== null),
        }));
      case "invoices":
        return this.#list(creds, "/v1/invoices", query, {}, objects => this.#orders(objects.map(invoice => mapInvoice(invoice, locationRef))), context);
      case "checkout_sessions":
        return this.#list(creds, "/v1/checkout/sessions", query, { "expand[]": "data.line_items", status: "complete" },
          objects => this.#orders(objects.map(session => mapCheckoutSession(session, locationRef))), context);
      case "payments":
        return this.#list(creds, "/v1/charges", query, { "expand[]": "data.balance_transaction" }, objects => ({
          transactions: objects.map(charge => mapCharge(charge, locationRef)).filter(record => record !== null),
        }), context);
      case "refunds":
        return this.#list(creds, "/v1/refunds", query, {}, objects => ({
          transactions: objects.map(refund => mapStripeRefund(refund, locationRef)).filter(record => record !== null),
        }), context);
      case "payouts":
        return this.#list(creds, "/v1/payouts", query, {}, objects => ({
          transactions: objects.map(mapPayout).filter(record => record !== null),
        }));
      case "fees":
        return this.#list(creds, "/v1/balance_transactions", query, {}, objects => ({
          transactions: objects.filter(object => (STRIPE_FEE_TYPES as readonly unknown[]).includes(object.type))
            .map(mapFee).filter(record => record !== null),
        }));
      case "events": return this.#events(creds, query, context);
      default: throw new Error(`Stripe has no ${resource} resource.`);
    }
  }

  async refetch(creds: StripeCreds, target: RefetchTarget, context: ReadContext): Promise<FetchedPage | null> {
    const paths: Record<string, string> = {
      charge: "/v1/charges/", refund: "/v1/refunds/", customer: "/v1/customers/", invoice: "/v1/invoices/",
      "checkout.session": "/v1/checkout/sessions/", product: "/v1/products/", price: "/v1/prices/",
      payout: "/v1/payouts/",
    };
    const path = paths[target.type];
    if (!path) return null;
    const expand = target.type === "charge" ? "?expand[]=balance_transaction"
      : target.type === "checkout.session" ? "?expand[]=line_items" : "";
    const { body, text } = await this.#get(creds, `${path}${encodeURIComponent(target.id)}${expand}`);
    return { batch: await this.#mapOne(creds, target.type, body, context), raw: text, fetched: 1, next: null, high: null };
  }

  /** One object of a refetch or an event → its records. */
  async #mapOne(creds: StripeCreds, type: string, object: StripeObject, context: ReadContext): Promise<IngestBatch> {
    const locationRef = stripeLocationId(creds.accountId);
    let batch: IngestBatch;
    switch (type) {
      case "charge": batch = { transactions: [mapCharge(object, locationRef)].filter(record => record !== null) }; break;
      case "refund": batch = { transactions: [mapStripeRefund(object, locationRef)].filter(record => record !== null) }; break;
      case "payout": batch = { transactions: [mapPayout(object)].filter(record => record !== null) }; break;
      case "customer": batch = { customers: [mapStripeCustomer(object)].filter(record => record !== null) }; break;
      case "product": batch = { products: [mapStripeProduct(object)].filter(record => record !== null) }; break;
      case "price": batch = { products: [mapStripePrice(object, null)].filter(record => record !== null) }; break;
      case "invoice": batch = this.#orders([mapInvoice(object, locationRef)]); break;
      case "checkout.session": {
        // Events carry sessions without their line items; read them.
        const id = typeof object.id === "string" ? object.id : "";
        const session = id && !object.line_items
          ? (await this.#get(creds, `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`)).body
          : object;
        batch = this.#orders([mapCheckoutSession(session, locationRef)]);
        break;
      }
      default: return {};
    }
    return this.#unlinkUnknown(batch, context);
  }

  #orders(mapped: { order: IngestBatch["orders"] extends (infer O)[] | undefined ? O | null : never; lineItems: NonNullable<IngestBatch["lineItems"]> }[]): IngestBatch {
    return {
      orders: mapped.map(item => item.order).filter(order => order !== null),
      lineItems: mapped.filter(item => item.order !== null).flatMap(item => item.lineItems),
    };
  }

  /** References to records this source has not read become null rather than rejections. */
  async #unlinkUnknown(batch: IngestBatch, context: ReadContext): Promise<IngestBatch> {
    const customers = new Set(batch.customers?.map(customer => customer.sourceRecordId));
    const orders = new Set(batch.orders?.map(order => order.sourceRecordId));
    const transactions = new Set(batch.transactions?.map(transaction => transaction.sourceRecordId));
    const products = new Set(batch.products?.map(product => product.sourceRecordId));
    const unknown = async (table: "customers" | "orders" | "transactions" | "products", inBatch: Set<string>, refs: (string | null | undefined)[]) => {
      const wanted = [...new Set(refs.filter((id): id is string => !!id && !inBatch.has(id)))];
      const known = await context.known(table, wanted);
      return new Set(wanted.filter(id => !known.has(id)));
    };
    const missingCustomers = await unknown("customers", customers, batch.orders?.map(order => order.customerRef) ?? []);
    for (const order of batch.orders ?? []) if (order.customerRef && missingCustomers.has(order.customerRef)) order.customerRef = null;
    const missingProducts = await unknown("products", products, [
      ...batch.lineItems?.map(line => line.productRef) ?? [], ...batch.products?.map(product => product.parentRef) ?? [],
    ]);
    for (const line of batch.lineItems ?? []) if (line.productRef && missingProducts.has(line.productRef)) line.productRef = null;
    for (const product of batch.products ?? []) if (product.parentRef && missingProducts.has(product.parentRef)) product.parentRef = null;
    const missingOrders = await unknown("orders", orders, batch.transactions?.map(transaction => transaction.orderRef) ?? []);
    const missingParents = await unknown("transactions", transactions, batch.transactions?.map(transaction => transaction.parentRef) ?? []);
    for (const transaction of batch.transactions ?? []) {
      if (transaction.orderRef && missingOrders.has(transaction.orderRef)) transaction.orderRef = null;
      if (transaction.parentRef && missingParents.has(transaction.parentRef)) transaction.parentRef = null;
    }
    return batch;
  }

  /** Products, then prices: the page cursor names which (`product:<id>` / `price:<id>`). */
  async #products(creds: StripeCreds, query: ResourceQuery): Promise<FetchedPage> {
    const phase = query.page?.startsWith("price:") ? "price" : "product";
    const after = query.page?.slice(phase.length + 1) ?? "";
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("starting_after", after);
    if (phase === "price") params.append("expand[]", "data.product");
    const { body, text } = await this.#get(creds, `/v1/${phase}s?${params}`);
    const objects = dataOf(body);
    const products = phase === "product"
      ? objects.map(mapStripeProduct).filter(record => record !== null)
      : objects.map(price => mapStripePrice(price, null)).filter(record => record !== null);
    const last = objects.at(-1)?.id;
    let next: ResourceQuery | null = null;
    if (body.has_more === true && typeof last === "string") next = { ...query, page: `${phase}:${last}` };
    else if (phase === "product") next = { ...query, page: "price:" };
    return { batch: { products }, raw: text, fetched: objects.length, next, high: null };
  }

  /** One page of a list endpoint over a `created` window, newest first. */
  async #list(
    creds: StripeCreds, path: string, query: ResourceQuery, extra: Record<string, string>,
    map: (objects: StripeObject[]) => IngestBatch, context?: ReadContext,
  ): Promise<FetchedPage> {
    const params = new URLSearchParams({ limit: "100", ...extra });
    if (query.from) params.set("created[gte]", String(Math.floor(Date.parse(query.from) / 1000)));
    if (query.to) params.set("created[lt]", String(Math.floor(Date.parse(query.to) / 1000)));
    if (query.page) params.set("starting_after", query.page);
    const { body, text } = await this.#get(creds, `${path}?${params}`);
    const objects = dataOf(body);
    const batch = context ? await this.#unlinkUnknown(map(objects), context) : map(objects);
    const last = objects.at(-1)?.id;
    return {
      batch,
      raw: text,
      fetched: objects.length,
      next: body.has_more === true && typeof last === "string" ? { ...query, page: last } : null,
      high: null,
    };
  }

  /**
   * The events backstop: `/v1/events` since the last seen event time, oldest first by walking
   * `ending_before`. Events read with our own credentials are provider data, so their snapshot is
   * mapped directly; objects whose snapshot lacks what we need are read again.
   */
  async #events(creds: StripeCreds, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    const params = new URLSearchParams({ limit: "100" });
    const since = query.updatedSince ? Math.floor(Date.parse(query.updatedSince) / 1000) : null;
    if (since !== null) params.set("created[gte]", String(since));
    if (query.page) params.set("ending_before", query.page);
    const { body, text } = await this.#get(creds, `/v1/events?${params}`);
    // Stripe lists newest first; process oldest first so later states win.
    const events = dataOf(body).toReversed();
    const merged: Required<Pick<IngestBatch, "customers" | "products" | "orders" | "lineItems" | "transactions">> = {
      customers: [], products: [], orders: [], lineItems: [], transactions: [],
    };
    let high: string | null = null;
    for (const event of events) {
      const object = isStripeObject(event.data) && isStripeObject(event.data.object) ? event.data.object : null;
      const type = typeof object?.object === "string" ? STRIPE_EVENT_OBJECTS[object.object] : undefined;
      if (typeof event.created === "number") high = new Date(event.created * 1000).toISOString();
      if (!object || !type) continue;
      const batch = await this.#mapOne(creds, type, object, context);
      for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
        const records = batch[key];
        if (records) (merged[key] as unknown[]).push(...records);
      }
    }
    const newestId = events.at(-1)?.id;
    return {
      batch: merged,
      raw: text,
      fetched: events.length,
      next: body.has_more === true && typeof newestId === "string" ? { ...query, page: newestId } : null,
      high,
    };
  }

  #basic(): string {
    return `Basic ${btoa(`${this.#config.appSecret}:`)}`;
  }

  async #token(form: Record<string, string>): Promise<Record<string, unknown>> {
    const { body } = await providerJson("Stripe", `${API}/v1/oauth/token`, {
      method: "POST",
      headers: { "Authorization": this.#basic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    }, stripeErrorCode);
    return body;
  }

  #get(creds: StripeCreds, path: string) {
    return providerJson("Stripe", `${API}${path}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${creds.accessToken}` },
    }, stripeErrorCode);
  }
}

function tokenCreds(body: Record<string, unknown>, obtainedAt: number): StripeCreds | null {
  const { access_token: accessToken, refresh_token: refreshToken, stripe_user_id: accountId, expires_in: expiresIn } = body;
  if (typeof accessToken !== "string" || !accessToken || typeof accountId !== "string" || !accountId) return null;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt: obtainedAt + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : ACCESS_TOKEN_MS),
    obtainedAt,
    accountId,
    livemode: body.livemode === true,
  };
}

function dataOf(body: Record<string, unknown>): StripeObject[] {
  return Array.isArray(body.data) ? body.data.filter(isStripeObject) : [];
}
