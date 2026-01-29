import type { Signal } from "@preact/signals";
import type { QueryState } from "../types/query.ts";
import TimeRangeSelector from "./TimeRangeSelector.tsx";
import VisualizationSelector from "./VisualizationSelector.tsx";
import WhereFilters from "./WhereFilters.tsx";
import GroupBySelector from "./GroupBySelector.tsx";

interface QuerySidebarProps {
  queryState: Signal<QueryState>;
  onRunQuery: () => void;
}

// Mock available fields - in real app, these would come from schema discovery
const AVAILABLE_FIELDS = [
  "level",
  "service",
  "host",
  "message",
  "duration_ms",
  "status_code",
  "trace_id",
  "user_id",
  "path",
  "method",
];

const NUMERIC_FIELDS = [
  "duration_ms",
  "status_code",
  "response_size",
  "request_count",
];

export default function QuerySidebar({ queryState, onRunQuery }: QuerySidebarProps) {
  // Create derived signals for each part of the query state
  // These update the parent state when modified
  const timeRange = {
    get value() { return queryState.value.timeRange; },
    set value(v) { queryState.value = { ...queryState.value, timeRange: v }; },
  } as Signal<QueryState["timeRange"]>;

  const visualize = {
    get value() { return queryState.value.visualize; },
    set value(v) { queryState.value = { ...queryState.value, visualize: v }; },
  } as Signal<QueryState["visualize"]>;

  const visualizeField = {
    get value() { return queryState.value.visualizeField; },
    set value(v) { queryState.value = { ...queryState.value, visualizeField: v }; },
  } as Signal<QueryState["visualizeField"]>;

  const filters = {
    get value() { return queryState.value.filters; },
    set value(v) { queryState.value = { ...queryState.value, filters: v }; },
  } as Signal<QueryState["filters"]>;

  const groupBy = {
    get value() { return queryState.value.groupBy; },
    set value(v) { queryState.value = { ...queryState.value, groupBy: v }; },
  } as Signal<QueryState["groupBy"]>;

  return (
    <aside class="w-72 min-w-[280px] flex-shrink-0 border-r border-[var(--border)] bg-[var(--bg-primary)] overflow-y-auto">
      <div class="p-4 space-y-6">
        {/* DEFINE section header */}
        <div>
          <h2 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Define
          </h2>

          {/* Time Range */}
          <div class="space-y-2">
            <label class="text-sm font-medium text-[var(--text-primary)]">
              Time Range
            </label>
            <TimeRangeSelector timeRange={timeRange} />
          </div>
        </div>

        {/* VISUALIZE section */}
        <div>
          <h2 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Visualize
          </h2>
          <VisualizationSelector
            visualize={visualize}
            visualizeField={visualizeField}
            availableFields={NUMERIC_FIELDS}
          />
        </div>

        {/* WHERE section */}
        <div>
          <h2 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Where
          </h2>
          <WhereFilters
            filters={filters}
            availableFields={AVAILABLE_FIELDS}
          />
        </div>

        {/* GROUP BY section */}
        <div>
          <h2 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Group By
          </h2>
          <GroupBySelector
            groupBy={groupBy}
            availableFields={AVAILABLE_FIELDS}
          />
        </div>

        {/* Run Query button */}
        <button
          type="button"
          onClick={onRunQuery}
          class="w-full px-4 py-2.5 bg-[var(--accent)] text-white font-medium
                 rounded-md hover:opacity-90 focus:outline-none focus:ring-2
                 focus:ring-[var(--accent)] focus:ring-offset-2 focus:ring-offset-[var(--bg-primary)]"
        >
          Run Query
        </button>
      </div>
    </aside>
  );
}
