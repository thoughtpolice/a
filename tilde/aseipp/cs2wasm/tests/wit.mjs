// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for world `test` of tests/wit/features.wit, keyed by the canonical
// ABI names the generated bindings use, plus a check that the componentized
// module is a component. Functions with strings, lists and the like pass
// them through the module's memory, as the canonical ABI lowers them (UTF-8
// strings, allocated with the module's cabi_realloc); this host does that
// lowering itself. Arguments: the core module, then the component, then
// the component of tests/wit/echo.wit, which a real component runtime
// (Wasmtime, when it is installed) calls too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [corePath, componentPath, echoPath] = process.argv.slice(2);
if (!corePath || !componentPath || !echoPath) {
  throw new Error(
    "Usage: wit.mjs <core.wasm> <component.wasm> <echo.component.wasm>",
  );
}

const module = new WebAssembly.Module(fs.readFileSync(corePath));
let checks = 0;
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks++;
}
function equalList(actual, expected, message) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const shapesModule = "test:features/shapes@1.0.0";
const handlesModule = "test:features/handles@1.0.0";
const callbacksModule = "test:features/callbacks@1.0.0";
const giftsModule = "test:features/gifts@1.0.0";
const utilModule = "test:features/util@1.0.0";
const textModule = "test:features/text@1.0.0";
const textCallbacksModule = "test:features/text-callbacks@1.0.0";
const otherUtilModule = "test:other/util";
equalList(
  WebAssembly.Module.imports(module)
    .map(({ module, name }) => `${module} ${name}`)
    .sort(),
  [
    `${shapesModule} blit`,
    `${shapesModule} fill`,
    `${shapesModule} kind-of`,
    `${shapesModule} label`,
    `${shapesModule} measure`,
    `${shapesModule} mode-of`,
    `${shapesModule} set-clip`,
    `${shapesModule} set-clips`,
    `${shapesModule} show`,
    `${shapesModule} style-of`,
    `${shapesModule} wide`,
    `${handlesModule} [constructor]canvas`,
    `${handlesModule} [constructor]counter`,
    `${handlesModule} [constructor]layer`,
    `${handlesModule} [method]canvas.area`,
    `${handlesModule} [method]canvas.clear`,
    `${handlesModule} [method]canvas.take-clip`,
    `${handlesModule} [method]counter.get`,
    `${handlesModule} [resource-drop]canvas`,
    `${handlesModule} [resource-drop]counter`,
    `${handlesModule} [resource-drop]layer`,
    `${handlesModule} [static]canvas.merge`,
    `${handlesModule} dispose-all`,
    `${handlesModule} open`,
    `${giftsModule} give`,
    `${giftsModule} swap`,
    `${utilModule} ping`,
    `${textModule} area`,
    `${textModule} checksum`,
    `${textModule} entries`,
    `${textModule} find`,
    `${textModule} greet`,
    `${textModule} many`,
    `${textModule} maybe-name`,
    `${textModule} mix`,
    `${textModule} pairs`,
    `${textModule} parse`,
    `${textModule} reverse`,
    `${textModule} signal-of`,
    `${textModule} split`,
    `${textModule} transpose`,
    `${textModule} validate`,
    `${otherUtilModule} ping`,
    "$root log",
  ].sort(),
  "canonical import names",
);
equalList(
  WebAssembly.Module.exports(module)
    .map(({ name }) => name)
    .filter((name) => name !== "__fault")
    .sort(),
  [
    `${callbacksModule}#on-canvas`,
    `${callbacksModule}#on-hit`,
    `${callbacksModule}#on-tick`,
    `${callbacksModule}#on-window`,
    `${textCallbacksModule}#on-entry`,
    `${textCallbacksModule}#on-many`,
    `${textCallbacksModule}#on-mixed`,
    `${textCallbacksModule}#on-shape`,
    `${textCallbacksModule}#on-text`,
    `${textCallbacksModule}#on-values`,
    "cabi_realloc",
    "describe",
    "finish",
    "memory",
    "run",
  ].sort(),
  "canonical export names, the memory and its allocator, and nothing else",
);

