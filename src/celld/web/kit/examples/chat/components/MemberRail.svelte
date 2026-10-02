<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import type { ChatModel } from '../model.ts';
  let { chat }: { chat: ChatModel } = $props();
</script>

<aside id="member-rail" class="member-rail rail" data-mobile-open={chat.mobilePanel === 'members'} aria-label="Channel members">
  <div class="rail-heading"><h2>Here now <span class="member-count">{chat.members.length}</span></h2><button class="ui-button ui-button-quiet rail-close" type="button" hidden={!chat.enhanced} onclick={() => chat.mobilePanel = 'none'} aria-label="Close members">Close</button></div>
  {#if chat.members.length === 0}
    <p class="members-empty">{chat.enhanced && chat.page.viewer && chat.status !== 'open' ? 'Waiting for the live connection…' : 'No guests connected to this channel yet.'}</p>
  {:else}
    <ul class="member-list">
      {#each chat.members as member (member.id)}
        <li class="member" data-member-id={member.id}><span class="identity-dot" aria-hidden="true"></span><div><span class="member-name">@{member.nickname}</span>{#if member.id === chat.page.viewer?.id}<span class="member-detail">you · guest</span>{:else}<span class="member-detail">{member.typing ? 'typing…' : 'guest'}</span>{/if}</div></li>
      {/each}
    </ul>
  {/if}
  <p class="presence-note">Connected guests in #{chat.page.channel.name}. Multiple tabs count as one person. Nicknames are not verified identities.</p>
</aside>
