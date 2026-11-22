// The mapping document (contracts/mapping-document.md): data, never code. This module holds its zod
// schema, the catalog of target fields, the validation rules, the conversion from the agent's
// `RetailMapping`, and the cell parsers the interpreter (`interpret.ts`) applies.

import { z } from "zod";
import type { ColumnRef, MappingDocument, MappingTarget, MappingTransform, TargetInfo } from "../app-api-types.js";
import { isIsoDate, isTimeZone, normalizeCurrency } from "../dataset/ingest.js";
import type { RetailMapping } from "../types.js";

/** Size limits of one mapping (contracts/mapping-document.md). */
export const MAPPING_LIMITS = { maxBytes: 64 * 1024, maxTargets: 200, maxFiles: 10 } as const;

/** The role of the only file of a single-file import. */
export const SINGLE_FILE_ROLE = "file";

/** What a target is attached to; decides which records a row produces. */
export type TargetLevel = "location" | "customer" | "order" | "line" | "product" | "modifier" | "payment";

type TargetSpec = Omit<TargetInfo, "path"> & { level: TargetLevel };

const money = (label: string, level: TargetLevel, description: string): TargetSpec =>
  ({ label, kind: "money", level, description });
const text = (label: string, level: TargetLevel, description: string, personal?: boolean): TargetSpec =>
  ({ label, kind: "text", level, description, ...(personal ? { personal } : {}) });

