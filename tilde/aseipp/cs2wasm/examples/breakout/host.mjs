// Persistent world state and the complete import interface. This adapter uses
// standard JavaScript APIs so the browser, Node and SpiderMonkey share it.
export const WORLD = Object.freeze({
  width: 800,
  height: 600,
  paddleHalfWidth: 55,
  paddleHalfHeight: 9,
  ballRadius: 8,
  brickHalfWidth: 31,
  brickHalfHeight: 10,
  stepSeconds: 1 / 120,
});
export const KIND = Object.freeze({ paddle: 0, ball: 1, brick: 2 });
export const STATUS = Object.freeze({ playing: 0, won: 1, lost: 2 });

export function createInitialState() {
  const entities = [
    { handle: 1, kind: KIND.paddle, alive: true, x: 400, y: 550, vx: 0, vy: 0 },
    {
      handle: 2,
      kind: KIND.ball,
      alive: true,
      x: 400,
      y: 510,
      vx: 160,
      vy: -260,
    },
  ];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 8; column++) {
      entities.push({
        handle: 100 + row * 8 + column,
        kind: KIND.brick,
        alive: true,
        x: 120 + column * 80,
        y: 80 + row * 32,
        vx: 0,
        vy: 0,
      });
    }
  }
  return { entities, score: 0, status: STATUS.playing };
}

export function createBreakoutHost(
  module,
  initialState = createInitialState(),
) {
  const entities = new Map();
  for (const source of initialState.entities) {
    const handle = integer(source.handle, 1, 2147483647);
    if (entities.has(handle)) throw new RangeError('Duplicate entity handle');
    entities.set(handle, {
      handle,
      kind: integer(source.kind, KIND.paddle, KIND.brick),
      alive: Boolean(source.alive),
      x: finiteFloat(source.x),
      y: finiteFloat(source.y),
      vx: finiteFloat(source.vx),
      vy: finiteFloat(source.vy),
    });
  }
  for (const kind of [KIND.paddle, KIND.ball]) {
    if (
      [...entities.values()].filter((entity) => entity.kind === kind).length !==
      1
    ) {
      throw new RangeError(
        'A world must contain exactly one paddle and one ball',
      );
    }
  }
  let score = integer(initialState.score, 0, 2147483647);
  let status = integer(initialState.status, STATUS.playing, STATUS.lost);
  const handles = [...entities.keys()];
  let targetX = WORLD.width / 2;
  let pending = null;

  function entity(handle) {
    const value = entities.get(handle);
    if (!value) throw new RangeError(`Unknown entity handle ${handle}`);
    return value;
  }

  function queue(command) {
    if (pending === null) throw new Error('Commands require an active tick');
    pending.push(command);
  }

  function update(handle, fields) {
    entity(handle);
    queue({ handle, fields });
  }

  const breakout = {
    entity_count: () => handles.length,
    entity_at: (index) => handles[integer(index, 0, handles.length - 1)],
    kind: (handle) => entity(handle).kind,
    is_alive: (handle) => (entity(handle).alive ? 1 : 0),
    read_x: (handle) => entity(handle).x,
    read_y: (handle) => entity(handle).y,
    read_velocity_x: (handle) => entity(handle).vx,
    read_velocity_y: (handle) => entity(handle).vy,
    paddle_target: () => targetX,
    score: () => score,
    status: () => status,
    set_position: (handle, x, y) =>
      update(handle, { x: finiteFloat(x), y: finiteFloat(y) }),
    set_velocity: (handle, vx, vy) =>
      update(handle, { vx: finiteFloat(vx), vy: finiteFloat(vy) }),
    set_alive: (handle, alive) => update(handle, { alive: alive !== 0 }),
    set_score: (value) => queue({ score: integer(value, 0, 2147483647) }),
    set_status: (value) =>
      queue({ status: integer(value, STATUS.playing, STATUS.lost) }),
  };

  for (const entry of WebAssembly.Module.imports(module)) {
    if (
      entry.module !== 'breakout' ||
      entry.kind !== 'function' ||
      !Object.hasOwn(breakout, entry.name)
    ) {
      throw new Error(`Unsupported import ${entry.module}.${entry.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, { breakout });

  function run(name, ...args) {
    if (pending !== null) throw new Error('Reentrant ticks are not allowed');
    pending = [];
    try {
      const result = instance.exports[name](...args);
      // Reads above still see the previous frame. Every command is validated
      // before it enters the batch, and only a successful call commits it.
      for (const command of pending) {
        if ('handle' in command)
          Object.assign(entity(command.handle), command.fields);
        if ('score' in command) score = command.score;
        if ('status' in command) status = command.status;
      }
      return result;
    } finally {
      // A trap or host exception skips the commit and discards every command.
      pending = null;
    }
  }

  return {
    step(seconds, paddleTarget) {
      if (
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > WORLD.stepSeconds
      ) {
        throw new RangeError(
          'A tick must be positive and no longer than 1/120 second',
        );
      }
      const duration = finiteFloat(seconds);
      if (duration === 0)
        throw new RangeError('Tick duration is too small for f32');
      targetX = finiteFloat(paddleTarget);
      return run('Demo.Breakout.Tick', duration);
    },
    failFrame: () => run('Demo.Breakout.FailAfterMove'),
    snapshot: () => ({
      entities: [...entities.values()].map((value) => ({ ...value })),
      score,
      status,
    }),
    lastFault: () => instance.exports.__fault.value,
  };
}

function integer(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Expected an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function finiteFloat(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isFinite(Math.fround(value))
  ) {
    throw new RangeError('World values must be finite f32 numbers');
  }
  return Math.fround(value);
}
