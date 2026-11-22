// Ingest: canonical records from any source (a connector page, a mapped CSV batch) become storage
// rows. Rows are upserted by (source_id, source_record_id), so re-reading the same data changes
// nothing (FR-005); every write records its run and mapping version (FR-013); import runs keep
// pre-images for undo (research R16); and every touched (location, business date) is queued for the
// rollup recompute (research R17). Business dates and local hours are computed here with `Intl`,
// because SQLite's `localtime` is UTC inside workerd (research R11).

import type { CustomerPii } from "./masking.js";
import { CANONICAL_TABLES, type CanonicalTable } from "./schema.js";

/** Epoch seconds. */
export type EpochSeconds = number;

/** Run kinds (data-model §4 `runs.kind`). */
export type RunKind = "backfill" | "sync" | "import" | "rebuild" | "undo";

/** Pre-images of import runs are kept this long (`RETAIL_UNDO_RETENTION_DAYS`). */
export const UNDO_RETENTION_DAYS = 30;

/** At most this many rejected rows are recorded per run. */
export const MAX_REJECTIONS_PER_RUN = 10_000;

/** Fields every canonical record carries. References name other records of the same source. */
type RecordBase = {
  /** The provider's or file's id; `fp:<sha256>` for CSV rows without one. */
  sourceRecordId: string;
  /** Set when the source deleted or merged the record. */
  deletedAt?: EpochSeconds | null;
  /** For CSV rows: the raw object and 1-based row the record came from, for rejections. */
  rawObjectId?: number;
  rowIndex?: number;
};

export type LocationRecord = RecordBase & {
  name: string;
  kind?: "store" | "restaurant" | "online" | "other";
  timezone: string;
  /** "HH:MM"; defaults to "04:00" for restaurants and "00:00" otherwise. */
  dayCutoff?: string;
  currency: string;
  addressCity?: string | null;
  addressRegion?: string | null;
  addressCountry?: string | null;
  addressPostalCode?: string | null;
};

export type CustomerRecord = RecordBase & {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt?: EpochSeconds | null;
  marketingOptIn?: boolean | null;
};

export type ProductRecord = RecordBase & {
  name: string;
  variantName?: string | null;
  parentRef?: string | null;
  sku?: string | null;
  barcode?: string | null;
  category?: string | null;
  priceAmount?: number | null;
  currency?: string | null;
  unitCostAmount?: number | null;
  isActive?: boolean;
};

export type OrderStatus = "open" | "completed" | "voided" | "refunded" | "partially_refunded";
export type Channel = "in_store" | "online" | "delivery" | "other";

export type OrderRecord = RecordBase & {
  locationRef: string;
  customerRef?: string | null;
  orderNumber?: string | null;
  status: OrderStatus;
  channel?: Channel;
  openedAt?: EpochSeconds | null;
  closedAt?: EpochSeconds | null;
  /** Overrides the derived business date (Toast: the export set's date). */
  businessDate?: string | null;
  currency: string;
  /** Used only while the order has no line items; otherwise gross is the lines' sum. */
  grossAmount?: number | null;
  /** The order-level discount; line discounts are added to it. */
  discountAmount?: number;
  serviceChargeAmount?: number;
  taxAmount?: number;
  tipAmount?: number;
  totalAmount: number;
  pricesIncludeTax?: boolean;
  guestCount?: number | null;
};

export type ModifierRecord = { name: string; price_amount: number; quantity: number };

export type LineItemRecord = RecordBase & {
  orderRef: string;
  productRef?: string | null;
  name: string;
  /** Quantity in ten-thousandths (see `parseQuantity`). */
  quantityE4: number;
  unitPriceAmount: number;
  /** Defaults to quantity × unit price. */
  grossAmount?: number;
  discountAmount?: number;
  taxAmount?: number;
  modifiers?: ModifierRecord[] | null;
  unitCostAmount?: number | null;
  isVoided?: boolean;
  /** Defaults to the order's currency. */
  currency?: string;
};

export type TransactionRecord = RecordBase & {
  orderRef?: string | null;
  locationRef?: string | null;
  parentRef?: string | null;
  kind: "payment" | "refund" | "payout" | "fee" | "adjustment";
  tender?: "card" | "cash" | "gift_card" | "wallet" | "other" | null;
  cardBrand?: string | null;
  amount: number;
  salesAmount?: number | null;
  taxAmount?: number | null;
  tipAmount?: number | null;
  feeAmount?: number | null;
  currency: string;
  occurredAt: EpochSeconds;
  status?: "succeeded" | "failed" | "pending";
};

export type RefundItemRecord = RecordBase & {
  orderRef: string;
  transactionRef?: string | null;
  lineItemRef?: string | null;
  productRef?: string | null;
  quantityE4: number;
  salesAmount: number;
  taxAmount?: number;
  /** When the refund happened; used when `transactionRef` does not resolve. */
  occurredAt?: EpochSeconds | null;
  currency?: string;
};

export type InventoryRecord = RecordBase & {
  productRef: string;
  locationRef: string;
  quantityOnHandE4?: number | null;
  state: "in_stock" | "low" | "out_of_stock";
  asOf: EpochSeconds;
};

export type InventoryMovementRecord = RecordBase & {
  productRef: string;
  locationRef: string;
  quantityDeltaE4: number;
  reason: "sale" | "receive" | "adjustment" | "transfer" | "waste" | "other";
  occurredAt: EpochSeconds;
};

/** One batch of canonical records from one source. Tables are written in dependency order. */
export type IngestBatch = {
  locations?: LocationRecord[];
  customers?: CustomerRecord[];
  products?: ProductRecord[];
  orders?: OrderRecord[];
  lineItems?: LineItemRecord[];
  transactions?: TransactionRecord[];
  refundItems?: RefundItemRecord[];
  inventory?: InventoryRecord[];
  inventoryMovements?: InventoryMovementRecord[];
};

/** Per-table outcome counts of a batch or run. */
export type TableCounts = {
  fetched: number;
  written: number;
  updated: number;
  skipped: number;
  rejected: number;
};

/** Reason codes for a rejected row (data-model §5). */
export type RejectionReason =
  | "unknown_currency" | "bad_amount" | "bad_date" | "missing_required" | "orphan_line"
  | "unknown_timezone" | "unknown_reference" | "invalid_value";

