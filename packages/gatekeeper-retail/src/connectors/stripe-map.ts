// Stripe objects → canonical records (spec "Stripe's role"): Stripe is a payments and online-sales
// source. Orders come from paid invoices and completed Checkout sessions; otherwise payments stand
// without line items. Stripe has no locations, so each account is one online location. Amounts are
// integer minor units; currencies arrive lower case and are stored upper case (research R11).

import type {
  CustomerRecord, LineItemRecord, LocationRecord, OrderRecord, OrderStatus, ProductRecord, TransactionRecord,
} from "../dataset/ingest.js";

/** Stripe's JSON, untyped: every access goes through the readers below. */
export type StripeObject = Record<string, unknown>;

export function isStripeObject(value: unknown): value is StripeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function obj(value: unknown): StripeObject {
  return isStripeObject(value) ? value : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** An expandable field's id, whether expanded or not. */
function ref(value: unknown): string | null {
  return str(value) ?? str(obj(value).id);
}

function currency(value: unknown): string | null {
  const code = str(value);
  return code ? code.toUpperCase() : null;
}

/** The synthetic location that stands for one Stripe account. */
export function stripeLocationId(accountId: string): string {
  return `stripe:${accountId}`;
}

/** The account → its one online location. */
export function mapAccountLocation(accountId: string, account: StripeObject): LocationRecord {
  const settings = obj(obj(account.settings).dashboard);
  const address = obj(obj(account.business_profile).support_address);
  return {
    sourceRecordId: stripeLocationId(accountId),
    name: str(obj(account.business_profile).name) ?? str(settings.display_name) ?? "Stripe",
    kind: "online",
    timezone: str(settings.timezone) ?? "UTC",
    currency: currency(account.default_currency) ?? "USD",
    addressCity: str(address.city),
    addressRegion: str(address.state),
    addressCountry: str(account.country) ?? str(address.country),
    addressPostalCode: str(address.postal_code),
  };
}

export function mapStripeCustomer(customer: StripeObject): CustomerRecord | null {
  const id = str(customer.id);
  if (!id) return null;
  const name = str(customer.name);
  const space = name?.indexOf(" ") ?? -1;
  return {
    sourceRecordId: id,
    firstName: name && space > 0 ? name.slice(0, space) : name,
    lastName: name && space > 0 ? name.slice(space + 1) : null,
    email: str(customer.email),
    phone: str(customer.phone),
    createdAt: typeof customer.created === "number" ? customer.created : null,
    deletedAt: customer.deleted === true ? Math.floor(Date.now() / 1000) : null,
  };
}

/** A product → its parent record. */
export function mapStripeProduct(product: StripeObject): ProductRecord | null {
  const id = str(product.id);
  if (!id) return null;
  return {
    sourceRecordId: id,
    name: str(product.name) ?? id,
    isActive: product.active !== false && product.deleted !== true,
    deletedAt: product.deleted === true ? Math.floor(Date.now() / 1000) : null,
  };
}

/** A price → a variant of its product. `productName` names it when the product is known. */
export function mapStripePrice(price: StripeObject, productName: string | null): ProductRecord | null {
  const id = str(price.id);
  const product = ref(price.product);
  if (!id) return null;
  const recurring = obj(price.recurring);
  const interval = str(recurring.interval);
  return {
    sourceRecordId: id,
    name: productName ?? str(obj(price.product).name) ?? str(price.nickname) ?? id,
    variantName: str(price.nickname) ?? (interval ? `per ${interval}` : null),
    parentRef: product,
    priceAmount: typeof price.unit_amount === "number" ? price.unit_amount : null,
    currency: currency(price.currency),
    isActive: price.active !== false,
  };
}

/** What one invoice or Checkout session contributes. */
export type MappedStripeOrder = { order: OrderRecord | null; lineItems: LineItemRecord[] };

function mapLines(orderId: string, lines: StripeObject[], orderCurrency: string): LineItemRecord[] {
  return lines.flatMap(line => {
    const id = str(line.id);
    if (!id) return [];
    const quantity = typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 1;
    const price = obj(line.price ?? obj(obj(line.pricing).price_details));
    const gross = typeof line.amount_subtotal === "number" ? line.amount_subtotal : int(line.amount);
    const discount = typeof line.amount_discount === "number" ? line.amount_discount
      : arrayOf(line, "discount_amounts").reduce((sum, item) => sum + int(item.amount), 0);
    const tax = typeof line.amount_tax === "number" ? line.amount_tax
      : arrayOf(line, "tax_amounts").reduce((sum, item) => sum + int(item.amount), 0);
    return [{
      sourceRecordId: `${orderId}:${id}`,
      orderRef: orderId,
      productRef: ref(price.id) ?? ref(line.price),
      name: str(line.description) ?? "Item",
      quantityE4: Math.round(quantity * 10_000),
      unitPriceAmount: typeof price.unit_amount === "number" ? price.unit_amount : Math.round(gross / quantity),
      grossAmount: gross,
      discountAmount: discount,
      taxAmount: tax,
      currency: currency(line.currency) ?? orderCurrency,
    }];
  });
}

function arrayOf(value: StripeObject, key: string): StripeObject[] {
  const list = value[key];
  if (Array.isArray(list)) return list.filter(isStripeObject);
  const data = obj(list).data;
  return Array.isArray(data) ? data.filter(isStripeObject) : [];
}

/** A paid, void or open invoice → an online order. Drafts are not orders yet. */
export function mapInvoice(invoice: StripeObject, locationRef: string): MappedStripeOrder {
  const id = str(invoice.id);
  const code = currency(invoice.currency);
  if (!id || !code || invoice.status === "draft") return { order: null, lineItems: [] };
  const statuses: Record<string, OrderStatus> = { paid: "completed", void: "voided", uncollectible: "voided" };
  const transitions = obj(invoice.status_transitions);
  const lineItems = mapLines(id, arrayOf(invoice, "lines"), code);
  return {
    order: {
      sourceRecordId: id,
      locationRef,
      customerRef: ref(invoice.customer),
      orderNumber: str(invoice.number),
      status: statuses[String(invoice.status)] ?? "open",
      channel: "online",
      openedAt: typeof invoice.created === "number" ? invoice.created : null,
      closedAt: typeof transitions.paid_at === "number" ? transitions.paid_at : null,
      currency: code,
      grossAmount: lineItems.length ? null : int(invoice.subtotal),
      discountAmount: 0,
      taxAmount: int(invoice.tax) || arrayOf(invoice, "total_taxes").reduce((sum, tax) => sum + int(tax.amount), 0),
      totalAmount: int(invoice.total),
      // stripe.ts reads every page of `lines` before mapping.
      linesComplete: true,
    },
    lineItems,
  };
}

/** A complete Checkout session in payment mode → an online order. */
export function mapCheckoutSession(session: StripeObject, locationRef: string): MappedStripeOrder {
  const id = str(session.id);
  const code = currency(session.currency);
  if (!id || !code || session.mode !== "payment" || session.status !== "complete") return { order: null, lineItems: [] };
  const details = obj(session.total_details);
  const lineItems = mapLines(id, arrayOf(session, "line_items"), code);
  return {
    order: {
      sourceRecordId: id,
      locationRef,
      customerRef: ref(session.customer),
      status: "completed",
      channel: "online",
      openedAt: typeof session.created === "number" ? session.created : null,
      closedAt: typeof session.created === "number" ? session.created : null,
      currency: code,
      grossAmount: lineItems.length ? null : int(session.amount_subtotal),
      discountAmount: 0,
      taxAmount: int(details.amount_tax),
      serviceChargeAmount: int(details.amount_shipping),
      totalAmount: int(session.amount_total),
      // stripe.ts reads every page of `line_items` before mapping.
      linesComplete: true,
    },
    lineItems,
  };
}

function chargeStatus(status: unknown): TransactionRecord["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "pending") return "pending";
  return "failed";
}

/** A charge → a payment. The fee comes from its balance transaction when expanded. */
export function mapCharge(charge: StripeObject, locationRef: string): TransactionRecord | null {
  const id = str(charge.id);
  const code = currency(charge.currency);
  if (!id || !code || typeof charge.created !== "number") return null;
  const method = obj(charge.payment_method_details);
  const type = str(method.type);
  const tenders: Record<string, TransactionRecord["tender"]> = { card: "card", card_present: "card" };
  return {
    sourceRecordId: id,
    orderRef: ref(charge.invoice),
    locationRef,
    kind: "payment",
    tender: type ? tenders[type] ?? (type.endsWith("_pay") || type === "link" ? "wallet" : "other") : null,
    cardBrand: str(obj(method.card).brand) ?? str(obj(method.card_present).brand),
    amount: int(charge.amount),
    salesAmount: int(charge.amount),
    feeAmount: int(obj(charge.balance_transaction).fee),
    currency: code,
    occurredAt: charge.created,
    status: chargeStatus(charge.status),
  };
}

/** A refund → a refund of its charge. */
export function mapStripeRefund(refund: StripeObject, locationRef: string): TransactionRecord | null {
  const id = str(refund.id);
  const code = currency(refund.currency);
  if (!id || !code || typeof refund.created !== "number") return null;
  return {
    sourceRecordId: id,
    locationRef,
    parentRef: ref(refund.charge),
    kind: "refund",
    amount: int(refund.amount),
    salesAmount: int(refund.amount),
    currency: code,
    occurredAt: refund.created,
    status: chargeStatus(refund.status),
  };
}

/** A payout to the merchant's bank. */
export function mapPayout(payout: StripeObject): TransactionRecord | null {
  const id = str(payout.id);
  const code = currency(payout.currency);
  const occurredAt = typeof payout.arrival_date === "number" ? payout.arrival_date : payout.created;
  if (!id || !code || typeof occurredAt !== "number") return null;
  return {
    sourceRecordId: id,
    kind: "payout",
    amount: int(payout.amount),
    currency: code,
    occurredAt,
    status: payout.status === "paid" ? "succeeded" : payout.status === "failed" || payout.status === "canceled" ? "failed" : "pending",
  };
}

/** Balance transactions that are fees Stripe charged outside a payment. */
export const STRIPE_FEE_TYPES = ["stripe_fee", "application_fee", "tax_fee"] as const;

export function mapFee(transaction: StripeObject): TransactionRecord | null {
  const id = str(transaction.id);
  const code = currency(transaction.currency);
  if (!id || !code || typeof transaction.created !== "number") return null;
  if (!(STRIPE_FEE_TYPES as readonly unknown[]).includes(transaction.type)) return null;
  const fee = Math.abs(int(transaction.amount));
  return {
    sourceRecordId: id,
    kind: "fee",
    amount: fee,
    feeAmount: fee,
    currency: code,
    occurredAt: transaction.created,
    status: transaction.status === "available" ? "succeeded" : "pending",
  };
}
