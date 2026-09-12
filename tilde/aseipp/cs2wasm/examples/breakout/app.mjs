// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { createBreakoutHost, KIND, STATUS, WORLD } from './host.mjs';

const canvas = document.querySelector('#game');
const context = canvas.getContext('2d');
const play = document.querySelector('#play');
const step = document.querySelector('#step');
const reset = document.querySelector('#reset');
const rollback = document.querySelector('#rollback');
const statusText = document.querySelector('#status');
const overlay = document.querySelector('#overlay');
const title = document.querySelector('#title');
const subtitle = document.querySelector('#subtitle');
const score = document.querySelector('#score');
const remaining = document.querySelector('#remaining');
const keys = new Set();
let module;
let host;
let running = false;
let started = false;
let targetX = WORLD.width / 2;
let elapsed = 0;
let previousTime = 0;

function refreshControls() {
  const state = host.snapshot();
  const finished = state.status !== STATUS.playing;
  play.textContent = running ? 'Pause' : started ? 'Resume' : 'Start';
  play.disabled = finished;
  step.disabled = running || finished;
  reset.disabled = false;
  rollback.disabled = false;
  overlay.hidden = running;
  title.textContent =
    state.status === STATUS.won
      ? 'Board cleared.'
      : state.status === STATUS.lost
        ? 'Out of bounds.'
        : started
          ? 'Paused.'
          : 'Clear the board.';
  subtitle.textContent = finished
    ? 'Reset to play again.'
    : started
      ? 'Resume when you’re ready.'
      : 'One ball. Thirty-two bricks. Keep it in play.';
}

function pause() {
  running = false;
  elapsed = 0;
  refreshControls();
}

function togglePlay() {
  if (!host || host.snapshot().status !== STATUS.playing) return;
  running = !running;
  started = true;
  elapsed = 0;
  statusText.textContent = running
    ? 'Keep the ball above the paddle.'
    : 'Paused. Step advances one physics tick.';
  refreshControls();
}

function resetGame() {
  host = createBreakoutHost(module);
  started = false;
  targetX = WORLD.width / 2;
  keys.clear();
  pause();
  statusText.textContent = 'Ready. Start to play, or Step to inspect one tick.';
  draw();
}

function tick() {
  const direction =
    Number(keys.has('ArrowRight') || keys.has('KeyD')) -
    Number(keys.has('ArrowLeft') || keys.has('KeyA'));
  if (direction !== 0) {
    const paddle = host
      .snapshot()
      .entities.find((entity) => entity.kind === KIND.paddle);
    targetX = paddle.x + direction * 600 * WORLD.stepSeconds;
  }
  const status = host.step(WORLD.stepSeconds, targetX);
  if (status !== STATUS.playing) {
    pause();
    statusText.textContent =
      status === STATUS.won
        ? 'All 32 bricks cleared. Nicely played.'
        : 'The ball got past you. Reset for another go.';
  }
}

function reportError(error) {
  pause();
  statusText.textContent = `Tick failed: ${error.message}. Fault ${host.lastFault()}. Pending changes were discarded.`;
}

function draw() {
  const state = host.snapshot();
  context.clearRect(0, 0, WORLD.width, WORLD.height);
  context.strokeStyle = '#243746';
  context.lineWidth = 1;
  for (let y = 24; y < WORLD.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(WORLD.width, y);
    context.stroke();
  }
  const colors = ['#83d9c4', '#80b9e6', '#b9a0e1', '#efb987'];
  for (const entity of state.entities) {
    if (!entity.alive) continue;
    if (entity.kind === KIND.ball) {
      context.fillStyle = '#fff2d5';
      context.beginPath();
      context.arc(entity.x, entity.y, WORLD.ballRadius, 0, Math.PI * 2);
      context.fill();
    } else {
      const paddle = entity.kind === KIND.paddle;
      const halfWidth = paddle ? WORLD.paddleHalfWidth : WORLD.brickHalfWidth;
      const halfHeight = paddle
        ? WORLD.paddleHalfHeight
        : WORLD.brickHalfHeight;
      context.fillStyle = paddle
        ? '#eef4fa'
        : colors[Math.floor((entity.handle - 100) / 8) % colors.length];
      context.fillRect(
        entity.x - halfWidth,
        entity.y - halfHeight,
        halfWidth * 2,
        halfHeight * 2,
      );
    }
  }
  score.textContent = state.score;
  const bricks = state.entities.filter(
    (entity) => entity.kind === KIND.brick && entity.alive,
  ).length;
  remaining.textContent = `${bricks} ${bricks === 1 ? 'brick' : 'bricks'} left`;
}

function frame(time) {
  const seconds =
    previousTime === 0 ? 0 : Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;
  if (running) {
    elapsed += seconds;
    try {
      // Rendering frequency never changes the physics step. Drop long pauses
      // rather than simulating an unbounded backlog after a hidden tab resumes.
      while (elapsed >= WORLD.stepSeconds && running) {
        elapsed -= WORLD.stepSeconds;
        tick();
      }
    } catch (error) {
      reportError(error);
    }
  }
  draw();
  requestAnimationFrame(frame);
}

canvas.addEventListener('pointermove', (event) => {
  const bounds = canvas.getBoundingClientRect();
  targetX = ((event.clientX - bounds.left) * WORLD.width) / bounds.width;
});
canvas.addEventListener('pointerdown', (event) => {
  canvas.focus();
  canvas.setPointerCapture(event.pointerId);
  const bounds = canvas.getBoundingClientRect();
  targetX = ((event.clientX - bounds.left) * WORLD.width) / bounds.width;
});
document.addEventListener('keydown', (event) => {
  if (!host) return;
  if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(event.code)) {
    event.preventDefault();
    keys.add(event.code);
  } else if (event.code === 'Space' && event.target.tagName !== 'BUTTON') {
    event.preventDefault();
    if (!event.repeat) togglePlay();
  } else if (event.code === 'KeyR' && !event.repeat) {
    resetGame();
  }
});
document.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => {
  keys.clear();
  if (host) pause();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && host) pause();
});
play.addEventListener('click', () => {
  togglePlay();
  canvas.focus();
});
reset.addEventListener('click', () => {
  resetGame();
  canvas.focus();
});
step.addEventListener('click', () => {
  started = true;
  try {
    tick();
  } catch (error) {
    reportError(error);
  }
  refreshControls();
  draw();
  canvas.focus();
});
rollback.addEventListener('click', () => {
  pause();
  const before = JSON.stringify(host.snapshot());
  try {
    host.failFrame();
    statusText.textContent = 'The expected trap did not occur.';
  } catch (error) {
    const unchanged = before === JSON.stringify(host.snapshot());
    statusText.textContent =
      error instanceof WebAssembly.RuntimeError &&
      host.lastFault() === 6 &&
      unchanged
        ? 'Rollback verified: bounds fault 6; world and score unchanged. Resume to continue.'
        : `Rollback check failed: ${error.message}`;
  }
  draw();
  canvas.focus();
});

try {
  const response = await fetch('/breakout.wasm');
  if (!response.ok) throw new Error(await response.text());
  module = await WebAssembly.compile(await response.arrayBuffer());
  resetGame();
  requestAnimationFrame(frame);
} catch (error) {
  title.textContent = 'Unable to load the game.';
  subtitle.textContent = 'Check the build command in the example README.';
  statusText.textContent = error.message;
}
