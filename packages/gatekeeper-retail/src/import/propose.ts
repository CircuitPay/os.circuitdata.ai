// The deterministic proposer (research R7): saved and built-in templates are matched by header
// signature first (the most recently used match wins), then a header-alias dictionary maps common
// column names. A known export therefore never needs the agent (SC-003).

import type { MappingDocument, MappingTarget, MappingTransform, TemplateMatch } from "../app-api-types.js";
import { normalizeCurrency } from "../dataset/ingest.js";
import { SINGLE_FILE_ROLE, TARGETS, normalizeHeader, parseWallClock } from "./mapping.js";

/** A staged file as the proposer sees it. */
export type ProposalFile = { headers: string[]; sampleRows: (string | null)[][] };

/** A template version that can be matched. */
export type CandidateTemplate = {
  templateId: number;
  versionId: number;
  name: string;
  origin: "builtin" | "user";
  mapping: MappingDocument;
  signatures: { role: string; headers: string[] }[];
  /** Epoch seconds of the last import that used the template, or null. */
  lastUsedAt: number | null;
};

/** What the proposer found. */
export type Proposal = {
  matches: (TemplateMatch & { roles: (string | null)[] })[];
  /** The role of each staged file in the chosen match, or null. */
  roles: (string | null)[];
  mapping: MappingDocument | null;
  /** Required files of the matched set that were not uploaded (US2.8). */
  missingRequiredFiles: string[];
  /** The version the mapping came from, if it came from a template. */
  templateVersionId: number | null;
};

/** Dataset defaults applied to settings a file does not state. */
export type ProposalDefaults = { timezone: string | null; currency: string | null };

/** Date formats tried, in order, against a date column's samples. */
const DATE_FORMATS = [
  "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd", "MM/dd/yyyy HH:mm:ss", "MM/dd/yyyy h:mm:ss a",
  "MM/dd/yyyy h:mm a", "MM/dd/yyyy HH:mm", "MM/dd/yyyy", "dd/MM/yyyy HH:mm:ss", "dd/MM/yyyy HH:mm", "dd/MM/yyyy",
  "dd.MM.yyyy HH:mm:ss", "dd.MM.yyyy HH:mm", "dd.MM.yyyy", "M/d/yy h:mm a", "M/d/yy HH:mm", "M/d/yy",
];

/** Column names that identify an order, best first. */
const ORDER_KEY_ALIASES = [
  "order id", "transaction id", "receipt id", "check id", "sale id", "ticket id", "invoice id", "id",
  "order number", "order #", "order no", "receipt number", "receipt #", "receipt no", "receipt", "check number",
  "check #", "ticket number", "ticket #", "transaction number", "transaction #", "invoice number",
  "invoice", "name", "order",
];

/** Header aliases → target and transform. The first alias present wins for each target. */
const ALIASES: readonly { target: string; transform?: MappingTransform; names: string[] }[] = [
  { target: "orders.order_number", names: ["order number", "order #", "order no", "receipt number", "receipt #", "receipt no", "check number", "check #", "ticket number", "ticket #", "transaction number", "transaction #", "invoice number"] },
  { target: "orders.business_date", transform: "date", names: ["business date", "business day", "trading date"] },
  { target: "orders.opened_at", transform: "datetime", names: ["opened", "opened at", "created at", "order date", "order time", "date", "datetime", "timestamp", "sale date", "transaction date"] },
  { target: "orders.closed_at", transform: "datetime", names: ["closed", "closed at", "paid at", "completed at", "paid date"] },
  { target: "locations.name", names: ["location", "location name", "store", "store name", "store location", "outlet", "shop", "branch"] },
  { target: "orders.currency", names: ["currency", "currency code"] },
  { target: "orders.tip_amount", transform: "money", names: ["tip", "tips", "gratuity"] },
  { target: "orders.total_amount", transform: "money", names: ["total", "order total", "grand total", "total amount", "amount paid"] },
  { target: "line_items.source_record_id", names: ["line id", "item selection id", "line item id"] },
  { target: "line_items.name", names: ["item", "item name", "product", "product name", "menu item", "lineitem name", "description"] },
  { target: "line_items.quantity", transform: "quantity", names: ["qty", "quantity", "units", "lineitem quantity", "count"] },
  { target: "line_items.unit_price_amount", transform: "money", names: ["unit price", "price", "item price", "lineitem price"] },
  { target: "line_items.gross_amount", transform: "money", names: ["gross sales", "gross price", "gross", "line total", "extended price", "gross amount"] },
  { target: "line_items.discount_amount", transform: "money", names: ["discount", "discounts", "discount amount", "item discount", "line discount", "lineitem discount"] },
  { target: "line_items.tax_amount", transform: "money", names: ["tax", "taxes", "tax amount", "vat", "sales tax"] },
  { target: "line_items.unit_cost_amount", transform: "money", names: ["cost", "unit cost", "cost price"] },
  { target: "products.sku", names: ["sku", "item sku", "lineitem sku", "product code", "item code", "product id"] },
  { target: "products.category", names: ["category", "department", "menu group", "sales category"] },
  { target: "customers.source_record_id", names: ["customer id"] },
  { target: "customers.email", names: ["email", "customer email", "e-mail"] },
  { target: "customers.phone", names: ["phone", "customer phone", "phone number"] },
  { target: "customers.first_name", transform: "split_name_first", names: ["customer name", "customer", "billing name"] },
  { target: "customers.last_name", transform: "split_name_last", names: ["customer name", "customer", "billing name"] },
];

