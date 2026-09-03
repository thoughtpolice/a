// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * What the guest reads through the HAL's input functions, and the script
 * format the SDK's runners replay and record.
 */

import { KEY_COUNT, KEY_NAMES, keyCode } from "./keys.ts";

export const MAX_EVENTS = 256;
export const MAX_TEXT = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder();

export interface KeyEvent {
  key: number;
  pressed: boolean;
}

export interface MouseReport {
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: number;
  wheel: number;
}

export type ScriptEvent =
  | { frame: number; kind: "key"; key: number; pressed: boolean }
  | {
    frame: number;
    kind: "mouse";
    x: number;
    y: number;
    buttons: number;
    wheel: number;
  }
  | { frame: number; kind: "text"; text: Uint8Array };

const SCRIPT_ERROR =
  "expected sorted 'frame key down|up', 'frame mouse x y buttons wheel', or 'frame text ...' lines";

/** The pointer and keyboard as the guest reads them. */
export class InputState {
  private events: KeyEvent[] = [];
  private text = new Uint8Array(MAX_TEXT);
  private textLength = 0;
  private held = new Set<number>();

  mouseX = 0;
  mouseY = 0;
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseWheel = 0;
  mouseButtons = 0;
  private mouseSeen = false;

  /** What the recording of the frame being assembled reports. */
  mouseChanged = false;
  frameWheel = 0;
  private frameText = 0;
  private firstEvent = 0;

  /** Starts a frame's input: what follows is what the recording reports. */
  beginFrame(): void {
    this.firstEvent = this.events.length;
    this.mouseChanged = false;
    this.frameWheel = 0;
    this.frameText = 0;
  }

