// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/box/container`: the lifecycle of a celld container owned by a Durable
 * Object, in the shape of Cloudflare's `@cloudflare/containers`.
 *
 * | Import                       | What it has                                              |
 * | ---------------------------- | -------------------------------------------------------- |
 * | `@celld/box/container`           | {@link ContainerController}, options, state, errors, durations |
 * | `@celld/box/container/durable`   | the `Container` base class, `getContainer`, `getRandom`, `PORT_HEADER` |
 * | `@celld/box/container/testing`   | `FakeContainer`, `FakeState`, `FakeKv`, `ManualClock`    |
 *
 * This entry point does not import `cloudflare:workers`, so it loads in
 * plain Deno tests.
 *
 * @module
 */

export {
  checkPort,
  ContainerController,
  OPTION_LIMITS,
  type ResolvedOptions,
  resolveOptions,
  STATE_KEY,
  type WaitForPortOptions,
} from "./controller.ts";
export { type Duration, type DurationLimits, durationMs } from "./duration.ts";
export { MAX_INSTANCES, randomUint32, uniformIndex } from "./random.ts";
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
