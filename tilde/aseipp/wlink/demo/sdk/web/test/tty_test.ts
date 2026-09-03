// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";
import { keyCode } from "../keys.ts";
import { CellRenderer, decodeInput, TerminalInput } from "../tty.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const keys = (inputs: TerminalInput[]) =>
  inputs.map((input) => input.kind === "key" ? input.key : -1);

Deno.test("letters, digits and punctuation are their keys and their text", () => {
  const inputs = decodeInput(bytes("wA7 -"));
  assertEquals(keys(inputs), [
    keyCode("w"),
    keyCode("a"),
    keyCode("7"),
    keyCode("space"),
    keyCode("minus"),
  ]);
  assertEquals(
    inputs.map((input) => input.kind === "key" ? input.text : null),
    ["w", "A", "7", " ", "-"],
  );
});

Deno.test("control bytes and escape sequences are the keys they stand for", () => {
  assertEquals(keys(decodeInput(bytes("\r\t\x7f"))), [
    keyCode("enter"),
    keyCode("tab"),
    keyCode("backspace"),
  ]);
  assertEquals(keys(decodeInput(bytes("\x1b[A\x1b[B\x1bOC\x1b[1;2D"))), [
    keyCode("up"),
    keyCode("down"),
    keyCode("right"),
    keyCode("left"),
  ]);
  assertEquals(keys(decodeInput(bytes("\x1b[5~\x1b[15~\x1bOP\x1b[Z"))), [
    keyCode("page-up"),
    keyCode("f5"),
    keyCode("f1"),
    keyCode("tab"),
  ]);
  // An escape alone in a read is the key; a cursor report is nothing.
  assertEquals(keys(decodeInput(bytes("\x1b"))), [keyCode("escape")]);
  assertEquals(decodeInput(bytes("\x1b[12;40R")), []);
  assertEquals(decodeInput(bytes("\x03")), [{ kind: "interrupt" }]);
});

Deno.test("SGR mouse reports press, release, move and turn the wheel", () => {
  assertEquals(
    decodeInput(bytes("\x1b[<0;10;5M\x1b[<2;10;5m\x1b[<35;11;6M\x1b[<65;1;1M")),
    [
      {
        kind: "mouse",
        column: 10,
        row: 5,
        button: 1,
        action: "press",
        wheel: 0,
      },
      {
        kind: "mouse",
        column: 10,
        row: 5,
        button: 2,
        action: "release",
        wheel: 0,
      },
      {
        kind: "mouse",
        column: 11,
        row: 6,
        button: 0,
        action: "move",
        wheel: 0,
      },
      {
        kind: "mouse",
        column: 1,
        row: 1,
        button: 0,
        action: "move",
        wheel: -1,
      },
    ],
  );
});

Deno.test("half blocks: centred, scaled, and only what changed is redrawn", () => {
  // A 4x4 frame, left half red and right half blue, into 8 columns by 2 rows:
  // it scales to 4x2 cells, one column in from each side.
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const red = i % 4 < 2;
    rgba.set(red ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  }
  const renderer = new CellRenderer(8, 2);
  const first = renderer.draw(rgba, 4, 4);
  assertEquals([renderer.left, renderer.top, renderer.width, renderer.height], [
    2,
    0,
    4,
    2,
  ]);
  assertEquals(first.split("▀").length - 1, 8);
  assertEquals(
    first.startsWith("\x1b[1;3H\x1b[38;2;255;0;0m\x1b[48;2;255;0;0m▀▀"),
    true,
  );
  assertEquals(renderer.draw(rgba, 4, 4), "");
  rgba.set([0, 255, 0, 255], 0);
  const changed = renderer.draw(rgba, 4, 4);
  assertEquals(changed.split("▀").length - 1, 1);
  assertEquals(renderer.pixelAt(3, 1), { x: 0, y: 0 });
  assertEquals(renderer.pixelAt(6, 2), { x: 3, y: 2 });
});
