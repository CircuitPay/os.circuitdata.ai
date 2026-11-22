// The Square connector (research R13): OAuth code flow with the server-held secret, read scopes
// only (checked against the token's status, since the token response does not report them), a
// refresh every 7 days or sooner (30-day tokens, stale after 8), newest-first backfill windows, an
// `updated_at` incremental cursor, and refetch of the objects a webhook names.

import { CredentialsExpiredError } from "@gadgets/gatekeeper-kit/credentials";
import type { IngestBatch, TransactionRecord } from "../dataset/ingest.js";
import {
  ProviderError, epochSeconds, laterInstant, providerJson,
  type Connector, type ExchangedGrant, type FetchedPage, type ProviderLocation, type ReadContext,
  type RefetchTarget, type ResourceQuery, type SyncResource,
} from "./provider.js";
import {
  mapCatalog, mapCustomer, mapInventoryChange, mapInventoryCount, mapLocation, mapOrder,
  mapPayment, mapRefund, type SquareObject,
} from "./square-map.js";

/** The read scopes requested, and the only ones a grant may carry (FR-003). */
export const SQUARE_SCOPES = [
  "MERCHANT_PROFILE_READ", "ORDERS_READ", "ITEMS_READ", "CUSTOMERS_READ", "PAYMENTS_READ", "INVENTORY_READ",
] as const;

/** The API version every request pins. */
export const SQUARE_VERSION = "2025-10-16";

/** Square's guidance: refresh at 7 days of a 30-day token, alert at 8. */
const REFRESH_AFTER_MS = 7 * 86_400_000;
const STALE_AFTER_MS = 8 * 86_400_000;

/** SearchOrders takes at most 10 location ids per call, and pages of up to 1000. */
const ORDER_LOCATIONS_PER_CALL = 10;
const ORDER_PAGE_LIMIT = 1000;
/** BatchRetrieveOrders / BulkRetrieveCustomers take at most 100 ids. */
const RETRIEVE_LIMIT = 100;

/** A Square grant as the connection stores it. */
export type SquareCreds = {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, epoch ms. */
  expiresAt: number;
  /** When this access token was minted, epoch ms. */
  obtainedAt: number;
  merchantId: string;
  scopes: string[];
};

/** The Square app's server-held configuration (deploy inputs). */
export type SquareConfig = {
  clientId: string;
  clientSecret: string;
};

/** Reads the Square app configuration, or throws when the deployment has none. */
export function squareConfig(env: Cloudflare.Env): SquareConfig {
  const clientId = env.SQUARE_CLIENT_ID;
  const clientSecret = env.SQUARE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Square is not configured on this deployment.");
  return { clientId, clientSecret };
}

