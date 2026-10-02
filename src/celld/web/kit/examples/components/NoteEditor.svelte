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

<aside class="ui-panel p-4 sm:p-6 lg:order-2" aria-labelledby="composer-title">
  <h2 id="composer-title" class="ui-heading">New note</h2>
  <p class="ui-hint mt-1 text-sm">A title is enough. Add a little context if you like.</p>
  <form id="add-note" class="mt-6" method="post" action="/notes" aria-busy={action.status === 'pending'}>
    <fieldset class="ui-fieldset" disabled={action.status === 'pending'}>
      <legend class="sr-only">Write a new note</legend>
      <label class="ui-label" for="note-title">Title</label>
      <input id="note-title" class="ui-input" name="title" type="text" required minlength="3" maxlength="80"
        bind:value={draft.title} aria-describedby="title-hint title-error" aria-invalid={titleError !== ''} />
      <p id="title-hint" class="ui-hint mt-2">3–80 characters. Surrounding spaces are trimmed when saved.</p>
      <p id="title-error" class="ui-error mt-2">{titleError}</p>

      <section class="mt-4" use:disclosure={{
        id: 'note-details', open: bodyOpen, onOpenChange: (value) => { bodyOpen = value; },
      }}>
        <button class="ui-disclosure-trigger" type="button" data-disclosure-trigger>Optional note details</button>
        <div class="pt-4" data-disclosure-panel>
          <label class="ui-label" for="note-body">Details <span class="text-sm font-normal text-muted">(optional)</span></label>
          <textarea id="note-body" class="ui-input" name="body" rows="5" maxlength="400" bind:value={draft.body}
            aria-describedby="body-hint body-error" aria-invalid={bodyError !== ''}></textarea>
          <p id="body-hint" class="ui-hint mt-2">Up to 400 characters. {draft.body.length}/400 used.</p>
          <p id="body-error" class="ui-error mt-2">{bodyError}</p>
        </div>
      </section>

      <p id="draft-word-count" class="ui-hint mt-4 text-sm" role="status" aria-live="polite">{draft.wordCount} {draft.wordCount === 1 ? 'word' : 'words'} in this draft</p>
      <button id="save-note" class="ui-button ui-button-primary mt-3 w-full disabled:cursor-wait" type="submit">{action.status === 'pending' ? 'Saving note…' : 'Save note'}</button>
    </fieldset>
    {#if action.status === 'pending'}
      <p class="ui-hint mt-3 text-sm" role="status">Saving to the server…</p>
    {:else if action.status === 'error'}
      <p class="ui-notice mt-3" data-tone="error" role="alert" data-action-error>{actionError}</p>
    {:else if action.status === 'success'}
      <p class="ui-notice mt-3" data-tone="success" role="status" data-action-success>Note saved. Your notebook is up to date.</p>
    {/if}
  </form>

  <div class="relative mt-6 border-t border-slate-200 pt-3" use:tooltip={{ id: 'notebook-storage', delay: 200 }}>
    <button class="min-h-11 text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-ink" type="button" data-tooltip-trigger>Saved on the server</button>
    <span class="ui-tooltip" data-tooltip-content hidden>Saved notes live in persistent server-side storage, not browser memory. Reloading the page reads the notebook again.</span>
  </div>
  <p class="ui-hint">This example is a shared notebook, not a private account. Do not save sensitive information.</p>
  <noscript><p class="ui-hint mt-3">You can save notes and open the guide without JavaScript. Draft previews and keyboard widgets require it.</p></noscript>
</aside>
