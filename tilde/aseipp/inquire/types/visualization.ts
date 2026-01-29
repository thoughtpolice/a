export interface HeatmapCell {
  x: number; // time bucket index
  y: number; // group bucket index
  value: number; // count or aggregated value
  timestamp: number; // actual timestamp for tooltip
  group?: string; // group label if grouped
}

export interface HeatmapData {
  cells: HeatmapCell[];
  xLabels: string[]; // time labels
  yLabels: string[]; // group labels
  minValue: number;
  maxValue: number;
  bucketCount: number;
}

export interface LogEntry {
  timestamp: number;
  level?: string;
  message: string;
  fields: Record<string, unknown>;
}
