import { Button, LayerCard, Table, Tooltip } from "@cloudflare/kumo";
import type { BrowseColumn, BrowseRow } from "../../src/app-api-types";
import { currencyOf, formatValue } from "./values";

/** Longer cell text is shortened in the grid; the full value stays in the cell's title. */
const CELL_LENGTH = 60;

/**
 * Rows of a retail table under its schema's column names. Each row's id opens the row's detail;
 * nothing here changes a row (FR-021).
 */
const RowGrid = ({
  caption,
  columns,
  rows,
  onOpen,
}: {
  caption: string;
  columns: BrowseColumn[];
  rows: BrowseRow[];
  /** `opener` takes focus back when the detail closes. */
  onOpen: (id: number, opener: HTMLElement) => void;
}) => (
  <LayerCard className="overflow-x-auto p-0">
    <Table>
      <caption className="sr-only">{caption}</caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>id</Table.Head>
          {columns.map((column) => (
            <Table.Head key={column.name}>
              {column.description ? (
                <Tooltip
                  content={column.description}
                  render={<span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-4" />}
                >
                  {column.name}
                </Tooltip>
              ) : (
                column.name
              )}
            </Table.Head>
          ))}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row) => (
          <Table.Row key={row.id}>
            <Table.Head>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open row ${row.id}`}
                onClick={(event) => onOpen(row.id, event.currentTarget)}
              >
                {row.id}
              </Button>
            </Table.Head>
            {columns.map((column, index) => {
              const value = row.values[index] ?? null;
              const currency = currencyOf(column, columns, row.values);
              const text = formatValue(column, value, currency, "grid");
              const full = formatValue(column, value, currency, "detail");
              const shortened = text.length > CELL_LENGTH;
              return (
                <Table.Cell key={column.name} title={shortened || full !== text ? full : undefined}>
                  {shortened ? `${text.slice(0, CELL_LENGTH - 1)}…` : text}
                </Table.Cell>
              );
            })}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  </LayerCard>
);

export default RowGrid;
