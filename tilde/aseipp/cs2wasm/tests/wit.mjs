// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for world `test` of tests/wit/features.wit, keyed by the canonical
// ABI names the generated bindings use, plus a check that the componentized
// module is a component. Arguments: the core module, then the component.
import assert from "node:assert/strict";
import fs from "node:fs";

const [corePath, componentPath] = process.argv.slice(2);
if (!corePath || !componentPath) {
  throw new Error("Usage: wit.mjs <core.wasm> <component.wasm>");
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
const otherUtilModule = "test:other/util";
equalList(
  WebAssembly.Module.imports(module)
    .map(({ module, name }) => `${module} ${name}`)
    .sort(),
  [
    `${shapesModule} blit`,
    `${shapesModule} fill`,
    `${shapesModule} kind-of`,
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
    "finish",
    "run",
  ].sort(),
  "canonical export names, and nothing else",
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
const { exports } = new WebAssembly.Instance(module, {
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

const component = fs.readFileSync(componentPath);
equalList(
  [...component.subarray(0, 8)],
  [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00],
  "the componentized module carries the component layer",
);
equal(component.length > module.constructor.length, true, "component bytes");
console.log(`PASS: ${checks} WIT binding checks.`);
