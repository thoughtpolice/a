// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A terminal as a console display and keyboard, for `terminal.ts`: the bytes
 * a terminal sends decoded into keys, text and the pointer, and frames drawn
 * as half-block cells in 24-bit colour, only the cells that changed. Nothing
 * here names a runtime, so the decisions are tested on their own.
 */

import { keyCode } from "./keys.ts";

/** What a terminal's input bytes mean to a console host. */
export type TerminalInput =
  | { kind: "key"; key: number; text: string | null }
  | {
    kind: "mouse";
    column: number;
    row: number;
    /** The SDK's bit for the button (left 1, right 2, middle 4), or 0. */
    button: number;
    action: "press" | "release" | "move";
    wheel: number;
  }
  | { kind: "interrupt" };

const ESC = 0x1b;

// The final bytes of `ESC [ ... X` and `ESC O X` that name keys.
const CSI_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

// `ESC [ n ~`.
const TILDE_KEYS: Readonly<Record<number, string>> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "page-up",
  6: "page-down",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

const PUNCTUATION: Readonly<Record<string, string>> = {
  "-": "minus",
  "_": "minus",
  "=": "equals",
  "+": "equals",
  ",": "comma",
  "<": "comma",
  ".": "period",
  ">": "period",
  "/": "slash",
  "?": "slash",
  ";": "semicolon",
  ":": "semicolon",
  "'": "apostrophe",
  '"': "apostrophe",
  "[": "left-bracket",
  "{": "left-bracket",
  "]": "right-bracket",
  "}": "right-bracket",
  "\\": "backslash",
  "|": "backslash",
  "`": "grave",
  "~": "grave",
};

/** The key a printable character is typed with, or -1. */
export function keyOfCharacter(character: string): number {
  if (character >= "a" && character <= "z") return keyCode(character);
  if (character >= "A" && character <= "Z") {
    return keyCode(character.toLowerCase());
  }
  if (character >= "0" && character <= "9") return keyCode(character);
  if (character === " ") return keyCode("space");
  const name = PUNCTUATION[character];
  return name === undefined ? -1 : keyCode(name);
}

/**
 * Decodes one read's worth of terminal input. An escape byte alone in a read
 * is the Escape key; a sequence is not split across reads by any terminal
 * that matters here, so none is carried over.
 */
export function decodeInput(bytes: Uint8Array): TerminalInput[] {
  const inputs: TerminalInput[] = [];
  const key = (name: string, text: string | null = null) => {
    const code = keyCode(name);
    if (code >= 0) inputs.push({ kind: "key", key: code, text });
  };
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === 0x03) {
      inputs.push({ kind: "interrupt" });
      i++;
    } else if (byte === ESC) {
      if (i + 1 >= bytes.length) {
        key("escape");
        i++;
      } else if (bytes[i + 1] === 0x4f && i + 2 < bytes.length) {
        // `ESC O X`: arrows in application mode, F1 to F4.
        const name = CSI_KEYS[String.fromCharCode(bytes[i + 2])];
        if (name) key(name);
        i += 3;
      } else if (bytes[i + 1] === 0x5b) {
        let end = i + 2;
        while (end < bytes.length && (bytes[end] < 0x40 || bytes[end] > 0x7e)) {
          end++;
        }
        if (end >= bytes.length) {
          i = bytes.length;
          continue;
        }
        const body = String.fromCharCode(...bytes.subarray(i + 2, end));
        const final = String.fromCharCode(bytes[end]);
        if (body.startsWith("<") && (final === "M" || final === "m")) {
          const mouse = decodeMouse(body.slice(1), final === "M");
          if (mouse) inputs.push(mouse);
        } else if (final === "~") {
          const name = TILDE_KEYS[Number(body.split(";")[0])];
          if (name) key(name);
        } else if (final === "Z") {
          key("tab");
        } else if (CSI_KEYS[final] && final !== "R") {
          // (CSI R is a cursor position report, not F3.)
          key(CSI_KEYS[final]);
        }
        i = end + 1;
      } else {
        // Alt with a key: the key.
        key("escape");
        i++;
      }
    } else if (byte === 0x0d || byte === 0x0a) {
      key("enter");
      i++;
    } else if (byte === 0x09) {
      key("tab");
      i++;
    } else if (byte === 0x7f || byte === 0x08) {
      key("backspace");
      i++;
    } else if (byte >= 0x20 && byte < 0x7f) {
      const character = String.fromCharCode(byte);
      const code = keyOfCharacter(character);
      if (code >= 0) inputs.push({ kind: "key", key: code, text: character });
      i++;
    } else {
      i++;
    }
  }
  return inputs;
}

