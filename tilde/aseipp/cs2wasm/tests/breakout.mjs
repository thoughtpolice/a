import {
  createBreakoutHost,
  createInitialState,
  KIND,
  STATUS,
  WORLD,
} from '../examples/breakout/host.mjs';

function findEntity(state, kind) {
  return state.entities.find((entity) => entity.kind === kind);
}

function liveBricks(state) {
  return state.entities.filter(
    (entity) => entity.kind === KIND.brick && entity.alive,
  ).length;
}

function withBall(values) {
  const state = createInitialState();
  Object.assign(findEntity(state, KIND.ball), values);
  return state;
}

// A complete round uses the real host and compiled C# physics. A changing aim
// offset steers the ball into new columns instead of returning it vertically.
export function runAutoplay(module) {
  const host = createBreakoutHost(module);
  let steps = 0;
  let state = host.snapshot();
  while (state.status === STATUS.playing && steps < 20000) {
    const ball = findEntity(state, KIND.ball);
    const target = ball.x + 25 * Math.sin(steps / 90);
    host.step(WORLD.stepSeconds, target);
    steps++;
    state = host.snapshot();
  }
  return {
    steps,
    seconds: steps * WORLD.stepSeconds,
    score: state.score,
    status: state.status,
    remainingBricks: liveBricks(state),
    fault: host.lastFault(),
  };
}