// Order-level fallbacks for amounts a file has only once per row with no items.
const ORDER_LEVEL_FALLBACK: Readonly<Record<string, string>> = {
  "line_items.discount_amount": "orders.discount_amount",
  "line_items.tax_amount": "orders.tax_amount",
};

/** Proposes a mapping for staged files. */
export function propose(
  files: ProposalFile[],
  templates: CandidateTemplate[],
  defaults: ProposalDefaults,
): Proposal {
  const matches: Proposal["matches"] = [];
  for (const template of templates) {
    const roles = matchTemplate(template, files);
    if (roles) {
      matches.push({
        templateId: template.templateId, versionId: template.versionId, name: template.name,
        origin: template.origin, lastUsedAt: template.lastUsedAt === null ? null : isoSeconds(template.lastUsedAt),
        roles,
      });
    }
  }
  matches.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "")
    || Number(a.origin === "builtin") - Number(b.origin === "builtin"));
  const best = matches[0];
  if (best) {
    const template = templates.find(candidate => candidate.versionId === best.versionId)!;
    const missingRequiredFiles = (template.mapping.files ?? [])
      .filter(file => file.required && !best.roles.includes(file.role))
      .map(file => file.role);
    return {
      matches,
      roles: best.roles,
      mapping: adaptTemplate(template, files, best.roles, defaults),
      missingRequiredFiles,
      templateVersionId: template.versionId,
    };
  }
  return {
    matches,
    roles: files.map(() => null),
    mapping: files.length === 1 ? aliasMapping(files[0]!, defaults) : null,
    missingRequiredFiles: [],
    templateVersionId: null,
  };
}

/**
 * The role of each file when `template` matches the staged files, or null. A single-file template
 * matches one file containing its signature; a set matches when every file is one of its roles.
 */
export function matchTemplate(template: CandidateTemplate, files: ProposalFile[]): (string | null)[] | null {
  const isSet = (template.mapping.files?.length ?? 0) > 0;
  const contains = (file: ProposalFile, signature: string[]) => {
    const headers = new Set(file.headers.map(normalizeHeader));
    return signature.length > 0 && signature.every(header => headers.has(normalizeHeader(header)));
  };
  if (!isSet) {
    if (files.length !== 1) return null;
    const signature = template.signatures[0]?.headers ?? [];
    return contains(files[0]!, signature) ? [SINGLE_FILE_ROLE] : null;
  }
  const taken = new Set<string>();
  const roles: (string | null)[] = [];
  for (const file of files) {
    const role = template.signatures
      .filter(entry => !taken.has(entry.role) && contains(file, entry.headers))
      .toSorted((a, b) => b.headers.length - a.headers.length)[0]?.role;
    if (!role) return null;
    taken.add(role);
    roles.push(role);
  }
  return roles;
}

