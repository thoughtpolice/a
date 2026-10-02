<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { PageData } from '@celld/web/fieldnotes/contracts';
  import KeyboardHelp from './KeyboardHelp.svelte';

  let { view }: { view: PageData['view'] } = $props();
  let trigger = $state<HTMLButtonElement>();
</script>

<header class="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-slate-200 py-5 sm:gap-x-8 sm:py-6">
  <a href="/" class="flex items-center gap-2 text-xl font-bold tracking-tight" aria-label="Fieldnotes home">
    <svg class="size-6 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
      <path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 3v18M12 8h4M12 12h4" />
    </svg>
    Fieldnotes
  </a>
  <nav class="order-3 flex w-full gap-6 sm:order-none sm:w-auto" aria-label="Notebook pages">
    <a id="notes-link" href="/" class="ui-nav-link" aria-current={view === 'notes' ? 'page' : undefined}>Notebook</a>
    <a id="guide-link" href="/guide" class="ui-nav-link" aria-current={view === 'guide' ? 'page' : undefined}>Guide</a>
  </nav>
  <button id="keyboard-help" class="ui-button ml-auto text-sm" type="button" bind:this={trigger}>Keyboard help</button>
</header>
<KeyboardHelp {trigger} />
