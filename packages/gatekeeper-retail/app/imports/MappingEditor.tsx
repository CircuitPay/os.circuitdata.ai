import { Checkbox, Input, LayerCard, Select, Table, Text } from "@cloudflare/kumo";
import type {
  MappingDocument,
  MappingTransform,
  StagedImportFile,
  TargetInfo,
} from "../../src/app-api-types";
import {
  assignColumn,
  columnKey,
  columnLabel,
  missingRequirements,
  sameColumn,
  setColumnTransform,
  sourceColumns,
  targetOfColumn,
} from "./mapping";

const NONE = "none";

const TRANSFORM_LABELS: Record<MappingTransform, string> = {
  date: "Date",
  datetime: "Date and time",
  time: "Time",
  money: "Amount",
  negate_money: "Amount, sign flipped",
  quantity: "Quantity",
  percent: "Percentage",
  lowercase: "Lower case",
  uppercase: "Upper case",
  trim: "Trim spaces",
  boolean: "Yes or no",
  split_name_first: "First name of a full name",
  split_name_last: "Last name of a full name",
};

const TRANSFORM_ITEMS: Record<string, string> = { [NONE]: "As is", ...TRANSFORM_LABELS };

const DECIMAL_MARK_ITEMS: Record<MappingDocument["settings"]["decimalMark"], string> = {
  ".": "Point (1,234.56)",
  ",": "Comma (1.234,56)",
};

type BusinessDate = NonNullable<MappingDocument["settings"]["businessDate"]>;

const BUSINESS_DATE_ITEMS: Record<BusinessDate | typeof NONE, string> = {
  [NONE]: "Automatic",
  from_column: "From the business date column",
  from_timestamp: "From the order's time",
  from_file_date: "The date of the export",
};

/**
 * The mapping editor (FR-023): one row per source column with a labelled target and transform,
 * the settings a file cannot state, the order key, and a live list of what is still missing.
 */
