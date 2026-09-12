// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The components of tests/wit/sleepy.wit and tests/wit/files.wit linked by
// wlink into core modules, run against a host of wlink's async host ABI
// (tilde/aseipp/wlink/ASYNC.md) rather than a component runtime: the
// component model's async between the C# glue and the host is wlink's
// runtime, inside each module. The host completes WASI 0.3's clock waits,
// reads a link, lists a directory through a stream of records holding
// strings and a future of its outcome, both of whose writable ends it
// holds, and reads what the module writes to standard output through a
// stream of bytes whose readable end it is handed. And tests/wit/ledger.wit's
// two modules linked together: one's exported resource, which the other
// makes, lends, gives back and drops through wlink's handle tables, its
// destructor run as the last handle goes. Arguments: the linked sleepy
// module, the linked files module, then the linked ledger module.
import assert from "node:assert/strict";
import fs from "node:fs";

const [sleepyPath, filesPath, ledgerPath] = process.argv.slice(2);
if (!sleepyPath || !filesPath || !ledgerPath) {
  throw new Error(
    "Usage: wit-linked.mjs <sleepy.linked.wasm> <files.linked.wasm> <ledger.linked.wasm>",
  );
}

let checks = 0;
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

const STARTED = 1;
const RETURNED = 2;
const BLOCKED = 0xffffffff;
const COMPLETED = 0;
const DROPPED = 1;
const STREAM_READ = 2;
const STREAM_WRITE = 3;
const FUTURE_WRITE = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function instantiate(path, imports) {
  return new WebAssembly.Instance(
    new WebAssembly.Module(fs.readFileSync(path)),
    imports,
  ).exports;
}

// A host's turn of the scheduler: every ready task runs until none has
// anything new to do.
function settle(exports) {
  let pumps = 0;
  while (exports["wlink:async:pump"]()) {
    assert.ok(++pumps < 10000, "the scheduler settles");
  }
}

// The two ends of a stream or future the host makes: readable, writable.
function ends(packed) {
  return [Number(packed & 0xffffffffn), Number(packed >> 32n)];
}

// MARK: sleepy: two clock waits at once, then a third

function nap(order, cancel) {
  const waits = [];
  const results = [];
  const imports = {
    "wasi:clocks/monotonic-clock@0.3.0": {
      "wait-for": (subtask, howLong) => {
        waits.push({ subtask, howLong: BigInt.asUintN(64, howLong) });
        return STARTED;
      },
    },
    "wlink:async": {
      // Nothing in the module blocks: its exports are lifted with callbacks.
      wait: () => 0,
      cancel: () => assert.fail("the module cancels no wait"),
      "task-cancelled": () => assert.fail("nap returns when cancelled"),
    },
    "wlink:task-return": {
      nap: (task, value) => results.push([task, value >>> 0]),
    },
  };
  const exports = instantiate(sleepyPath, imports);
  const status = exports.nap(20);
  equal(status & 15, STARTED, "nap waits for the clock");
  const task = status >>> 4;
  equal(
    waits.map((wait) => wait.howLong),
    [20000000n, 40000000n],
    "two waits at once",
  );
  if (cancel) {
    // The method does not look at its token, so it goes on and returns.
    exports["wlink:async:cancel"](task);
    settle(exports);
  }
  for (const index of order) {
    exports["wlink:async:resolve"](waits[index].subtask, RETURNED);
  }
  settle(exports);
  equal(waits.length, 3, "the third wait starts once both are over");
  equal(waits[2].howLong, 1000n, "the third wait is a microsecond");
  equal(results, [], "nap has not returned");
  exports["wlink:async:resolve"](waits[2].subtask, RETURNED);
  settle(exports);
  equal(results, [[task, 60]], "nap returns 20 + 40");
  equal(exports["wlink:async:trap"].value, 0, "no runtime trap");
}

nap([0, 1], false);
nap([1, 0], false);
nap([1, 0], true);

// MARK: files: a link, a directory listing, standard output

const DESCRIPTOR = 7;
const ENTRY_SIZE = 24;
// descriptor-type's cases, by index.
const DIRECTORY = 2;
const SYMBOLIC_LINK = 4;
const REGULAR_FILE = 5;
// error-code's `invalid`.
const INVALID = 11;

