import { Banner, Button, Checkbox, Input, LayerCard, Loader, Table, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CoverageReport, RetailAppClient } from "../../src/app-api-types";
import { errorMessage, formatDateTime } from "../format";
import { SOURCE_KIND_LABELS, SOURCE_STATUS_LABELS } from "../sourceLabels";
import LineageLookup from "./LineageLookup";
import RunsWithRejections from "./RunsWithRejections";

export type CoverageApi = Pick<RetailAppClient, "getCoverage" | "getLineage" | "listRuns" | "listRejections">;

type Query = { from: string; to: string; locationIds: number[] };

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; report: CoverageReport };

function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
}

/** The Coverage tab: which sources cover which dates and locations, gaps, rejections, lineage (US4). */
const CoveragePage = ({ api }: { api: CoverageApi }) => {
  const [draft, setDraft] = useState<Query>({ from: "", to: "", locationIds: [] });
  const [query, setQuery] = useState<Query>(draft);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Locations seen in an unfiltered report; a filtered one only names the chosen locations.
  const [locations, setLocations] = useState<number[]>([]);

  useEffect(() => {
    let current = true;
    api
      .getCoverage({
        from: query.from || undefined,
        to: query.to || undefined,
        locationIds: query.locationIds.length > 0 ? query.locationIds : undefined,
      })
      .then(
        (report) => {
          if (!current) return;
          setLoad({ state: "loaded", report });
          if (query.locationIds.length === 0) {
            const ids = new Set([
              ...report.ranges.map((range) => range.locationId),
              ...report.possibleGaps.map((gap) => gap.locationId),
            ]);
            setLocations([...ids].toSorted((a, b) => a - b));
          }
        },
        (error: unknown) => current && setLoad({ state: "failed", message: errorMessage(error) }),
      );
    return () => {
      current = false;
    };
  }, [api, query]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h2">
          Coverage
        </Text>
        <Text variant="secondary">
          Which dates and locations each source has data for, so a slow day can be told from missing data.
        </Text>
      </header>
      <form
        aria-label="Coverage filter"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setLoad({ state: "loading" });
          setQuery({ ...draft });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="From"
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <Input
            label="To"
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        {locations.length > 0 && (
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-1 font-medium">Locations (none chosen: all)</legend>
            {locations.map((locationId) => (
              <Checkbox
                key={locationId}
                label={`Location ${locationId}`}
                checked={draft.locationIds.includes(locationId)}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    locationIds: checked
                      ? [...draft.locationIds, locationId]
                      : draft.locationIds.filter((id) => id !== locationId),
                  })
                }
              />
            ))}
          </fieldset>
        )}
        <div>
          <Button type="submit" variant="secondary">
            Show coverage
          </Button>
        </div>
      </form>
      {load.state === "loading" && (
        <div className="flex justify-center p-12" role="status" aria-label="Loading coverage">
          <Loader size="lg" />
        </div>
      )}
      {load.state === "failed" && (
        <Banner variant="error" icon={<WarningCircle />} title="Coverage could not be loaded" description={load.message} />
      )}
      {load.state === "loaded" && <Coverage report={load.report} />}
      <RunsWithRejections api={api} />
      <LineageLookup api={api} />
    </div>
  );
};

const Coverage = ({ report }: { report: CoverageReport }) => {
  const sourceLabel = (sourceId: number) =>
    report.sources.find((source) => source.id === sourceId)?.label ?? `Source ${sourceId}`;
  return (
    <>
      <section aria-labelledby="coverage-sources-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="coverage-sources-heading">
          Sources
        </Text>
        {report.sources.length === 0 ? (
          <Text variant="secondary">No sources yet.</Text>
        ) : (
          <LayerCard className="overflow-x-auto p-0">
            <Table>
              <caption className="sr-only">Sources and their last successful run</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Last sync or import</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {report.sources.map((source) => (
                  <Table.Row key={source.id}>
                    <Table.Head>{source.label}</Table.Head>
                    <Table.Cell>{SOURCE_KIND_LABELS[source.kind]}</Table.Cell>
                    <Table.Cell>{SOURCE_STATUS_LABELS[source.status]}</Table.Cell>
                    <Table.Cell>{source.lastSuccessAt ? formatDateTime(source.lastSuccessAt) : "Never"}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </section>
      <section aria-labelledby="coverage-ranges-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="coverage-ranges-heading">
          Dates covered
        </Text>
        {report.ranges.length === 0 ? (
          <Text variant="secondary">No dates are covered in this range.</Text>
        ) : (
          <LayerCard className="overflow-x-auto p-0">
            <Table>
              <caption className="sr-only">Business dates covered per location and source</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Location</Table.Head>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>From</Table.Head>
                  <Table.Head>To</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {report.ranges.map((range) => (
                  <Table.Row key={`${range.locationId}-${range.sourceId}-${range.from}`}>
                    <Table.Head>Location {range.locationId}</Table.Head>
                    <Table.Cell>{sourceLabel(range.sourceId)}</Table.Cell>
                    <Table.Cell>{range.from}</Table.Cell>
                    <Table.Cell>{range.to}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </section>
      <section aria-labelledby="coverage-gaps-heading" className="flex flex-col gap-3">
        <Text variant="heading" as="h3" id="coverage-gaps-heading">
          Possible gaps
        </Text>
        {report.possibleGaps.length === 0 ? (
          <Text variant="secondary">No day looks like missing data.</Text>
        ) : (
          <>
            <Text variant="secondary">
              Days without orders at a location that usually trades on that day.
            </Text>
            <ul className="list-disc pl-5">
              {report.possibleGaps.map((gap) => (
                <li key={`${gap.locationId}-${gap.businessDate}`}>
                  Location {gap.locationId}: {weekday(gap.businessDate)} {gap.businessDate}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
};

export default CoveragePage;
