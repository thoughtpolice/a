<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { modalDialog } from '@celld/web/interactions';

  let { trigger }: { trigger: HTMLButtonElement | undefined } = $props();
  let open = $state(false);
</script>

<dialog class="m-auto max-h-[calc(100dvh-32px)] w-[min(600px,calc(100vw-32px))] overflow-auto rounded-lg border border-slate-200 bg-surface p-6 text-ink shadow-xl backdrop:bg-ink/50 sm:p-8" aria-labelledby="keyboard-title" use:modalDialog={{
  id: 'keyboard-dialog', trigger, open,
  onOpenChange: (value) => { open = value; },
}}>
  <h2 id="keyboard-title" class="text-2xl leading-8 font-semibold tracking-tight">Keyboard help</h2>
  <p class="mt-2 text-sm text-muted">Use the notebook without leaving the keyboard.</p>
  <dl class="my-6 divide-y divide-slate-200 [&_div]:py-3 [&_dt]:mb-1 [&_dt]:font-medium [&_dd]:text-sm [&_dd]:leading-6 [&_dd]:text-slate-600 [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-slate-200 [&_kbd]:bg-canvas [&_kbd]:px-1 [&_kbd]:font-sans [&_kbd]:text-xs [&_kbd]:whitespace-nowrap">
    <div><dt>Move through controls</dt><dd><kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd></dd></div>
    <div><dt>Notebook and draft tabs</dt><dd><kbd>←</kbd> / <kbd>→</kbd>; <kbd>Home</kbd> / <kbd>End</kbd></dd></div>
    <div><dt>Toggle optional details</dt><dd><kbd>Enter</kbd> or <kbd>Space</kbd> on its button</dd></div>
    <div><dt>Choose display order</dt><dd><kbd>↑</kbd> / <kbd>↓</kbd>, then <kbd>Enter</kbd>. Type a command’s first letters to find it.</dd></div>
    <div><dt>Dismiss a dialog, menu or tooltip</dt><dd><kbd>Escape</kbd></dd></div>
    <div><dt>Save a note</dt><dd>Activate Save note, or press <kbd>Enter</kbd> in the title field. In details, Enter adds a new line.</dd></div>
  </dl>
  <form method="dialog"><button class="min-h-11 rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-blue-700" type="submit">Close keyboard help</button></form>
</dialog>
