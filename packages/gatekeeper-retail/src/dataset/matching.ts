// Cross-source matching (US6, data-model `match_links`): customers with the same email hash and
// products with the same SKU in two sources are proposed pre-ticked; rows that share only a name
// are proposed unticked. Nothing links until an administrator confirms; only a confirmation sets
// `canonical_*_id`, and an undo clears it.

import type { MatchBasis, MatchKind, MatchProposal } from "../app-api-types.js";

/** How many proposals one listing returns. */
const LIST_LIMIT = 200;

type KindSpec = {
  table: string;
  canonicalColumn: string;
  /** Each basis's match key over a row alias; null rows never match. */
  bases: { basis: MatchBasis; key: (row: string) => string }[];
};

const KINDS: Record<MatchKind, KindSpec> = {
  customer: {
    table: "store_customers",
    canonicalColumn: "canonical_customer_id",
    bases: [
      { basis: "email", key: row => `${row}.email_hash` },
      {
        basis: "name",
        key: row => `CASE WHEN trim(COALESCE(${row}.first_name, '')) != '' AND trim(COALESCE(${row}.last_name, '')) != '' ` +
          `THEN lower(trim(${row}.first_name)) || ' ' || lower(trim(${row}.last_name)) END`,
      },
    ],
  },
  product: {
    table: "store_products",
    canonicalColumn: "canonical_product_id",
    bases: [
      { basis: "sku", key: row => `NULLIF(lower(trim(${row}.sku)), '')` },
      {
        basis: "name",
        key: row => `lower(trim(${row}.name)) || char(0) || lower(trim(COALESCE(${row}.variant_name, '')))`,
      },
    ],
  },
};

/**
 * Adds a `proposed` link for every live, unlinked row that shares a key with a row of another
 * source. The group's oldest row is the canonical one. Decided pairs are never proposed again.
 */
export function proposeMatches(sql: SqlStorage, kind: MatchKind): void {
  const { table, canonicalColumn, bases } = KINDS[kind];
  for (const { basis, key } of bases) {
    sql.exec(
      `INSERT INTO match_links (kind, row_id, canonical_id, basis, status)
       SELECT ?, r.id, g.canonical, ?, 'proposed'
       FROM (SELECT ${key("s")} AS k, MIN(s.id) AS canonical FROM ${table} s
             WHERE s.deleted_at IS NULL AND ${key("s")} IS NOT NULL
             GROUP BY k HAVING COUNT(DISTINCT s.source_id) > 1) g
       JOIN ${table} c ON c.id = g.canonical
       JOIN ${table} r ON ${key("r")} = g.k
       WHERE r.deleted_at IS NULL AND r.source_id != c.source_id AND r.${canonicalColumn} IS NULL
         AND NOT EXISTS (SELECT 1 FROM match_links m WHERE m.kind = ? AND m.row_id = r.id AND m.canonical_id = g.canonical)`,
      kind, basis, kind);
  }
}

/** Open proposals and confirmed links of a kind, strong bases first. */
export function listMatches(sql: SqlStorage, kind: MatchKind, unmasked: boolean): MatchProposal[] {
  const { table } = KINDS[kind];
  const label = kind === "product"
    ? "x.name || COALESCE(' – ' || x.variant_name, '') || COALESCE(' (SKU ' || x.sku || ')', '')"
    : unmasked
      ? "trim(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')) || COALESCE(' <' || x.email || '>', '')"
      : "trim(COALESCE(x.first_name_mask, '') || ' ' || COALESCE(x.last_name_mask, '')) || COALESCE(' <' || x.email_mask || '>', '')";
  const side = (alias: string) => label.replaceAll("x.", `${alias}.`);
  const rows = sql.exec<{
    id: number; basis: MatchBasis; status: "proposed" | "confirmed"; decided_at: number | null;
    row_id: number; row_source: string; row_label: string;
    canonical_id: number; canonical_source: string; canonical_label: string;
  }>(
    `SELECT m.id, m.basis, m.status, m.decided_at,
       r.id AS row_id, rs.label AS row_source, ${side("r")} AS row_label,
       c.id AS canonical_id, cs.label AS canonical_source, ${side("c")} AS canonical_label
     FROM match_links m
     JOIN ${table} r ON r.id = m.row_id JOIN store_sources rs ON rs.id = r.source_id
     JOIN ${table} c ON c.id = m.canonical_id JOIN store_sources cs ON cs.id = c.source_id
     WHERE m.kind = ? AND m.status IN ('proposed', 'confirmed')
     ORDER BY m.status = 'confirmed', m.basis = 'name', m.id
     LIMIT ?`,
    kind, LIST_LIMIT).toArray();
  return rows.map(row => ({
    id: row.id,
    kind,
    basis: row.basis,
    status: row.status,
    preselected: row.basis !== "name",
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    row: { id: row.row_id, source: row.row_source, label: row.row_label },
    canonical: { id: row.canonical_id, source: row.canonical_source, label: row.canonical_label },
  }));
}

type Link = { id: number; kind: MatchKind; row_id: number; canonical_id: number; status: string };

function link(sql: SqlStorage, id: number): Link {
  const row = sql.exec<Link>("SELECT id, kind, row_id, canonical_id, status FROM match_links WHERE id = ?", id).toArray()[0];
  if (!row || !(row.kind in KINDS)) throw new Error("No such match.");
  return row;
}

/** Links the row to the canonical row (through it, when the canonical row is itself linked). */
export function confirmMatch(sql: SqlStorage, id: number, memberId: string, now: number): void {
  const match = link(sql, id);
  if (match.status !== "proposed") throw new Error("Only a proposed match can be confirmed.");
  const { table, canonicalColumn } = KINDS[match.kind];
  const row = sql.exec<{ linked: number | null }>(
    `SELECT ${canonicalColumn} AS linked FROM ${table} WHERE id = ?`, match.row_id).one();
  if (row.linked !== null) throw new Error("This row is already linked; undo that match first.");
  const target = sql.exec<{ id: number }>(
    `SELECT COALESCE(${canonicalColumn}, id) AS id FROM ${table} WHERE id = ?`, match.canonical_id).one().id;
  sql.exec(`UPDATE ${table} SET ${canonicalColumn} = ? WHERE id = ?`, target, match.row_id);
  // Rows already linked through this one follow it to the new canonical row.
  sql.exec(`UPDATE ${table} SET ${canonicalColumn} = ? WHERE ${canonicalColumn} = ?`, target, match.row_id);
  decide(sql, id, "confirmed", memberId, now);
}

export function rejectMatch(sql: SqlStorage, id: number, memberId: string, now: number): void {
  if (link(sql, id).status !== "proposed") throw new Error("Only a proposed match can be rejected.");
  decide(sql, id, "rejected", memberId, now);
}

/** Unlinks a confirmed match: the row is its own canonical row again. */
export function undoMatch(sql: SqlStorage, id: number, memberId: string, now: number): void {
  const match = link(sql, id);
  if (match.status !== "confirmed") throw new Error("Only a confirmed match can be undone.");
  const { table, canonicalColumn } = KINDS[match.kind];
  sql.exec(`UPDATE ${table} SET ${canonicalColumn} = NULL WHERE id = ?`, match.row_id);
  decide(sql, id, "undone", memberId, now);
}

function decide(sql: SqlStorage, id: number, status: string, memberId: string, now: number): void {
  sql.exec("UPDATE match_links SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", status, memberId, now, id);
}