  pushKey(key: number, pressed: boolean): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ key, pressed });
    if (pressed) this.held.add(key);
    else this.held.delete(key);
  }

  /** Places the pointer, as a script's mouse line and a browser's pointer do. */
  moveMouse(x: number, y: number, buttons: number, wheel: number): void {
    if (this.mouseSeen) {
      this.mouseDx += x - this.mouseX;
      this.mouseDy += y - this.mouseY;
    }
    this.mouseChanged = this.mouseChanged || !this.mouseSeen ||
      x !== this.mouseX ||
      y !== this.mouseY || buttons !== this.mouseButtons || wheel !== 0;
    this.mouseSeen = true;
    this.mouseX = x;
    this.mouseY = y;
    this.mouseButtons = buttons;
    this.mouseWheel += wheel;
    this.frameWheel += wheel;
  }

  /**
   * Relative motion with no position of its own, which is what a locked
   * pointer reports; the caller keeps the clamped position.
   */
  addMotion(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.mouseSeen = true;
    this.mouseDx += dx;
    this.mouseDy += dy;
    this.mouseChanged = true;
  }

  setButtons(buttons: number): void {
    if (buttons === this.mouseButtons) return;
    this.mouseSeen = true;
    this.mouseButtons = buttons;
    this.mouseChanged = true;
  }

  setPosition(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  addWheel(notches: number): void {
    if (notches === 0) return;
    this.mouseSeen = true;
    this.mouseWheel += notches;
    this.frameWheel += notches;
    this.mouseChanged = true;
  }

  /** Appends typed text, dropping a chunk that does not fit rather than a part of one. */
  typeText(bytes: Uint8Array): void {
    if (this.textLength + bytes.length > MAX_TEXT) return;
    this.text.set(bytes, this.textLength);
    this.textLength += bytes.length;
    this.frameText += bytes.length;
  }

  /** A release for every key still held, for a window that lost the keyboard. */
  releaseAll(): void {
    for (const key of [...this.held]) this.pushKey(key, false);
    this.held.clear();
  }

  takeEvents(): KeyEvent[] {
    const events = this.events;
    this.events = [];
    this.firstEvent = 0;
    return events;
  }

  takeText(): Uint8Array {
    const text = this.text.slice(0, this.textLength);
    this.textLength = 0;
    return text;
  }

  readMouse(): MouseReport {
    const report: MouseReport = {
      x: this.mouseX,
      y: this.mouseY,
      dx: this.mouseDx,
      dy: this.mouseDy,
      buttons: this.mouseButtons,
      wheel: this.mouseWheel,
    };
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.mouseWheel = 0;
    return report;
  }

  /** The key transitions added since {@link beginFrame}, for the recording. */
  frameEvents(): KeyEvent[] {
    return this.events.slice(this.firstEvent);
  }

  /** The text typed since {@link beginFrame}, for the recording. */
  frameTypedText(): Uint8Array {
    return this.text.slice(this.textLength - this.frameText, this.textLength);
  }

  /**
   * Delivers every scripted event due by `frames` that the queue has room for,
   * returning the new cursor into the script.
   */
  deliverScript(
    script: readonly ScriptEvent[],
    cursor: number,
    frames: number,
  ): number {
    while (
      cursor < script.length && script[cursor].frame <= frames &&
      this.events.length < MAX_EVENTS
    ) {
      const event = script[cursor++];
      if (event.kind === "key") this.pushKey(event.key, event.pressed);
      else if (event.kind === "mouse") {
        this.moveMouse(event.x, event.y, event.buttons, event.wheel);
      } else this.typeText(event.text);
    }
    return cursor;
  }
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

/** The sorted script lines a runner's `--script` option accepts. */
export function parseScript(bytes: Uint8Array): ScriptEvent[] {
  const script: ScriptEvent[] = [];
  let start = 0;
  while (start <= bytes.length) {
    let end = start;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const line = bytes.subarray(start, end);
    const next = end + 1;
    if (line.length === 0 && end >= bytes.length) break;
    start = next;
    if (line.length === 0 || line[0] === 0x23) continue;

    const fields = splitFields(line);
    if (fields.length < 2) throw new Error(SCRIPT_ERROR);
    const frame = parseFrame(fields[0]);
    if (frame === null) throw new Error(SCRIPT_ERROR);
    if (script.length > 0 && frame < script[script.length - 1].frame) {
      throw new Error(SCRIPT_ERROR);
    }
    const kind = token(fields[1]);

    if (kind === "mouse") {
      if (fields.length !== 6) throw new Error(SCRIPT_ERROR);
      const x = parseInteger(fields[2], true);
      const y = parseInteger(fields[3], true);
      const buttons = parseInteger(fields[4], false);
      const wheel = parseInteger(fields[5], true);
      if (
        x === null || y === null || buttons === null || wheel === null ||
        buttons > 7
      ) {
        throw new Error(SCRIPT_ERROR);
      }
      script.push({ frame, kind: "mouse", x, y, buttons, wheel });
    } else if (kind === "text") {
      // The payload is everything after the first "text ", to the end of the
      // line: it may hold spaces, and only its emptiness is an error.
      const at = indexOfText(line);
      const payload = at < 0
        ? new Uint8Array(0)
        : trimEol(line.subarray(at + 5));
      if (payload.length === 0 || !validUtf8(payload)) {
        throw new Error(SCRIPT_ERROR);
      }
      script.push({ frame, kind: "text", text: payload.slice() });
    } else {
      if (fields.length !== 3) throw new Error(SCRIPT_ERROR);
      const key = kind === null ? -1 : keyCode(kind);
      const action = token(fields[2]);
      if (key < 0 || (action !== "down" && action !== "up")) {
        throw new Error(SCRIPT_ERROR);
      }
      script.push({ frame, kind: "key", key, pressed: action === "down" });
    }
  }
  return script;
}

function splitFields(line: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let at = 0;
  while (at < line.length) {
    while (at < line.length && isSpace(line[at])) at++;
    if (at >= line.length) break;
    const from = at;
    while (at < line.length && !isSpace(line[at])) at++;
    fields.push(line.subarray(from, at));
  }
  return fields;
}

/** A field as text, or null when the script holds bytes no name can have. */
function token(field: Uint8Array): string | null {
  try {
    return decoder.decode(field);
  } catch {
    return null;
  }
}

function parseFrame(field: Uint8Array): number | null {
  if (field.length === 0) return null;
  let value = 0;
  for (const byte of field) {
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
  }
  return Number.isSafeInteger(value) ? value : null;
}

function parseInteger(field: Uint8Array, signed: boolean): number | null {
  let at = 0;
  let negative = false;
  if (
    signed && at < field.length && (field[at] === 0x2d || field[at] === 0x2b)
  ) {
    negative = field[at] === 0x2d;
    at++;
  }
  if (at >= field.length) return null;
  let value = 0;
  for (; at < field.length; at++) {
    const byte = field[at];
    if (byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
  }
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

function indexOfText(line: Uint8Array): number {
  const needle = [0x74, 0x65, 0x78, 0x74, 0x20];
  outer: for (let i = 0; i + needle.length <= line.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (line[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function trimEol(payload: Uint8Array): Uint8Array {
  let end = 0;
  while (
    end < payload.length && payload[end] !== 0x0d && payload[end] !== 0x0a
  ) end++;
  return payload.subarray(0, end);
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A recording of everything the application received, in the script format, so
 * replaying it repeats the run.
 */
export class Recorder {
  private readonly sink: (line: string) => void;

  constructor(name: string, sink: (line: string) => void) {
    this.sink = sink;
    this.sink(`# ${name} input recording\n`);
  }

  frame(frames: number, input: InputState): void {
    for (const event of input.frameEvents()) {
      if (event.key >= KEY_COUNT) continue;
      this.sink(
        `${frames} ${KEY_NAMES[event.key]} ${event.pressed ? "down" : "up"}\n`,
      );
    }
    if (input.mouseChanged) {
      this.sink(
        `${frames} mouse ${input.mouseX} ${input.mouseY} ${input.mouseButtons} ${input.frameWheel}\n`,
      );
    }
    const typed = input.frameTypedText();
    if (typed.length > 0) this.sink(`${frames} text ${lossy.decode(typed)}\n`);
  }
}

/** The bytes of a script line's text payload, for tests and browser callers. */
export function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
}
