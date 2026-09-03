// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "../assert.ts";
import {
  InputState,
  MAX_EVENTS,
  MAX_TEXT,
  parseScript,
  Recorder,
  textBytes,
} from "../input.ts";
import { keyCode } from "../keys.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const DOOM_SCRIPT = `100 w down
130 w up
140 right down
170 right up
180 space down
220 space up
`;

const CONTRACT_SCRIPT =
  "0 a down\n0 a up\n0 pause down\n0 pause up\n0 page-up down\n0 page-up up\n" +
  "0 mouse 5 6 1 0\n0 text hi☃\n";

Deno.test("the scripts the end-to-end suites replay", () => {
  const doom = parseScript(bytes(DOOM_SCRIPT));
  assertEquals(doom.length, 6);
  assertEquals(doom[0], {
    frame: 100,
    kind: "key",
    key: keyCode("w"),
    pressed: true,
  });
  assertEquals(doom[5], {
    frame: 220,
    kind: "key",
    key: keyCode("space"),
    pressed: false,
  });

  const contract = parseScript(bytes(CONTRACT_SCRIPT));
  assertEquals(contract.length, 8);
  assertEquals(contract[6], {
    frame: 0,
    kind: "mouse",
    x: 5,
    y: 6,
    buttons: 1,
    wheel: 0,
  });
  assertEquals(contract[7], { frame: 0, kind: "text", text: bytes("hi☃") });
});

Deno.test("comments and blank lines are skipped", () => {
  const script = parseScript(
    bytes("# a recording\n\n10 a down\n\n#\n20 a up\n"),
  );
  assertEquals(script.length, 2);
  assertEquals(script[1].frame, 20);
});

Deno.test("what a script may not say", () => {
  const refused = [
    "20 a down\n10 a up\n",
    "10 nosuchkey down\n",
    "10 a sideways\n",
    "10 mouse 0 0 8 0\n",
    "10 mouse 0 0 1 0 extra\n",
    "10 a down extra\n",
    "10 text\n",
    "10 text \n",
    "10\n",
    "   \n",
    "a down\n",
    "-1 a down\n",
  ];
  for (const script of refused) {
    assertThrows(() => parseScript(bytes(script)), "expected sorted");
  }
  const invalid = new Uint8Array([
    0x31,
    0x20,
    0x74,
    0x65,
    0x78,
    0x74,
    0x20,
    0xff,
    0x0a,
  ]);
  assertThrows(() => parseScript(invalid), "expected sorted");
});

Deno.test("a text payload keeps its spaces and loses its line ending", () => {
  const script = parseScript(bytes("5 text  two  spaces \r\n"));
  assertEquals(script.length, 1);
  assertEquals(script[0], {
    frame: 5,
    kind: "text",
    text: bytes(" two  spaces "),
  });
});

Deno.test("the pointer accumulates motion and notches until it is read", () => {
  const input = new InputState();
  input.moveMouse(10, 20, 0, 0);
  assertEquals(input.readMouse(), {
    x: 10,
    y: 20,
    dx: 0,
    dy: 0,
    buttons: 0,
    wheel: 0,
  });
  input.moveMouse(13, 24, 1, -1);
  input.moveMouse(15, 24, 1, -1);
  assertEquals(input.readMouse(), {
    x: 15,
    y: 24,
    dx: 5,
    dy: 4,
    buttons: 1,
    wheel: -2,
  });
  assertEquals(input.readMouse(), {
    x: 15,
    y: 24,
    dx: 0,
    dy: 0,
    buttons: 1,
    wheel: 0,
  });
  input.addMotion(-3, 7);
  assertEquals(input.readMouse(), {
    x: 15,
    y: 24,
    dx: -3,
    dy: 7,
    buttons: 1,
    wheel: 0,
  });
});

Deno.test("a frame's recording reports only what changed in it", () => {
  const input = new InputState();
  input.beginFrame();
  input.moveMouse(4, 4, 0, 0);
  assertEquals(input.mouseChanged, true);
  input.beginFrame();
  input.moveMouse(4, 4, 0, 0);
  assertEquals(input.mouseChanged, false);
  input.beginFrame();
  input.moveMouse(4, 4, 0, 2);
  assertEquals(input.mouseChanged, true);
  assertEquals(input.frameWheel, 2);
});

Deno.test("the event queue holds a frame's worth and the rest arrive next frame", () => {
  const script = parseScript(
    bytes(Array.from({ length: 300 }, () => "0 a down").join("\n") + "\n"),
  );
  const input = new InputState();
  input.beginFrame();
  let cursor = input.deliverScript(script, 0, 0);
  assertEquals(cursor, MAX_EVENTS);
  assertEquals(input.takeEvents().length, MAX_EVENTS);
  input.beginFrame();
  cursor = input.deliverScript(script, cursor, 1);
  assertEquals(cursor, 300);
  assertEquals(input.takeEvents().length, 300 - MAX_EVENTS);
});

Deno.test("text that does not fit is dropped whole", () => {
  const input = new InputState();
  input.typeText(new Uint8Array(MAX_TEXT - 2).fill(0x61));
  input.typeText(textBytes("abc"));
  assertEquals(input.takeText().length, MAX_TEXT - 2);
  input.typeText(textBytes("ab"));
  assertEquals(input.takeText().length, 2);
});

Deno.test("losing the keyboard releases every key that was held", () => {
  const input = new InputState();
  input.pushKey(keyCode("w"), true);
  input.pushKey(keyCode("a"), true);
  input.pushKey(keyCode("w"), false);
  input.takeEvents();
  input.releaseAll();
  assertEquals(input.takeEvents(), [{ key: keyCode("a"), pressed: false }]);
  input.releaseAll();
  assertEquals(input.takeEvents(), []);
});

Deno.test("a recording replays as the same script", () => {
  const script = parseScript(
    bytes(CONTRACT_SCRIPT + "3 mouse 9 9 0 -1\n4 text  hi\n"),
  );
  const lines: string[] = [];
  const input = new InputState();
  const recorder = new Recorder("contract", (line) => lines.push(line));
  let cursor = 0;
  for (let frame = 0; frame <= 5; frame++) {
    input.beginFrame();
    cursor = input.deliverScript(script, cursor, frame);
    recorder.frame(frame, input);
    input.takeEvents();
    input.takeText();
    input.readMouse();
  }
  const recorded = lines.join("");
  assertEquals(recorded.startsWith("# contract input recording\n"), true);
  assertEquals(
    parseScript(bytes(recorded.split("\n").slice(1).join("\n"))),
    script,
  );
});
