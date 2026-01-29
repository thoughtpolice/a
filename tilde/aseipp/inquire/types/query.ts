export type FilterOperator = "=" | "!=" | "~" | "!~" | ">" | "<" | "contains";

export interface Filter {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
  enabled: boolean;
}

export type VisualizationType =
  | "count"
  | "avg"
  | "sum"
  | "min"
  | "max"
  | "p50"
  | "p95"
  | "p99";

export type ViewMode = "heatmap" | "logs" | "table";

export interface TimeRange {
  type: "relative" | "absolute";
  relative?: string; // "5m", "1h", "24h", "7d"
  start?: number; // Unix timestamp
  end?: number;
}

export interface QueryState {
  stream?: string;
  visualize: VisualizationType;
  visualizeField?: string;
  filters: Filter[];
  groupBy: string[];
  timeRange: TimeRange;
  viewMode: ViewMode;
}

export const DEFAULT_QUERY_STATE: QueryState = {
  visualize: "count",
  filters: [],
  groupBy: [],
  timeRange: { type: "relative", relative: "15m" },
  viewMode: "heatmap",
};
