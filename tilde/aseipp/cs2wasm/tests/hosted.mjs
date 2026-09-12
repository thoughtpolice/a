// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { createGameHost, exampleEntities } from '../examples/game-host.mjs';

export function checkHostedGameplay(module, assert) {
  const host = createGameHost(module, exampleEntities());
  let checks = 0;
  const expectedFrames = [
    [0.5, [1, 0, 2, 0], [9.5, -2.25, -1, -0.5]],
    [1, [3, -2, 2, -2], [8.5, -4.75, -1, -2.5]],
    [0.5, [4, -3.5, 2, -3], [8, -6.5, -1, -3.5]],
  ];
  for (const [seconds, first, second] of expectedFrames) {
    assert.equal(host.step(seconds), 2, 'two live entities moved');
    const state = host.snapshot();
    for (const [index, expected] of [
      [0, first],
      [1, second],
    ]) {
      const entity = state[index];
      assert.equal(
        JSON.stringify([entity.x, entity.y, entity.vx, entity.vy]),
        JSON.stringify(expected),
      );
    }
    assert.equal(
      JSON.stringify(state[2]),
      JSON.stringify(exampleEntities()[2]),
      'inactive entity unchanged',
    );
    assert.equal(host.lastFault(), 0);
    checks++;
  }

  const before = JSON.stringify(host.snapshot());
  assert.throws(
    () => host.run('Demo.HostedGameplay.FailAfterMove', 101),
    WebAssembly.RuntimeError,
  );
  assert.equal(host.lastFault(), 6);
  assert.equal(
    JSON.stringify(host.snapshot()),
    before,
    'failed frame discards queued commands',
  );
  checks++;

  assert.throws(
    () => host.run('Demo.HostedGameplay.MoveUnknownHandle'),
    RangeError,
  );
  assert.equal(
    JSON.stringify(host.snapshot()),
    before,
    'unknown handle cannot alter state',
  );
  checks++;
  assert.throws(
    () => host.run('Demo.HostedGameplay.InvalidPosition', 101),
    RangeError,
  );
  assert.equal(
    JSON.stringify(host.snapshot()),
    before,
    'nonfinite command cannot alter state',
  );
  checks++;
  assert.equal(
    host.step(0.5),
    2,
    'host remains usable after traps and host exceptions',
  );
  assert.equal(host.lastFault(), 0);
  checks++;
  assert.throws(() => host.step(0), RangeError);
  assert.throws(() => host.step(NaN), RangeError);
  checks += 2;

  const empty = createGameHost(module, []);
  assert.equal(empty.step(1), 0, 'empty world');
  checks++;
  return checks;
}
