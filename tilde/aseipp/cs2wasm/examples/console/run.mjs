// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Plays the console Breakout headlessly: the host steers the paddle from what
// the game draws, since the game keeps its state to itself. Arguments: the
// module, and optionally its component, whose header is checked.
import assert from "node:assert/strict";
import fs from "node:fs";
import { BUTTONS, createConsoleHost, frameHash } from "./host.mjs";

const [modulePath, componentPath] = process.argv.slice(2);
if (!modulePath) {
  throw new Error("Usage: run.mjs <breakout.wasm> [breakout-component.wasm]");
}

const module = new WebAssembly.Module(fs.readFileSync(modulePath));
let pressed = 0;
const host = createConsoleHost(module, { buttons: () => pressed });
host.init();
assert.equal(host.width, 320, "the game chose its frame size");
assert.equal(host.height, 240);
assert.equal(host.frameRate, 60, "the game asked for 60 Hz");

const sameColor = (a, b) =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const BALL = { r: 255, g: 220, b: 64, a: 255 };
const PADDLE = { r: 230, g: 230, b: 230, a: 255 };
const SCORE = { r: 96, g: 200, b: 255, a: 255 };
const LIFE = { r: 255, g: 96, b: 96, a: 255 };
const rects = (commands, color) =>
  commands.filter((command) =>
    command.op === "fill-rect" && sameColor(command.color, color)
  );
const brickCount = (commands) =>
  commands.filter((command) =>
    command.op === "fill-rect" && command.rect.y < 100 && command.rect.h === 10
  ).length;

let frames = 0;
let alive = true;
let initialBricks = 0;
for (; frames < 30_000; frames++) {
  alive = host.step(16);
  assert.equal(host.lastFault(), 0, `frame ${frames} faulted`);
  const commands = host.commands;
  assert.equal(commands[0].op, "clear", "every frame starts with a clear");
  if (frames === 0) {
    initialBricks = brickCount(commands);
    assert.equal(initialBricks, 50, "ten by five bricks");
    assert.equal(rects(commands, LIFE).length, 3, "three lives");
  }
  if (!alive) break;

  // Aim the paddle a little off the ball, changing over time, so the rebound
  // angles vary and the ball reaches every column.
  const [ball] = rects(commands, BALL);
  const [paddle] = rects(commands, PADDLE);
  assert.ok(ball && paddle, "the ball and paddle are drawn");
  const target = ball.rect.x + 2 + 14 * Math.sin(frames / 120);
  const center = paddle.rect.x + paddle.rect.w / 2;
  pressed = Math.abs(target - center) < 2
    ? 0
    : target < center
    ? BUTTONS.left
    : BUTTONS.right;
}

const final = host.commands;
const remaining = brickCount(final);
const scoreBar = rects(final, SCORE)[0]?.rect.w ?? 0;
console.log(
  `Played ${frames} frames (${(frames / 60).toFixed(1)} s): ${
    initialBricks - remaining
  } bricks cleared, ` +
    `${
      rects(final, LIFE).length
    } lives left, score bar ${scoreBar} px, final frame ${
      frameHash(host.render())
    }.`,
);
assert.equal(alive, false, "the round ends");
assert.equal(remaining, 0, "the steering host clears every brick");
assert.ok(scoreBar > 0, "the score was drawn");

// After the round the game keeps answering, drawing the finished board.
assert.equal(host.step(16), false, "a finished game stays finished");
assert.equal(brickCount(host.commands), 0);

if (componentPath) {
  const component = fs.readFileSync(componentPath);
  assert.deepEqual(
    [...component.subarray(0, 8)],
    [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00],
    "the componentized game carries the component layer",
  );
  console.log(`The component is ${component.length} bytes.`);
}
console.log("PASS: console Breakout.");
