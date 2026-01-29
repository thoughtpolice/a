import type { Signal } from "@preact/signals";
import { Dropdown } from "../components/Dropdown.tsx";
import { Chip } from "../components/Chip.tsx";

interface GroupBySelectorProps {
  groupBy: Signal<string[]>;
  availableFields: string[];
}

export default function GroupBySelector({ groupBy, availableFields }: GroupBySelectorProps) {
  const unusedFields = availableFields.filter(
    (f) => !groupBy.value.includes(f)
  );
  const fieldOptions = unusedFields.map((f) => ({ value: f, label: f }));

  const addGroupBy = (field: string) => {
    if (field && !groupBy.value.includes(field)) {
      groupBy.value = [...groupBy.value, field];
    }
  };

  const removeGroupBy = (field: string) => {
    groupBy.value = groupBy.value.filter((f) => f !== field);
  };

  return (
    <div class="space-y-2">
      {/* Selected group by fields */}
      {groupBy.value.length > 0 && (
        <div class="flex flex-wrap gap-2">
          {groupBy.value.map((field) => (
            <Chip
              key={field}
              label={field}
              onRemove={() => removeGroupBy(field)}
              variant="active"
            />
          ))}
        </div>
      )}

      {/* Add more dropdown */}
      {unusedFields.length > 0 && (
        <Dropdown
          options={fieldOptions}
          value=""
          onChange={addGroupBy}
          placeholder="+ Add group by..."
          searchable
          className="w-full"
        />
      )}
    </div>
  );
}
