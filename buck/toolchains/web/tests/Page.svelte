<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

<script lang="ts">
  let { name }: { name: string } = $props();
</script>

<p class="greeting">hello, {name}</p>

<style>
  .greeting { color: rebeccapurple; }
</style>