const MappingEditor = ({
  mapping,
  files,
  targets,
  onChange,
}: {
  mapping: MappingDocument;
  files: StagedImportFile[];
  targets: TargetInfo[];
  onChange: (mapping: MappingDocument) => void;
}) => {
  const columns = sourceColumns(files, mapping);
  const missing = missingRequirements(mapping, targets);
  const targetItems: Record<string, string> = { [NONE]: "Not imported" };
  for (const target of targets) targetItems[target.path] = `${target.label} (${target.path})`;
  const targetLabel = (path: string) => targets.find((target) => target.path === path)?.label ?? path;
  const settings = mapping.settings;
  const setSettings = (change: Partial<MappingDocument["settings"]>) =>
    onChange({ ...mapping, settings: { ...settings, ...change } });
  const constants = mapping.targets.filter((target) => target.from === null);
  const mappedPaths = [...new Set(mapping.targets.map((target) => target.target))];
  const orderKeyItems: Record<string, string> = { [NONE]: "None: each row is one order" };
  for (const column of columns) orderKeyItems[column.key] = columnLabel(column.ref);

  return (
    <section aria-labelledby="mapping-heading" className="flex flex-col gap-4">
      <Text variant="heading" as="h3" id="mapping-heading">
        Mapping
      </Text>
      <LayerCard className="overflow-x-auto p-0">
        <Table>
          <caption className="sr-only">Where each column of the files goes</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Column</Table.Head>
              <Table.Head>First value</Table.Head>
              <Table.Head>Imported as</Table.Head>
              <Table.Head>Transform</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {columns.map((column) => {
              const name = columnLabel(column.ref);
              const current = targetOfColumn(mapping, column.ref);
              const others = mapping.targets.filter(
                (target) =>
                  target !== current && target.from !== null && sameColumn(target.from, column.ref),
              );
              return (
                <Table.Row key={column.key}>
                  <Table.Head>{name}</Table.Head>
                  <Table.Cell>{column.sample ?? ""}</Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-col gap-1">
                      <Select
                        aria-label={`Imported as, for ${name}`}
                        items={targetItems}
                        value={current?.target ?? NONE}
                        onValueChange={(value) =>
                          onChange(
                            assignColumn(
                              mapping,
                              column.ref,
                              targets.find((target) => target.path === value) ?? null,
                            ),
                          )
                        }
                      />
                      {others.length > 0 && (
                        <Text variant="secondary" size="sm">
                          Also: {others.map((target) => targetLabel(target.target)).join(", ")}
                        </Text>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Select
                      aria-label={`Transform for ${name}`}
                      items={TRANSFORM_ITEMS}
                      disabled={!current}
                      value={current?.transform ?? NONE}
                      onValueChange={(value) =>
                        onChange(
                          setColumnTransform(
                            mapping,
                            column.ref,
                            value === NONE ? null : (value as MappingTransform),
                          ),
                        )
                      }
                    />
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </LayerCard>
      {constants.length > 0 && (
        <div className="flex flex-col gap-1">
          <Text bold>Set without a column</Text>
          <ul className="list-disc pl-5">
            {constants.map((target) => (
              <li key={target.target}>
                {targetLabel(target.target)}: {String(target.constant ?? "")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-medium">Settings the file does not state</legend>
        <Input
          label="Timezone"
          description="The location's IANA timezone, e.g. America/New_York."
          value={settings.timezone}
          onChange={(event) => setSettings({ timezone: event.target.value })}
        />
        <Input
          label="Currency"
          description="ISO 4217 code, used when no currency column is mapped."
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
        <Select
          label="Decimal mark"
          items={DECIMAL_MARK_ITEMS}
          value={settings.decimalMark}
          onValueChange={(value) => setSettings({ decimalMark: value === "," ? "," : "." })}
        />
        <Select
          label="Business date"
          items={BUSINESS_DATE_ITEMS}
          value={settings.businessDate ?? NONE}
          onValueChange={(value) =>
            setSettings({ businessDate: value === NONE ? undefined : (value as BusinessDate) })
          }
        />
        {settings.businessDate === "from_file_date" && (
          <Input
            label="Business date of the export"
            type="date"
            value={settings.fileDate ?? ""}
            onChange={(event) => setSettings({ fileDate: event.target.value || undefined })}
          />
        )}
        <Select
          label="Order key"
          description="Rows sharing this column's value form one order."
          items={orderKeyItems}
          value={mapping.orderKey === null ? NONE : columnKey(mapping.orderKey)}
          onValueChange={(value) =>
            onChange({
              ...mapping,
              orderKey: columns.find((column) => column.key === value)?.ref ?? null,
            })
          }
        />
      </fieldset>
      {mapping.orderKey === null && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">Fields that identify an order without a key</legend>
          <Text variant="secondary" size="sm">
            Without an order id, a later edit of an old order cannot be matched to it.
          </Text>
          {mappedPaths.length === 0 ? (
            <Text variant="secondary">Map some columns first.</Text>
          ) : (
            mappedPaths.map((path) => (
              <Checkbox
                key={path}
                label={targetLabel(path)}
                checked={mapping.fingerprint?.includes(path) ?? false}
                onCheckedChange={(checked) => {
                  const rest = (mapping.fingerprint ?? []).filter((entry) => entry !== path);
                  onChange({ ...mapping, fingerprint: checked ? [...rest, path] : rest });
                }}
              />
            ))
          )}
        </fieldset>
      )}
      <div aria-live="polite" aria-atomic="true" aria-label="Still needed">
        {missing.length === 0 ? (
          <Text variant="secondary">Everything an import needs is mapped.</Text>
        ) : (
          <LayerCard className="flex flex-col gap-1 p-3">
            <Text bold>Still needed</Text>
            <ul className="list-disc pl-5">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </LayerCard>
        )}
      </div>
    </section>
  );
};

export default MappingEditor;
