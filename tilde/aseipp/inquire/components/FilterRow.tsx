import type { Filter, FilterOperator } from "../types/query.ts";
import { Dropdown } from "./Dropdown.tsx";

interface FilterRowProps {
  filter: Filter;
  fields: string[];
  onUpdate: (filter: Filter) => void;
  onRemove: () => void;
}

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "=", label: "=" },
  { value: "!=", label: "!=" },
  { value: "~", label: "~ (regex)" },
  { value: "!~", label: "!~ (not regex)" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: "contains", label: "contains" },
];

export function FilterRow({ filter, fields, onUpdate, onRemove }: FilterRowProps) {
  const fieldOptions = fields.map((f) => ({ value: f, label: f }));

  return (
    <div class="flex items-center gap-2 p-2 bg-[var(--bg-secondary)] rounded-md border border-[var(--border)]">
      <Dropdown
        options={fieldOptions}
        value={filter.field}
        onChange={(field) => onUpdate({ ...filter, field })}
        placeholder="Field"
        searchable
        className="flex-1 min-w-0"
      />

      <Dropdown
        options={OPERATORS}
        value={filter.operator}
        onChange={(op) => onUpdate({ ...filter, operator: op as FilterOperator })}
        className="w-24"
      />

      <input
        type="text"
        value={filter.value}
        onInput={(e) => onUpdate({ ...filter, value: (e.target as HTMLInputElement).value })}
        placeholder="Value"
        class="flex-1 min-w-0 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)]
               rounded-md text-sm text-[var(--text-primary)]
               focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
      />

      <button
        type="button"
        onClick={onRemove}
        class="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]
               hover:bg-[var(--bg-hover)] rounded-md"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
