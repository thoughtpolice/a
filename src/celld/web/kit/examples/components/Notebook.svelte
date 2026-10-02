<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { Note } from '@celld/web/fieldnotes/contracts';
  import type { Draft } from '../draft.svelte.ts';
  import { menu, tabs } from '@celld/web/interactions';

  let { notes, draft, selected, order, onSelect, onOrderChange }: {
    notes: Note[];
    draft: Draft;
    selected: string;
    order: string;
    onSelect: (value: string) => void;
    onOrderChange: (value: string) => void;
  } = $props();

  const orderedNotes = $derived(order === 'oldest' ? [...notes].reverse() : notes);
</script>

<section class="min-w-0 lg:order-1" aria-label="Saved notes and draft preview" use:tabs={{
  id: 'notebook-views', selected, onSelect,
}}>
  <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
    <div class="flex gap-1" data-tab-list aria-label="Notebook panels">
      <button class="ui-button ui-tab" type="button" data-tab="notebook" aria-selected={selected === 'notebook'}>Notebook</button>
      <button class="ui-button ui-tab" type="button" data-tab="preview" aria-selected={selected === 'preview'}>Draft preview</button>
    </div>
    <div class="relative" use:menu={{
      id: 'note-order',
      onSelect: onOrderChange,
    }}>
      <button class="ui-button ui-menu-trigger" type="button" data-menu-trigger>
        Display order
        <svg class="size-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
      </button>
      <div class="ui-panel ui-menu" data-menu-panel hidden>
        <button class="ui-button ui-button-quiet ui-menu-item" type="button" data-menu-item="newest">Newest first</button>
        <button class="ui-button ui-button-quiet ui-menu-item" type="button" data-menu-item="oldest">Oldest first</button>
      </div>
    </div>
  </div>

  <section class="pt-6" data-tab-panel="notebook" hidden={selected !== 'notebook'}>
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="ui-heading">Saved notes</h2>
      <span id="display-order" class="ui-hint text-sm" role="status">{order === 'newest' ? 'Newest first' : 'Oldest first'}</span>
    </div>
    <div class="ui-panel overflow-hidden">
      {#if orderedNotes.length === 0}
        <div id="empty-notebook" class="px-6 py-8 sm:p-8">
          <h3 class="ui-heading">The first page is yours.</h3>
          <p class="mt-2 max-w-[48ch] text-muted">A small observation, a question, a line you want to remember. Start with a title; details are optional.</p>
          <a class="ui-link mt-6" href="#note-title">Write your first note</a>
        </div>
      {:else}
        <ol class="divide-y divide-slate-200" aria-label="Saved notes">
          {#each orderedNotes as note (note.id)}
            <li class="p-4 sm:p-6" data-note-id={note.id}>
              <article class="max-w-[75ch]">
                <h3 class="ui-heading text-lg">{note.title}</h3>
                {#if note.body}<p class="ui-body mt-2">{note.body}</p>{/if}
              </article>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </section>

  <section class="pt-6" data-tab-panel="preview" hidden={selected !== 'preview'}>
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="ui-heading">Your draft</h2>
      <span class="rounded bg-accent/10 px-2 py-1 text-xs font-medium text-accent">Not saved yet</span>
    </div>
    <article id="draft-preview" class="ui-panel min-h-64 p-6 sm:p-8">
      <h3 class="ui-heading max-w-[40ch] text-2xl leading-8">{draft.previewTitle}</h3>
      {#if draft.previewBody}
        <p class="ui-body mt-4 max-w-[75ch]">{draft.previewBody}</p>
      {:else}
        <p class="mt-4 text-muted">Optional details will appear here as you write.</p>
      {/if}
    </article>
    <p class="ui-hint mt-3 max-w-[75ch] text-sm">This preview stays in this browser until you save. The title and details contribute to the word count.</p>
  </section>
</section>
