// The dataset's SQLite schema: compact STRICT storage tables (`store_*`), the public views
// consumers read, the rollup tables every run keeps current, and the internal operational tables.
// See specs/006-retail-data-layer/data-model.md §2-§4. Guarded SQL may name only the public views.

import type { RetailColumn, RetailTable } from "../types.js";

/** One public view's published description; `rows` is filled in at describe time. */
export type PublicTable = {
  name: RetailTable;
  description: string;
  columns: RetailColumn[];
};

const iso = (column: string) =>
  `strftime('%Y-%m-%dT%H:%M:%SZ', ${column}, 'unixepoch') AS ${column}`;

/** Columns every canonical storage table carries (FR-013 lineage, research R16 rebuilds). */
const CANONICAL_COLUMNS = `
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  source_record_id TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  mapping_version TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  rebuild_gen INTEGER NOT NULL DEFAULT 0`;

const LINEAGE_VIEW_COLUMNS = [
  "id", "source_id", "source_record_id", "run_id", "mapping_version",
  iso("ingested_at"), iso("updated_at"), iso("deleted_at"),
].join(", ");

const LINEAGE_COLUMNS: RetailColumn[] = [
  { name: "id", type: "integer", description: "Opaque, stable row id." },
  { name: "source_id", type: "integer", description: "The source (see `sources`) that supplied the row." },
  { name: "source_record_id", type: "text", description: "The provider's or file's own id for the row." },
  { name: "run_id", type: "integer", description: "The run that last wrote the row." },
  { name: "mapping_version", type: "text", description: "The mapping version that produced the row." },
  { name: "ingested_at", type: "timestamp", description: "When the row was first written." },
  { name: "updated_at", type: "timestamp", description: "When the row last changed." },
  { name: "deleted_at", type: "timestamp", description: "Set when the source deleted or merged the record. Metrics ignore these rows." },
];

const money = (name: string, description: string, currencyColumn = "currency"): RetailColumn =>
  ({ name, type: "money", currencyColumn, description });

