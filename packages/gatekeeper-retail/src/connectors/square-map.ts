// Square objects → canonical records (data-model §2). Pure functions over the documented API
// shapes; every field is read defensively, because a page is untrusted input. Amounts are Square's
// integer minor units; quantities are decimal strings, stored as ten-thousandths.

import {
  parseQuantity,
  type Channel, type CustomerRecord, type InventoryMovementRecord, type InventoryRecord,
  type LineItemRecord, type LocationRecord, type ModifierRecord, type OrderRecord, type OrderStatus,
  type ProductRecord, type RefundItemRecord, type TransactionRecord,
} from "../dataset/ingest.js";
import { epochSeconds } from "./provider.js";

/** Square's JSON, untyped: every access goes through the readers below. */
export type SquareObject = Record<string, unknown>;

function obj(value: unknown): SquareObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as SquareObject : {};
}

function arr(value: unknown): SquareObject[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A Money's amount, or 0. */
function amount(money: unknown): number {
  const value = obj(money).amount;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** A Money's currency, upper case, or null. */
function currencyOf(money: unknown): string | null {
  const code = str(obj(money).currency);
  return code ? code.toUpperCase() : null;
}

function quantityE4(value: unknown): number {
  return (typeof value === "string" || typeof value === "number" ? parseQuantity(value)?.e4 : undefined) ?? 0;
}

/** `Location` → location. Square always reports a time zone and currency for a location. */
export function mapLocation(location: SquareObject): LocationRecord | null {
  const id = str(location.id);
  const timezone = str(location.timezone);
  const currency = str(location.currency);
  if (!id || !timezone || !currency) return null;
  const address = obj(location.address);
  return {
    sourceRecordId: id,
    name: str(location.name) ?? str(location.business_name) ?? id,
    kind: location.type === "MOBILE" ? "other" : "store",
    timezone,
    currency: currency.toUpperCase(),
    addressCity: str(address.locality),
    addressRegion: str(address.administrative_district_level_1),
    addressCountry: str(address.country) ?? str(location.country),
    addressPostalCode: str(address.postal_code),
  };
}

/**
 * A catalog page → products. Each `ITEM` becomes a parent product, and each of its variations a
 * product under it; `CATEGORY` objects on the same page name the items' categories.
 */
export function mapCatalog(objects: SquareObject[]): ProductRecord[] {
  const categories = new Map<string, string>();
  for (const object of objects) {
    if (object.type !== "CATEGORY") continue;
    const id = str(object.id);
    const name = str(obj(object.category_data).name);
    if (id && name) categories.set(id, name);
  }
  const products: ProductRecord[] = [];
  for (const object of objects) {
    if (object.type === "ITEM") products.push(...mapItem(object, categories));
    else if (object.type === "ITEM_VARIATION") {
      const variation = mapVariation(object, null, null, null);
      if (variation) products.push(variation);
    }
  }
  return products;
}

function mapItem(item: SquareObject, categories: Map<string, string>): ProductRecord[] {
  const id = str(item.id);
  if (!id) return [];
  const data = obj(item.item_data);
  const name = str(data.name) ?? id;
  const categoryId = str(obj(data.reporting_category).id) ?? str(arr(data.categories)[0]?.id) ?? str(data.category_id);
  const category = categoryId ? categories.get(categoryId) ?? null : null;
  const deletedAt = item.is_deleted === true ? epochSeconds(item.updated_at) : null;
  const products: ProductRecord[] = [{
    sourceRecordId: id, name, category, isActive: !deletedAt, deletedAt,
  }];
  for (const variation of arr(data.variations)) {
    const mapped = mapVariation(variation, id, name, category);
    if (mapped) products.push(deletedAt ? { ...mapped, isActive: false, deletedAt } : mapped);
  }
  return products;
}

function mapVariation(
  variation: SquareObject, parentRef: string | null, itemName: string | null, category: string | null,
): ProductRecord | null {
  const id = str(variation.id);
  if (!id) return null;
  const data = obj(variation.item_variation_data);
  const price = data.price_money;
  const deletedAt = variation.is_deleted === true ? epochSeconds(variation.updated_at) : null;
  return {
    sourceRecordId: id,
    name: itemName ?? str(data.name) ?? id,
    variantName: str(data.name),
    parentRef,
    sku: str(data.sku),
    barcode: str(data.upc),
    category,
    priceAmount: price ? amount(price) : null,
    currency: currencyOf(price),
    isActive: !deletedAt,
    deletedAt,
  };
}

/** `Customer` → customer. PII is protected by the dataset on ingest (research R12). */
export function mapCustomer(customer: SquareObject): CustomerRecord | null {
  const id = str(customer.id);
  if (!id) return null;
  const preferences = obj(customer.preferences);
  return {
    sourceRecordId: id,
    firstName: str(customer.given_name),
    lastName: str(customer.family_name),
    email: str(customer.email_address),
    phone: str(customer.phone_number),
    createdAt: epochSeconds(customer.created_at),
    marketingOptIn: typeof preferences.email_unsubscribed === "boolean" ? !preferences.email_unsubscribed : null,
  };
}

/** What one Square order contributes. A pure return order contributes refund items only. */
export type MappedOrder = {
  order: OrderRecord | null;
  lineItems: LineItemRecord[];
  refundItems: RefundItemRecord[];
};

/** `Order` → order, line items and returned items. */
export function mapOrder(order: SquareObject): MappedOrder {
  const id = str(order.id);
  const locationRef = str(order.location_id);
  const lines = arr(order.line_items);
  const returns = arr(order.returns);
  const currency = currencyOf(order.total_money) ?? currencyOf(lines[0]?.base_price_money);
  const occurredAt = epochSeconds(order.closed_at) ?? epochSeconds(order.created_at);
  if (!id || !locationRef) return { order: null, lineItems: [], refundItems: [] };

  const refundItems: RefundItemRecord[] = [];
  for (const returned of returns) {
    const sourceOrderId = str(returned.source_order_id);
    if (!sourceOrderId) continue;
    for (const item of arr(returned.return_line_items)) {
      const uid = str(item.uid);
      if (!uid) continue;
      const sourceLine = str(item.source_line_item_uid);
      refundItems.push({
        sourceRecordId: `${id}:${uid}`,
        orderRef: sourceOrderId,
        lineItemRef: sourceLine ? `${sourceOrderId}:${sourceLine}` : null,
        productRef: str(item.catalog_object_id),
        quantityE4: quantityE4(item.quantity),
        salesAmount: amount(item.gross_return_money) - amount(item.total_discount_money),
        taxAmount: amount(item.total_tax_money),
        occurredAt,
        currency: currencyOf(item.gross_return_money) ?? currency ?? undefined,
      });
    }
  }
  // A return or exchange order with nothing sold is not a sale of its own.
  if (lines.length === 0 && returns.length > 0) return { order: null, lineItems: [], refundItems };
  if (!currency) return { order: null, lineItems: [], refundItems };

  const lineItems: LineItemRecord[] = lines.flatMap(line => {
    const uid = str(line.uid);
    if (!uid) return [];
    const modifiers: ModifierRecord[] = arr(line.modifiers).map(modifier => ({
      name: str(modifier.name) ?? "",
      price_amount: amount(modifier.base_price_money),
      quantity: Number(str(modifier.quantity) ?? 1) || 1,
    }));
    const variation = str(line.variation_name);
    const name = str(line.name) ?? "Custom amount";
    return [{
      sourceRecordId: `${id}:${uid}`,
      orderRef: id,
      productRef: str(line.catalog_object_id),
      name: variation && variation !== "Regular" ? `${name} (${variation})` : name,
      quantityE4: quantityE4(line.quantity),
      unitPriceAmount: amount(line.base_price_money),
      grossAmount: amount(line.gross_sales_money),
      discountAmount: amount(line.total_discount_money),
      taxAmount: amount(line.total_tax_money),
      modifiers: modifiers.length ? modifiers : null,
      currency: currencyOf(line.base_price_money) ?? currency,
    }];
  });
  const lineDiscounts = lineItems.reduce((sum, line) => sum + (line.discountAmount ?? 0), 0);
  const total = amount(order.total_money);
  const returned = amount(obj(order.return_amounts).total_money);
  let status: OrderStatus = "open";
  if (order.state === "COMPLETED") {
    status = returned <= 0 ? "completed" : returned >= total ? "refunded" : "partially_refunded";
  } else if (order.state === "CANCELED") {
    status = "voided";
  }
  return {
    order: {
      sourceRecordId: id,
      locationRef,
      customerRef: str(order.customer_id),
      orderNumber: str(order.ticket_name) ?? str(order.reference_id),
      status,
      channel: channelOf(order),
      openedAt: epochSeconds(order.created_at),
      closedAt: epochSeconds(order.closed_at),
      currency,
      grossAmount: lineItems.length ? null : total - amount(order.total_tax_money) - amount(order.total_tip_money)
        - amount(order.total_service_charge_money) + amount(order.total_discount_money),
      discountAmount: Math.max(0, amount(order.total_discount_money) - lineDiscounts),
      serviceChargeAmount: amount(order.total_service_charge_money),
      taxAmount: amount(order.total_tax_money),
      tipAmount: amount(order.total_tip_money),
      totalAmount: total,
      linesComplete: true,
    },
    lineItems,
    refundItems,
  };
}

function channelOf(order: SquareObject): Channel {
  const types = new Set(arr(order.fulfillments).map(fulfillment => fulfillment.type));
  if (types.has("DELIVERY")) return "delivery";
  if (types.has("SHIPMENT")) return "online";
  const source = (str(obj(order.source).name) ?? "").toLowerCase();
  if (source.includes("online") || source.includes("ecom")) return "online";
  return "in_store";
}

const TENDERS: Record<string, TransactionRecord["tender"]> = {
  CARD: "card", CASH: "cash", SQUARE_ACCOUNT: "gift_card", WALLET: "wallet", BANK_ACCOUNT: "other",
  BUY_NOW_PAY_LATER: "other", EXTERNAL: "other",
};

function transactionStatus(status: unknown): TransactionRecord["status"] {
  if (status === "COMPLETED" || status === "APPROVED") return "succeeded";
  if (status === "PENDING") return "pending";
  return "failed";
}

/** `Payment` → payment transaction. */
export function mapPayment(payment: SquareObject): TransactionRecord | null {
  const id = str(payment.id);
  const occurredAt = epochSeconds(payment.created_at);
  const currency = currencyOf(payment.total_money) ?? currencyOf(payment.amount_money);
  if (!id || occurredAt === null || !currency) return null;
  const fees = arr(payment.processing_fee).reduce((sum, fee) => sum + amount(fee.amount_money), 0);
  return {
    sourceRecordId: id,
    orderRef: str(payment.order_id),
    locationRef: str(payment.location_id),
    kind: "payment",
    tender: TENDERS[String(payment.source_type)] ?? "other",
    cardBrand: str(obj(obj(payment.card_details).card).card_brand),
    amount: amount(payment.total_money) || amount(payment.amount_money) + amount(payment.tip_money),
    salesAmount: amount(payment.amount_money),
    tipAmount: amount(payment.tip_money),
    feeAmount: fees,
    currency,
    occurredAt,
    status: transactionStatus(payment.status),
  };
}

/** `PaymentRefund` → refund transaction, linked to its payment. */
export function mapRefund(refund: SquareObject): TransactionRecord | null {
  const id = str(refund.id);
  const occurredAt = epochSeconds(refund.created_at);
  const currency = currencyOf(refund.amount_money);
  if (!id || occurredAt === null || !currency) return null;
  const fees = arr(refund.processing_fee).reduce((sum, fee) => sum + amount(fee.amount_money), 0);
  return {
    sourceRecordId: id,
    orderRef: str(refund.order_id),
    locationRef: str(refund.location_id),
    parentRef: str(refund.payment_id),
    kind: "refund",
    amount: amount(refund.amount_money),
    salesAmount: amount(refund.amount_money),
    feeAmount: fees,
    currency,
    occurredAt,
    status: transactionStatus(refund.status),
  };
}

/** `InventoryCount` → current stock of one product at one location. */
export function mapInventoryCount(count: SquareObject): InventoryRecord | null {
  const productRef = str(count.catalog_object_id);
  const locationRef = str(count.location_id);
  const asOf = epochSeconds(count.calculated_at);
  if (!productRef || !locationRef || asOf === null || count.state !== "IN_STOCK") return null;
  const quantity = quantityE4(count.quantity);
  return {
    sourceRecordId: `${productRef}@${locationRef}`,
    productRef,
    locationRef,
    quantityOnHandE4: quantity,
    state: quantity > 0 ? "in_stock" : "out_of_stock",
    asOf,
  };
}

/** `InventoryChange` (adjustments only) → a stock movement at one location. */
export function mapInventoryChange(change: SquareObject): InventoryMovementRecord | null {
  if (change.type !== "ADJUSTMENT") return null;
  const adjustment = obj(change.adjustment);
  const id = str(adjustment.id);
  const productRef = str(adjustment.catalog_object_id);
  const locationRef = str(adjustment.location_id);
  const occurredAt = epochSeconds(adjustment.occurred_at) ?? epochSeconds(adjustment.created_at);
  if (!id || !productRef || !locationRef || occurredAt === null) return null;
  const quantity = quantityE4(adjustment.quantity);
  const into = adjustment.to_state === "IN_STOCK";
  const outOf = adjustment.from_state === "IN_STOCK";
  if (into === outOf) return null;
  let reason: InventoryMovementRecord["reason"] = "adjustment";
  if (adjustment.to_state === "SOLD") reason = "sale";
  else if (adjustment.to_state === "WASTE") reason = "waste";
  else if (into && (adjustment.from_state === "NONE" || adjustment.from_state === "RECEIVED_FROM_VENDOR")) reason = "receive";
  else if (adjustment.to_state === "IN_TRANSIT" || adjustment.from_state === "IN_TRANSIT") reason = "transfer";
  return {
    sourceRecordId: id,
    productRef,
    locationRef,
    quantityDeltaE4: into ? quantity : -quantity,
    reason,
    occurredAt,
  };
}
