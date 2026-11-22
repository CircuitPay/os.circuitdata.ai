import { Input, LayerCard, Select, Table, Text } from "@cloudflare/kumo";
import type { MappingDocument, SniffResult, StagedImportFile } from "../../src/app-api-types";
import { formatBytes } from "../format";

type Parsing = NonNullable<MappingDocument["parsing"]>;
type Delimiter = SniffResult["delimiter"];

const DELIMITER_LABELS: Record<Delimiter, string> = {
  ",": "Comma",
  ";": "Semicolon",
  "\t": "Tab",
  "|": "Pipe",
};

const DETECTED = "detected";

const DELIMITER_ITEMS: Record<string, string> = { [DETECTED]: "As detected", ...DELIMITER_LABELS };

/** Drops unset fields so an untouched override leaves `parsing` absent. */
function compact(parsing: Parsing): Parsing | undefined {
  const entries = Object.entries(parsing).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as Parsing);
}

function wholeNumber(text: string, minimum: number): number | undefined {
  const value = Number.parseInt(text, 10);
  return Number.isInteger(value) && value >= minimum ? value : undefined;
}

/**
 * The sniffed encoding, delimiter, header row and footer rows of each file, and the overrides
 * that apply to every file of the import (Edge "malformed CSV": nothing is mis-parsed silently).
 */
const ParsingSettings = ({
  files,
  parsing,
  onChange,
}: {
  files: StagedImportFile[];
  parsing: MappingDocument["parsing"];
  onChange: (parsing: MappingDocument["parsing"]) => void;
}) => {
  const set = (change: Parsing) => onChange(compact({ ...parsing, ...change }));
  return (
    <section aria-labelledby="parsing-heading" className="flex flex-col gap-3">
      <Text variant="heading" as="h3" id="parsing-heading">
        Files
      </Text>
      <LayerCard className="overflow-x-auto p-0">
        <Table>
          <caption className="sr-only">Files and how they were read</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>File</Table.Head>
              <Table.Head>Part of the set</Table.Head>
              <Table.Head>Size</Table.Head>
              <Table.Head>Encoding</Table.Head>
              <Table.Head>Delimiter</Table.Head>
              <Table.Head>Header row</Table.Head>
              <Table.Head>Footer rows</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {files.map((file) => (
              <Table.Row key={file.rawObjectId}>
                <Table.Head>{file.name}</Table.Head>
                <Table.Cell>{file.role ?? "—"}</Table.Cell>
                <Table.Cell>{formatBytes(file.bytes)}</Table.Cell>
                <Table.Cell>{file.sniff.encoding}</Table.Cell>
                <Table.Cell>{DELIMITER_LABELS[file.sniff.delimiter]}</Table.Cell>
                <Table.Cell>{file.sniff.headerRow}</Table.Cell>
                <Table.Cell>{file.sniff.footerRows}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </LayerCard>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 font-medium">Read every file differently</legend>
        <Input
          label="Encoding"
          placeholder="As detected"
          description="e.g. utf-8, windows-1252"
          value={parsing?.encoding ?? ""}
          onChange={(event) => set({ encoding: event.target.value.trim() || undefined })}
        />
        <Select
          label="Delimiter"
          items={DELIMITER_ITEMS}
          value={parsing?.delimiter ?? DETECTED}
          onValueChange={(value) =>
            set({ delimiter: value === DETECTED ? undefined : (value as Delimiter) })
          }
        />
        <Input
          label="Header row"
          type="number"
          min={1}
          placeholder="As detected"
          value={parsing?.headerRow ?? ""}
          onChange={(event) => set({ headerRow: wholeNumber(event.target.value, 1) })}
        />
        <Input
          label="Footer rows"
          type="number"
          min={0}
          placeholder="As detected"
          value={parsing?.footerRows ?? ""}
          onChange={(event) => set({ footerRows: wholeNumber(event.target.value, 0) })}
        />
      </fieldset>
    </section>
  );
};

export default ParsingSettings;
