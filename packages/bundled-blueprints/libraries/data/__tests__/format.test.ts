// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  columnHeading,
  currencyDigits,
  formatAge,
  formatCompact,
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatValue,
  percentChange,
} from "../src/format.ts";
import type { ResultColumn } from "../src/model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatMoney", () => {
  it("scales minor units by the currency's own digits", () => {
    expect(formatMoney(1299, "USD", "en-US")).toBe("$12.99");
    expect(formatMoney(1299, "JPY", "en-US")).toBe("¥1,299");
    // The currency code and the amount are joined by a no-break space.
    expect(formatMoney(1234567, "KWD", "en-US")).toMatch(/^KWD\s1,234\.567$/);
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
    expect(currencyDigits("KWD")).toBe(3);
  });

  it("keeps every minor unit of a large or a negative amount", () => {
    expect(formatMoney(123456789, "USD", "en-US")).toBe("$1,234,567.89");
    expect(formatMoney(-500, "USD", "en-US")).toBe("-$5.00");
    expect(formatMoney(0, "EUR", "en-US")).toBe("€0.00");
  });

  it("formats the same with no locale as with en-US", () => {
    expect(formatMoney(1299, "USD")).toBe(formatMoney(1299, "USD", "en-US"));
    expect(formatMoney(1299, "USD", "not a locale")).toBe("$12.99");
  });

  it("shows the units as they are, named, when the currency is not a code", () => {
    expect(formatMoney(1299, "US", "en-US")).toBe("1,299 US");
    expect(formatMoney(1299, "", "en-US")).toBe("1,299");
  });

  it("shortens an amount for an axis", () => {
    expect(formatMoneyCompact(1234000, "USD", "en-US")).toBe("$12.3K");
    expect(formatMoneyCompact(50000, "USD", "en-US")).toBe("$500");
  });
});

describe("formatValue", () => {
  const columns: ResultColumn[] = [
    { name: "location", type: "text" },
    { name: "currency", type: "text" },
    { name: "net_amount", type: "money", currencyColumn: "currency" },
  ];

  it("takes a money cell's currency from its own row", () => {
    const dollars = ["Downtown", "USD", 1234000];
    const yen = ["Shibuya", "JPY", 1234000];
    expect(formatValue(dollars[2], columns[2], dollars, columns, "en-US")).toBe("$12,340.00");
    expect(formatValue(yen[2], columns[2], yen, columns, "en-US")).toBe("¥1,234,000");
  });

  it("shows money with no currency in its row as a plain whole number", () => {
    expect(formatValue(1299, columns[2], ["Downtown", null, 1299], columns, "en-US")).toBe("1,299");
    expect(formatValue(1299, { name: "amount", type: "money" }, [1299], [{ name: "amount", type: "money" }], "en-US")).toBe("1,299");
  });

  it("groups counts, keeps two decimals of a quantity and leaves identifiers and years alone", () => {
    expect(formatValue(12345, { name: "orders", type: "integer" }, [], [], "en-US")).toBe("12,345");
    expect(formatValue(1234.5678, { name: "units", type: "real" }, [], [], "en-US")).toBe("1,234.57");
    expect(formatValue(12345, { name: "product_id", type: "integer" }, [], [], "en-US")).toBe("12345");
    expect(formatValue(2026, { name: "year", type: "integer" }, [], [], "en-US")).toBe("2026");
  });

  it("shows a ratio labelled % as a percentage", () => {
    expect(formatValue(0.253, { name: "value", type: "real", label: "%" }, [], [], "en-US")).toBe("25.3%");
    expect(formatValue(0.253, { name: "value", type: "real" }, [], [], "en-US")).toBe("0.25");
  });

  it("writes dates, months, timestamps and booleans in words", () => {
    expect(formatValue("2026-10-31", { name: "day", type: "date" }, [], [])).toBe("31 Oct 2026");
    expect(formatValue("2026-10", { name: "month", type: "text" }, [], [])).toBe("Oct 2026");
    expect(formatValue("2026-11-17T14:03:00Z", { name: "opened_at", type: "timestamp" }, [], [])).toBe("17 Nov 2026, 14:03 UTC");
    expect(formatValue(true, { name: "is_active", type: "boolean" }, [], [])).toBe("Yes");
    expect(formatValue(false, { name: "is_active", type: "boolean" }, [], [])).toBe("No");
  });

  it("shows text as it is and an absent value as a dash", () => {
    expect(formatValue("<b>Tee</b>", { name: "name", type: "text" }, [], [])).toBe("<b>Tee</b>");
    expect(formatValue(null, { name: "name", type: "text" }, [], [])).toBe("–");
    expect(formatValue(null, columns[2], ["Downtown", "USD", null], columns)).toBe("–");
  });
});

