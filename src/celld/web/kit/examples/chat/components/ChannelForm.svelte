<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  interface Props {
    chat: ChatModel;
    enhanced: boolean;
    name: string;
    topic: string;
    pending: boolean;
    update: (field: 'name' | 'topic', value: string) => void;
    submit: (event: SubmitEvent) => void;
    close: () => void;
  }
  let { chat, enhanced, name, topic, pending, update, submit, close }: Props = $props();
  function input(field: 'name' | 'topic', event: Event): void {
    if (event.currentTarget instanceof HTMLInputElement) update(field, event.currentTarget.value);
  }
</script>

<div class="dialog-heading">
  <h2 id="create-title" class="ui-heading">Create a channel</h2>
  {#if enhanced}<button class="ui-button ui-button-quiet" type="button" onclick={close} aria-label="Close new channel dialog">Close</button>{/if}
</div>
<p class="dialog-description">Pick a name and a topic. New channels are public, just like every other channel here.</p>
<form method="post" action="/channels" onsubmit={submit}>
  <input type="hidden" name="_csrf" value={chat.page.csrf} />
  <fieldset class="ui-fieldset dialog-fields" disabled={pending}>
    <div class="form-field">
      <label class="ui-label" for="create-channel-name">Channel name</label>
      <input id="create-channel-name" class="ui-input" name="name" value={name} oninput={(event) => input('name', event)} minlength="1" maxlength="32" pattern="[a-z0-9][a-z0-9\-]*" required autocomplete="off" placeholder="weekend-projects" aria-describedby="channel-name-hint" />
      <p id="channel-name-hint" class="ui-hint">Up to 32 lowercase letters, numbers or hyphens. Start with a letter or number.</p>
    </div>
    <div class="form-field">
      <label class="ui-label" for="create-channel-topic">Topic <span class="optional-label">optional</span></label>
      <input id="create-channel-topic" class="ui-input" name="topic" value={topic} oninput={(event) => input('topic', event)} maxlength="160" placeholder="What’s this channel about?" />
    </div>
    {#if chat.formError}<p class="ui-error" role="alert">{chat.formError}</p>{/if}
    <div class="dialog-actions">
      {#if enhanced}<button class="ui-button ui-button-quiet" type="button" onclick={close}>Cancel</button>{/if}
      <button id="create-channel-submit" class="ui-button ui-button-primary" type="submit">{pending ? 'Creating…' : 'Create channel'}</button>
    </div>
  </fieldset>
</form>