/** The canonical schema consumers read: every public view, in `describe()` order. */
export const PUBLIC_TABLES: readonly PublicTable[] = [
  {
    name: "locations",
    description: "A store, restaurant or online channel.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "name", type: "text" },
      { name: "kind", type: "text", description: "store | restaurant | online | other" },
      { name: "timezone", type: "text", description: "IANA time zone." },
      { name: "day_cutoff", type: "text", description: "HH:MM local time at which the trading day starts." },
      { name: "currency", type: "text", description: "Default ISO 4217 currency." },
      { name: "address_city", type: "text" },
      { name: "address_region", type: "text" },
      { name: "address_country", type: "text" },
      { name: "address_postal_code", type: "text" },
    ],
  },
  {
    name: "customers",
    description: "People who bought something. Personal columns are masked unless the organization allowed unmasked access.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "first_name", type: "text", personal: true },
      { name: "last_name", type: "text", personal: true },
      { name: "email", type: "text", personal: true },
      { name: "phone", type: "text", personal: true },
      { name: "email_hash", type: "text", description: "Keyed hash of the lowercase email; equal emails have equal hashes. Use for joins." },
      { name: "phone_hash", type: "text", description: "Keyed hash of the phone number's digits; use for joins." },
      { name: "created_at", type: "timestamp", description: "First seen at the source." },
      { name: "marketing_opt_in", type: "boolean" },
      { name: "canonical_customer_id", type: "integer", description: "Set when this customer was confirmed to be the same person as another customer row." },
    ],
  },
  {
    name: "products",
    description: "One row per sellable variant; parent_product_id groups variants.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "name", type: "text" },
      { name: "variant_name", type: "text" },
      { name: "parent_product_id", type: "integer" },
      { name: "sku", type: "text" },
      { name: "barcode", type: "text" },
      { name: "category", type: "text" },
      money("price_amount", "Current list price."),
      { name: "currency", type: "text" },
      money("unit_cost_amount", "Unit cost, when known."),
      { name: "is_active", type: "boolean" },
      { name: "canonical_product_id", type: "integer", description: "Set when this product was confirmed to be the same as another product row." },
    ],
  },
  {
    name: "orders",
    description: "A sale (a check, for restaurants). Voided orders are kept with status 'voided'.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "location_id", type: "integer" },
      { name: "customer_id", type: "integer" },
      { name: "order_number", type: "text", description: "The number staff and receipts show." },
      { name: "status", type: "text", description: "open | completed | voided | refunded | partially_refunded" },
      { name: "channel", type: "text", description: "in_store | online | delivery | other" },
      { name: "opened_at", type: "timestamp" },
      { name: "closed_at", type: "timestamp" },
      { name: "business_date", type: "date", description: "Local trading day, after the location's day cutoff." },
      { name: "local_hour", type: "integer", description: "0-23 in the location's time zone." },
      { name: "currency", type: "text" },
      money("gross_amount", "Sum of the gross of non-voided lines, before discounts."),
      money("discount_amount", "Order-level plus line-level discounts."),
      money("service_charge_amount", "Service charges."),
      money("tax_amount", "Tax collected."),
      money("tip_amount", "Tips."),
      money("total_amount", "What the customer was charged."),
      { name: "prices_include_tax", type: "boolean" },
      { name: "guest_count", type: "integer" },
    ],
  },
  {
    name: "line_items",
    description: "One sold item of an order. location_id and business_date are copied from the order.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "order_id", type: "integer" },
      { name: "location_id", type: "integer" },
      { name: "business_date", type: "date" },
      { name: "product_id", type: "integer", description: "Null for custom or open-price items." },
      { name: "name", type: "text", description: "As sold." },
      { name: "quantity", type: "real", description: "Up to 4 decimals; fractional when sold by weight." },
      money("unit_price_amount", "Unit price including modifier prices."),
      money("gross_amount", "quantity x unit price."),
      money("discount_amount", "Line discount."),
      money("tax_amount", "Line tax."),
      money("net_amount", "gross_amount - discount_amount."),
      { name: "modifiers", type: "json", description: "[{ name, price_amount, quantity }]" },
      money("unit_cost_amount", "Cost at the time of sale, when known."),
      { name: "is_voided", type: "boolean", description: "Item voided on an order that otherwise stands." },
      { name: "currency", type: "text" },
    ],
  },
  {
    name: "transactions",
    description: "Money movements: payments, refunds, payouts, fees and adjustments. amount is positive; kind gives the direction.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "order_id", type: "integer" },
      { name: "location_id", type: "integer" },
      { name: "parent_transaction_id", type: "integer", description: "For a refund: the payment it reverses." },
      { name: "kind", type: "text", description: "payment | refund | payout | fee | adjustment" },
      { name: "tender", type: "text", description: "card | cash | gift_card | wallet | other" },
      { name: "card_brand", type: "text" },
      money("amount", "Positive amount."),
      money("sales_amount", "Sales portion (refunds)."),
      money("tax_amount", "Tax portion, when known."),
      money("tip_amount", "Tip portion, when known."),
      { name: "breakdown_known", type: "boolean", description: "False when sales/tax/tip were not itemized by the source." },
      money("fee_amount", "Processor fee, when known."),
      { name: "currency", type: "text" },
      { name: "occurred_at", type: "timestamp" },
      { name: "business_date", type: "date" },
      { name: "status", type: "text", description: "succeeded | failed | pending" },
    ],
  },
  {
    name: "refund_items",
    description: "Line-level returns, where the source itemizes a refund.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "transaction_id", type: "integer" },
      { name: "order_id", type: "integer" },
      { name: "line_item_id", type: "integer" },
      { name: "location_id", type: "integer" },
      { name: "product_id", type: "integer" },
      { name: "quantity", type: "real" },
      money("sales_amount", "Refunded sales."),
      money("tax_amount", "Refunded tax."),
      { name: "business_date", type: "date", description: "The refund's trading day." },
      { name: "currency", type: "text" },
    ],
  },
  {
    name: "inventory",
    description: "Current stock per product, location and source.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "product_id", type: "integer" },
      { name: "location_id", type: "integer" },
      { name: "quantity_on_hand", type: "real" },
      { name: "state", type: "text", description: "in_stock | low | out_of_stock" },
      { name: "as_of", type: "timestamp" },
    ],
  },
  {
    name: "inventory_movements",
    description: "Stock changes, where the source reports them.",
    columns: [
      ...LINEAGE_COLUMNS,
      { name: "product_id", type: "integer" },
      { name: "location_id", type: "integer" },
      { name: "quantity_delta", type: "real", description: "Signed." },
      { name: "reason", type: "text", description: "sale | receive | adjustment | transfer | waste | other" },
      { name: "occurred_at", type: "timestamp" },
    ],
  },
  {
    name: "sources",
    description: "Where the data comes from: provider connections and CSV sources.",
    columns: [
      { name: "id", type: "integer" },
      { name: "kind", type: "text", description: "square | stripe | toast | csv" },
      { name: "label", type: "text" },
      { name: "status", type: "text" },
      { name: "last_success_at", type: "timestamp" },
      { name: "coverage_from", type: "date" },
      { name: "coverage_to", type: "date" },
    ],
  },
  {
    name: "daily_sales",
    description: "Sales per business date, location, channel and currency. Kept current by every run; prefer it to scanning orders.",
    columns: [
      { name: "business_date", type: "date" },
      { name: "location_id", type: "integer" },
      { name: "channel", type: "text" },
      { name: "currency", type: "text" },
      { name: "orders", type: "integer", description: "Non-voided orders." },
      { name: "voided_orders", type: "integer" },
      money("gross_amount", "Gross sales."),
      money("discount_amount", "Discounts."),
      money("refund_amount", "Sales portion of refunds, on the refund's business date."),
      money("net_amount", "gross - discounts - refunds."),
      money("tax_amount", "Tax."),
      money("tip_amount", "Tips."),
      money("service_charge_amount", "Service charges."),
      { name: "units", type: "real", description: "Units sold on non-voided lines." },
      { name: "refunded_units", type: "real" },
      money("cost_amount", "Cost of the units with a known cost."),
      { name: "lines_missing_cost", type: "integer" },
    ],
  },
  {
    name: "daily_product_sales",
    description: "Sales per business date, location, product, channel and currency (product_id null for unlinked items).",
    columns: [
      { name: "business_date", type: "date" },
      { name: "location_id", type: "integer" },
      { name: "product_id", type: "integer" },
      { name: "channel", type: "text" },
      { name: "currency", type: "text" },
      { name: "units", type: "real" },
      { name: "refunded_units", type: "real" },
      money("gross_amount", "Gross sales."),
      money("discount_amount", "Discounts."),
      money("refund_amount", "Sales portion of itemized refunds."),
      money("net_amount", "gross - discounts - refunds."),
      money("cost_amount", "Cost of the units with a known cost."),
      { name: "units_missing_cost", type: "real" },
    ],
  },
  {
    name: "customer_summary",
    description: "Per customer and currency: first and last order dates, orders and lifetime net sales.",
    columns: [
      { name: "customer_id", type: "integer" },
      { name: "currency", type: "text" },
      { name: "first_order_date", type: "date" },
      { name: "last_order_date", type: "date" },
      { name: "orders", type: "integer" },
      money("lifetime_net_amount", "Net sales over the customer's orders."),
    ],
  },
  {
    name: "daily_source_coverage",
    description: "Orders and transactions per business date, location and source.",
    columns: [
      { name: "business_date", type: "date" },
      { name: "location_id", type: "integer" },
      { name: "source_id", type: "integer" },
      { name: "orders", type: "integer" },
      { name: "transactions", type: "integer" },
    ],
  },
];

