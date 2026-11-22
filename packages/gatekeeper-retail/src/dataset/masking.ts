// Personal data (FR-019, research R12). Customers keep their raw PII plus display masks and keyed
// hashes; the public `customers` view exposes the masks unless an organization administrator turned
// unmasked access on, so masking needs no query rewrite and query text cannot bypass it.

import { customersViewSql } from "./schema.js";

/** The masked and hashed forms of one customer's personal columns. */
export type CustomerPii = {
  firstNameMask: string | null;
  lastNameMask: string | null;
  emailMask: string | null;
  phoneMask: string | null;
  emailHash: string | null;
  phoneHash: string | null;
};

/** A fresh per-dataset HMAC key, hex-encoded. Generated once; it never leaves the dataset. */
export function newHmacKey(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Imports the dataset's hex HMAC key for signing. */
export function importHmacKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", fromHex(hexKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** HMAC-SHA-256 of `value`, hex-encoded. */
export async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(new Uint8Array(signature));
}

/** The form an email is hashed in: trimmed and lower case. Null when blank. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * The form a phone number is hashed in: its digits, with the leading "+" kept when the source gave
 * an E.164 number. Sources that omit the country code hash differently from those that include it.
 * Null when it has no digits.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  return phone.trim().startsWith("+") ? `+${digits}` : digits;
}

/** "Jane" → "J." */
export function maskName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return `${String.fromCodePoint(trimmed.codePointAt(0)!).toUpperCase()}.`;
}

/** "jane@example.com" → "j***@example.com"; text without "@" masks entirely. */
export function maskEmail(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${String.fromCodePoint(normalized.codePointAt(0)!)}***${normalized.slice(at)}`;
}

/** "+1 415 555 1234" → "***-***-1234" (the last four digits only). */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, "");
  if (!digits) return null;
  return `***-***-${digits.slice(-4)}`;
}

/** Computes the masks and keyed hashes of one customer's personal columns. */
export async function protectCustomer(
  key: CryptoKey,
  customer: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null },
): Promise<CustomerPii> {
  const email = normalizeEmail(customer.email);
  const phone = normalizePhone(customer.phone);
  const [emailHash, phoneHash] = await Promise.all([
    email ? hmacHex(key, email) : null,
    phone ? hmacHex(key, phone) : null,
  ]);
  return {
    firstNameMask: maskName(customer.firstName),
    lastNameMask: maskName(customer.lastName),
    emailMask: maskEmail(customer.email),
    phoneMask: maskPhone(customer.phone),
    emailHash,
    phoneHash,
  };
}

/** Recreates the `customers` view masked or unmasked. Run inside the caller's transaction. */
export function recreateCustomersView(sql: SqlStorage, unmasked: boolean): void {
  sql.exec("DROP VIEW IF EXISTS customers");
  sql.exec(customersViewSql(unmasked));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
