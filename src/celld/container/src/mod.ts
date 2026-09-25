// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/container`: the lifecycle of a celld container owned by a Durable
 * Object, in the shape of Cloudflare's `@cloudflare/containers`.
 *
 * | Import                       | What it has                                              |
 * | ---------------------------- | -------------------------------------------------------- |
 * | `@celld/container`           | {@link ContainerController}, options, state, errors, durations |
 * | `@celld/container/durable`   | the `Container` base class, `getContainer`, `getRandom`, `switchPort` |
 * | `@celld/container/testing`   | `FakeContainer`, `FakeState`, `ManualClock`              |
 *
 * This entry point does not import `cloudflare:workers`, so it loads in
 * plain Deno tests.
 *
 * @module
 */

export {
  checkPort,
  ContainerController,
  type ResolvedOptions,
  resolveOptions,
  STATE_KEY,
  type WaitForPortOptions,
} from "./controller.ts";
export { type Duration, durationMs } from "./duration.ts";
export {
  ContainerError,
  type ContainerErrorCode,
  messageOf,
} from "./errors.ts";
export {
  type Clock,
  type ContainerHooks,
  type ContainerHost,
  type ContainerOptions,
  type ContainerState,
  type ContainerStatus,
  type NativeContainer,
  type NativeContainerPort,
  type RestartMode,
  type RestartPolicy,
  type StartOverrides,
  type StopEvent,
  type StopReason,
  type SyncKv,
  systemClock,
} from "./types.ts";
