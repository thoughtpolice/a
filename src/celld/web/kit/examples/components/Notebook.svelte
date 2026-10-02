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
      <button class="min-h-11 rounded-md px-3 py-2 font-medium text-muted hover:bg-slate-100 hover:text-ink aria-selected:bg-ink aria-selected:text-white" type="button" data-tab="notebook" aria-selected={selected === 'notebook'}>Notebook</button>
      <button class="min-h-11 rounded-md px-3 py-2 font-medium text-muted hover:bg-slate-100 hover:text-ink aria-selected:bg-ink aria-selected:text-white" type="button" data-tab="preview" aria-selected={selected === 'preview'}>Draft preview</button>
    </div>
    <div class="relative" use:menu={{
      id: 'note-order',
      onSelect: onOrderChange,
    }}>
      <button class="flex min-h-11 items-center gap-2 rounded-md border border-slate-200 bg-surface px-3 text-sm font-medium hover:border-slate-400 aria-expanded:border-accent" type="button" data-menu-trigger>
        Display order
        <svg class="size-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
      </button>
      <div class="absolute right-0 top-full z-10 mt-2 w-44 rounded-md border border-slate-200 bg-surface p-1 shadow-lg" data-menu-panel hidden>
        <button class="block min-h-11 w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100" type="button" data-menu-item="newest">Newest first</button>
        <button class="block min-h-11 w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100" type="button" data-menu-item="oldest">Oldest first</button>
      </div>
    </div>
  </div>

  <section class="pt-6" data-tab-panel="notebook" hidden={selected !== 'notebook'}>
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-xl leading-7 font-semibold tracking-tight">Saved notes</h2>
      <span id="display-order" class="text-sm text-muted" role="status">{order === 'newest' ? 'Newest first' : 'Oldest first'}</span>
    </div>
    <div class="overflow-hidden rounded-lg border border-slate-200 bg-surface">
      {#if orderedNotes.length === 0}
        <div id="empty-notebook" class="px-6 py-8 sm:p-8">
          <h3 class="text-xl leading-7 font-semibold tracking-tight">The first page is yours.</h3>
          <p class="mt-2 max-w-[48ch] text-muted">A small observation, a question, a line you want to remember. Start with a title; details are optional.</p>
          <a class="mt-6 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4 hover:text-blue-700" href="#note-title">Write your first note</a>
        </div>
      {:else}
        <ol class="divide-y divide-slate-200" aria-label="Saved notes">
          {#each orderedNotes as note (note.id)}
            <li class="p-4 sm:p-6" data-note-id={note.id}>
              <article class="max-w-[75ch]">
                <h3 class="text-lg leading-7 font-semibold tracking-tight [overflow-wrap:anywhere]">{note.title}</h3>
                {#if note.body}<p class="mt-2 whitespace-pre-wrap text-slate-600 [overflow-wrap:anywhere]">{note.body}</p>{/if}
              </article>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </section>

  <section class="pt-6" data-tab-panel="preview" hidden={selected !== 'preview'}>
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-xl leading-7 font-semibold tracking-tight">Your draft</h2>
      <span class="rounded bg-accent/10 px-2 py-1 text-xs font-medium text-accent">Not saved yet</span>
    </div>
    <article id="draft-preview" class="min-h-64 rounded-lg border border-slate-200 bg-surface p-6 sm:p-8">
      <h3 class="max-w-[40ch] text-2xl leading-8 font-semibold tracking-tight [overflow-wrap:anywhere]">{draft.previewTitle}</h3>
      {#if draft.previewBody}
        <p class="mt-4 max-w-[75ch] whitespace-pre-wrap text-slate-600 [overflow-wrap:anywhere]">{draft.previewBody}</p>
      {:else}
        <p class="mt-4 text-muted">Optional details will appear here as you write.</p>
      {/if}
    </article>
    <p class="mt-3 max-w-[75ch] text-sm text-muted">This preview stays in this browser until you save. The title and details contribute to the word count.</p>
  </section>
</section>
