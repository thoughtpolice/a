import { useState } from "preact/hooks";
import type { LogEntry } from "../types/visualization.ts";

interface LogRowProps {
  entry: LogEntry;
  onFieldClick?: (field: string, value: unknown) => void;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  warning: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-gray-400",
};

export function LogRow({ entry, onFieldClick }: LogRowProps) {
  const [expanded, setExpanded] = useState(false);

  const levelColor = entry.level ? LEVEL_COLORS[entry.level.toLowerCase()] || "text-[var(--text-primary)]" : "";
  const timestamp = new Date(entry.timestamp).toISOString().slice(11, 23);

  const fieldEntries = Object.entries(entry.fields).filter(
    ([key]) => key !== "_msg" && key !== "_time" && key !== "level"
  );

  return (
    <div class="border-b border-[var(--border)] hover:bg-[var(--bg-hover)]">
      <div
        class="flex items-start gap-3 px-3 py-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <button
          type="button"
          class="mt-0.5 p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <svg
            class={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        <span class="text-[var(--text-muted)] font-mono text-xs whitespace-nowrap">
          {timestamp}
        </span>

        {entry.level && (
          <span class={`font-mono text-xs uppercase w-12 ${levelColor}`}>
            {entry.level}
          </span>
        )}

        <span class="flex-1 text-sm text-[var(--text-primary)] truncate">
          {entry.message}
        </span>
      </div>

      {expanded && (
        <div class="px-10 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border)]">
          <div class="grid gap-1">
            {fieldEntries.map(([key, value]) => (
              <div key={key} class="flex items-start gap-2 text-sm">
                <span class="text-[var(--text-muted)] font-mono min-w-[120px]">
                  {key}:
                </span>
                <span
                  class="text-[var(--text-primary)] font-mono break-all cursor-pointer
                         hover:text-[var(--accent)] hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFieldClick?.(key, value);
                  }}
                >
                  {typeof value === "object" ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
