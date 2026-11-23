import type { StagedImportFile } from "../../src/app-api-types";

/** The 1-based file row of sample row `index`: the rows right after the sniffed header row. */
export function sampleFileRow(file: StagedImportFile, index: number): number {
  return file.sniff.headerRow + 1 + index;
}

export function sampleRowId(importId: number, fileIndex: number, fileRow: number): string {
  return `import-${importId}-file-${fileIndex}-row-${fileRow}`;
}

/** The element id of the sample row a problem names (a file name and 1-based row), if it is shown. */
export function problemSampleRowId(
  importId: number,
  files: StagedImportFile[],
  file: string | null,
  row: number | null,
): string | null {
  if (row === null) return null;
  const fileIndex = file === null && files.length === 1 ? 0 : files.findIndex((entry) => entry.name === file);
  if (fileIndex < 0) return null;
  const index = row - sampleFileRow(files[fileIndex], 0);
  if (index < 0 || index >= files[fileIndex].sampleRows.length) return null;
  return sampleRowId(importId, fileIndex, row);
}
