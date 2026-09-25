// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox errors. As with `ContainerError`, the code rides in the message
 * as a `[code] ` prefix, because Durable Object RPC keeps only messages;
 * {@link SandboxError.from} recovers it on the caller's side, including
 * the container codes (`start_failed`, `failed`, ...).
 *
 * @module
 */

import { ContainerError, type ContainerErrorCode } from "@celld/container";

/** Why a sandbox operation failed. */
export type SandboxErrorCode =
  | ContainerErrorCode
  /** An argument failed validation; the message lists every issue. */
  | "invalid"
  /** A path is malformed, or a symbolic link on it points nowhere. */
  | "invalid_path"
  /** A path, once resolved, is outside the workspace. */
  | "outside_workspace"
  /** The workspace directory is missing in the container. */
  | "no_workspace"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "exists"
  /** More bytes than the operation's limit. */
  | "too_large"
  /** Not a regular file (a FIFO or device, say). */
  | "not_regular"
  | "not_empty"
  /** The file is not valid UTF-8; read it as bytes. */
  | "not_text"
  /** A helper command inside the container failed unexpectedly. */
  | "command_failed"
  /** A helper command inside the container ran out of time. */
  | "timeout"
  | "no_such_process"
  | "too_many_processes"
  | "no_such_session"
  | "port_not_exposed"
  /** A stream ticket is unknown, used or expired. */
  | "bad_ticket";

const PREFIX = /^\[([a-z_]+)\] /;

const CODES = new Set<string>([
  "no_container",
  "start_failed",
  "start_timeout",
  "port_timeout",
  "failed",
  "not_running",
  "invalid",
  "invalid_path",
  "outside_workspace",
  "no_workspace",
  "not_found",
  "is_directory",
  "not_directory",
  "exists",
  "too_large",
  "not_regular",
  "not_empty",
  "not_text",
  "command_failed",
  "timeout",
  "no_such_process",
  "too_many_processes",
  "no_such_session",
  "port_not_exposed",
  "bad_ticket",
]);

/** An error whose `code` is also the `[code] ` prefix of its message. */
export class SandboxError extends Error {
  override readonly name: string = "SandboxError";

  constructor(
    readonly code: SandboxErrorCode,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${detail}`, options);
  }

  /** The message without its code prefix. */
  get detail(): string {
    return this.message.replace(PREFIX, "");
  }

  /** `error` as a SandboxError when its message carries a known code, else null. */
  static from(error: unknown): SandboxError | null {
    if (error instanceof SandboxError) return error;
    if (error instanceof ContainerError) {
      return new SandboxError(error.code, error.detail, { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    const match = PREFIX.exec(message);
    if (match === null || !CODES.has(match[1])) return null;
    return new SandboxError(
      match[1] as SandboxErrorCode,
      message.slice(match[0].length),
      { cause: error },
    );
  }

  /** `error` as a SandboxError if it carries a code, else `error` unchanged. */
  static wrap(error: unknown): unknown {
    return SandboxError.from(error) ?? error;
  }
}

/** Throws `invalid` unless `condition` holds. */
export function ensure(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new SandboxError("invalid", detail);
}
