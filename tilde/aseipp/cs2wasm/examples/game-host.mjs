// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A small embedding adapter: host-owned entities persist across Wasm calls.
// This file uses only standard JavaScript/WebAssembly APIs, so tests can also
// exercise it in SpiderMonkey. It is not a process or physical-memory sandbox.
export function createGameHost(module, initialEntities) {
  const entities = new Map();
  for (const entity of initialEntities) {
    if (
      !Number.isInteger(entity.handle) ||
      entity.handle <= 0 ||
      entity.handle > 2147483647 ||
      entities.has(entity.handle)
    ) {
      throw new RangeError('Entity handles must be unique positive i32 values');
    }
    entities.set(entity.handle, {
      handle: entity.handle,
      alive: Boolean(entity.alive),
      x: finiteFloat(entity.x),
      y: finiteFloat(entity.y),
      vx: finiteFloat(entity.vx),
      vy: finiteFloat(entity.vy),
    });
  }

  const handles = [...entities.keys()];
  let pending = null;

  function requireEntity(handle) {
    const entity = entities.get(handle);
    if (!entity) {
      throw new RangeError(`Unknown entity handle ${handle}`);
    }
    return entity;
  }

  function queue(handle, fields) {
    if (pending === null) {
      throw new Error('Host commands require an active frame');
    }
    if (!requireEntity(handle).alive) {
      throw new Error(`Entity ${handle} is inactive`);
    }
    pending.push({ handle, fields });
  }

  const game = {
    entity_count: () => handles.length,
    entity_at(index) {
      if (!Number.isInteger(index) || index < 0 || index >= handles.length) {
        throw new RangeError(`Invalid entity index ${index}`);
      }
      return handles[index];
    },
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

  // Only this concrete host interface is available to the module.
  for (const entry of WebAssembly.Module.imports(module)) {
    if (
      entry.module !== 'game' ||
      entry.kind !== 'function' ||
      !Object.hasOwn(game, entry.name)
    ) {
      throw new Error(`Unsupported host import ${entry.module}.${entry.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, { game });

  function run(exportName, ...args) {
    if (pending !== null) {
      throw new Error('Reentrant Wasm entry is not allowed');
    }
    const entry = instance.exports[exportName];
    if (typeof entry !== 'function') {
      throw new Error(`Unknown Wasm export ${exportName}`);
    }
    pending = [];
    try {
      const result = entry(...args);
      // Every command has already been validated. Commit only after success.
      for (const command of pending) {
        Object.assign(entities.get(command.handle), command.fields);
      }
      return result;
    } finally {
      // A Wasm trap or host exception discards the batch and releases the guard.
      pending = null;
    }
  }

  return {
    run,
    step(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new RangeError('Frame duration must be finite and positive');
      }
      const duration = finiteFloat(seconds);
      if (duration <= 0)
        throw new RangeError('Frame duration is too small for f32');
      return run('Demo.HostedGameplay.Tick', duration);
    },
    snapshot: () => [...entities.values()].map((entity) => ({ ...entity })),
    lastFault: () => instance.exports.__fault.value,
  };
}

function finiteFloat(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isFinite(Math.fround(value))
  ) {
    throw new RangeError('Entity state must contain finite f32 values');
  }
  return Math.fround(value);
}

export function exampleEntities() {
  return [
    { handle: 101, alive: true, x: 0, y: 0, vx: 2, vy: 1 },
    { handle: 203, alive: true, x: 10, y: -2, vx: -1, vy: 0.5 },
    { handle: 999, alive: false, x: 8, y: 8, vx: 100, vy: 100 },
  ];
}
