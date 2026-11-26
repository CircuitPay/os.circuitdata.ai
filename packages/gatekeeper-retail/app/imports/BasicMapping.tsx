import { Badge, Banner, Input, Radio, Select, Text } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import { useState } from "react";
import type { MappingDocument, RunSummary, StagedImport } from "../../src/app-api-types";
import { formatDate } from "../format";
import {
  basicFields,
  columnOfField,
  previouslyImported,
  rowLevelOf,
  setFieldColumn,
  setRowLevel,
  type RowLevel,
} from "./basicFields";
import { columnKey, columnLabel, missingRequirements, sourceColumns } from "./mapping";
import StillNeeded from "./StillNeeded";

const NOT_IN_FILE = "none";

/**
 * The basic mapping (FR-009 to FR-011): whether a row is an order or an item sold, one column per
 * field the import needs, and the settings a file cannot state, over the same mapping the full
 * editor edits.
 */
const BasicMapping = ({
  staged,
  mapping,
  onChange,
  runs,
}: {
  staged: StagedImport;
  mapping: MappingDocument;
  onChange: (mapping: MappingDocument) => void;
  /** Recent runs, to tell the member when a file was imported before. */
  runs: RunSummary[];
}) => {
  // Item level is only visible in the mapping once an item field is mapped, so the choice is kept
  // here until then.
  const [chosenLevel, setChosenLevel] = useState<RowLevel>(() => rowLevelOf(mapping));
  const level = rowLevelOf(mapping) === "item" ? "item" : chosenLevel;
  const columns = sourceColumns(staged.files, mapping);
  const reimported = previouslyImported(staged, runs);
  const settings = mapping.settings;
  const setSettings = (change: Partial<MappingDocument["settings"]>) =>
    onChange({ ...mapping, settings: { ...settings, ...change } });

  const columnItems: Record<string, string> = {};
  for (const column of columns) {
    const name = columnLabel(column.ref);
    columnItems[column.key] = column.sample ? `${name} (e.g. ${column.sample})` : name;
  }

  return (
    <section aria-labelledby="basic-mapping-heading" className="flex flex-col gap-4">
      {reimported !== null && (
        <Banner
          icon={<Info />}
          title="This file was imported before"
          description={`This file looks like one imported on ${formatDate(reimported.at)}. Importing it again updates those rows rather than adding new ones.`}
        />
      )}
      <Text variant="heading" as="h3" id="basic-mapping-heading">
        Columns
      </Text>
      <Radio.Group
        legend="Each row is one"
        appearance="segmented"
        orientation="horizontal"
        value={level}
        onValueChange={(value: RowLevel) => {
          setChosenLevel(value);
          if (value !== level) onChange(setRowLevel(mapping, value));
        }}
      >
        <Radio.Item label="Order" value="order" />
        <Radio.Item label="Item sold" value="item" />
      </Radio.Group>
      <div className="grid gap-3 sm:grid-cols-2">
        {basicFields(level).map(({ field, label, required }) => {
          const column = columnOfField(mapping, field);
          const isOrderKey = field === "orderKey";
          // An order key is settled by a column or by "None", which identifies orders by a fingerprint.
          const matched = column !== null || (isOrderKey && Boolean(mapping.fingerprint?.length));
          const needed = !matched && (required || isOrderKey);
          const items = isOrderKey
            ? { [NOT_IN_FILE]: "None: each row is one order", ...columnItems }
            : { [NOT_IN_FILE]: "Not in this file", ...columnItems };
          return (
            <Select
              key={field}
              label={label}
              required={required || isOrderKey}
              placeholder="Not matched yet"
              items={items}
              value={column !== null ? columnKey(column) : isOrderKey && !matched ? null : NOT_IN_FILE}
              description={needed ? <Badge variant="warning">Needed</Badge> : undefined}
              onValueChange={(value) =>
                onChange(
                  setFieldColumn(
                    mapping,
                    field,
                    columns.find((entry) => entry.key === value)?.ref ?? null,
                    staged.files,
                  ),
                )
              }
            />
          );
        })}
      </div>
      {level === "item" && columnOfField(mapping, "orderKey") === null && (
        <Text variant="secondary">
          Without an order identifier, each item sold becomes an order of its own. Pick the column
          that groups items into orders, such as a receipt or order number, if the file has one.
        </Text>
      )}
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-medium">Settings the file does not state</legend>
        <Input
          label="Timezone"
          description="The location's IANA timezone, e.g. America/New_York."
          value={settings.timezone}
          onChange={(event) => setSettings({ timezone: event.target.value })}
        />
        <Input
          label="Currency"
          description="Three letters, e.g. USD."
          value={settings.currency}
          maxLength={3}
          onChange={(event) => setSettings({ currency: event.target.value.toUpperCase() })}
        />
        <Input
          label="Date format"
          description="e.g. MM/dd/yyyy HH:mm:ss or yyyy-MM-dd."
          value={settings.dateFormat}
          onChange={(event) => setSettings({ dateFormat: event.target.value })}
        />
      </fieldset>
      <StillNeeded missing={missingRequirements(mapping, staged.targets)} />
    </section>
  );
};

export default BasicMapping;
