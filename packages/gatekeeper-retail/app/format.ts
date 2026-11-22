export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 || value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** An ISO 8601 timestamp in the member's locale. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatCount(count: number): string {
  return count.toLocaleString();
}

/** Integer minor units of `currency` (1299 USD → $12.99), as the dataset stores money. */
export function formatMoney(minorUnits: number, currency: string): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    // Not an ISO 4217 code Intl knows: show the raw amount rather than guess its minor units.
    return `${minorUnits.toLocaleString()} ${currency}`;
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minorUnits / 10 ** digits);
}

/** The message of a thrown value, as the Data area shows it in error banners. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
