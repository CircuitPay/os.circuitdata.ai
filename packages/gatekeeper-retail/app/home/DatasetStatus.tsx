import { Banner, Empty, LayerCard, Meter, Table, Text } from "@cloudflare/kumo";
import { ChartBar, WarningCircle } from "@phosphor-icons/react";
import type { RetailOverview } from "../../src/app-api-types";
import { formatBytes } from "../format";
import { SOURCE_KIND_LABELS, SOURCE_STATUS_LABELS } from "../sourceLabels";

/**
 * The dataset's state below Home's summary: storage and its warning, sources an administrator must
 * reconnect, and every source with its business dates.
 */
const DatasetStatus = ({ overview }: { overview: RetailOverview }) => {
  const { storage, sources, failuresNeedingAdmin, canManage } = overview;
  return (
    <>
      {storage.warn && (
        <Banner
          variant="alert"
          icon={<WarningCircle />}
          title="The dataset is nearly full"
          description="It has used over 70% of its storage. An administrator should remove old sources before imports and syncs start to fail."
        />
      )}
      {failuresNeedingAdmin.map((failure) => (
        <Banner
          key={failure.sourceId}
          variant="error"
          icon={<WarningCircle />}
          title={`${failure.label} needs attention`}
          description={
            canManage
              ? (failure.message ?? "Reconnect it to resume syncing.")
              : "Ask an organization administrator to reconnect it."
          }
        />
      ))}
      <section aria-label="Sources" className="flex flex-col gap-3">
        <Text variant="heading" as="h2">
          Sources
        </Text>
        {sources.length === 0 ? (
          <Empty
            icon={<ChartBar size={48} />}
            title="No data yet"
            description="Sources appear here once sales are imported or a point-of-sale system is connected."
          />
        ) : (
          <LayerCard className="p-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Source</Table.Head>
                  <Table.Head>Kind</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Business dates</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {sources.map((source) => (
                  <Table.Row key={source.id}>
                    <Table.Cell>{source.label}</Table.Cell>
                    <Table.Cell>{SOURCE_KIND_LABELS[source.kind]}</Table.Cell>
                    <Table.Cell>{SOURCE_STATUS_LABELS[source.status]}</Table.Cell>
                    <Table.Cell>
                      {source.coverageFrom && source.coverageTo
                        ? `${source.coverageFrom} – ${source.coverageTo}`
                        : "None yet"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </section>
      <section aria-label="Storage" className="flex flex-col gap-3">
        <Text variant="heading" as="h2">
          Storage
        </Text>
        <Meter
          label="Dataset"
          value={(storage.usedBytes / storage.capBytes) * 100}
          customValue={`${formatBytes(storage.usedBytes)} of ${formatBytes(storage.capBytes)}`}
        />
        <Meter
          label="Original files and pages"
          value={(storage.rawUsedBytes / storage.rawQuotaBytes) * 100}
          customValue={`${formatBytes(storage.rawUsedBytes)} of ${formatBytes(storage.rawQuotaBytes)}`}
        />
      </section>
      {!canManage && (
        <Text variant="secondary">
          Organization administrators manage sources and settings.
        </Text>
      )}
    </>
  );
};

export default DatasetStatus;
