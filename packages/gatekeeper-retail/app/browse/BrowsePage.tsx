import { Banner, Button, Empty, Input, Loader, Select, Text } from "@cloudflare/kumo";
import { CalendarBlank, Rows, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  BrowseCatalog,
  BrowsePage as BrowsePageData,
  BrowseQuery,
  BrowseTable,
  BrowseTableInfo,
  RetailAppClient,
  RunSummary,
} from "../../src/app-api-types";
import { focusOnMount } from "../focus";
import { errorMessage, formatCount, formatDate } from "../format";
import type { BrowseTarget } from "../navigation";
import { SOURCE_KIND_LABELS } from "../sourceLabels";
import MaskedNotice from "./MaskedNotice";
import RowDetailView from "./RowDetailView";
import RowGrid from "./RowGrid";

export type BrowseApi = Pick<RetailAppClient, "getBrowseCatalog" | "browseRows" | "getRowDetail" | "listRuns">;

/** Another panel asking to show a table; a new `seq` opens it again. */
export type BrowseRequest = BrowseTarget & { seq: number };

/** How many recent imports "Rows from" offers. */
const RECENT_IMPORTS = 20;

/** Typing applies the search after this pause; Enter applies it at once. */
const SEARCH_PAUSE_MS = 500;

const ALL_ROWS = "all";

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; catalog: BrowseCatalog; imports: RunSummary[] };

/**
 * Browse (US3): the retail tables with their row counts, one table's rows with filters and paging,
 * and a row's detail. Read-only.
 */
const BrowsePage = ({ api, request }: { api: BrowseApi; request?: BrowseRequest }) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // `version` remounts the table view, so each selection starts from its own filters.
  const [selection, setSelection] = useState(() => ({
    target: request ?? { table: "orders" as BrowseTable },
    version: 0,
    requested: request !== undefined,
  }));
  const [requestSeq, setRequestSeq] = useState(request?.seq);
  if (request && request.seq !== requestSeq) {
    setRequestSeq(request.seq);
    setSelection({ target: request, version: selection.version + 1, requested: true });
  }

  // A request usually follows a new import, so the counts and the imports are read again.
  const seq = request?.seq;
  useEffect(() => {
    let current = true;
    Promise.all([api.getBrowseCatalog(), api.listRuns({ limit: 100 })]).then(
      ([catalog, runs]) =>
        current &&
        setLoad({
          state: "loaded",
          catalog,
          imports: runs.items
            .filter((run) => run.kind === "import" && run.status === "succeeded")
            .slice(0, RECENT_IMPORTS),
        }),
      (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api, seq]);

  if (load.state === "loading") {
    return (
      <div className="flex justify-center p-12" role="status" aria-label="Loading the tables">
        <Loader size="lg" />
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <Banner variant="error" icon={<WarningCircle />} title="The tables could not be loaded" description={load.message} />
    );
  }

  const { catalog, imports } = load;
  const info = catalog.tables.find((table) => table.name === selection.target.table);
  const labels: Partial<Record<BrowseTable, string>> = {};
  for (const table of catalog.tables) labels[table.name] = table.label;

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <nav aria-label="Tables">
        <ul className="flex flex-col gap-2">
          {catalog.tables.map((table) => {
            const selected = table.name === selection.target.table;
            const summaryId = `browse-table-${table.name}-summary`;
            return (
              <li key={table.name} className="flex flex-col">
                <Button
                  variant={selected ? "secondary" : "ghost"}
                  className="justify-start"
                  aria-current={selected ? "true" : undefined}
                  aria-describedby={summaryId}
                  onClick={() =>
                    setSelection({ target: { table: table.name }, version: selection.version + 1, requested: false })
                  }
                >
                  {table.label}
                </Button>
                <Text variant="secondary" size="sm" id={summaryId}>
                  {table.rows === 0 ? "No rows yet" : `${formatCount(table.rows)} ${table.rows === 1 ? "row" : "rows"}`}
                  {" · "}
                  {table.description}
                </Text>
              </li>
            );
          })}
        </ul>
      </nav>
      {info === undefined ? (
        <Empty icon={<Rows size={48} />} title="Choose a table" description="Pick a table to see its rows." />
      ) : (
        <TableView
          key={`${info.name}-${selection.version}`}
          api={api}
          info={info}
          catalog={catalog}
          imports={imports}
          labels={labels}
          initial={selection.target}
          focusHeading={selection.requested}
        />
      )}
    </div>
  );
};

