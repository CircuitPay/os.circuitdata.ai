// The gatekeeper's HTTP routes (contracts/http-routes.md). The router forwards
// `/gatekeeper/retail/*` here; `BASE_URL` is `$PUBLIC_BASE_URL/gatekeeper/retail`. OAuth callbacks
// are answered by the connection that holds the flow; webhook signatures are verified over the raw
// body before anything parses it, and an event only queues refetches.

import { readBytesCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { constantTimeEqual } from "@gadgets/gatekeeper-kit/connect-nonce";
import { errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { retailLogger } from "../observability.js";
import { connectionObjectName, decodeState } from "./connection-do.js";
import type { ProviderKind, RefetchTarget } from "./provider.js";
import { STRIPE_EVENT_OBJECTS } from "./stripe.js";
import { routeObjectName } from "./webhook-route-do.js";

const logger = retailLogger("http");

/** Webhook bodies are capped at 1 MiB. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** Stripe signatures older than this are refused (replay window). */
export const STRIPE_TOLERANCE_SECONDS = 300;

/** The worker's public base URL, without a trailing slash. */
export function baseUrl(env: Cloudflare.Env): string {
  return (env.BASE_URL || "http://localhost:8787/gatekeeper/retail").replace(/\/+$/, "");
}

/** Serves one request. */
export async function handleRequest(request: Request, env: Cloudflare.Env, exports: Cloudflare.Exports): Promise<Response> {
  const base = baseUrl(env);
  const basePath = new URL(base).pathname.replace(/\/$/, "");
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${basePath}/`)) return notFound();
  const route = url.pathname.slice(basePath.length);
  const provider: ProviderKind | null = route.endsWith("/square") ? "square" : route.endsWith("/stripe") ? "stripe" : null;
  if (provider && route === `/oauth/${provider}` && request.method === "GET") {
    return oauthCallback(url, provider, base, exports);
  }
  if (provider && route === `/webhooks/${provider}` && request.method === "POST") {
    return provider === "square"
      ? squareWebhook(request, env, `${base}/webhooks/square`, exports)
      : stripeWebhook(request, env, exports);
  }
  return notFound();
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

async function oauthCallback(url: URL, provider: ProviderKind, base: string, exports: Cloudflare.Exports): Promise<Response> {
  const state = decodeState(url.searchParams.get("state") ?? "");
  if (!state) {
    logger.info("oauth callback refused", { event: "oauth.callback.refused", refusalReason: "state" });
    return htmlResponse(errorPageHtml("This link has expired", "Start the connection again from the Data area."), 400);
  }
  const connection = exports.RetailConnection.getByName(connectionObjectName(state.sharingDomain, state.connectionId));
  const { status, html } = await connection.callback(url.search.slice(1), `${base}/oauth/${provider}`, new URL(base).origin);
  return htmlResponse(html, status);
}

/** The raw body, capped; null when it is too large. */
async function rawBody(request: Request): Promise<Uint8Array | null> {
  try {
    return await readBytesCapped(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return null;
    throw error;
  }
}

async function hmac(secret: string, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Square: HMAC-SHA-256 of the notification URL followed by the raw body, base64, against
 * `x-square-hmacsha256-signature`, compared in constant time.
 */
export async function verifySquareSignature(
  signatureKey: string, notificationUrl: string, body: Uint8Array, signature: string,
): Promise<boolean> {
  const mac = await hmac(signatureKey, concat(new TextEncoder().encode(notificationUrl), body));
  return constantTimeEqual(btoa(String.fromCharCode(...mac)), signature);
}

/**
 * Stripe: `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=…]`, an HMAC-SHA-256 of `<t>.<raw body>`;
 * any `v1` may match, and `t` must be within the tolerance.
 */
export async function verifyStripeSignature(
  secret: string, body: Uint8Array, header: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = header.split(",").map(part => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > STRIPE_TOLERANCE_SECONDS) return false;
  const mac = await hmac(secret, concat(new TextEncoder().encode(`${timestamp}.`), body));
  const expected = Array.from(mac, byte => byte.toString(16).padStart(2, "0")).join("");
  let matched = false;
  for (const signature of signatures) matched = constantTimeEqual(expected, signature) || matched;
  return matched;
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

/** Square object types a connection refetches by id; catalog and inventory events re-read incrementally. */
const SQUARE_OBJECTS: Readonly<Record<string, string>> = {
  order: "order", payment: "payment", refund: "refund", customer: "customer",
};

async function squareWebhook(request: Request, env: Cloudflare.Env, notificationUrl: string, exports: Cloudflare.Exports): Promise<Response> {
  const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const signature = request.headers.get("x-square-hmacsha256-signature");
  const body = await rawBody(request);
  if (body === null) return new Response("Payload too large", { status: 413 });
  if (!key || !signature || !await verifySquareSignature(key, notificationUrl, body, signature)) {
    logger.info("webhook rejected", { event: "webhook.rejected_signature", operation: "square" });
    return new Response("Unauthorized", { status: 401 });
  }
  const event = parseJson(body);
  const merchantId = field(event, "merchant_id");
  const eventId = field(event, "event_id");
  const eventType = field(event, "type");
  const data = field(event, "data");
  if (typeof merchantId !== "string" || typeof eventId !== "string" || typeof eventType !== "string") {
    return new Response("Bad request", { status: 400 });
  }
  const dataType = field(data, "type");
  const dataId = field(data, "id");
  let target: RefetchTarget | null = null;
  if (typeof dataType === "string" && SQUARE_OBJECTS[dataType] && typeof dataId === "string" && dataId) {
    target = { type: SQUARE_OBJECTS[dataType], id: dataId };
  } else if (eventType.startsWith("catalog.") || eventType.startsWith("inventory.") || eventType.startsWith("location.")) {
    target = { type: eventType.split(".")[0]!, id: "" };
  }
  return dispatch(exports, "square", merchantId, eventId, target);
}

async function stripeWebhook(request: Request, env: Cloudflare.Env, exports: Cloudflare.Exports): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");
  const body = await rawBody(request);
  if (body === null) return new Response("Payload too large", { status: 413 });
  if (!secret || !signature || !await verifyStripeSignature(secret, body, signature)) {
    logger.info("webhook rejected", { event: "webhook.rejected_signature", operation: "stripe" });
    return new Response("Unauthorized", { status: 401 });
  }
  const event = parseJson(body);
  const account = field(event, "account");
  const eventId = field(event, "id");
  const object = field(field(event, "data"), "object");
  if (typeof eventId !== "string") return new Response("Bad request", { status: 400 });
  // Events of the platform itself (no `account`) concern no connection.
  if (typeof account !== "string") return new Response("OK", { status: 200 });
  const kind = field(object, "object");
  const id = field(object, "id");
  const type = typeof kind === "string" ? STRIPE_EVENT_OBJECTS[kind] : undefined;
  const target = type && typeof id === "string" && id ? { type, id } : null;
  return dispatch(exports, "stripe", account, eventId, target);
}

async function dispatch(
  exports: Cloudflare.Exports, provider: ProviderKind, accountId: string, eventId: string, target: RefetchTarget | null,
): Promise<Response> {
  if (!target) return new Response("OK", { status: 200 });
  const queued = await exports.RetailWebhookRoute.getByName(routeObjectName(provider, accountId)).dispatch(eventId, [target]);
  logger.info(queued > 0 ? "webhook accepted" : "webhook unrouted", {
    event: queued > 0 ? "webhook.accepted" : "webhook.unrouted", operation: provider,
  });
  return new Response("OK", { status: 200 });
}