/** Public view names: the only relations guarded SQL may read. */
export const PUBLIC_VIEW_NAMES: ReadonlySet<string> = new Set(PUBLIC_TABLES.map(table => table.name));

/** Fact views whose full scan guarded SQL refuses above the scan row limit, by storage table. */
export const SCAN_GUARDED_TABLES: Readonly<Record<string, RetailTable>> = {
  store_orders: "orders",
  store_line_items: "line_items",
  store_transactions: "transactions",
  store_refund_items: "refund_items",
  store_inventory_movements: "inventory_movements",
};

/** The storage table behind each public view, for approximate row counts. */
export const VIEW_STORAGE: Readonly<Record<RetailTable, string>> = {
  locations: "store_locations",
  customers: "store_customers",
  products: "store_products",
  orders: "store_orders",
  line_items: "store_line_items",
  transactions: "store_transactions",
  refund_items: "store_refund_items",
  inventory: "store_inventory",
  inventory_movements: "store_inventory_movements",
  sources: "store_sources",
  daily_sales: "store_daily_sales",
  daily_product_sales: "store_daily_product_sales",
  customer_summary: "store_customer_summary",
  daily_source_coverage: "store_daily_source_coverage",
};

/** The canonical tables ingest writes, in dependency order. */
export const CANONICAL_TABLES = [
  "locations", "customers", "products", "orders", "line_items", "transactions", "refund_items",
  "inventory", "inventory_movements",
] as const;

