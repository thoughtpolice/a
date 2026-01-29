import type { Signal } from "@preact/signals";
import type { TimeRange } from "../types/query.ts";
import { Dropdown } from "../components/Dropdown.tsx";

interface TimeRangeSelectorProps {
  timeRange: Signal<TimeRange>;
}

const TIME_PRESETS = [
  { value: "5m", label: "Last 5 minutes" },
  { value: "15m", label: "Last 15 minutes" },
  { value: "30m", label: "Last 30 minutes" },
  { value: "1h", label: "Last 1 hour" },
  { value: "3h", label: "Last 3 hours" },
  { value: "6h", label: "Last 6 hours" },
  { value: "12h", label: "Last 12 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

export default function TimeRangeSelector({ timeRange }: TimeRangeSelectorProps) {
  const currentValue = timeRange.value.type === "relative"
    ? timeRange.value.relative || "15m"
    : "custom";

  return (
    <Dropdown
      options={TIME_PRESETS}
      value={currentValue}
      onChange={(value) => {
        timeRange.value = {
          type: "relative",
          relative: value,
        };
      }}
      className="w-full"
    />
  );
}
