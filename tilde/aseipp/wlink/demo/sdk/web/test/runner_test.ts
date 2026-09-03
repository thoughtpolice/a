// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "../assert.ts";
import { AudioSink } from "../audio.ts";
import { fixtureModule, FixtureSpec } from "../fixtures.ts";
import { Identity, SILENT_SINKS } from "../hal.ts";
import { parseScript } from "../input.ts";
import { Runner } from "../runner.ts";

const IDENTITY: Identity = {
  name: "headless",
  unixSeconds: () => 0n,
  randomSeed: () => 0n,
  features: () => 0,
  capabilities: () => 7,
};

class Counter implements AudioSink {
  chunks = 0;
  silent = 0;

  chunk(): void {
    this.chunks++;
  }

  silence(frames: number): void {
    this.silent += frames;
  }
}

async function runner(
  spec: FixtureSpec,
  framesPerSecond = 60,
  audioSink?: AudioSink,
) {
  const module = new WebAssembly.Module(fixtureModule(spec));
  return await Runner.instantiate(module, {
    framesPerSecond,
    identity: IDENTITY,
    sinks: SILENT_SINKS,
    audioSink,
  });
}

Deno.test("the clock advances one frame period per frame", async () => {
  const slow = await runner({}, 35);
  assertEquals(slow.start(), "continue");
  const stamps: number[] = [];
  for (let i = 0; i < 4; i++) {
    assertEquals(slow.step(), "continue");
    stamps.push(Number(slow.state.nowMs));
  }
  assertEquals(stamps, [29, 58, 86, 115]);
});

Deno.test("a rate chosen during init is the one the clock uses", async () => {
  const fast = await runner({ init: "set-rate-70" }, 60);
  assertEquals(fast.start(), "continue");
  assertEquals(fast.state.framesPerSecond, 70);
  const stamps: number[] = [];
  for (let i = 0; i < 3; i++) {
    fast.step();
    stamps.push(Number(fast.state.nowMs));
  }
  assertEquals(stamps, [15, 29, 43]);
});

Deno.test("a run that presented nothing reports the empty hash", async () => {
  const run = await runner({}, 35);
  run.start();
  run.step();
  assertEquals(
    run.traceLine(),
    `frame=1 hash=cbf29ce484222325 game-memory=65536 platform-memory=65536 ` +
      `audio=cbf29ce484222325 played=0`,
  );
  assertEquals(
    run.summaryLine(0),
    `summary frames=1 presents=0 width=0 height=0 hash=cbf29ce484222325 ` +
      `game-memory=65536 platform-memory=65536 audio=cbf29ce484222325 played=0 exit=0`,
  );
});

Deno.test("a game that asks to stop stops", async () => {
  const run = await runner({ frame: "stop" });
  assertEquals(run.start(), "continue");
  assertEquals(run.step(), "stopped");
  assertEquals(run.state.frames, 1);
});

Deno.test("a guest that exits is not a trap", async () => {
  const run = await runner({ frame: "exit7" });
  assertEquals(run.start(), "continue");
  assertEquals(run.step(), "exit");
  assertEquals(run.state.exitRequested, true);
  assertEquals(run.state.exitCode, 7);
  assertEquals(run.trapMessage, null);
  assertEquals(run.step(), "exit", "a finished instance is never called again");
});

Deno.test("a guest that traps says why, once", async () => {
  const counter = new Counter();
  const run = await runner({ frame: "trap" }, 60, counter);
  assertEquals(run.start(), "continue");
  assertEquals(run.step(), "trap");
  assert(run.trapMessage !== null, "a trap has a message");
  assert(run.trapMessage.length > 0, "a trap has a message");
  assertEquals(run.state.exitRequested, false);
  // The frame that trapped never played its period.
  assertEquals(counter.chunks, 0);
  assertEquals(counter.silent, 0);
  assertEquals(run.state.audio.played, 0);
  assertEquals(run.step(), "trap");
});

Deno.test("a frame that continues plays its period", async () => {
  const counter = new Counter();
  const run = await runner({}, 60, counter);
  run.start();
  run.step();
  run.step();
  assertEquals(counter.chunks, 2);
  assertEquals(counter.silent, Math.floor((2 * 44100) / 60));
});

Deno.test("frame-zero events are delivered before init", async () => {
  const run = await runner({}, 35);
  run.setScript(parseScript(new TextEncoder().encode("0 a down\n2 a up\n")));
  run.start();
  assertEquals(run.state.input.takeEvents().length, 1);
  run.step();
  assertEquals(run.state.input.takeEvents().length, 0);
  run.step();
  assertEquals(run.state.input.takeEvents().length, 1);
});