/** A canonical table ingest writes. */
export type CanonicalTable = typeof CANONICAL_TABLES[number];

const TABLES = `
CREATE TABLE store_locations (${CANONICAL_COLUMNS},
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  timezone TEXT NOT NULL,
  day_cutoff_minutes INTEGER NOT NULL,
  currency TEXT NOT NULL,
  address_city TEXT,
  address_region TEXT,
  address_country TEXT,
  address_postal_code TEXT,
  UNIQUE (source_id, source_record_id)
) STRICT;

CREATE TABLE store_customers (${CANONICAL_COLUMNS},
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  first_name_mask TEXT,
  last_name_mask TEXT,
  email_mask TEXT,
  phone_mask TEXT,
  email_hash TEXT,
  phone_hash TEXT,
  created_at INTEGER,
  marketing_opt_in INTEGER,
  canonical_customer_id INTEGER,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_customers_email_hash ON store_customers (email_hash);
CREATE INDEX store_customers_phone_hash ON store_customers (phone_hash);

CREATE TABLE store_products (${CANONICAL_COLUMNS},
  name TEXT NOT NULL,
  variant_name TEXT,
  parent_product_id INTEGER,
  sku TEXT,
  barcode TEXT,
  category TEXT,
  price_amount INTEGER,
  currency TEXT,
  unit_cost_amount INTEGER,
  is_active INTEGER NOT NULL,
  canonical_product_id INTEGER,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_products_sku ON store_products (sku);

CREATE TABLE store_orders (${CANONICAL_COLUMNS},
  location_id INTEGER NOT NULL,
  customer_id INTEGER,
  order_number TEXT,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  opened_at INTEGER,
  closed_at INTEGER,
  business_date TEXT NOT NULL,
  local_hour INTEGER NOT NULL,
  currency TEXT NOT NULL,
  -- The order's own gross, used only when it has no lines; gross_amount is otherwise their sum.
  input_gross_amount INTEGER,
  gross_amount INTEGER NOT NULL,
  -- The order-level discount; discount_amount adds the lines' discounts.
  order_discount_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  service_charge_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  tip_amount INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  prices_include_tax INTEGER NOT NULL,
  guest_count INTEGER,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_orders_date ON store_orders (business_date, location_id);
CREATE INDEX store_orders_customer ON store_orders (customer_id);

CREATE TABLE store_line_items (${CANONICAL_COLUMNS},
  order_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  quantity_e4 INTEGER NOT NULL,
  unit_price_amount INTEGER NOT NULL,
  gross_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  modifiers TEXT,
  unit_cost_amount INTEGER,
  is_voided INTEGER NOT NULL,
  currency TEXT NOT NULL,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_line_items_date ON store_line_items (business_date, location_id);
CREATE INDEX store_line_items_order ON store_line_items (order_id);

CREATE TABLE store_transactions (${CANONICAL_COLUMNS},
  order_id INTEGER,
  location_id INTEGER,
  parent_transaction_id INTEGER,
  kind TEXT NOT NULL,
  tender TEXT,
  card_brand TEXT,
  amount INTEGER NOT NULL,
  sales_amount INTEGER,
  tax_amount INTEGER,
  tip_amount INTEGER,
  breakdown_known INTEGER NOT NULL,
  fee_amount INTEGER,
  currency TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_transactions_date ON store_transactions (business_date, location_id);
CREATE INDEX store_transactions_order ON store_transactions (order_id);

CREATE TABLE store_refund_items (${CANONICAL_COLUMNS},
  transaction_id INTEGER,
  order_id INTEGER NOT NULL,
  line_item_id INTEGER,
  location_id INTEGER NOT NULL,
  product_id INTEGER,
  quantity_e4 INTEGER NOT NULL,
  sales_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  UNIQUE (source_id, source_record_id)
) STRICT;
CREATE INDEX store_refund_items_date ON store_refund_items (business_date, location_id);
CREATE INDEX store_refund_items_order ON store_refund_items (order_id);

CREATE TABLE store_inventory (${CANONICAL_COLUMNS},
  product_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  quantity_on_hand_e4 INTEGER,
  state TEXT NOT NULL,
  as_of INTEGER NOT NULL,
  UNIQUE (source_id, source_record_id)
) STRICT;

CREATE TABLE store_inventory_movements (${CANONICAL_COLUMNS},
  product_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  quantity_delta_e4 INTEGER NOT NULL,
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE (source_id, source_record_id)
) STRICT;

CREATE TABLE store_sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  connection_name TEXT,
  external_account_label TEXT,
  default_timezone TEXT,
  default_currency TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  coverage_from TEXT,
  coverage_to TEXT
) STRICT;

CREATE TABLE store_daily_sales (
  business_date TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  currency TEXT NOT NULL,
  orders INTEGER NOT NULL,
  voided_orders INTEGER NOT NULL,
  gross_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  refund_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL,
  tip_amount INTEGER NOT NULL,
  service_charge_amount INTEGER NOT NULL,
  units_e4 INTEGER NOT NULL,
  refunded_units_e4 INTEGER NOT NULL,
  cost_amount INTEGER NOT NULL,
  lines_missing_cost INTEGER NOT NULL,
  PRIMARY KEY (business_date, location_id, channel, currency)
) STRICT, WITHOUT ROWID;

-- product_id 0 stands for "no product" so the key stays non-null; the view maps it back to null.
CREATE TABLE store_daily_product_sales (
  business_date TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  currency TEXT NOT NULL,
  units_e4 INTEGER NOT NULL,
  refunded_units_e4 INTEGER NOT NULL,
  gross_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  refund_amount INTEGER NOT NULL,
  cost_amount INTEGER NOT NULL,
  units_missing_cost_e4 INTEGER NOT NULL,
  PRIMARY KEY (business_date, location_id, product_id, channel, currency)
) STRICT, WITHOUT ROWID;

CREATE TABLE store_customer_summary (
  customer_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  first_order_date TEXT NOT NULL,
  last_order_date TEXT NOT NULL,
  orders INTEGER NOT NULL,
  lifetime_net_amount INTEGER NOT NULL,
  PRIMARY KEY (customer_id, currency)
) STRICT, WITHOUT ROWID;

CREATE TABLE store_daily_source_coverage (
  source_id INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  orders INTEGER NOT NULL,
  transactions INTEGER NOT NULL,
  PRIMARY KEY (source_id, business_date, location_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX store_daily_source_coverage_day ON store_daily_source_coverage (business_date, location_id);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  template_version_id INTEGER,
  mapping_version TEXT NOT NULL,
  started_by TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  counts TEXT NOT NULL DEFAULT '{}',
  progress TEXT,
  undo_of INTEGER,
  undone_by INTEGER,
  cursor TEXT,
  -- Set by a cancel; the import loop honours it between batches.
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  -- Warning counts (json: fingerprintRows, totalMismatch, quantityRounded).
  warnings TEXT NOT NULL DEFAULT '{}',
  -- Why the run failed; never row values.
  error TEXT
) STRICT;

CREATE TABLE run_rejections (
  run_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  raw_object_id INTEGER,
  row_index INTEGER,
  reason_code TEXT NOT NULL,
  column_name TEXT,
  detail TEXT
) STRICT;
CREATE INDEX run_rejections_run ON run_rejections (run_id);

CREATE TABLE raw_objects (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  file_role TEXT,
  -- CSV files: the name the member's file had (display and lineage).
  file_name TEXT,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  record_count INTEGER
) STRICT;

-- Imported rows: the raw object and 1-based record they came from (FR-013 lineage, US4.2).
CREATE TABLE row_origins (
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  raw_object_id INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source_id INTEGER,
  origin TEXT NOT NULL,
  builtin_key TEXT,
  current_version_id INTEGER,
  created_by TEXT
) STRICT;

CREATE TABLE template_versions (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  mapping TEXT NOT NULL,
  header_signatures TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE staged_imports (
  id INTEGER PRIMARY KEY,
  source_id INTEGER,
  files TEXT NOT NULL,
  status TEXT NOT NULL,
  deterministic_mapping TEXT,
  agent_mapping TEXT,
  -- The mapping the member started the import with (rebuilds of built-in templates reuse its settings).
  import_mapping TEXT,
  chosen_template_version_id INTEGER,
  run_id INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Template matches found at staging (json: TemplateMatch[]) and required files of the set that are missing.
  matches TEXT NOT NULL DEFAULT '[]',
  missing_files TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE row_versions (
  run_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  before TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX row_versions_row ON row_versions (table_name, row_id);

CREATE TABLE dirty_days (
  location_id INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  PRIMARY KEY (location_id, business_date)
) STRICT, WITHOUT ROWID;

-- Customers whose customer_summary rows need recomputing.
CREATE TABLE dirty_customers (
  customer_id INTEGER PRIMARY KEY
) STRICT;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL,
  pii_unmasked INTEGER NOT NULL DEFAULT 0,
  pii_changed_by TEXT,
  pii_changed_at INTEGER,
  backfill_years INTEGER NOT NULL DEFAULT 3,
  size_warned_at INTEGER,
  email_hmac_key TEXT NOT NULL
) STRICT;

CREATE TABLE match_links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  canonical_id INTEGER NOT NULL,
  basis TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
) STRICT;
`;

