// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for world `worker` of tests/wit/tasks.wit: the component model's
// async functions through its callback ABI (WASI 0.3's), as a component
// runtime runs them, over the core module. The host keeps the canonical
// built-ins' state (waitable sets, subtasks, each task's context), lowers
// export arguments with the module's cabi_realloc, starts async exports
// and calls their callbacks with the events their sets receive, and
// completes the async imports' subtasks in the order each check says,
// writing their results into the areas the module passed. Arguments: the
// core module, then its component, then the components of
// tests/wit/sleepy.wit and tests/wit/files.wit, which Wasmtime runs over
// its own WASI 0.3 clock, filesystem and standard output when it is
// installed, then tests/wit/ledger.wit's teller and bank components, which
// wasm-tools composes for Wasmtime to run when both are.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [corePath, componentPath, sleepyPath, filesPath, tellerPath, bankPath] =
  process.argv.slice(2);
if (
  !corePath || !componentPath || !sleepyPath || !filesPath || !tellerPath ||
  !bankPath
) {
  throw new Error(
    "Usage: wit-tasks.mjs <core.wasm> <component.wasm> <sleepy.component.wasm> <files.component.wasm> <teller.component.wasm> <bank.component.wasm>",
  );
}

let checks = 0;
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

const component = fs.readFileSync(componentPath);
equal(
  [...component.subarray(4, 8)],
  [0x0d, 0x00, 0x01, 0x00],
  "the componentized module is a component",
);

const hostModule = "test:tasks/host@1.0.0";
const jobsModule = "test:tasks/jobs@1.0.0";
const EVENT_SUBTASK = 1;
const EVENT_CANCELLED = 6;
const STARTING = 0;
const STARTED = 1;
const RETURNED = 2;

const memory = () => new DataView(exports.memory.buffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// MARK: The canonical built-ins' state

let current = null; // the component task whose code runs
let nextHandle = 1; // waitable sets and subtasks share the handle table
const sets = new Map(); // set handle -> true
const subtasks = new Map(); // subtask handle -> subtask
let eventSequence = 0;
let activity = 0; // bumped by anything a yielding task could have waited for

function newHandle() {
  return nextHandle++;
}

// A subtask of an async import: `run` does the host's work once started
// (reading the arguments then), `finish` writes the result.
function subtask(name, state, start, finish) {
  const handle = newHandle();
  const entry = { handle, name, state, set: 0, event: null, start, finish };
  subtasks.set(handle, entry);
  return entry;
}

function progress(entry, state) {
  entry.state = state;
  entry.event = { state, sequence: eventSequence++ };
  activity++;
}

// The host's side of an async import: `mode` is "now" (returns at once),
// "started" (starts at once, returns when the check says) or "starting"
// (starts, reading its arguments, only when the check says).
const modes = {};
const lowered = []; // subtasks not yet returned, in call order
function lower(name, start, finish) {
  activity++;
  const mode = modes[name] ?? "started";
  if (mode === "now") {
    start();
    finish();
    return RETURNED;
  }
  const entry = subtask(
    name,
    mode === "starting" ? STARTING : STARTED,
    start,
    finish,
  );
  if (mode !== "starting") {
    start();
  }
  lowered.push(entry);
  return (entry.handle << 4) | entry.state;
}

// Completes a subtask: it starts (if it had not) and returns.
function complete(entry) {
  if (entry.state === STARTING) {
    entry.start();
  }
  entry.finish();
  lowered.splice(lowered.indexOf(entry), 1);
  progress(entry, RETURNED);
}

function startOnly(entry) {
  assert.equal(entry.state, STARTING);
  entry.start();
  progress(entry, STARTED);
}

function readString(pointer, length) {
  return decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length));
}

// What the host allocates in the module's memory for a result, as a
// component runtime lowers one: with the module's cabi_realloc, whenever it
// writes the result (between the module's calls, for an async import).
let hostAllocations = 0;
function hostAllocate(bytes, alignment) {
  hostAllocations++;
  return exports.cabi_realloc(0, 0, alignment, bytes);
}

function hostString(text) {
  const bytes = encoder.encode(text);
  const pointer = hostAllocate(bytes.length, 1);
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
  return [pointer, bytes.length];
}

function hostStrings(texts) {
  const pointer = hostAllocate(texts.length * 8, 4);
  texts.forEach((text, index) => {
    const [p, l] = hostString(text);
    memory().setUint32(pointer + index * 8, p, true);
    memory().setUint32(pointer + index * 8 + 4, l, true);
  });
  return [pointer, texts.length];
}

function writePair(address, [pointer, length]) {
  memory().setUint32(address, pointer, true);
  memory().setUint32(address + 4, length, true);
}

const counters = new Map(); // handle -> count
let nextCounter = 100;

// MARK: The module's accounts
//
// An exported resource: the module makes a handle of its own object with
// `resource.new` (a rep it chooses), which the host takes from the
// module's table when an export returns it; a borrow the host lends is the
// rep itself; an own handle the host gives back goes into the module's
// table; and dropping a handle calls the module's destructor with the rep.
const accountHandles = new Map(); // the module's table: handle -> rep
const accountsDropped = []; // reps whose destructor ran

function takeAccount(handle) {
  assert.ok(accountHandles.has(handle), "the module returns its handle");
  const rep = accountHandles.get(handle);
  accountHandles.delete(handle);
  return { rep };
}

function giveAccount(account) {
  const handle = newHandle();
  accountHandles.set(handle, account.rep);
  return handle;
}

function dropAccount(account) {
  accountsDropped.push(account.rep);
  exports[`${jobsModule}#[dtor]account`](account.rep);
}

