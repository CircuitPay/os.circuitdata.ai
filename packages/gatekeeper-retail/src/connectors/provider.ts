// What every provider connector (Square, Stripe) implements, and the errors that steer the
// connection's state machine (data-model §7): 401/revoked/missing scope → needs_reconnect;
// 429, 5xx and network failures → retrying with backoff.

import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import type { IngestBatch } from "../dataset/ingest.js";

/** A provider whose data a `RetailConnection` syncs. */
export type ProviderKind = "square" | "stripe";

/** Provider responses are capped; a Square order page of 1000 orders stays well under this. */
export const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Per-request timeout of provider API calls. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Why a provider call failed, as the connection acts on it. */
export type ProviderFailure =
  /** The grant is gone or lacks a scope: an administrator must reconnect. */
  | "auth"
  /** Too many requests: back off, at least `retryAfterMs`. */
  | "rate_limited"
  /** 5xx, network, oversized or malformed response: retry with backoff. */
  | "transient";

/** A provider API failure. The message carries the provider label, status and code, never a body. */
export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number;

  constructor(provider: string, failure: ProviderFailure, status: number, code: string, retryAfterMs = 0) {
    super(`${provider} request failed: ${status === 0 ? "network error" : `HTTP ${status}`} (${code}).`);
    this.name = "ProviderError";
    this.failure = failure;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Classifies an HTTP status the way every connector does. */
export function failureFor(status: number): ProviderFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  return "transient";
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or 0. */
export function retryAfterMs(response: Response, now = Date.now()): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 3_600_000)) : 0;
}

/**
 * One JSON request to a provider API: capped response, timeout, no redirects, and every failure as
 * a `ProviderError`. Returns the parsed body and its raw text (kept as the raw record).
 */
export async function providerJson(
  provider: string,
  url: string,
  init: RequestInit,
  codeOf: (body: unknown) => string | undefined,
): Promise<{ body: Record<string, unknown>; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ProviderError(provider, "transient", 0, "network");
  }
  let text: string;
  try {
    text = await readTextCapped(response, MAX_PROVIDER_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new ProviderError(provider, "transient", response.status, "too_large");
    throw new ProviderError(provider, "transient", response.status, "network");
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Reported below for a success; an error status is classified by its status alone.
  }
  if (!response.ok) {
    const code = sanitizeCode(codeOf(body)) ?? `http_${response.status}`;
    throw new ProviderError(provider, failureFor(response.status), response.status, code, retryAfterMs(response));
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderError(provider, "transient", response.status, "malformed");
  }
  return { body: { ...body }, text };
}

/** Keeps provider error codes log-safe: short, plain identifiers only. */
function sanitizeCode(code: string | undefined): string | undefined {
  return code && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

/** A provider location the administrator may include. */
export type ProviderLocation = { id: string; name: string; timezone: string | null; currency: string | null; active: boolean };

/** What a completed OAuth code exchange yields; `creds` never leave the connection object. */
export type ExchangedGrant<Creds> = {
  creds: Creds;
  /** The provider account (Square merchant, Stripe account) the grant is for. */
  externalAccountId: string;
  externalAccountLabel: string;
};

/** A resource a connector syncs, in dependency order (references resolve against earlier ones). */
export type SyncResource =
  | "locations" | "products" | "customers" | "orders" | "payments" | "refunds" | "inventory"
  | "inventory_changes" | "invoices" | "checkout_sessions" | "payouts" | "fees" | "events";

/** Canonical tables whose already-ingested source ids a connector may ask about. */
export type KnownTable = "locations" | "customers" | "products" | "orders" | "transactions" | "line_items";

/**
 * One query over a resource. Backfill and the daily re-read use a creation window; incremental
 * reads use `updatedSince`. `page` is the provider's cursor within the query.
 */
export type ResourceQuery = {
  from?: string;
  to?: string;
  updatedSince?: string;
  page?: string | null;
};

/** The configuration a read runs under. */
export type ReadContext = {
  /** Provider location ids the administrator chose (all when empty). */
  locationIds: string[];
  now: number;
  /** Which of `ids` this source has already ingested into `table`. */
  known(table: KnownTable, ids: string[]): Promise<Set<string>>;
};

/** One fetched page: canonical records, the raw page text, and where to continue. */
export type FetchedPage = {
  batch: IngestBatch;
  raw: string;
  /** Records the provider returned on this page. */
  fetched: number;
  /** null when this resource's query is complete. */
  next: ResourceQuery | null;
  /** The newest update time on this page (ISO), the next incremental read's start. */
  high: string | null;
};

/** A webhook's "refetch object X". Bodies are triggers, never data. */
export type RefetchTarget = { type: string; id: string };

/** Provider-specific behaviour of a connection. */
export interface Connector<Creds> {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Resources read whole by a backfill (catalog, customers…), in dependency order. */
  readonly fullResources: readonly SyncResource[];
  /** Resources a backfill reads by creation window, newest first (orders, payments…). */
  readonly windowedResources: readonly SyncResource[];
  /** Resources each incremental pass reads by update time, in dependency order. */
  readonly incrementalResources: readonly SyncResource[];
  /** The provider's consent URL for a new flow. */
  authorizationUrl(state: string, redirectUri: string): string;
  /** Exchanges the callback's code and checks the granted scopes. Throws a user-safe message. */
  exchange(params: URLSearchParams, redirectUri: string): Promise<ExchangedGrant<Creds>>;
  /** When the stored grant must be refreshed (epoch ms), for `CredentialCoordinator`. */
  expiresAt(creds: Creds): number | undefined;
  /** How far ahead of `expiresAt` to refresh. */
  readonly refreshSkewMs: number;
  /** Mints fresh credentials; throws `CredentialsExpiredError` when the grant is dead. */
  refresh(creds: Creds): Promise<Creds>;
  /** Revokes the grant at the provider. Best effort; never throws for an already-dead grant. */
  revoke(creds: Creds): Promise<void>;
  /** Whether a grant this old needs an administrator although it still refreshes (Square: 8 days). */
  isStale(creds: Creds, now: number): boolean;
  listLocations(creds: Creds): Promise<ProviderLocation[]>;
  /** Reads one page. */
  fetchPage(creds: Creds, resource: SyncResource, query: ResourceQuery, context: ReadContext): Promise<FetchedPage>;
  /** Re-reads one object a webhook named. Returns null for an object type the connector ignores. */
  refetch(creds: Creds, target: RefetchTarget, context: ReadContext): Promise<FetchedPage | null>;
}

/** Splits `[from, to)` (ISO instants) into windows of `days`, newest first. */
export function windowsNewestFirst(from: string, to: string, days: number): { from: string; to: string }[] {
  const windows: { from: string; to: string }[] = [];
  const start = Date.parse(from);
  let end = Date.parse(to);
  const step = days * 86_400_000;
  while (end > start) {
    const begin = Math.max(start, end - step);
    windows.push({ from: new Date(begin).toISOString(), to: new Date(end).toISOString() });
    end = begin;
  }
  return windows;
}

/** Epoch seconds of an ISO 8601 instant, or null. */
export function epochSeconds(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The later of two ISO instants (either may be null). */
export function laterInstant(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
