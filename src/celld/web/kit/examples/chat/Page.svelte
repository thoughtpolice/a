<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from '@celld/web/switchboard/contracts';
  import { createChatModel } from './chat.svelte.ts';
  import ChannelRail from './components/ChannelRail.svelte';
  import ChannelHeader from './components/ChannelHeader.svelte';
  import Transcript from './components/Transcript.svelte';
  import Composer from './components/Composer.svelte';
  import MemberRail from './components/MemberRail.svelte';
  import SessionDialog from './components/SessionDialog.svelte';
  import ChannelDialog from './components/ChannelDialog.svelte';

  let { channel, channels, messages, members, viewer, csrf }: PageData = $props();
  const chat = createChatModel(() => ({ channel, channels, messages, members, viewer, csrf }));
  interface DialogHandle { open(): void; }
  let sessionDialog: DialogHandle;
  let channelDialog: DialogHandle;

  function openSession(): void { chat.clearFormError(); sessionDialog.open(); }
  function openChannel(): void { chat.clearFormError(); channelDialog.open(); }

  onMount(() => chat.start());

  function shortcuts(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      document.getElementById('message-search')?.focus();
    }
    if (event.key === 'Escape') {
      chat.filter = '';
      chat.mobilePanel = 'none';
    }
  }
</script>

<svelte:head>
  <title>#{chat.page.channel.name} · Switchboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#17181c" />
</svelte:head>
<svelte:window onkeydown={shortcuts} />

<div class="workspace" data-enhanced={chat.enhanced}>
  <ChannelRail {chat} {openSession} {openChannel} />
  <main class="conversation" aria-busy={chat.navigating}>
    <ChannelHeader {chat} />
    {#if chat.notice}
      <div class="chat-notice ui-notice" data-tone="error" role="alert">
        <span>{chat.notice} Try again, or <a class="ui-link" href="/channels/{chat.page.channel.name}">reload this channel</a>.</span>
        <button class="ui-button ui-button-quiet" type="button" onclick={() => chat.dismissNotice()} aria-label="Dismiss notice">Dismiss</button>
      </div>
    {/if}
    <Transcript {chat} />
    <Composer {chat} {openSession} />
  </main>
  <MemberRail {chat} />
</div>
<SessionDialog bind:this={sessionDialog} {chat} />
<ChannelDialog bind:this={channelDialog} {chat} />
