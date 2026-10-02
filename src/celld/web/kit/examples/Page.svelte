<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { PageData } from '@celld/web/fieldnotes/contracts';
  import type { ActionState } from '@celld/web/kit/actions';
  import type { NavigationState } from '@celld/web/kit/navigation';
  import Guide from './components/Guide.svelte';
  import Header from './components/Header.svelte';
  import NoteEditor from './components/NoteEditor.svelte';
  import Notebook from './components/Notebook.svelte';
  import { createDraft } from './draft.svelte.ts';

  let { view, notes }: PageData = $props();
  const draft = createDraft();
  let navigation = $state<NavigationState<PageData>>({ status: 'idle' });
  let action = $state<ActionState<PageData>>({ status: 'idle' });
  let selected = $state('notebook');
  let order = $state('newest');

  // The browser commits only current results; these synchronous bridges never load data.
  export function setPage(page: PageData): void {
    view = page.view;
    notes = page.notes;
    selected = 'notebook';
  }

  export function setNavigation(state: NavigationState<PageData>): void {
    navigation = state;
  }

  export function setAction(state: ActionState<PageData>): void {
    action = state;
    if (state.status === 'success') {
      setPage(state.data);
      draft.reset();
    }
  }
</script>

<svelte:head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<div class="mx-auto min-h-screen max-w-[1240px] px-4 font-sans text-[15px] leading-6 text-ink sm:px-8">
  <Header {view} />

  <div class="text-sm text-muted data-[state=error]:text-error" data-state={navigation.status} role="status" aria-live="polite">
    {#if navigation.status === 'pending'}
      <p class="ui-notice mt-4 px-4">Loading page… Your notebook stays here until the next page is ready.</p>
    {:else if navigation.status === 'error'}
      <p class="ui-notice mt-4 px-4" data-tone="error">This page could not be loaded. Your notebook is unchanged. Try the link again or reload the page.</p>
    {/if}
  </div>

  <main id="fieldnotes-main" class="py-6 sm:py-8 aria-busy:cursor-progress" aria-busy={navigation.status === 'pending'}>
    {#if view === 'notes'}
      <div class="mb-6 max-w-2xl sm:mb-8">
        <h1 class="ui-heading text-[28px] leading-8 font-bold sm:text-[32px] sm:leading-10" data-page-focus>Your notebook</h1>
        <p class="mt-2 text-muted">A place for things worth noticing. Write a thought, keep it for later.</p>
      </div>

      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        <NoteEditor {draft} {action} />
        <Notebook {notes} {draft} {selected} {order}
          onSelect={(value) => { selected = value; }}
          onOrderChange={(value) => { order = value; }} />
      </div>
    {:else}
      <Guide />
    {/if}
  </main>

  <footer class="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-slate-200 py-6 text-xs leading-5 text-muted"><span class="font-semibold text-ink">Fieldnotes</span><span>A working celld web-kit notebook.</span></footer>

</div>

