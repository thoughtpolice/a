<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  let { chat, openSession, openChannel }: { chat: ChatModel; openSession: () => void; openChannel: () => void } = $props();

  function navigate(event: MouseEvent, name: string): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void chat.navigate(name);
  }
  function leave(event: SubmitEvent): void {
    event.preventDefault();
    void chat.leave();
  }
</script>

<aside id="channel-rail" class="channel-rail rail" data-mobile-open={chat.mobilePanel === 'channels'} aria-label="Channels and guest session">
  <div class="brand"><a href="/" class="brand-name">Switchboard<span class="brand-mark" aria-hidden="true">▌</span></a><span class="brand-caption">Public channels. Real conversations.</span></div>
  <div class="rail-heading"><h2>Channels</h2><button class="ui-button ui-button-quiet rail-close" type="button" hidden={!chat.enhanced} onclick={() => chat.mobilePanel = 'none'} aria-label="Close channels">Close</button></div>
  <nav class="channel-list" aria-label="Public channels">
    {#each chat.page.channels as channel (channel.name)}
      <a class="channel-link" href="/channels/{channel.name}" data-channel={channel.name} aria-current={channel.name === chat.page.channel.name ? 'page' : undefined} onclick={(event) => navigate(event, channel.name)}>
        <span class="channel-name"><span class="channel-hash" aria-hidden="true">#</span>{channel.name}</span>
        {#if chat.unread[channel.name] > 0}<span class="unread-count" aria-label="{chat.unread[channel.name]} unread messages">{chat.unread[channel.name]}</span>{/if}
      </a>
    {/each}
  </nav>
  {#if chat.page.viewer}
    <button id="new-channel" class="ui-button ui-button-quiet new-channel" type="button" hidden={!chat.enhanced} onclick={openChannel}><span aria-hidden="true">＋</span> New channel</button>
    <noscript><a class="ui-link native-dialog-link" href="#channel-dialog">Create a channel</a></noscript>
  {/if}
  <div class="rail-bottom">
    <p class="public-note">Every channel is public.<br />Read along, or choose a nickname to join in.</p>
    {#if chat.page.viewer}
      <div class="guest-identity"><span class="identity-dot" aria-hidden="true"></span><div><strong>@{chat.page.viewer.nickname}</strong><span>Guest · not a verified account</span></div></div>
      <form method="post" action="/session/leave" onsubmit={leave}>
        <input type="hidden" name="_csrf" value={chat.page.csrf} />
        <input type="hidden" name="channel" value={chat.page.channel.name} />
        <button id="leave-chat" class="ui-button ui-button-quiet leave-chat" type="submit">Leave chat</button>
      </form>
    {:else}
      <button class="ui-button ui-button-primary join-chat" type="button" hidden={!chat.enhanced} onclick={openSession}>Choose a nickname</button>
      <noscript><a class="ui-link native-dialog-link" href="#session-dialog">Join the conversation</a></noscript>
    {/if}
  </div>
</aside>
