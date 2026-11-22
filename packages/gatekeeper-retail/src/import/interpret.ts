// The mapping interpreter: CSV records plus a mapping document become canonical records (an
// `IngestBatch`) and row problems. Nothing here runs code from the mapping; it only reads cells
// through the target catalog in `mapping.ts`. Rows sharing the order key form one order; files of
// a set are read one after the other and joined on the order key, and a modifiers file is joined
// to its items through an in-memory lookup.

import type { MappingDocument, MappingTarget } from "../app-api-types.js";
import {
  type CustomerRecord, type IngestBatch, type LineItemRecord, type LocationRecord, type ModifierRecord,
  type OrderRecord, type ProductRecord, type RefundItemRecord, type RejectionReason, type TransactionRecord,
  businessDayOf, normalizeCurrency, parseMoney, parseQuantity, roundHalfEven, zonedTimeToEpoch,
} from "../dataset/ingest.js";
import type { CanonicalTable } from "../dataset/schema.js";
import type { CsvRecord } from "./csv-stream.js";
import {
  SINGLE_FILE_ROLE, TARGETS, type TargetLevel, type WallClock, joinTo, normalizeHeader, parseBoolean,
  parseWallClock, resolveRef,
} from "./mapping.js";

/** One file of the import, as the interpreter reads it. */
export type InterpretFile = { role: string; headers: string[]; rawObjectId: number };

/** A row (or part of one) refused before ingest. `detail` never holds a cell value. */
export type RowProblem = {
  table: CanonicalTable;
  rawObjectId: number;
  row: number;
  reason: RejectionReason;
  column: string | null;
  detail: string | null;
};

/** Carried between batches of one file: the order the last rows belonged to. */
export type GroupState = {
  key: string | null;
  lines: number;
  payments: number;
  returns: number;
  /** Order-level cells of the order's first row (fill-down). */
  fill: Record<number, string> | null;
};

/** Modifier rows of a lookup file, by the item they belong to. */
export type ModifierLookup = Map<string, ModifierRecord[]>;

/** What interpreting a batch of records produced. */
export type InterpretResult = {
  batch: IngestBatch;
  problems: RowProblem[];
  warnings: { fingerprintRows: number; quantityRounded: number };
  state: GroupState;
  /** Rows read. */
  rows: number;
};

/** The empty group state a file starts with. */
export const NEW_GROUP_STATE: GroupState = { key: null, lines: 0, payments: 0, returns: 0, fill: null };

type CompiledTarget = {
  path: string;
  level: TargetLevel;
  kind: (typeof TARGETS)[string]["kind"];
  values: readonly string[];
  column: number;
  constant: string | number | boolean | undefined;
  transform: MappingTarget["transform"];
  valueMap: Map<string, string> | null;
};

/** One file's compiled reading plan. */
export type FilePlan = {
  role: string;
  rawObjectId: number;
  targets: CompiledTarget[];
  levels: Set<TargetLevel>;
  /** Column holding the order key, or the joined column holding it; -1 when fingerprinting. */
  orderColumn: number;
  /** Columns whose blanks fill down from the order's first row. */
  fillColumns: number[];
  refundColumn: number;
  refundValues: Set<string>;
  /** Items file: the column modifiers join on, and the lookup's role. */
  modifierJoin: { column: number; role: string } | null;
  /** Modifiers file: the column that names the item a modifier belongs to; -1 otherwise. */
  lookupKeyColumn: number;
  dateFormat: string;
};

type Value = string | number | boolean | WallClock | null;

class Problem extends Error {
  constructor(readonly reason: RejectionReason, readonly column: string, detail?: string) {
    super(detail ?? reason);
  }
}

const ORDER_LEVELS: ReadonlySet<TargetLevel> = new Set(["order", "location", "customer"]);

/** Interprets the files of one mapping. */
export class MappingInterpreter {
  readonly #document: MappingDocument;
  readonly #isSet: boolean;
  readonly #sourceLabel: string;
  readonly #orderRole: string;
  readonly #modifierRole: string | null;

