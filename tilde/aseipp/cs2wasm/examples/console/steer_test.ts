// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Plays a round of the console Breakout through the console's web core, the
// runner its browser, headless and terminal hosts share. The game keeps its
// state to itself, so the test steers from the frame the game presents: it
// finds the ball and the paddle by colour and holds the left or right arrow.
// The round must end with every brick cleared, in the module the browser is
// served and in the one wlink wrote, frame for frame.
import { assert, assertEquals } from "../../../wlink/demo/sdk/web/assert.ts";
import { Identity, SILENT_SINKS } from "../../../wlink/demo/sdk/web/hal.ts";
import { keyCode } from "../../../wlink/demo/sdk/web/keys.ts";
import { Outcome, Runner } from "../../../wlink/demo/sdk/web/runner.ts";

type Color = readonly [number, number, number];

// What Breakout.cs draws with, and where.
const BACKGROUND: Color = [16, 16, 32];
const PADDLE: Color = [230, 230, 230];
const BALL: Color = [255, 220, 64];
const SCORE: Color = [96, 200, 255];
const LIFE: Color = [255, 96, 96];
const ROWS: Color[] = [
  [240, 80, 80],
  [240, 160, 64],
  [240, 220, 64],
  [96, 200, 96],
  [96, 128, 240],
];
const COLUMNS = 10;
const BRICK_LEFT = 10;
const BRICK_TOP = 30;
const PADDLE_WIDTH = 48;
const PADDLE_HEIGHT = 6;
const BALL_SIZE = 5;

const LEFT = keyCode("left");
const RIGHT = keyCode("right");

const identity: Identity = {
  name: "headless",
  unixSeconds: () => 0n,
  randomSeed: () => 0n,
  features: () => 0,
  capabilities: () => 7,
};

class Frame {
  constructor(
    readonly pixels: Uint8Array,
    readonly width: number,
    readonly height: number,
  ) {}

  is(x: number, y: number, [r, g, b]: Color): boolean {
    const at = (y * this.width + x) * 4;
    const p = this.pixels;
    return p[at] === r && p[at + 1] === g && p[at + 2] === b &&
      p[at + 3] === 255;
  }

  /** The pixels of a colour: how many, and the leftmost column. */
  find(color: Color): { count: number; left: number } {
    let count = 0;
    let left = this.width;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.is(x, y, color)) continue;
        count++;
        left = Math.min(left, x);
      }
    }
    return { count, left };
  }

  /** The bricks still standing, by the colour at the middle of each slot. */
  bricks(): number {
    let standing = 0;
    for (let row = 0; row < ROWS.length; row++) {
      for (let column = 0; column < COLUMNS; column++) {
        const x = BRICK_LEFT + column * 30 + 14;
        const y = BRICK_TOP + row * 12 + 5;
        if (this.is(x, y, ROWS[row])) standing++;
      }
    }
    return standing;
  }

  lives(): number {
    let lives = 0;
    while (lives < 8 && this.is(6 + lives * 8, 6, LIFE)) lives++;
    return lives;
  }

  scoreBar(): number {
    let width = 0;
    while (this.is(4 + width, this.height - 5, SCORE)) width++;
    return width;
  }
}

function frameOf(runner: Runner): Frame {
  const { pixels, width, height } = runner.state;
  assert(pixels !== null, "the game presented a frame");
  return new Frame(pixels, width, height);
}

interface Round {
  frames: number;
  hash: string;
  score: number;
  lives: number;
}

async function play(path: string): Promise<Round> {
  const runner = await Runner.instantiate(Deno.readFileSync(path), {
    framesPerSecond: 60,
    identity,
    sinks: SILENT_SINKS,
  });
  assertEquals(runner.start(), "continue");
  assertEquals(runner.state.framesPerSecond, 60, "the game asked for 60 Hz");

  let held = -1;
  const hold = (key: number) => {
    if (key === held) return;
    if (held >= 0) runner.state.input.pushKey(held, false);
    if (key >= 0) runner.state.input.pushKey(key, true);
    held = key;
  };

  let outcome: Outcome = "continue";
  let frames = 0;
  for (; frames < 30_000 && outcome === "continue"; frames++) {
    outcome = runner.step();
    assert(outcome !== "trap", `frame ${frames}: ${runner.trapMessage}`);
    const frame = frameOf(runner);
    assertEquals([frame.width, frame.height], [320, 240], "the frame size");
    if (frames === 0) {
      assertEquals(frame.bricks(), 50, "ten by five bricks");
      assertEquals(frame.lives(), 3, "three lives");
      assert(frame.is(160, 120, BACKGROUND), "the background is drawn");
    }

    // Each frame starts from a clean slate: one paddle, at most one ball.
    const paddle = frame.find(PADDLE);
    assertEquals(paddle.count, PADDLE_WIDTH * PADDLE_HEIGHT, "one paddle");
    const ball = frame.find(BALL);
    assert(ball.count <= BALL_SIZE * BALL_SIZE, "at most one ball");
    if (outcome !== "continue" || ball.count === 0) continue;

    // Aim the paddle a little off the ball, changing over time, so the
    // rebound angles vary and the ball reaches every column.
    const target = ball.left + 2 + 14 * Math.sin(frames / 120);
    const center = paddle.left + PADDLE_WIDTH / 2;
    hold(
      Math.abs(target - center) < 2 ? -1 : target < center ? LEFT : RIGHT,
    );
  }

  assertEquals(outcome, "stopped", "the round ends");
  const final = frameOf(runner);
  assertEquals(final.bricks(), 0, "the steering clears every brick");
  const round = {
    frames,
    hash: runner.frameHash(),
    score: final.scoreBar(),
    lives: final.lives(),
  };
  assert(round.score > 0, "the score was drawn");

  // After the round the game keeps answering, drawing the finished board.
  assertEquals(runner.step(), "stopped", "a finished game stays finished");
  assertEquals(frameOf(runner).bricks(), 0);
  return round;
}

function env(name: string): string {
  const value = Deno.env.get(name);
  assert(value !== undefined, `${name} names a module`);
  return value;
}

Deno.test("the steering clears the board in the served module", async () => {
  const served = await play(env("BREAKOUT_SERVED_WASM"));
  console.log(
    `Played ${served.frames} frames (${(served.frames / 60).toFixed(1)} s): ` +
      `${served.lives} lives left, score bar ${served.score} px, ` +
      `final frame ${served.hash}.`,
  );
  // wasm-opt changed the module, not the game.
  assertEquals(await play(env("BREAKOUT_LINKED_WASM")), served);
});

Deno.test("the componentized game carries the component layer", () => {
  const component = Deno.readFileSync(env("BREAKOUT_COMPONENT_WASM"));
  assertEquals(
    [...component.subarray(0, 8)],
    [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00],
  );
});