/** Sandbox application ids start with `sandbox-`; they talk to the sandbox hosts. */
export function squareOrigin(clientId: string): string {
  return clientId.startsWith("sandbox-") ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

function squareErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const errors = "errors" in body && Array.isArray(body.errors) ? body.errors : [];
  const first: unknown = errors[0];
  const code = first !== null && typeof first === "object" && "code" in first ? first.code
    : "type" in body ? body.type : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The Square connector. */
export class SquareConnector implements Connector<SquareCreds> {
  readonly kind = "square" as const;
  readonly label = "Square";
  readonly fullResources: readonly SyncResource[] = ["locations", "products", "customers", "inventory"];
  readonly windowedResources: readonly SyncResource[] = ["orders", "payments", "refunds"];
  readonly incrementalResources: readonly SyncResource[] = [
    "locations", "products", "customers", "orders", "payments", "refunds", "inventory", "inventory_changes",
  ];
  /** `expiresAt` is 30 days out; refreshing 23 days early refreshes at 7 days. */
  readonly refreshSkewMs = 23 * 86_400_000;

  readonly #config: SquareConfig;
  readonly #origin: string;

  constructor(config: SquareConfig) {
    this.#config = config;
    this.#origin = squareOrigin(config.clientId);
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const url = new URL("/oauth2/authorize", this.#origin);
    url.searchParams.set("client_id", this.#config.clientId);
    url.searchParams.set("scope", SQUARE_SCOPES.join(" "));
    url.searchParams.set("session", "false");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  }

  async exchange(params: URLSearchParams, redirectUri: string): Promise<ExchangedGrant<SquareCreds>> {
    const code = params.get("code");
    if (!code) throw new Error(params.get("error") === "access_denied"
      ? "The Square connection was cancelled."
      : "Square did not return an authorization code.");
    const obtainedAt = Date.now();
    const { body } = await this.#oauth("/oauth2/token", {
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const creds = tokenCreds(body, obtainedAt);
    if (!creds) throw new Error("Square returned an unusable token.");
    // The token response does not carry scopes; the token's status does.
    const scopes = await this.#grantedScopes(creds.accessToken).catch(() => null);
    const requested = new Set<string>(SQUARE_SCOPES);
    if (!scopes || scopes.length !== requested.size || scopes.some(scope => !requested.has(scope))) {
      await this.revoke(creds).catch(() => undefined);
      throw new Error("The Square grant does not match the read-only access requested.");
    }
    const merchant = await this.#api(creds, "GET", `/v2/merchants/${encodeURIComponent(creds.merchantId)}`)
      .then(({ body }) => objectOf(body, "merchant"))
      .catch((): SquareObject => ({}));
    const businessName = typeof merchant.business_name === "string" ? merchant.business_name : null;
    return {
      creds: { ...creds, scopes },
      externalAccountId: creds.merchantId,
      externalAccountLabel: businessName ?? `Square ${creds.merchantId}`,
    };
  }

  expiresAt(creds: SquareCreds): number | undefined {
    // Refresh 7 days after minting even if Square shortened the token's life.
    return Math.min(creds.expiresAt, creds.obtainedAt + REFRESH_AFTER_MS + this.refreshSkewMs);
  }

  isStale(creds: SquareCreds, now: number): boolean {
    return now - creds.obtainedAt > STALE_AFTER_MS;
  }

  async refresh(creds: SquareCreds): Promise<SquareCreds> {
    const obtainedAt = Date.now();
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#oauth("/oauth2/token", {
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
      }));
    } catch (error) {
      if (error instanceof ProviderError && (error.failure === "auth" || error.status === 400)) {
        throw new CredentialsExpiredError("The Square grant was revoked.", { cause: error });
      }
      throw error;
    }
    const minted = tokenCreds(body, obtainedAt);
    if (!minted) throw new ProviderError("Square", "transient", 200, "malformed");
    return { ...creds, ...minted, refreshToken: minted.refreshToken || creds.refreshToken, scopes: creds.scopes };
  }

  async revoke(creds: Pick<SquareCreds, "accessToken">): Promise<void> {
    try {
      await providerJson("Square", new URL("/oauth2/revoke", this.#origin).toString(), {
        method: "POST",
        headers: {
          "Authorization": `Client ${this.#config.clientSecret}`,
          "Content-Type": "application/json",
          "Square-Version": SQUARE_VERSION,
        },
        body: JSON.stringify({ client_id: this.#config.clientId, access_token: creds.accessToken }),
      }, squareErrorCode);
    } catch (error) {
      // An already-revoked grant is the outcome we wanted.
      if (error instanceof ProviderError && error.failure === "auth") return;
      throw error;
    }
  }

  async listLocations(creds: SquareCreds): Promise<ProviderLocation[]> {
    const { body } = await this.#api(creds, "GET", "/v2/locations");
    return arrayOf(body, "locations").flatMap(location => {
      const id = typeof location.id === "string" ? location.id : null;
      if (!id) return [];
      return [{
        id,
        name: typeof location.name === "string" ? location.name : id,
        timezone: typeof location.timezone === "string" ? location.timezone : null,
        currency: typeof location.currency === "string" ? location.currency : null,
        active: location.status === "ACTIVE",
      }];
    });
  }

  async fetchPage(creds: SquareCreds, resource: SyncResource, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    switch (resource) {
      case "locations": return this.#locations(creds, context);
      case "products": return this.#catalog(creds, query);
      case "customers": return this.#customers(creds, query);
      case "orders": return this.#orders(creds, query, context);
      case "payments": return this.#payments(creds, query, context, "payments");
      case "refunds": return this.#payments(creds, query, context, "refunds");
      case "inventory": return this.#inventoryCounts(creds, query, context);
      case "inventory_changes": return this.#inventoryChanges(creds, query, context);
      default: throw new Error(`Square has no ${resource} resource.`);
    }
  }

  async refetch(creds: SquareCreds, target: RefetchTarget, context: ReadContext): Promise<FetchedPage | null> {
    const id = encodeURIComponent(target.id);
    switch (target.type) {
      case "order": {
        const { body, text } = await this.#api(creds, "GET", `/v2/orders/${id}`);
        return this.#orderPage([objectOf(body, "order")], text, null, context);
      }
      case "payment": {
        const { body, text } = await this.#api(creds, "GET", `/v2/payments/${id}`);
        return this.#paymentPage([objectOf(body, "payment")], text, "payments", null, context);
      }
      case "refund": {
        const { body, text } = await this.#api(creds, "GET", `/v2/refunds/${id}`);
        return this.#paymentPage([objectOf(body, "refund")], text, "refunds", null, context);
      }
      case "customer": {
        const { body, text } = await this.#api(creds, "GET", `/v2/customers/${id}`);
        const customer = mapCustomer(objectOf(body, "customer"));
        return { batch: { customers: customer ? [customer] : [] }, raw: text, fetched: 1, next: null, high: null };
      }
      default:
        return null;
    }
  }

  async #locations(creds: SquareCreds, context: ReadContext): Promise<FetchedPage> {
    const { body, text } = await this.#api(creds, "GET", "/v2/locations");
    const all = arrayOf(body, "locations");
    const chosen = all.filter(location => included(context, location.id));
    const locations = chosen.map(mapLocation).filter(record => record !== null);
    return { batch: { locations }, raw: text, fetched: all.length, next: null, high: null };
  }

  async #catalog(creds: SquareCreds, query: ResourceQuery): Promise<FetchedPage> {
    const { body, text } = await this.#api(creds, "POST", "/v2/catalog/search", {
      object_types: ["ITEM", "CATEGORY"],
      include_deleted_objects: true,
      limit: 1000,
      ...(query.page ? { cursor: query.page } : {}),
      ...(query.updatedSince ? { begin_time: query.updatedSince } : {}),
    });
    const objects = arrayOf(body, "objects");
    return {
      batch: { products: mapCatalog(objects) },
      raw: text,
      fetched: objects.length,
      next: nextQuery(query, body),
      high: newest(objects),
    };
  }

  async #customers(creds: SquareCreds, query: ResourceQuery): Promise<FetchedPage> {
    const { body, text } = await this.#api(creds, "POST", "/v2/customers/search", {
      limit: 100,
      ...(query.page ? { cursor: query.page } : {}),
      query: {
        ...(query.updatedSince ? { filter: { updated_at: { start_at: query.updatedSince } } } : {}),
        sort: { field: "CREATED_AT", order: "ASC" },
      },
    });
    const customers = arrayOf(body, "customers");
    return {
      batch: { customers: customers.map(mapCustomer).filter(record => record !== null) },
      raw: text,
      fetched: customers.length,
      next: nextQuery(query, body),
      high: newest(customers),
    };
  }

  /**
   * SearchOrders over the chosen locations, 10 per call: the page cursor is `<chunk>:<cursor>`. A
   * creation window sorts newest first (backfill); an update query sorts oldest first (incremental),
   * the date filter and the sort on the same field as Square requires.
   */
  async #orders(creds: SquareCreds, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    const locations = context.locationIds.length ? context.locationIds : await this.#allLocationIds(creds);
    const chunks: string[][] = [];
    for (let index = 0; index < locations.length; index += ORDER_LOCATIONS_PER_CALL) {
      chunks.push(locations.slice(index, index + ORDER_LOCATIONS_PER_CALL));
    }
    if (chunks.length === 0) return { batch: {}, raw: "{}", fetched: 0, next: null, high: null };
    const separator = query.page?.indexOf(":") ?? -1;
    const chunk = separator > 0 ? Number(query.page!.slice(0, separator)) : 0;
    const cursor = separator > 0 ? query.page!.slice(separator + 1) : "";
    const byUpdate = query.updatedSince !== undefined;
    const field = byUpdate ? "updated_at" : "created_at";
    const range = byUpdate
      ? { start_at: query.updatedSince }
      : { start_at: query.from, end_at: query.to };
    const { body, text } = await this.#api(creds, "POST", "/v2/orders/search", {
      location_ids: chunks[chunk] ?? [],
      limit: ORDER_PAGE_LIMIT,
      return_entries: false,
      ...(cursor ? { cursor } : {}),
      query: {
        filter: { date_time_filter: { [field]: range } },
        sort: { sort_field: byUpdate ? "UPDATED_AT" : "CREATED_AT", sort_order: byUpdate ? "ASC" : "DESC" },
      },
    });
    const pageCursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    let next: ResourceQuery | null = null;
    if (pageCursor) next = { ...query, page: `${chunk}:${pageCursor}` };
    else if (chunk + 1 < chunks.length) next = { ...query, page: `${chunk + 1}:` };
    return this.#orderPage(arrayOf(body, "orders"), text, next, context, creds);
  }

  /**
   * Maps orders, and fetches what they reference that this source has not seen yet: the source
   * orders of returns (older than the window being read), and customers created since the last
   * customer read. Unknown catalog items keep the line's name and lose the product link.
   */
  async #orderPage(
    orders: SquareObject[], raw: string, next: ResourceQuery | null, context: ReadContext, creds?: SquareCreds,
  ): Promise<FetchedPage> {
    const batch: Required<Pick<IngestBatch, "orders" | "lineItems" | "refundItems" | "customers">> = {
      orders: [], lineItems: [], refundItems: [], customers: [],
    };
    const mapOne = (order: SquareObject) => {
      if (!included(context, order.location_id)) return;
      const mapped = mapOrder(order);
      if (mapped.order) batch.orders.push(mapped.order);
      batch.lineItems.push(...mapped.lineItems);
      batch.refundItems.push(...mapped.refundItems);
    };
    orders.forEach(mapOne);
    if (creds) {
      const inBatch = new Set(batch.orders.map(order => order.sourceRecordId));
      const sourceOrders = [...new Set(batch.refundItems.map(item => item.orderRef))].filter(id => !inBatch.has(id));
      const knownOrders = await context.known("orders", sourceOrders);
      const missingOrders = sourceOrders.filter(id => !knownOrders.has(id));
      for (let index = 0; index < missingOrders.length; index += RETRIEVE_LIMIT) {
        const { body } = await this.#api(creds, "POST", "/v2/orders/batch-retrieve", {
          order_ids: missingOrders.slice(index, index + RETRIEVE_LIMIT),
        });
        arrayOf(body, "orders").forEach(mapOne);
      }
      const customerIds = [...new Set(batch.orders.map(order => order.customerRef).filter(id => typeof id === "string"))];
      const knownCustomers = await context.known("customers", customerIds);
      const missingCustomers = customerIds.filter(id => !knownCustomers.has(id));
      for (let index = 0; index < missingCustomers.length; index += RETRIEVE_LIMIT) {
        const { body } = await this.#api(creds, "POST", "/v2/customers/bulk-retrieve", {
          customer_ids: missingCustomers.slice(index, index + RETRIEVE_LIMIT),
        });
        for (const response of Object.values(objectOf(body, "responses"))) {
          const customer = mapCustomer(objectOf(response, "customer"));
          if (customer) batch.customers.push(customer);
        }
      }
    }
    const fetchedCustomers = new Set(batch.customers.map(customer => customer.sourceRecordId));
    const customerRefs = batch.orders.map(order => order.customerRef).filter((id): id is string => !!id);
    const knownCustomers = await context.known("customers", customerRefs.filter(id => !fetchedCustomers.has(id)));
    const productRefs = batch.lineItems.map(line => line.productRef).filter((id): id is string => !!id);
    const knownProducts = await context.known("products", productRefs);
    for (const order of batch.orders) {
      if (order.customerRef && !fetchedCustomers.has(order.customerRef) && !knownCustomers.has(order.customerRef)) {
        order.customerRef = null;
      }
    }
    for (const line of batch.lineItems) {
      if (line.productRef && !knownProducts.has(line.productRef)) line.productRef = null;
    }
    for (const item of batch.refundItems) {
      if (item.productRef && !knownProducts.has(item.productRef)) item.productRef = null;
    }
    return { batch, raw, fetched: orders.length, next, high: newest(orders) };
  }

  /** ListPayments / ListPaymentRefunds by creation window or `updated_at`. */
  async #payments(
    creds: SquareCreds, query: ResourceQuery, context: ReadContext, resource: "payments" | "refunds",
  ): Promise<FetchedPage> {
    const params = new URLSearchParams({ limit: "100" });
    if (query.updatedSince) {
      params.set("updated_at_begin_time", query.updatedSince);
      params.set("sort_field", "UPDATED_AT");
      params.set("sort_order", "ASC");
    } else {
      if (query.from) params.set("begin_time", query.from);
      if (query.to) params.set("end_time", query.to);
      params.set("sort_order", "DESC");
    }
    if (query.page) params.set("cursor", query.page);
    const { body, text } = await this.#api(creds, "GET", `/v2/${resource}?${params}`);
    return this.#paymentPage(arrayOf(body, resource), text, resource, nextQuery(query, body), context);
  }

  async #paymentPage(
    objects: SquareObject[], raw: string, resource: "payments" | "refunds", next: ResourceQuery | null,
    context: ReadContext,
  ): Promise<FetchedPage> {
    const transactions = objects
      .filter(object => included(context, object.location_id))
      .map(resource === "payments" ? mapPayment : mapRefund)
      .filter(record => record !== null);
    // A payment for an order this source has not read, or a refund of an unseen payment, keeps its
    // amount and loses the link rather than being rejected.
    const refs = (pick: (record: TransactionRecord) => string | null | undefined) =>
      transactions.map(pick).filter((id): id is string => !!id);
    const knownOrders = await context.known("orders", refs(record => record.orderRef));
    const knownPayments = await context.known("transactions", refs(record => record.parentRef));
    const knownLocations = await context.known("locations", refs(record => record.locationRef));
    for (const record of transactions) {
      if (record.orderRef && !knownOrders.has(record.orderRef)) record.orderRef = null;
      if (record.parentRef && !knownPayments.has(record.parentRef)) record.parentRef = null;
      if (record.locationRef && !knownLocations.has(record.locationRef)) record.locationRef = null;
    }
    return { batch: { transactions }, raw, fetched: objects.length, next, high: newest(objects) };
  }

  async #inventoryCounts(creds: SquareCreds, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    const { body, text } = await this.#api(creds, "POST", "/v2/inventory/counts/batch-retrieve", {
      limit: 1000,
      states: ["IN_STOCK"],
      ...(context.locationIds.length ? { location_ids: context.locationIds } : {}),
      ...(query.updatedSince ? { updated_after: query.updatedSince } : {}),
      ...(query.page ? { cursor: query.page } : {}),
    });
    const counts = arrayOf(body, "counts");
    const inventory = await this.#withKnownProducts(
      counts.map(mapInventoryCount).filter(record => record !== null), context);
    const high = counts.reduce<string | null>(
      (latest, count) => laterInstant(latest, typeof count.calculated_at === "string" ? count.calculated_at : null), null);
    return { batch: { inventory }, raw: text, fetched: counts.length, next: nextQuery(query, body), high };
  }

  async #inventoryChanges(creds: SquareCreds, query: ResourceQuery, context: ReadContext): Promise<FetchedPage> {
    const { body, text } = await this.#api(creds, "POST", "/v2/inventory/changes/batch-retrieve", {
      limit: 1000,
      types: ["ADJUSTMENT"],
      ...(context.locationIds.length ? { location_ids: context.locationIds } : {}),
      ...(query.updatedSince ? { updated_after: query.updatedSince } : {}),
      ...(query.page ? { cursor: query.page } : {}),
    });
    const changes = arrayOf(body, "changes");
    const inventoryMovements = await this.#withKnownProducts(
      changes.map(mapInventoryChange).filter(record => record !== null), context);
    const high = changes.reduce<string | null>((latest, change) => {
      const adjustment = objectOf(change, "adjustment");
      return laterInstant(latest, typeof adjustment.created_at === "string" ? adjustment.created_at : null);
    }, null);
    return { batch: { inventoryMovements }, raw: text, fetched: changes.length, next: nextQuery(query, body), high };
  }

  /** Stock rows for catalog objects this source has not read would be rejected; drop them. */
  async #withKnownProducts<T extends { productRef: string; locationRef: string }>(records: T[], context: ReadContext): Promise<T[]> {
    const products = await context.known("products", records.map(record => record.productRef));
    const locations = await context.known("locations", records.map(record => record.locationRef));
    return records.filter(record => products.has(record.productRef) && locations.has(record.locationRef));
  }

  async #allLocationIds(creds: SquareCreds): Promise<string[]> {
    return (await this.listLocations(creds)).map(location => location.id);
  }

  #oauth(path: string, payload: Record<string, string>) {
    return providerJson("Square", new URL(path, this.#origin).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
      body: JSON.stringify(payload),
    }, squareErrorCode);
  }

  async #grantedScopes(accessToken: string): Promise<string[]> {
    const { body } = await providerJson("Square", new URL("/oauth2/token/status", this.#origin).toString(), {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Square-Version": SQUARE_VERSION },
    }, squareErrorCode);
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    if (scopes.length === 0 || !scopes.every(scope => typeof scope === "string")) throw new Error("no scopes");
    return scopes;
  }

  #api(creds: Pick<SquareCreds, "accessToken">, method: "GET" | "POST", path: string, payload?: unknown) {
    return providerJson("Square", new URL(path, this.#origin).toString(), {
      method,
      headers: {
        "Authorization": `Bearer ${creds.accessToken}`,
        "Square-Version": SQUARE_VERSION,
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }, squareErrorCode);
  }
}

