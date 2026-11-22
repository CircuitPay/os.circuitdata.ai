import { LayerCard, Table, Text } from "@cloudflare/kumo";
import type { RunTableCounts } from "../../src/app-api-types";
import { formatCount } from "../format";

/** Rows per canonical table: read, written, updated, skipped and rejected (FR-011). */
const RunCountsTable = ({
  caption,
  counts,
}: {
  caption: string;
  counts: Partial<Record<string, RunTableCounts>>;
}) => {
  const rows = Object.entries(counts).flatMap(([table, count]) => (count ? [{ table, count }] : []));
  if (rows.length === 0) return <Text variant="secondary">No rows yet.</Text>;
  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>Table</Table.Head>
            <Table.Head>Read</Table.Head>
            <Table.Head>Written</Table.Head>
            <Table.Head>Updated</Table.Head>
            <Table.Head>Skipped</Table.Head>
            <Table.Head>Rejected</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map(({ table, count }) => (
            <Table.Row key={table}>
              <Table.Head>{table}</Table.Head>
              <Table.Cell>{formatCount(count.fetched)}</Table.Cell>
              <Table.Cell>{formatCount(count.written)}</Table.Cell>
              <Table.Cell>{formatCount(count.updated)}</Table.Cell>
              <Table.Cell>{formatCount(count.skipped)}</Table.Cell>
              <Table.Cell>{formatCount(count.rejected)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
};

export default RunCountsTable;