// MARK: Futures and streams
//
// A channel has a readable and a writable end, each held by the module (a
// handle in its table, a waitable) or by the host. A copy the module
// starts completes at once when the host's side is ready, or blocks until
// the host reads or writes, when the module's end gets the event.
const BLOCKED = -1;
const COPY_COMPLETED = 0;
const COPY_DROPPED = 1;
const COPY_CANCELLED = 2;
const EVENT_STREAM_READ = 2;
const EVENT_STREAM_WRITE = 3;
const EVENT_FUTURE_READ = 4;
const EVENT_FUTURE_WRITE = 5;
const ends = new Map(); // the module's ends: handle -> end
const payloads = {
  u32: {
    size: 4,
    lower: (address, value) => memory().setUint32(address, value, true),
    lift: (address) => memory().getUint32(address, true),
  },
  u64: {
    size: 8,
    lower: (address, value) => memory().setBigUint64(address, value, true),
    lift: (address) => memory().getBigUint64(address, true),
  },
  string: {
    size: 8,
    lower: (address, value) => writePair(address, hostString(value)),
    lift: (address) =>
      readString(
        memory().getUint32(address, true),
        memory().getUint32(address + 4, true),
      ),
  },
};

// A channel the module made (both ends its), or the host made for it.
function channel(stream, payload, moduleReads, moduleWrites) {
  const entry = {
    stream,
    payload: payloads[payload],
    queue: [], // what the host wrote that the module has yet to read
    taken: [], // what the host read of the module's writes
    readerDropped: false,
    writerDropped: false,
    read: null, // the module's read pending: { pointer, length }
    write: null, // the module's write pending: { pointer, length }
    hostTakes: true, // whether the host reads what the module writes at once
    cancelBlocks: false, // whether a cancel waits for the host to stop the copy
  };
  if (moduleReads) {
    entry.readable = end(entry, true);
  }
  if (moduleWrites) {
    entry.writable = end(entry, false);
  }
  return entry;
}

function end(entry, readable) {
  const handle = newHandle();
  ends.set(handle, { handle, channel: entry, readable, set: 0, event: null });
  return handle;
}

// The module hands its end over to the host.
function takeEnd(handle, readable) {
  const moduleEnd = ends.get(handle);
  assert.ok(moduleEnd, "handing over an end the module holds");
  assert.equal(moduleEnd.readable, readable, "the end's kind");
  assert.equal(moduleEnd.set, 0, "an end handed over waits in no set");
  ends.delete(handle);
  if (readable) {
    moduleEnd.channel.readable = 0;
  } else {
    moduleEnd.channel.writable = 0;
  }
  return moduleEnd.channel;
}

function copyEvent(entry, readable, code) {
  const handle = readable ? entry.readable : entry.writable;
  const moduleEnd = ends.get(handle);
  const type = readable
    ? (entry.stream ? EVENT_STREAM_READ : EVENT_FUTURE_READ)
    : (entry.stream ? EVENT_STREAM_WRITE : EVENT_FUTURE_WRITE);
  moduleEnd.event = { code, type, sequence: eventSequence++ };
  activity++;
}

// The module's read of the queue: at most `length` values.
function fill(entry, pointer, length) {
  const count = Math.min(length, entry.queue.length);
  for (let index = 0; index < count; index++) {
    entry.payload.lower(
      pointer + index * entry.payload.size,
      entry.queue.shift(),
    );
  }
  return count;
}

// The module's write, taken by the host: at most `length` values.
function drain(entry, pointer, length) {
  for (let index = 0; index < length; index++) {
    entry.taken.push(entry.payload.lift(pointer + index * entry.payload.size));
  }
  return length;
}

// The host writes values to a channel the module reads.
function hostWrite(entry, values) {
  entry.queue.push(...values);
  if (entry.read && entry.queue.length > 0) {
    const { pointer, length } = entry.read;
    entry.read = null;
    copyEvent(
      entry,
      true,
      (fill(entry, pointer, length) << 4) | COPY_COMPLETED,
    );
  }
}

function hostDropWriter(entry) {
  entry.writerDropped = true;
  if (entry.read && entry.queue.length === 0) {
    entry.read = null;
    copyEvent(entry, true, (0 << 4) | COPY_DROPPED);
  }
}

// The host stops a read the module canceled, with what it wrote meanwhile.
function hostStopRead(entry, values = []) {
  assert.ok(entry.read?.cancelling, "the module canceled its read");
  const { pointer, length } = entry.read;
  entry.read = null;
  entry.queue.push(...values);
  copyEvent(
    entry,
    true,
    (fill(entry, pointer, length) << 4) | COPY_CANCELLED,
  );
}

// The host reads at most `length` of what the module writes.
function hostRead(entry, length) {
  assert.ok(entry.write, "the module is writing");
  const { pointer, length: writing } = entry.write;
  entry.write = null;
  const count = Math.min(length, writing);
  const values = [];
  for (let index = 0; index < count; index++) {
    values.push(entry.payload.lift(pointer + index * entry.payload.size));
  }
  copyEvent(entry, false, (count << 4) | COPY_COMPLETED);
  return values;
}

