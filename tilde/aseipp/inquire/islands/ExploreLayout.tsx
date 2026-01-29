import type { Signal } from "@preact/signals";
import { useSignal, effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { QueryState, ViewMode, TimeRange } from "../types/query.ts";
import { decodeQueryState, buildExploreUrl } from "../lib/url-state.ts";
import QuerySidebar from "./QuerySidebar.tsx";
import ResultsPanel from "./ResultsPanel.tsx";

interface ExploreLayoutProps {
  initialState: QueryState;
}

export default function ExploreLayout({ initialState }: ExploreLayoutProps) {
  const queryState = useSignal<QueryState>(initialState);

  // Sync URL when query state changes
  useEffect(() => {
    const unsubscribe = effect(() => {
      const newUrl = buildExploreUrl(queryState.value);
      const currentUrl = globalThis.location.pathname + globalThis.location.search;

      if (newUrl !== currentUrl) {
        globalThis.history.pushState({}, "", newUrl);
      }
    });

    return () => unsubscribe();
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(globalThis.location.search);
      queryState.value = decodeQueryState(params);
    };

    globalThis.addEventListener("popstate", handlePopState);
    return () => globalThis.removeEventListener("popstate", handlePopState);
  }, []);

  const handleRunQuery = () => {
    console.log("Running query:", queryState.value);
    // TODO: Actually execute the query against VictoriaLogs
  };

  const handleFieldClick = (field: string, value: unknown) => {
    // Add a filter for the clicked field
    const newFilter = {
      id: `filter-${Date.now()}`,
      field,
      operator: "=" as const,
      value: String(value),
      enabled: true,
    };
    queryState.value = {
      ...queryState.value,
      filters: [...queryState.value.filters, newFilter],
    };
  };

  // Create mutable signal wrappers for ResultsPanel
  const viewModeSignal: Signal<ViewMode> = {
    get value() { return queryState.value.viewMode; },
    set value(v: ViewMode) {
      queryState.value = { ...queryState.value, viewMode: v };
    },
  } as Signal<ViewMode>;

  const timeRangeSignal: Signal<TimeRange> = {
    get value() { return queryState.value.timeRange; },
    set value(v: TimeRange) {
      queryState.value = { ...queryState.value, timeRange: v };
    },
  } as Signal<TimeRange>;

  return (
    <div class="flex h-[calc(100vh-56px)] overflow-hidden">
      <QuerySidebar
        queryState={queryState}
        onRunQuery={handleRunQuery}
      />
      <ResultsPanel
        viewMode={viewModeSignal}
        timeRange={timeRangeSignal}
        onFieldClick={handleFieldClick}
      />
    </div>
  );
}