export function checkBreakout(module, assert) {
  let checks = 0;
  function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    checks++;
  }
  function near(actual, expected, message) {
    equal(Math.abs(actual - expected) < 0.0001, true, message);
  }
  function throws(action, error, message) {
    assert.throws(action, error, message);
    checks++;
  }

  const initial = createInitialState();
  const initialJson = JSON.stringify(initial);
  const host = createBreakoutHost(module, initial);
  equal(
    host.snapshot().entities.length,
    34,
    'a new world has a paddle, ball and 32 bricks',
  );
  equal(liveBricks(host.snapshot()), 32, 'every initial brick is alive');
  equal(
    JSON.stringify(host.snapshot()),
    initialJson,
    'host starts with the supplied world',
  );

  initial.entities[0].x = 0;
  initial.score = 999;
  const detached = host.snapshot();
  detached.entities[1].vy = 999;
  detached.entities.pop();
  detached.status = STATUS.lost;
  equal(
    JSON.stringify(host.snapshot()),
    initialJson,
    'input and output snapshots cannot mutate host state',
  );
  equal(
    JSON.stringify(createInitialState()),
    initialJson,
    'initial worlds do not share mutable entities',
  );

  equal(
    host.step(WORLD.stepSeconds, 400),
    STATUS.playing,
    'the first tick keeps playing',
  );
  let state = host.snapshot();
  let ball = findEntity(state, KIND.ball);
  near(ball.x, 400 + 160 / 120, 'first tick integrates horizontal velocity');
  near(ball.y, 510 - 260 / 120, 'first tick integrates vertical velocity');
  equal(findEntity(state, KIND.paddle).x, 400, 'paddle stays at its target');
  equal(state.score, 0, 'moving through empty space earns no points');
  equal(host.lastFault(), 0, 'normal frames do not fault');

  for (const [name, start, expected] of [
    ['left wall', { x: 8.5, y: 300, vx: -160, vy: 0 }, { x: 8, vx: 160 }],
    ['right wall', { x: 791.5, y: 300, vx: 160, vy: 0 }, { x: 792, vx: -160 }],
    ['ceiling', { x: 400, y: 8.5, vx: 0, vy: -260 }, { y: 8, vy: 260 }],
  ]) {
    const wallHost = createBreakoutHost(module, withBall(start));
    wallHost.step(WORLD.stepSeconds, 400);
    ball = findEntity(wallHost.snapshot(), KIND.ball);
    for (const [field, value] of Object.entries(expected)) {
      near(
        ball[field],
        value,
        `${name} reflects the ball and resolves its position`,
      );
    }
    equal(wallHost.snapshot().score, 0, `${name} does not count as a brick`);
  }

  const paddleHost = createBreakoutHost(
    module,
    withBall({ x: 410, y: 532, vx: 0, vy: 260 }),
  );
  paddleHost.step(WORLD.stepSeconds, 400);
  ball = findEntity(paddleHost.snapshot(), KIND.ball);
  near(ball.y, 533, 'paddle collision places the ball above the surface');
  equal(ball.vy, -260, 'a descending ball rebounds upward');
  near(
    ball.vx,
    (10 / 55) * 280,
    'paddle hit position determines the outgoing direction',
  );
  paddleHost.step(WORLD.stepSeconds, 400);
  ball = findEntity(paddleHost.snapshot(), KIND.ball);
  equal(
    ball.y < 533,
    true,
    'the next tick leaves the paddle without another collision',
  );
  equal(ball.vy, -260, 'the outgoing vertical velocity remains upward');

  for (const [startX, target, expectedX] of [
    [56, -1000, 55],
    [744, 1000, 745],
    [400, 700, 405],
  ]) {
    const paddleState = withBall({ x: 400, y: 300, vx: 0, vy: 0 });
    findEntity(paddleState, KIND.paddle).x = startX;
    const movingHost = createBreakoutHost(module, paddleState);
    movingHost.step(WORLD.stepSeconds, target);
    near(
      findEntity(movingHost.snapshot(), KIND.paddle).x,
      expectedX,
      'paddle travel respects speed and world bounds',
    );
  }

  const brickHost = createBreakoutHost(
    module,
    withBall({ x: 120, y: 60, vx: 0, vy: 260 }),
  );
  brickHost.step(WORLD.stepSeconds, 400);
  state = brickHost.snapshot();
  equal(state.score, 10, 'destroying one brick earns ten points');
  equal(liveBricks(state), 31, 'a destroyed brick is no longer alive');
  equal(
    state.entities.find((entity) => entity.handle === 100).alive,
    false,
    'the intersected brick is removed',
  );
  equal(
    state.status,
    STATUS.playing,
    'other live bricks keep the round active',
  );
  near(
    findEntity(state, KIND.ball).y,
    62,
    'brick collision resolves at its expanded top face',
  );
  equal(
    findEntity(state, KIND.ball).vy,
    -260,
    'brick collision reflects the ball',
  );

  const overlapState = withBall({ x: 120, y: 60, vx: 0, vy: 260 });
  Object.assign(
    overlapState.entities.find((entity) => entity.handle === 101),
    { x: 120, y: 80 },
  );
  const overlapHost = createBreakoutHost(module, overlapState);
  overlapHost.step(WORLD.stepSeconds, 400);
  equal(
    liveBricks(overlapHost.snapshot()),
    31,
    'overlapping bricks remove at most one brick per tick',
  );
  equal(
    overlapHost.snapshot().score,
    10,
    'overlapping bricks award points only once',
  );
  equal(
    overlapHost.snapshot().entities.find((entity) => entity.handle === 101)
      .alive,
    true,
    'the second overlapping brick remains available',
  );

  const winningState = withBall({ x: 120, y: 60, vx: 0, vy: 260 });
  winningState.entities = winningState.entities.filter(
    (entity) => entity.kind !== KIND.brick || entity.handle === 100,
  );
  winningState.score = 310;
  const winningHost = createBreakoutHost(module, winningState);
  equal(
    winningHost.step(WORLD.stepSeconds, 400),
    STATUS.won,
    'the final brick wins the round',
  );
  equal(
    winningHost.snapshot().score,
    320,
    'the winning frame commits its final points',
  );
  equal(
    liveBricks(winningHost.snapshot()),
    0,
    'the winning frame commits the final brick removal',
  );
  const wonJson = JSON.stringify(winningHost.snapshot());
  equal(
    winningHost.step(WORLD.stepSeconds, 0),
    STATUS.won,
    'finished rounds keep their winning result',
  );
  equal(
    JSON.stringify(winningHost.snapshot()),
    wonJson,
    'winning freezes the world',
  );

  const losingHost = createBreakoutHost(
    module,
    withBall({ x: 400, y: 607, vx: 0, vy: 260 }),
  );
  equal(
    losingHost.step(WORLD.stepSeconds, 400),
    STATUS.lost,
    'a ball below the bottom loses the round',
  );
  equal(
    losingHost.snapshot().status,
    STATUS.lost,
    'loss persists in host state',
  );
  equal(losingHost.snapshot().score, 0, 'losing does not change the score');
  const lostJson = JSON.stringify(losingHost.snapshot());
  equal(
    losingHost.step(WORLD.stepSeconds, 0),
    STATUS.lost,
    'finished rounds keep their losing result',
  );
  equal(
    JSON.stringify(losingHost.snapshot()),
    lostJson,
    'losing freezes the world',
  );

  const beforeFault = JSON.stringify(host.snapshot());
  throws(
    () => host.failFrame(),
    WebAssembly.RuntimeError,
    'the deliberate invalid frame traps',
  );
  equal(host.lastFault(), 6, 'the deliberate failure is an array bounds fault');
  equal(
    JSON.stringify(host.snapshot()),
    beforeFault,
    'a trap discards every queued command',
  );
  equal(
    host.step(WORLD.stepSeconds, 400),
    STATUS.playing,
    'a valid frame can follow a failed frame',
  );
  equal(host.lastFault(), 0, 'a successful frame clears the previous fault');
  equal(
    JSON.stringify(host.snapshot()) !== beforeFault,
    true,
    'recovery resumes persistent movement',
  );

  const beforeInvalidInput = JSON.stringify(host.snapshot());
  for (const seconds of [0, -1, NaN, Infinity, 1 / 60, Number.MIN_VALUE]) {
    throws(
      () => host.step(seconds, 400),
      RangeError,
      'invalid tick durations are rejected',
    );
  }
  for (const target of [NaN, Infinity, 1e40]) {
    throws(
      () => host.step(WORLD.stepSeconds, target),
      RangeError,
      'nonfinite f32 targets are rejected',
    );
  }
  equal(
    JSON.stringify(host.snapshot()),
    beforeInvalidInput,
    'rejected input leaves the world unchanged',
  );
  const invalidWorld = createInitialState();
  invalidWorld.entities[0].x = NaN;
  throws(
    () => createBreakoutHost(module, invalidWorld),
    RangeError,
    'nonfinite initial coordinates are rejected',
  );
  equal(
    host.step(WORLD.stepSeconds, 400),
    STATUS.playing,
    'rejected input does not prevent the next frame',
  );

  const completed = runAutoplay(module);
  equal(
    completed.status,
    STATUS.won,
    'autoplay completes a full round within 20000 ticks',
  );
  equal(completed.score, 320, 'a complete round earns exactly 320 points');
  equal(completed.remainingBricks, 0, 'a complete round removes all 32 bricks');
  equal(completed.fault, 0, 'the complete round stays within compiler limits');
  return checks;
}
