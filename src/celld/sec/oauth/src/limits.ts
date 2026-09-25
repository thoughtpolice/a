// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Public wire limits in UTF-16 code units; protocols below use ASCII values. */
export const OAUTH_LIMITS = Object.freeze({
  token: 16_384,
  assertion: 16_384,
  authorization: 16_400,
  url: 16_384,
  identifier: 4096,
  nonce: 1024,
  error: 1024,
  scopeToken: 256,
  scopeCount: 256,
  resourceCount: 64,
});