function channelBuiltins(stream) {
  const kind = stream ? "stream" : "future";
  return {
    new: (payload) => () => {
      const entry = channel(stream, payload, true, true);
      entry.hostTakes = false;
      return (BigInt(entry.writable) << 32n) | BigInt(entry.readable);
    },
    read: (handle, pointer, length = 1) => {
      const moduleEnd = ends.get(handle);
      assert.ok(moduleEnd?.readable, `${kind}.read of a readable end`);
      const entry = moduleEnd.channel;
      assert.equal(entry.read, null, "one read at a time");
      if (entry.queue.length > 0) {
        return (fill(entry, pointer, length) << 4) | COPY_COMPLETED;
      }
      if (entry.writerDropped) {
        return (0 << 4) | COPY_DROPPED;
      }
      entry.read = { pointer, length };
      return BLOCKED;
    },
    write: (handle, pointer, length = 1) => {
      const moduleEnd = ends.get(handle);
      assert.ok(
        moduleEnd && !moduleEnd.readable,
        `${kind}.write of a writable end`,
      );
      const entry = moduleEnd.channel;
      assert.equal(entry.write, null, "one write at a time");
      if (entry.readerDropped) {
        return (0 << 4) | COPY_DROPPED;
      }
      if (entry.hostTakes) {
        return (drain(entry, pointer, length) << 4) | COPY_COMPLETED;
      }
      entry.write = { pointer, length };
      return BLOCKED;
    },
    cancelRead: (handle) => {
      const entry = ends.get(handle).channel;
      assert.ok(entry.read, "canceling a pending read");
      assert.ok(!entry.read.cancelling, "canceling a read once");
      if (entry.cancelBlocks) {
        entry.read.cancelling = true;
        return BLOCKED;
      }
      entry.read = null;
      return (0 << 4) | COPY_CANCELLED;
    },
    cancelWrite: (handle) => {
      const entry = ends.get(handle).channel;
      assert.ok(entry.write, "canceling a pending write");
      entry.write = null;
      return (0 << 4) | COPY_CANCELLED;
    },
    dropReadable: (handle) => {
      const moduleEnd = ends.get(handle);
      assert.ok(moduleEnd?.readable, "dropping a readable end");
      assert.equal(moduleEnd.channel.read, null, "no read pending at the drop");
      moduleEnd.channel.readerDropped = true;
      ends.delete(handle);
    },
    dropWritable: (handle) => {
      const moduleEnd = ends.get(handle);
      assert.ok(moduleEnd && !moduleEnd.readable, "dropping a writable end");
      assert.equal(
        moduleEnd.channel.write,
        null,
        "no write pending at the drop",
      );
      moduleEnd.channel.writerDropped = true;
      ends.delete(handle);
    },
  };
}

const streams = channelBuiltins(true);
const futures = channelBuiltins(false);

// The built-ins of one type, as the module imports them.
function builtins(kind, index, name, payload) {
  const b = kind === "stream" ? streams : futures;
  const suffix = `${index}]${name}`;
  return {
    [`[${kind}-new-${suffix}`]: b.new(payload),
    [`[async-lower][${kind}-read-${suffix}`]: b.read,
    [`[async-lower][${kind}-write-${suffix}`]: b.write,
    [`[async-lower][${kind}-cancel-read-${suffix}`]: b.cancelRead,
    [`[async-lower][${kind}-cancel-write-${suffix}`]: b.cancelWrite,
    [`[${kind}-drop-readable-${suffix}`]: b.dropReadable,
    [`[${kind}-drop-writable-${suffix}`]: b.dropWritable,
  };
}

// What the host did with the channels the checks look at.
const hostChannels = {};

