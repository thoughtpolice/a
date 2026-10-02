<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { modalDialog } from '@celld/web/interactions';
  import type { ChatModel } from '../model.ts';
  import SessionForm from './SessionForm.svelte';
  let { chat }: { chat: ChatModel } = $props();
  let enhanced = $state(false);
  let isOpen = $state(false);
  let nickname = $state('');
  let pending = $state(false);
  onMount(() => { enhanced = true; });
  export function open(): void {
    chat.clearFormError();
    isOpen = true;
  }
  async function enter(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      if (await chat.enter(nickname)) {
        const wasOpen = isOpen;
        isOpen = false;
        if (wasOpen) {
          await tick();
          document.getElementById('message-text')?.focus();
        }
      }
    } finally { pending = false; }
  }
</script>

{#if enhanced}
  <dialog class="ui-dialog ui-panel chat-dialog" aria-labelledby="session-title" use:modalDialog={{
    id: 'session-dialog', open: isOpen, closeOnOutside: false,
    initialFocus: () => document.getElementById('nickname'),
    onOpenChange: (value) => { isOpen = value; },
  }}>
    <SessionForm {chat} {enhanced} {nickname} {pending} updateNickname={(value) => nickname = value} submit={enter} close={() => isOpen = false} />
  </dialog>
{:else if chat.page.viewer === null}
  <section id="session-dialog" class="ui-dialog ui-panel chat-dialog native-dialog" aria-labelledby="session-title">
    <SessionForm {chat} {enhanced} {nickname} {pending} updateNickname={(value) => nickname = value} submit={enter} close={() => isOpen = false} />
  </section>
{/if}
