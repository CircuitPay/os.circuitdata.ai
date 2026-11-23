import { LayerCard, Table } from "@cloudflare/kumo";
import type { StagedImportFile } from "../../src/app-api-types";
import { sampleFileRow, sampleRowId } from "./sampleRows";

/**
 * A staged file's headers and first rows, unmasked (members may see their own file). Each row can
 * take focus, so a preview problem can move the member to it.
 */
const FileSample = ({
  importId,
  fileIndex,
  file,
}: {
  importId: number;
  fileIndex: number;
  file: StagedImportFile;
}) => (
  <LayerCard className="max-h-96 overflow-auto p-0">
    <Table>
      <caption className="p-3 text-left font-medium">
        {file.name}: first {file.sampleRows.length} rows
      </caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Row</Table.Head>
          {file.headers.map((header, index) => (
            <Table.Head key={index}>
              {header}
            </Table.Head>
          ))}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {file.sampleRows.map((row, index) => {
          const fileRow = sampleFileRow(file, index);
          return (
            <Table.Row
              key={index}
              id={sampleRowId(importId, fileIndex, fileRow)}
              tabIndex={-1}
              className="focus:outline-2 focus:outline-kumo-focus"
            >
              <Table.Head>{fileRow}</Table.Head>
              {row.map((cell, cellIndex) => (
                <Table.Cell key={cellIndex}>{cell ?? ""}</Table.Cell>
              ))}
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  </LayerCard>
);

export default FileSample;