describe("formatDate", () => {
  it("writes day, month and year with no locale and the locale's own form with one", () => {
    expect(formatDate("2026-10-31")).toBe("31 Oct 2026");
    expect(formatDate("2026-10-31", "en-US")).toBe("Oct 31, 2026");
    expect(formatDate("2026-11-17T14:03:00Z")).toBe("17 Nov 2026");
  });

  it("returns text that is not a date as it is", () => {
    expect(formatDate("2026-02-30")).toBe("2026-02-30");
    expect(formatDate("soon")).toBe("soon");
  });
});

describe("formatCompact and formatPercent", () => {
  it("shortens large numbers and keeps small fractions", () => {
    expect(formatCompact(950, "en-US")).toBe("950");
    expect(formatCompact(1234, "en-US")).toBe("1.2K");
    expect(formatCompact(3_400_000, "en-US")).toBe("3.4M");
    expect(formatCompact(0.25, "en-US")).toBe("0.25");
    expect(formatCompact(0, "en-US")).toBe("0");
  });

  it("writes a ratio as a percentage, signed on request", () => {
    expect(formatPercent(0.082, "en-US")).toBe("8.2%");
    expect(formatPercent(0.082, "en-US", true)).toBe("+8.2%");
    expect(formatPercent(-0.051, "en-US", true)).toBe("-5.1%");
  });
});

describe("formatAge", () => {
  const now = Date.UTC(2026, 10, 25, 12);

  it("says just now under a minute, and for a time in the future", () => {
    expect(formatAge(now, now)).toBe("just now");
    expect(formatAge(now - 59_000, now)).toBe("just now");
    expect(formatAge(now + HOUR, now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(formatAge(now - 5 * MINUTE, now)).toBe("5 min ago");
    expect(formatAge(now - 59 * MINUTE, now)).toBe("59 min ago");
    expect(formatAge(now - 2 * HOUR, now)).toBe("2 h ago");
    expect(formatAge(now - 23 * HOUR, now)).toBe("23 h ago");
    expect(formatAge(now - DAY, now)).toBe("1 day ago");
    expect(formatAge(now - 3 * DAY, now)).toBe("3 days ago");
  });
});

describe("percentChange", () => {
  it("is the change as a percentage of the earlier figure", () => {
    expect(percentChange(110, 100)).toBeCloseTo(10);
    expect(percentChange(90, 100)).toBeCloseTo(-10);
    expect(percentChange(100, 100)).toBe(0);
    // A loss that halves is an improvement of 50%.
    expect(percentChange(-50, -100)).toBeCloseTo(50);
  });

  it("is null when there is no base to compare with", () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(Number.NaN, 100)).toBeNull();
  });
});

describe("columnHeading", () => {
  it("is the label when there is one, and the name in words otherwise", () => {
    expect(columnHeading({ name: "net_amount", type: "money" })).toBe("Net amount");
    expect(columnHeading({ name: "value", type: "integer", label: "Orders" })).toBe("Orders");
    // The % label is a unit, never a heading.
    expect(columnHeading({ name: "value", type: "real", label: "%" })).toBe("Value");
  });
});