/** The outcome of one ingested batch. */
export type IngestResult = {
  counts: Partial<Record<CanonicalTable, TableCounts>>;
  /** Accepted with a warning (data-model §5). */
  warnings: { totalMismatch: number };
  /** (location, business date) pairs whose rollups were queued for recompute. */
  dirtyDays: number;
};

/** Who and what writes a batch. */
export type IngestContext = {
  sourceId: number;
  runId: number;
  runKind: RunKind;
  mappingVersion: string;
  now: EpochSeconds;
  /** Customer masks and hashes, computed before the transaction (hashing is asynchronous). */
  customerPii: ReadonlyMap<string, CustomerPii>;
  /** Rebuild runs: the generation every row the rebuild produces is stamped with (research R16). */
  rebuildGen?: number;
};

type Value = SqlStorageValue;
type Row = Record<string, Value>;

/** A row refused by validation. */
class Rejection extends Error {
  constructor(readonly reason: RejectionReason, readonly column?: string, detail?: string) {
    super(detail ?? reason);
  }
}

const TABLE_KEY: Record<CanonicalTable, keyof IngestBatch> = {
  locations: "locations",
  customers: "customers",
  products: "products",
  orders: "orders",
  line_items: "lineItems",
  transactions: "transactions",
  refund_items: "refundItems",
  inventory: "inventory",
  inventory_movements: "inventoryMovements",
};

const enumOf = (...values: string[]): Readonly<Record<string, true>> =>
  Object.fromEntries(values.map(value => [value, true]));
const ORDER_STATUSES = enumOf("open", "completed", "voided", "refunded", "partially_refunded");
const CHANNELS = enumOf("in_store", "online", "delivery", "other");
const LOCATION_KINDS = enumOf("store", "restaurant", "online", "other");
const TRANSACTION_KINDS = enumOf("payment", "refund", "payout", "fee", "adjustment");
const TENDERS = enumOf("card", "cash", "gift_card", "wallet", "other");
const TRANSACTION_STATUSES = enumOf("succeeded", "failed", "pending");
const INVENTORY_STATES = enumOf("in_stock", "low", "out_of_stock");
const MOVEMENT_REASONS = enumOf("sale", "receive", "adjustment", "transfer", "waste", "other");

type LocationInfo = { timezone: string; cutoffMinutes: number };
type OrderInfo = { locationId: number; businessDate: string; customerId: number | null; currency: string };

/**
 * Writes one batch inside the caller's `transactionSync`. Rows that fail validation are recorded
 * in `run_rejections` (without values from personal columns) and the rest are written.
 */
export function writeBatch(sql: SqlStorage, context: IngestContext, batch: IngestBatch): IngestResult {
  return new BatchWriter(sql, context).write(batch);
}

class BatchWriter {
  readonly #sql: SqlStorage;
  readonly #context: IngestContext;
  readonly #counts: Partial<Record<CanonicalTable, TableCounts>> = {};
  readonly #ids = new Map<string, number | null>();
  readonly #locations = new Map<number, LocationInfo>();
  readonly #orders = new Map<number, OrderInfo>();
  readonly #dirtyDays = new Set<string>();
  readonly #dirtyCustomers = new Set<number>();
  readonly #touchedOrders = new Set<number>();
  #rejectionsLeft: number;
  #seq: number;

