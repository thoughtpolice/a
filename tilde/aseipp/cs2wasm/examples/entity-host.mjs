// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The pieces every entity-owning host shares: a handle table, a command
// queue that only exists during a Wasm call, an import allow-list, and a
// transactional entry that commits the queue only when the call returns.
// Standard JavaScript/WebAssembly APIs only, so Node, Deno, browsers and
// SpiderMonkey can all load it.

// `normalize(source, handle)` validates one initial entity and returns the
// host's own copy of it.
export function createEntityStore(sources, normalize) {
  const entities = new Map();
  for (const source of sources) {
    const handle = source.handle;
    if (!Number.isInteger(handle) || handle <= 0 || handle > 2147483647) {
      throw new RangeError("Entity handles must be positive i32 values");
    }
    if (entities.has(handle)) {
      throw new RangeError(`Duplicate entity handle ${handle}`);
    }
    entities.set(handle, normalize(source, handle));
  }
  const handles = [...entities.keys()];
  let pending = null;

  function entity(handle) {
    const value = entities.get(handle);
    if (!value) throw new RangeError(`Unknown entity handle ${handle}`);
    return value;
  }

  function entityAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= handles.length) {
      throw new RangeError(`Invalid entity index ${index}`);
    }
    return handles[index];
  }

  function queue(command) {
    if (pending === null) {
      throw new Error("Host commands require an active Wasm call");
    }
    pending.push(command);
  }

  // Only the functions in `imports` are available to the module, and only
  // under `namespace`.
  function instantiate(module, namespace, imports) {
    for (const entry of WebAssembly.Module.imports(module)) {
      if (
        entry.module !== namespace ||
        entry.kind !== "function" ||
        !Object.hasOwn(imports, entry.name)
      ) {
        throw new Error(
          `Unsupported host import ${entry.module}.${entry.name}`,
        );
      }
    }
    return new WebAssembly.Instance(module, { [namespace]: imports });
  }

  // Commands shaped `{ handle, fields }` update that entity; any other
  // command goes to `commitOther`.
  function run(instance, exportName, args, commitOther) {
    if (pending !== null) {
      throw new Error("Reentrant Wasm entry is not allowed");
    }
    const entry = instance.exports[exportName];
    if (typeof entry !== "function") {
      throw new Error(`Unknown Wasm export ${exportName}`);
    }
    pending = [];
    try {
      const result = entry(...args);
      // Reads during the call still saw the previous state. Every command
      // was validated before it entered the batch; commit only on success.
      for (const command of pending) {
        if ("handle" in command) {
          Object.assign(entities.get(command.handle), command.fields);
        } else {
          commitOther(command);
        }
      }
      return result;
    } finally {
      // A Wasm trap or host exception discards the batch and releases the guard.
      pending = null;
    }
  }

  return { entities, handles, entity, entityAt, queue, instantiate, run };
}

export function finiteFloat(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isFinite(Math.fround(value))
  ) {
    throw new RangeError("Entity state must contain finite f32 values");
  }
  return Math.fround(value);
}
