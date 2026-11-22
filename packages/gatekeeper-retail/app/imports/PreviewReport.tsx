import { Banner, Button, LayerCard, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { ImportPreview, StagedImportFile } from "../../src/app-api-types";
import { formatCount, formatMoney } from "../format";
import RunCountsTable from "../runs/RunCountsTable";
import { problemSampleRowId } from "./sampleRows";
import { warningMessages } from "./warnings";

type ProblemExample = ImportPreview["problems"][number]["examples"][number];

function describeExample(example: ProblemExample): string {
  const where = [
    example.row === null ? null : `Row ${example.row}`,
    example.file === null ? null : `of ${example.file}`,
    example.column === null ? null : `in ${example.column}`,
    `(${example.table})`,
  ].filter((part) => part !== null);
  return `${where.join(" ")}${example.detail ? `: ${example.detail}` : ""}`;
}

/**
 * What a mapping would produce, before anything is written (US2.3): rows per table, the first
 * rows per table, problems by reason, and totals per business date to compare with the POS report.
 */
const PreviewReport = ({
  importId,
  files,
  preview,
}: {
  importId: number;
  files: StagedImportFile[];
  preview: ImportPreview;
}) => {
  const warnings = warningMessages(preview.warnings);
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-4">
      <Text variant="heading" as="h3" id="preview-heading">
        Preview
      </Text>
      <Text variant="secondary">
        {preview.truncated
          ? `This preview read the first ${formatCount(preview.rowLimit)} rows only; the import reads every row.`
          : `This preview read all ${formatCount(preview.rowsRead)} rows. Nothing has been written yet.`}
      </Text>
      <RunCountsTable caption="Rows per table" counts={preview.counts} />
      {warnings.length > 0 && (
        <Banner
          variant="alert"
          icon={<Warning />}
          title="Check before importing"
          description={
            <ul className="list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          }
        />
      )}
      {preview.problems.length > 0 && (
        <div className="flex flex-col gap-2">
          <Text variant="heading" as="h4">
            Problems
          </Text>
          <ul className="flex flex-col gap-3">
            {preview.problems.map((problem) => (
              <li key={problem.reason} className="flex flex-col gap-1">
                <Text bold>
                  {problem.reason}: {formatCount(problem.count)} {problem.count === 1 ? "row" : "rows"}
                </Text>
                <ul className="flex flex-col gap-1 pl-4">
                  {problem.examples.map((example, index) => {
                    const rowId = problemSampleRowId(importId, files, example.file, example.row);
                    const text = describeExample(example);
                    return (
                      <li key={index}>
                        {rowId === null ? (
                          <Text>{text}</Text>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              document.getElementById(rowId)?.focus();
                            }}
                          >
                            {text}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.samples.map((sample) => (
        <LayerCard key={sample.table} className="max-h-96 overflow-auto p-0">
          <Table>
            <caption className="p-3 text-left font-medium">
              {sample.table}: first {sample.rows.length} rows as they would be imported
            </caption>
            <Table.Header>
              <Table.Row>
                {sample.columns.map((column) => (
                  <Table.Head key={column}>
                    {column}
                  </Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sample.rows.map((row, index) => (
                <Table.Row key={index}>
                  {row.map((cell, cellIndex) => (
                    <Table.Cell key={cellIndex}>{cell ?? ""}</Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      ))}
      {preview.dailyTotals.length > 0 && (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <caption className="p-3 text-left font-medium">
              Totals per business date, to compare with your point-of-sale report
            </caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Business date</Table.Head>
                <Table.Head>Orders</Table.Head>
                <Table.Head>Gross</Table.Head>
                <Table.Head>Discounts</Table.Head>
                <Table.Head>Refunds</Table.Head>
                <Table.Head>Net</Table.Head>
                <Table.Head>Tax</Table.Head>
                <Table.Head>Tips</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {preview.dailyTotals.map((day) => (
                <Table.Row key={`${day.businessDate}-${day.currency}`}>
                  <Table.Head>{day.businessDate}</Table.Head>
                  <Table.Cell>{formatCount(day.orders)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.gross, day.currency)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.discounts, day.currency)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.refunds, day.currency)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.net, day.currency)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.tax, day.currency)}</Table.Cell>
                  <Table.Cell>{formatMoney(day.tips, day.currency)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </section>
  );
};

export default PreviewReport;
