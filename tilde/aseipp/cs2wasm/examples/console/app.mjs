// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The browser page: keyboard to buttons, animation frames to `frame`, the
// display list to a canvas. The game itself is the compiled C# module.
import { BUTTONS, createConsoleHost } from "./host.mjs";

const canvas = document.getElementById("screen");
const status = document.getElementById("status");
const context = canvas.getContext("2d");
context.imageSmoothingEnabled = false;

const keys = new Map([
  ["ArrowLeft", BUTTONS.left],
  ["ArrowRight", BUTTONS.right],
  ["KeyA", BUTTONS.left],
  ["KeyD", BUTTONS.right],
  ["ArrowUp", BUTTONS.up],
  ["ArrowDown", BUTTONS.down],
  ["KeyZ", BUTTONS.a],
  ["KeyX", BUTTONS.b],
  ["Enter", BUTTONS.start],
]);
let pressed = 0;
window.addEventListener("keydown", (event) => {
  const button = keys.get(event.code);
  if (button) {
    pressed |= button;
    event.preventDefault();
  }
  if (event.code === "KeyR") restart();
});
window.addEventListener("keyup", (event) => {
  const button = keys.get(event.code);
  if (button) pressed &= ~button;
});

const module = await WebAssembly.compileStreaming(fetch("breakout.wasm"));
let host;
let alive = true;
let last = performance.now();
let offscreen;

function restart() {
  host = createConsoleHost(module, { buttons: () => pressed });
  host.init();
  offscreen = new OffscreenCanvas(host.width, host.height);
  alive = true;
  status.textContent = "Arrow keys or A/D move the paddle. R restarts.";
}

function tick(now) {
  const dt = Math.min(50, Math.max(1, Math.round(now - last)));
  last = now;
  if (alive) {
    try {
      alive = host.step(dt);
    } catch (error) {
      status.textContent = `The game faulted (${host.lastFault()}): ${error}`;
      alive = false;
    }
    if (!alive && !status.textContent.startsWith("The game faulted")) {
      status.textContent = "Round over. R restarts.";
    }
  }
  const frame = host.render();
  offscreen.getContext("2d").putImageData(
    new ImageData(frame.rgba, frame.width, frame.height),
    0,
    0,
  );
  context.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  requestAnimationFrame(tick);
}

restart();
requestAnimationFrame(tick);