const fills = [];
const clips = [];
const logs = [];
const canvases = new Map();
const drops = [];
const calls = [];
const setClips = [];
const shows = [];
const counters = new Map();
const counterDrops = [];
const layers = [];
const layerDrops = [];
const gifts = [];
let nextHandle = 11;
const labels = [];

// The canonical ABI's lowering and lifting, through the module's memory.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const view = () => new DataView(instance.exports.memory.buffer);
const bytes = (pointer, length) =>
  new Uint8Array(instance.exports.memory.buffer, pointer, length);
const allocate = (size, align) =>
  instance.exports.cabi_realloc(0, 0, align, size);
const liftString = (pointer, length) =>
  decoder.decode(bytes(pointer, length).slice());
function lowerString(text) {
  const encoded = encoder.encode(text);
  const pointer = allocate(encoded.length, 1);
  bytes(pointer, encoded.length).set(encoded);
  return [pointer, encoded.length];
}
function storeString(address, text) {
  const [pointer, length] = lowerString(text);
  view().setInt32(address, pointer, true);
  view().setInt32(address + 4, length, true);
}
function loadString(address) {
  return liftString(
    view().getInt32(address, true),
    view().getInt32(address + 4, true),
  );
}
function storeList(address, items, size, align, store) {
  const pointer = allocate(items.length * size, align);
  items.forEach((item, index) => store(pointer + index * size, item));
  view().setInt32(address, pointer, true);
  view().setInt32(address + 4, items.length, true);
}
function loadList(pointer, length, size, load) {
  return Array.from({ length }, (_, index) => load(pointer + index * size));
}
// Float bits, as a variant's joined flat payload carries them.
const bitsView = new DataView(new ArrayBuffer(8));
function floatFromBits(bits) {
  bitsView.setUint32(0, Number(BigInt.asUintN(32, BigInt(bits))), true);
  return bitsView.getFloat32(0, true);
}
function floatBits(value) {
  bitsView.setFloat32(0, value, true);
  return bitsView.getUint32(0, true);
}