/** Every target field a mapping may name. Lineage and id columns are not targets. */
export const TARGETS: Readonly<Record<string, TargetSpec>> = {
  "locations.name": text("Location name", "location", "Rows with the same name share a location. Without it, one location named after the source is used."),
  "locations.timezone": text("Location time zone", "location", "IANA time zone; defaults to the mapping's time zone."),
  "locations.kind": { label: "Location kind", kind: "enum", values: ["store", "restaurant", "online", "other"], level: "location", description: "Restaurants get a 04:00 day cutoff." },

  "customers.source_record_id": text("Customer id", "customer", "The source's own customer id."),
  "customers.first_name": text("Customer first name", "customer", "Personal data.", true),
  "customers.last_name": text("Customer last name", "customer", "Personal data.", true),
  "customers.email": text("Customer email", "customer", "Personal data.", true),
  "customers.phone": text("Customer phone", "customer", "Personal data.", true),
  "customers.marketing_opt_in": { label: "Marketing opt-in", kind: "boolean", level: "customer", description: "Whether the customer accepts marketing." },

  "orders.order_number": text("Order number", "order", "The number staff and receipts show."),
  "orders.status": { label: "Order status", kind: "enum", values: ["open", "completed", "voided", "refunded", "partially_refunded"], level: "order", description: "Defaults to completed." },
  "orders.channel": { label: "Channel", kind: "enum", values: ["in_store", "online", "delivery", "other"], level: "order", description: "Defaults to other." },
  "orders.opened_at": { label: "Opened at", kind: "datetime", level: "order", description: "When the order was opened." },
  "orders.closed_at": { label: "Closed at", kind: "datetime", level: "order", description: "When the order was paid or closed; the business date comes from it." },
  "orders.business_date": { label: "Business date", kind: "date", level: "order", description: "The trading day, when the file states it." },
  "orders.currency": text("Currency", "order", "ISO 4217 code; defaults to the mapping's currency."),
  "orders.gross_amount": money("Order gross", "order", "Used only when the order has no line items."),
  "orders.discount_amount": money("Order discount", "order", "Order-level discount; line discounts are added."),
  "orders.service_charge_amount": money("Service charge", "order", "Service charges."),
  "orders.tax_amount": money("Tax", "order", "Tax on the order."),
  "orders.tip_amount": money("Tip", "order", "Tips and gratuity."),
  "orders.total_amount": money("Order total", "order", "What the customer was charged. Derived from the lines when unmapped."),
  "orders.prices_include_tax": { label: "Prices include tax", kind: "boolean", level: "order", description: "Tax-inclusive pricing." },
  "orders.guest_count": { label: "Guests", kind: "integer", level: "order", description: "Restaurants." },

  "line_items.source_record_id": text("Line id", "line", "The source's own line id; otherwise lines are numbered within the order."),
  "line_items.name": text("Item name", "line", "As sold."),
  "line_items.quantity": { label: "Quantity", kind: "quantity", level: "line", description: "Up to 4 decimals." },
  "line_items.unit_price_amount": money("Unit price", "line", "Including modifier prices."),
  "line_items.gross_amount": money("Line gross", "line", "Quantity × unit price; the unit price is derived from it when unmapped."),
  "line_items.discount_amount": money("Line discount", "line", "Discount on the line."),
  "line_items.tax_amount": money("Line tax", "line", "Tax on the line."),
  "line_items.unit_cost_amount": money("Unit cost", "line", "Cost at the time of sale."),
  "line_items.is_voided": { label: "Line voided", kind: "boolean", level: "line", description: "An item voided on an order that otherwise stands." },
  "line_items.modifier_name": text("Modifier name", "modifier", "From a modifiers file joined to the items."),
  "line_items.modifier_price_amount": money("Modifier price", "modifier", "From a modifiers file joined to the items."),
  "line_items.modifier_quantity": { label: "Modifier quantity", kind: "quantity", level: "modifier", description: "From a modifiers file joined to the items." },

  "products.sku": text("SKU", "product", "The cross-source match key."),
  "products.name": text("Product name", "product", "Defaults to the item name."),
  "products.variant_name": text("Variant", "product", "e.g. Large."),
  "products.barcode": text("Barcode", "product", "Barcode."),
  "products.category": text("Category", "product", "Category or menu group."),
  "products.unit_cost_amount": money("Product cost", "product", "Current unit cost."),

  "transactions.source_record_id": text("Payment id", "payment", "The source's own payment id."),
  "transactions.amount": money("Payment amount", "payment", "Amount paid."),
  "transactions.tip_amount": money("Payment tip", "payment", "Tip included in the payment."),
  "transactions.fee_amount": money("Processing fee", "payment", "Processor fee."),
  "transactions.tender": { label: "Tender", kind: "enum", values: ["card", "cash", "gift_card", "wallet", "other"], level: "payment", description: "How it was paid." },
  "transactions.card_brand": text("Card brand", "payment", "Never card numbers."),
  "transactions.occurred_at": { label: "Paid at", kind: "datetime", level: "payment", description: "When the payment happened; defaults to the order's time." },
  "transactions.status": { label: "Payment status", kind: "enum", values: ["succeeded", "failed", "pending"], level: "payment", description: "Defaults to succeeded." },
  "transactions.refund_amount": money("Refunded amount", "payment", "A refund of this amount (no itemization)."),
  "transactions.refund_occurred_at": { label: "Refunded at", kind: "datetime", level: "payment", description: "When the refund happened; defaults to the payment's or order's time." },
};

/** The catalog as the Data area lists it. */
export const TARGET_INFOS: readonly TargetInfo[] = Object.entries(TARGETS)
  .map(([path, { level: _level, ...info }]) => ({ path, ...info }));

const TRANSFORMS = [
  "date", "datetime", "time", "money", "negate_money", "quantity", "percent", "lowercase", "uppercase",
  "trim", "boolean", "split_name_first", "split_name_last",
] as const satisfies readonly MappingTransform[];

// Which transforms make sense for which target kinds.
const TRANSFORMS_BY_KIND: Readonly<Record<TargetInfo["kind"], readonly MappingTransform[]>> = {
  text: ["trim", "lowercase", "uppercase", "split_name_first", "split_name_last"],
  enum: ["trim", "lowercase", "uppercase", "boolean"],
  money: ["money", "negate_money"],
  datetime: ["datetime", "date", "time"],
  date: ["date", "datetime"],
  time: ["time"],
  quantity: ["quantity", "percent"],
  boolean: ["boolean"],
  integer: ["quantity"],
};