/**
 * Fits a template to the files at hand: the dataset's zone and currency for a built-in, targets
 * whose optional columns are absent dropped (or re-pointed by alias), and the export set's date.
 */
function adaptTemplate(
  template: CandidateTemplate,
  files: ProposalFile[],
  roles: (string | null)[],
  defaults: ProposalDefaults,
): MappingDocument {
  const mapping: MappingDocument = structuredClone(template.mapping);
  const isSet = (mapping.files?.length ?? 0) > 0;
  if (template.origin === "builtin") {
    if (defaults.timezone) mapping.settings.timezone = defaults.timezone;
    if (defaults.currency && normalizeCurrency(defaults.currency)) mapping.settings.currency = defaults.currency;
  }
  const fileOf = (role: string) => {
    const index = roles.indexOf(role);
    return index < 0 ? null : files[index]!;
  };
  const headersOf = (role: string) => new Map(
    (fileOf(role)?.headers ?? []).map(header => [normalizeHeader(header), header] as const));
  const resolve = (ref: MappingTarget["from"]): MappingTarget["from"] | undefined => {
    if (ref === null) return null;
    const role = typeof ref === "string" ? SINGLE_FILE_ROLE : ref.file;
    const column = typeof ref === "string" ? ref : ref.column;
    const found = headersOf(isSet ? role : SINGLE_FILE_ROLE).get(normalizeHeader(column));
    if (!found) return undefined;
    return typeof ref === "string" ? found : { file: ref.file, column: found };
  };
  const single = isSet ? null : files[0]!;
  mapping.targets = mapping.targets.flatMap(target => {
    const from = resolve(target.from);
    if (from !== undefined) return [{ ...target, from }];
    // A single file's missing column may go by another name (Square headers vary by region).
    if (single) {
      const alias = ALIASES.find(entry => entry.target === target.target);
      const header = alias && findHeader(single.headers, alias.names);
      if (header) return [{ ...target, from: header }];
    }
    return [];
  });
  mapping.joins = mapping.joins?.filter(join => resolve(join.from) !== undefined && resolve(join.to) !== undefined);
  if (mapping.refundWhen && resolve(mapping.refundWhen.column) === undefined) delete mapping.refundWhen;
  if (mapping.orderKey !== null && resolve(mapping.orderKey) === undefined && single) {
    const key = findHeader(single.headers, ORDER_KEY_ALIASES);
    mapping.orderKey = key ?? null;
    if (!key) mapping.fingerprint = fingerprintFor(mapping);
  } else if (mapping.orderKey !== null) {
    mapping.orderKey = resolve(mapping.orderKey) ?? mapping.orderKey;
  }

  // The date format of the file, when the template's does not read the samples.
  const dateSamples = samplesOf(mapping, files, roles, ["datetime", "date"]);
  if (dateSamples.length > 0 && !dateSamples.every(value => parseWallClock(value, mapping.settings.dateFormat))) {
    mapping.settings.dateFormat = detectDateFormat(dateSamples) ?? mapping.settings.dateFormat;
  }
  if (mapping.settings.businessDate === "from_file_date" && mapping.settings.fileDate === undefined) {
    const opened = samplesOf(mapping, files, roles, ["datetime"], "orders.opened_at");
    const formats = [mapping.files?.find(file => file.role === roles[0])?.dateFormat, mapping.settings.dateFormat];
    for (const value of opened) {
      const clock = formats.map(format => format && parseWallClock(value, format)).find(Boolean);
      if (clock && clock.year !== undefined) {
        mapping.settings.fileDate = `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
        break;
      }
    }
  }
  return mapping;
}

/** A mapping from the header-alias dictionary alone. */
export function aliasMapping(file: ProposalFile, defaults: ProposalDefaults): MappingDocument | null {
  const targets: MappingTarget[] = [];
  const used = new Set<string>();
  for (const alias of ALIASES) {
    if (targets.some(target => target.target === alias.target)) continue;
    const header = findHeader(file.headers, alias.names);
    if (!header) continue;
    // A name column feeds both name targets; any other column feeds one target.
    if (used.has(header) && !alias.target.startsWith("customers.")) continue;
    used.add(header);
    targets.push({ target: alias.target, from: header, ...(alias.transform ? { transform: alias.transform } : {}) });
  }
  if (targets.length === 0) return null;
  const hasLines = targets.some(target => target.target === "line_items.name");
  const mapped = targets.map(target => {
    // Without items, discounts and tax belong to the order; line fields without a name are dropped.
    if (!hasLines && ORDER_LEVEL_FALLBACK[target.target]) return { ...target, target: ORDER_LEVEL_FALLBACK[target.target]! };
    return target;
  }).filter(target => hasLines || TARGETS[target.target]!.level !== "line");
  const orderKey = findHeader(file.headers, ORDER_KEY_ALIASES);
  const timezone = defaults.timezone ?? "UTC";
  const currency = defaults.currency && normalizeCurrency(defaults.currency) ? defaults.currency : "USD";
  const mapping: MappingDocument = {
    version: 1,
    settings: { timezone, currency, dateFormat: "yyyy-MM-dd HH:mm:ss", decimalMark: detectDecimalMark(file, mapped) },
    orderKey: orderKey ?? null,
    targets: mapped,
  };
  if (!orderKey) mapping.fingerprint = fingerprintFor(mapping);
  const dateSamples = samplesOf(mapping, [file], [SINGLE_FILE_ROLE], ["datetime", "date"]);
  mapping.settings.dateFormat = detectDateFormat(dateSamples) ?? mapping.settings.dateFormat;
  return mapping;
}

/** The first date format that reads every sample. */
export function detectDateFormat(samples: string[]): string | null {
  if (samples.length === 0) return null;
  return DATE_FORMATS.find(format => samples.every(sample => parseWallClock(sample, format) !== null)) ?? null;
}

/** "," when money samples are written like "1.234,56" or "12,50". */
function detectDecimalMark(file: ProposalFile, targets: MappingTarget[]): "." | "," {
  const columns = targets
    .filter(target => TARGETS[target.target]?.kind === "money" && typeof target.from === "string")
    .map(target => file.headers.indexOf(target.from as string));
  const samples = file.sampleRows.flatMap(row => columns.map(column => row[column] ?? "")).filter(Boolean);
  const comma = samples.filter(value => /\d,\d{1,2}$/.test(value.trim())).length;
  const dot = samples.filter(value => /\d\.\d{1,2}$/.test(value.trim())).length;
  return comma > dot ? "," : ".";
}

function findHeader(headers: string[], names: string[]): string | null {
  // Exports from databases and spreadsheets often write "order_id" for "Order ID".
  const byName = new Map(headers.map(header => [normalizeHeader(header.replaceAll("_", " ")), header] as const));
  for (const name of names) {
    const header = byName.get(name);
    if (header) return header;
  }
  return null;
}

function fingerprintFor(mapping: MappingDocument): string[] {
  const candidates = ["orders.order_number", "orders.opened_at", "orders.closed_at", "orders.business_date",
    "orders.total_amount", "locations.name", "line_items.name", "line_items.quantity"];
  return candidates.filter(path => mapping.targets.some(target => target.target === path));
}

/** Non-empty sample cells of the targets with the given transforms (or of one target). */
function samplesOf(
  mapping: MappingDocument, files: ProposalFile[], roles: (string | null)[], transforms: string[], path?: string,
): string[] {
  const samples: string[] = [];
  for (const target of mapping.targets) {
    if (path ? target.target !== path : !transforms.includes(target.transform ?? "")) continue;
    if (target.from === null) continue;
    const role = typeof target.from === "string" ? SINGLE_FILE_ROLE : target.from.file;
    const column = typeof target.from === "string" ? target.from : target.from.column;
    const index = (mapping.files?.length ?? 0) > 0 ? roles.indexOf(role) : 0;
    const file = files[index];
    if (!file) continue;
    const at = file.headers.findIndex(header => normalizeHeader(header) === normalizeHeader(column));
    if (at < 0) continue;
    for (const row of file.sampleRows) {
      const value = row[at]?.trim();
      if (value) samples.push(value);
    }
  }
  return samples;
}

function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