  constructor(document: MappingDocument, options: { sourceLabel: string }) {
    this.#document = document;
    this.#isSet = (document.files?.length ?? 0) > 0;
    this.#sourceLabel = options.sourceLabel;
    this.#orderRole = document.orderKey === null ? SINGLE_FILE_ROLE : resolveRef(document.orderKey, this.#isSet).role;
    const modifier = document.targets.find(target => TARGETS[target.target]?.level === "modifier" && target.from !== null);
    this.#modifierRole = this.#isSet && modifier ? resolveRef(modifier.from!, true).role : null;
  }

  /**
   * The roles to read, in order: the order key's file first, then the others as declared. A
   * modifiers file is not read on its own; it is a lookup for the items file.
   */
  readOrder(presentRoles: string[]): string[] {
    if (!this.#isSet) return [SINGLE_FILE_ROLE];
    const declared = this.#document.files!.map(file => file.role).filter(role => presentRoles.includes(role));
    return [
      ...declared.filter(role => role === this.#orderRole),
      ...declared.filter(role => role !== this.#orderRole && role !== this.#modifierRole),
    ];
  }

  /** The lookup role an items file needs loaded first, if any. */
  lookupRoleFor(plan: FilePlan): string | null {
    return plan.modifierJoin?.role ?? null;
  }

  /** Compiles the reading plan of one file. */
  plan(file: InterpretFile): FilePlan {
    const index = new Map(file.headers.map((header, column) => [normalizeHeader(header), column] as const));
    const columnOf = (column: string) => index.get(normalizeHeader(column)) ?? -1;
    const fileLevels = new Set<TargetLevel>();
    for (const target of this.#document.targets) {
      if (target.from !== null && resolveRef(target.from, this.#isSet).role === file.role) {
        fileLevels.add(TARGETS[target.target]!.level);
      }
    }
    const isOrderFile = file.role === this.#orderRole;
    if (isOrderFile) for (const level of ORDER_LEVELS) fileLevels.add(level);
    const targets: CompiledTarget[] = [];
    for (const target of this.#document.targets) {
      const spec = TARGETS[target.target]!;
      let column = -1;
      if (target.from !== null) {
        const ref = resolveRef(target.from, this.#isSet);
        if (ref.role !== file.role) continue;
        column = columnOf(ref.column);
        // An optional column absent from this export contributes nothing.
        if (column < 0) continue;
      } else if (!this.#ownsConstant(file.role, spec.level, fileLevels)) {
        continue;
      }
      targets.push({
        path: target.target, level: spec.level, kind: spec.kind, values: spec.values ?? [], column,
        constant: target.constant, transform: target.transform,
        valueMap: target.valueMap
          ? new Map(Object.entries(target.valueMap).map(([from, to]) => [from.trim().toLowerCase(), to]))
          : null,
      });
    }
    let orderColumn = -1;
    if (this.#document.orderKey !== null) {
      if (isOrderFile) {
        orderColumn = columnOf(resolveRef(this.#document.orderKey, this.#isSet).column);
      } else {
        const join = joinTo(this.#document, file.role, this.#orderRole);
        if (join) orderColumn = columnOf(join.from.column);
      }
    }
    let modifierJoin: FilePlan["modifierJoin"] = null;
    if (this.#modifierRole && fileLevels.has("line")) {
      const join = joinTo(this.#document, this.#modifierRole, file.role);
      if (join) modifierJoin = { column: columnOf(join.to.column), role: this.#modifierRole };
    }
    const refund = this.#document.refundWhen;
    const refundRef = refund ? resolveRef(refund.column, this.#isSet) : null;
    const fileFormat = this.#document.files?.find(entry => entry.role === file.role)?.dateFormat;
    return {
      role: file.role,
      rawObjectId: file.rawObjectId,
      targets,
      levels: new Set(targets.map(target => target.level)),
      orderColumn,
      fillColumns: this.#document.fillOrderFieldsDown
        ? targets.filter(target => target.column >= 0 && target.level !== "line" && target.level !== "product")
          .map(target => target.column)
        : [],
      refundColumn: refundRef && refundRef.role === file.role ? columnOf(refundRef.column) : -1,
      refundValues: new Set((refund?.values ?? []).map(value => value.trim().toLowerCase())),
      modifierJoin,
      lookupKeyColumn: (() => {
        if (file.role !== this.#modifierRole) return -1;
        const join = joinTo(this.#document, file.role, this.#lineRole());
        return join ? columnOf(join.from.column) : -1;
      })(),
      dateFormat: fileFormat ?? this.#document.settings.dateFormat,
    };
  }

  /** The raw order key of a row, for keeping an order's rows in one batch; null when fingerprinting. */
  groupKeyOf(plan: FilePlan, cells: string[]): string | null {
    return plan.orderColumn < 0 ? null : (cells[plan.orderColumn] ?? "").trim();
  }

  /** Adds the rows of a modifiers file to `lookup`. */
  addModifiers(plan: FilePlan, records: CsvRecord[], lookup: ModifierLookup): void {
    if (plan.lookupKeyColumn < 0) return;
    const warnings = { quantityRounded: 0 };
    for (const record of records) {
      const key = (record.cells[plan.lookupKeyColumn] ?? "").trim();
      if (!key) continue;
      const values = new Map<string, Value>();
      try {
        for (const target of plan.targets) values.set(target.path, this.#value(target, record.cells, plan, warnings));
      } catch (error) {
        if (error instanceof Problem) continue;
        throw error;
      }
      const name = values.get("line_items.modifier_name");
      if (typeof name !== "string" || !name) continue;
      const quantity = values.get("line_items.modifier_quantity");
      const modifier: ModifierRecord = {
        name,
        price_amount: (values.get("line_items.modifier_price_amount") as number | null) ?? 0,
        quantity: typeof quantity === "number" ? quantity / 10_000 : 1,
      };
      const list = lookup.get(key);
      if (list) list.push(modifier);
      else lookup.set(key, [modifier]);
    }
  }

  /** Interprets records of one file. */
  async interpret(
    plan: FilePlan,
    records: CsvRecord[],
    state: GroupState,
    lookup: ModifierLookup | null,
  ): Promise<InterpretResult> {
    const settings = this.#document.settings;
    const batch: Required<Pick<IngestBatch, "locations" | "customers" | "products" | "orders" | "lineItems" | "transactions" | "refundItems">> = {
      locations: [], customers: [], products: [], orders: [], lineItems: [], transactions: [], refundItems: [],
    };
    const problems: RowProblem[] = [];
    const warnings = { fingerprintRows: 0, quantityRounded: 0 };
    const seen = { locations: new Set<string>(), customers: new Set<string>(), products: new Set<string>(), orders: new Map<string, OrderRecord>(), payments: new Set<string>() };
    // Lines by order, for orders read from the same file as their lines.
    const linesOf = new Map<string, LineItemRecord[]>();
    const orderTaxMapped = this.#document.targets.some(target => target.target === "orders.tax_amount");
    const statedTotals = new Set<string>();
    const counters = new Map<string, { lines: number; payments: number; returns: number }>();
    let current: GroupState = { ...state, fill: state.fill ? { ...state.fill } : null };
    if (current.key !== null) counters.set(current.key, { lines: current.lines, payments: current.payments, returns: current.returns });

    for (const record of records) {
      const cells = [...record.cells];
      const problem = (table: CanonicalTable, error: Problem) => problems.push({
        table, rawObjectId: plan.rawObjectId, row: record.row, reason: error.reason, column: error.column,
        detail: error.message === error.reason ? null : error.message,
      });

      // Order identity, and fill-down of order fields from the order's first row.
      let orderRef: string;
      let groupKey = this.groupKeyOf(plan, cells);
      // Continuation rows (Shopify) may leave the order key blank too.
      if (groupKey === "" && this.#document.fillOrderFieldsDown && current.key !== null) groupKey = current.key;
      if (groupKey !== null) {
        if (!groupKey) {
          problem(plan.levels.has("order") ? "orders" : plan.levels.has("payment") ? "transactions" : "line_items",
            new Problem("missing_required", "order key", "the order key cell is empty"));
          continue;
        }
        orderRef = groupKey;
        if (groupKey !== current.key) {
          current = { key: groupKey, lines: 0, payments: 0, returns: 0, fill: null };
        }
        if (plan.fillColumns.length > 0) {
          if (current.fill === null) {
            current.fill = Object.fromEntries(plan.fillColumns.map(column => [column, cells[column] ?? ""]));
          } else {
            for (const column of plan.fillColumns) {
              if ((cells[column] ?? "").trim() === "") cells[column] = current.fill[column] ?? "";
            }
          }
        }
      } else {
        orderRef = await this.#fingerprint(plan, cells);
        warnings.fingerprintRows++;
      }
      const counter = counters.get(orderRef) ?? { lines: 0, payments: 0, returns: 0 };
      counters.set(orderRef, counter);

      // Read every target of the row; a problem refuses the level it belongs to.
      const values = new Map<string, Value>();
      const clocks = new Map<string, { level: TargetLevel; parts: WallClock[] }>();
      const levelProblems = new Map<TargetLevel, Problem>();
      for (const target of plan.targets) {
        if (levelProblems.has(target.level)) continue;
        try {
          const value = this.#value(target, cells, plan, warnings);
          if (value !== null && typeof value === "object") {
            const entry = clocks.get(target.path) ?? { level: target.level, parts: [] };
            entry.parts.push(value);
            clocks.set(target.path, entry);
          }
          if (values.get(target.path) == null) values.set(target.path, value);
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          levelProblems.set(target.level, error);
        }
      }
      const get = (path: string): Value => values.get(path) ?? null;
      const mappedCurrency = get("orders.currency") as string | null;
      const currency = mappedCurrency
        ? normalizeCurrency(mappedCurrency) ?? mappedCurrency
        : normalizeCurrency(settings.currency) ?? settings.currency;
      const timezone = (get("locations.timezone") as string | null) ?? settings.timezone;
      const times = new Map<string, { epoch: number; dateOnly: string | null }>();
      for (const [path, { level, parts }] of clocks) {
        if (levelProblems.has(level)) continue;
        try {
          times.set(path, toInstant(path, parts, timezone));
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          levelProblems.set(level, error);
        }
      }
      const timestamp = (path: string) => times.get(path) ?? null;

      // Returns of items (refundWhen): a refund item and its refund transaction, nothing else.
      if (plan.refundColumn >= 0 && plan.refundValues.has((cells[plan.refundColumn] ?? "").trim().toLowerCase())) {
        const lineProblem = levelProblems.get("line") ?? levelProblems.get("order");
        if (lineProblem) {
          problem("refund_items", lineProblem);
          continue;
        }
        const quantity = Math.abs((get("line_items.quantity") as number | null) ?? 10_000);
        const unit = get("line_items.unit_price_amount") as number | null;
        const gross = Math.abs((get("line_items.gross_amount") as number | null) ?? (unit === null ? 0 : roundHalfEven(Math.abs(unit) * quantity, 10_000)));
        const discount = Math.abs((get("line_items.discount_amount") as number | null) ?? 0);
        const tax = Math.abs((get("line_items.tax_amount") as number | null) ?? 0);
        const at = timestamp("orders.closed_at") ?? timestamp("orders.opened_at");
        if (!at) {
          problem("refund_items", new Problem("missing_required", "orders.closed_at", "a return needs when it happened"));
          continue;
        }
        const id = `${orderRef}:return:${++counter.returns}`;
        const productRef = this.#product(values, get, batch.products, seen.products, currency, plan, record);
        batch.transactions.push({
          sourceRecordId: `${id}:refund`, orderRef, kind: "refund", amount: gross - discount + tax,
          salesAmount: gross - discount, taxAmount: tax, currency, occurredAt: at.epoch,
          rawObjectId: plan.rawObjectId, rowIndex: record.row,
        });
        batch.refundItems.push({
          sourceRecordId: id, orderRef, transactionRef: `${id}:refund`, productRef, quantityE4: quantity,
          salesAmount: gross - discount, taxAmount: tax, currency, rawObjectId: plan.rawObjectId, rowIndex: record.row,
        } satisfies RefundItemRecord);
        continue;
      }

      // The order, once per batch.
      if (plan.levels.has("order") && !seen.orders.has(orderRef)) {
        const orderProblem = levelProblems.get("order") ?? levelProblems.get("location");
        if (orderProblem) {
          problem("orders", orderProblem);
          continue;
        }
        const locationName = get("locations.name") as string | null;
        const locationRef = locationName ? `name:${locationName.trim().toLowerCase()}` : "default";
        if (!seen.locations.has(locationRef)) {
          seen.locations.add(locationRef);
          batch.locations.push({
            sourceRecordId: locationRef, name: locationName?.trim() || this.#sourceLabel, timezone,
            currency, kind: (get("locations.kind") as LocationRecord["kind"] | null) ?? undefined,
            rawObjectId: plan.rawObjectId, rowIndex: record.row,
          });
        }
        let customerRef: string | null = null;
        if (levelProblems.has("customer")) problem("customers", levelProblems.get("customer")!);
        else customerRef = await this.#customer(get, batch.customers, seen.customers, plan, record);
        const opened = timestamp("orders.opened_at");
        const closed = timestamp("orders.closed_at");
        const stated = get("orders.business_date") as WallClock | null;
        let businessDate: string | null = stated ? isoDate(stated) : null;
        if (!businessDate && settings.businessDate === "from_file_date" && settings.fileDate) {
          businessDate = settings.fileDate;
          // A check from an earlier day repeated in this set (edited since) keeps its own day.
          const at = closed ?? opened;
          if (at && !at.dateOnly) {
            const cutoff = get("locations.kind") === "restaurant" ? 240 : 0;
            const own = businessDayOf(at.epoch, timezone, cutoff).businessDate;
            if (own < businessDate) businessDate = own;
          }
        }
        // A date without a time names the trading day itself.
        businessDate ??= (closed ?? opened)?.dateOnly ?? null;
        const order: OrderRecord = {
          sourceRecordId: orderRef,
          locationRef,
          customerRef,
          orderNumber: (get("orders.order_number") as string | null) ?? null,
          status: (get("orders.status") as OrderRecord["status"] | null) ?? "completed",
          channel: (get("orders.channel") as OrderRecord["channel"] | null) ?? undefined,
          openedAt: opened?.epoch ?? null,
          closedAt: closed?.epoch ?? null,
          businessDate,
          currency,
          grossAmount: get("orders.gross_amount") as number | null,
          discountAmount: (get("orders.discount_amount") as number | null) ?? 0,
          serviceChargeAmount: (get("orders.service_charge_amount") as number | null) ?? 0,
          taxAmount: (get("orders.tax_amount") as number | null) ?? 0,
          tipAmount: (get("orders.tip_amount") as number | null) ?? 0,
          totalAmount: (get("orders.total_amount") as number | null) ?? 0,
          pricesIncludeTax: (get("orders.prices_include_tax") as boolean | null) ?? false,
          guestCount: (get("orders.guest_count") as number | null) ?? null,
          rawObjectId: plan.rawObjectId,
          rowIndex: record.row,
        };
        if (plan.levels.has("line")) linesOf.set(orderRef, []);
        if (get("orders.total_amount") !== null) statedTotals.add(orderRef);
        seen.orders.set(orderRef, order);
        batch.orders.push(order);
      } else if (plan.levels.has("order") && levelProblems.has("order")) {
        // A later row of an order already read: its own order cells are not used.
        levelProblems.delete("order");
      }

      // The line item.
      const name = get("line_items.name") as string | null;
      if (plan.levels.has("line") && name) {
        const lineProblem = levelProblems.get("line") ?? levelProblems.get("product");
        if (lineProblem) {
          problem("line_items", lineProblem);
        } else {
          const quantity = (get("line_items.quantity") as number | null) ?? 10_000;
          const gross = get("line_items.gross_amount") as number | null;
          let unit = get("line_items.unit_price_amount") as number | null;
          if (unit === null) unit = gross === null ? 0 : quantity === 0 ? gross : roundHalfEven(gross * 10_000, quantity);
          const lineId = (get("line_items.source_record_id") as string | null) ?? `${orderRef}:${++counter.lines}`;
          const productRef = this.#product(values, get, batch.products, seen.products, currency, plan, record);
          const modifierKey = plan.modifierJoin ? (cells[plan.modifierJoin.column] ?? "").trim() : "";
          const line: LineItemRecord = {
            sourceRecordId: lineId, orderRef, productRef, name, quantityE4: quantity, unitPriceAmount: unit,
            ...(gross === null ? {} : { grossAmount: gross }),
            discountAmount: (get("line_items.discount_amount") as number | null) ?? 0,
            taxAmount: (get("line_items.tax_amount") as number | null) ?? 0,
            unitCostAmount: get("line_items.unit_cost_amount") as number | null,
            isVoided: (get("line_items.is_voided") as boolean | null) ?? false,
            modifiers: modifierKey ? lookup?.get(modifierKey) ?? null : null,
            rawObjectId: plan.rawObjectId, rowIndex: record.row,
          };
          batch.lineItems.push(line);
          linesOf.get(orderRef)?.push(line);
        }
      }

      // Payments and order-level refunds.
      if (plan.levels.has("payment")) {
        const paymentProblem = levelProblems.get("payment");
        if (paymentProblem) {
          problem("transactions", paymentProblem);
          continue;
        }
        const order = seen.orders.get(orderRef);
        const orderTime = order ? order.closedAt ?? order.openedAt ?? null : null;
        const amount = get("transactions.amount") as number | null;
        const paidAt = timestamp("transactions.occurred_at")?.epoch ?? orderTime;
        let paymentRef: string | null = null;
        if (amount !== null && amount !== 0) {
          const explicit = get("transactions.source_record_id") as string | null;
          // Without an id: one payment per order in the order's file, numbered in a payments file.
          paymentRef = explicit
            ?? (plan.role === this.#orderRole ? `${orderRef}:payment` : `${orderRef}:payment:${++counter.payments}`);
          if (paidAt === null) {
            problem("transactions", new Problem("missing_required", "transactions.occurred_at", "a payment needs when it happened"));
          } else if (!seen.payments.has(paymentRef)) {
            seen.payments.add(paymentRef);
            batch.transactions.push({
              sourceRecordId: paymentRef, orderRef, kind: amount < 0 ? "refund" : "payment",
              tender: (get("transactions.tender") as TransactionRecord["tender"] | null) ?? null,
              cardBrand: (get("transactions.card_brand") as string | null) ?? null,
              amount: Math.abs(amount),
              tipAmount: get("transactions.tip_amount") as number | null,
              feeAmount: get("transactions.fee_amount") as number | null,
              currency, occurredAt: paidAt,
              status: (get("transactions.status") as TransactionRecord["status"] | null) ?? undefined,
              rawObjectId: plan.rawObjectId, rowIndex: record.row,
            });
          }
        }
        const refunded = get("transactions.refund_amount") as number | null;
        if (refunded !== null && refunded !== 0) {
          const refundRef = `${paymentRef ?? orderRef}:refund`;
          const refundedAt = timestamp("transactions.refund_occurred_at")?.epoch ?? paidAt;
          if (refundedAt === null) {
            problem("transactions", new Problem("missing_required", "transactions.refund_occurred_at", "a refund needs when it happened"));
          } else if (!seen.payments.has(refundRef)) {
            seen.payments.add(refundRef);
            batch.transactions.push({
              sourceRecordId: refundRef, orderRef, parentRef: paymentRef, kind: "refund", amount: Math.abs(refunded),
              currency, occurredAt: refundedAt, rawObjectId: plan.rawObjectId, rowIndex: record.row,
            });
          }
        }
      }
    }

    // Orders with their lines in this file: tax from the lines when the order states none, and the
    // total from the lines plus the order's own charges when the order states none.
    for (const [orderRef, lines] of linesOf) {
      const order = seen.orders.get(orderRef)!;
      const live = lines.filter(line => !line.isVoided);
      if (!orderTaxMapped) order.taxAmount = live.reduce((sum, line) => sum + (line.taxAmount ?? 0), 0);
      if (statedTotals.has(orderRef)) continue;
      const net = live.reduce((sum, line) =>
        sum + (line.grossAmount ?? roundHalfEven(line.quantityE4 * line.unitPriceAmount, 10_000)) - (line.discountAmount ?? 0), 0);
      order.totalAmount = net - (order.discountAmount ?? 0) + (order.serviceChargeAmount ?? 0)
        + (order.pricesIncludeTax ? 0 : order.taxAmount ?? 0) + (order.tipAmount ?? 0);
    }
    const last = current.key === null ? null : counters.get(current.key);
    if (last) Object.assign(current, last);
    return {
      batch: Object.fromEntries(Object.entries(batch).filter(([, list]) => list.length > 0)) as IngestBatch,
      problems,
      warnings,
      state: current,
      rows: records.length,
    };
  }

  /** The typed value of one target in a row; null for a blank cell. Throws `Problem`. */
  #value(target: CompiledTarget, cells: string[], plan: FilePlan, warnings: { quantityRounded: number }): Value {
    const settings = this.#document.settings;
    if (target.column < 0 && typeof target.constant !== "string") {
      return target.constant ?? null;
    }
    const raw = target.column < 0 ? String(target.constant) : cells[target.column] ?? "";
    const text = raw.trim();
    if (text === "") return null;
    switch (target.kind) {
      case "money": {
        const currency = normalizeCurrency(settings.currency) ?? "USD";
        const amount = parseMoney(text, { currency, decimalMark: settings.decimalMark });
        if (amount === null) throw new Problem("bad_amount", target.path, "not an amount in the mapping's format");
        return target.transform === "negate_money" ? -amount || 0 : amount;
      }
      case "date":
      case "datetime":
      case "time": {
        const clock = parseWallClock(text, plan.dateFormat);
        if (!clock) throw new Problem("bad_date", target.path, `not a date in the format ${plan.dateFormat}`);
        return clock;
      }
      case "quantity":
      case "integer": {
        const percent = target.transform === "percent";
        const parsed = parseQuantity(percent ? text.replace(/%$/, "") : text, settings.decimalMark);
        if (!parsed) throw new Problem("invalid_value", target.path, "not a number");
        if (target.kind === "integer") {
          if (parsed.e4 % 10_000 !== 0) throw new Problem("invalid_value", target.path, "not a whole number");
          return parsed.e4 / 10_000;
        }
        if (parsed.rounded) warnings.quantityRounded++;
        return percent ? roundHalfEven(parsed.e4, 100) : parsed.e4;
      }
      case "boolean": {
        const value = parseBoolean(text);
        if (value === null) throw new Problem("invalid_value", target.path, "not yes or no");
        return value;
      }
      case "enum": {
        const key = text.toLowerCase();
        const mapped = target.valueMap?.get(key);
        if (mapped) return mapped;
        const canonical = target.values.find(value => value === key.replace(/[\s-]+/g, "_"));
        if (canonical) return canonical;
        if (target.values.includes("other")) return "other";
        throw new Problem("invalid_value", target.path, `not one of ${target.values.join(", ")}; add a value map`);
      }
      case "text": {
        switch (target.transform) {
          case "lowercase": return text.toLowerCase();
          case "uppercase": return text.toUpperCase();
          case "split_name_first": return text.split(/\s+/)[0] ?? null;
          case "split_name_last": {
            const parts = text.split(/\s+/);
            return parts.length > 1 ? parts.slice(1).join(" ") : null;
          }
          default: return text;
        }
      }
    }
  }

  async #customer(
    get: (path: string) => Value, customers: CustomerRecord[], seen: Set<string>, plan: FilePlan, record: CsvRecord,
  ): Promise<string | null> {
    const firstName = get("customers.first_name") as string | null;
    const lastName = get("customers.last_name") as string | null;
    const email = get("customers.email") as string | null;
    const phone = get("customers.phone") as string | null;
    const explicit = get("customers.source_record_id") as string | null;
    if (!explicit && !email && !phone && !firstName && !lastName) return null;
    const ref = explicit ?? `fp:${await sha256Hex([
      email?.toLowerCase() ?? "", phone?.replace(/\D/g, "") ?? "", `${firstName ?? ""} ${lastName ?? ""}`.trim().toLowerCase(),
    ].join("\0"))}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      customers.push({
        sourceRecordId: ref, firstName, lastName, email, phone,
        marketingOptIn: get("customers.marketing_opt_in") as boolean | null,
        rawObjectId: plan.rawObjectId, rowIndex: record.row,
      });
    }
    return ref;
  }

  #product(
    values: Map<string, Value>, get: (path: string) => Value, products: ProductRecord[], seen: Set<string>,
    currency: string, plan: FilePlan, record: CsvRecord,
  ): string | null {
    if (![...values.keys()].some(key => key.startsWith("products."))) return null;
    const sku = get("products.sku") as string | null;
    const name = (get("products.name") as string | null) ?? (get("line_items.name") as string | null);
    if (!sku && !name) return null;
    const variant = get("products.variant_name") as string | null;
    const ref = sku ? `sku:${sku}` : `name:${name!.toLowerCase()}|${variant?.toLowerCase() ?? ""}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      products.push({
        sourceRecordId: ref, name: name ?? sku!, variantName: variant, sku,
        barcode: get("products.barcode") as string | null, category: get("products.category") as string | null,
        currency, unitCostAmount: get("products.unit_cost_amount") as number | null,
        rawObjectId: plan.rawObjectId, rowIndex: record.row,
      });
    }
    return ref;
  }

  /** `fp:` plus the SHA-256 of the fingerprint fields' cells (US2.5). */
  async #fingerprint(plan: FilePlan, cells: string[]): Promise<string> {
    const paths = this.#document.fingerprint ?? [];
    const parts = paths.map(path => plan.targets
      .filter(target => target.path === path && target.column >= 0)
      .map(target => (cells[target.column] ?? "").trim())
      .join(" "));
    return `fp:${await sha256Hex(parts.join("\0"))}`;
  }

  #ownsConstant(role: string, level: TargetLevel, fileLevels: Set<TargetLevel>): boolean {
    if (!this.#isSet) return true;
    if (ORDER_LEVELS.has(level)) return role === this.#orderRole;
    if (level === "product" || level === "line") return role === this.#lineRole();
    return fileLevels.has(level);
  }

  /** The file holding the item names. */
  #lineRole(): string {
    const line = this.#document.targets.find(target => target.target === "line_items.name" && target.from !== null);
    return line ? resolveRef(line.from!, this.#isSet).role : this.#orderRole;
  }
}

/**
 * The instant a timestamp target names, combining a date column with a time column. A cell with an
 * offset is exact; otherwise the wall clock is read in `timezone`.
 */
function toInstant(path: string, parts: WallClock[], timezone: string): { epoch: number; dateOnly: string | null } {
  const clock: WallClock = Object.assign({}, ...parts);
  if (clock.year === undefined || clock.month === undefined || clock.day === undefined) {
    throw new Problem("bad_date", path, "a time without a date");
  }
  const local = {
    year: clock.year, month: clock.month, day: clock.day,
    hour: clock.hour ?? 0, minute: clock.minute ?? 0, second: clock.second ?? 0,
  };
  const epoch = clock.offsetMinutes !== undefined
    ? Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) / 1000
      - clock.offsetMinutes * 60
    : zonedTimeToEpoch(local, timezone);
  return { epoch, dateOnly: clock.hour === undefined ? isoDate(clock) : null };
}

/** `YYYY-MM-DD` of a wall clock with a date. */
function isoDate(clock: WallClock): string {
  return `${String(clock.year).padStart(4, "0")}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
}

/** SHA-256 of `text`, hex, first 32 characters (128 bits). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
}
