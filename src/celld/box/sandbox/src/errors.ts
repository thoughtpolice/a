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

import { ContainerError, type ContainerErrorCode } from "@celld/box/container";

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
  /** `createSession` past `maxSessions`. */
  | "too_many_sessions"
  /** `openStream` past `maxOpenTickets` unredeemed tickets. */
  | "too_many_streams"
  | "no_such_session"
  | "port_not_exposed"
  /** A stream ticket is unknown, used or expired. */
  | "bad_ticket"
  /** The caller cancelled the command (a signal, `cancel`, a closed stream). */
  | "cancelled"
  /** The `hostile` tier could not verify gVisor with its trusted-image probe. */
  | "unsafe_runtime"
  /** `acquireLease` past {@link MAX_LEASES} live leases. */
  | "too_many_leases"
  /** `exposePort` past `MAX_EXPOSED_PORTS` ports with live tokens. */
  | "too_many_ports"
  /** The image lacks something the sandbox needs (`setsid`). */
  | "unsupported_image"
  /** Another caller holds the workspace lease; see `LeaseOption`. */
  | "lease_held"
  /** The workspace lease the call names expired, or was taken. */
  | "lease_lost"
  /** `noFollow`: the path, or a directory on its way, is a symbolic link. */
  | "is_symlink"
  /** A `listFiles` cursor's page no longer follows the one before it. */
  | "listing_changed";

const PREFIX = /^\[([a-z_]+)\] /;

const CODES = new Set<string>([
  "no_container",
  "start_failed",
  "start_timeout",
  "port_timeout",
  "unhealthy",
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
  "too_many_sessions",
  "too_many_streams",
  "no_such_session",
  "port_not_exposed",
  "bad_ticket",
  "cancelled",
  "unsafe_runtime",
  "too_many_leases",
  "too_many_ports",
  "unsupported_image",
  "lease_held",
  "lease_lost",
  "is_symlink",
  "listing_changed",
]);

/**
 * The HTTP status of an error code, as `errorResponse` answers it: 4xx for
 * what the caller asked (its detail describes the caller's own request),
 * 503 for everything that failed on the sandbox's side.
 */
export function errorStatus(code: string): number {
  switch (code) {
    case "invalid":
    case "invalid_path":
    case "outside_workspace":
      return 400;
    case "bad_ticket":
    case "not_found":
    case "no_such_process":
    case "no_such_session":
    case "port_not_exposed":
      return 404;
    case "too_large":
      return 413;
    case "exists":
    case "is_directory":
    case "not_directory":
    case "not_regular":
    case "not_empty":
    case "not_text":
    case "too_many_processes":
    case "too_many_ports":
    case "lease_held":
    case "lease_lost":
    case "is_symlink":
    case "listing_changed":
      return 409;
    default:
      return 503;
  }
}

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
