// @vitest-environment node
import { describe, expect, it } from "vitest";

import { compatibleVisuals, CURRENCY_NOTE, inferRoles, renderVisual } from "../src/chart.ts";
import type { QueryResult, ResultColumn, VisualType } from "../src/model.ts";
import type { Scalar } from "../src/retail.ts";
import { DATA_STYLES } from "../src/styles.ts";
import { escapeHtml, renderMarkdownLite, renderTable } from "../src/table.ts";

const DAY: ResultColumn = { name: "day", type: "date" };
const LOCATION: ResultColumn = { name: "location", type: "text" };
const CURRENCY: ResultColumn = { name: "currency", type: "text" };
const VALUE: ResultColumn = { name: "value", type: "money", currencyColumn: "currency" };
const SIZE = { width: 480, height: 240 };
const CHARTS: VisualType[] = ["line", "area", "bar", "stackedBar"];

function result(columns: ResultColumn[], rows: Scalar[][], extra: Partial<QueryResult> = {}): QueryResult {
  return {
    columns,
    rows,
    truncated: false,
    period: { from: "2026-10-01", to: "2026-10-31" },
    ranAt: 0,
    durationMs: 0,
    rowCount: rows.length,
    ...extra,
  };
}

/** Net sales for each day of October 2026: 10 dollars on the 1st, rising by 10 a day. */
const october = result(
  [DAY, CURRENCY, VALUE],
  Array.from({ length: 31 }, (_, index) => [`2026-10-${String(index + 1).padStart(2, "0")}`, "USD", (index + 1) * 1000]),
);

/** Two days of sales at two locations, in one currency. */
const byLocation = result([DAY, LOCATION, CURRENCY, VALUE], [
  ["2026-10-01", "Downtown", "USD", 10000],
  ["2026-10-01", "Airport", "USD", 10000],
  ["2026-10-02", "Downtown", "USD", 5000],
  ["2026-10-02", "Airport", "USD", 2500],
]);

/** The same amounts, split by currency instead of by location. */
const byCurrency = result([DAY, CURRENCY, VALUE], [
  ["2026-10-01", "USD", 10000],
  ["2026-10-01", "EUR", 10000],
  ["2026-10-02", "USD", 5000],
  ["2026-10-02", "EUR", 2500],
]);

/** The text of each label in one of a chart's label groups: "end" is the value axis, "middle" the category axis. */
function axisLabels(html: string, anchor: "end" | "middle"): string[] {
  const group = new RegExp(`<g style="fill:var\\(--data-muted\\)" text-anchor="${anchor}">(.*?)</g>`).exec(html);
  return Array.from((group?.[1] ?? "").matchAll(/<text[^>]*>([^<]*)<\/text>/g), match => match[1]);
}

describe("inferRoles", () => {
  it("takes the first date or text column as x, the numbers as y and a second text column as the series", () => {
    expect(inferRoles([DAY, LOCATION, CURRENCY, VALUE], { type: "line" }))
      .toEqual({ x: "day", y: ["value"], series: "location", currency: "currency" });
  });

  it("never takes a currency column for a category", () => {
    expect(inferRoles([CURRENCY, VALUE], { type: "kpi" })).toEqual({ x: null, y: ["value"], series: null, currency: "currency" });
    expect(inferRoles([DAY, CURRENCY, VALUE], { type: "bar" })).toEqual({ x: "day", y: ["value"], series: null, currency: "currency" });
  });

  it("lets the visual name its own columns", () => {
    const columns: ResultColumn[] = [DAY, LOCATION, { name: "channel", type: "text" }, CURRENCY, VALUE, { name: "orders", type: "integer" }];
    expect(inferRoles(columns, { type: "bar", x: "channel", y: ["orders"], series: "location" }))
      .toEqual({ x: "channel", y: ["orders"], series: "location", currency: "currency" });
    // A name the result does not have is ignored, and the role is inferred instead.
    expect(inferRoles(columns, { type: "bar", x: "nope", y: ["nope"], series: "nope" }))
      .toEqual({ x: "day", y: ["value", "orders"], series: "location", currency: "currency" });
  });

  it("reads an identifier as a category, never as a value", () => {
    const columns: ResultColumn[] = [{ name: "product_id", type: "integer" }, { name: "units", type: "real" }];
    expect(inferRoles(columns, { type: "bar" })).toEqual({ x: "product_id", y: ["units"], series: null, currency: null });
  });
});

