// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind
// the Durable Objects, and adds a host Durable Object that drives the gatekeeper facet the way the
// overseer does (a `DurableObjectClass` carrying props is reachable only through `ctx.facets`).

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, AgentCatalog, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { RetailGatekeeper } from "../src/gatekeeper.js";
import type { RetailDataSession } from "../src/session.js";
import type { RetailMapping, RetailMetricName, RetailMetricQuery, RetailTable } from "../src/types.js";
import type { RetailAccountProps } from "../src/vendor.js";

export { default } from "../src/index.js";
// Named from their defining modules: the pool's ctx.exports analyzer does not follow the barrel.
export { RetailDataset } from "../src/dataset/dataset-do.js";
export { RetailConnection } from "../src/connectors/connection-do.js";
export { RetailWebhookRoute } from "../src/connectors/webhook-route-do.js";
export { RetailGatekeeper } from "../src/gatekeeper.js";
export { GatekeeperVendor, RetailAccount, RetailVerifier } from "../src/vendor.js";

type TestExports = {
  RetailGatekeeper(options: { props: RetailAccountProps }): DurableObjectClass<RetailGatekeeper>;
  RetailVerifier(options: { props: RetailAccountProps }): Fetcher<GatekeeperUserVerifier>;
};

/** Records every observation and action the session submits, as the overseer's approval queue would. */
class RecordingQueue extends RpcTarget {
  constructor(
    private readonly observations: ObservationDescription[],
    private readonly actions: { action: number; description: ActionDescription }[],
  ) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.actions.push({ action, description });
  }
}

/** Hosts gatekeeper facets for the tests. */
export class TestHost extends DurableObject<Cloudflare.Env> {
  readonly #observations: ObservationDescription[] = [];
  readonly #actions: { action: number; description: ActionDescription }[] = [];

  #gatekeeper(props: RetailAccountProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<RetailGatekeeper>(`retail-${props.datasetId}`, () => ({
      class: exports.RetailGatekeeper({ props }),
    }));
  }

  #session(props: RetailAccountProps): Promise<RetailDataSession> {
    // `startSession` releases its argument when it returns; the session keeps its own duplicate.
    using queue = new RpcStub(new RecordingQueue(this.#observations, this.#actions));
    return this.#gatekeeper(props).startSession(queue as never) as Promise<RetailDataSession>;
  }

  async describeData(props: RetailAccountProps) {
    using session = await this.#session(props);
    return session.describe();
  }

  async run(
    props: RetailAccountProps,
    sql: string,
    params?: (string | number | boolean | null)[],
    options?: { maxRows?: number; maxBytes?: number },
  ) {
    using session = await this.#session(props);
    return session.run(sql, params, options);
  }

  async metric(props: RetailAccountProps, name: RetailMetricName, query: RetailMetricQuery) {
    using session = await this.#session(props);
    return session.metric(name, query);
  }

  async catalog(props: RetailAccountProps): Promise<AgentCatalog> {
    return this.#gatekeeper(props).getAgentCatalog();
  }

  async coverage(props: RetailAccountProps, options?: { from?: string; to?: string; locationIds?: number[] }) {
    using session = await this.#session(props);
    return session.coverage(options);
  }

  async lineage(props: RetailAccountProps, table: RetailTable, id: number) {
    using session = await this.#session(props);
    return session.lineage(table, id);
  }

  async pendingImports(props: RetailAccountProps) {
    using session = await this.#session(props);
    return session.pendingImports();
  }

  /** Returns the refusal message, or null when the suggestion was submitted. */
  async proposeImportMapping(props: RetailAccountProps, importId: number, mapping: RetailMapping): Promise<string | null> {
    using session = await this.#session(props);
    try {
      await session.proposeImportMapping(importId, mapping);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async autoApprovable(props: RetailAccountProps) {
    return this.#gatekeeper(props).getAutoApprovableActions();
  }

  async applyAction(props: RetailAccountProps, action: number): Promise<void> {
    // Mapping suggestions read nothing from the git cache; any stub satisfies the signature.
    using cache = new RpcStub(new RpcTarget());
    await this.#gatekeeper(props).applyAction(action, cache as never);
  }

  async rejectAction(props: RetailAccountProps, action: number): Promise<void> {
    await this.#gatekeeper(props).rejectAction(action);
  }

  /** The actions submitted so far, oldest first. */
  actions(): { action: number; description: ActionDescription }[] {
    return [...this.#actions];
  }

  /**
   * Admits a collaborator whose own account is `collaborator` to the facet bound to `props`.
   * Returns the refusal message, or null when admitted.
   */
  async addObserver(props: RetailAccountProps, collaborator: RetailAccountProps): Promise<string | null> {
    const exports = this.ctx.exports as unknown as TestExports;
    try {
      await this.#gatekeeper(props).addObserver("observer-1", exports.RetailVerifier({ props: collaborator }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The observations authorized so far, oldest first. */
  observations(): ObservationDescription[] {
    return [...this.#observations];
  }
}