const columnRef = z.union([
  z.string().min(1).max(200),
  z.strictObject({ file: z.string().min(1).max(100), column: z.string().min(1).max(200) }),
]);

const scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);

const targetSchema = z.strictObject({
  target: z.string().min(1).max(100),
  from: columnRef.nullable(),
  constant: scalar.optional(),
  transform: z.enum(TRANSFORMS).optional(),
  valueMap: z.record(z.string().max(200), z.string().max(100)).optional(),
});

/** The zod schema of a mapping document. */
export const mappingDocumentSchema = z.strictObject({
  version: z.literal(1),
  parsing: z.strictObject({
    encoding: z.string().min(1).max(40).optional(),
    delimiter: z.enum([",", ";", "\t", "|"]).optional(),
    headerRow: z.int().min(1).max(1000).optional(),
    footerRows: z.int().min(0).max(100).optional(),
  }).optional(),
  settings: z.strictObject({
    timezone: z.string().min(1).max(100),
    currency: z.string().min(3).max(3),
    dateFormat: z.string().min(1).max(60),
    decimalMark: z.enum([".", ","]),
    negativeStyle: z.enum(["minus", "parentheses"]).optional(),
    businessDate: z.enum(["from_column", "from_timestamp", "from_file_date"]).optional(),
    fileDate: z.string().max(10).optional(),
  }),
  files: z.array(z.strictObject({
    role: z.string().min(1).max(100),
    required: z.boolean(),
    headerSignature: z.array(z.string().min(1).max(200)).max(100),
    dateFormat: z.string().min(1).max(60).optional(),
  })).max(MAPPING_LIMITS.maxFiles).optional(),
  orderKey: columnRef.nullable(),
  fingerprint: z.array(z.string().max(100)).max(20).optional(),
  fillOrderFieldsDown: z.boolean().optional(),
  refundWhen: z.strictObject({ column: columnRef, values: z.array(z.string().max(200)).min(1).max(20) }).optional(),
  targets: z.array(targetSchema).max(MAPPING_LIMITS.maxTargets),
  joins: z.array(z.strictObject({ from: columnRef, to: columnRef })).max(20).optional(),
}) satisfies z.ZodType<MappingDocument>;

/** The zod schema of the agent's `RetailMapping`. */
export const agentMappingSchema = z.strictObject({
  settings: z.strictObject({
    timezone: z.string().min(1).max(100),
    currency: z.string().min(3).max(3),
    dateFormat: z.string().min(1).max(60),
    decimalMark: z.enum([".", ","]),
  }),
  orderKey: z.string().min(1).max(200).nullable(),
  fields: z.array(z.strictObject({
    target: z.string().min(1).max(100),
    from: z.string().min(1).max(200).nullable(),
    constant: scalar.optional(),
    transform: z.enum(["date", "datetime", "money", "negate_money", "quantity", "lowercase", "trim"]).optional(),
  })).max(MAPPING_LIMITS.maxTargets),
}) satisfies z.ZodType<RetailMapping>;

/** A mapping that failed validation; the message names the field. */
export class MappingError extends Error {}

/** A file of a staged import, as validation sees it. */
export type MappingFile = { role: string; headers: string[] };

/** Parses and validates a mapping document. Throws `MappingError` naming the field. */
export function parseMappingDocument(input: unknown): MappingDocument {
  const size = new TextEncoder().encode(JSON.stringify(input) ?? "").length;
  if (size > MAPPING_LIMITS.maxBytes) throw new MappingError(`The mapping is ${size} bytes; at most 64 KiB is allowed.`);
  const result = mappingDocumentSchema.safeParse(input);
  if (!result.success) throw new MappingError(describeZodError(result.error));
  return result.data;
}

