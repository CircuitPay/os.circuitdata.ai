// The Data area's `ui` capability (contracts/data-area-api.md). The member's rights are re-read
// through the kernel's `TenantAccess` at the start of every method; nothing is cached.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { TenantAccess, TenantFileDelivery } from "@gadgets/workshop-shared/gatekeeper";
import type {
  ConnectFlow, CoverageReport, ImportListEntry, ImportPreview, ImportTarget, LineageTable, MappingDocument, MatchKind,
  MatchProposal, Page, ProviderKind, ProviderLocationInfo, RetailAppClient, RetailOverview, RowLineage, RunRejection,
  RunSummary, StagedImport, TemplateDetail, TemplateSummary,
} from "./app-api-types.js";
import { ERASE_CONFIRMATION } from "./app-api-types.js";
import { connectionObjectName, sha256Hex, type RetailConnection } from "./connectors/connection-do.js";
import type { RetailDataset } from "./dataset/dataset-do.js";

/** What the Data area capability is minted with. */
export type RetailAppDeps = {
  dataset: DurableObjectStub<RetailDataset>;
  datasetId: string;
  /** Owned by the capability and released with it. */
  access: RpcStub<TenantAccess>;
  /** The signed-in member's opaque id within the tenant, for attribution only. */
  memberId: string;
  /** Provider connections, by DO name (connectors/connection-do.ts). */
  connections: DurableObjectNamespace<RetailConnection>;
  sharingDomain: string;
  /** `$PUBLIC_BASE_URL/gatekeeper/retail`, for the providers' redirect URIs. */
  baseUrl: string;
  /** Providers whose app credentials this deployment has; only these can be connected. */
  providers: readonly ProviderKind[];
};

/** The refusal every administrator-only method gives a member (contracts/data-area-api.md). */
function refuse(action: string): never {
  throw new Error(`Only organization administrators can ${action}.`);
}

@validateRpc()
export class RetailAppApi extends RpcTarget implements RetailAppClient {
  readonly #dataset: DurableObjectStub<RetailDataset>;
  readonly #datasetId: string;
  readonly #access: RpcStub<TenantAccess>;
  readonly #memberId: string;
  readonly #connections: DurableObjectNamespace<RetailConnection>;
  readonly #sharingDomain: string;
  readonly #baseUrl: string;
  readonly #providers: readonly ProviderKind[];

  constructor(deps: RetailAppDeps) {
    super();
    this.#dataset = deps.dataset;
    this.#datasetId = deps.datasetId;
    this.#access = deps.access;
    this.#memberId = deps.memberId;
    this.#connections = deps.connections;
    this.#sharingDomain = deps.sharingDomain;
    this.#baseUrl = deps.baseUrl;
    this.#providers = deps.providers;
  }

