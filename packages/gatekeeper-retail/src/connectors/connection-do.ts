// RetailConnection: one SQLite Durable Object per provider connection (research R15), named
// `<sharingDomain>\0conn\0<connectionId>`. It holds the grant (kit `CredentialCoordinator`; the
// credentials never reach the dataset object or the binding, FR-021), the connect flow's state and
// nonce, the staged grant and its handoff ticket (research R19), per-resource checkpoints, status
// and backoff, and the webhook de-duplication window. One alarm drives everything through the
// planner: backfill, the 15-minute incremental pass, the daily 3-day re-read, token refresh, webhook
// refetches, stage expiry and teardown.

import { DurableObject } from "cloudflare:workers";
import {
  CredentialCoordinator, isCredentialsExpired, type RefreshCredentials,
} from "@gadgets/gatekeeper-kit/credentials";
import {
  commitStagedCredentials, discardStagedCredentials, stageCredentials,
} from "@gadgets/gatekeeper-kit/credential-stage";
import {
  OAUTH_NONCE_LIFETIME_MS, constantTimeEqual, generateNonce, isLiveNonce, type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { connectHandoffPageHtml, errorPageHtml } from "@gadgets/gatekeeper-kit/connect-pages";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { reportIssue } from "@gadgets/observability/error-reporting";
import type { SourceStatus } from "../app-api-types.js";
import { datasetObjectName, type RetailDataset } from "../dataset/dataset-do.js";
import type { IngestBatch } from "../dataset/ingest.js";
import { retailLogger } from "../observability.js";
import { BATCH_SIZE, Planner, type WorkItem } from "./planner.js";
import {
  ProviderError, laterInstant, windowsNewestFirst,
  type Connector, type FetchedPage, type ProviderKind, type ProviderLocation, type ReadContext,
  type RefetchTarget, type ResourceQuery, type SyncResource,
} from "./provider.js";
import { SquareConnector, squareConfig, type SquareCreds } from "./square.js";
import { StripeConnector, stripeConfig, type StripeCreds } from "./stripe.js";
import { routeObjectName } from "./webhook-route-do.js";

const logger = retailLogger("connection");

/** How long a started connect flow, and then its staged grant and ticket, stay usable. */
export const CONNECT_FLOW_LIFETIME_MS = OAUTH_NONCE_LIFETIME_MS;
/** The incremental pass interval, and its overlap with the previous pass (research R13). */
export const SYNC_INTERVAL_MS = 15 * 60_000;
export const SYNC_OVERLAP_MS = 10 * 60_000;
/** The daily re-read of the last 3 days. */
export const REREAD_INTERVAL_MS = 86_400_000;
export const REREAD_DAYS = 3;
/** Backfill: the newest 30 days first (SC-001), then older windows of 90 days. */
export const FIRST_WINDOW_DAYS = 30;
export const WINDOW_DAYS = 90;
/** Webhook event ids are remembered this long. */
export const EVENT_DEDUPE_MS = 86_400_000;
/** Pages read per work item before yielding to the next alarm. */
const PAGES_PER_STEP = 5;

/** The DO name of a connection. */
export function connectionObjectName(sharingDomain: string, connectionId: string): string {
  return `${sharingDomain}\0conn\0${connectionId}`;
}

/**
 * The OAuth `state`: the sharing domain (base64url), the connection id and the flow's secret, so
 * the stateless callback route can address the connection that holds the flow. Only the secret is
 * checked; a forged prefix addresses an object holding no matching flow.
 */
export function encodeState(sharingDomain: string, connectionId: string, secret: string): string {
  const domain = btoa(sharingDomain).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${domain}.${connectionId}.${secret}`;
}

export function decodeState(state: string): { sharingDomain: string; connectionId: string; secret: string } | null {
  const [domain, connectionId, secret, ...rest] = state.split(".");
  if (!domain || !connectionId || !secret || rest.length) return null;
  if (!/^[0-9a-f-]{36}$/.test(connectionId) || !/^[0-9a-f]{64}$/.test(secret)) return null;
  try {
    return { sharingDomain: atob(domain.replaceAll("-", "+").replaceAll("_", "/")), connectionId, secret };
  } catch {
    return null;
  }
}

/** SHA-256 of a secret, hex: what is stored in place of tickets and nonces. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type Creds = SquareCreds | StripeCreds;

/** Builds the connector of a provider from the deployment's configuration. */
export function connectorFor(provider: ProviderKind, env: Cloudflare.Env): Connector<Creds> {
  return (provider === "square"
    ? new SquareConnector(squareConfig(env))
    : new StripeConnector(stripeConfig(env))) as Connector<Creds>;
}

/** What the connection knows about itself. */
type Meta = {
  sharingDomain: string;
  datasetId: string;
  connectionId: string;
  provider: ProviderKind;
  createdBy: string;
  sourceId: number | null;
  status: SourceStatus;
  externalAccountId: string | null;
  externalAccountLabel: string | null;
  /** Provider location ids to read; null until the administrator chose. */
  locationIds: string[] | null;
  /** Set once disconnect started; nothing but teardown runs after it. */
  tearingDown?: { deleteData: boolean };
};

/** A started flow: the OAuth state secret, and the popup nonce's hash. */
type Flow = TimedNonce & { nonceHash: string; reconnect: boolean };

/** A completed callback waiting for redemption. */
type Handoff = {
  ticketHash: string;
  nonceHash: string;
  stageId: string;
  expiresAt: number;
  externalAccountId: string;
  externalAccountLabel: string;
  reconnect: boolean;
};

type Staged = { creds: Creds };

/** Work the planner runs. */
type Work =
  | { kind: "backfill" }
  | { kind: "sync" }
  | { kind: "reread" }
  | { kind: "refresh" }
  | { kind: "refetch"; target: RefetchTarget }
  | { kind: "stage-expiry"; stageId: string }
  | { kind: "flow-expiry" }
  | { kind: "housekeeping" }
  | { kind: "teardown" };

/** Where a multi-resource read stands. */
type Pass = {
  runId: number | null;
  /** Each step: a resource and a query; done steps are dropped from the front. */
  steps: { resource: SyncResource; query: ResourceQuery }[];
  total: number;
  done: number;
  startedAt: number;
};

const META_KEY = "meta";
const FLOW_KEY = "flow";
const HANDOFF_KEY = "handoff";
const PASS_PREFIX = "pass:";
const HIGH_PREFIX = "high:";
const EVENT_PREFIX = "event:";
/** Kept through teardown until the last step, so the object still knows what it is cleaning. */
const TEARDOWN_KEEP: ReadonlySet<string> = new Set([META_KEY]);

/** The error a refused redemption throws; the Workshop's handoff page shows it verbatim. */
const REFUSED = "This connection could not be completed. Start it again from the Data area.";

/** The connection Durable Object. */
export class RetailConnection extends DurableObject<Cloudflare.Env> {
  readonly #planner = new Planner<Work>(this.ctx.storage);
  /**
   * Alarm steps and the administrator's changes to what they read run one at a time: a step awaits
   * provider and dataset calls, and an interleaved change would race its read-modify-write of the
   * pass state.
   */
  readonly #serial = new SerialTaskQueue();

  /**
   * The grant's coordinator, with the provider's refresh policy. No `discardMint`: Square refresh
   * tokens do not rotate and Stripe's rotate under the coordinator's mutex, so a fenced-out mint
   * shares its grant with the survivor, and revoking it would kill the connection that won.
   */
  get #credentials(): CredentialCoordinator<Creds> {
    const connector = this.#connector();
    return new CredentialCoordinator<Creds>(this.ctx.storage.kv, {
      expiresAt: creds => connector.expiresAt(creds),
      refreshSkewMs: connector.refreshSkewMs,
      vendorId: "retail",
    });
  }

  // --- The connect flow (research R19) ---

  /**
   * Starts a connect (or a reconnect of this connection): returns the provider's consent URL and
   * the popup nonce the Workshop writes into the popup. Only the nonce's hash is kept.
   */
  async begin(init: {
    sharingDomain: string; datasetId: string; connectionId: string; provider: ProviderKind; createdBy: string;
    redirectUri: string;
  }): Promise<{ url: string; nonce: string }> {
    const kv = this.ctx.storage.kv;
    let meta = this.#metaOrNull();
    if (meta) {
      if (meta.datasetId !== init.datasetId || meta.provider !== init.provider) throw new Error("This connection belongs elsewhere.");
      if (meta.tearingDown) throw new Error("This connection is being disconnected.");
    } else {
      meta = {
        sharingDomain: init.sharingDomain, datasetId: init.datasetId, connectionId: init.connectionId,
        provider: init.provider, createdBy: init.createdBy, sourceId: null, status: "connecting",
        externalAccountId: null, externalAccountLabel: null, locationIds: null,
      };
      kv.put(META_KEY, meta);
    }
    const connector = this.#connector(meta);
    const secret = generateNonce();
    const nonce = generateNonce();
    const now = Date.now();
    kv.put<Flow>(FLOW_KEY, {
      value: secret, expiresAt: now + CONNECT_FLOW_LIFETIME_MS, nonceHash: await sha256Hex(nonce),
      reconnect: meta.sourceId !== null,
    });
    if (meta.sourceId === null) this.#planner.schedule("flow-expiry", { kind: "flow-expiry" }, now + 2 * CONNECT_FLOW_LIFETIME_MS);
    await this.#planner.plan();
    const url = connector.authorizationUrl(encodeState(meta.sharingDomain, meta.connectionId, secret), init.redirectUri);
    return { url, nonce };
  }

  /**
   * The OAuth callback: checks the flow's state (live, single use), exchanges the code, checks the
   * granted scopes, and stages the grant behind a fresh ticket. Returns the page to serve: the
   * handoff page, or a plain error page with nothing staged.
   */
  async callback(query: string, redirectUri: string, targetOrigin: string): Promise<{ status: number; html: string }> {
    const params = new URLSearchParams(query);
    const meta = this.#metaOrNull();
    const flow = this.ctx.storage.kv.get<Flow>(FLOW_KEY);
    const secret = decodeState(params.get("state") ?? "")?.secret ?? "";
    if (!meta || meta.tearingDown || !flow || !isLiveNonce(flow, secret, Date.now())) {
      logger.info("oauth callback refused", { event: "oauth.callback.refused", refusalReason: "state" });
      return { status: 400, html: errorPageHtml("This link has expired", "Start the connection again from the Data area.") };
    }
    // Single use: consumed before the exchange, whatever happens next.
    this.ctx.storage.kv.delete(FLOW_KEY);
    const connector = this.#connector(meta);
    let grant;
    try {
      grant = await connector.exchange(params, redirectUri);
    } catch (error) {
      logger.info("oauth callback refused", {
        event: "oauth.callback.refused", datasetId: meta.datasetId, refusalReason: "exchange",
      });
      const detail = error instanceof Error && !(error instanceof ProviderError) ? error.message : `${connector.label} refused the connection.`;
      return { status: 400, html: errorPageHtml("Could not connect", detail) };
    }
    // A reconnect must stay on the same provider account: data of two accounts never merge.
    if (meta.externalAccountId !== null && grant.externalAccountId !== meta.externalAccountId) {
      await connector.revoke(grant.creds).catch(() => undefined);
      logger.info("oauth callback refused", {
        event: "oauth.callback.refused", datasetId: meta.datasetId, refusalReason: "other_account",
      });
      return {
        status: 400,
        html: errorPageHtml("Different account", `Reconnect with the same ${connector.label} account this source was connected to.`),
      };
    }
    const now = Date.now();
    // Replacing an earlier stage: dispose of it after the new one is in place.
    const previous = discardStagedCredentials<Staged>(this.ctx.storage.kv);
    const stageId = stageCredentials<Staged>(this.ctx.storage.kv, { creds: grant.creds }, now, CONNECT_FLOW_LIFETIME_MS);
    const ticket = generateNonce();
    const handoff: Handoff = {
      ticketHash: await sha256Hex(ticket), nonceHash: flow.nonceHash, stageId, expiresAt: now + CONNECT_FLOW_LIFETIME_MS,
      externalAccountId: grant.externalAccountId, externalAccountLabel: grant.externalAccountLabel, reconnect: flow.reconnect,
    };
    this.ctx.storage.kv.put(HANDOFF_KEY, handoff);
    if (previous) await connector.revoke(previous.creds).catch(() => undefined);
    await this.#dataset(meta).registerConnectTicket(meta.datasetId, handoff.ticketHash, meta.connectionId, handoff.expiresAt);
    this.#planner.schedule(`stage-expiry:${stageId}`, { kind: "stage-expiry", stageId }, handoff.expiresAt);
    await this.#planner.plan();
    logger.info("oauth callback staged", { event: "oauth.callback.staged", datasetId: meta.datasetId });
    return { status: 200, html: connectHandoffPageHtml({ ticket, targetOrigin }) };
  }

  /**
   * Redeems a handoff (research R19): the ticket and the popup nonce must both match this flow,
   * unexpired and single use, and the caller's dataset must be this connection's. Only then is the
   * staged grant committed. A refused redemption revokes the staged grant.
   */
  redeem(datasetId: string, ticket: string, nonce: string, memberId: string): Promise<{ sourceId: number }> {
    return this.#serial.run(() => this.#redeem(datasetId, ticket, nonce, memberId));
  }

  async #redeem(datasetId: string, ticket: string, nonce: string, memberId: string): Promise<{ sourceId: number }> {
    const meta = this.#metaOrNull();
    const handoff = this.ctx.storage.kv.get<Handoff>(HANDOFF_KEY);
    if (!meta || !handoff || meta.datasetId !== datasetId) throw new Error(REFUSED);
    const [ticketHash, nonceHash] = await Promise.all([sha256Hex(ticket), sha256Hex(nonce)]);
    // Single use, whatever the outcome.
    this.ctx.storage.kv.delete(HANDOFF_KEY);
    this.#planner.remove(`stage-expiry:${handoff.stageId}`);
    const live = Date.now() < handoff.expiresAt
      && constantTimeEqual(handoff.ticketHash, ticketHash) && constantTimeEqual(handoff.nonceHash, nonceHash);
    const staged = live ? commitStagedCredentials<Staged>(this.ctx.storage.kv, Date.now(), handoff.stageId) : null;
    if (!staged) {
      const dropped = discardStagedCredentials<Staged>(this.ctx.storage.kv, handoff.stageId);
      if (dropped) await this.#connector(meta).revoke(dropped.creds).catch(() => undefined);
      await this.#planner.plan();
      logger.info("connect handoff refused", { event: "oauth.handoff.refused", datasetId, refusalReason: "ticket" });
      throw new Error(REFUSED);
    }
    this.#credentials.connect(staged.creds);
    const dataset = this.#dataset(meta);
    let sourceId = meta.sourceId;
    if (sourceId === null) {
      sourceId = await dataset.createConnectedSource(datasetId, {
        kind: meta.provider, label: handoff.externalAccountLabel, createdBy: memberId,
        connectionName: connectionObjectName(meta.sharingDomain, meta.connectionId),
        externalAccountLabel: handoff.externalAccountLabel,
      });
      this.#planner.remove("flow-expiry");
    }
    this.#putMeta({
      ...meta, sourceId, externalAccountId: handoff.externalAccountId, externalAccountLabel: handoff.externalAccountLabel,
    });
    await this.#route(meta.provider, handoff.externalAccountId).add(connectionObjectName(meta.sharingDomain, meta.connectionId));
    const now = Date.now();
    this.#planner.schedule("refresh", { kind: "refresh" }, this.#refreshDue(staged.creds));
    this.#planner.scheduleIfAbsent("housekeeping", { kind: "housekeeping" }, now + EVENT_DEDUPE_MS);
    if (meta.locationIds !== null) {
      // A reconnect resumes where the connection stood.
      this.#planner.schedule("sync", { kind: "sync" }, now);
      if (this.ctx.storage.kv.get(`${PASS_PREFIX}backfill`)) this.#planner.schedule("backfill", { kind: "backfill" }, now);
      await this.#setStatus(this.ctx.storage.kv.get(`${PASS_PREFIX}backfill`) ? "backfilling" : "syncing");
    }
    await this.#planner.plan();
    logger.info("connect handoff redeemed", { event: "oauth.handoff.redeemed", datasetId, sourceId });
    return { sourceId };
  }

  // --- Administration (RetailAppApi; the caller checked canManage) ---

  /** The provider account's locations, for the administrator to choose from. */
  async listLocations(datasetId: string): Promise<ProviderLocation[]> {
    const meta = this.#requireMeta(datasetId);
    return this.#withCreds(meta, creds => this.#connector(meta).listLocations(creds));
  }

  /** Sets the locations to read and starts (or restarts) the backfill over them. */
  chooseLocations(datasetId: string, locationIds: string[]): Promise<void> {
    return this.#serial.run(() => this.#chooseLocations(datasetId, locationIds));
  }

  async #chooseLocations(datasetId: string, locationIds: string[]): Promise<void> {
    const meta = this.#requireMeta(datasetId);
    const available = new Set((await this.listLocations(datasetId)).map(location => location.id));
    const chosen = [...new Set(locationIds)];
    if (chosen.length === 0) throw new Error("Choose at least one location.");
    const unknown = chosen.filter(id => !available.has(id));
    if (unknown.length) throw new Error("Some of those locations are not in this account.");
    this.#putMeta({ ...meta, locationIds: chosen });
    const years = await this.#dataset(meta).backfillYears(datasetId);
    const now = Date.now();
    const connector = this.#connector(meta);
    const to = new Date(now).toISOString();
    const recent = new Date(now - FIRST_WINDOW_DAYS * 86_400_000).toISOString();
    const oldest = new Date(now - years * 365 * 86_400_000).toISOString();
    const windows = [{ from: recent, to }, ...windowsNewestFirst(oldest, recent, WINDOW_DAYS)];
    const steps: Pass["steps"] = [
      ...connector.fullResources.map(resource => ({ resource, query: {} })),
      ...windows.flatMap(window => connector.windowedResources.map(resource => ({ resource, query: { ...window } }))),
    ];
    const previous = this.ctx.storage.kv.get<Pass>(`${PASS_PREFIX}backfill`);
    if (previous?.runId) await this.#finishRun(previous.runId, "cancelled");
    this.ctx.storage.kv.put<Pass>(`${PASS_PREFIX}backfill`, { runId: null, steps, total: steps.length, done: 0, startedAt: now });
    // Incremental reads start where the backfill started.
    for (const resource of connector.incrementalResources) {
      if (this.ctx.storage.kv.get(`${HIGH_PREFIX}${resource}`) === undefined) {
        this.ctx.storage.kv.put(`${HIGH_PREFIX}${resource}`, to);
      }
    }
    this.#planner.schedule("backfill", { kind: "backfill" }, now);
    this.#planner.schedule("sync", { kind: "sync" }, now + SYNC_INTERVAL_MS);
    this.#planner.schedule("reread", { kind: "reread" }, now + REREAD_INTERVAL_MS);
    await this.#setStatus("backfilling");
    await this.#planner.plan();
  }

  /** Queues an incremental pass now. */
  syncNow(datasetId: string): Promise<void> {
    return this.#serial.run(() => this.#syncNow(datasetId));
  }

  async #syncNow(datasetId: string): Promise<void> {
    const meta = this.#requireMeta(datasetId);
    if (meta.locationIds === null) throw new Error("Choose the locations to include first.");
    if (meta.status === "needs_reconnect") throw new Error("Reconnect this source first.");
    this.#planner.schedule("sync", { kind: "sync" }, Date.now());
    await this.#planner.plan();
  }

  /**
   * Disconnects: stops sync, revokes the provider grant and forgets it. With `deleteData`, the
   * source's rows, raw objects and affected rollups are deleted in alarm-driven batches.
   */
  disconnect(datasetId: string, deleteData: boolean): Promise<void> {
    return this.#serial.run(() => this.#teardown(this.#requireMeta(datasetId), deleteData));
  }

  /** Erasure (FR-022): the same as a disconnect, from the account's revoke. */
  revokeForErasure(datasetId: string): Promise<void> {
    return this.#serial.run(async () => {
      const meta = this.#metaOrNull();
      if (meta?.datasetId === datasetId) await this.#teardown(meta, false);
    });
  }

  // --- Webhooks ---

  /**
   * Queues a refetch of the objects an event named (never trusting its body as data). Events are
   * de-duplicated by id for 24 hours. Returns whether anything was queued.
   */
  async queueRefetch(eventId: string, targets: RefetchTarget[]): Promise<boolean> {
    const meta = this.#metaOrNull();
    if (!meta || meta.tearingDown || meta.locationIds === null || meta.status === "needs_reconnect") return false;
    const kv = this.ctx.storage.kv;
    const key = `${EVENT_PREFIX}${eventId}`;
    const now = Date.now();
    if (kv.get<number>(key) !== undefined) return false;
    kv.put(key, now + EVENT_DEDUPE_MS);
    for (const target of targets.slice(0, 20)) {
      // Square's catalog and inventory events name no object: the incremental pass reads them.
      if (target.id === "") this.#planner.schedule("sync", { kind: "sync" }, now);
      else this.#planner.schedule(`refetch:${target.type}:${target.id}`, { kind: "refetch", target }, now);
    }
    await this.#planner.plan();
    return true;
  }

  // --- The alarm ---

  override alarm(): Promise<void> {
    return this.#serial.run(() => this.#alarm());
  }

  async #alarm(): Promise<void> {
    const now = Date.now();
    await this.#planner.armWatchdog(now);
    const meta = this.#metaOrNull();
    if (!meta) {
      await this.#planner.teardownStep(new Set());
      return;
    }
    if (meta.tearingDown) {
      await this.#teardownStep(meta);
      return;
    }
    for (const item of this.#planner.due(now, BATCH_SIZE)) {
      if (this.#metaOrNull()?.tearingDown) break;
      await this.#run(item);
    }
    if (this.#metaOrNull()?.tearingDown) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    await this.#planner.plan();
  }

  /** Runs one item, turning provider failures into status and backoff. */
  async #run(item: WorkItem<Work>): Promise<void> {
    const work = item.payload;
    try {
      switch (work.kind) {
        case "backfill": return await this.#pass(item, "backfill");
        case "sync": return await this.#pass(item, "sync");
        case "reread": return await this.#pass(item, "reread");
        case "refetch": return await this.#refetch(item, work.target);
        case "refresh": return await this.#refresh(item);
        case "stage-expiry": return await this.#expireStage(item, work.stageId);
        case "flow-expiry": return await this.#expireFlow(item);
        case "housekeeping": return this.#housekeeping(item);
        case "teardown": return;
      }
    } catch (error) {
      await this.#failed(item, error);
    }
  }

  /**
   * One step of a multi-resource read: up to a few pages, each kept raw in R2 and ingested as one
   * idempotent batch. Backfill keeps its pass across alarms; sync and re-read build theirs fresh.
   */
  async #pass(item: WorkItem<Work>, kind: "backfill" | "sync" | "reread"): Promise<void> {
    const meta = this.#requireMeta();
    if (meta.locationIds === null || meta.sourceId === null) {
      this.#planner.remove(item.key);
      return;
    }
    const kv = this.ctx.storage.kv;
    const connector = this.#connector(meta);
    const now = Date.now();
    const passKey = `${PASS_PREFIX}${kind}`;
    let pass = kv.get<Pass>(passKey);
    if (!pass) {
      if (kind === "backfill") {
        this.#planner.remove(item.key);
        return;
      }
      const steps: Pass["steps"] = kind === "sync"
        ? connector.incrementalResources.map(resource => {
          const high = kv.get<string>(`${HIGH_PREFIX}${resource}`);
          return {
            resource,
            query: high ? { updatedSince: new Date(Date.parse(high) - SYNC_OVERLAP_MS).toISOString() } : {},
          };
        })
        : connector.windowedResources.map(resource => ({
          resource,
          query: { from: new Date(now - REREAD_DAYS * 86_400_000).toISOString(), to: new Date(now).toISOString() },
        }));
      pass = { runId: null, steps, total: steps.length, done: 0, startedAt: now };
      kv.put(passKey, pass);
    }
    const sourceId = meta.sourceId;
    if (kind !== "backfill" && meta.status !== "backfilling") await this.#setStatus("syncing");
    const context = this.#readContext(meta, sourceId);
    let pages = 0;
    await this.#withCreds(meta, async creds => {
      while (pass!.steps.length > 0 && pages < PAGES_PER_STEP) {
        const step = pass!.steps[0]!;
        const page = await connector.fetchPage(creds, step.resource, step.query, context);
        pages++;
        pass!.runId ??= await this.#startRun(meta, kind === "backfill" ? "backfill" : "sync");
        await this.#ingest(meta, pass!.runId, page);
        if (kind === "sync" && page.high) {
          const highKey = `${HIGH_PREFIX}${step.resource}`;
          kv.put(highKey, laterInstant(kv.get<string>(highKey), page.high)!);
        }
        if (page.next) {
          step.query = page.next;
        } else {
          pass!.steps.shift();
          pass!.done++;
        }
        kv.put(passKey, pass);
        await this.#progress(pass!, kind);
      }
    });
    if (pass.steps.length > 0) {
      this.#planner.update(item, item.payload, Date.now());
      return;
    }
    // The pass is complete.
    kv.delete(passKey);
    if (pass.runId !== null) await this.#finishRun(pass.runId, "succeeded");
    logger.info("sync completed", {
      event: "sync.completed", datasetId: meta.datasetId, sourceId, runId: pass.runId ?? undefined,
      operation: kind, durationMs: Date.now() - pass.startedAt,
    });
    if (kind === "backfill") this.#planner.remove(item.key);
    else this.#planner.update(item, item.payload, Date.now() + (kind === "sync" ? SYNC_INTERVAL_MS : REREAD_INTERVAL_MS));
    await this.#setStatus(kv.get(`${PASS_PREFIX}backfill`) ? "backfilling" : "active");
  }

  async #refetch(item: WorkItem<Work>, target: RefetchTarget): Promise<void> {
    const meta = this.#requireMeta();
    if (meta.sourceId === null || meta.locationIds === null) {
      this.#planner.remove(item.key);
      return;
    }
    const connector = this.#connector(meta);
    const context = this.#readContext(meta, meta.sourceId);
    await this.#withCreds(meta, async creds => {
      const page = await connector.refetch(creds, target, context);
      if (page && page.fetched > 0) {
        const runId = await this.#startRun(meta, "sync");
        await this.#ingest(meta, runId, page);
        await this.#finishRun(runId, "succeeded");
      }
    });
    this.#planner.remove(item.key);
  }

  /** Refreshes the grant when due (Square: every 7 days); a stale grant needs an administrator. */
  async #refresh(item: WorkItem<Work>): Promise<void> {
    const meta = this.#requireMeta();
    const connector = this.#connector(meta);
    const creds = await this.#credentials.fresh(this.#refresher());
    if (connector.isStale(creds, Date.now())) {
      await this.#needsReconnect("token_stale", `The ${connector.label} grant could not be refreshed for 8 days.`);
      return;
    }
    this.#planner.update(item, item.payload, this.#refreshDue(creds));
  }

  async #expireStage(item: WorkItem<Work>, stageId: string): Promise<void> {
    this.#planner.remove(item.key);
    const meta = this.#metaOrNull();
    const handoff = this.ctx.storage.kv.get<Handoff>(HANDOFF_KEY);
    if (handoff?.stageId === stageId) this.ctx.storage.kv.delete(HANDOFF_KEY);
    const dropped = discardStagedCredentials<Staged>(this.ctx.storage.kv, stageId);
    if (dropped && meta) await this.#connector(meta).revoke(dropped.creds).catch(() => undefined);
  }

  /** A connect that never completed leaves nothing behind. */
  async #expireFlow(item: WorkItem<Work>): Promise<void> {
    this.#planner.remove(item.key);
    const meta = this.#metaOrNull();
    if (meta && meta.sourceId === null && !this.ctx.storage.kv.get(HANDOFF_KEY)) {
      this.#putMeta({ ...meta, tearingDown: { deleteData: false } });
    }
  }

  #housekeeping(item: WorkItem<Work>): void {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    for (const [key, expiresAt] of kv.list<number>({ prefix: EVENT_PREFIX })) {
      if (expiresAt <= now) kv.delete(key);
    }
    this.#planner.update(item, item.payload, now + EVENT_DEDUPE_MS);
  }

  /**
   * Classifies a failure: a dead or under-scoped grant needs an administrator; a 429 backs off at
   * least as long as the provider asked; anything else retries with capped backoff.
   */
  async #failed(item: WorkItem<Work>, error: unknown): Promise<void> {
    const meta = this.#metaOrNull();
    const datasetId = meta?.datasetId;
    const sourceId = meta?.sourceId ?? undefined;
    if (isCredentialsExpired(error) || (error instanceof ProviderError && error.failure === "auth")) {
      const label = meta ? this.#connector(meta).label : "The provider";
      await this.#needsReconnect(
        error instanceof ProviderError ? error.code : "grant_revoked",
        `${label} no longer accepts this connection's access. Reconnect it.`,
      );
      logger.warn("sync failed", { event: "sync.failed", datasetId, sourceId, refusalReason: "auth" });
      return;
    }
    const retryAfter = error instanceof ProviderError ? error.retryAfterMs : 0;
    const delay = this.#planner.fail(item, Date.now(), retryAfter);
    if (error instanceof ProviderError && error.failure === "rate_limited") {
      logger.info("sync rate limited", { event: "sync.rate_limited", datasetId, sourceId, durationMs: delay });
    } else {
      logger.warn("sync failed", { event: "sync.failed", datasetId, sourceId, error });
      if (item.attempts + 1 >= 4) reportIssue("retail.sync", error, { attributes: { datasetId, sourceId } });
    }
    if (meta?.sourceId != null && (item.payload.kind === "backfill" || item.payload.kind === "sync" || item.payload.kind === "reread")) {
      await this.#setStatus("retrying");
    }
  }

  /** Stops reads until an administrator reconnects. Refresh stays scheduled for the reconnect. */
  async #needsReconnect(code: string, message: string): Promise<void> {
    for (const work of this.#planner.list()) {
      if (work.payload.kind === "sync" || work.payload.kind === "reread" || work.payload.kind === "refetch"
        || work.payload.kind === "backfill" || work.payload.kind === "refresh") {
        this.#planner.remove(work.key);
      }
    }
    await this.#setStatus("needs_reconnect", { code, message });
  }

  /** Runs `use` with fresh credentials; a 401 mid-call is adjudicated once (refresh or death). */
  async #withCreds<T>(meta: Meta, use: (creds: Creds) => Promise<T>): Promise<T> {
    const refresh = this.#refresher();
    const creds = await this.#credentials.fresh(refresh);
    const identity = this.#credentials.identity();
    try {
      return await use(creds);
    } catch (error) {
      if (!(error instanceof ProviderError && error.failure === "auth" && error.status === 401)) throw error;
      const verdict = await this.#credentials.adjudicateRejection(identity, { refresh, notify: async () => {} });
      if (verdict !== "superseded") throw error;
      return use(await this.#credentials.fresh(refresh));
    }
  }

  #refresher(): RefreshCredentials<Creds> {
    return creds => this.#connector().refresh(creds);
  }

  #refreshDue(creds: Creds): number {
    const connector = this.#connector();
    const expiresAt = connector.expiresAt(creds);
    return expiresAt === undefined ? Date.now() + 86_400_000 : Math.max(Date.now(), expiresAt - connector.refreshSkewMs);
  }

  #readContext(meta: Meta, sourceId: number): ReadContext {
    const dataset = this.#dataset(meta);
    return {
      locationIds: meta.locationIds ?? [],
      now: Date.now(),
      known: async (table, ids) => ids.length === 0
        ? new Set()
        : new Set(await dataset.knownSourceRecords(meta.datasetId, sourceId, table, ids)),
    };
  }

  /** Keeps the page raw in R2, then ingests it as one batch. */
  async #ingest(meta: Meta, runId: number, page: FetchedPage): Promise<void> {
    const dataset = this.#dataset(meta);
    // A page that only navigates (e.g. seeking to the oldest Stripe events page) carries no records.
    if (page.raw) {
      const bytes = new TextEncoder().encode(page.raw);
      await dataset.putRawObject(meta.datasetId, { sourceId: meta.sourceId!, runId, kind: "provider_page" },
        new Blob([bytes]).stream(), bytes.byteLength);
    }
    if (hasRecords(page.batch)) await dataset.ingestBatch(meta.datasetId, runId, page.batch);
  }

  async #startRun(meta: Meta, kind: "backfill" | "sync"): Promise<number> {
    const runId = await this.#dataset(meta).startRun(meta.datasetId, {
      sourceId: meta.sourceId!, kind, mappingVersion: `${meta.provider}-v1`, startedBy: null,
    });
    logger.info("sync started", { event: "sync.started", datasetId: meta.datasetId, sourceId: meta.sourceId!, runId, operation: kind });
    return runId;
  }

  async #finishRun(runId: number, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
    const meta = this.#requireMeta();
    await this.#dataset(meta).finishRun(meta.datasetId, runId, status).catch(error => {
      // A run the dataset already closed (an erased dataset, a cancel) has nothing left to finish.
      logger.warn("finishing a run failed", { event: "sync.finish_failed", datasetId: meta.datasetId, runId, error });
    });
  }

  async #progress(pass: Pass, phase: string): Promise<void> {
    if (pass.runId === null) return;
    const meta = this.#requireMeta();
    const elapsed = (Date.now() - pass.startedAt) / 1000;
    const etaSeconds = pass.done > 0 ? Math.round(elapsed / pass.done * (pass.total - pass.done)) : null;
    await this.#dataset(meta).updateRunProgress(meta.datasetId, pass.runId,
      { phase, done: pass.done, total: pass.total, etaSeconds }, pass.steps[0] ?? null);
  }

  async #setStatus(status: SourceStatus, error: { code: string; message: string } | null = null): Promise<void> {
    const meta = this.#requireMeta();
    if (meta.status === status && !error) return;
    this.#putMeta({ ...meta, status });
    if (meta.sourceId !== null) await this.#dataset(meta).setSourceStatus(meta.datasetId, meta.sourceId, status, error);
  }

  // --- Teardown ---

  async #teardown(meta: Meta, deleteData: boolean): Promise<void> {
    if (!meta.tearingDown) {
      this.#putMeta({ ...meta, tearingDown: { deleteData } });
      for (const work of this.#planner.list()) this.#planner.remove(work.key);
      this.ctx.storage.kv.delete(FLOW_KEY);
      this.ctx.storage.kv.delete(HANDOFF_KEY);
      const connector = this.#connector(meta);
      const staged = discardStagedCredentials<Staged>(this.ctx.storage.kv);
      const live = this.#credentials.stored();
      this.#credentials.clear();
      for (const creds of [staged?.creds, live]) {
        if (creds) await connector.revoke(creds).catch(error => logger.warn("provider revoke failed", { event: "connection.revoke_failed", error }));
      }
      if (meta.externalAccountId) {
        await this.#route(meta.provider, meta.externalAccountId).remove(connectionObjectName(meta.sharingDomain, meta.connectionId));
      }
      const pass = this.ctx.storage.kv.get<Pass>(`${PASS_PREFIX}backfill`);
      if (pass?.runId) await this.#finishRun(pass.runId, "cancelled");
      if (meta.sourceId !== null) {
        await this.#dataset(meta).setSourceStatus(meta.datasetId, meta.sourceId, "disconnected").catch(() => undefined);
      }
      logger.info("connection disconnected", { event: "connection.disconnected", datasetId: meta.datasetId, sourceId: meta.sourceId ?? undefined });
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** One teardown alarm: a batch of the source's data (when deleting), then of this object's storage. */
  async #teardownStep(meta: Meta): Promise<void> {
    if (meta.tearingDown?.deleteData && meta.sourceId !== null) {
      const { done } = await this.#dataset(meta).deleteSourceDataBatch(meta.datasetId, meta.sourceId);
      if (!done) {
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }
      this.#putMeta({ ...meta, tearingDown: { deleteData: false } });
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    if (await this.#planner.teardownStep(TEARDOWN_KEEP)) {
      await this.ctx.storage.deleteAll();
    }
  }

  // --- Plumbing ---

  #metaOrNull(): Meta | null {
    return this.ctx.storage.kv.get<Meta>(META_KEY) ?? null;
  }

  #requireMeta(datasetId?: string): Meta {
    const meta = this.#metaOrNull();
    if (!meta || (datasetId !== undefined && meta.datasetId !== datasetId)) throw new Error("No such connection.");
    if (meta.tearingDown) throw new Error("This connection was disconnected.");
    return meta;
  }

  #putMeta(meta: Meta): void {
    this.ctx.storage.kv.put(META_KEY, meta);
  }

  #connector(meta: Meta | null = this.#metaOrNull()): Connector<Creds> {
    if (!meta) throw new Error("No such connection.");
    return connectorFor(meta.provider, this.env);
  }

  #dataset(meta: Meta): DurableObjectStub<RetailDataset> {
    return this.ctx.exports.RetailDataset.getByName(datasetObjectName(meta.sharingDomain, meta.datasetId));
  }

  #route(provider: ProviderKind, externalAccountId: string) {
    return this.ctx.exports.RetailWebhookRoute.getByName(routeObjectName(provider, externalAccountId));
  }
}

function hasRecords(batch: IngestBatch): boolean {
  return Object.values(batch).some(records => Array.isArray(records) && records.length > 0);
}
