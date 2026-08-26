// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Transport-independent RPC outcomes. Expected protocol failures travel as
 * plain data, so callers never depend on custom Error prototypes surviving
 * celld's structured-clone boundary. Unexpected storage/routing failures still
 * reject unless an endpoint deliberately supplies its public error envelope.
 * No domain state, retries, or durability policy lives here. @module
 */

/** A successful value or an explicit, serializable protocol failure. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; details?: unknown };

/** Internal control flow only: rpcGuard converts this error before transport. */
export class RpcFault extends Error {
  /** Associates an expected failure with its public HTTP status. */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Wrap an ordinary return value without changing its representation. */
export function rpcOk<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

/** Preserve expected failures as data; do not disguise unknown failures as conflicts. */
export async function rpcGuard<T>(
  operation: () => Promise<T>,
  unavailableMessage?: string,
): Promise<RpcResult<T>> {
  try {
    return rpcOk(await operation());
  } catch (error) {
    if (error instanceof RpcFault) {
      return { ok: false, status: error.status, error: error.message };
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return { ok: false, status: 400, error: error.message };
    }
    if (unavailableMessage !== undefined) {
      return {
        ok: false,
        status: 503,
        error: unavailableMessage,
        details: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

/** Require success inside a Workflow activity, retaining failure text for diagnosis. */
export function unwrapRpc<T>(result: RpcResult<T>): T {
  if (!result.ok) {
    throw new Error(`object RPC: ${result.status} ${result.error}`);
  }
  return result.value;
}
