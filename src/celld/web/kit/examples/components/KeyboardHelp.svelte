<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { modalDialog } from '@celld/web/interactions';

  let { trigger }: { trigger: HTMLButtonElement | undefined } = $props();
  let open = $state(false);
</script>

<dialog class="ui-panel ui-dialog p-6 sm:p-8" aria-labelledby="keyboard-title" use:modalDialog={{
  id: 'keyboard-dialog', trigger, open,
  onOpenChange: (value) => { open = value; },
}}>
  <h2 id="keyboard-title" class="ui-heading text-2xl leading-8">Keyboard help</h2>
  <p class="ui-hint mt-2 text-sm">Use the notebook without leaving the keyboard.</p>
  <dl class="ui-keyboard-list">
    <div><dt>Move through controls</dt><dd><kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd></dd></div>
    <div><dt>Notebook and draft tabs</dt><dd><kbd>←</kbd> / <kbd>→</kbd>; <kbd>Home</kbd> / <kbd>End</kbd></dd></div>
    <div><dt>Toggle optional details</dt><dd><kbd>Enter</kbd> or <kbd>Space</kbd> on its button</dd></div>
    <div><dt>Choose display order</dt><dd><kbd>↑</kbd> / <kbd>↓</kbd>, then <kbd>Enter</kbd>. Type a command’s first letters to find it.</dd></div>
    <div><dt>Dismiss a dialog, menu or tooltip</dt><dd><kbd>Escape</kbd></dd></div>
    <div><dt>Save a note</dt><dd>Activate Save note, or press <kbd>Enter</kbd> in the title field. In details, Enter adds a new line.</dd></div>
  </dl>
  <form method="dialog"><button class="ui-button ui-button-primary" type="submit">Close keyboard help</button></form>
</dialog>
