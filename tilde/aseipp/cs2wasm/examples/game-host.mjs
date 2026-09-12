// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { createEntityStore, finiteFloat } from "./entity-host.mjs";

// A small embedding adapter: host-owned entities persist across Wasm calls.
// This file uses only standard JavaScript/WebAssembly APIs, so tests can also
// exercise it in SpiderMonkey. It is not a process or physical-memory sandbox.
export function createGameHost(module, initialEntities) {
  const store = createEntityStore(initialEntities, (entity, handle) => ({
    handle,
    alive: Boolean(entity.alive),
    x: finiteFloat(entity.x),
    y: finiteFloat(entity.y),
    vx: finiteFloat(entity.vx),
    vy: finiteFloat(entity.vy),
  }));
  const { entity: requireEntity } = store;

  function queue(handle, fields) {
    if (!requireEntity(handle).alive) {
      throw new Error(`Entity ${handle} is inactive`);
    }
    store.queue({ handle, fields });
  }

  const game = {
    entity_count: () => store.handles.length,
    entity_at: store.entityAt,
    // Deliberately return a noncanonical true value to exercise the bool ABI.
    is_alive: (handle) => (requireEntity(handle).alive ? 7 : 0),
    read_x: (handle) => requireEntity(handle).x,
    read_y: (handle) => requireEntity(handle).y,
    read_velocity_x: (handle) => requireEntity(handle).vx,
    read_velocity_y: (handle) => requireEntity(handle).vy,
    set_position: (handle, x, y) =>
      queue(handle, { x: finiteFloat(x), y: finiteFloat(y) }),
    set_velocity: (handle, vx, vy) =>
      queue(handle, { vx: finiteFloat(vx), vy: finiteFloat(vy) }),
  };
  const instance = store.instantiate(module, "game", game);

  function run(exportName, ...args) {
    return store.run(instance, exportName, args);
  }

  return {
    run,
    step(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new RangeError("Frame duration must be finite and positive");
      }
      const duration = finiteFloat(seconds);
      if (duration <= 0) {
        throw new RangeError("Frame duration is too small for f32");
      }
      return run("Demo.HostedGameplay.Tick", duration);
    },
    snapshot: () =>
      [...store.entities.values()].map((entity) => ({ ...entity })),
    lastFault: () => instance.exports.__fault.value,
  };
}

export function exampleEntities() {
  return [
    { handle: 101, alive: true, x: 0, y: 0, vx: 2, vy: 1 },
    { handle: 203, alive: true, x: 10, y: -2, vx: -1, vy: 0.5 },
    { handle: 999, alive: false, x: 8, y: 8, vx: 100, vy: 100 },
  ];
}