const instance = new WebAssembly.Instance(module, {
  [shapesModule]: {
    fill: (x, y, w, h, r, g, b, a) => {
      fills.push([x, y, w, h, r, g, b, a]);
      return w + h;
    },
    blit: (x, y, w, h, r, g, b, a, visible, scale) =>
      x + y + w + h + r + g + b + a + visible + scale,
    "set-clip": (some, x, y, w, h) => clips.push([some, x, y, w, h]),
    "kind-of": (sides) => (sides === 4 ? 1 : 0),
    "style-of": (kind) => (kind === 1 ? 5 : 0),
    wide: (a, b, c, d, e) => a + b + BigInt(c) + BigInt(d) + BigInt(e),
    "set-clips": (...args) => {
      setClips.push(args);
      return args[0] * 10 + args[5];
    },
    show: (...args) => {
      shows.push(args);
      return 0;
    },
    "mode-of": (mode) => mode,
    label: (x, y, w, h, pointer, length) =>
      labels.push([x, y, w, h, liftString(pointer, length)]),
    measure: (sides, result) => {
      [sides, -sides, sides * 2, sides * 3].forEach((value, index) =>
        view().setInt32(result + index * 4, value, true)
      );
    },
  },
  [textModule]: {
    greet: (pointer, length, result) =>
      storeString(result, "hello, " + liftString(pointer, length)),
    reverse: (pointer, length, result) => {
      const values = loadList(
        pointer,
        length,
        4,
        (at) => view().getInt32(at, true),
      ).reverse();
      storeList(
        result,
        values,
        4,
        4,
        (at, value) => view().setInt32(at, value, true),
      );
    },
    entries: (pointer, length, count, result) => {
      const prefix = liftString(pointer, length);
      const entries = Array.from({ length: count }, (_, index) => ({
        name: `${prefix}${index}`,
        size: index * 10,
        tags: Array.from({ length: index + 1 }, (_, tag) => `t${tag}`),
      }));
      storeList(result, entries, 20, 4, (at, entry) => {
        storeString(at, entry.name);
        view().setUint32(at + 8, entry.size, true);
        storeList(at + 12, entry.tags, 8, 4, storeString);
      });
    },
    split: (pointer, length, at, result) => {
      const text = liftString(pointer, length);
      storeString(result, text.slice(0, at));
      storeString(result + 8, text.slice(at + 1));
    },
    find: (pointer, length, wanted, result) => {
      const index = loadList(
        pointer,
        length,
        2,
        (at) => view().getUint16(at, true),
      ).indexOf(wanted);
      view().setUint8(result, index < 0 ? 0 : 1);
      if (index >= 0) view().setUint32(result + 4, index, true);
    },
    "maybe-name": (id, result) => {
      view().setUint8(result, id === 0 ? 0 : 1);
      if (id !== 0) storeString(result + 4, `name${id}`);
    },
    many: (pointer) => {
      let sum = 0n;
      for (let index = 0; index < 17; index++) {
        sum += BigInt(view().getUint32(pointer + index * 4, true));
      }
      return sum;
    },
    checksum: (pointer, length) =>
      bytes(pointer, length).reduce((sum, value) => (sum + value) >>> 0, 0),
    transpose: (pointer, length, result) => {
      const rows = loadList(
        pointer,
        length,
        8,
        (at) =>
          Array.from(
            bytes(view().getInt32(at, true), view().getInt32(at + 4, true)),
          ),
      );
      const columns = rows[0].map((_, column) =>
        rows.map((row) => row[column])
      );
      storeList(
        result,
        columns,
        8,
        4,
        (at, column) =>
          storeList(
            at,
            column,
            1,
            1,
            (byte, value) => view().setUint8(byte, value),
          ),
      );
    },
    pairs: (pointer, length) => {
      const items = loadList(pointer, length, 24, (at) => ({
        text: loadString(at),
        value: view().getUint8(at + 8)
          ? view().getBigInt64(at + 16, true)
          : null,
      }));
      const lengths = items.reduce((sum, item) => sum + item.text.length, 0);
      const present = items.filter((item) => item.value !== null);
      return lengths * 1000 + present.length * 10 +
        (present.some((item) => item.value < 0n) ? 1 : 0);
    },
    // shape: circle(f32), rect(tuple<u32, u32>), label(string), empty;
    // flat, the payload joins to (i32, i32).
    area: (tag, first, second) =>
      [
        () => floatFromBits(first) ** 2,
        () => first * second,
        () => liftString(first, second).length,
        () => 0.5,
      ][tag](),
    parse: (pointer, length, result) => {
      const text = liftString(pointer, length);
      const ok = /^[0-9]+$/.test(text);
      view().setUint8(result, ok ? 0 : 1);
      if (ok) view().setUint32(result + 4, Number(text), true);
      else storeString(result + 4, `bad ${text}`);
    },
    // mixed: small(f32), big(u64), text(string), nothing; flat, the payload
    // joins to (i64, i32); in memory, a tag and the payload at 8.
    mix: (tag, wide, narrow, result) => {
      view().setUint8(result, tag);
      if (tag === 0) {
        view().setFloat32(result + 8, floatFromBits(wide) * 2, true);
      }
      if (tag === 1) {
        view().setBigUint64(result + 8, BigInt.asUintN(64, wide) + 1n, true);
      }
      if (tag === 2) {
        storeString(
          result + 8,
          liftString(Number(BigInt.asUintN(32, wide)), narrow) + "!",
        );
      }
    },
    "signal-of": (value) => (value === 1 ? 1 : 0),
    // list<result<shape, u8>>: 16-byte elements, the payload at 4.
    validate: (pointer, length, result) => {
      const errors = [];
      loadList(pointer, length, 16, (at) => {
        if (view().getUint8(at) === 1) {
          errors.push(`e${view().getUint8(at + 4)}`);
        } else if (
          view().getUint8(at + 4) === 2 && view().getInt32(at + 12, true) === 0
        ) errors.push("empty label");
      });
      view().setUint8(result, errors.length === 0 ? 0 : 1);
      if (errors.length !== 0) storeList(result + 4, errors, 8, 4, storeString);
    },
  },
  [handlesModule]: {
    "[constructor]canvas": (width, height) => {
      const handle = nextHandle++;
      canvases.set(handle, { width, height });
      return handle;
    },
    "[method]canvas.clear": (self, value) => calls.push(["clear", self, value]),
    "[method]canvas.area": (self) => {
      const canvas = canvases.get(self);
      return BigInt(canvas.width * canvas.height);
    },
    "[static]canvas.merge": (first, second) => {
      calls.push(["merge", first, second]);
      canvases.set(33, canvases.get(first));
      return 33;
    },
    "[method]canvas.take-clip": (self, some, x, y, w, h) => {
      calls.push(["take-clip", self, some, x, y, w, h]);
      return some;
    },
    open: (id) => {
      calls.push(["open", id]);
      canvases.set(22, { width: 1, height: 1 });
      return 22;
    },
    "dispose-all": () => calls.push(["dispose-all"]),
    "[resource-drop]canvas": (handle) => drops.push(handle),
    "[constructor]counter": (start) => {
      const handle = nextHandle++;
      counters.set(handle, start);
      return handle;
    },
    "[method]counter.get": (self) => counters.get(self),
    "[resource-drop]counter": (handle) => counterDrops.push(handle),
    "[constructor]layer": (...args) => {
      layers.push(args);
      return nextHandle++;
    },
    "[resource-drop]layer": (handle) => layerDrops.push(handle),
  },
  [giftsModule]: {
    give: (n) => {
      const handle = nextHandle++;
      gifts.push(["give", n, handle]);
      return handle;
    },
    swap: (old) => {
      const handle = nextHandle++;
      gifts.push(["swap", old, handle]);
      return handle;
    },
  },
  [utilModule]: {
    ping: (x) => x + 100,
  },
  [otherUtilModule]: {
    ping: (x) => x + 200,
  },
  $root: {
    log: (level, code) => logs.push([level, code]),
  },
});
const { exports } = instance;

