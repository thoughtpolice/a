// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal Worker fixture ensuring the toolchain needs no application bindings.
 * @module
 */
export default {
  /** Returns a static response without consulting any environment bindings. */
  fetch() {
    return new Response("ok");
  },
};
