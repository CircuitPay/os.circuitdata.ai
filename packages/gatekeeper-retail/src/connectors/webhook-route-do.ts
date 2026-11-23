// RetailWebhookRoute: one Durable Object per provider account (data-model §1), holding the set of
// connections that receive that account's events. A provider event names only its account
// (Square's `merchant_id`, Stripe's `account`), never a dataset or a sharing domain, so the route is
// named by provider and account alone and fans out to every connection of the account, whichever
// dataset holds it. Each connection then refetches with its own credentials; the event body is a
// trigger, never data.

import { DurableObject } from "cloudflare:workers";
import { retailLogger } from "../observability.js";
import type { ProviderKind, RefetchTarget } from "./provider.js";

const logger = retailLogger("webhook");

const CONNECTION_PREFIX = "conn:";

/** The DO name of a provider account's route. */
export function routeObjectName(provider: ProviderKind, externalAccountId: string): string {
  return `route\0${provider}\0${externalAccountId}`;
}

export class RetailWebhookRoute extends DurableObject<Cloudflare.Env> {
  /** Adds a connection (by DO name) to this account's route. */
  add(connectionName: string): void {
    // `<sharingDomain>\0conn\0<connectionId>`
    const parts = connectionName.split("\0");
    if (parts.length !== 3 || parts[1] !== "conn") throw new Error("Not a connection name.");
    this.ctx.storage.kv.put(`${CONNECTION_PREFIX}${connectionName}`, true);
  }

  /** Removes a connection; the route object empties itself with its last connection. */
  async remove(connectionName: string): Promise<void> {
    this.ctx.storage.kv.delete(`${CONNECTION_PREFIX}${connectionName}`);
    if ([...this.ctx.storage.kv.list({ prefix: CONNECTION_PREFIX, limit: 1 })].length === 0) {
      await this.ctx.storage.deleteAll();
    }
  }

  /** The connections routed here. */
  connections(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: CONNECTION_PREFIX })].map(([key]) => key.slice(CONNECTION_PREFIX.length));
  }

  /**
   * Queues a refetch of `targets` on every connection of the account. Returns how many
   * connections took it (0: unrouted, or a duplicate event).
   */
  async dispatch(eventId: string, targets: RefetchTarget[]): Promise<number> {
    let queued = 0;
    for (const name of this.connections()) {
      try {
        if (await this.ctx.exports.RetailConnection.getByName(name).queueRefetch(eventId, targets)) queued++;
      } catch (error) {
        logger.warn("webhook dispatch failed", { event: "webhook.dispatch_failed", error });
      }
    }
    return queued;
  }
}
