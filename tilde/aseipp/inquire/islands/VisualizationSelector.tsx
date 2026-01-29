import type { Signal } from "@preact/signals";
import type { VisualizationType } from "../types/query.ts";
import { Dropdown } from "../components/Dropdown.tsx";

interface VisualizationSelectorProps {
  visualize: Signal<VisualizationType>;
  visualizeField: Signal<string | undefined>;
  availableFields: string[];
}

const VISUALIZATION_TYPES = [
  { value: "count", label: "COUNT" },
  { value: "avg", label: "AVG" },
  { value: "sum", label: "SUM" },
  { value: "min", label: "MIN" },
  { value: "max", label: "MAX" },
  { value: "p50", label: "P50" },
  { value: "p95", label: "P95" },
  { value: "p99", label: "P99" },
];

const NEEDS_FIELD = ["avg", "sum", "min", "max", "p50", "p95", "p99"];

export default function VisualizationSelector({
  visualize,
  visualizeField,
  availableFields,
}: VisualizationSelectorProps) {
  const needsField = NEEDS_FIELD.includes(visualize.value);
  const fieldOptions = availableFields.map((f) => ({ value: f, label: f }));

  return (
    <div class="space-y-2">
      <Dropdown
        options={VISUALIZATION_TYPES}
        value={visualize.value}
        onChange={(value) => {
          visualize.value = value as VisualizationType;
        }}
        className="w-full"
      />

      {needsField && (
        <Dropdown
          options={fieldOptions}
          value={visualizeField.value || ""}
          onChange={(value) => {
            visualizeField.value = value;
          }}
          placeholder="Select field..."
          searchable
          className="w-full"
        />
      )}
    </div>
  );
}
