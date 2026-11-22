// RetailGatekeeper: the ambient `RETAIL_DATA` binding, a facet of the workspace's overseer. It
// holds observer state and the workspace's pending mapping suggestions only; the data lives in
// the RetailDataset object.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { aclObservers, ObservationGate } from "@gadgets/gatekeeper-kit/observers";
import {
  boundAgentCatalog,
  type ActionKind, type AgentCatalog, type AgentCatalogEntry, type ApprovalQueue, type Gatekeeper,
  type GatekeeperUserVerifier, type GitCache, type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { datasetObjectName } from "./dataset/dataset-do.js";
import { METRIC_DEFINITIONS } from "./dataset/metrics.js";
import { PUBLIC_TABLES } from "./dataset/schema.js";
import type { MappingDocument } from "./app-api-types.js";
import { RetailDataSession, type MappingSuggestions, type RetailDataApi } from "./session.js";
import type { RetailAccountProps, RetailVerifierApi } from "./vendor.js";
import TYPES_CODE from "./types.txt";

@validateRpc()
export class RetailGatekeeper extends DurableObject<Cloudflare.Env, RetailAccountProps>
  implements Gatekeeper<RetailDataApi> {
  /**
   * Observer strategy B (research R6): the dataset is one ACL unit, and a collaborator is admitted
   * only when their own tenant's account holds the same dataset. The overseer passes a verifier of
   * this vendor only, and only from the collaborator's own tenant.
   */
  readonly #observers = aclObservers<Fetcher<RetailVerifierApi>>({
    hasAccess: verifier => verifier.hasDatasetAccess(this.ctx.props.datasetId),
    denyMessage: "This workspace reads an organization's retail data that you do not have access to.",
  });

  /** Describes the ambient binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "retail://dataset",
      title: "Retail data",
      snippet: "Your organization's sales, products, customers and inventory: read-only SQL and standard metrics.",
      suggestedBindingName: "RETAIL_DATA",
      tsType: "RetailData",
    };
  }

  /** The agent-facing declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** A suggested import mapping only drafts a mapping a member still previews and confirms. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [MAPPING_ACTION];
  }

  /** Opens a session whose reads and suggestions go through the workspace's approval queue. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RetailDataSession> {
    const { datasetId } = this.ctx.props;
    return new RetailDataSession({
      dataset: this.#dataset(),
      datasetId,
      observations: new ObservationGate(approvalQueue.dup(), this.#observers),
      suggestions: this.#suggestions(approvalQueue.dup()),
    });
  }

  /** Table and metric names and the pending import count; not an observation. */
  async getAgentCatalog(): Promise<AgentCatalog> {
    const { sharingDomain, datasetId } = this.ctx.props;
    const pending = await this.ctx.exports.RetailDataset
      .getByName(datasetObjectName(sharingDomain, datasetId)).pendingImportCount(datasetId);
    const entries: AgentCatalogEntry[] = [
      ...PUBLIC_TABLES.map(table => ({ id: `table:${table.name}`, title: table.name, description: table.description })),
      ...METRIC_DEFINITIONS.map(metric => ({ id: `metric:${metric.name}`, title: metric.name, description: metric.description })),
    ];
    if (pending > 0) {
      entries.unshift({
        id: "pending-imports",
        title: "CSV imports waiting for a mapping",
        description: `${pending} uploaded CSV import${pending === 1 ? " is" : "s are"} waiting for a column mapping.`,
      });
    }
    return boundAgentCatalog(entries);
  }

  /** Admits a collaborator whose tenant holds the same dataset. */
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    return this.#observers.addObserver(id, user);
  }

  /** No observer state is kept under strategy B. */
  removeObserver(id: string): Promise<void> {
    return this.#observers.removeObserver(id);
  }

  /**
   * Applies a suggested mapping: stores it as the import's draft, unless a newer suggestion for the
   * same import replaced it or the import is no longer waiting for a mapping.
   */
  async applyAction(action: number, _cache: RpcStub<GitCache>): Promise<void> {
    const kv = this.ctx.storage.kv;
    const suggestion = kv.get<PendingSuggestion>(`action:${action}`);
    if (!suggestion) return;
    const latestKey = `latest:${suggestion.importId}`;
    if (kv.get<number>(latestKey) === action) {
      try {
        await this.#dataset().setAgentMapping(this.ctx.props.datasetId, suggestion.importId, suggestion.mapping);
      } catch (error) {
        // The member imported or discarded it meanwhile: the suggestion has nothing left to draft.
        if (!(error instanceof Error && /no longer waiting|There is no import/.test(error.message))) throw error;
      }
      kv.delete(latestKey);
    }
    kv.delete(`action:${action}`);
  }

  /** Drops a rejected suggestion; the import keeps its earlier mapping. */
  async rejectAction(action: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    const suggestion = kv.get<PendingSuggestion>(`action:${action}`);
    if (!suggestion) return;
    const latestKey = `latest:${suggestion.importId}`;
    if (kv.get<number>(latestKey) === action) kv.delete(latestKey);
    kv.delete(`action:${action}`);
  }

  /** Suggestions are submitted with `implementsRevert: false`. */
  revertAction(_action: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("A suggested mapping cannot be reverted; choose another mapping in the Data area.");
  }

  #dataset() {
    const { sharingDomain, datasetId } = this.ctx.props;
    return this.ctx.exports.RetailDataset.getByName(datasetObjectName(sharingDomain, datasetId));
  }

  /**
   * Suggestions of this workspace: each is an action in the approval queue, simulated by
   * overlaying the latest pending one per import on `pendingImports()` until it is applied.
   */
  #suggestions(queue: RpcStub<ApprovalQueue>): MappingSuggestions {
    const kv = this.ctx.storage.kv;
    return {
      pending: () => [...kv.list<number>({ prefix: "latest:" })]
        .map(([, action]) => kv.get<PendingSuggestion>(`action:${action}`))
        .filter((suggestion): suggestion is PendingSuggestion => suggestion !== undefined),
      submit: async (importId, mapping) => {
        const action = (kv.get<number>("nextAction") ?? 0) + 1;
        const latestKey = `latest:${importId}`;
        const previous = kv.get<number>(latestKey);
        kv.put("nextAction", action);
        kv.put(`action:${action}`, { importId, mapping } satisfies PendingSuggestion);
        kv.put(latestKey, action);
        try {
          await queue.submitAction(action, {
            title: `Suggest a mapping for import ${importId}`,
            description: `Stores a suggested column mapping as a draft on pending CSV import ${importId}, ` +
              "replacing any earlier suggestion. Nothing is imported until a member previews the mapping " +
              "and confirms it in the Data area.",
            fields: [
              { label: "Import", kind: "inline", value: String(importId) },
              { label: "Mapping", kind: "json", value: JSON.stringify(mapping, null, 2) },
            ],
            descriptionIsComplete: true,
            implementsRevert: false,
            autoApprovable: true,
            actionKind: MAPPING_ACTION,
          });
        } catch (error) {
          kv.delete(`action:${action}`);
          if (previous === undefined) kv.delete(latestKey);
          else kv.put(latestKey, previous);
          throw error;
        }
      },
    };
  }
}

/** A suggested import mapping waiting in the approval queue. */
type PendingSuggestion = { importId: number; mapping: MappingDocument };

/** The one action kind: drafting a mapping on a pending import (research R7). */
const MAPPING_ACTION: ActionKind = { tag: "proposeImportMapping", label: "Suggested CSV import mappings" };