/** Converts the agent's mapping of a single file into a mapping document. */
export function fromAgentMapping(input: unknown, base?: MappingDocument | null): MappingDocument {
  const size = new TextEncoder().encode(JSON.stringify(input) ?? "").length;
  if (size > MAPPING_LIMITS.maxBytes) throw new MappingError(`The mapping is ${size} bytes; at most 64 KiB is allowed.`);
  const result = agentMappingSchema.safeParse(input);
  if (!result.success) throw new MappingError(describeZodError(result.error));
  const mapping = result.data;
  const targets: MappingTarget[] = mapping.fields.map(field => ({
    target: field.target,
    from: field.from,
    ...(field.constant === undefined ? {} : { constant: field.constant }),
    ...(field.transform === undefined ? {} : { transform: field.transform }),
  }));
  return {
    version: 1,
    ...(base?.parsing ? { parsing: base.parsing } : {}),
    settings: { ...mapping.settings },
    orderKey: mapping.orderKey,
    ...(mapping.orderKey === null
      ? { fingerprint: [...new Set(targets.filter(t => t.target.startsWith("orders.")).map(t => t.target))] }
      : {}),
    targets,
  };
}

/** The agent-facing subset of a single-file mapping document. */
export function toAgentMapping(document: MappingDocument): RetailMapping {
  const agentTransforms = new Set(["date", "datetime", "money", "negate_money", "quantity", "lowercase", "trim"]);
  return {
    settings: {
      timezone: document.settings.timezone,
      currency: document.settings.currency,
      dateFormat: document.settings.dateFormat,
      decimalMark: document.settings.decimalMark,
    },
    orderKey: typeof document.orderKey === "string" ? document.orderKey : document.orderKey?.column ?? null,
    fields: document.targets.map(target => ({
      target: target.target,
      from: target.from === null ? null : typeof target.from === "string" ? target.from : target.from.column,
      ...(target.constant === undefined ? {} : { constant: target.constant }),
      ...(target.transform && agentTransforms.has(target.transform)
        ? { transform: target.transform as NonNullable<RetailMapping["fields"][number]["transform"]> }
        : {}),
    })),
  };
}

/**
 * Checks the rules of contracts/mapping-document.md against the staged files: known targets and
 * transforms, required targets, columns that exist, roles that are declared, and a valid zone and
 * currency. Throws `MappingError` naming the field.
 */