const noted = [];
const imports = {
  $root: {
    "[waitable-set-new]": () => {
      const handle = newHandle();
      sets.set(handle, true);
      return handle;
    },
    "[waitable-set-drop]": (set) => {
      assert.ok(sets.delete(set), "dropping a set that exists");
      for (const entry of [...subtasks.values(), ...ends.values()]) {
        assert.notEqual(entry.set, set, "dropping a set with members");
      }
    },
    "[waitable-join]": (waitable, set) => {
      const entry = subtasks.get(waitable) ?? ends.get(waitable);
      assert.ok(entry, "joining a subtask or an end");
      assert.ok(set === 0 || sets.has(set), "joining a set that exists");
      entry.set = set;
    },
    "[subtask-drop]": (handle) => {
      const entry = subtasks.get(handle);
      assert.ok(entry, "dropping a subtask that exists");
      assert.equal(entry.state, RETURNED, "dropping a returned subtask");
      subtasks.delete(handle);
    },
    "[context-get-0]": () => current.context,
    "[context-set-0]": (value) => {
      current.context = value;
    },
  },
  "[export]$root": {
    "[task-cancel]": () => {
      assert.ok(current.cancelRequested, "task.cancel after a cancellation");
      taskReturned({ canceled: true });
    },
    "[task-return]run": (value) => taskReturned(BigInt.asUintN(64, value)),
  },
  [`[export]${jobsModule}`]: {
    ...builtins("future", 0, "delayed", "u64"),
    "[task-return]total": (value) => taskReturned(value >>> 0),
    "[task-return]greet": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[task-return]both": (x, y) => taskReturned({ x, y }),
    "[task-return]find": (value) => taskReturned(BigInt.asUintN(64, value)),
    "[task-return]hold": (value) => taskReturned(value >>> 0),
    "[task-return]release": () => taskReturned(null),
    "[task-return]early": (value) => taskReturned(value >>> 0),
    "[task-return]cancelable": (value) => taskReturned(value >>> 0),
    "[task-return]fail": (value) => taskReturned(value >>> 0),
    "[task-return]count-to": (readable) =>
      taskReturned(takeEnd(readable, true)),
    "[task-return]concat": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[task-return]delayed": (readable) => taskReturned(takeEnd(readable, true)),
    "[task-return]pipes": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[task-return]abandon": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[task-return]card": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[task-return]tally": (pointer, length) =>
      taskReturned(readString(pointer, length)),
    "[resource-new]account": (rep) => {
      const handle = newHandle();
      accountHandles.set(handle, rep);
      return handle;
    },
    "[resource-rep]account": (handle) => {
      assert.ok(accountHandles.has(handle), "the rep of the module's handle");
      return accountHandles.get(handle);
    },
    "[resource-drop]account": (handle) => {
      const rep = accountHandles.get(handle);
      assert.ok(accountHandles.delete(handle), "dropping the module's handle");
      accountsDropped.push(rep);
      exports[`${jobsModule}#[dtor]account`](rep);
    },
    "[task-return][method]account.deposit": (value) =>
      taskReturned(value >>> 0),
    "[task-return][static]account.open": (handle) =>
      taskReturned(takeAccount(handle)),
  },
  [hostModule]: {
    "[async-lower]add": (a, b, area) =>
      lower(
        "add",
        () => {},
        () => memory().setUint32(area, (a + b) >>> 0, true),
      ),
    "[async-lower]note": (pointer, length) =>
      lower("note", () => noted.push(readString(pointer, length)), () => {}),
    "[async-lower]measure": (pointer, length, scale, area) => {
      let text;
      return lower(
        "measure",
        () => {
          text = readString(pointer, length);
        },
        () => {
          memory().setInt32(area, text.length * scale, true);
          memory().setInt32(area + 4, -scale, true);
        },
      );
    },
    "[async-lower]lookup": (key, area) =>
      lower("lookup", () => {}, () => {
        const known = { 3: 42n };
        memory().setUint8(area, key in known ? 1 : 0);
        if (key in known) {
          memory().setBigUint64(area + 8, known[key], true);
        }
      }),
    "[async-lower]name-of": (id, area) =>
      lower(
        "name-of",
        () => {},
        () => writePair(area, hostString(`name ${id}`)),
      ),
    "[async-lower]names": (count, area) =>
      lower(
        "names",
        () => {},
        () =>
          writePair(
            area,
            hostStrings(Array.from({ length: count }, (_, i) => `n${i}`)),
          ),
      ),
    "[async-lower]bytes-of": (pointer, length, area) => {
      let text;
      return lower(
        "bytes-of",
        () => {
          text = readString(pointer, length);
        },
        () => {
          const bytes = encoder.encode(text + "!");
          const block = hostAllocate(bytes.length, 1);
          new Uint8Array(exports.memory.buffer, block, bytes.length).set(bytes);
          writePair(area, [block, bytes.length]);
        },
      );
    },
    "[async-lower]profile": (id, area) =>
      lower("profile", () => {}, () => {
        writePair(area, hostString(`person ${id}`));
        writePair(
          area + 8,
          hostStrings(Array.from({ length: id % 3 }, (_, i) => `t${i}`)),
        );
        memory().setUint32(area + 16, 20 + id, true);
      }),
    // Synchronous: the string is allocated during the call.
    "label": (id, area) => writePair(area, hostString(`L${id}`)),
    "[constructor]counter": (start) => {
      const handle = nextCounter++;
      counters.set(handle, start);
      return handle;
    },
    "[async-lower][method]counter.bump": (self, by, area) =>
      lower("bump", () => {}, () => {
        counters.set(self, counters.get(self) + by);
        memory().setUint32(area, counters.get(self), true);
      }),
    "[async-lower][method]counter.describe": (self, area) =>
      lower(
        "describe",
        () => {},
        () => writePair(area, hostString(`#${self}=${counters.get(self)}`)),
      ),
    "[async-lower][static]counter.make": (start, area) =>
      lower("make", () => {}, () => {
        const handle = nextCounter++;
        counters.set(handle, start);
        memory().setUint32(area, handle, true);
      }),
    "[resource-drop]counter": (handle) => {
      assert.ok(counters.delete(handle), "dropping a counter that exists");
    },
    ...builtins("stream", 0, "sum-stream", "u32"),
    ...builtins("stream", 0, "words", "string"),
    ...builtins("future", 0, "later", "string"),
    ...builtins("future", 0, "wait-for", "u32"),
    // The host takes the stream and reads what the module writes as it
    // writes it; the call returns once the writer has dropped its end.
    "[async-lower]sum-stream": (readable, area) => {
      const entry = takeEnd(readable, true);
      entry.hostTakes = true;
      hostChannels.sum = entry;
      return lower("sum-stream", () => {}, () => {
        assert.ok(entry.writerDropped, "the sum after the writer is done");
        memory().setUint32(area, entry.taken.reduce((a, b) => a + b, 0), true);
      });
    },
    // A stream the host writes later.
    "words": (count) => {
      const entry = channel(true, "string", true, false);
      entry.count = count;
      hostChannels.words = entry;
      return entry.readable;
    },
    "[async-lower]later": (id, area) =>
      lower("later", () => {}, () => {
        const entry = channel(false, "string", true, false);
        entry.id = id;
        hostChannels.later = entry;
        memory().setUint32(area, entry.readable, true);
      }),
    "[async-lower]wait-for": (readable, area) => {
      const entry = takeEnd(readable, true);
      entry.hostTakes = true;
      return lower("wait-for", () => {}, () => {
        assert.equal(entry.taken.length, 1, "the future's value");
        memory().setUint32(area, entry.taken[0], true);
      });
    },
    "[async-lower]sum5": (block, area) => {
      let values;
      return lower(
        "sum5",
        () => {
          values = [0, 4, 8, 12, 16].map((offset) =>
            memory().getUint32(block + offset, true)
          );
        },
        () => memory().setUint32(area, values.reduce((a, b) => a + b, 0), true),
      );
    },
  },
};

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(fs.readFileSync(corePath)),
  imports,
);
const exports = instance.exports;

// MARK: Component tasks

let tasks = [];
let nextTask = 1;

function taskReturned(value) {
  assert.ok(!current.returned, `${current.name} returns once`);
  current.returned = true;
  current.result = value;
  activity++;
}

function call(task, fn, ...args) {
  const previous = current;
  current = task;
  try {
    return fn(...args);
  } finally {
    current = previous;
  }
}

function settle(task, code) {
  switch (code & 0xf) {
    case 0:
      task.status = "exit";
      assert.ok(task.returned, `${task.name} returned before it exited`);
      break;
    case 1:
      task.status = "yield";
      break;
    case 2:
      task.status = "wait";
      task.set = code >>> 4;
      assert.ok(sets.has(task.set), `${task.name} waits on a set that exists`);
      break;
    default:
      throw new Error(`unknown callback code ${code}`);
  }
}

