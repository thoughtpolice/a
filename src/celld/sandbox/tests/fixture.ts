// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { SandboxError, type SandboxErrorCode } from "@celld/sandbox";
import { type LocalSandbox, localSandbox } from "@celld/sandbox/testing";

/** Runs `body` with a fresh local sandbox, closing it afterwards. */
export async function withSandbox(
  body: (local: LocalSandbox) => Promise<void>,
  options: Parameters<typeof localSandbox>[0] = {},
): Promise<void> {
  const local = await localSandbox(options);
  try {
    await body(local);
  } finally {
    await local.close();
  }
}

/** Awaits `promise` and checks it rejects with a SandboxError of `code`. */
export async function rejectsWith(
  promise: Promise<unknown>,
  code: SandboxErrorCode,
): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    const found = SandboxError.from(error);
    if (found === null || found.code !== code) {
      throw new Error(`expected [${code}], got ${String(error)}`);
    }
    return found;
  }
  throw new Error(`expected [${code}], but it succeeded`);
}

/** Waits until `check` holds, polling every 20 ms for up to `ms`. */
export async function eventually(
  check: () => Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
