import { define } from "../utils.ts";
import { decodeQueryState } from "../lib/url-state.ts";
import ExploreLayout from "../islands/ExploreLayout.tsx";

export default define.page(function ExplorePage(ctx) {
  // Parse query state from URL
  const params = ctx.url.searchParams;
  const initialState = decodeQueryState(params);

  return (
    <div class="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Header */}
      <header class="h-14 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex items-center justify-between px-4">
        <div class="flex items-center gap-4">
          <h1 class="text-lg font-semibold text-[var(--accent)]">Inquire</h1>
          <div class="text-sm text-[var(--text-muted)]">
            Observability Explorer
          </div>
        </div>

        <div class="flex items-center gap-3">
          {/* Stream selector placeholder */}
          <button
            type="button"
            class="px-3 py-1.5 text-sm text-[var(--text-muted)]
                   bg-[var(--bg-primary)] border border-[var(--border)]
                   rounded-md hover:border-[var(--border-hover)]"
          >
            All Streams
          </button>

          {/* Settings button */}
          <button
            type="button"
            class="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]
                   hover:bg-[var(--bg-hover)] rounded-md"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </header>

      {/* Main explore layout */}
      <ExploreLayout initialState={initialState} />
    </div>
  );
});