describe("compatibleVisuals", () => {
  it("offers a KPI for a single figure and charts for a breakdown", () => {
    expect(compatibleVisuals([CURRENCY, VALUE], 1)).toEqual(["kpi", "table"]);
    expect(compatibleVisuals([DAY, CURRENCY, VALUE], 31)).toEqual(["line", "area", "bar", "table"]);
    expect(compatibleVisuals([LOCATION, CURRENCY, VALUE], 1)).toEqual(["kpi", "bar", "table"]);
  });

  it("offers a stacked bar only when there is something to stack", () => {
    expect(compatibleVisuals([DAY, LOCATION, CURRENCY, VALUE], 62)).toEqual(["line", "area", "bar", "stackedBar", "table"]);
    expect(compatibleVisuals([DAY, { name: "orders", type: "integer" }, { name: "units", type: "real" }], 31)).toContain("stackedBar");
  });

  it("offers only the table when nothing is numeric, and nothing for no columns", () => {
    expect(compatibleVisuals([LOCATION, { name: "channel", type: "text" }], 5)).toEqual(["table"]);
    expect(compatibleVisuals([], 0)).toEqual([]);
  });
});

describe("renderVisual", () => {
  it("draws every chart type as one labelled image with its summary", () => {
    for (const type of CHARTS) {
      const rendered = renderVisual(byLocation, { type }, SIZE);
      expect(rendered.summary).not.toBe("");
      expect(rendered.html.startsWith("<svg ")).toBe(true);
      expect(rendered.html.endsWith("</svg>")).toBe(true);
      expect(rendered.html).toContain('role="img"');
      expect(rendered.html).toContain(`aria-label="${escapeHtml(rendered.summary)}"`);
      expect(rendered.html).toContain('viewBox="0 0 480 240"');
    }
  });

  it("says in words what a line chart shows", () => {
    const rendered = renderVisual(october, { type: "line" }, SIZE);
    expect(rendered.summary).toBe(
      "Line chart of value by day, 31 points from 1 Oct 2026 to 31 Oct 2026. Highest $310.00 at 31 Oct 2026, lowest $10.00 at 1 Oct 2026.",
    );
    expect(rendered.notes).toEqual([]);
  });

  it("keeps to six value ticks and eight category labels", () => {
    const { html } = renderVisual(october, { type: "line" }, SIZE);
    expect(axisLabels(html, "end")).toEqual(["$0", "$100", "$200", "$300", "$400"]);
    expect(axisLabels(html, "middle")).toEqual(["1 Oct", "5 Oct", "9 Oct", "13 Oct", "17 Oct", "21 Oct", "25 Oct", "29 Oct"]);
    for (const type of CHARTS) {
      const chart = renderVisual(october, { type }, { width: 900, height: 300 }).html;
      expect(axisLabels(chart, "end").length).toBeLessThanOrEqual(6);
      expect(axisLabels(chart, "middle").length).toBeLessThanOrEqual(8);
    }
  });

  it("draws the same markup for the same input", () => {
    for (const type of [...CHARTS, "kpi", "table"] as const) {
      expect(renderVisual(byLocation, { type }, SIZE)).toEqual(renderVisual(byLocation, { type }, SIZE));
    }
  });

  it("uses the size it is given for the viewBox, and a default for a size that is not a number", () => {
    expect(renderVisual(october, { type: "bar" }, { width: 300.4, height: 180 }).html).toContain('viewBox="0 0 300 180"');
    expect(renderVisual(october, { type: "bar" }, { width: Number.NaN, height: Number.NaN }).html).toContain('viewBox="0 0 480 240"');
  });

  it("names every colour through the shared variables", () => {
    for (const type of CHARTS) {
      const { html } = renderVisual(byLocation, { type }, SIZE);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const name of ["--data-series-1", "--data-series-2", "--data-grid", "--data-axis", "--data-muted", "--data-text"]) {
        expect(html).toContain(`var(${name})`);
      }
    }
  });

  it("gives each value column its own series when nothing splits the rows", () => {
    const counts = result([DAY, { name: "orders", type: "integer" }, { name: "units", type: "real" }], [
      ["2026-10-01", 4, 9.5],
      ["2026-10-02", 6, 12],
    ]);
    const rendered = renderVisual(counts, { type: "line" }, SIZE);
    expect(rendered.summary).toBe("Line chart of orders and units by day, 2 series: Orders, Units, 2 points from 1 Oct 2026 to 2 Oct 2026.");
    expect(rendered.html).toContain(">Orders</text>");
    expect(rendered.html).toContain(">Units</text>");
  });

  it("stacks one currency's series and reads the stack on the axis", () => {
    const stacked = renderVisual(byLocation, { type: "stackedBar" }, SIZE);
    expect(stacked.summary).toBe("Stacked bar chart of value by day, 2 series: Downtown, Airport, 2 points from 1 Oct 2026 to 2 Oct 2026.");
    expect(axisLabels(stacked.html, "end")).toEqual(["$0", "$50", "$100", "$150", "$200"]);
    expect(stacked.notes).toEqual([]);
    const grouped = renderVisual(byLocation, { type: "bar" }, SIZE);
    expect(axisLabels(grouped.html, "end")).toEqual(["$0", "$20", "$40", "$60", "$80", "$100"]);
  });

  it("never stacks or adds amounts in different currencies", () => {
    const rendered = renderVisual(byCurrency, { type: "stackedBar" }, SIZE);
    expect(rendered.summary).toBe("Bar chart of value by day, 2 series: USD, EUR, 2 points from 1 Oct 2026 to 2 Oct 2026.");
    expect(rendered.notes).toEqual([CURRENCY_NOTE]);
    // The axis reaches the largest single amount (100), not the 200 a stack of both would reach,
    // and carries no currency sign because it serves two currencies.
    expect(axisLabels(rendered.html, "end")).toEqual(["0", "20", "40", "60", "80", "100"]);
    expect(rendered.html).toContain("<title>USD, 1 Oct 2026: $100.00</title>");
    expect(rendered.html).toContain("<title>EUR, 1 Oct 2026: €100.00</title>");
    expect(rendered.html).not.toContain("200.00");
  });

  it("keeps the eleven largest series and combines the rest as Other", () => {
    const rows: Scalar[][] = [];
    for (const day of ["2026-10-01", "2026-10-02"]) {
      for (let index = 1; index <= 15; index++) rows.push([day, `L${String(index).padStart(2, "0")}`, "USD", index * 1000]);
    }
    const rendered = renderVisual(result([DAY, LOCATION, CURRENCY, VALUE], rows), { type: "bar" }, SIZE);
    expect(rendered.notes).toEqual(["Showing the 11 largest of 15 series; the rest are combined as Other"]);
    expect(rendered.html).toContain(">L15</text>");
    expect(rendered.html).toContain(">L05</text>");
    expect(rendered.html).toContain(">Other</text>");
    expect(rendered.html).not.toContain(">L04</text>");
    // Other is the four smallest added up: 10 + 20 + 30 + 40 dollars.
    expect(rendered.html).toContain("<title>Other, 1 Oct 2026: $100.00</title>");
    expect(rendered.html).toContain("var(--data-series-12)");
    expect(rendered.html).not.toContain("--data-series-13");
    expect(rendered.summary).toContain("12 series: L15, L14, L13 and 9 more");
  });

  it("leaves out the smaller series instead of combining them when the currencies differ", () => {
    const rows: Scalar[][] = [];
    for (let index = 1; index <= 7; index++) {
      rows.push(["2026-10-01", `L${index}`, "USD", index * 1000], ["2026-10-01", `L${index}`, "EUR", index * 900]);
    }
    const rendered = renderVisual(result([DAY, LOCATION, CURRENCY, VALUE], rows), { type: "stackedBar" }, SIZE);
    expect(rendered.notes).toEqual([CURRENCY_NOTE, "Showing the 12 largest of 14 series"]);
    expect(rendered.html).toContain(">L7 · USD</text>");
    expect(rendered.html).not.toContain(">Other</text>");
    expect(rendered.summary.startsWith("Bar chart")).toBe(true);
  });

  it("shows a KPI's value with its change on the previous period", () => {
    const now = result([CURRENCY, VALUE], [["USD", 1234000]], {
      previous: { from: "2026-08-31", to: "2026-09-30", rows: [["USD", 1140000]] },
    });
    const up = renderVisual(now, { type: "kpi" }, SIZE);
    expect(up.summary).toBe("$12,340.00, up 8.2% on the previous 31 days");
    expect(up.html).toBe(
      '<div class="data-kpi" role="img" aria-label="$12,340.00, up 8.2% on the previous 31 days">'
      + '<div class="data-kpi-line"><div class="data-kpi-value">$12,340.00</div>'
      + '<div class="data-kpi-change">+8.2% on the previous 31 days</div></div></div>',
    );

    const down = renderVisual({ ...now, previous: { from: "2026-08-31", to: "2026-09-30", rows: [["USD", 1300000]] } }, { type: "kpi" }, SIZE);
    expect(down.summary).toBe("$12,340.00, down 5.1% on the previous 31 days");
    expect(down.html).toContain(">-5.1% on the previous 31 days<");

    const same = renderVisual({ ...now, previous: { from: "2026-09-30", to: "2026-09-30", rows: [["USD", 1234000]] } }, { type: "kpi" }, SIZE);
    expect(same.summary).toBe("$12,340.00, unchanged on the previous day");

    const fromNothing = renderVisual({ ...now, previous: { from: "2026-08-31", to: "2026-09-30", rows: [["USD", 0]] } }, { type: "kpi" }, SIZE);
    expect(fromNothing.summary).toBe("$12,340.00, with nothing in the previous 31 days to compare with");
  });

  it("shows a KPI without a comparison when none was asked for", () => {
    const rendered = renderVisual(result([{ name: "value", type: "real", label: "%" }], [[0.253]]), { type: "kpi" }, SIZE);
    expect(rendered.summary).toBe("25.3%");
    expect(rendered.html).toBe('<div class="data-kpi" role="img" aria-label="25.3%"><div class="data-kpi-line"><div class="data-kpi-value">25.3%</div></div></div>');
    const named = renderVisual(result([{ name: "open_orders", type: "integer" }], [[1234]]), { type: "kpi" }, SIZE);
    expect(named.summary).toBe("Open orders 1,234");
  });

  it("shows a KPI in several currencies as one line each, each compared with its own currency", () => {
    const mixed = result([CURRENCY, VALUE], [["USD", 1234000], ["EUR", 120000]], {
      previous: { from: "2026-08-31", to: "2026-09-30", rows: [["EUR", 100000], ["USD", 1140000]] },
    });
    const rendered = renderVisual(mixed, { type: "kpi" }, SIZE);
    expect(rendered.summary).toBe("$12,340.00, up 8.2% on the previous 31 days; €1,200.00, up 20% on the previous 31 days");
    expect(rendered.html.split('class="data-kpi-line"')).toHaveLength(3);
    expect(rendered.notes).toEqual([CURRENCY_NOTE]);
    // 12,340.00 + 1,200.00 would be 13,540.00: no such figure is ever written.
    expect(rendered.html).not.toContain("13,540");
  });

  it("returns the table and the text block for the two types that are not pictures", () => {
    const table = renderVisual(october, { type: "table" }, SIZE);
    expect(table.summary).toBe("Table with 31 rows and 3 columns: Day, Currency, Value.");
    expect(table.html.startsWith('<table class="data-table"><caption class="sr-only">Table with 31 rows and 3 columns: Day, Currency, Value.</caption>')).toBe(true);
    const text = renderVisual(october, { type: "text", text: "# Notes\n\nSales were **up**." }, SIZE);
    expect(text).toEqual({ html: "<h3>Notes</h3><p>Sales were <strong>up</strong>.</p>", summary: "Notes Sales were up.", notes: [] });
  });

  it("notes a truncated result and a partial margin", () => {
    const cut = renderVisual(result([DAY, CURRENCY, VALUE], october.rows.slice(0, 2), { truncated: true }), { type: "bar" }, SIZE);
    expect(cut.notes).toEqual(["Showing the first 2 rows"]);
    const partial = renderVisual(result([CURRENCY, VALUE], [["USD", 4200]], { partial: true, costCoverage: 0.82 }), { type: "kpi" }, SIZE);
    expect(partial.notes).toEqual(["Partial: covers 82% of units"]);
  });

  it("says so in words when there is nothing to draw", () => {
    for (const type of [...CHARTS, "kpi"] as const) {
      expect(renderVisual(result([DAY, CURRENCY, VALUE], []), { type }, SIZE)).toEqual({
        html: '<p class="data-empty">No data for this period.</p>',
        summary: "No data for this period.",
        notes: [],
      });
    }
    const words = renderVisual(result([LOCATION], [["Downtown"]]), { type: "bar" }, SIZE);
    expect(words.summary).toBe("This result has no numbers to draw. Show it as a table instead.");
  });

  it("escapes markup in labels wherever they are written", () => {
    const script = '<script>alert("x")</script>';
    const breakout = '" onload="alert(1)';
    const hostile = result([LOCATION, { name: "channel", type: "text" }, CURRENCY, VALUE], [
      [script, breakout, "USD", 100],
      ["Airport", "<img src=x onerror=alert(1)>", "USD", 200],
    ]);
    for (const type of [...CHARTS, "kpi", "table"] as const) {
      const { html } = renderVisual(hostile, { type }, SIZE);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain('" onload="');
    }
    const chart = renderVisual(hostile, { type: "bar" }, SIZE);
    expect(chart.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(chart.html).toContain("&quot; onload=&quot;alert(1)");
    // The summary is plain text for the caller to set as text; inside the markup it is escaped.
    expect(chart.summary).toContain(script);
    expect(chart.html).toContain(`aria-label="${escapeHtml(chart.summary)}"`);
  });
});

