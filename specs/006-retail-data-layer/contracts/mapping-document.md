# Contract: the mapping document

A mapping is **data, not code**. The agent proposes one, a member confirms it, and templates store it
in versions (`template_versions.mapping`). Nothing in a mapping runs code. The import engine
interprets it, and the document is validated with zod on every write. The `RetailMapping` type in
`retail-binding.md` is the agent-facing subset. The full internal form adds multi-file sets,
parsing overrides and per-table targets.

```ts
type MappingDocument = {
  version: 1;
  /** Parsing; each field overrides the sniffed value. */
  parsing?: {
    encoding?: string;             // a WHATWG label, e.g. "windows-1252"
    delimiter?: "," | ";" | "\t" | "|";
    headerRow?: number;            // 1-based
    footerRows?: number;           // trailing total rows to drop
  };
  settings: {
    timezone: string;              // IANA; the location timezone when the file has no location column
    currency: string;              // ISO 4217; used when no currency column is mapped
    dateFormat: string;            // e.g. "MM/dd/yyyy HH:mm:ss", "yyyy-MM-dd"
    decimalMark: "." | ",";
    negativeStyle?: "minus" | "parentheses";
    businessDate?: "from_column" | "from_timestamp" | "from_file_date"; // Toast: from_file_date
  };
  /** Multi-file sets (Toast). Absent for a single file. */
  files?: {
    role: string;                  // e.g. "OrderDetails"
    required: boolean;
    /** Recognised by these headers (all must be present). */
    headerSignature: string[];
  }[];
  /** Rows sharing this key form one order. Null: each row is one order. */
  orderKey: ColumnRef | null;
  /** When a source has no ids, these mapped fields form the fingerprint (US2.5). */
  fingerprint?: string[];          // target paths, e.g. ["orders.opened_at", "orders.total_amount"]
  /**
   * Continuation rows (Shopify): order-level fields blank on later rows of the same order are
   * filled from that order's first row.
   */
  fillOrderFieldsDown?: boolean;
  targets: {
    target: TargetPath;            // e.g. "orders.business_date", "line_items.quantity"
    from: ColumnRef | null;
    constant?: string | number | boolean;
    transform?: Transform;
    /** Only for enum targets (status, channel, tender, kind): source value → canonical value. */
    valueMap?: Record<string, string>;
  }[];
  /** Joins between files of a set, e.g. ItemSelectionDetails."Order Id" = OrderDetails."Order Id". */
  joins?: { from: ColumnRef; to: ColumnRef }[];
};

type ColumnRef = string | { file: string; column: string };   // a string means the single file
type Transform =
  | "date" | "datetime" | "time" | "money" | "negate_money" | "quantity" | "percent"
  | "lowercase" | "uppercase" | "trim" | "boolean" | "split_name_first" | "split_name_last";
type TargetPath = `${CanonicalTable}.${string}`;               // must name a writable canonical column
```

Validation (refused with a message naming the field):

- Every target path is a known canonical column. Lineage and id columns cannot be targets.
- Required targets are present, either mapped or constant:
  - `orders`: `business_date` (or the source fields to derive it), `currency` (or `settings.currency`) and a total.
  - `line_items`: `name` and `quantity`.
- `orderKey` must be set or `fingerprint` must be set.
- `timezone` is accepted by `Intl` and `currency` is ISO 4217.
- In a file set, every `ColumnRef.file` names a declared role, and every required role is present
  at import (US2.8).
- At most 64 KiB, 200 targets and 10 files.

Header matching (US2.4):

- A template matches a file, or a set, when its `headerSignature` headers are all present, compared
  case- and whitespace-insensitively. Extra columns are allowed.
- When several templates match, the most recently used one wins.

## Built-in templates (FR-010)

| Key | Files | Order key | Notes |
|---|---|---|---|
| `toast` | `OrderDetails` (required), `ItemSelectionDetails` (required), `PaymentDetails` (required), `ModifiersSelectionDetails`, `CheckDetails`, `AllItemsReport` (products), stock export (inventory) | `OrderDetails."Order Id"` | Items, modifiers and payments are joined on `Order Id`, `Check Id` and `Item Selection Id`. A modifier's `Parent Menu Selection Item ID` → the item's `Item Selection Id`. `Location` (a name) → location. `businessDate: from_file_date`. Date formats are set per file: `MM/DD/YYYY HH:MM:SS`, but `MM/DD/YY` + `hh:mm a` in CheckDetails. `Voided` → order `voided`. `Void?` → line `is_voided`. `Refunded`/`Refund Amount` → refund transaction. The modifiers file's misspelled header "Sales Cateogry" is matched as written. Source: https://doc.toasttab.com/doc/platformguide/adminDataExportFieldReference.html. To be checked against real sample exports before release. |
| `square_item_detail` | one file (Dashboard → Transactions → Export → Item Detail CSV) | `Transaction ID` | Money cells carry a currency symbol. Square publishes no column reference, and headers vary by region, so this template matches on a minimal signature (`Date`, `Time`, `Item`, `Qty`, `Gross Sales`, `Transaction ID`) and resolves the rest by alias. |
| `shopify_orders` | one file (Orders → Export) | `Id` (fallback `Name`) | `fillOrderFieldsDown: true`, because continuation rows leave order fields blank. `Lineitem *` → line items. `Refunded Amount` → refund transaction (no itemization). `Financial Status` → status `valueMap`. Source: https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders |

A built-in template's mapping version is part of the release. When it changes, every source that
used it is offered a rebuild (US5.2).
