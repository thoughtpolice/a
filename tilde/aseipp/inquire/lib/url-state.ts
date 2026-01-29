import type { Filter, QueryState, TimeRange, ViewMode, VisualizationType } from "../types/query.ts";
import { DEFAULT_QUERY_STATE } from "../types/query.ts";

// URL param keys
const PARAM = {
  visualize: "v",
  visualizeField: "vf",
  timeRelative: "t",
  timeStart: "ts",
  timeEnd: "te",
  filters: "f",
  groupBy: "g",
  viewMode: "m",
  stream: "s",
} as const;

// Encode a single filter: field=value, field~value, field!=value, etc.
function encodeFilter(filter: Filter): string {
  if (!filter.enabled) return "";
  return `${encodeURIComponent(filter.field)}${filter.operator}${encodeURIComponent(filter.value)}`;
}

// Parse filter string back to Filter object
function parseFilter(str: string, index: number): Filter | null {
  // Match: field<operator>value where operator is one of: =, !=, ~, !~, >, <, contains
  const operators = ["!=", "!~", "~", "=", ">", "<", "contains"] as const;

  for (const op of operators) {
    const idx = str.indexOf(op);
    if (idx > 0) {
      const field = decodeURIComponent(str.slice(0, idx));
      const value = decodeURIComponent(str.slice(idx + op.length));
      return {
        id: `filter-${index}-${Date.now()}`,
        field,
        operator: op,
        value,
        enabled: true,
      };
    }
  }
  return null;
}

// Encode filters array to URL param value
function encodeFilters(filters: Filter[]): string {
  return filters
    .filter((f) => f.enabled)
    .map(encodeFilter)
    .filter(Boolean)
    .join(",");
}

// Parse filters from URL param value
function parseFilters(str: string): Filter[] {
  if (!str) return [];
  return str
    .split(",")
    .map((s, i) => parseFilter(s.trim(), i))
    .filter((f): f is Filter => f !== null);
}

// Encode time range
function encodeTimeRange(time: TimeRange): Record<string, string> {
  if (time.type === "relative" && time.relative) {
    return { [PARAM.timeRelative]: time.relative };
  }
  if (time.type === "absolute" && time.start && time.end) {
    return {
      [PARAM.timeStart]: String(time.start),
      [PARAM.timeEnd]: String(time.end),
    };
  }
  return { [PARAM.timeRelative]: "15m" };
}

// Parse time range from URL params
function parseTimeRange(params: URLSearchParams): TimeRange {
  const relative = params.get(PARAM.timeRelative);
  const start = params.get(PARAM.timeStart);
  const end = params.get(PARAM.timeEnd);

  if (start && end) {
    return {
      type: "absolute",
      start: parseInt(start, 10),
      end: parseInt(end, 10),
    };
  }
  return {
    type: "relative",
    relative: relative || "15m",
  };
}

// Encode full QueryState to URL search params
export function encodeQueryState(state: QueryState): URLSearchParams {
  const params = new URLSearchParams();

  // Visualize
  if (state.visualize !== DEFAULT_QUERY_STATE.visualize) {
    params.set(PARAM.visualize, state.visualize);
  }
  if (state.visualizeField) {
    params.set(PARAM.visualizeField, state.visualizeField);
  }

  // Time range
  const timeParams = encodeTimeRange(state.timeRange);
  for (const [key, value] of Object.entries(timeParams)) {
    params.set(key, value);
  }

  // Filters
  const filtersStr = encodeFilters(state.filters);
  if (filtersStr) {
    params.set(PARAM.filters, filtersStr);
  }

  // Group by
  if (state.groupBy.length > 0) {
    params.set(PARAM.groupBy, state.groupBy.join(","));
  }

  // View mode
  if (state.viewMode !== DEFAULT_QUERY_STATE.viewMode) {
    params.set(PARAM.viewMode, state.viewMode);
  }

  // Stream
  if (state.stream) {
    params.set(PARAM.stream, state.stream);
  }

  return params;
}

// Decode URL search params to QueryState
export function decodeQueryState(params: URLSearchParams): QueryState {
  const visualize = (params.get(PARAM.visualize) || DEFAULT_QUERY_STATE.visualize) as VisualizationType;
  const visualizeField = params.get(PARAM.visualizeField) || undefined;
  const timeRange = parseTimeRange(params);
  const filters = parseFilters(params.get(PARAM.filters) || "");
  const groupBy = params.get(PARAM.groupBy)?.split(",").filter(Boolean) || [];
  const viewMode = (params.get(PARAM.viewMode) || DEFAULT_QUERY_STATE.viewMode) as ViewMode;
  const stream = params.get(PARAM.stream) || undefined;

  return {
    stream,
    visualize,
    visualizeField,
    filters,
    groupBy,
    timeRange,
    viewMode,
  };
}

// Build URL path with encoded query state
export function buildExploreUrl(state: QueryState): string {
  const params = encodeQueryState(state);
  const search = params.toString();
  return search ? `/explore?${search}` : "/explore";
}
