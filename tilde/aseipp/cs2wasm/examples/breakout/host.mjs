// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Persistent world state and the complete import interface. This adapter uses
// standard JavaScript APIs so the browser, Node and SpiderMonkey share it.
import { createEntityStore, finiteFloat } from "../entity-host.mjs";

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
  const store = createEntityStore(initialState.entities, (source, handle) => ({
    handle,
    kind: integer(source.kind, KIND.paddle, KIND.brick),
    alive: Boolean(source.alive),
    x: finiteFloat(source.x),
    y: finiteFloat(source.y),
    vx: finiteFloat(source.vx),
    vy: finiteFloat(source.vy),
  }));
  const { entities, entity } = store;
  function onlyHandle(kind) {
    let count = 0;
    let handle;
    for (const value of entities.values()) {
      if (value.kind === kind) {
        count++;
        handle = value.handle;
      }
    }
    if (count !== 1) {
      throw new RangeError(
        "A world must contain exactly one paddle and one ball",
      );
    }
    return handle;
  }
  const paddle = onlyHandle(KIND.paddle);
  onlyHandle(KIND.ball);
  let score = integer(initialState.score, 0, 2147483647);
  let status = integer(initialState.status, STATUS.playing, STATUS.lost);
  let targetX = WORLD.width / 2;

  function update(handle, fields) {
    entity(handle);
    store.queue({ handle, fields });
  }

  const breakout = {
    entity_count: () => store.handles.length,
    entity_at: store.entityAt,
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
    set_score: (value) => store.queue({ score: integer(value, 0, 2147483647) }),
    set_status: (value) =>
      store.queue({ status: integer(value, STATUS.playing, STATUS.lost) }),
  };
  const instance = store.instantiate(module, "breakout", breakout);

  function commit(command) {
    if ("score" in command) score = command.score;
    if ("status" in command) status = command.status;
  }

  function run(name, ...args) {
    return store.run(instance, name, args, commit);
  }

  return {
    step(seconds, paddleTarget) {
      if (
        !Number.isFinite(seconds) ||
        seconds <= 0 ||
        seconds > WORLD.stepSeconds
      ) {
        throw new RangeError(
          "A tick must be positive and no longer than 1/120 second",
        );
      }
      const duration = finiteFloat(seconds);
      if (duration === 0) {
        throw new RangeError("Tick duration is too small for f32");
      }
      targetX = finiteFloat(paddleTarget);
      return run("Demo.Breakout.Tick", duration);
    },
    failFrame: () => run("Demo.Breakout.FailAfterMove"),
    snapshot: () => ({
      entities: [...entities.values()].map((value) => ({ ...value })),
      score,
      status,
    }),
    // Non-copying reads for renderers. The entities passed to `visit` and
    // returned by `entity` are the host's own: read them, never write them.
    forEachEntity(visit) {
      for (const value of entities.values()) visit(value);
    },
    entity,
    paddleHandle: paddle,
    score: () => score,
    status: () => status,
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
