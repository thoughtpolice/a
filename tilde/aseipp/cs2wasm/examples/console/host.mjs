// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A host for the scalar part of console:sdk's `game` world, keyed by the
// canonical ABI names a gameplayc module imports. The overlay a frame draws
// is kept as a display list and rasterized on request, so a browser page and
// a headless runner see the same pixels. Standard JavaScript only.
export const BUTTONS = Object.freeze({
  up: 1,
  down: 2,
  left: 4,
  right: 8,
  a: 16,
  b: 32,
  start: 64,
  select: 128,
});

const SDK = "console:sdk";
const VERSION = "@0.1.0";
const iface = (name) => `${SDK}/${name}${VERSION}`;

export function createConsoleHost(module, options = {}) {
  const buttons = options.buttons ?? (() => 0);
  const seed = options.seed ?? 0x5eedn;
  const state = {
    width: 256,
    height: 256,
    frameRate: 60,
    frame: 0n,
    nowMs: 0n,
    commands: [],
    camera: [0, 0],
    clip: null,
  };
  const color = (r, g, b, a) => ({ r, g, b, a });
  const rect = (x, y, w, h) => ({ x, y, w, h });

  // Every function the bindings can generate for the world, by module.
  const implementations = {
    [iface("gfx")]: {
      "set-mode": (width, height) => {
        if (width < 1 || width > 4096 || height < 1 || height > 4096) return 0;
        state.width = width >>> 0;
        state.height = height >>> 0;
        return 1;
      },
      clear: (r, g, b, a) =>
        state.commands.push({ op: "clear", color: color(r, g, b, a) }),
      "fill-rect": (x, y, w, h, r, g, b, a) =>
        state.commands.push({
          op: "fill-rect",
          rect: rect(x, y, w >>> 0, h >>> 0),
          color: color(r, g, b, a),
        }),
      "draw-rect": (x, y, w, h, r, g, b, a) =>
        state.commands.push({
          op: "draw-rect",
          rect: rect(x, y, w >>> 0, h >>> 0),
          color: color(r, g, b, a),
        }),
      "draw-line": (x0, y0, x1, y1, r, g, b, a) =>
        state.commands.push({
          op: "draw-line",
          x0,
          y0,
          x1,
          y1,
          color: color(r, g, b, a),
        }),
      "fill-circle": (cx, cy, radius, r, g, b, a) =>
        state.commands.push({
          op: "fill-circle",
          cx,
          cy,
          radius: radius >>> 0,
          color: color(r, g, b, a),
        }),
      "set-clip": (some, x, y, w, h) =>
        state.commands.push({
          op: "set-clip",
          clip: some ? rect(x, y, w >>> 0, h >>> 0) : null,
        }),
      "set-camera": (dx, dy) =>
        state.commands.push({ op: "set-camera", dx, dy }),
      "draw-sprite": () => {
        throw new Error(
          "sheets need list<u8>, which a gameplayc module cannot construct yet",
        );
      },
    },
    [iface("input")]: {
      poll: () => buttons() >>> 0,
      capabilities: () => 0,
      "capture-pointer": () => 0,
    },
    [iface("audio")]: {
      queued: () => 0,
    },
    [iface("clock")]: {
      "now-ms": () => state.nowMs,
      frame: () => state.frame,
      "unix-seconds": () => 1_700_000_000n,
      "set-frame-rate": (hz) => {
        if (hz >= 1 && hz <= 1000) state.frameRate = hz >>> 0;
        return state.frameRate;
      },
    },
    [iface("system")]: {
      "random-seed": () => seed,
    },
    [iface("process")]: {
      "arg-count": () => 0,
      exit: (code) => {
        throw new Error(`the game asked to exit with code ${code}`);
      },
    },
  };

  // Only the imports the module declares are supplied, and each must be one
  // the host knows: an unknown capability is an error, not a silent stub.
  const imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    const implementation = implementations[entry.module]?.[entry.name];
    if (entry.kind !== "function" || !implementation) {
      throw new Error(`Unsupported import ${entry.module}.${entry.name}`);
    }
    (imports[entry.module] ??= {})[entry.name] = implementation;
  }
  const instance = new WebAssembly.Instance(module, imports);
  const { init, frame, __fault: fault } = instance.exports;
  if (typeof init !== "function" || typeof frame !== "function") {
    throw new Error("The module does not export init and frame");
  }

  let running = false;
  let lastFrame = null;
  function enter(action) {
    if (running) throw new Error("Reentrant entry is not allowed");
    running = true;
    try {
      return action();
    } finally {
      running = false;
    }
  }

  return {
    init: () => enter(() => init()),
    // Runs one frame; returns whether the game wants to continue.
    step(dtMs) {
      return enter(() => {
        state.commands = [];
        const alive = frame(dtMs >>> 0) !== 0;
        state.frame += 1n;
        state.nowMs += BigInt(dtMs >>> 0);
        return alive;
      });
    },
    get commands() {
      return state.commands;
    },
    get width() {
      return state.width;
    },
    get height() {
      return state.height;
    },
    get frameRate() {
      return state.frameRate;
    },
    lastFault: () => fault.value,
    // The next render at the same size draws into this frame's pixels; copy
    // them to keep a frame.
    render: () => (lastFrame = rasterize(
      state.width,
      state.height,
      state.commands,
      lastFrame,
    )),
  };
}