function probe(link, deferReadlink) {
  const view = (name) => new DataView(exports[name].buffer);
  const bytes = (name) => new Uint8Array(exports[name].buffer);
  const importMemory = (fn) => `wlink:import:${fn}:memory`;
  const importRealloc = (fn) => exports[`wlink:import:${fn}:realloc`];
  const PREOPENS = "wasi:filesystem/preopens@0.3.0#get-directories";
  const READLINK = "wasi:filesystem/types@0.3.0#[method]descriptor.readlink-at";
  const READ_DIRECTORY =
    "wasi:filesystem/types@0.3.0#[method]descriptor.read-directory";

  // The host's buffers, at the bottom of `wlink:host`; what the module's
  // copies allocate there goes above them.
  let heap = 4096;
  const allocate = (align, size) => {
    heap = Math.ceil(heap / align) * align;
    const at = heap;
    heap += size;
    const memory = exports["wlink:host"];
    while (heap > memory.buffer.byteLength) memory.grow(1);
    return at;
  };
  const hostString = (text) => {
    const encoded = encoder.encode(text);
    const at = allocate(1, encoded.length);
    bytes("wlink:host").set(encoded, at);
    return [at, encoded.length];
  };

  const events = new Map();
  let readlink = null;
  let listing = null;
  let output = null;
  let returned = null;

  // Writes `result<string, error-code>` for a path, the string through the
  // import's allocator.
  function answerReadlink(path, out) {
    const memory = importMemory(READLINK);
    if (path === "link") {
      const target = encoder.encode("file.txt");
      const at = importRealloc(READLINK)(0, 0, 1, target.length);
      bytes(memory).set(target, at);
      view(memory).setUint8(out, 0);
      view(memory).setUint32(out + 4, at, true);
      view(memory).setUint32(out + 8, target.length, true);
    } else {
      view(memory).setUint8(out, 1);
      view(memory).setUint8(out + 4, INVALID);
    }
  }

  // The listing: its records in the host's memory, unsorted.
  function directoryEntries() {
    const entries = [["sub", DIRECTORY], ["link", SYMBOLIC_LINK], [
      "file.txt",
      REGULAR_FILE,
    ]];
    const at = allocate(4, entries.length * ENTRY_SIZE);
    entries.forEach(([name, type], index) => {
      const [pointer, length] = hostString(name);
      const record = at + index * ENTRY_SIZE;
      bytes("wlink:host").fill(0, record, record + ENTRY_SIZE);
      view("wlink:host").setUint8(record, type);
      view("wlink:host").setUint32(record + 16, pointer, true);
      view("wlink:host").setUint32(record + 20, length, true);
    });
    return { at, count: entries.length };
  }

  // `result<_, error-code>`'s `ok`, twenty bytes.
  const ok = () => {
    const at = allocate(4, 20);
    bytes("wlink:host").fill(0, at, at + 20);
    return at;
  };

  const imports = {
    "wasi:filesystem/preopens@0.3.0": {
      "get-directories": (ret) => {
        const memory = importMemory(PREOPENS);
        const realloc = importRealloc(PREOPENS);
        const name = encoder.encode("/");
        const string = realloc(0, 0, 1, name.length);
        bytes(memory).set(name, string);
        const list = realloc(0, 0, 4, 12);
        view(memory).setUint32(list, DESCRIPTOR, true);
        view(memory).setUint32(list + 4, string, true);
        view(memory).setUint32(list + 8, name.length, true);
        view(memory).setUint32(ret, list, true);
        view(memory).setUint32(ret + 4, 1, true);
      },
    },
    "wasi:filesystem/types@0.3.0": {
      "[method]descriptor.readlink-at": (
        subtask,
        self,
        pointer,
        length,
        out,
      ) => {
        equal(self, DESCRIPTOR, "readlink-at is a method of the preopen");
        const path = decoder.decode(
          bytes(importMemory(READLINK)).slice(pointer, pointer + length),
        );
        if (deferReadlink) {
          readlink = { subtask, path, out };
          return STARTED;
        }
        answerReadlink(path, out);
        return RETURNED;
      },
      "[method]descriptor.read-directory": (self, ret) => {
        equal(self, DESCRIPTOR, "read-directory is a method of the preopen");
        const [reader, writer] = ends(exports["wlink:async:stream-new"]());
        const [outcome, settled] = ends(exports["wlink:async:future-new"]());
        listing = {
          writer,
          settled,
          ...directoryEntries(),
          sent: 0,
          busy: false,
          over: false,
        };
        view(importMemory(READ_DIRECTORY)).setUint32(ret, reader, true);
        view(importMemory(READ_DIRECTORY)).setUint32(ret + 4, outcome, true);
      },
    },
    "wasi:cli/stdout@0.3.0": {
      "write-via-stream": (reader) => {
        const [outcome, settled] = ends(exports["wlink:async:future-new"]());
        output = {
          reader,
          settled,
          buffer: allocate(1, 16),
          text: [],
          busy: false,
          over: false,
        };
        return outcome;
      },
    },
    "wlink:async": {
      // A wait the module cannot get past without the host: the host's
      // next step.
      wait: () => (step() ? 1 : 0),
      cancel: () => assert.fail("the module cancels nothing"),
      event: (end, code, payload) => {
        assert.ok(!events.has(end), "one event per copy");
        events.set(end, { code, payload });
      },
      realloc: (old, oldSize, align, size) => {
        equal([old, oldSize], [0, 0], "the host's allocator makes new blocks");
        return allocate(align, size);
      },
      "task-cancelled": () => assert.fail("probe is not cancelled"),
    },
    "wlink:task-return": {
      probe: (_task, pointer, length) => {
        returned = decoder.decode(
          bytes("wlink:export:probe:memory").slice(pointer, pointer + length),
        );
      },
    },
  };
  // The imports above reach the exports only once the module runs.
  const exports = instantiate(filesPath, imports);

  // The event of a copy that waited, once the scheduler has delivered it.
  function took(end, code) {
    const event = events.get(end);
    if (!event) return null;
    events.delete(end);
    equal(event.code, code, "an event of the copy's kind");
    return event.payload;
  }

  // Finishes the outcome future with `ok` and drops it.
  function settleOutcome(state) {
    if (state.outcomeBusy) {
      const payload = took(state.settled, FUTURE_WRITE);
      if (payload === null) return false;
      equal(payload, COMPLETED, "the module takes the outcome");
      exports["wlink:async:drop"](state.settled);
      state.done = true;
      return true;
    }
    const result = exports["wlink:async:write"](state.settled, ok(), 1) >>> 0;
    if (result === BLOCKED) {
      state.outcomeBusy = true;
    } else {
      equal(result, COMPLETED, "the module took the outcome at once");
      exports["wlink:async:drop"](state.settled);
      state.done = true;
    }
    return true;
  }

  // One step of the host's own work: whether anything moved.
  function step() {
    let moved = false;
    if (readlink) {
      answerReadlink(readlink.path, readlink.out);
      exports["wlink:async:resolve"](readlink.subtask, RETURNED);
      readlink = null;
      moved = true;
    }
    if (listing && !listing.done) {
      if (listing.busy) {
        const payload = took(listing.writer, STREAM_WRITE);
        if (payload !== null) {
          listing.busy = false;
          equal(payload & 15, COMPLETED, "the module reads the listing");
          listing.sent += payload >>> 4;
          moved = true;
        }
      } else if (!listing.over && listing.sent < listing.count) {
        const result = exports["wlink:async:write"](
          listing.writer,
          listing.at + listing.sent * ENTRY_SIZE,
          listing.count - listing.sent,
        ) >>> 0;
        if (result === BLOCKED) {
          listing.busy = true;
        } else {
          listing.sent += result >>> 4;
        }
        moved = true;
      } else if (!listing.over) {
        exports["wlink:async:drop"](listing.writer);
        listing.over = true;
        moved = true;
      } else {
        moved = settleOutcome(listing) || moved;
      }
    }
    if (output && !output.done) {
      if (!output.over) {
        let result;
        if (output.busy) {
          result = took(output.reader, STREAM_READ);
          if (result !== null) output.busy = false;
        } else {
          result =
            exports["wlink:async:read"](output.reader, output.buffer, 16) >>> 0;
          if (result === BLOCKED) {
            output.busy = true;
            result = null;
          }
          moved = true;
        }
        if (result !== null) {
          const count = result >>> 4;
          output.text.push(
            ...bytes("wlink:host").slice(output.buffer, output.buffer + count),
          );
          if ((result & 15) === DROPPED) {
            exports["wlink:async:drop"](output.reader);
            output.over = true;
          }
          moved = true;
        }
      } else {
        moved = settleOutcome(output) || moved;
      }
    }
    return moved;
  }

  const encoded = encoder.encode(link);
  const argument = exports["wlink:export:probe:realloc"](
    0,
    0,
    1,
    encoded.length,
  );
  bytes("wlink:export:probe:memory").set(encoded, argument);
  const status = exports.probe(argument, encoded.length);
  equal(status & 15, STARTED, "probe waits on the host");
  for (
    let rounds = 0;
    returned === null || !listing?.done || !output?.done;
    rounds++
  ) {
    assert.ok(rounds < 1000, "the probe finishes");
    settle(exports);
    step();
  }
  equal(exports["wlink:async:trap"].value, 0, "no runtime trap");
  return [decoder.decode(new Uint8Array(output.text)), returned];
}