describe("renderTable", () => {
  const rows: Scalar[][] = Array.from({ length: 150 }, (_, index) => [`L${index}`, "USD", 1000 + index]);
  const many = result([LOCATION, CURRENCY, VALUE], rows);

  it("heads each column, aligns numbers right and formats each cell", () => {
    const html = renderTable(result([LOCATION, CURRENCY, VALUE], [["Downtown", "USD", 1000]]), {});
    expect(html).toBe(
      '<table class="data-table"><caption class="sr-only">Table with 1 row and 3 columns: Location, Currency, Value.</caption>'
      + '<thead><tr><th scope="col">Location</th><th scope="col">Currency</th><th scope="col" class="data-num">Value</th></tr></thead>'
      + '<tbody><tr><td>Downtown</td><td>USD</td><td class="data-num">$10.00</td></tr></tbody></table>',
    );
  });

  it("shows at most 100 rows unless told otherwise, and says how many there are", () => {
    const html = renderTable(many, {});
    expect(html.split('<td class="data-num">')).toHaveLength(101);
    expect(html).toContain('<tfoot><tr><td class="data-note" colspan="3">Showing first 100 of 150 rows</td></tr></tfoot>');
    const few = renderTable(many, { maxRows: 5 });
    expect(few.split('<td class="data-num">')).toHaveLength(6);
    expect(few).toContain("Showing first 5 of 150 rows");
    expect(renderTable(many, { maxRows: 150 })).not.toContain("<tfoot>");
  });

  it("says when there are no rows", () => {
    expect(renderTable(result([LOCATION, CURRENCY, VALUE], []), {})).toContain('<td class="data-note" colspan="3">No rows for this period.</td>');
  });

  it("escapes headings and cells", () => {
    const html = renderTable(result([{ name: "<b>name</b>", type: "text" }], [["<script>alert(1)</script>"]]), {});
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
  });
});

