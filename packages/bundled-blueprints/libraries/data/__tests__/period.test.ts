// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { DateRangeFilter } from "../src/model.ts";
import { addDays, anchorDate, DATE_PRESETS, daysInRange, describeRange, isIsoDate, previousRange, resolveRange } from "../src/period.ts";

describe("anchorDate", () => {
  it("is the dataset's last business date when that is before today", () => {
    expect(anchorDate("2026-11-25", "2026-11-20")).toBe("2026-11-20");
  });

  it("is today when the dataset runs past it, or has no dates", () => {
    expect(anchorDate("2026-11-25", "2026-12-01")).toBe("2026-11-25");
    expect(anchorDate("2026-11-25", "2026-11-25")).toBe("2026-11-25");
    expect(anchorDate("2026-11-25", null)).toBe("2026-11-25");
  });

  it("reads the date of a full timestamp", () => {
    expect(anchorDate("2026-11-25T23:59:59.000Z", null)).toBe("2026-11-25");
  });

  it("refuses a today that is not a date", () => {
    expect(() => anchorDate("yesterday", null)).toThrow(/YYYY-MM-DD/);
  });
});

describe("resolveRange with a preset", () => {
  it("counts the last 7, 30 and 90 days back from the anchor, inclusive", () => {
    expect(resolveRange({ preset: "last7" }, "2026-11-25")).toEqual({ from: "2026-11-19", to: "2026-11-25" });
    expect(resolveRange({ preset: "last30" }, "2026-11-25")).toEqual({ from: "2026-10-27", to: "2026-11-25" });
    expect(resolveRange({ preset: "last90" }, "2026-11-25")).toEqual({ from: "2026-08-28", to: "2026-11-25" });
    for (const [preset, days] of [["last7", 7], ["last30", 30], ["last90", 90]] as const) {
      expect(daysInRange(resolveRange({ preset }, "2026-11-25"))).toBe(days);
    }
  });

  it("crosses month and year boundaries", () => {
    expect(resolveRange({ preset: "last7" }, "2026-03-03")).toEqual({ from: "2026-02-25", to: "2026-03-03" });
    expect(resolveRange({ preset: "last30" }, "2026-01-15")).toEqual({ from: "2025-12-17", to: "2026-01-15" });
    expect(resolveRange({ preset: "last7" }, "2026-01-01")).toEqual({ from: "2025-12-26", to: "2026-01-01" });
  });

  it("counts the leap day", () => {
    expect(resolveRange({ preset: "last7" }, "2024-03-03")).toEqual({ from: "2024-02-26", to: "2024-03-03" });
    expect(resolveRange({ preset: "last90" }, "2024-03-30")).toEqual({ from: "2024-01-01", to: "2024-03-30" });
    expect(resolveRange({ preset: "last7" }, "2024-02-29")).toEqual({ from: "2024-02-23", to: "2024-02-29" });
  });

  it("starts this month on its first day", () => {
    expect(resolveRange({ preset: "thisMonth" }, "2026-10-17")).toEqual({ from: "2026-10-01", to: "2026-10-17" });
    expect(resolveRange({ preset: "thisMonth" }, "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(resolveRange({ preset: "thisMonth" }, "2024-02-29")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("takes the month before the anchor's as last month", () => {
    expect(resolveRange({ preset: "lastMonth" }, "2026-11-25")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveRange({ preset: "lastMonth" }, "2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveRange({ preset: "lastMonth" }, "2024-03-15")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(resolveRange({ preset: "lastMonth" }, "2026-03-01")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // The day before a month's last is still inside it, so the month before is the last whole one.
    expect(resolveRange({ preset: "lastMonth" }, "2024-02-28")).toEqual({ from: "2024-01-01", to: "2024-01-31" });
  });

  it("takes the anchor's own month as last month when the anchor is its last day", () => {
    expect(resolveRange({ preset: "lastMonth" }, "2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveRange({ preset: "lastMonth" }, "2025-12-31")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveRange({ preset: "lastMonth" }, "2024-02-29")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(resolveRange({ preset: "lastMonth" }, "2026-02-28")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("starts this year on 1 January", () => {
    expect(resolveRange({ preset: "thisYear" }, "2026-11-25")).toEqual({ from: "2026-01-01", to: "2026-11-25" });
    expect(resolveRange({ preset: "thisYear" }, "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(resolveRange({ preset: "thisYear" }, "2024-12-31")).toEqual({ from: "2024-01-01", to: "2024-12-31" });
  });

  it("resolves every preset the control offers to a range that ends at the anchor or before it", () => {
    expect(DATE_PRESETS.map(preset => preset.id)).toEqual(["last7", "last30", "last90", "thisMonth", "lastMonth", "thisYear"]);
    for (const preset of DATE_PRESETS) {
      const range = resolveRange({ preset: preset.id }, "2026-11-25");
      expect(range.from <= range.to).toBe(true);
      expect(range.to <= "2026-11-25").toBe(true);
      expect(preset.label).not.toBe("");
    }
  });

  it("refuses a preset it does not know and an anchor that is not a date", () => {
    const offTheWire: DateRangeFilter = JSON.parse('{"preset":"sinceForever"}');
    expect(() => resolveRange(offTheWire, "2026-11-25")).toThrow(/not a date range/);
    expect(() => resolveRange({ preset: "last7" }, "2026-13-01")).toThrow(/YYYY-MM-DD/);
  });
});

describe("resolveRange with explicit dates", () => {
  it("returns a valid range as it is, whatever the anchor", () => {
    expect(resolveRange({ from: "2026-10-01", to: "2026-10-31" }, "2020-01-01")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveRange({ from: "2026-10-05", to: "2026-10-05" }, "2026-11-25")).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });

  it("refuses dates out of order", () => {
    expect(() => resolveRange({ from: "2026-11-02", to: "2026-11-01" }, "2026-11-25")).toThrow("The start date must not be after the end date.");
  });

  it("refuses text that is not a real date, however it is dressed", () => {
    for (const bad of ["2026-02-30", "2025-02-29", "2026-2-3", "2026-10-01'; DROP TABLE orders;--", "", "10/01/2026", "0000-01-01"]) {
      expect(() => resolveRange({ from: bad, to: "2026-11-01" }, "2026-11-25")).toThrow(/start date must be a real date/);
      expect(() => resolveRange({ from: "2020-01-01", to: bad }, "2026-11-25")).toThrow(/end date must be a real date/);
    }
  });

  it("refuses a range of three years or more, as the dataset does", () => {
    expect(resolveRange({ from: "2023-01-01", to: "2025-12-31" }, "2026-11-25")).toEqual({ from: "2023-01-01", to: "2025-12-31" });
    expect(() => resolveRange({ from: "2023-01-01", to: "2026-01-01" }, "2026-11-25")).toThrow("The date range must be shorter than 3 years.");
  });
});

describe("previousRange", () => {
  it("is the same number of days, ending the day before the range starts", () => {
    const october = { from: "2026-10-01", to: "2026-10-31" };
    expect(previousRange(october)).toEqual({ from: "2026-08-31", to: "2026-09-30" });
    expect(daysInRange(previousRange(october))).toBe(daysInRange(october));
  });

  it("is the day before for a single day", () => {
    expect(previousRange({ from: "2026-03-01", to: "2026-03-01" })).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  });

  it("counts the leap day and crosses a year", () => {
    expect(previousRange({ from: "2024-03-01", to: "2024-03-31" })).toEqual({ from: "2024-01-30", to: "2024-02-29" });
    expect(previousRange({ from: "2026-01-01", to: "2026-01-07" })).toEqual({ from: "2025-12-25", to: "2025-12-31" });
  });

  it("keeps the length for every preset", () => {
    for (const preset of DATE_PRESETS) {
      const range = resolveRange({ preset: preset.id }, "2024-03-30");
      const before = previousRange(range);
      expect(daysInRange(before)).toBe(daysInRange(range));
      expect(addDays(before.to, 1)).toBe(range.from);
    }
  });
});

describe("describeRange", () => {
  it("writes a range the way a person would", () => {
    expect(describeRange({ from: "2026-10-01", to: "2026-10-31" })).toBe("1–31 Oct 2026");
    expect(describeRange({ from: "2026-11-03", to: "2026-11-03" })).toBe("3 Nov 2026");
    expect(describeRange({ from: "2026-10-28", to: "2026-11-03" })).toBe("28 Oct – 3 Nov 2026");
    expect(describeRange({ from: "2025-12-28", to: "2026-01-03" })).toBe("28 Dec 2025 – 3 Jan 2026");
  });
});

describe("isIsoDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-11-25T00:00:00Z")).toBe(false);
    expect(isIsoDate(20261125)).toBe(false);
  });
});
