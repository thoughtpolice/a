// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/exedev`: a typed client for everything exe.dev exposes, for celld
 * Workers, Durable Objects and Workflows.
 *
 * This entry point has the control-plane client (`POST https://exe.dev/exec`)
 * with a typed method per CLI command, the command catalog, quoting, errors,
 * retry policy, and exe0 token permissions, minting and verification. It has
 * no `cloudflare:*` imports, so it also loads in plain Deno. The subpaths add
 * the rest:
 *
 * - `@celld/api/exedev/vm`: for code on a VM: reflection, integrations, email.
 * - `@celld/api/exedev/proxy`: identity headers a VM's server receives, login
 *   with exe, calling VM endpoints with VM tokens, suggest/new links.
 * - `@celld/api/exedev/fleet`: desired-state planning and reconciling.
 * - `@celld/api/exedev/limiter`: per-SSH-key pacing.
 * - `@celld/api/exedev/durable`: the `ExeFleet` and `ExeKeyLimiter` Durable Objects.
 * - `@celld/api/exedev/workflow`: replay-safe provisioning steps.
 * - `@celld/api/exedev/testing`: an in-memory fake exe.dev and test helpers.
 *
 * @module
 */

export * from "./api.ts";
export * from "./catalog.ts";
export * from "./client.ts";
export * from "./command.ts";
export * from "./decode.ts";
export * from "./errors.ts";
export * from "./json.ts";
export * from "./quote.ts";
export * from "./retry.ts";
export * from "./runtime.ts";
export * from "./sshsig.ts";
export * from "./tokens.ts";
export * from "./transport.ts";
export * from "./validate.ts";
export * from "./vmexec.ts";
