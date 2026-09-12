// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Plays the console Breakout in a terminal: each frame the game draws is
// rasterized and written as half-block cells in 24-bit colour, and the
// keyboard supplies the buttons. Usage:
//
//   terminal.mjs <breakout.wasm> [--fps N] [--frames N]
//
// With --frames the paddle is steered from the drawn frame, as run.mjs does,
// and the run stops after that many frames, which lets a build test the
// renderer without a terminal. Standard JavaScript and node: modules only, so
// Node and Deno both run it.
import fs from "node:fs";
import process from "node:process";
import { BUTTONS, createConsoleHost } from "./host.mjs";

const args = process.argv.slice(2);
const modulePath = args.find((argument) => !argument.startsWith("--"));
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length
    ? Number(args[index + 1])
    : fallback;
};
const fps = option("--fps", 60);
const scriptedFrames = option("--frames", null);
if (
  !modulePath || !(fps > 0) ||
  (scriptedFrames !== null && !(scriptedFrames > 0))
) {
  throw new Error("Usage: terminal.mjs <breakout.wasm> [--fps N] [--frames N]");
}

const module = new WebAssembly.Module(fs.readFileSync(modulePath));
let pressed = 0;
let host = createConsoleHost(module, { buttons: () => pressed });
host.init();

// MARK: Terminal

const out = process.stdout;
const interactive = Boolean(
  process.stdin.isTTY && out.isTTY && scriptedFrames === null,
);
const ESC = "\x1b";
function enter() {
  if (!interactive) return;
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  if (globalThis.Deno) globalThis.Deno.stdin.setRaw(true);
  else process.stdin.setRawMode(true);
  process.stdin.resume();
}
function leave() {
  if (!interactive) return;
  if (globalThis.Deno) globalThis.Deno.stdin.setRaw(false);
  else process.stdin.setRawMode(false);
  out.write(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
}

// A terminal cannot report a key going up, so a button stays held for a
// moment after each press and autorepeat keeps it down, as the console's
// native terminal host does.
const HOLD_MS = 180;
const releases = new Map();
function press(button) {
  pressed |= button;
  clearTimeout(releases.get(button));
  releases.set(button, setTimeout(() => (pressed &= ~button), HOLD_MS));
}
const keys = new Map([
  [`${ESC}[D`, BUTTONS.left],
  [`${ESC}[C`, BUTTONS.right],
  [`${ESC}[A`, BUTTONS.up],
  [`${ESC}[B`, BUTTONS.down],
  ["a", BUTTONS.left],
  ["d", BUTTONS.right],
  ["z", BUTTONS.a],
  ["x", BUTTONS.b],
  ["\r", BUTTONS.start],
]);
let alive = true;
function restart() {
  host = createConsoleHost(module, { buttons: () => pressed });
  host.init();
  alive = true;
}
function onKeys(chunk) {
  const text = String(chunk);
  if (text === "q" || text === "\x03") {
    stop();
    return;
  }
  if (text === "r") restart();
  const button = keys.get(text);
  if (button) press(button);
}

// MARK: Rendering

// The frame is sampled nearest-neighbour onto the terminal grid, two pixel
// rows per cell: the upper half block takes the top pixel's colour as the
// foreground and the bottom pixel's as the background.
function draw(frame, status) {
  const columns = Math.max(1, Math.min(out.columns || 80, frame.width));
  const rows = Math.max(
    1,
    Math.min((out.rows || 24) - 1, Math.ceil(frame.height / 2)),
  );
  const lines = [`${ESC}[H`];
  let foreground = -1;
  let background = -1;
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let column = 0; column < columns; column++) {
      const x = Math.floor((column * frame.width) / columns);
      const top = Math.floor((row * 2 * frame.height) / (rows * 2));
      const bottom = Math.min(
        frame.height - 1,
        Math.floor(((row * 2 + 1) * frame.height) / (rows * 2)),
      );
      const upper = pixel(frame, x, top);
      const lower = pixel(frame, x, bottom);
      if (upper !== foreground) {
        line += `${ESC}[38;2;${rgb(upper)}m`;
        foreground = upper;
      }
      if (lower !== background) {
        line += `${ESC}[48;2;${rgb(lower)}m`;
        background = lower;
      }
      line += "▀";
    }
    lines.push(line + `${ESC}[0m${ESC}[K`);
    foreground = -1;
    background = -1;
  }
  lines.push(`${ESC}[0m${status}${ESC}[K`);
  out.write(lines.join("\n"));
}
// A pixel's colour as 0xRRGGBB, compared as a number and formatted only when
// the cell colour changes.
function pixel(frame, x, y) {
  const offset = (y * frame.width + x) * 4;
  return (frame.rgba[offset] << 16) | (frame.rgba[offset + 1] << 8) |
    frame.rgba[offset + 2];
}
const rgb = (color) => `${color >> 16};${(color >> 8) & 255};${color & 255}`;

// MARK: Loop

const BALL = { r: 255, g: 220, b: 64, a: 255 };
const PADDLE = { r: 230, g: 230, b: 230, a: 255 };
const sameColor = (a, b) =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
function steer(frames) {
  const rects = host.commands.filter((command) => command.op === "fill-rect");
  const ball = rects.find((command) => sameColor(command.color, BALL));
  const paddle = rects.find((command) => sameColor(command.color, PADDLE));
  if (!ball || !paddle) return;
  const target = ball.rect.x + 2 + 14 * Math.sin(frames / 120);
  const center = paddle.rect.x + paddle.rect.w / 2;
  pressed = Math.abs(target - center) < 2
    ? 0
    : target < center
    ? BUTTONS.left
    : BUTTONS.right;
}

let frames = 0;
let timer = null;
function stop() {
  clearInterval(timer);
  for (const release of releases.values()) clearTimeout(release);
  leave();
  if (interactive) process.stdin.pause();
  if (!interactive) out.write("\n");
}
function tick() {
  if (alive) {
    try {
      alive = host.step(Math.round(1000 / fps));
    } catch (error) {
      stop();
      throw new Error(`The game faulted (${host.lastFault()}): ${error}`);
    }
  }
  frames++;
  if (scriptedFrames !== null) steer(frames);
  const status = alive
    ? `frame ${frames}  |  arrows or A/D move, R restarts, Q quits`
    : `frame ${frames}  |  round over: R restarts, Q quits`;
  draw(host.render(), status);
  if (scriptedFrames !== null && frames >= scriptedFrames) {
    stop();
    out.write(
      `Rendered ${frames} frames of ${host.width}x${host.height} at ${fps} Hz.\n`,
    );
  }
}

enter();
if (interactive) process.stdin.on("data", onKeys);
if (scriptedFrames !== null) {
  // Scripted frames need no wall clock.
  while (frames < scriptedFrames) tick();
} else {
  timer = setInterval(tick, 1000 / fps);
}
