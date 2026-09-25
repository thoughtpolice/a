// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai`: a client for GPT models reached through the user's ChatGPT
 * (Codex) subscription, as an exe.dev LLM integration serves it, for celld
 * Workers, Durable Objects and Workflows.
 *
 * This entry point has no `cloudflare:*` imports, so it also loads in plain
 * Deno. The subpaths add the rest:
 *
 * - `@celld/api/openai/coding`: `apply_patch`, `exec_command`, read-only file
 *   tools over a pluggable file system, and an in-memory file system.
 * - `@celld/api/openai/blueteam`: security review, reverse-engineering and
 *   triage schemas, prompts and helpers.
 * - `@celld/api/openai/durable`: the `GptPacer` and `GptConversations`
 *   Durable Objects.
 * - `@celld/api/openai/workflow`: replay-safe steps for Workflows.
 * - `@celld/api/openai/testing`: a scripted fake Responses server.
 *
 * Schemas are `@celld/sieve`'s, retries, the runtime and SSE
 * `@celld/http`'s, and ids `@celld/ulid`'s. Separate targets carry the
 * bridges, so this one needs no other library: `@celld/api/openai/jev`
 * (Jev-gated approvals, routing and scoring), `@celld/api/openai/reflection`
 * (integration discovery through exe.dev's reflection service) and
 * `@celld/api/openai/sandbox` (the coding tools over a `@celld/sandbox`).
 *
 * @module
 */

export * from "./agent.ts";
export * from "./chunk.ts";
export * from "./client.ts";
export * from "./conversation.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./items.ts";
export * from "./json.ts";
export * from "./models.ts";
export * from "./pacer.ts";
export * from "./ratelimits.ts";
export * from "./request.ts";
export * from "./retry.ts";
export * from "./tools.ts";
export * from "./types.ts";