type Filters = {
  /** Inclusive business dates, "" when unset. */
  from: string;
  to: string;
  /** `ALL_ROWS`, `source:<id>` or `run:<id>`. */
  rowsFrom: string;
  /** The applied search, "" for none. */
  search: string;
  offset: number;
};

type Detail = { table: BrowseTable; id: number; opener: HTMLElement };

function queryOf(filters: Filters): BrowseQuery {
  const query: BrowseQuery = {};
  if (filters.offset > 0) query.offset = filters.offset;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  const [kind, id] = filters.rowsFrom.split(":");
  if (kind === "run") query.runId = Number(id);
  if (kind === "source") query.sourceId = Number(id);
  if (filters.search) query.search = filters.search;
  return query;
}

function dateRangeText(from: string, to: string): string {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
  return from ? `from ${formatDate(from)}` : `up to ${formatDate(to)}`;
}

const TableView = ({
  api,
  info,
  catalog,
  imports,
  labels,
  initial,
  focusHeading,
}: {
  api: BrowseApi;
  info: BrowseTableInfo;
  catalog: BrowseCatalog;
  imports: RunSummary[];
  labels: Partial<Record<BrowseTable, string>>;
  initial: BrowseTarget;
  focusHeading: boolean;
}) => {
  const [filters, setFilters] = useState<Filters>(() => ({
    from: "",
    to: "",
    rowsFrom:
      initial.runId !== undefined
        ? `run:${initial.runId}`
        : initial.sourceId !== undefined
          ? `source:${initial.sourceId}`
          : ALL_ROWS,
    search: "",
    offset: 0,
  }));
  // The filters the shown page (or error) answers; a page for older filters is still loading anew.
  const [result, setResult] = useState<
    { filters: Filters; page: BrowsePageData } | { filters: Filters; message: string } | null
  >(null);
  const [searchText, setSearchText] = useState("");
  const searchTimer = useRef<number | undefined>(undefined);
  const [details, setDetails] = useState<Detail[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const table = info.name;

  useEffect(() => {
    let current = true;
    api.browseRows(table, queryOf(filters)).then(
      (page) => current && setResult({ filters, page }),
      (error: unknown) => current && setResult({ filters, message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [api, table, filters]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const change = (next: Partial<Filters>) => setFilters({ ...filters, ...next, offset: 0 });
  const applySearch = (text: string) => {
    clearTimeout(searchTimer.current);
    const search = text.trim();
    setFilters((previous) => (previous.search === search ? previous : { ...previous, search, offset: 0 }));
  };

  const rowsFromItems: Record<string, string> = { [ALL_ROWS]: "All rows" };
  for (const source of catalog.sources) {
    rowsFromItems[`source:${source.id}`] = `${source.label} (${SOURCE_KIND_LABELS[source.kind]})`;
  }
  for (const run of imports) {
    const files = run.files.map((file) => file.name).join(", ") || run.sourceLabel;
    rowsFromItems[`run:${run.id}`] = `Import ${run.id}: ${files}, ${formatDate(run.finishedAt ?? run.startedAt)}`;
  }
  // An import opened from its report stays choosable even when it is not among the recent ones.
  if (initial.runId !== undefined) rowsFromItems[`run:${initial.runId}`] ??= `Import ${initial.runId}`;

  const loading = result === null || result.filters !== filters;
  const page = result !== null && "page" in result ? result.page : null;
  const captionParts = [info.label];
  if (filters.from || filters.to) captionParts.push(dateRangeText(filters.from, filters.to));
  else if (page?.narrowedTo) captionParts.push(dateRangeText(page.narrowedTo.from, page.narrowedTo.to));
  if (filters.rowsFrom !== ALL_ROWS) captionParts.push(`rows from ${rowsFromItems[filters.rowsFrom]}`);
  if (filters.search) captionParts.push(`matching “${filters.search}”`);
  const position =
    page === null
      ? ""
      : page.total === 0
        ? "No rows"
        : `${formatCount(page.offset + 1)}–${formatCount(page.offset + page.rows.length)} of ${formatCount(page.total)}`;

  const openDetail = (detailTable: BrowseTable, id: number, opener: HTMLElement) => {
    setRowError(null);
    setDetails([...details, { table: detailTable, id, opener }]);
  };
  // Back, or a row that is gone: the previous view returns and its opener takes focus again.
  const closeDetail = (message: string | null) => {
    const top = details.at(-1);
    if (!top) return;
    flushSync(() => {
      setDetails(details.slice(0, -1));
      setRowError(message);
    });
    top.opener.focus();
  };

  return (
    <section aria-labelledby={`browse-${table}-heading`} className="flex min-w-0 flex-col gap-4">
      {rowError !== null && (
        <Banner variant="error" icon={<WarningCircle />} title="The row could not be opened" description={rowError} />
      )}
      <div hidden={details.length > 0} className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <Text
            variant="heading"
            size="lg"
            as="h2"
            id={`browse-${table}-heading`}
            tabIndex={-1}
            ref={focusHeading ? focusOnMount : undefined}
          >
            {info.label}
          </Text>
          <Text variant="secondary">{info.description}</Text>
        </header>
        <div className="flex flex-wrap items-end gap-3">
          {info.dateColumn !== null && (
            <>
              <Input
                label="From"
                type="date"
                value={filters.from}
                max={filters.to || undefined}
                onChange={(event) => change({ from: event.target.value })}
              />
              <Input
                label="To"
                type="date"
                value={filters.to}
                min={filters.from || undefined}
                onChange={(event) => change({ to: event.target.value })}
              />
            </>
          )}
          <Select
            label="Rows from"
            items={rowsFromItems}
            value={filters.rowsFrom}
            onValueChange={(value) => change({ rowsFrom: String(value) })}
          />
          {info.search !== null && (
            <Input
              label="Search"
              type="search"
              placeholder={`Find by ${info.search.label}`}
              maxLength={100}
              value={searchText}
              onChange={(event) => {
                const text = event.target.value;
                setSearchText(text);
                clearTimeout(searchTimer.current);
                searchTimer.current = window.setTimeout(() => applySearch(text), SEARCH_PAUSE_MS);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") applySearch(searchText);
              }}
            />
          )}
        </div>
        {page?.narrowedTo && (
          <Banner
            icon={<CalendarBlank />}
            title={`This table is large, so it opens on ${dateRangeText(page.narrowedTo.from, page.narrowedTo.to)}. Choose dates to see others.`}
          />
        )}
        {table === "customers" && catalog.personalDataMasked && <MaskedNotice />}
        {result !== null && "message" in result && (
          <Banner
            variant="error"
            icon={<WarningCircle />}
            title="The rows could not be loaded"
            description={result.message}
          />
        )}
        <div aria-busy={loading} className="flex flex-col gap-3">
          {page === null ? (
            loading && (
              <div className="flex justify-center p-12" role="status" aria-label="Loading rows">
                <Loader size="lg" />
              </div>
            )
          ) : page.rows.length === 0 ? (
            <Empty
              icon={<Rows size={48} />}
              title={info.rows === 0 ? "No rows yet" : "No rows match"}
              description={
                info.rows === 0 ? "Rows appear here once they are imported or synced." : "Change the filters to see others."
              }
            />
          ) : (
            <RowGrid
              caption={captionParts.join(", ")}
              columns={page.columns}
              rows={page.rows}
              onOpen={(id, opener) => openDetail(table, id, opener)}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={loading || filters.offset === 0}
              onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - (page?.pageSize ?? 100)) })}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={loading || page === null || page.offset + page.pageSize >= page.total}
              onClick={() => page && setFilters({ ...filters, offset: page.offset + page.pageSize })}
            >
              Next
            </Button>
            <p aria-live="polite" aria-atomic="true" className="text-kumo-subtle">
              {position}
            </p>
          </div>
        </div>
      </div>
      {details.map((detail, index) => (
        <div key={`${index}-${detail.table}-${detail.id}`} hidden={index !== details.length - 1}>
          <RowDetailView
            api={api}
            table={detail.table}
            id={detail.id}
            labels={labels}
            masked={catalog.personalDataMasked}
            onBack={() => closeDetail(null)}
            onGone={closeDetail}
            onOpen={openDetail}
          />
        </div>
      ))}
    </section>
  );
};

export default BrowsePage;
