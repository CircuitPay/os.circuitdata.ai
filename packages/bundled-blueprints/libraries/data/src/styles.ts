/**
 * The stylesheet the builders' markup needs: the `--data-*` colours a chart is drawn in, and the
 * classes the KPI block, the chart, the table and the notes carry.
 *
 * A chart names no colour of its own. Every fill and stroke is a `var(--data-…)`, so one set of
 * variables recolours every chart on the page: light by default, dark when the system asks for
 * it, and light again for paper. The dark block skips `.document-export`, the class a gadget puts
 * on the root while it is being exported, so a PDF made on a dark machine is still a light page.
 */
export const DATA_STYLES = `
:root {
  --data-series-1: #2563eb;
  --data-series-2: #d97706;
  --data-series-3: #059669;
  --data-series-4: #dc2626;
  --data-series-5: #7c3aed;
  --data-series-6: #0891b2;
  --data-series-7: #db2777;
  --data-series-8: #4d7c0f;
  --data-series-9: #9a3412;
  --data-series-10: #475569;
  --data-series-11: #a21caf;
  --data-series-12: #0f766e;
  --data-axis: #6b7280;
  --data-grid: #e5e7eb;
  --data-text: #111827;
  --data-muted: #6b7280;
}
@media screen and (prefers-color-scheme: dark) {
  :root:not(.document-export) {
    --data-series-1: #60a5fa;
    --data-series-2: #fbbf24;
    --data-series-3: #34d399;
    --data-series-4: #f87171;
    --data-series-5: #a78bfa;
    --data-series-6: #22d3ee;
    --data-series-7: #f472b6;
    --data-series-8: #a3e635;
    --data-series-9: #fdba74;
    --data-series-10: #94a3b8;
    --data-series-11: #e879f9;
    --data-series-12: #2dd4bf;
    --data-axis: #9ca3af;
    --data-grid: #374151;
    --data-text: #f3f4f6;
    --data-muted: #9ca3af;
  }
}
.data-kpi {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--data-text);
}
.data-kpi-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.data-kpi-value {
  font-size: 28px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.data-kpi-change {
  font-size: 12px;
  color: var(--data-muted);
}
.data-chart {
  display: block;
  width: 100%;
  height: auto;
  max-height: 100%;
  overflow: visible;
  font-variant-numeric: tabular-nums;
}
.data-empty {
  margin: 0;
  padding: 12px 0;
  font-size: 13px;
  color: var(--data-muted);
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  color: var(--data-text);
  font-variant-numeric: tabular-nums;
}
.data-table th,
.data-table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--data-grid);
}
.data-table th {
  font-weight: 600;
  color: var(--data-muted);
}
.data-table .data-num {
  text-align: right;
  white-space: nowrap;
}
.data-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--data-muted);
}
.data-table td.data-note {
  margin: 0;
  text-align: left;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media print {
  :root {
    --data-series-1: #2563eb;
    --data-series-2: #d97706;
    --data-series-3: #059669;
    --data-series-4: #dc2626;
    --data-series-5: #7c3aed;
    --data-series-6: #0891b2;
    --data-series-7: #db2777;
    --data-series-8: #4d7c0f;
    --data-series-9: #9a3412;
    --data-series-10: #475569;
    --data-series-11: #a21caf;
    --data-series-12: #0f766e;
    --data-axis: #4b5563;
    --data-grid: #d1d5db;
    --data-text: #000000;
    --data-muted: #4b5563;
  }
  .data-kpi,
  .data-chart,
  .data-table tr {
    break-inside: avoid;
  }
  .data-chart,
  .data-table {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .data-table thead {
    display: table-header-group;
  }
}
`;
