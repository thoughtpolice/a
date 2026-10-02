<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { FixtureProps } from './types.ts';
  import type { ActionState } from '@celld/web/kit/actions';
  import type { NavigationState } from '@celld/web/kit/navigation';
  import { disclosure, menu, modalDialog, tabs, tooltip } from '@celld/web/interactions';
  let { message, count }: FixtureProps = $props();
  let navigation = $state('Ready');
  let actionMessage = $state('');
  let showWidgets = $state(true);
  let dialogTrigger = $state<HTMLButtonElement>();
  let dialogOpen = $state(false);
  let selected = $state('overview');
  let disclosureOpen = $state(false);
  let menuChoice = $state('No command selected');
  let fieldError = $state('');
  export function setPage(page: FixtureProps): void {
    message = page.message;
    count = page.count;
  }
  export function setNavigation(state: NavigationState<FixtureProps>): void {
    navigation = state.status === 'pending' ? 'Loading page…'
      : state.status === 'error' ? `Unable to load page (${state.error.kind}). Try again.`
      : 'Ready';
  }
  export function setAction(state: ActionState<FixtureProps>): void {
    fieldError = state.status === 'error' && state.error.kind === 'validation'
      ? (state.error.error.fieldErrors.message ?? []).join('; ') : '';
    actionMessage = state.status === 'pending' ? 'Saving…'
      : state.status === 'success' ? 'Saved message.'
      : state.status === 'error' ? `Save failed (${state.error.kind}). Try again.` : '';
    if (state.status === 'success') setPage(state.data);
  }
</script>
<svelte:head><meta name="kit-fixture" content={message} /></svelte:head>
<h1>{message}</h1>
<p>{count}</p>
<button onclick={() => count += 1}>Increment</button>
<nav aria-label="Fixture pages"><a id="next-page" href="/?message=Second">Second page</a></nav>
<p role="status" aria-live="polite">{navigation}</p>
<form method="post" action="/rename">
  <label for="message">Message</label>
  <input id="message" name="message" required value={message} aria-describedby="message-error" aria-invalid={fieldError !== ''} />
  <button type="submit">Save message</button>
  <p id="message-error" role="alert" data-action-error>{fieldError}</p>
  <p role="status" aria-live="polite" data-action-success>{actionMessage}</p>
</form>
<h2>Interaction primitives</h2>
<button id="toggle-widgets" type="button" onclick={() => showWidgets = !showWidgets}>Toggle primitives</button>
{#if showWidgets}
  <section id="widgets-proof">
    <button id="dialog-trigger" type="button" bind:this={dialogTrigger}>Open dialog</button>
    <dialog aria-labelledby="dialog-title" use:modalDialog={{
      id: 'proof-dialog', trigger: dialogTrigger, open: dialogOpen,
      onOpenChange: (value) => { dialogOpen = value; },
    }}>
      <h2 id="dialog-title">Edit profile</h2>
      <label>Display name <input id="dialog-name" name="display-name" /></label>
      <form method="dialog"><button type="submit">Done</button></form>
    </dialog>

    <section id="tabs-proof" use:tabs={{ id: 'proof-tabs', selected, onSelect: (value) => { selected = value; } }}>
      <div data-tab-list aria-label="Fixture views">
        <button type="button" data-tab="overview">Overview</button>
        <button type="button" data-tab="disabled" disabled>Unavailable</button>
        <button type="button" data-tab="details">Details</button>
      </div>
      <section data-tab-panel="overview">
        Overview panel
        <section id="nested-tabs-proof" use:tabs={{ id: 'nested-tabs', orientation: 'vertical', activation: 'manual' }}>
          <div data-tab-list aria-label="Nested views">
            <button type="button" data-tab="nested-first">Nested first</button>
            <button type="button" data-tab="nested-second">Nested second</button>
          </div>
          <section data-tab-panel="nested-first">Nested first panel</section>
          <section data-tab-panel="nested-second" hidden>Nested second panel</section>
        </section>
      </section>
      <section data-tab-panel="disabled" hidden>Unavailable panel</section>
      <section data-tab-panel="details" hidden>Details panel</section>
    </section>

    <section use:disclosure={{ id: 'proof-disclosure', open: disclosureOpen, onOpenChange: (value) => { disclosureOpen = value; } }}>
      <button type="button" data-disclosure-trigger>Advanced settings</button>
      <div data-disclosure-panel hidden><label>Alias <input name="alias" /></label></div>
    </section>

    <div id="menu-proof" use:menu={{ id: 'proof-menu', onSelect: (value) => { menuChoice = value; } }}>
      <button type="button" data-menu-trigger>Commands</button>
      <div data-menu-panel hidden>
        <button type="button" data-menu-item="save">Save</button>
        <button type="button" data-menu-item="disabled" disabled>Unavailable</button>
        <button type="button" data-menu-item="copy">Copy</button>
        <a href="/?message=Linked" data-menu-item="link">Linked page</a>
      </div>
    </div>
    <p id="menu-result" role="status">{menuChoice}</p>

    <span id="tooltip-proof" use:tooltip={{ id: 'proof-tooltip', delay: 20 }}>
      <button type="button" data-tooltip-trigger>Why native?</button>
      <span data-tooltip-content hidden>Compiled in Rust and hydrated by Svelte.</span>
    </span>
  </section>
{/if}
<style>h1 { color: #183b56; }</style>