// The overlay as RGBA8: primitives in frame pixels, shifted by the camera and
// cut to the clip rectangle; zero alpha draws nothing. Pass a previous frame
// of the same size as `target` to draw into its buffer instead of a new one.
export function rasterize(width, height, commands, target = null) {
  const reuse = target !== null && target.width === width &&
    target.height === height;
  const frame = reuse
    ? target
    : { width, height, rgba: new Uint8ClampedArray(width * height * 4) };
  const { rgba } = frame;
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  if (reuse) pixels.fill(0);
  // Colours are packed through a word view, so the byte order matches `pixels`,
  // and clamped as stores into `rgba` would be.
  const packBytes = new Uint8ClampedArray(4);
  const packWord = new Uint32Array(packBytes.buffer);
  const pack = ({ r, g, b, a }) => {
    packBytes[0] = r;
    packBytes[1] = g;
    packBytes[2] = b;
    packBytes[3] = a;
    return packWord[0];
  };
  let cameraX = 0;
  let cameraY = 0;
  // The drawable window: the clip rectangle cut to the frame.
  let left = 0;
  let top = 0;
  let right = width;
  let bottom = height;
  function plot(x, y, color) {
    if (x >= left && y >= top && x < right && y < bottom) {
      pixels[y * width + x] = color;
    }
  }
  function fill(x, y, w, h, color) {
    const x0 = Math.max(x, left);
    const x1 = Math.min(x + w, right);
    const y0 = Math.max(y, top);
    const y1 = Math.min(y + h, bottom);
    if (x0 >= x1) return;
    for (let row = y0; row < y1; row++) {
      pixels.fill(color, row * width + x0, row * width + x1);
    }
  }
  for (const command of commands) {
    if (command.op === "set-camera") {
      cameraX = command.dx;
      cameraY = command.dy;
      continue;
    }
    if (command.op === "set-clip") {
      const clip = command.clip ?? { x: 0, y: 0, w: width, h: height };
      left = Math.max(clip.x, 0);
      top = Math.max(clip.y, 0);
      right = Math.min(clip.x + clip.w, width);
      bottom = Math.min(clip.y + clip.h, height);
      continue;
    }
    if (command.color.a === 0) continue;
    const color = pack(command.color);
    const dx = -cameraX;
    const dy = -cameraY;
    switch (command.op) {
      case "clear":
        fill(0, 0, width, height, color);
        break;
      case "fill-rect": {
        const { x, y, w, h } = command.rect;
        fill(x + dx, y + dy, w, h, color);
        break;
      }
      case "draw-rect": {
        const { x, y, w, h } = command.rect;
        if (w === 0 || h === 0) break;
        fill(x + dx, y + dy, w, 1, color);
        fill(x + dx, y + dy + h - 1, w, 1, color);
        fill(x + dx, y + dy, 1, h, color);
        fill(x + dx + w - 1, y + dy, 1, h, color);
        break;
      }
      case "draw-line": {
        let x0 = command.x0 + dx;
        let y0 = command.y0 + dy;
        const x1 = command.x1 + dx;
        const y1 = command.y1 + dy;
        const stepX = Math.abs(x1 - x0);
        const stepY = -Math.abs(y1 - y0);
        const signX = x0 < x1 ? 1 : -1;
        const signY = y0 < y1 ? 1 : -1;
        let error = stepX + stepY;
        for (;;) {
          plot(x0, y0, color);
          if (x0 === x1 && y0 === y1) break;
          const doubled = 2 * error;
          if (doubled >= stepY) {
            error += stepY;
            x0 += signX;
          }
          if (doubled <= stepX) {
            error += stepX;
            y0 += signY;
          }
        }
        break;
      }
      case "fill-circle": {
        const { cx, cy, radius } = command;
        for (let y = -radius; y <= radius; y++) {
          const span = Math.floor(Math.sqrt(radius * radius - y * y));
          fill(cx - span + dx, cy + y + dy, 2 * span + 1, 1, color);
        }
        break;
      }
      default:
        throw new Error(`Unknown draw command ${command.op}`);
    }
  }
  return frame;
}

// FNV-1a over the pixels, for frame-level regression checks.
export function frameHash({ rgba }) {
  let hash = 0x811c9dc5;
  for (const byte of rgba) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