// SGR mouse reports: `button;column;row`, pressed with M and released
// with m. The low bits name the button (0 left, 1 middle, 2 right, 3 none),
// 32 is motion and 64 the wheel.
function decodeMouse(body: string, pressed: boolean): TerminalInput | null {
  const [code, column, row] = body.split(";").map(Number);
  if ([code, column, row].some((value) => !Number.isFinite(value))) return null;
  if (code & 64) {
    return {
      kind: "mouse",
      column,
      row,
      button: 0,
      action: "move",
      wheel: code & 1 ? -1 : 1,
    };
  }
  const which = code & 3;
  const button = which === 0 ? 1 : which === 1 ? 4 : which === 2 ? 2 : 0;
  const action = code & 32 ? "move" : pressed ? "press" : "release";
  return { kind: "mouse", column, row, button, action, wheel: 0 };
}

/**
 * Draws frames into a terminal of a given size as half blocks: each cell is
 * two pixels, the upper as the foreground of `▀` and the lower as its
 * background, sampled nearest-neighbour from the frame scaled to fit and
 * centred. Only the cells that differ from the last drawing are written.
 */
export class CellRenderer {
  readonly columns: number;
  readonly rows: number;
  private upper: Int32Array;
  private lower: Int32Array;
  private frameWidth = 0;
  private frameHeight = 0;
  /** Where the picture sits, in cells, and its size in cells. */
  left = 0;
  top = 0;
  width = 0;
  height = 0;

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.upper = new Int32Array(this.columns * this.rows).fill(-1);
    this.lower = new Int32Array(this.columns * this.rows).fill(-1);
  }

  private layout(frameWidth: number, frameHeight: number): void {
    if (frameWidth === this.frameWidth && frameHeight === this.frameHeight) {
      return;
    }
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    const scale = Math.min(
      this.columns / frameWidth,
      (this.rows * 2) / frameHeight,
    );
    this.width = Math.max(1, Math.floor(frameWidth * scale));
    this.height = Math.max(1, Math.floor((frameHeight * scale) / 2));
    this.left = Math.floor((this.columns - this.width) / 2);
    this.top = Math.floor((this.rows - this.height) / 2);
    this.upper.fill(-1);
    this.lower.fill(-1);
  }

  /** The frame pixel a cell's column and row (1-based, as mouse reports count) show. */
  pixelAt(column: number, row: number): { x: number; y: number } {
    const x = Math.floor(
      ((column - 1 - this.left) * this.frameWidth) / this.width,
    );
    const y = Math.floor(
      ((row - 1 - this.top) * 2 * this.frameHeight) / (this.height * 2),
    );
    return {
      x: Math.min(Math.max(x, 0), this.frameWidth - 1),
      y: Math.min(Math.max(y, 0), this.frameHeight - 1),
    };
  }

  /** The escape sequences that bring the terminal up to date with an RGBA frame. */
  draw(rgba: Uint8Array, frameWidth: number, frameHeight: number): string {
    this.layout(frameWidth, frameHeight);
    const out: string[] = [];
    let cursor = -1;
    let foreground = -1;
    let background = -1;
    const sample = (x: number, y: number): number => {
      const fx = Math.floor((x * frameWidth) / this.width);
      const fy = Math.min(
        frameHeight - 1,
        Math.floor((y * frameHeight) / (this.height * 2)),
      );
      const at = (fy * frameWidth + fx) * 4;
      return (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
    };
    for (let row = 0; row < this.height; row++) {
      for (let column = 0; column < this.width; column++) {
        const up = sample(column, row * 2);
        const down = sample(column, row * 2 + 1);
        const cell = (this.top + row) * this.columns + this.left + column;
        if (this.upper[cell] === up && this.lower[cell] === down) continue;
        this.upper[cell] = up;
        this.lower[cell] = down;
        if (cursor !== cell) {
          out.push(`\x1b[${this.top + row + 1};${this.left + column + 1}H`);
        }
        if (up !== foreground) {
          out.push(`\x1b[38;2;${up >> 16};${(up >> 8) & 0xff};${up & 0xff}m`);
          foreground = up;
        }
        if (down !== background) {
          out.push(
            `\x1b[48;2;${down >> 16};${(down >> 8) & 0xff};${down & 0xff}m`,
          );
          background = down;
        }
        out.push("▀");
        cursor = cell + 1;
      }
    }
    if (out.length > 0) out.push("\x1b[0m");
    return out.join("");
  }
}
