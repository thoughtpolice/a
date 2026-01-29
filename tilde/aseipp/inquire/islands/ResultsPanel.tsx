import type { Signal } from "@preact/signals";
import type { ViewMode, TimeRange } from "../types/query.ts";
import type { LogEntry } from "../types/visualization.ts";
import HeatmapChart from "./HeatmapChart.tsx";
import { LogRow } from "../components/LogRow.tsx";

interface ResultsPanelProps {
  viewMode: Signal<ViewMode>;
  timeRange: Signal<TimeRange>;
  onFieldClick?: (field: string, value: unknown) => void;
}

// Mock log entries for demonstration
const MOCK_LOGS: LogEntry[] = [
  {
    timestamp: Date.now() - 1000,
    level: "error",
    message: "Connection timeout after 30s - host unreachable",
    fields: {
      host: "api-server-01",
      service: "gateway",
      duration_ms: 30000,
      trace_id: "abc123",
    },
  },
  {
    timestamp: Date.now() - 5000,
    level: "warn",
    message: "Rate limit approaching threshold (85%)",
    fields: {
      host: "api-server-02",
      service: "ratelimiter",
      current_rate: 850,
      max_rate: 1000,
    },
  },
  {
    timestamp: Date.now() - 12000,
    level: "info",
    message: "Request completed successfully",
    fields: {
      host: "api-server-01",
      service: "auth",
      duration_ms: 45,
      status_code: 200,
    },
  },
  {
    timestamp: Date.now() - 18000,
    level: "debug",
    message: "Cache hit for user preferences",
    fields: {
      host: "cache-01",
      service: "cache",
      key: "user:123:prefs",
      ttl: 3600,
    },
  },
  {
    timestamp: Date.now() - 25000,
    level: "error",
    message: "Database query failed - deadlock detected",
    fields: {
      host: "db-primary",
      service: "postgres",
      query_id: "q-789",
      duration_ms: 5000,
    },
  },
];

const VIEW_TABS: { mode: ViewMode; label: string }[] = [
  { mode: "heatmap", label: "Heatmap" },
  { mode: "logs", label: "Logs" },
  { mode: "table", label: "Table" },
];

export default function ResultsPanel({
  viewMode,
  timeRange,
  onFieldClick,
}: ResultsPanelProps) {
  const timeLabel = timeRange.value.type === "relative"
    ? `Last ${timeRange.value.relative}`
    : "Custom range";

  return (
    <div class="flex-1 flex flex-col min-h-0 bg-[var(--bg-primary)]">
      {/* Header with view tabs and time indicator */}
      <div class="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
        <div class="flex items-center gap-1">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              onClick={() => {
                viewMode.value = tab.mode;
              }}
              class={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                viewMode.value === tab.mode
                  ? "bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div class="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {timeLabel}
        </div>
      </div>

      {/* Content area */}
      <div class="flex-1 overflow-auto p-4">
        {viewMode.value === "heatmap" && (
          <div class="h-full flex flex-col">
            <HeatmapChart
              width={900}
              height={280}
            />
            <div class="mt-4 text-sm text-[var(--text-muted)]">
              Click a cell to drill down into that time period
            </div>
          </div>
        )}

        {viewMode.value === "logs" && (
          <div class="border border-[var(--border)] rounded-md overflow-hidden">
            {MOCK_LOGS.map((entry, i) => (
              <LogRow
                key={i}
                entry={entry}
                onFieldClick={onFieldClick}
              />
            ))}
          </div>
        )}

        {viewMode.value === "table" && (
          <div class="border border-[var(--border)] rounded-md overflow-hidden">
            <table class="w-full text-sm">
              <thead class="bg-[var(--bg-secondary)]">
                <tr>
                  <th class="px-4 py-2 text-left text-[var(--text-muted)] font-medium">Time</th>
                  <th class="px-4 py-2 text-left text-[var(--text-muted)] font-medium">Level</th>
                  <th class="px-4 py-2 text-left text-[var(--text-muted)] font-medium">Service</th>
                  <th class="px-4 py-2 text-left text-[var(--text-muted)] font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_LOGS.map((entry, i) => (
                  <tr key={i} class="border-t border-[var(--border)] hover:bg-[var(--bg-hover)]">
                    <td class="px-4 py-2 text-[var(--text-muted)] font-mono text-xs whitespace-nowrap">
                      {new Date(entry.timestamp).toISOString().slice(11, 23)}
                    </td>
                    <td class="px-4 py-2">
                      <span class={`text-xs uppercase ${
                        entry.level === "error" ? "text-red-400" :
                        entry.level === "warn" ? "text-yellow-400" :
                        entry.level === "info" ? "text-blue-400" :
                        "text-gray-400"
                      }`}>
                        {entry.level}
                      </span>
                    </td>
                    <td class="px-4 py-2 text-[var(--text-primary)]">
                      {entry.fields.service as string}
                    </td>
                    <td class="px-4 py-2 text-[var(--text-primary)] truncate max-w-md">
                      {entry.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
