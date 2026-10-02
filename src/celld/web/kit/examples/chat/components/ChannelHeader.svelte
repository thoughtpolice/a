<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  let { chat }: { chat: ChatModel } = $props();
  const connectionLabel = $derived(chat.navigating ? 'Loading channel…' : chat.status === 'reading' ? 'Read-only · join to chat' : chat.status === 'open' ? 'Live' : chat.status === 'connecting' ? 'Connecting…' : chat.status === 'reconnecting' ? 'Reconnecting…' : 'Disconnected');
</script>

<header class="channel-header">
  <div class="channel-heading-row">
    <button id="toggle-channels" class="ui-button ui-button-quiet mobile-toggle" type="button" hidden={!chat.enhanced} aria-label="Toggle channels" aria-controls="channel-rail" aria-expanded={chat.mobilePanel === 'channels'} onclick={() => chat.mobilePanel = chat.mobilePanel === 'channels' ? 'none' : 'channels'}>Channels</button>
    <h1 class="channel-title" data-channel-heading tabindex="-1"><span class="channel-hash" aria-hidden="true">#</span>{chat.page.channel.name}</h1>
    <span class="connection-state" data-connection-state={chat.enhanced ? chat.status : 'snapshot'} role="status"><span class="connection-dot" aria-hidden="true"></span>{chat.enhanced ? connectionLabel : 'Server snapshot · reload for updates'}</span>
    <button id="toggle-members" class="ui-button ui-button-quiet mobile-toggle" type="button" hidden={!chat.enhanced} aria-label="Toggle members" aria-controls="member-rail" aria-expanded={chat.mobilePanel === 'members'} onclick={() => chat.mobilePanel = chat.mobilePanel === 'members' ? 'none' : 'members'}>Members</button>
  </div>
  <p class="channel-topic">{chat.page.channel.topic || 'A public channel for whatever is on your mind.'}</p>
  <div class="search-bar" hidden={!chat.enhanced}>
    <label class="search-label" for="message-search">Search this conversation</label>
    <div class="search-control">
      <input id="message-search" class="ui-input" type="search" placeholder="Find a message…" bind:value={chat.filter} autocomplete="off" />
      {#if chat.filter}<button class="ui-button ui-button-quiet search-clear" type="button" onclick={() => { chat.filter = ''; document.getElementById('message-search')?.focus(); }} aria-label="Clear message search">Clear</button>{:else}<kbd class="search-shortcut" aria-hidden="true">⌘ / Ctrl K</kbd>{/if}
    </div>
  </div>
</header>