function exportName(name) {
  return name === "run" ? name : `${jobsModule}#${name}`;
}

// Starts an async export with its flat arguments.
function start(name, ...args) {
  const task = {
    id: nextTask++,
    name,
    context: 0,
    returned: false,
    status: null,
  };
  tasks.push(task);
  settle(task, call(task, exports[`[async-lift]${exportName(name)}`], ...args));
  return task;
}

function callback(task, event, waitable, code) {
  settle(
    task,
    call(
      task,
      exports[`[callback][async-lift]${exportName(task.name)}`],
      event,
      waitable,
      code,
    ),
  );
}

// Delivers the events waiting tasks can take, oldest first, and calls
// yielding tasks back, until nothing more happens.
function pump() {
  for (let round = 0; round < 10000; round++) {
    const before = activity;
    for (const task of tasks) {
      if (task.status !== "wait") {
        continue;
      }
      const ready = [...subtasks.values(), ...ends.values()]
        .filter((entry) => entry.set === task.set && entry.event)
        .sort((a, b) => a.event.sequence - b.event.sequence);
      if (ready.length > 0) {
        const entry = ready[0];
        const { state, code, type } = entry.event;
        entry.event = null;
        if (type === undefined) {
          callback(task, EVENT_SUBTASK, entry.handle, state);
        } else {
          callback(task, type, entry.handle, code);
        }
        activity++;
      }
    }
    for (const task of tasks) {
      if (task.status === "yield") {
        callback(task, 0, 0, 0);
      }
    }
    tasks = tasks.filter((task) => task.status !== "exit");
    if (activity === before) {
      return;
    }
  }
  throw new Error("the tasks never settled");
}

function allocate(bytes, alignment) {
  return exports.cabi_realloc(0, 0, alignment, bytes);
}

function lowerString(text) {
  const bytes = encoder.encode(text);
  const pointer = allocate(bytes.length, 1);
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
  return [pointer, bytes.length];
}

function lowerList(values) {
  const pointer = allocate(values.length * 4, 4);
  values.forEach((value, index) =>
    memory().setUint32(pointer + index * 4, value, true)
  );
  return [pointer, values.length];
}

function done(task, expected, message) {
  equal(task.status, "exit", `${message}: exited`);
  equal(task.result, expected, message);
}

// Where the boundary memory's arena starts once no task holds memory: a
// call empties it down to its floor, and the next allocation is there.
// While the module holds what the host allocates (an import whose result
// holds strings or lists is pending), that allocation is below the floor
// (which it raises) after a 16-byte header, so the allocation is a
// string an export frees once it has read it.
const holding = ["name-of", "names", "bytes-of", "profile", "describe"];
function floor() {
  exports.plain(0);
  const held = lowered.some((entry) => holding.includes(entry.name));
  const [pointer, length] = lowerString("x");
  equal(exports.measure(pointer, length), 1, "measure");
  return held ? pointer - 16 : pointer;
}

// MARK: Checks

equal(exports.plain(3), 9, "a synchronous export next to async ones");
const base = floor();

// Returned at once: the task exits from its first step.
modes.add = "now";
done(
  start("total", ...lowerList([1, 2, 3])),
  6,
  "total with imports that return at once",
);

// Each await waits for the host: one subtask at a time.
modes.add = "started";
{
  const task = start("total", ...lowerList([5, 6, 7]));
  equal(task.status, "wait", "total waits for its first add");
  for (const expected of [1, 1, 1]) {
    equal(lowered.length, expected, "one add at a time");
    complete(lowered[0]);
    pump();
  }
  done(task, 18, "total, one add at a time");
}

// Arguments stay in memory until the host starts the call, while other
// exports allocate; results land in their areas while other calls run.
modes.note = "starting";
modes.measure = "started";
{
  const greet = start("greet", ...lowerString("ann"));
  equal(greet.status, "wait", "greet waits for its note");
  const both = start("both", ...lowerString("abcd"), ...lowerString("xy"));
  const [first, second] = lowered.filter((entry) => entry.name === "measure");
  complete(second);
  const other = start(
    "greet",
    ...lowerString("bob, whose name is long enough to spill"),
  );
  startOnly(lowered.find((entry) => entry.name === "note"));
  equal(noted, ["greeting ann"], "the note's argument, read when it started");
  complete(first);
  pump();
  done(
    both,
    { x: 4 * 1 + 2 * 10, y: -1 + -10 },
    "both measures, completed out of order",
  );
  equal(greet.status, "wait", "greet waits until its note returns");
  for (const entry of lowered.filter((entry) => entry.name === "note")) {
    complete(entry);
  }
  pump();
  done(greet, "hello, ann!", "greet after its note");
  done(
    other,
    "hello, bob, whose name is long enough to spill!",
    "another greet",
  );
  equal(noted.length, 2, "both notes");
}

// Options through the area, a world-level export, Task.Yield and WhenAll.
modes.lookup = "started";
modes.sum5 = "started";
{
  const three = start("find", 3);
  const four = start("find", 4);
  for (const entry of [...lowered].reverse()) {
    complete(entry);
  }
  pump();
  done(three, 42n, "find some");
  done(four, 16n, "find none");

  const run = start("run", 5);
  pump();
  while (lowered.length > 0) {
    complete(lowered[lowered.length - 1]);
    pump();
  }
  done(
    run,
    6n * 1000n + 25n + 25n * 1000000n,
    "run: yield, WhenAll, then find",
  );
}

// A task with nothing of its own to wait for yields until another
// export's call completes it.
{
  const hold = start("hold");
  equal(hold.status, "yield", "hold yields");
  pump();
  equal(hold.status, "yield", "hold still yields");
  const release = start("release", 7);
  pump();
  done(release, null, "release");
  done(hold, 8, "hold, released by another call");
}

