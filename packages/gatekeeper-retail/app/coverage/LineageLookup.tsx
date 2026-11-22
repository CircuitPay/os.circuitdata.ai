import { Banner, Button, Input, LayerCard, Select, Text } from "@cloudflare/kumo";
import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { LineageTable, RetailAppClient, RowLineage } from "../../src/app-api-types";
import { errorMessage, formatDateTime } from "../format";
import { RUN_KIND_LABELS } from "../runs/runLabels";
import { SOURCE_KIND_LABELS } from "../sourceLabels";

const TABLES: Record<LineageTable, string> = {
  orders: "orders",
  line_items: "line_items",
  transactions: "transactions",
  refund_items: "refund_items",
  customers: "customers",
  products: "products",
  locations: "locations",
  inventory: "inventory",
  inventory_movements: "inventory_movements",
  sources: "sources",
  daily_sales: "daily_sales",
  daily_product_sales: "daily_product_sales",
  customer_summary: "customer_summary",
  daily_source_coverage: "daily_source_coverage",
};

type Result = { state: "idle" } | { state: "failed"; message: string } | { state: "found"; lineage: RowLineage };

/** Where one canonical row came from: source, run, mapping version, file and row (US4.2). */
const LineageLookup = ({ api }: { api: Pick<RetailAppClient, "getLineage"> }) => {
  const [table, setTable] = useState<LineageTable>("orders");
  const [rowId, setRowId] = useState("");
  const [tracing, setTracing] = useState(false);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const id = Number(rowId);
  const validId = rowId.trim() !== "" && Number.isInteger(id) && id > 0;

  const trace = async () => {
    setTracing(true);
    try {
      setResult({ state: "found", lineage: await api.getLineage(table, id) });
    } catch (thrown) {
      setResult({ state: "failed", message: errorMessage(thrown) });
    } finally {
      setTracing(false);
    }
  };

  return (
    <section aria-labelledby="lineage-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h3" id="lineage-heading">
        Where a row came from
      </Text>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (validId) void trace();
        }}
      >
        <Select
          label="Table"
          items={TABLES}
          value={table}
          onValueChange={(value) => setTable(value as LineageTable)}
        />
        <Input
          label="Row id"
          type="number"
          min={1}
          value={rowId}
          onChange={(event) => setRowId(event.target.value)}
        />
        <Button type="submit" variant="secondary" icon={<MagnifyingGlass />} disabled={!validId} loading={tracing}>
          Trace
        </Button>
      </form>
      <div aria-live="polite">
        {result.state === "failed" && (
          <Banner variant="error" icon={<WarningCircle />} title="The row could not be traced" description={result.message} />
        )}
        {result.state === "found" && <Lineage lineage={result.lineage} />}
      </div>
    </section>
  );
};

const Lineage = ({ lineage }: { lineage: RowLineage }) => (
  <LayerCard className="p-4">
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
      <dt className="text-kumo-subtle">Row</dt>
      <dd>
        {lineage.table} {lineage.id}
      </dd>
      <dt className="text-kumo-subtle">Source</dt>
      <dd>
        {lineage.source.label} ({SOURCE_KIND_LABELS[lineage.source.kind]})
      </dd>
      <dt className="text-kumo-subtle">Source record</dt>
      <dd>{lineage.sourceRecordId}</dd>
      <dt className="text-kumo-subtle">Run</dt>
      <dd>
        {RUN_KIND_LABELS[lineage.run.kind]} {lineage.run.id}
        {lineage.run.finishedAt ? `, finished ${formatDateTime(lineage.run.finishedAt)}` : ""}
      </dd>
      <dt className="text-kumo-subtle">Mapping version</dt>
      <dd>{lineage.mappingVersion}</dd>
      {lineage.file && (
        <>
          <dt className="text-kumo-subtle">File</dt>
          <dd>
            {lineage.file.name}, row {lineage.file.row}
          </dd>
        </>
      )}
    </dl>
  </LayerCard>
);

export default LineageLookup;