export function validateMapping(document: MappingDocument, files: MappingFile[] | null): void {
  const fail = (message: string): never => {
    throw new MappingError(message);
  };
  if (!isTimeZone(document.settings.timezone)) fail(`settings.timezone: "${document.settings.timezone}" is not a time zone.`);
  if (normalizeCurrency(document.settings.currency) === null) fail(`settings.currency: "${document.settings.currency}" is not an ISO 4217 currency.`);
  compileDateFormat(document.settings.dateFormat);
  for (const file of document.files ?? []) if (file.dateFormat) compileDateFormat(file.dateFormat);
  if (document.settings.fileDate !== undefined && !isIsoDate(document.settings.fileDate)) {
    fail("settings.fileDate: expected a date written YYYY-MM-DD.");
  }

  const isSet = (document.files?.length ?? 0) > 0;
  const roles = new Map((document.files ?? []).map(file => [file.role, file]));
  if (isSet && roles.size !== document.files!.length) fail("files: two files share a role.");
  // Without files (a template saved on its own), only the document itself is checked.
  const headersByRole = new Map((files ?? []).map(file => [file.role, new Set(file.headers.map(normalizeHeader))]));
  if (isSet && files) {
    for (const file of document.files!) {
      if (file.required && !headersByRole.has(file.role)) fail(`files: the required file ${file.role} is missing.`);
    }
  }
  const checkRef = (ref: ColumnRef, field: string) => {
    const { role, column } = resolveRef(ref, isSet);
    if (isSet && typeof ref === "string") fail(`${field}: in a file set, name the file: { file, column }.`);
    if (isSet && !roles.has(role)) fail(`${field}: "${role}" is not a declared file.`);
    const headers = headersByRole.get(role);
    // An optional file that was not uploaded contributes nothing.
    if (headers && !headers.has(normalizeHeader(column))) fail(`${field}: the file has no column "${column}".`);
  };

  const seen = new Map<string, MappingTransform[]>();
  for (const [index, target] of document.targets.entries()) {
    const field = `targets[${index}] (${target.target})`;
    const spec = TARGETS[target.target];
    if (!spec) fail(`${field}: unknown target field.`);
    if (target.from === null && target.constant === undefined) fail(`${field}: map a column or set a constant.`);
    if (target.from !== null) checkRef(target.from, field);
    if (target.transform && !TRANSFORMS_BY_KIND[spec!.kind].includes(target.transform)) {
      fail(`${field}: the ${target.transform} transform does not apply to a ${spec!.kind} field.`);
    }
    if (target.valueMap) {
      if (spec!.kind !== "enum") fail(`${field}: a value map applies only to fields with fixed values.`);
      for (const value of Object.values(target.valueMap)) {
        if (!spec!.values!.includes(value)) fail(`${field}: "${value}" is not one of ${spec!.values!.join(", ")}.`);
      }
    }
    if (target.constant !== undefined && spec!.kind === "enum" && !spec!.values!.includes(String(target.constant))) {
      fail(`${field}: "${String(target.constant)}" is not one of ${spec!.values!.join(", ")}.`);
    }
    const transforms = seen.get(target.target) ?? [];
    transforms.push(target.transform ?? "trim");
    seen.set(target.target, transforms);
  }
  for (const [path, transforms] of seen) {
    // A date column and a time column may share a timestamp target; nothing else may repeat.
    const pair = transforms.length === 2 && transforms.includes("date") && transforms.includes("time");
    if (transforms.length > 1 && !pair) fail(`targets: ${path} is mapped more than once.`);
  }
  for (const join of document.joins ?? []) {
    checkRef(join.from, "joins.from");
    checkRef(join.to, "joins.to");
  }
  if (document.refundWhen) checkRef(document.refundWhen.column, "refundWhen.column");

  const mapped = (path: string) => seen.has(path);
  if (document.orderKey !== null) checkRef(document.orderKey, "orderKey");
  else if (!document.fingerprint?.length) fail("orderKey: set the column that identifies an order, or fingerprint fields.");
  for (const path of document.fingerprint ?? []) {
    if (!mapped(path)) fail(`fingerprint: ${path} is not mapped.`);
  }
  const hasDate = mapped("orders.business_date") || mapped("orders.opened_at") || mapped("orders.closed_at")
    || (document.settings.businessDate === "from_file_date" && document.settings.fileDate !== undefined);
  if (!hasDate) fail("orders.business_date: map the business date, or when the order was opened or closed.");
  const lineTargets = [...seen.keys()].filter(path => TARGETS[path]!.level === "line");
  if (lineTargets.length > 0) {
    if (!mapped("line_items.name")) fail("line_items.name: line items need the item name.");
    if (!mapped("line_items.quantity")) fail("line_items.quantity: line items need a quantity.");
    if (!mapped("line_items.unit_price_amount") && !mapped("line_items.gross_amount")) {
      fail("line_items.gross_amount: line items need a unit price or a line gross.");
    }
  }
  if (!mapped("orders.total_amount")) {
    const orderRole = document.orderKey === null ? SINGLE_FILE_ROLE : resolveRef(document.orderKey, isSet).role;
    const linesWithOrders = document.targets.some(target => TARGETS[target.target]?.level === "line"
      && target.from !== null && resolveRef(target.from, isSet).role === orderRole);
    if (!linesWithOrders) fail("orders.total_amount: map the order total (it can be derived only from line items in the same file).");
  }
  if (isSet && document.orderKey !== null) {
    const orderRole = resolveRef(document.orderKey, true).role;
    for (const role of new Set(document.targets.flatMap(t => t.from === null ? [] : [resolveRef(t.from, true).role]))) {
      if (role === orderRole) continue;
      const levels = new Set(document.targets
        .filter(t => t.from !== null && resolveRef(t.from, true).role === role)
        .map(t => TARGETS[t.target]!.level));
      if (levels.has("order") || levels.has("location") || levels.has("customer")) {
        fail(`targets: order fields must come from the order key's file, ${orderRole}, not ${role}.`);
      }
      if (levels.has("modifier")) continue;
      if (!joinTo(document, role, orderRole)) fail(`joins: join ${role} to ${orderRole} on the order key.`);
    }
  }
}