equal(exports.run(3), 1015, "run: fills plus the clip result");
equalList(
  fills,
  [
    [0, 0, 0, 0, 1, 2, 3, 4],
    [1, -1, 2, 3, 1, 2, 3, 4],
    [2, -2, 4, 6, 1, 2, 3, 4],
  ],
  "records flatten field by field",
);
equalList(
  clips,
  [
    [0, 0, 0, 0, 0],
    [1, 1, 2, 3, 4],
  ],
  "option<record>: discriminant then fields, zeros when absent",
);
const runLogs = [
  [2, 1],
  [3, 0],
  [9, 11],
  [9, 10],
  [9, 1],
  [5, 3],
  [6, 41],
  [7, 0],
  [8, 0],
  [10, 303],
];
equalList(
  logs,
  runLogs,
  "enum and flags results; spent objects keep no handle; independent options; a flag called none",
);
equalList(
  setClips,
  [
    [1, 1, 2, 3, 4, 1, 5, 6, 7, 8],
    [1, 9, 9, 9, 9, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, -7, 7, 7, 7],
  ],
  "two options: each present or absent on its own",
);
equalList(
  shows,
  [
    [1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [2, 2, 2, 2, 0, 0, 0, 1, 2, 0],
  ],
  "an option<record> field and an option<record> parameter",
);
equalList(counterDrops, [12], "a constructor taking one s32");
equalList(
  layers,
  [
    [13, 0, 0, 0, 0, 0],
    [15, 1, 1, 2, 3, 4],
  ],
  "a constructor with an owned argument and an option",
);
equalList(layerDrops, [14, 16], "layers drop; their spent bases do not");
equalList(
  gifts,
  [
    ["give", 5, 17],
    ["swap", 17, 18],
  ],
  "handles of a resource another interface defines",
);
equalList(
  calls,
  [
    ["clear", 11, 7],
    ["open", 9],
    ["merge", 11, 22],
    ["take-clip", 33, 1, 0, 0, 1, 1],
    ["take-clip", 33, 0, 0, 0, 0, 0],
    ["dispose-all"],
  ],
  "resource constructor, methods, statics and free functions",
);
equalList(
  drops,
  [33, 11, 18],
  "Dispose drops once; an owned argument is not dropped twice",
);
equal(exports.finish(), 38n + 194046n + 2048n, "i64 results and arguments");

equal(
  exports[`${callbacksModule}#on-hit`](3, 4, 5, 6, 1, 9, 9, 9, 255),
  1,
  "exported interface function with flattened records",
);
equalList(logs, [...runLogs, [1, 3001]], "the export rebuilt its records");
equal(
  exports[`${callbacksModule}#on-tick`](1234567n),
  567,
  "i64 export argument",
);
equal(
  exports[`${callbacksModule}#on-window`](5, 6, 7, 8, 1, 2, 1, 1, 3, 0, 0, 0),
  5 + 112 + 3000,
  "export rebuilds an option<record> field and parameter when present",
);
equal(
  exports[`${callbacksModule}#on-window`](1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  1,
  "export rebuilds absent options as null",
);
equal(
  exports[`${callbacksModule}#on-canvas`](5, 6),
  6,
  "export takes and returns handles",
);
equal(
  exports[`${callbacksModule}#on-canvas`](7, 8),
  8,
  "export takes and returns handles again",
);
equalList(
  calls.slice(-2),
  [
    ["clear", 5, 2],
    ["clear", 7, 2],
  ],
  "a borrowed export argument calls through its handle",
);
equalList(
  logs.slice(-1),
  [[4, 0]],
  "an owned export result leaves the module object spent",
);

// Through memory. The export's result stays in memory until the next
// outermost call, so it is read after the call returns, as a component host
// lifts it.
const describe = exports.describe();
equal(
  loadString(describe),
  "hello, wörld 🌍|7|310|3:item2:20:3:t1|left+right|20|name1-|153|3|3x2:6|3011|6,12|1875|ok42errbad x|s50b256ttx!n|1|2:e9",
  "strings, lists, records, tuples, options and wide signatures through memory",
);
equalList(
  labels,
  [[1, 2, 3, 4, "label ✓"]],
  "a record and a string, flat and through memory",
);
equal(
  instance.exports.memory.buffer.byteLength > 65536,
  true,
  "the memory grew for a list bigger than a page",
);
equal(
  loadString(exports.describe()),
  loadString(describe),
  "the arena is reused by the next call",
);

const [textPointer, textLength] = lowerString("héllo 🌍");
equal(
  loadString(
    exports[`${textCallbacksModule}#on-text`](textPointer, textLength),
  ),
  "<héllo 🌍>8",
  "a string export: UTF-8 in, UTF-16 inside, UTF-8 out",
);
const [emptyPointer, emptyLength] = lowerString("");
equal(
  loadString(
    exports[`${textCallbacksModule}#on-text`](emptyPointer, emptyLength),
  ),
  "<>0",
  "an empty string",
);

const values = [1.5, -2.25, 1000];
const valuesPointer = allocate(values.length * 8, 8);
values.forEach((value, index) =>
  view().setFloat64(valuesPointer + index * 8, value, true)
);
const strings = exports[`${textCallbacksModule}#on-values`](
  valuesPointer,
  values.length,
);
equalList(
  loadList(
    view().getInt32(strings, true),
    view().getInt32(strings + 4, true),
    8,
    loadString,
  ),
  ["1", "-2", "1000"],
  "a list export returning a list of strings",
);
const noValues = exports[`${textCallbacksModule}#on-values`](0, 0);
equal(view().getInt32(noValues + 4, true), 0, "an empty list");

function entryExport(extra) {
  const [namePointer, nameLength] = lowerString("e");
  const tags = allocate(16, 4);
  storeString(tags, "x");
  storeString(tags + 8, "y");
  const result = exports[`${textCallbacksModule}#on-entry`](
    namePointer,
    nameLength,
    5,
    tags,
    2,
    extra === null ? 0 : 1,
    extra ?? 0,
  );
  if (view().getUint8(result) === 0) return null;
  return {
    name: loadString(result + 4),
    size: view().getUint32(result + 12, true),
    tags: loadList(
      view().getInt32(result + 16, true),
      view().getInt32(result + 20, true),
      8,
      loadString,
    ),
  };
}
equalList(
  entryExport(3),
  { name: "e!", size: 8, tags: ["y", "x"] },
  "a record and an option in, an option out",
);
equal(entryExport(null), null, "none out");

// Seventeen flat parameters: the host passes them in memory.
const manyPointer = allocate(72, 4);
for (let index = 0; index < 16; index++) {
  view().setInt32(manyPointer + index * 4, index - 3, true);
}
storeString(manyPointer + 64, "ab");
const many = exports[`${textCallbacksModule}#on-many`](manyPointer);
equal(view().getBigInt64(many, true), 72n, "parameters from memory");
equal(loadString(many + 8), "abab", "a tuple result in memory");

// Variants and results out of exports: result<string, u32>, the payload at 4.
function shapeExport(tag, first, second) {
  const result = exports[`${textCallbacksModule}#on-shape`](tag, first, second);
  return view().getUint8(result) === 0
    ? `ok ${loadString(result + 4)}`
    : `err ${view().getUint32(result + 4, true)}`;
}
equal(
  shapeExport(0, floatBits(1.5), 0),
  "ok circle 6",
  "a variant with a float payload, joined into an i32",
);
equal(shapeExport(1, 3, 4), "ok rect 12", "a variant with a tuple payload");
const [labelPointer, labelLength] = lowerString("xyz");
equal(
  shapeExport(2, labelPointer, labelLength),
  "ok label xyz",
  "a variant with a string payload",
);
equal(
  shapeExport(3, 0, 0),
  "err 404",
  "a variant case without a payload, and an error",
);

// list<mixed>: 16-byte elements, the payload at 8.
const mixedValues = allocate(64, 8);
view().setUint8(mixedValues, 0);
view().setFloat32(mixedValues + 8, 1, true);
view().setUint8(mixedValues + 16, 1);
view().setBigUint64(mixedValues + 24, 500n, true);
view().setUint8(mixedValues + 32, 2);
storeString(mixedValues + 40, "a");
view().setUint8(mixedValues + 48, 3);
const mixedResults = exports[`${textCallbacksModule}#on-mixed`](mixedValues, 4);
equalList(
  loadList(
    view().getInt32(mixedResults, true),
    view().getInt32(mixedResults + 4, true),
    12,
    (at) => view().getUint8(at) === 0 ? "ok" : loadString(at + 4),
  ),
  ["ok", "too big", "no a", "ok"],
  "a list of variants in, a list of results out",
);

const component = fs.readFileSync(componentPath);
equalList(
  [...component.subarray(0, 8)],
  [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00],
  "the componentized module carries the component layer",
);
equal(component.length > module.constructor.length, true, "component bytes");
// A component runtime lowers and lifts on its own: Wasmtime, if installed.
const wasmtime = spawnSync("wasmtime", ["--version"], { encoding: "utf8" });
if (wasmtime.error || wasmtime.status !== 0) {
  console.log("SKIP: no wasmtime to run the echo component.");
} else {
  for (
    const [call, expected] of [
      ['shout("héllo 🌍")', '"héllo 🌍! (8)"'],
      ['shout("")', '"! (0)"'],
      [
        'entries(["ab", "ü", ""])',
        '[{name: "ab0", values: [97, 98]}, {name: "ü1", values: [252]}, {name: "2", values: []}]',
      ],
      ['pick([("x", 1), ("yz", 2)], 2)', 'some("yz")'],
      ["pick([], 2)", "none"],
      ["classify(small(1.5))", 'ok("small 3")'],
      ["classify(big(7))", 'ok("big 7")'],
      ['classify(text("é"))', 'ok("text é")'],
      ["classify(nothing)", "err(7)"],
    ]
  ) {
    const result = spawnSync("wasmtime", ["run", "--invoke", call, echoPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${call}\n${result.stderr}`);
    equal(result.stdout.trim(), expected, `wasmtime ${call}`);
  }
}
console.log(`PASS: ${checks} WIT binding checks.`);
