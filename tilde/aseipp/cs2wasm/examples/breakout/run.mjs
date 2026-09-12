// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Exercise the actual compiled C# and shared host without browser timing.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBreakoutHost, KIND, STATUS, WORLD } from './host.mjs';

const wasm = new URL('../../publish/breakout.wasm', import.meta.url);
let bytes;
try {
  bytes = await readFile(wasm);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  throw new Error(
    'Compile first: ./publish/gameplayc -o publish/breakout.wasm examples/breakout/Breakout.cs',
  );
}
const module = await WebAssembly.compile(bytes);
const host = createBreakoutHost(module);
console.log(
  `Loaded ${bytes.length} bytes; ${WebAssembly.Module.imports(module).length} typed host imports.`,
);

const before = host.snapshot();
assert.throws(() => host.failFrame(), WebAssembly.RuntimeError);
assert.equal(host.lastFault(), 6);
assert.deepEqual(host.snapshot(), before);
console.log('Rollback: fault 6; all queued changes discarded.');

let ticks = 0;
for (; ticks < 20_000 && host.snapshot().status === STATUS.playing; ticks++) {
  const ball = host
    .snapshot()
    .entities.find((entity) => entity.kind === KIND.ball);
  // Follow the ball with a changing offset. This varies paddle rebounds so
  // the ball explores the whole board instead of repeating one empty column.
  host.step(WORLD.stepSeconds, ball.x + 25 * Math.sin(ticks / 90));
  assert.equal(host.lastFault(), 0, 'A normal entry recovers after the trap');
  if ((ticks + 1) % 2400 === 0) {
    const state = host.snapshot();
    const remaining = state.entities.filter(
      (entity) => entity.kind === KIND.brick && entity.alive,
    ).length;
    console.log(
      `${((ticks + 1) * WORLD.stepSeconds).toFixed(0)}s: score ${state.score}, ${remaining} ${remaining === 1 ? 'brick' : 'bricks'} left.`,
    );
  }
}
const final = host.snapshot();
assert.equal(final.status, STATUS.won, 'Scripted paddle must clear the board');
assert.equal(final.score, 320);
assert.equal(
  final.entities.filter((entity) => entity.kind === KIND.brick && entity.alive)
    .length,
  0,
);
host.step(WORLD.stepSeconds, 400);
assert.deepEqual(host.snapshot(), final, 'Finished games stop advancing');
console.log(
  `Won: score ${final.score}, all 32 bricks cleared in ${ticks} ticks (${(ticks * WORLD.stepSeconds).toFixed(2)} simulated seconds).`,
);