  constructor(sql: SqlStorage, context: IngestContext) {
    this.#sql = sql;
    this.#context = context;
    this.#rejectionsLeft = MAX_REJECTIONS_PER_RUN - this.#one<number>(
      "SELECT COUNT(*) AS n FROM run_rejections WHERE run_id = ?", context.runId);
    this.#seq = this.#one<number>(
      "SELECT COALESCE(MAX(seq), 0) AS n FROM row_versions WHERE run_id = ?", context.runId);
  }

  write(batch: IngestBatch): IngestResult {
    for (const table of CANONICAL_TABLES) {
      const records = (batch[TABLE_KEY[table]] ?? []) as RecordBase[];
      // Payments first, so a refund in the same batch can name the payment it reverses.
      const ordered = table === "transactions"
        ? (records as TransactionRecord[]).toSorted((a, b) =>
          Number(a.kind === "refund") - Number(b.kind === "refund"))
        : records;
      for (const record of ordered) this.#writeRecord(table, record);
    }
    const totalMismatch = this.#recomputeOrderTotals();
    for (const key of this.#dirtyDays) {
      const [locationId, businessDate] = splitDayKey(key);
      this.#sql.exec(
        "INSERT OR IGNORE INTO dirty_days (location_id, business_date) VALUES (?, ?)",
        locationId, businessDate);
    }
    for (const customerId of this.#dirtyCustomers) {
      this.#sql.exec("INSERT OR IGNORE INTO dirty_customers (customer_id) VALUES (?)", customerId);
    }
    return { counts: this.#counts, warnings: { totalMismatch }, dirtyDays: this.#dirtyDays.size };
  }

  #writeRecord(table: CanonicalTable, record: RecordBase): void {
    const counts = this.#counts[table] ??= { fetched: 0, written: 0, updated: 0, skipped: 0, rejected: 0 };
    counts.fetched++;
    try {
      if (typeof record.sourceRecordId !== "string" || record.sourceRecordId === "") {
        throw new Rejection("missing_required", "source_record_id");
      }
      const outcome = this.#writers[table](record as never);
      counts[outcome]++;
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      counts.rejected++;
      this.#reject(table, record, error);
    }
  }

  readonly #writers: { [T in CanonicalTable]: (record: never) => "written" | "updated" | "skipped" } = {
    locations: (record: LocationRecord) => {
      const timezone = requireTimezone(record.timezone);
      const kind = optionalEnum(record.kind, LOCATION_KINDS, "kind") ?? "other";
      const cutoff = record.dayCutoff ?? (kind === "restaurant" ? "04:00" : "00:00");
      const { op, id } = this.#upsert("locations", record, {
        name: requireText(record.name, "name"),
        kind,
        timezone,
        day_cutoff_minutes: parseCutoff(cutoff),
        currency: requireCurrency(record.currency),
        address_city: optionalText(record.addressCity),
        address_region: optionalText(record.addressRegion),
        address_country: optionalText(record.addressCountry),
        address_postal_code: optionalText(record.addressPostalCode),
      });
      this.#locations.delete(id);
      return op;
    },
    customers: (record: CustomerRecord) => {
      const pii = this.#context.customerPii.get(record.sourceRecordId);
      if (!pii) throw new Error(`Customer ${record.sourceRecordId} was not prepared for ingest.`);
      return this.#upsert("customers", record, {
        first_name: optionalText(record.firstName),
        last_name: optionalText(record.lastName),
        email: optionalText(record.email),
        phone: optionalText(record.phone),
        first_name_mask: pii.firstNameMask,
        last_name_mask: pii.lastNameMask,
        email_mask: pii.emailMask,
        phone_mask: pii.phoneMask,
        email_hash: pii.emailHash,
        phone_hash: pii.phoneHash,
        created_at: optionalEpoch(record.createdAt, "created_at"),
        marketing_opt_in: optionalBool(record.marketingOptIn),
      }).op;
    },
    products: (record: ProductRecord) => this.#upsert("products", record, {
      name: requireText(record.name, "name"),
      variant_name: optionalText(record.variantName),
      parent_product_id: record.parentRef ? this.#ref("products", record.parentRef, "parent_product_id") : null,
      sku: optionalText(record.sku),
      barcode: optionalText(record.barcode),
      category: optionalText(record.category),
      price_amount: optionalAmount(record.priceAmount, "price_amount"),
      currency: record.currency == null ? null : requireCurrency(record.currency),
      unit_cost_amount: optionalAmount(record.unitCostAmount, "unit_cost_amount"),
      is_active: record.isActive === false ? 0 : 1,
    }).op,
    orders: (record: OrderRecord) => this.#writeOrder(record),
    line_items: (record: LineItemRecord) => this.#writeLineItem(record),
    transactions: (record: TransactionRecord) => this.#writeTransaction(record),
    refund_items: (record: RefundItemRecord) => this.#writeRefundItem(record),
    inventory: (record: InventoryRecord) => this.#upsert("inventory", record, {
      product_id: this.#ref("products", record.productRef, "product_id"),
      location_id: this.#ref("locations", record.locationRef, "location_id"),
      quantity_on_hand_e4: record.quantityOnHandE4 == null
        ? null : requireInteger(record.quantityOnHandE4, "quantity_on_hand"),
      state: requireEnum(record.state, INVENTORY_STATES, "state"),
      as_of: requireEpoch(record.asOf, "as_of"),
    }).op,
    inventory_movements: (record: InventoryMovementRecord) => this.#upsert("inventory_movements", record, {
      product_id: this.#ref("products", record.productRef, "product_id"),
      location_id: this.#ref("locations", record.locationRef, "location_id"),
      quantity_delta_e4: requireInteger(record.quantityDeltaE4, "quantity_delta"),
      reason: requireEnum(record.reason, MOVEMENT_REASONS, "reason"),
      occurred_at: requireEpoch(record.occurredAt, "occurred_at"),
    }).op,
  };

  #writeOrder(record: OrderRecord) {
    const locationId = this.#ref("locations", record.locationRef, "location_id");
    const location = this.#location(locationId);
    const closedAt = optionalEpoch(record.closedAt, "closed_at");
    const openedAt = optionalEpoch(record.openedAt, "opened_at");
    const at = closedAt ?? openedAt;
    let businessDate: string;
    let localHour: number;
    if (record.businessDate != null) {
      businessDate = requireDate(record.businessDate, "business_date");
      localHour = at === null ? 0 : businessDayOf(at, location.timezone, location.cutoffMinutes).localHour;
    } else {
      if (at === null) throw new Rejection("missing_required", "business_date");
      ({ businessDate, localHour } = businessDayOf(at, location.timezone, location.cutoffMinutes));
    }
    const customerId = record.customerRef ? this.#ref("customers", record.customerRef, "customer_id") : null;
    const currency = requireCurrency(record.currency);
    const orderDiscount = optionalAmount(record.discountAmount, "discount_amount") ?? 0;
    const inputGross = optionalAmount(record.grossAmount, "gross_amount");
    const { op, id, before } = this.#upsert("orders", record, {
      location_id: locationId,
      customer_id: customerId,
      order_number: optionalText(record.orderNumber),
      status: requireEnum(record.status, ORDER_STATUSES, "status"),
      channel: optionalEnum(record.channel, CHANNELS, "channel") ?? "other",
      opened_at: openedAt,
      closed_at: closedAt,
      business_date: businessDate,
      local_hour: localHour,
      currency,
      input_gross_amount: inputGross,
      order_discount_amount: orderDiscount,
      service_charge_amount: optionalAmount(record.serviceChargeAmount, "service_charge_amount") ?? 0,
      tax_amount: optionalAmount(record.taxAmount, "tax_amount") ?? 0,
      tip_amount: optionalAmount(record.tipAmount, "tip_amount") ?? 0,
      total_amount: requireAmount(record.totalAmount, "total_amount"),
      prices_include_tax: record.pricesIncludeTax ? 1 : 0,
      guest_count: record.guestCount == null ? null : requireInteger(record.guestCount, "guest_count"),
    }, { gross_amount: inputGross ?? 0, discount_amount: orderDiscount });
    this.#orders.set(id, { locationId, businessDate, customerId, currency });
    this.#markDay(locationId, businessDate);
    if (customerId !== null) this.#dirtyCustomers.add(customerId);
    if (before) {
      this.#markDay(before.location_id as number, before.business_date as string);
      if (before.customer_id !== null) this.#dirtyCustomers.add(before.customer_id as number);
      if (before.location_id !== locationId || before.business_date !== businessDate) {
        // Line items carry the order's location and business date.
        this.#sql.exec(
          "UPDATE store_line_items SET location_id = ?, business_date = ? WHERE order_id = ?",
          locationId, businessDate, id);
        this.#sql.exec("UPDATE store_refund_items SET location_id = ? WHERE order_id = ?", locationId, id);
      }
    }
    if (op !== "skipped") this.#touchedOrders.add(id);
    return op;
  }

  #writeLineItem(record: LineItemRecord) {
    const orderId = this.#ref("orders", record.orderRef, "order_id", "orphan_line");
    const order = this.#order(orderId);
    const quantityE4 = requireInteger(record.quantityE4, "quantity");
    const unitPrice = requireAmount(record.unitPriceAmount, "unit_price_amount");
    const gross = record.grossAmount === undefined
      ? roundHalfEven(quantityE4 * unitPrice, 10_000)
      : requireAmount(record.grossAmount, "gross_amount");
    const { op, before } = this.#upsert("line_items", record, {
      order_id: orderId,
      location_id: order.locationId,
      business_date: order.businessDate,
      product_id: record.productRef ? this.#ref("products", record.productRef, "product_id") : null,
      name: requireText(record.name, "name"),
      quantity_e4: quantityE4,
      unit_price_amount: unitPrice,
      gross_amount: gross,
      discount_amount: optionalAmount(record.discountAmount, "discount_amount") ?? 0,
      tax_amount: optionalAmount(record.taxAmount, "tax_amount") ?? 0,
      modifiers: record.modifiers?.length ? JSON.stringify(record.modifiers) : null,
      unit_cost_amount: optionalAmount(record.unitCostAmount, "unit_cost_amount"),
      is_voided: record.isVoided ? 1 : 0,
      currency: record.currency === undefined ? order.currency : requireCurrency(record.currency),
    });
    this.#markDay(order.locationId, order.businessDate);
    if (before) {
      this.#markDay(before.location_id as number, before.business_date as string);
      this.#touchedOrders.add(before.order_id as number);
    }
    if (op !== "skipped") this.#touchedOrders.add(orderId);
    return op;
  }

  #writeTransaction(record: TransactionRecord) {
    const kind = requireEnum(record.kind, TRANSACTION_KINDS, "kind");
    const orderId = record.orderRef ? this.#ref("orders", record.orderRef, "order_id") : null;
    const order = orderId === null ? null : this.#order(orderId);
    const locationId = record.locationRef
      ? this.#ref("locations", record.locationRef, "location_id")
      : order?.locationId ?? null;
    const occurredAt = requireEpoch(record.occurredAt, "occurred_at");
    const businessDate = locationId === null
      ? utcDate(occurredAt)
      : businessDayOf(occurredAt, this.#location(locationId).timezone,
        this.#location(locationId).cutoffMinutes).businessDate;
    const amount = requireAmount(record.amount, "amount");
    if (amount < 0) throw new Rejection("bad_amount", "amount", "amount must be positive; kind gives the direction");
    const tip = optionalAmount(record.tipAmount, "tip_amount");
    const salesInput = optionalAmount(record.salesAmount, "sales_amount");
    const { op, before } = this.#upsert("transactions", record, {
      order_id: orderId,
      location_id: locationId,
      parent_transaction_id: record.parentRef
        ? this.#ref("transactions", record.parentRef, "parent_transaction_id") : null,
      kind,
      tender: optionalEnum(record.tender, TENDERS, "tender"),
      card_brand: optionalText(record.cardBrand),
      amount,
      // Without a breakdown, the sales portion of a refund is what is left after the tip.
      sales_amount: salesInput ?? (kind === "refund" ? amount - (tip ?? 0) : null),
      tax_amount: optionalAmount(record.taxAmount, "tax_amount"),
      tip_amount: tip,
      breakdown_known: salesInput === null ? 0 : 1,
      fee_amount: optionalAmount(record.feeAmount, "fee_amount"),
      currency: requireCurrency(record.currency),
      occurred_at: occurredAt,
      business_date: businessDate,
      status: optionalEnum(record.status, TRANSACTION_STATUSES, "status") ?? "succeeded",
    });
    this.#markDay(locationId ?? 0, businessDate);
    if (order?.customerId != null) this.#dirtyCustomers.add(order.customerId);
    if (before) {
      this.#markDay((before.location_id as number | null) ?? 0, before.business_date as string);
      if (before.order_id !== null && before.order_id !== orderId) {
        const previous = this.#order(before.order_id as number);
        if (previous.customerId !== null) this.#dirtyCustomers.add(previous.customerId);
      }
    }
    return op;
  }

  #writeRefundItem(record: RefundItemRecord) {
    const orderId = this.#ref("orders", record.orderRef, "order_id", "orphan_line");
    const order = this.#order(orderId);
    const transactionId = record.transactionRef
      ? this.#ref("transactions", record.transactionRef, "transaction_id") : null;
    const lineItemId = record.lineItemRef
      ? this.#ref("line_items", record.lineItemRef, "line_item_id") : null;
    let businessDate: string;
    if (transactionId !== null) {
      businessDate = this.#one<string>(
        "SELECT business_date AS n FROM store_transactions WHERE id = ?", transactionId);
    } else if (record.occurredAt != null) {
      const location = this.#location(order.locationId);
      businessDate = businessDayOf(requireEpoch(record.occurredAt, "occurred_at"), location.timezone,
        location.cutoffMinutes).businessDate;
    } else {
      throw new Rejection("missing_required", "business_date", "a refund item needs its refund or when it happened");
    }
    let productId = record.productRef ? this.#ref("products", record.productRef, "product_id") : null;
    if (productId === null && lineItemId !== null) {
      productId = this.#one<number | null>("SELECT product_id AS n FROM store_line_items WHERE id = ?", lineItemId);
    }
    const quantityE4 = requireInteger(record.quantityE4, "quantity");
    if (quantityE4 <= 0) throw new Rejection("invalid_value", "quantity", "refunded quantity must be positive");
    const { op, before } = this.#upsert("refund_items", record, {
      transaction_id: transactionId,
      order_id: orderId,
      line_item_id: lineItemId,
      location_id: order.locationId,
      product_id: productId,
      quantity_e4: quantityE4,
      sales_amount: requireAmount(record.salesAmount, "sales_amount"),
      tax_amount: optionalAmount(record.taxAmount, "tax_amount") ?? 0,
      business_date: businessDate,
      currency: record.currency === undefined ? order.currency : requireCurrency(record.currency),
    });
    this.#markDay(order.locationId, businessDate);
    if (before) this.#markDay(before.location_id as number, before.business_date as string);
    return op;
  }

  /**
   * Inserts or updates one row by its source key. `derived` columns are written on insert only;
   * they are maintained afterwards by `#recomputeOrderTotals`.
   */
  #upsert(table: CanonicalTable, record: RecordBase, values: Row, derived: Row = {}): {
    op: "written" | "updated" | "skipped";
    id: number;
    before: Row | null;
  } {
    const { sourceId, runId, mappingVersion, now } = this.#context;
    const deletedAt = optionalEpoch(record.deletedAt, "deleted_at");
    const storeTable = `store_${table}`;
    const before = this.#sql.exec<Row>(
      `SELECT * FROM ${storeTable} WHERE source_id = ? AND source_record_id = ?`,
      sourceId, record.sourceRecordId).toArray()[0] ?? null;
    let id: number;
    let op: "written" | "updated" | "skipped";
    const generation: Row = this.#context.rebuildGen === undefined ? {} : { rebuild_gen: this.#context.rebuildGen };
    if (before === null) {
      const row: Row = {
        ...values, ...derived, ...generation, deleted_at: deletedAt, source_id: sourceId,
        source_record_id: record.sourceRecordId, run_id: runId, mapping_version: mappingVersion,
        ingested_at: now, updated_at: now,
      };
      const columns = Object.keys(row);
      id = this.#one<number>(
        `INSERT INTO ${storeTable} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
        "RETURNING id AS n", ...Object.values(row));
      op = "written";
    } else {
      id = before.id as number;
      const changed = Object.entries({ ...values, deleted_at: deletedAt })
        .filter(([column, value]) => before[column] !== value);
      if (changed.length === 0) {
        op = "skipped";
        // A rebuild that reproduces a row unchanged still claims it, so it is not deleted.
        if (this.#context.rebuildGen !== undefined && before.rebuild_gen !== this.#context.rebuildGen) {
          this.#sql.exec(`UPDATE ${storeTable} SET rebuild_gen = ? WHERE id = ?`, this.#context.rebuildGen, id);
        }
      } else {
        const row: Row = {
          ...Object.fromEntries(changed), ...generation, run_id: runId, mapping_version: mappingVersion, updated_at: now,
        };
        this.#sql.exec(
          `UPDATE ${storeTable} SET ${Object.keys(row).map(column => `${column} = ?`).join(", ")} ` +
          "WHERE id = ?", ...Object.values(row), id);
        op = "updated";
      }
    }
    this.#ids.set(`${table}\0${record.sourceRecordId}`, id);
    if (op === "skipped") return { op, id, before };
    let priorOrigin: Row | null = null;
    if (this.#context.runKind === "import") {
      priorOrigin = this.#sql.exec<Row>(
        "SELECT raw_object_id, row_index FROM row_origins WHERE table_name = ? AND row_id = ?", table, id,
      ).toArray()[0] ?? null;
    }
    if (record.rawObjectId !== undefined && record.rowIndex !== undefined) {
      this.#sql.exec(
        "INSERT OR REPLACE INTO row_origins (table_name, row_id, raw_object_id, row_index) VALUES (?, ?, ?, ?)",
        table, id, record.rawObjectId, record.rowIndex);
    } else {
      // A provider re-read supersedes an earlier file origin.
      this.#sql.exec("DELETE FROM row_origins WHERE table_name = ? AND row_id = ?", table, id);
    }
    if (this.#context.runKind === "import") {
      // The pre-image carries the row's earlier origin, so an undo restores lineage too.
      const image = before === null ? null : JSON.stringify({ ...before, [ORIGIN_KEY]: priorOrigin });
      this.#sql.exec(
        "INSERT INTO row_versions (run_id, table_name, row_id, seq, before, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        runId, table, id, ++this.#seq, image, now + UNDO_RETENTION_DAYS * 86_400);
    }
    return { op, id, before };
  }

  /** Resolves a reference to another record of the same source, or rejects the row. */
  #ref(table: CanonicalTable, sourceRecordId: string | undefined, column: string,
    reason: RejectionReason = "unknown_reference"): number {
    if (typeof sourceRecordId !== "string" || sourceRecordId === "") {
      throw new Rejection("missing_required", column);
    }
    const key = `${table}\0${sourceRecordId}`;
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#sql.exec<{ id: number }>(
        `SELECT id FROM store_${table} WHERE source_id = ? AND source_record_id = ?`,
        this.#context.sourceId, sourceRecordId).toArray()[0]?.id ?? null;
      this.#ids.set(key, id);
    }
    if (id === null) throw new Rejection(reason, column, `no ${table} row with this source id`);
    return id;
  }

  #location(id: number): LocationInfo {
    let info = this.#locations.get(id);
    if (!info) {
      const row = this.#sql.exec<{ timezone: string; day_cutoff_minutes: number }>(
        "SELECT timezone, day_cutoff_minutes FROM store_locations WHERE id = ?", id).one();
      info = { timezone: row.timezone, cutoffMinutes: row.day_cutoff_minutes };
      this.#locations.set(id, info);
    }
    return info;
  }

  #order(id: number): OrderInfo {
    let info = this.#orders.get(id);
    if (!info) {
      const row = this.#sql.exec<{
        location_id: number; business_date: string; customer_id: number | null; currency: string;
      }>("SELECT location_id, business_date, customer_id, currency FROM store_orders WHERE id = ?", id).one();
      info = {
        locationId: row.location_id, businessDate: row.business_date, customerId: row.customer_id,
        currency: row.currency,
      };
      this.#orders.set(id, info);
    }
    return info;
  }

  #markDay(locationId: number, businessDate: string): void {
    this.#dirtyDays.add(`${locationId}|${businessDate}`);
  }

  /**
   * Re-derives gross and discount of every order this batch touched from its non-voided lines, and
   * counts orders whose total disagrees with its parts by more than 1 minor unit per line.
   */
  #recomputeOrderTotals(): number {
    return recomputeOrderTotals(this.#sql, this.#touchedOrders);
  }

  #reject(table: CanonicalTable, record: RecordBase, rejection: Rejection): void {
    if (this.#rejectionsLeft <= 0) return;
    this.#rejectionsLeft--;
    // `detail` is fixed validation text, never a cell value, so no personal data is stored.
    this.#sql.exec(
      "INSERT INTO run_rejections (run_id, table_name, raw_object_id, row_index, reason_code, column_name, detail) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.#context.runId, table, record.rawObjectId ?? null, record.rowIndex ?? null,
      rejection.reason, rejection.column ?? null, rejection.message === rejection.reason ? null : rejection.message);
  }

  #one<T extends Value>(query: string, ...bindings: Value[]): T {
    return this.#sql.exec<{ n: T }>(query, ...bindings).one().n;
  }
}

/** Adds per-table counts to a run's running totals. */
export function addRunCounts(sql: SqlStorage, runId: number, counts: Partial<Record<string, TableCounts>>): void {
  const current = JSON.parse(sql.exec<{ counts: string }>("SELECT counts FROM runs WHERE id = ?", runId).one().counts) as
    Record<string, TableCounts>;
  for (const [table, add] of Object.entries(counts)) {
    const total = current[table] ??= { fetched: 0, written: 0, updated: 0, skipped: 0, rejected: 0 };
    total.fetched += add!.fetched;
    total.written += add!.written;
    total.updated += add!.updated;
    total.skipped += add!.skipped;
    total.rejected += add!.rejected;
  }
  sql.exec("UPDATE runs SET counts = ? WHERE id = ?", JSON.stringify(current), runId);
}

/**
 * Re-derives gross and discount of orders from their non-voided lines. Returns how many orders'
 * totals disagree with their parts by more than 1 minor unit per line. Missing orders are skipped.
 */
export function recomputeOrderTotals(sql: SqlStorage, orderIds: Iterable<number>): number {
  let mismatches = 0;
  for (const id of orderIds) {
    const lines = sql.exec<{ n: number; gross: number; discount: number }>(`
      SELECT COUNT(*) AS n,
        COALESCE(SUM(CASE WHEN is_voided = 0 THEN gross_amount END), 0) AS gross,
        COALESCE(SUM(CASE WHEN is_voided = 0 THEN discount_amount END), 0) AS discount
      FROM store_line_items WHERE order_id = ? AND deleted_at IS NULL`, id).one();
    const order = sql.exec<{ difference: number }>(`
      UPDATE store_orders SET
        gross_amount = CASE WHEN ?1 > 0 THEN ?2 ELSE COALESCE(input_gross_amount, 0) END,
        discount_amount = order_discount_amount + ?3
      WHERE id = ?4
      RETURNING ABS(total_amount - (gross_amount - discount_amount + service_charge_amount
        + CASE WHEN prices_include_tax = 1 THEN 0 ELSE tax_amount END + tip_amount)) AS difference`,
      lines.n, lines.gross, lines.discount, id).toArray()[0];
    if (order && order.difference > Math.max(1, lines.n)) mismatches++;
  }
  return mismatches;
}

/** A row refused before ingest (by the mapping interpreter). `detail` never holds a cell value. */
export type PreIngestRejection = {
  table: CanonicalTable;
  rawObjectId: number | null;
  row: number | null;
  reason: RejectionReason;
  column: string | null;
  detail: string | null;
};

/**
 * Records rows refused before ingest under `runId`, within the per-run cap, and returns the
 * per-table counts to add to the run (each refused row counts as fetched and rejected).
 */
export function recordRejections(
  sql: SqlStorage, runId: number, rejections: PreIngestRejection[],
): Partial<Record<CanonicalTable, TableCounts>> {
  const counts: Partial<Record<CanonicalTable, TableCounts>> = {};
  let left = MAX_REJECTIONS_PER_RUN - sql.exec<{ n: number }>(
    "SELECT COUNT(*) AS n FROM run_rejections WHERE run_id = ?", runId).one().n;
  for (const rejection of rejections) {
    const table = counts[rejection.table] ??= { fetched: 0, written: 0, updated: 0, skipped: 0, rejected: 0 };
    table.fetched++;
    table.rejected++;
    if (left-- <= 0) continue;
    sql.exec(
      "INSERT INTO run_rejections (run_id, table_name, raw_object_id, row_index, reason_code, column_name, detail) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
      runId, rejection.table, rejection.rawObjectId, rejection.row, rejection.reason, rejection.column, rejection.detail);
  }
  return counts;
}

/** The key of a pre-image's earlier `row_origins` entry. */
export const ORIGIN_KEY = "__origin";

// Fact tables whose rows carry a location and business date that rollups are keyed by.
const DATED_TABLES: ReadonlySet<CanonicalTable> = new Set(["orders", "line_items", "transactions", "refund_items"]);

/** Queues the rollups, customers and order totals a storage row feeds. */
function markRow(
  sql: SqlStorage, table: CanonicalTable, row: Row, orders: Set<number>,
): void {
  if (DATED_TABLES.has(table)) {
    sql.exec("INSERT OR IGNORE INTO dirty_days (location_id, business_date) VALUES (?, ?)",
      (row.location_id as number | null) ?? 0, row.business_date as string);
  }
  if (table === "orders") {
    orders.add(row.id as number);
    if (row.customer_id !== null) sql.exec("INSERT OR IGNORE INTO dirty_customers (customer_id) VALUES (?)", row.customer_id);
  } else if ((table === "line_items" || table === "transactions" || table === "refund_items") && row.order_id !== null) {
    orders.add(row.order_id as number);
  }
}

/** Queues the customers of `orders` for the customer summary recompute. */
function markCustomers(sql: SqlStorage, orders: Set<number>): void {
  for (const id of orders) {
    sql.exec(
      "INSERT OR IGNORE INTO dirty_customers (customer_id) SELECT customer_id FROM store_orders WHERE id = ? AND customer_id IS NOT NULL",
      id);
  }
}

/** Why an import cannot be undone. */
export class UndoRefusedError extends Error {}

/**
 * The later runs that changed rows an import wrote, and how many of its rows were deleted since.
 * An undo is possible only when both are empty.
 */
export function laterChanges(sql: SqlStorage, runId: number): { runs: number[]; deleted: number } {
  const later = new Set<number>();
  let deleted = 0;
  for (const { table_name: table, row_id: rowId } of sql.exec<{ table_name: CanonicalTable; row_id: number }>(
    "SELECT DISTINCT table_name, row_id FROM row_versions WHERE run_id = ?", runId)) {
    const current = sql.exec<{ run_id: number }>(`SELECT run_id FROM store_${table} WHERE id = ?`, rowId).toArray()[0];
    if (!current) deleted++;
    else if (current.run_id !== runId) later.add(current.run_id);
  }
  return { runs: [...later].toSorted((a, b) => a - b), deleted };
}

/**
 * Restores the pre-images of an import run in reverse order (research R16), inside the caller's
 * transaction. Refused, naming them, when later runs changed any of its rows, and when its
 * pre-images have expired. Rollups are queued, not recomputed.
 */
export function undoImportRun(sql: SqlStorage, runId: number, now: EpochSeconds): { restored: number } {
  const versions = sql.exec<{ table_name: CanonicalTable; row_id: number; before: string | null; expires_at: number }>(
    "SELECT table_name, row_id, before, expires_at FROM row_versions WHERE run_id = ? ORDER BY seq DESC", runId).toArray();
  if (versions.some(version => version.expires_at <= now)) {
    throw new UndoRefusedError("This import can no longer be undone: its earlier versions of the rows have expired.");
  }
  const later = laterChanges(sql, runId);
  if (later.runs.length > 0 || later.deleted > 0) {
    const names = later.runs.map(id => {
      const run = sql.exec<{ kind: string }>("SELECT kind FROM runs WHERE id = ?", id).toArray()[0];
      return `run ${id}${run ? ` (${run.kind})` : ""}`;
    });
    if (later.deleted > 0) names.push(`${later.deleted} row${later.deleted === 1 ? "" : "s"} deleted since`);
    throw new UndoRefusedError(`This import cannot be undone: later runs changed its rows: ${names.join(", ")}.`);
  }
  const orders = new Set<number>();
  for (const version of versions) {
    const table = version.table_name;
    const current = sql.exec<Row>(`SELECT * FROM store_${table} WHERE id = ?`, version.row_id).toArray()[0];
    if (current) markRow(sql, table, current, orders);
    if (version.before === null) {
      sql.exec(`DELETE FROM store_${table} WHERE id = ?`, version.row_id);
      sql.exec("DELETE FROM row_origins WHERE table_name = ? AND row_id = ?", table, version.row_id);
      continue;
    }
    const { [ORIGIN_KEY]: origin, ...before } = JSON.parse(version.before) as Row & { [ORIGIN_KEY]?: Row | null };
    const columns = Object.keys(before);
    sql.exec(
      `INSERT OR REPLACE INTO store_${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ...Object.values(before) as Value[]);
    if (origin) {
      sql.exec("INSERT OR REPLACE INTO row_origins (table_name, row_id, raw_object_id, row_index) VALUES (?, ?, ?, ?)",
        table, version.row_id, origin.raw_object_id, origin.row_index);
    } else {
      sql.exec("DELETE FROM row_origins WHERE table_name = ? AND row_id = ?", table, version.row_id);
    }
    markRow(sql, table, before, orders);
  }
  recomputeOrderTotals(sql, orders);
  markCustomers(sql, orders);
  sql.exec("DELETE FROM row_versions WHERE run_id = ?", runId);
  return { restored: versions.length };
}