/** The role and header a column reference names. */
export function resolveRef(ref: ColumnRef, isSet: boolean): { role: string; column: string } {
  if (typeof ref === "string") return { role: isSet ? "" : SINGLE_FILE_ROLE, column: ref };
  return { role: isSet ? ref.file : SINGLE_FILE_ROLE, column: ref.column };
}

/** The join whose `from` lies in `role` and whose `to` lies in `toRole`, either way round. */
export function joinTo(document: MappingDocument, role: string, toRole: string):
  { from: { role: string; column: string }; to: { role: string; column: string } } | null {
  for (const join of document.joins ?? []) {
    const from = resolveRef(join.from, true);
    const to = resolveRef(join.to, true);
    if (from.role === role && to.role === toRole) return { from, to };
    if (to.role === role && from.role === toRole) return { from: to, to: from };
  }
  return null;
}

/** Header comparison is case- and whitespace-insensitive (US2.4). */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

function describeZodError(error: z.ZodError): string {
  return error.issues.slice(0, 5)
    .map(issue => `${issue.path.length ? issue.path.join(".") : "mapping"}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------------------------
// Cell parsing

/** Wall-clock parts read from a date or time cell. */
export type WallClock = {
  year?: number; month?: number; day?: number; hour?: number; minute?: number; second?: number;
  /** Offset from UTC in minutes, when the cell states one. */
  offsetMinutes?: number;
};

type CompiledFormat = { regex: RegExp; groups: string[]; hasDate: boolean; hasTime: boolean };

const formatCache = new Map<string, CompiledFormat[]>();

const TOKENS: readonly [string, string, string][] = [
  ["yyyy", "(\\d{4})", "year"], ["yy", "(\\d{2})", "year2"], ["MM", "(\\d{1,2})", "month"],
  ["M", "(\\d{1,2})", "month"], ["dd", "(\\d{1,2})", "day"], ["d", "(\\d{1,2})", "day"],
  ["HH", "(\\d{1,2})", "hour"], ["H", "(\\d{1,2})", "hour"], ["hh", "(\\d{1,2})", "hour12"],
  ["h", "(\\d{1,2})", "hour12"], ["mm", "(\\d{2})", "minute"], ["ss", "(\\d{2})", "second"],
  ["a", "([AaPp]\\.?[Mm]\\.?)", "ampm"],
];

/**
 * Compiles a date format such as "MM/dd/yyyy HH:mm:ss" into matchers for the whole format and for
 * its date part alone (a cell may omit the time). Throws `MappingError` for a format with no date
 * or time token.
 */
export function compileDateFormat(format: string): CompiledFormat[] {
  const cached = formatCache.get(format);
  if (cached) return cached;
  const compile = (pattern: string): CompiledFormat | null => {
    let regex = "";
    const groups: string[] = [];
    let index = 0;
    while (index < pattern.length) {
      const token = TOKENS.find(([name]) => pattern.startsWith(name, index));
      if (token) {
        regex += token[1];
        groups.push(token[2]);
        index += token[0].length;
      } else {
        const char = pattern[index]!;
        regex += /\s/.test(char) ? "\\s+" : char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
        index++;
      }
    }
    if (groups.length === 0) return null;
    return {
      regex: new RegExp(`^${regex}(?:\\s*(Z|[+-]\\d{2}:?\\d{2}))?$`),
      groups,
      hasDate: groups.some(group => group === "year" || group === "year2" || group === "day"),
      hasTime: groups.some(group => group === "hour" || group === "hour12"),
    };
  };
  const full = compile(format);
  if (!full) throw new MappingError(`settings.dateFormat: "${format}" has no date or time fields (use yyyy, MM, dd, HH, mm, ss, a).`);
  const compiled = [full];
  // The date part alone, for date-only cells: cut at the first time token.
  const timeAt = format.search(/[Hh]/);
  if (timeAt > 0) {
    const datePart = compile(format.slice(0, timeAt).trimEnd().replace(/[\sT,]+$/, ""));
    if (datePart?.hasDate) compiled.push(datePart);
  }
  // The time part alone, for separate time columns.
  if (timeAt >= 0) {
    const timePart = compile(format.slice(timeAt));
    if (timePart) compiled.push(timePart);
  }
  formatCache.set(format, compiled);
  return compiled;
}

/** Reads a date, time or timestamp cell with `format`, or ISO 8601. Null when it does not parse. */
export function parseWallClock(value: string, format: string): WallClock | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (iso) {
    return validClock({
      year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]),
      ...(iso[4] ? { hour: Number(iso[4]), minute: Number(iso[5]), second: Number(iso[6] ?? 0) } : {}),
      ...(iso[7] ? { offsetMinutes: parseOffset(iso[7]) } : {}),
    });
  }
  for (const compiled of compileDateFormat(format)) {
    const match = compiled.regex.exec(text);
    if (!match) continue;
    const clock: WallClock = {};
    let hour12: number | undefined;
    let pm: boolean | undefined;
    compiled.groups.forEach((group, index) => {
      const part = match[index + 1]!;
      if (group === "year") clock.year = Number(part);
      else if (group === "year2") clock.year = 2000 + Number(part);
      else if (group === "month") clock.month = Number(part);
      else if (group === "day") clock.day = Number(part);
      else if (group === "hour") clock.hour = Number(part);
      else if (group === "hour12") hour12 = Number(part);
      else if (group === "minute") clock.minute = Number(part);
      else if (group === "second") clock.second = Number(part);
      else if (group === "ampm") pm = /^p/i.test(part);
    });
    if (hour12 !== undefined) {
      if (hour12 < 1 || hour12 > 12) return null;
      clock.hour = (hour12 % 12) + (pm ? 12 : 0);
    }
    if (clock.hour !== undefined) {
      clock.minute ??= 0;
      clock.second ??= 0;
    }
    const zone = match[compiled.groups.length + 1];
    if (zone) clock.offsetMinutes = parseOffset(zone);
    return validClock(clock);
  }
  // A separate time column may use any common clock form.
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(text);
  if (time) {
    let hour = Number(time[1]);
    if (time[4]) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (/^p/i.test(time[4]) ? 12 : 0);
    }
    return validClock({ hour, minute: Number(time[2]), second: Number(time[3] ?? 0) });
  }
  return null;
}

function parseOffset(zone: string): number {
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
}

function validClock(clock: WallClock): WallClock | null {
  if (clock.month !== undefined && (clock.month < 1 || clock.month > 12)) return null;
  if (clock.day !== undefined) {
    if (clock.year === undefined || clock.month === undefined) return null;
    const days = new Date(Date.UTC(clock.year, clock.month, 0)).getUTCDate();
    if (clock.day < 1 || clock.day > days) return null;
  }
  if (clock.hour !== undefined && (clock.hour > 23 || clock.minute! > 59 || clock.second! > 59)) return null;
  return clock;
}

/** Reads a yes/no cell. Null when it is neither. */
export function parseBoolean(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "x", "t", "✓", "on"].includes(text)) return true;
  if (["false", "no", "n", "0", "", "f", "off"].includes(text)) return false;
  return null;
}