// A result returned before the task is over.
modes.note = "started";
{
  const early = start("early", 4);
  equal(early.returned, true, "early returned from its first step");
  equal(early.result, 8, "early's result");
  equal(early.status, "wait", "early waits for its note");
  complete(lowered[0]);
  pump();
  equal(early.status, "exit", "early exits after its note");
}

// Cancellation: the token the export read is canceled, the task is.
{
  const task = start("cancelable", 1);
  equal(task.status, "wait", "cancelable waits for its add");
  task.cancelRequested = true;
  callback(task, EVENT_CANCELLED, 0, 0);
  equal(task.result, { canceled: true }, "cancelable called task.cancel");
  equal(task.status, "wait", "cancelable waits for its add after canceling");
  complete(lowered[0]);
  pump();
  equal(task.status, "exit", "cancelable exits after its add");
  const kept = start("cancelable", 2);
  complete(lowered[0]);
  pump();
  done(kept, 3, "cancelable, not canceled");
}

// Futures and streams, through the host both ways.
modes["sum-stream"] = "started";
modes.later = "started";
modes["wait-for"] = "started";
{
  // pipes writes 1..4 to the host (which takes them at once) and drops
  // its end; the host returns their sum.
  const pipes = start("pipes", 4);
  equal(hostChannels.sum.taken, [1, 2, 3, 4], "the host took the writes");
  equal(hostChannels.sum.writerDropped, true, "the writer dropped its end");
  complete(lowered.find((entry) => entry.name === "sum-stream"));
  pump();
  // Then it reads words two at a time, which the host writes when it
  // likes, between the module's calls: strings it allocates.
  const words = hostChannels.words;
  equal(words.count, 4, "words(4)");
  equal(words.read?.length, 2, "a read of two words waits");
  hostWrite(words, ["alpha", "beta", "gamma"]);
  pump();
  hostWrite(words, ["delta"]);
  pump();
  hostDropWriter(words);
  pump();
  // A future the host resolves later.
  complete(lowered.find((entry) => entry.name === "later"));
  pump();
  equal(hostChannels.later.read?.length, 1, "the future's read waits");
  hostWrite(hostChannels.later, [`later ${hostChannels.later.id}`]);
  hostDropWriter(hostChannels.later);
  pump();
  // A future the module writes, which the host takes at once.
  complete(lowered.find((entry) => entry.name === "wait-for"));
  pump();
  done(
    pipes,
    "4:10:alpha,beta,gamma,delta:later 4:True:28",
    "pipes: streams and futures both ways",
  );
  equal(words.readerDropped, true, "the module dropped the words' end");

  // A stream the module returns and writes as the host reads it: a
  // write blocks until the host reads, three values at a time.
  const count = start("count-to", 7);
  equal(count.returned, true, "count-to returned its stream at once");
  const numbers = count.result;
  const read = [];
  while (numbers.write) {
    read.push(...hostRead(numbers, 2));
    pump();
  }
  equal(read, [1, 2, 3, 4, 5, 6, 7], "the numbers, read two at a time");
  equal(numbers.writerDropped, true, "the module dropped its end at the end");
  equal(count.status, "exit", "count-to exits once written");

  // A stream the host passes and writes: joined once it is done.
  const parts = channel(true, "string", true, false);
  const concat = start("concat", parts.readable);
  hostWrite(parts, ["a"]);
  pump();
  hostWrite(parts, ["b", "c"]);
  pump();
  hostDropWriter(parts);
  pump();
  done(concat, "a+b+c", "concat of what the host wrote");
  equal(parts.readerDropped, true, "concat dropped its end");

  // Reads the host never answers: one canceled by a token once a host
  // call returns, one by dropping the end.
  modes.add = "started";
  const silent = channel(true, "u32", true, false);
  const abandon = start("abandon", silent.readable);
  equal(silent.read?.length, 4, "abandon's read waits");
  complete(lowered.find((entry) => entry.name === "add"));
  pump();
  done(abandon, "canceled:canceled:False", "abandon's reads were canceled");
  equal(silent.read, null, "no read pending after the cancellations");
  equal(silent.readerDropped, true, "abandon dropped its end");

  // The same, where each cancel waits for the host to stop the read
  // (BLOCKED): the token's read gets what the host wrote meanwhile, and
  // the end is dropped once the second read has stopped.
  modes.add = "started";
  const slow = channel(true, "u32", true, false);
  slow.cancelBlocks = true;
  const lagging = start("abandon", slow.readable);
  complete(lowered.find((entry) => entry.name === "add"));
  pump();
  equal(slow.read?.cancelling, true, "the token's cancel waits for the host");
  equal(lagging.status, "wait", "abandon waits for its canceled read");
  hostStopRead(slow, [5, 6]);
  pump();
  equal(slow.read?.cancelling, true, "dropping the end cancels its read");
  equal(slow.readerDropped, false, "the end stays until its read stops");
  hostStopRead(slow);
  pump();
  done(
    lagging,
    "read 2:canceled:False",
    "abandon's reads, stopped by the host later",
  );
  equal(slow.readerDropped, true, "abandon dropped its end after the read");

  // A future the module resolves after a host call of its own.
  modes.add = "started";
  const delayed = start("delayed", 21);
  const promise = delayed.result;
  equal(promise.write, null, "nothing is written before the add returns");
  complete(lowered.find((entry) => entry.name === "add"));
  pump();
  equal(promise.write?.length, 1, "the module writes the future");
  equal(hostRead(promise, 1), [42000n], "the future's value");
  pump();
  equal(delayed.status, "exit", "delayed exits once its future is taken");
  equal(ends.size, 0, "the module holds no end");
  equal(floor(), base, "no memory is held once the channels are done");

  // Many streams at once, whose strings the host allocates while others
  // are pending, do not grow the memory.
  const pages = exports.memory.buffer.byteLength;
  const open = [];
  const joins = [];
  for (let round = 0; round < 300; round++) {
    const each = channel(true, "string", true, false);
    const task = start("concat", each.readable);
    joins.push([round, task]);
    open.push([round, each, task]);
    hostWrite(each, [`r${round}`, "x".repeat(round % 40)]);
    pump();
    if (open.length > 3) {
      const [, oldest] = open.shift();
      hostDropWriter(oldest);
      pump();
    }
  }
  for (const [, each] of open) {
    hostDropWriter(each);
    pump();
  }
  for (const [round, task] of joins) {
    assert.equal(task.result, `r${round}+${"x".repeat(round % 40)}`);
  }
  equal(
    exports.memory.buffer.byteLength,
    pages,
    "overlapping streams reuse the held memory",
  );
  equal(floor(), base, "no memory is held once the streams are done");
}