  /** Sources, storage, settings and failures, with the member's live rights. */
  async getOverview(): Promise<RetailOverview> {
    const { canManage } = await this.#access.current();
    const overview = await this.#dataset.overview(this.#datasetId);
    return { ...overview, canManage, connectableProviders: [...this.#providers] };
  }

  // --- Runs, imports, templates, coverage and lineage (members; own imports or administrators) ---

  async listRuns(options?: { sourceId?: number; after?: number; limit?: number }): Promise<Page<RunSummary>> {
    return this.#dataset.listRuns(this.#datasetId, options, await this.#member());
  }

  async getRun(id: number): Promise<RunSummary> {
    return this.#dataset.getRun(this.#datasetId, id, await this.#member());
  }

  async listRejections(runId: number, options?: { after?: number; limit?: number }): Promise<Page<RunRejection>> {
    await this.#member();
    return this.#dataset.listRejections(this.#datasetId, runId, options);
  }

  async getCoverage(options?: { from?: string; to?: string; locationIds?: number[] }): Promise<CoverageReport> {
    await this.#member();
    return this.#dataset.coverage(this.#datasetId, options);
  }

  async getLineage(table: LineageTable, id: number): Promise<RowLineage> {
    await this.#member();
    return this.#dataset.lineage(this.#datasetId, table, id);
  }

  /**
   * Called by the Workshop host, not the iframe, with the files the member picked: each stream is
   * copied into the raw store before this returns. Refused for more than 10 files, a file over
   * the limit, or a full raw quota.
   */
  async receiveTenantFiles(target: ImportTarget, files: TenantFileDelivery[]): Promise<{ importId: number }> {
    const member = await this.#member();
    return this.#dataset.stageImport(this.#datasetId, target, files, member);
  }

  async listImports(): Promise<ImportListEntry[]> {
    await this.#member();
    return this.#dataset.listImports(this.#datasetId);
  }

  async getImport(id: number): Promise<StagedImport> {
    await this.#member();
    return this.#dataset.getImport(this.#datasetId, id);
  }

  async discardImport(id: number): Promise<void> {
    await this.#dataset.discardImport(this.#datasetId, id, await this.#member());
  }

  async askAgentPrompt(id: number): Promise<string> {
    await this.#member();
    return this.#dataset.askAgentPrompt(this.#datasetId, id);
  }

  async preview(id: number, mapping: MappingDocument): Promise<ImportPreview> {
    await this.#member();
    return this.#dataset.previewImport(this.#datasetId, id, mapping);
  }

  async startImport(
    id: number,
    mapping: MappingDocument,
    options?: { saveAsTemplate?: { name: string } | { templateId: number } },
  ): Promise<{ runId: number }> {
    return this.#dataset.startImport(this.#datasetId, id, mapping, options, await this.#member());
  }

  async cancelRun(runId: number): Promise<void> {
    await this.#dataset.cancelRun(this.#datasetId, runId, await this.#member());
  }

  async undoImport(runId: number): Promise<{ undoRunId: number }> {
    return this.#dataset.undoImport(this.#datasetId, runId, await this.#member());
  }

  async listTemplates(): Promise<TemplateSummary[]> {
    await this.#member();
    return this.#dataset.listTemplates(this.#datasetId);
  }

  async getTemplate(id: number): Promise<TemplateDetail> {
    await this.#member();
    return this.#dataset.getTemplate(this.#datasetId, id);
  }

  async saveTemplateVersion(id: number, mapping: MappingDocument): Promise<{ versionId: number }> {
    return this.#dataset.saveTemplateVersion(this.#datasetId, id, mapping, await this.#member());
  }

  async copyTemplate(id: number, name: string): Promise<{ templateId: number }> {
    return this.#dataset.copyTemplate(this.#datasetId, id, name, await this.#member());
  }

  async deleteTemplate(id: number): Promise<void> {
    await this.#member();
    await this.#dataset.deleteTemplate(this.#datasetId, id);
  }

  async reapplyTemplate(templateId: number, options?: { versionId?: number }): Promise<{ runIds: number[] }> {
    return this.#dataset.reapplyTemplate(this.#datasetId, templateId, options?.versionId, await this.#member());
  }

  /** The member and their live rights, re-read on every call. */
  async #member(): Promise<{ memberId: string; canManage: boolean }> {
    const { canManage } = await this.#access.current();
    return { memberId: this.#memberId, canManage };
  }

  // --- Connections (administrators only; research R19) ---

  /** Starts a provider connection: the consent URL and the popup nonce for `openConnectPopup`. */
  async beginConnect(provider: ProviderKind): Promise<ConnectFlow> {
    if (!(await this.#access.current()).canManage) refuse("connect a provider");
    if (!this.#providers.includes(provider)) throw new Error("This provider is not configured on this deployment.");
    const connectionId = crypto.randomUUID();
    return this.#connections.getByName(connectionObjectName(this.#sharingDomain, connectionId)).begin({
      sharingDomain: this.#sharingDomain, datasetId: this.#datasetId, connectionId, provider,
      createdBy: this.#memberId, redirectUri: `${this.#baseUrl}/oauth/${provider}`,
    });
  }

  /**
   * Redeems a connect handoff over the popup's own session. The ticket must have been minted for a
   * flow of this dataset (else it is unknown here: a phished handoff), and the nonce must match
   * that same flow; the connection then commits the staged grant, or revokes it.
   */
  async redeemConnectHandoff(ticket: string, nonce: string): Promise<{ sourceId: number }> {
    if (!(await this.#access.current()).canManage) refuse("connect a provider");
    if (!/^[0-9a-f]{64}$/.test(ticket) || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error("This connection link is not valid.");
    const connectionId = await this.#dataset.takeConnectTicket(this.#datasetId, await sha256Hex(ticket));
    if (!connectionId) {
      throw new Error("This connection was not started from this organization's Data area. Start it again there.");
    }
    return this.#connections.getByName(connectionObjectName(this.#sharingDomain, connectionId))
      .redeem(this.#datasetId, ticket, nonce, this.#memberId);
  }

  async listProviderLocations(sourceId: number): Promise<ProviderLocationInfo[]> {
    if (!(await this.#access.current()).canManage) refuse("choose locations");
    return (await this.#connection(sourceId)).listLocations(this.#datasetId);
  }

  async chooseLocations(sourceId: number, locationIds: string[]): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("choose locations");
    await (await this.#connection(sourceId)).chooseLocations(this.#datasetId, locationIds);
  }

  async setBackfillYears(years: number): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("change the backfill depth");
    await this.#dataset.setBackfillYears(this.#datasetId, years);
  }

  async syncNow(sourceId: number): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("sync a source");
    await (await this.#connection(sourceId)).syncNow(this.#datasetId);
  }

  async reconnect(sourceId: number): Promise<ConnectFlow> {
    if (!(await this.#access.current()).canManage) refuse("reconnect a provider");
    const source = await this.#dataset.sourceConnection(this.#datasetId, sourceId);
    if (!source?.connectionName || (source.kind !== "square" && source.kind !== "stripe")) throw new Error("No such connection.");
    if (source.status === "disconnected") throw new Error("This source was disconnected; connect the provider again.");
    const connectionId = source.connectionName.split("\0")[2]!;
    return this.#connections.getByName(source.connectionName).begin({
      sharingDomain: this.#sharingDomain, datasetId: this.#datasetId, connectionId, provider: source.kind,
      createdBy: this.#memberId, redirectUri: `${this.#baseUrl}/oauth/${source.kind}`,
    });
  }

  async disconnect(sourceId: number, options: { deleteData: boolean }): Promise<void> {
    const { canManage } = await this.#access.current();
    if (!canManage) refuse(options.deleteData ? "delete a source's data" : "disconnect a provider");
    await (await this.#connection(sourceId)).disconnect(this.#datasetId, options.deleteData === true);
  }

  // --- Settings, erasure and matching (administrators only) ---

  async setPersonalDataUnmasked(on: boolean): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("change who sees personal data");
    await this.#dataset.setPersonalDataUnmasked(this.#datasetId, on === true, this.#memberId);
  }

  /** Revokes every provider grant, then erases the dataset; the account stays, empty (FR-022). */
  async eraseDataset(options: { confirm: string }): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("erase the dataset");
    if (options.confirm !== ERASE_CONFIRMATION) throw new Error(`Type "${ERASE_CONFIRMATION}" to erase the dataset.`);
    for (const name of await this.#dataset.connectionNames(this.#datasetId)) {
      await this.#connections.getByName(name).revokeForErasure(this.#datasetId);
    }
    await this.#dataset.erase(this.#datasetId);
  }

  async listMatchProposals(options: { kind: MatchKind }): Promise<MatchProposal[]> {
    if (!(await this.#access.current()).canManage) refuse("review matches");
    return this.#dataset.listMatchProposals(this.#datasetId, options.kind);
  }

  async confirmMatch(id: number): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("confirm matches");
    await this.#dataset.confirmMatch(this.#datasetId, id, this.#memberId);
  }

  async rejectMatch(id: number): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("reject matches");
    await this.#dataset.rejectMatch(this.#datasetId, id, this.#memberId);
  }

  async undoMatch(id: number): Promise<void> {
    if (!(await this.#access.current()).canManage) refuse("undo matches");
    await this.#dataset.undoMatch(this.#datasetId, id, this.#memberId);
  }

  /** The connection behind a provider source of this dataset. */
  async #connection(sourceId: number): Promise<DurableObjectStub<RetailConnection>> {
    const source = await this.#dataset.sourceConnection(this.#datasetId, sourceId);
    if (!source?.connectionName || source.status === "disconnected") throw new Error("No such connection.");
    return this.#connections.getByName(source.connectionName);
  }

  [Symbol.dispose](): void {
    this.#access[Symbol.dispose]();
  }
}
