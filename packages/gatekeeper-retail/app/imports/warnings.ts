import type { RunSummary } from "../../src/app-api-types";

/** The warnings of an import or its preview, worded for the member (US2.5). */
export function warningMessages(warnings: RunSummary["warnings"]): string[] {
  const messages: string[] = [];
  if (warnings.fingerprintRows > 0) {
    messages.push(
      `${warnings.fingerprintRows.toLocaleString()} rows had no id and were matched by their contents, so a later edit of one of them will be imported as a new row.`,
    );
  }
  if (warnings.totalMismatch > 0) {
    messages.push(
      `${warnings.totalMismatch.toLocaleString()} orders have a total that disagrees with their items, tax and tips.`,
    );
  }
  if (warnings.quantityRounded > 0) {
    messages.push(`${warnings.quantityRounded.toLocaleString()} quantities were rounded to 4 decimals.`);
  }
  return messages;
}