/** A token response → credentials, or null when it is not a usable Square token. */
function tokenCreds(record: Record<string, unknown>, obtainedAt: number): Omit<SquareCreds, "scopes"> | null {
  const accessToken = record.access_token;
  const merchantId = record.merchant_id;
  const expiresAt = epochSeconds(record.expires_at);
  if (typeof accessToken !== "string" || !accessToken || typeof merchantId !== "string" || !merchantId) return null;
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : "",
    expiresAt: expiresAt === null ? obtainedAt + 30 * 86_400_000 : expiresAt * 1000,
    obtainedAt,
    merchantId,
  };
}

function isObject(value: unknown): value is SquareObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayOf(body: Record<string, unknown>, key: string): SquareObject[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function objectOf(body: unknown, key: string): SquareObject {
  const value = isObject(body) ? body[key] : undefined;
  return isObject(value) ? value : {};
}

/** The same query at Square's next cursor, or null at the last page. */
function nextQuery(query: ResourceQuery, body: Record<string, unknown>): ResourceQuery | null {
  const cursor = body.cursor;
  return typeof cursor === "string" && cursor ? { ...query, page: cursor } : null;
}

/** The newest `updated_at` of a page. */
function newest(objects: SquareObject[]): string | null {
  return objects.reduce<string | null>(
    (latest, object) => laterInstant(latest, typeof object.updated_at === "string" ? object.updated_at : null), null);
}

/** Whether a location id is among the chosen ones (all when none were chosen). */
function included(context: ReadContext, locationId: unknown): boolean {
  return context.locationIds.length === 0 || (typeof locationId === "string" && context.locationIds.includes(locationId));
}

