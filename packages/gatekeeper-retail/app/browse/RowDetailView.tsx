import { Button, Loader, Text } from "@cloudflare/kumo";
import { ArrowLeft } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useState } from "react";
import type { BrowseTable, RetailAppClient, RowDetail, RowLineage } from "../../src/app-api-types";
import { focusOnMount } from "../focus";
import { errorMessage } from "../format";
import { RUN_KIND_LABELS } from "../runs/runLabels";
import MaskedNotice from "./MaskedNotice";
import RowGrid from "./RowGrid";
import { currencyOf, formatValue } from "./values";

function originText(origin: RowLineage): string {
  const parts = [`From ${origin.source.label}`, `${RUN_KIND_LABELS[origin.run.kind].toLowerCase()} #${origin.run.id}`];
  if (origin.file) parts.push(`${origin.file.name}, row ${origin.file.row}`);
  return parts.join(" · ");
}

/**
 * One row (FR-020): every field with its description, the related rows one step away (each opens
 * its own detail) and where the row came from. Read-only.
 */
const RowDetailView = ({
  api,
  table,
  id,
  labels,
  masked,
  onBack,
  onGone,
  onOpen,
}: {
  api: Pick<RetailAppClient, "getRowDetail">;
  table: BrowseTable;
  id: number;
  /** Each table's label, e.g. "Orders". */
  labels: Partial<Record<BrowseTable, string>>;
  /** Whether customers' names, emails and phone numbers are hidden. */
  masked: boolean;
  onBack: () => void;
  /** The row could not be read, e.g. an undone import removed it. */
  onGone: (message: string) => void;
  onOpen: (table: BrowseTable, id: number, opener: HTMLElement) => void;
}) => {
  const [detail, setDetail] = useState<RowDetail | null>(null);
  const reportGone = useEffectEvent(onGone);

  useEffect(() => {
    let current = true;
    api.getRowDetail(table, id).then(
      (loaded) => current && setDetail(loaded),
      (error: unknown) => current && reportGone(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [api, table, id]);

  const title = `${labels[table] ?? table} row ${id}`;
  const fieldColumns = detail?.fields.map((field) => field.column) ?? [];
  const fieldValues = detail?.fields.map((field) => field.value) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          Back
        </Button>
      </div>
      {detail === null ? (
        <div className="flex justify-center p-12" role="status" aria-label="Loading the row">
          <Loader size="lg" />
        </div>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <Text variant="heading" size="lg" as="h3" tabIndex={-1} ref={focusOnMount}>
              {title}
            </Text>
            {detail.origin !== null && <Text variant="secondary">{originText(detail.origin)}</Text>}
          </header>
          {masked && table === "customers" && <MaskedNotice />}
          <section aria-label="Fields">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
              {detail.fields.map(({ column, value }) => (
                <div key={column.name} className="contents">
                  <dt className="flex flex-col">
                    <span className="font-medium">{column.name}</span>
                    {column.description && (
                      <span className="text-sm text-kumo-subtle">{column.description}</span>
                    )}
                  </dt>
                  <dd className="break-words">
                    {formatValue(column, value, currencyOf(column, fieldColumns, fieldValues), "detail")}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          {detail.related.map((group) => (
            <section key={`${group.table}-${group.label}`} aria-label={group.label} className="flex flex-col gap-2">
              <Text variant="heading" as="h4">
                {group.label}
              </Text>
              {group.rows.length === 0 ? (
                <Text variant="secondary">None.</Text>
              ) : (
                <RowGrid
                  caption={`${group.label} of ${title}`}
                  columns={group.columns}
                  rows={group.rows}
                  onOpen={(rowId, opener) => onOpen(group.table, rowId, opener)}
                />
              )}
              {group.truncated && <Text variant="secondary">Showing the first 50.</Text>}
            </section>
          ))}
        </>
      )}
    </div>
  );
};

export default RowDetailView;