// Async imports whose results hold strings and lists the host allocates
// when they return, between the module's calls: held until the glue has
// read them, however the calls overlap.
modes["name-of"] = "started";
modes.names = "started";
modes["bytes-of"] = "started";
modes.profile = "started";
{
  const card = start("card", 7);
  equal(card.status, "wait", "card waits for its imports");
  // The last call first, then the others, each result written as it
  // returns, while another card starts.
  complete(lowered.find((entry) => entry.name === "profile"));
  const other = start("card", 4);
  for (const name of ["names", "name-of"]) {
    complete(lowered.find((entry) => entry.name === name));
  }
  pump();
  while (lowered.length > 0) {
    complete(lowered[lowered.length - 1]);
    pump();
  }
  done(
    card,
    "L7:name 7/n0,n1,n2/person 7[t0]27/7",
    "card: strings, lists and a record the host allocated",
  );
  done(
    other,
    "L4:name 4//person 4[t0]24/7",
    "another card, overlapping",
  );
  equal(floor(), base, "what the host allocated was freed once read");
}

// Async methods and statics of a resource.
modes.bump = "started";
modes.describe = "started";
modes.make = "started";
{
  const tally = start("tally", 3, 4);
  while (lowered.length > 0) {
    complete(lowered[0]);
    pump();
  }
  done(
    tally,
    "7,74,#100=7|#101=74",
    "tally through a resource's async members",
  );
  equal(counters.size, 0, "both counters were dropped");
}

// An exported resource's objects, which the host holds handles of.
{
  const jobs = (name, ...args) => exports[`${jobsModule}#${name}`](...args);
  const pairString = (area) =>
    readString(
      memory().getUint32(area, true),
      memory().getUint32(area + 4, true),
    );
  const statement = (account) =>
    pairString(jobs("[method]account.statement", account.rep));
  const closed = () => {
    const area = jobs("closed");
    const elements = memory().getUint32(area, true);
    const length = memory().getUint32(area + 4, true);
    return Array.from(
      { length },
      (_, index) => pairString(elements + index * 8),
    );
  };

  // The constructor's object leaves as a new handle, whose rep is its
  // entry in the class's table.
  const ann = takeAccount(
    jobs("[constructor]account", ...lowerString("ann")),
  );
  equal(ann.rep, 1, "the first object's rep");
  equal(statement(ann), "ann:0", "a method on the lent rep");

  // An async method, and an async static whose result is a new object.
  modes.add = "started";
  const deposit = start("[method]account.deposit", ann.rep, 5);
  complete(lowered.find((entry) => entry.name === "add"));
  pump();
  done(deposit, 5, "an async method of an exported resource");
  const opening = start("[static]account.open", ...lowerString("bob"), 3, 4);
  complete(lowered.find((entry) => entry.name === "add"));
  pump();
  equal(opening.status, "exit", "an async static of an exported resource");
  const bob = opening.result;
  equal(bob.rep, 2, "the second object's rep");
  equal(jobs("combined", ann.rep, bob.rep), 12, "two lent objects");

  // Another handle of the same object counts: dropping one keeps it.
  const again = takeAccount(jobs("[static]account.latest"));
  equal(again.rep, bob.rep, "the same object, the same rep");
  dropAccount(again);
  equal(closed(), [], "the object is still held");

  // Given back as own, the object's last handle goes, then the method
  // runs: the module learns of it first (OnDropped).
  jobs("[method]account.absorb", ann.rep, giveAccount(bob));
  equal(accountHandles.size, 0, "the module dropped the handle given back");
  equal(closed(), ["bob"], "the module learned bob's last handle went");
  equal(statement(ann), "ann:12", "absorb moved the balance");

  // The host drops its last handle: the destructor ends the object's
  // entry, which the next object takes.
  dropAccount(ann);
  equal(closed(), ["bob", "ann"], "both objects are let go of");
  const cy = takeAccount(jobs("[constructor]account", ...lowerString("cy")));
  equal(cy.rep, ann.rep, "a rep let go of is used again");
  dropAccount(cy);
  equal(accountsDropped, [2, 2, 1, 1], "the destructor ran per handle");
}

