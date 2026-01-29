import type { Signal } from "@preact/signals";
import type { Filter } from "../types/query.ts";
import { FilterRow } from "../components/FilterRow.tsx";
import { Chip } from "../components/Chip.tsx";

interface WhereFiltersProps {
  filters: Signal<Filter[]>;
  availableFields: string[];
}

function generateFilterId(): string {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function WhereFilters({ filters, availableFields }: WhereFiltersProps) {
  const addFilter = () => {
    filters.value = [
      ...filters.value,
      {
        id: generateFilterId(),
        field: availableFields[0] || "",
        operator: "=",
        value: "",
        enabled: true,
      },
    ];
  };

  const updateFilter = (id: string, updated: Filter) => {
    filters.value = filters.value.map((f) =>
      f.id === id ? updated : f
    );
  };

  const removeFilter = (id: string) => {
    filters.value = filters.value.filter((f) => f.id !== id);
  };

  // Compact view when there are filters
  const activeFilters = filters.value.filter((f) => f.enabled && f.field && f.value);

  return (
    <div class="space-y-2">
      {/* Compact chips view */}
      {activeFilters.length > 0 && (
        <div class="flex flex-wrap gap-2">
          {activeFilters.map((filter) => (
            <Chip
              key={filter.id}
              label={`${filter.field} ${filter.operator} ${filter.value}`}
              onRemove={() => removeFilter(filter.id)}
              variant="active"
            />
          ))}
        </div>
      )}

      {/* Expanded filter rows */}
      <div class="space-y-2">
        {filters.value.map((filter) => (
          <FilterRow
            key={filter.id}
            filter={filter}
            fields={availableFields}
            onUpdate={(updated) => updateFilter(filter.id, updated)}
            onRemove={() => removeFilter(filter.id)}
          />
        ))}
      </div>

      {/* Add filter button */}
      <button
        type="button"
        onClick={addFilter}
        class="flex items-center gap-2 px-3 py-2 text-sm
               text-[var(--text-muted)] hover:text-[var(--text-primary)]
               hover:bg-[var(--bg-hover)] rounded-md w-full"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        Add Filter
      </button>
    </div>
  );
}
