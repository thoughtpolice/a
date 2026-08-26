// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/** Internal object RPC, durability, and serialization helpers. No domain policy. @module */
import type { EpochIdentity, OrchestraEnvironment } from "../model.ts";
import type { EpochLedger } from "../epoch_ledger.ts";
import { epochCellName } from "./identifiers.ts";
/** Serialize handlers, including across outbound awaits. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
/** Locate an epoch without coupling callers to naming conventions. */
export function epochStub(
  env: OrchestraEnvironment,
  id: EpochIdentity,
): DurableObjectStub<EpochLedger> {
  return env.EPOCH.getByName(epochCellName(id.repo, id.epoch_id));
}
/** Persist before reporting success or performing external effects. */
export async function persist(
  storage: DurableObjectStorage,
  key: string,
  value: unknown,
): Promise<void> {
  await storage.put(key, value);
  await storage.sync();
}