// The held memory is used again: many overlapping calls do not grow it.
{
  equal(floor(), base, "no memory is held between the checks");
  // A call outstanding throughout keeps its area held low in the memory.
  const anchor = start("total", ...lowerList([1000]));
  const anchorAdd = lowered[0];
  const pages = exports.memory.buffer.byteLength;
  // Each round's calls wait while the next round's start, so a newer
  // area is always held above the older ones being freed.
  const calls = [];
  for (let round = 0; round < 1000; round++) {
    const older = lowered.filter((entry) => entry !== anchorAdd);
    calls.push([round, start("total", ...lowerList([round, 1]))]);
    calls.push([
      round,
      start(
        "both",
        ...lowerString("x".repeat(round % 50)),
        ...lowerString("y".repeat(200)),
      ),
    ]);
    calls.push([round, start("card", round % 5)]);
    if (round % 100 === 99) {
      // What is held stays a few areas, however many rounds go by.
      assert.ok(
        floor() < base + 256,
        `the held memory stays small (round ${round})`,
      );
    }
    for (const entry of round % 2 === 0 ? older : older.reverse()) {
      complete(entry);
      pump();
    }
  }
  for (
    let others = lowered.filter((entry) => entry !== anchorAdd);
    others.length > 0;
  ) {
    complete(others[0]);
    pump();
    others = lowered.filter((entry) => entry !== anchorAdd);
  }
  for (const [round, task] of calls) {
    assert.equal(task.status, "exit");
    const id = round % 5;
    assert.deepEqual(
      task.result,
      task.name === "total"
        ? round + 1
        : task.name === "card"
        ? `L${id}:name ${id}/${
          Array.from({ length: id % 4 }, (_, i) => `n${i}`).join(",")
        }/person ${id}[${
          Array.from({ length: id % 3 }, (_, i) => `t${i}`).join(",")
        }]${20 + id}/7`
        : { x: (round % 50) + 2000, y: -11 },
    );
  }
  equal(
    exports.memory.buffer.byteLength,
    pages,
    "overlapping calls reuse the held memory",
  );
  checks++; // the floor stayed low throughout
  complete(anchorAdd);
  pump();
  done(anchor, 1000, "the call outstanding throughout");
  equal(floor(), base, "no memory is held once every call is over");
  equal(subtasks.size, 0, "every subtask was dropped");
  equal(sets.size, 0, "every waitable set was dropped");
}

// What fails the method faults the call that would return it.
{
  start("fail", 2);
  assert.throws(() => {
    complete(lowered[0]);
    pump();
  }, WebAssembly.RuntimeError);
  equal(
    exports.__fault.value,
    14,
    "the exception escaping the export's callback is its fault (InvalidOperationException's)",
  );
}

// A component runtime's own callback loop, WASI 0.3 clock, filesystem and
// standard output: Wasmtime 48 or later, if installed.
const version = spawnSync("wasmtime", ["--version"], { encoding: "utf8" });
const major = Number(/wasmtime (\d+)/.exec(version.stdout ?? "")?.[1] ?? 0);
if (version.error || version.status !== 0 || major < 48) {
  console.log(
    "SKIP: no Wasmtime 48 or later to run the sleepy and files components.",
  );
} else {
  const result = spawnSync(
    "wasmtime",
    [
      "run",
      "-W",
      "component-model-async=y",
      "-W",
      "component-model-more-async-builtins=y",
      "-S",
      "p3",
      "--invoke",
      "nap(20)",
      sleepyPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  equal(
    result.stdout.trim(),
    "60",
    "Wasmtime runs two waits at once, then another",
  );

  // files.wit's probe over a directory of its own: an async method whose
  // result is a string, a stream of records holding strings and the
  // future of its outcome, and a stream of bytes the module writes to
  // standard output, whose outcome is a future too.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wit-files-"));
  try {
    fs.writeFileSync(path.join(directory, "file.txt"), "hi\n");
    fs.symlinkSync("file.txt", path.join(directory, "link"));
    fs.mkdirSync(path.join(directory, "sub"));
    const probe = (link) =>
      spawnSync(
        "wasmtime",
        [
          "run",
          "-W",
          "component-model-async=y",
          "-W",
          "component-model-more-async-builtins=y",
          "-S",
          "p3",
          "--dir",
          `${directory}::/`,
          "--invoke",
          `probe(${JSON.stringify(link)})`,
          filesPath,
        ],
        { encoding: "utf8" },
      );
    const linked = probe("link");
    assert.equal(linked.status, 0, linked.stderr);
    equal(
      linked.stdout,
      'file.txt|file.txt,link@,sub|True\n"file.txt|file.txt,link@,sub|True|33|True"\n',
      "Wasmtime reads a link, lists a directory and writes standard output through streams",
    );
    const unlinked = probe("sub");
    assert.equal(unlinked.status, 0, unlinked.stderr);
    equal(
      unlinked.stdout,
      '?|file.txt,link@,sub|True\n"?|file.txt,link@,sub|True|26|True"\n',
      "Wasmtime's error for reading a directory as a link",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // ledger.wit's modules composed into one component: the teller's async
  // run makes, lends, gives back, audits (an async method) and drops the
  // bank's accounts, through Wasmtime's handle tables and destructor calls.
  const compose = spawnSync("wasm-tools", ["compose", "--help"], {
    encoding: "utf8",
  });
  if (compose.error || compose.status !== 0) {
    console.log("SKIP: no wasm-tools compose for the ledger's components.");
  } else {
    const ledger = fs.mkdtempSync(path.join(os.tmpdir(), "wit-ledger-"));
    try {
      // compose names the dependency after its file, in kebab case.
      const bank = path.join(ledger, "bank.wasm");
      const composed = path.join(ledger, "ledger.wasm");
      fs.copyFileSync(bankPath, bank);
      const composing = spawnSync(
        "wasm-tools",
        ["compose", tellerPath, "-d", bank, "-o", composed],
        { encoding: "utf8" },
      );
      assert.equal(composing.status, 0, composing.stderr);
      const run = spawnSync(
        "wasmtime",
        ["run", "-W", "component-model-async=y", "--invoke", "run()", composed],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stderr);
      equal(
        run.stdout.trim(),
        '"12|12|ann:12|bob|bob,ann"',
        "Wasmtime runs one module's exported resource from another",
      );
    } finally {
      fs.rmSync(ledger, { recursive: true, force: true });
    }
  }
}

console.log(`wit-tasks: ${checks} checks passed`);
