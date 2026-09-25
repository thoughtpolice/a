// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/box/sandbox`: run commands, files, background processes and ports
 * in a per-id celld container, in the shape of Cloudflare's
 * `@cloudflare/sandbox`, built on `@celld/box/container`.
 *
 * | Import                   | What it has                                                    |
 * | ------------------------ | -------------------------------------------------------------- |
 * | `@celld/box/sandbox`         | `getSandbox`, `SandboxClient`, `proxyToSandbox`, `SandboxCore`, types, errors, SSE |
 * | `@celld/box/sandbox/durable` | the `Sandbox` Durable Object class                             |
 * | `@celld/box/sandbox/testing` | `localSandbox`: the real core over host processes              |
 *
 * This entry point does not import `cloudflare:workers`.
 *
 * @module
 */

export {
  type ClientStreamOptions,
  createPreviewProxy,
  deriveSandboxId,
  getPrincipalSandbox,
  getSandbox,
  parsePreviewHost,
  PREVIEW_HEADER,
  previewUrl,
  proxyToSandbox,
  SandboxClient,
  type SandboxClientOptions,
  SandboxSession,
  STREAM_PATH,
  type WorkspaceClient,
} from "./client.ts";
export {
  DEFAULT_LEASE_TTL_MS,
  MAX_EXPOSED_PORTS,
  MAX_LEASES,
  MAX_TOKEN_LENGTH,
  PREVIEW_TOKEN_LENGTH,
  randomToken,
  READ_ALL_MAX_BYTES,
  readAll,
  type ResolvedSettings,
  resolveSettings,
  sameToken,
  SandboxCore,
  type SandboxSettings,
  SETTING_LIMITS,
  WORKSPACE_LEASE,
} from "./core.ts";
export { SandboxError, type SandboxErrorCode } from "./errors.ts";
export {
  DEFAULT_MAX_HOLD_MS,
  LEASE_KILL_GRACE_MS,
  LEASE_TTL_MS,
  LEASE_WAIT_MS,
  withWorkspaceLease,
  WorkspaceLeaseError,
  type WorkspaceLeaseOptions,
} from "./lease.ts";
export { type RawOptions, type RawResult, runRaw } from "./exec.ts";
export {
  checkDirectory,
  workspaceEntry,
  type WorkspacePath,
  workspacePath,
} from "./paths.ts";
export {
  boundedStream,
  type BoundedStreamOptions,
  encodeEvent,
  eventStream,
  isSandboxEvent,
  type ParseOptions,
  parseSSEStream,
  SSE_HEADERS,
} from "./sse.ts";
export type * from "./types.ts";