/**
 * Ends a rebuild (research R16): deletes the source's rows that earlier runs of the template wrote
 * and the rebuild did not produce again (their `rebuild_gen` is not the rebuild's), inside the
 * caller's transaction. Rollups are queued, not recomputed. Returns rows deleted per table.
 */
export function deleteUnrebuiltRows(
  sql: SqlStorage, sourceId: number, templateRunIds: number[], generation: number,
): Partial<Record<CanonicalTable, number>> {
  const deleted: Partial<Record<CanonicalTable, number>> = {};
  if (templateRunIds.length === 0) return deleted;
  const orders = new Set<number>();
  const runList = templateRunIds.map(() => "?").join(", ");
  // Dependents first, so no kept row is left pointing at a deleted one of the same rebuild.
  for (const table of CANONICAL_TABLES.toReversed()) {
    const rows = sql.exec<Row>(
      `SELECT * FROM store_${table} WHERE source_id = ? AND rebuild_gen != ? AND run_id IN (${runList})`,
      sourceId, generation, ...templateRunIds).toArray();
    for (const row of rows) {
      markRow(sql, table, row, orders);
      sql.exec(`DELETE FROM store_${table} WHERE id = ?`, row.id as number);
      sql.exec("DELETE FROM row_origins WHERE table_name = ? AND row_id = ?", table, row.id as number);
    }
    if (rows.length > 0) deleted[table] = rows.length;
  }
  recomputeOrderTotals(sql, orders);
  markCustomers(sql, orders);
  return deleted;
}

