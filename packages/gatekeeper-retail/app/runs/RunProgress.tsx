import { Text } from "@cloudflare/kumo";
import type { RunProgress as Progress } from "../../src/app-api-types";
import { formatCount } from "../format";

function describe(progress: Progress): string {
  const done = `${formatCount(progress.done)} of ${formatCount(progress.total)}`;
  const eta =
    progress.etaSeconds === null
      ? ""
      : `, about ${progress.etaSeconds < 90 ? `${Math.max(1, Math.round(progress.etaSeconds))} seconds` : `${Math.round(progress.etaSeconds / 60)} minutes`} left`;
  return `${progress.phase}: ${done}${eta}`;
}

/**
 * A run's progress. Kumo's `Meter` is `role="meter"` (a measurement such as quota use), so a run
 * gets a `progressbar` with a text value instead (FR-023), drawn with the Meter's tokens.
 */
const RunProgress = ({ label, progress }: { label: string; progress: Progress }) => {
  const text = describe(progress);
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-valuetext={text}
        className="relative h-2 w-full overflow-hidden rounded-full bg-kumo-fill"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-kumo-brand transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <Text variant="secondary" size="sm">
        {text}
      </Text>
    </div>
  );
};

export default RunProgress;
