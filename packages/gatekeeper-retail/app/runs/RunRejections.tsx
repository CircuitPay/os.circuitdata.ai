import { Banner, Button, LayerCard, Loader, Table, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { RetailAppClient, RunRejection } from "../../src/app-api-types";
import { errorMessage } from "../format";

const PAGE_SIZE = 50;

type Rejections = {
  items: RunRejection[];
  nextAfter: number | null;
  loadingMore: boolean;
  error: string | null;
};

/** A run's rejected rows (FR-011), in row order, a page at a time. */
const RunRejections = ({
  api,
  runId,
}: {
  api: Pick<RetailAppClient, "listRejections">;
  runId: number;
}) => {
  const [rejections, setRejections] = useState<Rejections | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.listRejections(runId, { limit: PAGE_SIZE }).then(
      (page) => current && setRejections({ ...page, loadingMore: false, error: null }),
      (error: unknown) => current && setFailure(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [api, runId]);

  const loadMore = async (after: number) => {
    setRejections((state) => state && { ...state, loadingMore: true, error: null });
    try {
      const page = await api.listRejections(runId, { after, limit: PAGE_SIZE });
      setRejections((state) =>
        state && {
          items: [...state.items, ...page.items],
          nextAfter: page.nextAfter,
          loadingMore: false,
          error: null,
        },
      );
    } catch (error) {
      setRejections((state) => state && { ...state, loadingMore: false, error: errorMessage(error) });
    }
  };

  if (failure !== null) {
    return (
      <Banner
        variant="error"
        icon={<WarningCircle />}
        title="The rejected rows could not be loaded"
        description={failure}
      />
    );
  }
  if (rejections === null) {
    return (
      <div className="flex justify-center p-6" role="status" aria-label="Loading rejected rows">
        <Loader />
      </div>
    );
  }
  if (rejections.items.length === 0) return <Text variant="secondary">No rows were rejected.</Text>;
  const { nextAfter } = rejections;
  return (
    <div className="flex flex-col gap-3">
      <LayerCard className="overflow-x-auto p-0">
        <Table>
          <caption className="sr-only">Rejected rows of run {runId}</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>File</Table.Head>
              <Table.Head>Row</Table.Head>
              <Table.Head>Table</Table.Head>
              <Table.Head>Reason</Table.Head>
              <Table.Head>Column</Table.Head>
              <Table.Head>Detail</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rejections.items.map((rejection) => (
              <Table.Row key={rejection.id}>
                <Table.Cell>{rejection.file ?? "—"}</Table.Cell>
                <Table.Cell>{rejection.row ?? "—"}</Table.Cell>
                <Table.Cell>{rejection.table}</Table.Cell>
                <Table.Cell>{rejection.reason}</Table.Cell>
                <Table.Cell>{rejection.column ?? "—"}</Table.Cell>
                <Table.Cell>{rejection.detail ?? ""}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
      {rejections.error !== null && (
        <Banner
          variant="error"
          icon={<WarningCircle />}
          title="More rejected rows could not be loaded"
          description={rejections.error}
        />
      )}
      {nextAfter !== null && (
        <Button
          variant="secondary"
          className="self-start"
          loading={rejections.loadingMore}
          onClick={() => void loadMore(nextAfter)}
        >
          Show more rejected rows
        </Button>
      )}
    </div>
  );
};

export default RunRejections;
