import { Badge, Banner, Button, Checkbox, Empty, LayerCard, Loader, Table, Text } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { MatchBasis, MatchKind, MatchProposal, RetailAppClient } from "../../src/app-api-types";
import { errorMessage } from "../format";

type MatchApi = Pick<RetailAppClient, "listMatchProposals" | "confirmMatch" | "rejectMatch" | "undoMatch">;

const TITLES: Record<MatchKind, string> = { customer: "Customers", product: "Products" };
const BASIS_LABELS: Record<MatchBasis, string> = { email: "Same email", sku: "Same SKU", name: "Same name only" };

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; proposals: MatchProposal[] };

/**
 * Proposed and confirmed matches of one kind. Email and SKU proposals start ticked, name-only ones
 * unticked; ticked proposals are linked with one action, and a confirmed link can be undone.
 */
const MatchReview = ({ api, kind }: { api: MatchApi; kind: MatchKind }) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  // Ticks the administrator changed; the rest follow each proposal's default.
  const [ticks, setTicks] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.listMatchProposals({ kind }).then(
      (proposals) => current && setLoad({ state: "loaded", proposals }),
      (thrown: unknown) => current && setLoad({ state: "failed", message: errorMessage(thrown) }),
    );
    return () => {
      current = false;
    };
  }, [api, kind, generation]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (thrown) {
      setError(errorMessage(thrown));
    } finally {
      setBusy(false);
      setTicks(new Map());
      setGeneration((value) => value + 1);
    }
  };

  const title = TITLES[kind];
  if (load.state === "loading") {
    return (
      <div className="flex justify-center p-6" role="status" aria-label={`Loading ${title.toLowerCase()} matches`}>
        <Loader />
      </div>
    );
  }
  if (load.state === "failed") {
    return <Banner variant="error" icon={<WarningCircle />} title={`${title} matches could not be loaded`} description={load.message} />;
  }

  const ticked = (proposal: MatchProposal) => ticks.get(proposal.id) ?? proposal.preselected;
  const selected = load.proposals.filter((proposal) => proposal.status === "proposed" && ticked(proposal));

  return (
    <section aria-label={`${title} matches`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Text variant="heading" as="h3">
          {title}
        </Text>
        <Button
          variant="primary"
          loading={busy}
          disabled={selected.length === 0}
          onClick={() => void act(async () => {
            for (const proposal of selected) await api.confirmMatch(proposal.id);
          })}
        >
          {`Link ${selected.length} selected`}
        </Button>
      </div>
      {error !== null && <Banner variant="error" icon={<WarningCircle />} title="That did not work" description={error} />}
      {load.proposals.length === 0 ? (
        <Empty title={`No ${title.toLowerCase()} to match`} description="Matches appear when two sources hold the same record." />
      ) : (
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Link</Table.Head>
                <Table.Head>Record</Table.Head>
                <Table.Head>Same as</Table.Head>
                <Table.Head>Why</Table.Head>
                <Table.Head>Action</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {load.proposals.map((proposal) => {
                const description = `${proposal.row.label} (${proposal.row.source}) and ${proposal.canonical.label} (${proposal.canonical.source})`;
                return (
                  <Table.Row key={proposal.id}>
                    <Table.Cell>
                      {proposal.status === "confirmed" ? (
                        <Badge variant="neutral">Linked</Badge>
                      ) : (
                        <Checkbox
                          label={`Link ${description}`}
                          checked={ticked(proposal)}
                          disabled={busy}
                          onCheckedChange={(checked) => setTicks((previous) => new Map(previous).set(proposal.id, checked === true))}
                        />
                      )}
                    </Table.Cell>
                    <Table.Cell>{`${proposal.row.label} · ${proposal.row.source}`}</Table.Cell>
                    <Table.Cell>{`${proposal.canonical.label} · ${proposal.canonical.source}`}</Table.Cell>
                    <Table.Cell>{BASIS_LABELS[proposal.basis]}</Table.Cell>
                    <Table.Cell>
                      {proposal.status === "confirmed" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          aria-label={`Undo link of ${description}`}
                          onClick={() => void act(() => api.undoMatch(proposal.id))}
                        >
                          Undo
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          aria-label={`Not the same: ${description}`}
                          onClick={() => void act(() => api.rejectMatch(proposal.id))}
                        >
                          Not the same
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </section>
  );
};

export default MatchReview;
