// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Deno-only stand-in for celld's "cloudflare:sockets" module, which
 * `celld.test(fake_runtime = True)` maps here. Modules that import it load;
 * opening a socket throws, since a test has no celld network stack.
 * @module
 */

export type Socket = globalThis.Socket;
export type SocketAddress = globalThis.SocketAddress;
export type SocketOptions = globalThis.SocketOptions;
export type SocketInfo = globalThis.SocketInfo;

/** Throws: the fake runtime has no sockets. */
export function connect(
  _address: SocketAddress | string,
  _options?: SocketOptions,
): Socket {
  throw new Error(
    "cloudflare:sockets connect() is not available in the fake test runtime",
  );
}
