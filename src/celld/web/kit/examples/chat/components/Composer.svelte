<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  let { chat, openSession }: { chat: ChatModel; openSession: () => void } = $props();
  let form = $state<HTMLFormElement>();
  function send(event: SubmitEvent): void {
    event.preventDefault();
    if (!chat.sending) void chat.send();
  }
  function input(event: Event): void {
    if (event.currentTarget instanceof HTMLTextAreaElement) chat.draft = event.currentTarget.value;
    chat.typing();
  }
  function keyboard(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!chat.sending) form?.requestSubmit();
  }
</script>

<footer class="composer-area">
  <div class="typing-line">{#if chat.typingNames.length > 0}<span>{chat.typingNames.join(', ')} {chat.typingNames.length === 1 ? 'is' : 'are'} typing…</span>{/if}</div>
  {#if chat.page.viewer}
    <form bind:this={form} class="composer" method="post" action="/channels/{chat.page.channel.name}/messages" onsubmit={send}>
      <input type="hidden" name="_csrf" value={chat.page.csrf} />
      <label class="ui-label composer-label" for="message-text">Message #{chat.page.channel.name}</label>
      <div class="composer-controls">
        <textarea id="message-text" class="ui-input message-input" name="text" value={chat.draft} oninput={input} onkeydown={keyboard} rows="2" maxlength="2000" required placeholder="Say something…" disabled={chat.sending || chat.navigating} aria-invalid={chat.sendError !== ''} aria-describedby={chat.sendError ? 'composer-hint send-error' : 'composer-hint'}></textarea>
        <button id="send-message" class="ui-button ui-button-primary send-button" type="submit" disabled={chat.sending || chat.navigating}>{chat.sending ? 'Sending…' : 'Send'}<span aria-hidden="true">↵</span></button>
      </div>
      {#if chat.sendError}<p id="send-error" class="ui-error composer-error" role="alert">{chat.sendError}</p>{/if}
      <div id="composer-hint" class="composer-hint">{#if chat.enhanced}<span><kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line</span><span>{chat.draft.length}/2000</span>{:else}<span>Use Send to post. Up to 2000 characters.</span>{/if}</div>
    </form>
  {:else}
    <div class="reader-composer"><div><strong>Read along. Jump in when you’re ready.</strong><p>A nickname makes you a guest, not a verified account.</p></div><button class="ui-button ui-button-primary" type="button" hidden={!chat.enhanced} onclick={openSession}>Join the conversation</button><noscript><a class="ui-link" href="#session-dialog">Choose a nickname below</a></noscript></div>
  {/if}
</footer>
