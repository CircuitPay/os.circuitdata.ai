// The built-in templates (FR-010). A built-in's mapping version is part of the release: bump
// `version` whenever its mapping changes, and every source that used an older version is offered a
// rebuild (US5.2).

import type { MappingDocument } from "../../app-api-types.js";
import { SHOPIFY_ORDERS } from "./shopify-orders.js";
import { SQUARE_ITEM_DETAIL } from "./square-item-detail.js";
import { TOAST } from "./toast.js";

/** A template shipped with the release. */
export type BuiltinTemplate = {
  key: "toast" | "square_item_detail" | "shopify_orders";
  name: string;
  version: number;
  /** Single-file templates: the headers that recognise the file. Sets use `mapping.files`. */
  signature?: string[];
  mapping: MappingDocument;
};

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [TOAST, SQUARE_ITEM_DETAIL, SHOPIFY_ORDERS];

/** The header signatures stored with a template version: one list per file role. */
export function headerSignatures(mapping: MappingDocument, signature?: string[]): { role: string; headers: string[] }[] {
  if (mapping.files?.length) return mapping.files.map(file => ({ role: file.role, headers: file.headerSignature }));
  return [{ role: "file", headers: signature ?? signatureFromMapping(mapping) }];
}

/** A single-file mapping's signature: the columns it reads. */
export function signatureFromMapping(mapping: MappingDocument): string[] {
  const columns = new Set<string>();
  for (const target of mapping.targets) {
    if (typeof target.from === "string") columns.add(target.from);
  }
  if (typeof mapping.orderKey === "string") columns.add(mapping.orderKey);
  return [...columns];
}