equal(
  probe("link", false),
  [
    "file.txt|file.txt,link@,sub|True\n",
    "file.txt|file.txt,link@,sub|True|33|True",
  ],
  "a link read at once, a directory listed and standard output written through streams",
);
equal(
  probe("link", true),
  [
    "file.txt|file.txt,link@,sub|True\n",
    "file.txt|file.txt,link@,sub|True|33|True",
  ],
  "the same, with the link's string resolved later",
);
equal(
  probe("sub", true),
  ["?|file.txt,link@,sub|True\n", "?|file.txt,link@,sub|True|26|True"],
  "an error for reading a directory as a link",
);

// MARK: ledger: an exported resource between two modules

function ledger() {
  const results = [];
  const imports = {
    "wlink:async": {
      "task-cancelled": () => assert.fail("run is not cancelled"),
    },
    "wlink:task-return": {
      run: (_task, pointer, length) =>
        results.push(
          decoder.decode(
            new Uint8Array(
              exports["wlink:export:run:memory"].buffer,
              pointer,
              length,
            ),
          ),
        ),
    },
  };
  const exports = instantiate(ledgerPath, imports);
  // Nothing waits on the host: wlink's scheduler runs `audit`'s yield and
  // the rest of run within the call.
  const status = exports.run();
  equal(status & 15, RETURNED, "run returns from its call");
  equal(exports["wlink:async:trap"].value, 0, "no runtime trap");
  return results;
}

equal(
  ledger(),
  ["12|12|ann:12|bob|bob,ann"],
  "accounts made, lent, given back, audited and dropped across modules",
);

console.log(`wit-linked: ${checks} checks passed`);