function splitDayKey(key: string): [number, string] {
  const bar = key.indexOf("|");
  return [Number(key.slice(0, bar)), key.slice(bar + 1)];
}

// ---------------------------------------------------------------------------------------------
// Validation

function requireText(value: unknown, column: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Rejection("missing_required", column);
  return value;
}

function optionalText(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function requireEnum(value: unknown, allowed: Readonly<Record<string, true>>, column: string): string {
  if (value === undefined || value === null) throw new Rejection("missing_required", column);
  if (typeof value !== "string" || !Object.hasOwn(allowed, value)) throw new Rejection("invalid_value", column);
  return value;
}

function optionalEnum(value: unknown, allowed: Readonly<Record<string, true>>, column: string): string | null {
  return value === undefined || value === null ? null : requireEnum(value, allowed, column);
}

function requireInteger(value: unknown, column: string): number {
  if (!Number.isSafeInteger(value)) throw new Rejection("invalid_value", column, "not an integer");
  return value as number;
}

function requireAmount(value: unknown, column: string): number {
  if (value === undefined || value === null) throw new Rejection("missing_required", column);
  if (!Number.isSafeInteger(value)) throw new Rejection("bad_amount", column);
  return value as number;
}

function optionalAmount(value: unknown, column: string): number | null {
  return value === undefined || value === null ? null : requireAmount(value, column);
}

function requireEpoch(value: unknown, column: string): number {
  if (value === undefined || value === null) throw new Rejection("missing_required", column);
  if (!Number.isSafeInteger(value)) throw new Rejection("bad_date", column);
  return value as number;
}

function optionalEpoch(value: unknown, column: string): number | null {
  return value === undefined || value === null ? null : requireEpoch(value, column);
}

function optionalBool(value: boolean | null | undefined): number | null {
  return value === undefined || value === null ? null : value ? 1 : 0;
}

function requireDate(value: unknown, column: string): string {
  if (typeof value !== "string" || !isIsoDate(value)) throw new Rejection("bad_date", column);
  return value;
}

function requireCurrency(value: unknown): string {
  const currency = typeof value === "string" ? normalizeCurrency(value) : null;
  if (currency === null) throw new Rejection("unknown_currency", "currency");
  return currency;
}

function requireTimezone(value: unknown): string {
  if (typeof value !== "string" || !isTimeZone(value)) throw new Rejection("unknown_timezone", "timezone");
  return value;
}

function parseCutoff(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Rejection("invalid_value", "day_cutoff", "expected HH:MM");
  return Number(match[1]) * 60 + Number(match[2]);
}

// ---------------------------------------------------------------------------------------------
// Time (research R11)

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(epochSeconds: number, timeZone: string) {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(epochSeconds * 1000)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Whether `Intl` accepts `timeZone` as an IANA zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0 && timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The UTC calendar date of an instant, `YYYY-MM-DD`. */
export function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The trading day an instant belongs to at a location: the local calendar date, or the previous
 * one when the local wall-clock time is before the day cutoff (a 01:30 sale with a 04:00 cutoff
 * belongs to the previous day). Wall-clock based, so DST transitions need no special case.
 */
export function businessDayOf(epochSeconds: number, timeZone: string, cutoffMinutes: number):
  { businessDate: string; localHour: number } {
  const local = zoneParts(epochSeconds, timeZone);
  const day = Date.UTC(local.year, local.month - 1, local.day)
    - (local.hour * 60 + local.minute < cutoffMinutes ? 86_400_000 : 0);
  return { businessDate: new Date(day).toISOString().slice(0, 10), localHour: local.hour };
}

/**
 * The instant a local wall-clock time names in `timeZone` (for CSV times without an offset). A
 * time skipped by a DST jump resolves to the instant after the jump.
 */
export function zonedTimeToEpoch(
  local: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): number {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) / 1000;
  const offsetAt = (epoch: number) => {
    const parts = zoneParts(epoch, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - epoch;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  return Math.max(first, second);
}

// ---------------------------------------------------------------------------------------------
// Money and quantities (FR-014, research R11)

// ISO 4217 minor units that are not 2.
const MINOR_UNIT_EXCEPTIONS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

let currencyCodes: ReadonlySet<string> | undefined;

/** The ISO 4217 code for `value` (case-insensitive), or null when it is not one. */
export function normalizeCurrency(value: string): string | null {
  const code = value.trim().toUpperCase();
  currencyCodes ??= new Set(Intl.supportedValuesOf("currency"));
  return /^[A-Z]{3}$/.test(code) && currencyCodes.has(code) ? code : null;
}

/** The number of minor-unit digits of an ISO 4217 currency (JPY 0, USD 2, KWD 3). */
export function currencyExponent(currency: string): number {
  return MINOR_UNIT_EXCEPTIONS[currency] ?? 2;
}

/** How a source writes money. */
export type MoneyFormat = {
  currency: string;
  decimalMark: "." | ",";
};

/**
 * Parses a money cell into integer minor units: strips currency symbols and codes, spaces and
 * thousands separators; reads a leading or trailing minus or surrounding parentheses as negative.
 * Returns null for anything else, and for more decimals than the currency has (unless they are
 * zeros), so no amount is silently rounded.
 */
export function parseMoney(text: string, format: MoneyFormat): number | null {
  let value = text.trim();
  if (!value) return null;
  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[\s\u00a0\u202f']/g, "").replace(/\p{Sc}/gu, "").replace(/^[A-Za-z]{3}|[A-Za-z]{3}$/g, "");
  if (/^[-\u2212]|[-\u2212]$/.test(value)) {
    if (negative) return null;
    negative = true;
    value = value.replace(/^[-\u2212]|[-\u2212]$/g, "");
  }
  const thousands = format.decimalMark === "." ? "," : ".";
  value = value.replaceAll(thousands, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.replace(format.decimalMark, "."));
  if (!match) return null;
  const exponent = currencyExponent(format.currency);
  const [whole, fraction = ""] = [match[1]!, match[2] ?? ""];
  if (/[^0]/.test(fraction.slice(exponent))) return null;
  const minor = Number(whole + fraction.slice(0, exponent).padEnd(exponent, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative && minor !== 0 ? -minor : minor;
}

/**
 * Parses a quantity into integer ten-thousandths, rounding half-even beyond 4 decimals (reported as
 * `rounded`, warning `quantity_rounded`). Returns null when it is not a decimal number.
 */
export function parseQuantity(value: string | number, decimalMark: "." | "," = "."):
  { e4: number; rounded: boolean } | null {
  let text = typeof value === "number"
    ? (Number.isFinite(value) ? value.toFixed(12) : "")
    : value.trim().replace(/[\s\u00a0\u202f]/g, "").replace(decimalMark, ".");
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && !match[2])) return null;
  const fraction = match[2] ?? "";
  let e4 = Number((match[1] || "0") + fraction.slice(0, 4).padEnd(4, "0"));
  const rest = fraction.slice(4).replace(/0+$/, "");
  if (rest) {
    const half = rest[0]! > "5" || (rest[0] === "5" && rest.length > 1) ? 1
      : rest[0] === "5" ? (e4 % 2 === 1 ? 1 : 0) : 0;
    e4 += half;
  }
  if (!Number.isSafeInteger(e4)) return null;
  return { e4: negative && e4 !== 0 ? -e4 : e4, rounded: rest !== "" };
}

/** `numerator / denominator` rounded half-even to an integer (positive denominator). */
export function roundHalfEven(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  const twice = remainder * 2;
  if (twice > denominator || (twice === denominator && quotient % 2 !== 0)) return quotient + 1;
  return quotient;
}
