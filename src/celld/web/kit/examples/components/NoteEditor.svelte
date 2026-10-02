<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { PageData } from '@celld/web/fieldnotes/contracts';
  import type { ActionState } from '@celld/web/kit/actions';
  import { disclosure, tooltip } from '@celld/web/interactions';
  import type { Draft } from '../draft.svelte.ts';

  let { draft, action }: { draft: Draft; action: ActionState<PageData> } = $props();
  let bodyOpen = $state(true);
  const validation = $derived(action.status === 'error' && action.error.kind === 'validation' ? action.error.error : undefined);
  const titleError = $derived((validation?.fieldErrors.title ?? []).join(' '));
  const bodyError = $derived((validation?.fieldErrors.body ?? []).join(' '));
  const actionError = $derived.by(() => {
    if (action.status !== 'error') return '';
    const failure = action.error;
    if (failure.kind === 'validation') {
      return failure.error.formErrors.join(' ') || 'Check your note below, then save again.';
    } else if (failure.kind === 'transport') {
      return 'The server could not be reached. Your draft is still here. Check your connection, then save again.';
    } else if (failure.kind === 'cancelled') {
      return 'Saving was interrupted. Your draft is still here; save again when you are ready.';
    } else if (failure.kind === 'auth') {
      return 'The server refused this save. Your draft is still here. Reload the page before trying again.';
    } else if (failure.kind === 'request') {
      return 'This note could not be sent. Check the title and details, then save again.';
    } else if (failure.kind === 'response') {
      return 'The server reply could not be read. Keep your draft and reload the notebook to check whether it was saved before trying again.';
    }
    return 'The server could not save this note. Your draft is still here. Try saving again.';
  });

  // Reopen before the browser's synchronous state bridge restores field focus.
  $effect.pre(() => {
    if (bodyError) bodyOpen = true;
  });
</script>

<aside class="min-w-0 rounded-lg border border-slate-200 bg-surface p-4 sm:p-6 lg:order-2" aria-labelledby="composer-title">
  <h2 id="composer-title" class="text-xl leading-7 font-semibold tracking-tight">New note</h2>
  <p class="mt-1 text-sm text-muted">A title is enough. Add a little context if you like.</p>
  <form id="add-note" class="mt-6" method="post" action="/notes" aria-busy={action.status === 'pending'}>
    <fieldset class="min-w-0 disabled:opacity-60" disabled={action.status === 'pending'}>
      <legend class="sr-only">Write a new note</legend>
      <label class="mb-2 block font-medium" for="note-title">Title</label>
      <input id="note-title" class="block min-h-11 w-full min-w-0 rounded-md border border-slate-300 bg-surface px-3 py-2 text-base focus:border-accent aria-invalid:border-error aria-invalid:ring-1 aria-invalid:ring-error" name="title" type="text" required minlength="3" maxlength="80"
        bind:value={draft.title} aria-describedby="title-hint title-error" aria-invalid={titleError !== ''} />
      <p id="title-hint" class="mt-2 text-xs leading-5 text-muted">3–80 characters. Surrounding spaces are trimmed when saved.</p>
      <p id="title-error" class="mt-2 text-sm text-error [overflow-wrap:anywhere] empty:hidden">{titleError}</p>

      <section class="mt-4" use:disclosure={{
        id: 'note-details', open: bodyOpen, onOpenChange: (value) => { bodyOpen = value; },
      }}>
        <button class="flex min-h-11 w-full items-center justify-between gap-2 border-b border-slate-200 py-2 text-left font-medium after:text-lg after:text-muted after:content-['−'] aria-[expanded=false]:after:content-['+'] hover:text-accent" type="button" data-disclosure-trigger>Optional note details</button>
        <div class="pt-4" data-disclosure-panel>
          <label class="mb-2 block font-medium" for="note-body">Details <span class="text-sm font-normal text-muted">(optional)</span></label>
          <textarea id="note-body" class="block w-full min-w-0 resize-y rounded-md border border-slate-300 bg-surface px-3 py-2 text-base leading-6 focus:border-accent aria-invalid:border-error aria-invalid:ring-1 aria-invalid:ring-error" name="body" rows="5" maxlength="400" bind:value={draft.body}
            aria-describedby="body-hint body-error" aria-invalid={bodyError !== ''}></textarea>
          <p id="body-hint" class="mt-2 text-xs leading-5 text-muted">Up to 400 characters. {draft.body.length}/400 used.</p>
          <p id="body-error" class="mt-2 text-sm text-error [overflow-wrap:anywhere] empty:hidden">{bodyError}</p>
        </div>
      </section>

      <p id="draft-word-count" class="mt-4 text-sm text-muted" role="status" aria-live="polite">{draft.wordCount} {draft.wordCount === 1 ? 'word' : 'words'} in this draft</p>
      <button id="save-note" class="mt-3 min-h-11 w-full rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-wait" type="submit">{action.status === 'pending' ? 'Saving note…' : 'Save note'}</button>
    </fieldset>
    {#if action.status === 'pending'}
      <p class="mt-3 text-sm text-muted" role="status">Saving to the server…</p>
    {:else if action.status === 'error'}
      <p class="mt-3 rounded-md border border-error/20 bg-error/5 p-3 text-sm text-error [overflow-wrap:anywhere]" role="alert" data-action-error>{actionError}</p>
    {:else if action.status === 'success'}
      <p class="mt-3 rounded-md border border-accent/20 bg-accent/5 p-3 text-sm text-ink" role="status" data-action-success>Note saved. Your notebook is up to date.</p>
    {/if}
  </form>

  <div class="relative mt-6 border-t border-slate-200 pt-3" use:tooltip={{ id: 'notebook-storage', delay: 200 }}>
    <button class="min-h-11 text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-ink" type="button" data-tooltip-trigger>Saved on the server</button>
    <span class="absolute bottom-full left-0 z-20 w-full rounded-md bg-ink p-3 text-sm text-white shadow-lg" data-tooltip-content hidden>Saved notes live in persistent server-side storage, not browser memory. Reloading the page reads the notebook again.</span>
  </div>
  <p class="text-xs leading-5 text-muted">This example is a shared notebook, not a private account. Do not save sensitive information.</p>
  <noscript><p class="mt-3 text-xs leading-5 text-muted">You can save notes and open the guide without JavaScript. Draft previews and keyboard widgets require it.</p></noscript>
</aside>
