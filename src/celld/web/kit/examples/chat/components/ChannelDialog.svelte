<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { modalDialog } from '@celld/web/interactions';
  import type { ChatModel } from '../model.ts';
  import ChannelForm from './ChannelForm.svelte';
  let { chat }: { chat: ChatModel } = $props();
  let enhanced = $state(false);
  let isOpen = $state(false);
  let name = $state('');
  let topic = $state('');
  let pending = $state(false);
  onMount(() => { enhanced = true; });
  export function open(): void {
    chat.clearFormError();
    isOpen = true;
  }
  function update(field: 'name' | 'topic', value: string): void {
    if (field === 'name') name = value;
    else topic = value;
  }
  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      if (await chat.createChannel(name, topic)) {
        name = '';
        topic = '';
        isOpen = false;
      }
    } finally { pending = false; }
  }
</script>

{#if enhanced}
  <dialog class="ui-dialog ui-panel chat-dialog" aria-labelledby="create-title" use:modalDialog={{
    id: 'channel-dialog', open: isOpen, closeOnOutside: false,
    initialFocus: () => document.getElementById('create-channel-name'),
    onOpenChange: (value) => { isOpen = value; },
  }}>
    <ChannelForm {chat} {enhanced} {name} {topic} {pending} {update} submit={create} close={() => isOpen = false} />
  </dialog>
{:else if chat.page.viewer !== null}
  <section id="channel-dialog" class="ui-dialog ui-panel chat-dialog native-dialog" aria-labelledby="create-title">
    <ChannelForm {chat} {enhanced} {name} {topic} {pending} {update} submit={create} close={() => isOpen = false} />
  </section>
{/if}