/** The `customers` view, masked (default) or unmasked (research R12). */
export function customersViewSql(unmasked: boolean): string {
  const pii = unmasked
    ? "first_name, last_name, email, phone"
    : "first_name_mask AS first_name, last_name_mask AS last_name, email_mask AS email, " +
      "phone_mask AS phone";
  return `CREATE VIEW customers AS SELECT ${LINEAGE_VIEW_COLUMNS}, ${pii}, email_hash, phone_hash,
    ${iso("created_at")}, marketing_opt_in, canonical_customer_id FROM store_customers`;
}

const VIEWS = [
  `CREATE VIEW locations AS SELECT ${LINEAGE_VIEW_COLUMNS}, name, kind, timezone,
    printf('%02d:%02d', day_cutoff_minutes / 60, day_cutoff_minutes % 60) AS day_cutoff, currency,
    address_city, address_region, address_country, address_postal_code FROM store_locations`,
  customersViewSql(false),
  `CREATE VIEW products AS SELECT ${LINEAGE_VIEW_COLUMNS}, name, variant_name, parent_product_id,
    sku, barcode, category, price_amount, currency, unit_cost_amount, is_active,
    canonical_product_id FROM store_products`,
  `CREATE VIEW orders AS SELECT ${LINEAGE_VIEW_COLUMNS}, location_id, customer_id, order_number,
    status, channel, ${iso("opened_at")}, ${iso("closed_at")}, business_date, local_hour, currency,
    gross_amount, discount_amount, service_charge_amount, tax_amount, tip_amount, total_amount,
    prices_include_tax, guest_count FROM store_orders`,
  `CREATE VIEW line_items AS SELECT ${LINEAGE_VIEW_COLUMNS}, order_id, location_id, business_date,
    product_id, name, quantity_e4 / 10000.0 AS quantity, unit_price_amount, gross_amount,
    discount_amount, tax_amount, gross_amount - discount_amount AS net_amount, modifiers,
    unit_cost_amount, is_voided, currency FROM store_line_items`,
  `CREATE VIEW transactions AS SELECT ${LINEAGE_VIEW_COLUMNS}, order_id, location_id,
    parent_transaction_id, kind, tender, card_brand, amount, sales_amount, tax_amount, tip_amount,
    breakdown_known, fee_amount, currency, ${iso("occurred_at")}, business_date, status
    FROM store_transactions`,
  `CREATE VIEW refund_items AS SELECT ${LINEAGE_VIEW_COLUMNS}, transaction_id, order_id,
    line_item_id, location_id, product_id, quantity_e4 / 10000.0 AS quantity, sales_amount,
    tax_amount, business_date, currency FROM store_refund_items`,
  `CREATE VIEW inventory AS SELECT ${LINEAGE_VIEW_COLUMNS}, product_id, location_id,
    quantity_on_hand_e4 / 10000.0 AS quantity_on_hand, state, ${iso("as_of")} FROM store_inventory`,
  `CREATE VIEW inventory_movements AS SELECT ${LINEAGE_VIEW_COLUMNS}, product_id, location_id,
    quantity_delta_e4 / 10000.0 AS quantity_delta, reason, ${iso("occurred_at")}
    FROM store_inventory_movements`,
  `CREATE VIEW sources AS SELECT id, kind, label, status, ${iso("last_success_at")}, coverage_from,
    coverage_to FROM store_sources`,
  `CREATE VIEW daily_sales AS SELECT business_date, location_id, channel, currency, orders,
    voided_orders, gross_amount, discount_amount, refund_amount,
    gross_amount - discount_amount - refund_amount AS net_amount, tax_amount, tip_amount,
    service_charge_amount, units_e4 / 10000.0 AS units, refunded_units_e4 / 10000.0 AS refunded_units,
    cost_amount, lines_missing_cost FROM store_daily_sales`,
  `CREATE VIEW daily_product_sales AS SELECT business_date, location_id,
    NULLIF(product_id, 0) AS product_id, channel, currency, units_e4 / 10000.0 AS units,
    refunded_units_e4 / 10000.0 AS refunded_units, gross_amount, discount_amount, refund_amount,
    gross_amount - discount_amount - refund_amount AS net_amount, cost_amount,
    units_missing_cost_e4 / 10000.0 AS units_missing_cost FROM store_daily_product_sales`,
  `CREATE VIEW customer_summary AS SELECT customer_id, currency, first_order_date, last_order_date,
    orders, lifetime_net_amount FROM store_customer_summary`,
  `CREATE VIEW daily_source_coverage AS SELECT business_date, location_id, source_id, orders,
    transactions FROM store_daily_source_coverage`,
];

/**
 * Ordered schema migrations, applied inside the dataset Durable Object. Index `n` takes the schema
 * from version `n` to `n + 1`; never edit a shipped entry, append a new one.
 */
export const SCHEMA_MIGRATIONS: readonly string[][] = [
  [TABLES, ...VIEWS],
];

/** The schema version the code expects. */
export const SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;
