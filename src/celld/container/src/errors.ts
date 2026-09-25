// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Errors with a machine-readable code that survives Durable Object RPC.
 *
 * celld's RPC keeps only an error's message, so the code travels inside it
 * as a `[code] ` prefix, and {@link ContainerError.from} reads it back on
 * the caller's side.
 *
 * @module
 */

/** Why a container operation failed. */
export type ContainerErrorCode =
  /** The Durable Object class has no container declared. */
  | "no_container"
  /** The engine refused or failed the start. */
  | "start_failed"
  /** The engine did not report the container running in time. */
  | "start_timeout"
  /** A required port did not accept a connection in time. */
  | "port_timeout"
  /** It crashed more often than the restart policy allows. */
  | "failed"
  /** It stopped while the operation needed it. */
  | "not_running"
  /** An argument was refused. */
  | "invalid";

const PREFIX = /^\[([a-z_]+)\] /;

/** An error whose `code` is also the `[code] ` prefix of its message. */
export class ContainerError extends Error {
  override readonly name: string = "ContainerError";

  constructor(
    readonly code: ContainerErrorCode,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${detail}`, options);
  }

  /** The message without its code prefix. */
  get detail(): string {
    return this.message.replace(PREFIX, "");
  }

  /**
   * The error a caller received over RPC as a `ContainerError` again, when
   * its message carries a container code; otherwise null.
   */
  static from(error: unknown): ContainerError | null {
    if (error instanceof ContainerError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const match = PREFIX.exec(message);
    if (match === null || !CODES.has(match[1])) return null;
    return new ContainerError(
      match[1] as ContainerErrorCode,
      message.slice(match[0].length),
      { cause: error },
    );
  }
}

const CODES = new Set<string>([
  "no_container",
  "start_failed",
  "start_timeout",
  "port_timeout",
  "failed",
  "not_running",
  "invalid",
]);

/** The message of anything thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
