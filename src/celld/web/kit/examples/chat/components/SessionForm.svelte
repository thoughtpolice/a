<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  interface Props {
    chat: ChatModel;
    enhanced: boolean;
    nickname: string;
    pending: boolean;
    updateNickname: (value: string) => void;
    submit: (event: SubmitEvent) => void;
    close: () => void;
  }
  let { chat, enhanced, nickname, pending, updateNickname, submit, close }: Props = $props();
  function input(event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) updateNickname(event.currentTarget.value);
  }
</script>

<div class="dialog-heading">
  <h2 id="session-title" class="ui-heading">Choose your nickname</h2>
  {#if enhanced}<button class="ui-button ui-button-quiet" type="button" onclick={close} aria-label="Close nickname dialog">Close</button>{/if}
</div>
<p class="dialog-description">Join #{chat.page.channel.name} as a guest. Your nickname stays with this browser until you leave.</p>
<form method="post" action="/session" onsubmit={submit}>
  <input type="hidden" name="_csrf" value={chat.page.csrf} />
  <input type="hidden" name="channel" value={chat.page.channel.name} />
  <fieldset class="ui-fieldset dialog-fields" disabled={pending}>
    <div class="form-field">
      <label class="ui-label" for="nickname">Nickname</label>
      <input id="nickname" class="ui-input" name="nickname" value={nickname} oninput={input} minlength="2" maxlength="24" pattern="[A-Za-z0-9_\-]+" required autocomplete="nickname" placeholder="your-nickname" aria-describedby="nickname-hint" />
      <p id="nickname-hint" class="ui-hint">2–24 letters, numbers, underscores or hyphens.</p>
    </div>
    {#if chat.formError}<p class="ui-error" role="alert">{chat.formError}</p>{/if}
    <p class="identity-warning">This is a public chat. Guest nicknames aren’t verified accounts, and anyone can read your messages.</p>
    <div class="dialog-actions">
      {#if enhanced}<button class="ui-button ui-button-quiet" type="button" onclick={close}>Keep reading</button>{/if}
      <button id="enter-chat" class="ui-button ui-button-primary" type="submit">{pending ? 'Joining…' : 'Join chat'}</button>
    </div>
  </fieldset>
</form>
