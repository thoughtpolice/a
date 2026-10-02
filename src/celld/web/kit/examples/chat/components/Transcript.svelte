<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ChatModel } from '../model.ts';
  let { chat }: { chat: ChatModel } = $props();
  let scroller: HTMLDivElement;
  let live = $state(false);
  let nearBottom = true;
  let previousChannel = '';
  let previousSeq = 0;
  let unseen = $state(0);
  const query = $derived(chat.filter.trim().toLocaleLowerCase());
  const visible = $derived(query ? chat.messages.filter((message) => message.text.toLocaleLowerCase().includes(query) || message.from?.nickname.toLocaleLowerCase().includes(query)) : chat.messages);

  onMount(() => { live = true; });
  function position(): void {
    nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    if (nearBottom) unseen = 0;
  }
  function bottom(): void {
    scroller.scrollTop = scroller.scrollHeight;
    nearBottom = true;
    unseen = 0;
  }
  $effect(() => {
    const channel = chat.page.channel.name;
    const seq = chat.messages.at(-1)?.seq ?? 0;
    const filter = query;
    untrack(() => {
      const changedChannel = previousChannel !== channel;
      const added = !changedChannel && seq > previousSeq;
      const shouldScroll = changedChannel || nearBottom;
      if (added && !shouldScroll && !filter) unseen += chat.messages.filter((message) => message.seq > previousSeq).length;
      previousChannel = channel;
      previousSeq = seq;
      void tick().then(() => {
        if (!scroller || previousChannel !== channel) return;
        if (shouldScroll && !filter) bottom();
      });
    });
  });
  function time(at: number): string { return new Date(at).toISOString().slice(11, 16); }
  function date(at: number): string { return new Date(at).toISOString().slice(0, 10); }
</script>

<section class="transcript-shell" aria-label="Channel conversation">
  <div bind:this={scroller} class="transcript" aria-label="Scroll conversation" tabindex="0" onscroll={position}>
    <div role="log" aria-label="Messages in #{chat.page.channel.name}" aria-live={live ? 'polite' : 'off'} aria-relevant="additions">
    {#if query}
      <p class="search-summary">{visible.length} {visible.length === 1 ? 'message matches' : 'messages match'} “{chat.filter.trim()}”</p>
    {/if}
    {#if visible.length === 0}
      <div class="transcript-empty">
        {#if query}
          <span class="empty-symbol" aria-hidden="true">⌕</span><h2>No matching messages</h2><p>Try a different word or nickname. Search only looks in this channel’s loaded history.</p><button class="ui-button ui-button-quiet" type="button" onclick={() => chat.filter = ''}>Clear search</button>
        {:else}
          <span class="empty-symbol" aria-hidden="true">#</span><h2>You’re at the beginning of #{chat.page.channel.name}</h2><p>No messages yet. {chat.page.viewer ? 'Say hello and start the conversation.' : 'Choose a nickname below to start the conversation.'}</p>
        {/if}
      </div>
    {:else}
      {#each visible as message, index (message.seq)}
        {#if index === 0 || date(message.at) !== date(visible[index - 1].at)}<div class="day-divider"><time datetime={date(message.at)}>{date(message.at)} · UTC</time></div>{/if}
        <article class="message" data-message-seq={message.seq} data-own={message.from !== null && message.from.id === chat.page.viewer?.id}>
          <time class="message-time" datetime={new Date(message.at).toISOString()} title={new Date(message.at).toISOString()}>{time(message.at)}</time>
          <div class="message-content"><span class="message-handle">{message.from ? `@${message.from.nickname}` : 'system'}</span><p class="message-text">{message.text}</p></div>
        </article>
      {/each}
    {/if}
    </div>
  </div>
  {#if unseen > 0 && !query}<button class="ui-button ui-button-primary jump-messages" type="button" onclick={bottom}>{unseen} new {unseen === 1 ? 'message' : 'messages'} · Jump to latest ↓</button>{/if}
</section>