describe("renderMarkdownLite", () => {
  it("renders headings, paragraphs, bold, italic, lists and line breaks, and escapes everything else", () => {
    const text = [
      "# Title",
      "## Sub",
      "### Deep",
      "#### Not a heading",
      "",
      "Hello **bold** and *it*",
      "next line",
      "",
      "- one",
      "- two *x*",
      "",
      "2 * 3 * 4",
      "<img src=x onerror=alert(1)> [link](http://x)",
    ].join("\r\n");
    expect(renderMarkdownLite(text)).toBe(
      "<h3>Title</h3><h4>Sub</h4><h5>Deep</h5><p>#### Not a heading</p>"
      + "<p>Hello <strong>bold</strong> and <em>it</em><br>next line</p>"
      + "<ul><li>one</li><li>two <em>x</em></li></ul>"
      + "<p>2 * 3 * 4<br>&lt;img src=x onerror=alert(1)&gt; [link](http://x)</p>",
    );
  });

  it("writes no tag a person typed, in a heading, a list or a paragraph", () => {
    const html = renderMarkdownLite("# <script>a</script>\n- <script>b</script>\n\n**<script>c</script>**");
    expect(html).toBe(
      "<h3>&lt;script&gt;a&lt;/script&gt;</h3><ul><li>&lt;script&gt;b&lt;/script&gt;</li></ul>"
      + "<p><strong>&lt;script&gt;c&lt;/script&gt;</strong></p>",
    );
    expect(renderMarkdownLite("")).toBe("");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that can end text or an attribute", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  });
});

describe("DATA_STYLES", () => {
  it("defines every variable the charts use, for light, dark and print", () => {
    const names = [...Array.from({ length: 12 }, (_, index) => `--data-series-${index + 1}`), "--data-axis", "--data-grid", "--data-text", "--data-muted"];
    const [light, rest] = DATA_STYLES.split("@media screen and (prefers-color-scheme: dark)");
    const [dark, print] = rest.split("@media print");
    for (const name of names) {
      expect(light).toContain(`${name}:`);
      expect(dark).toContain(`${name}:`);
      expect(print).toContain(`${name}:`);
    }
    // An export of a page on a dark machine stays light.
    expect(dark).toContain(":root:not(.document-export)");
  });

  it("styles every class the builders emit", () => {
    for (const name of [".data-kpi", ".data-chart", ".data-table", ".data-note", ".data-empty", ".data-num", ".sr-only"]) {
      expect(DATA_STYLES).toContain(name);
    }
  });
});
