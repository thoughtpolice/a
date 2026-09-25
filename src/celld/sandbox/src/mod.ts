// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/sandbox`: run commands, files, background processes and ports
 * in a per-id celld container, in the shape of Cloudflare's
 * `@cloudflare/sandbox`, built on `@celld/container`.
 *
 * | Import                   | What it has                                                    |
 * | ------------------------ | -------------------------------------------------------------- |
 * | `@celld/sandbox`         | `getSandbox`, `SandboxClient`, `proxyToSandbox`, `SandboxCore`, types, errors, SSE |
 * | `@celld/sandbox/durable` | the `Sandbox` Durable Object class                             |
 * | `@celld/sandbox/testing` | `localSandbox`: the real core over host processes              |
 *
 * This entry point does not import `cloudflare:workers`.
 *
 * @module
 */

export {
  getSandbox,
  parsePreviewHost,
  PREVIEW_HEADER,
  previewUrl,
  proxyToSandbox,
  SandboxClient,
  type SandboxClientOptions,
  SandboxSession,
  STREAM_PATH,
} from "./client.ts";
export {
  randomToken,
  readAll,
  type ResolvedSettings,
  resolveSettings,
  sameToken,
  SandboxCore,
  type SandboxSettings,
} from "./core.ts";
export { SandboxError, type SandboxErrorCode } from "./errors.ts";
export { type RawOptions, type RawResult, runRaw } from "./exec.ts";
export {
  checkDirectory,
  workspaceEntry,
  type WorkspacePath,
  workspacePath,
} from "./paths.ts";
export {
  encodeEvent,
  eventStream,
  parseSSEStream,
  SSE_HEADERS,
} from "./sse.ts";
export type * from "./types.ts";
