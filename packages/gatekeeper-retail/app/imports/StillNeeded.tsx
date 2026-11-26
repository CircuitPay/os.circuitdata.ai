import { LayerCard, Text } from "@cloudflare/kumo";

/** What the mapping still lacks (`missingRequirements`), announced as it changes. */
const StillNeeded = ({ missing }: { missing: string[] }) => (
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
);

export default StillNeeded;
