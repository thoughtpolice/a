// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The keys of `console:sdk/input.key`, by ordinal and by script name. */

/**
 * The script and recording name of every key, in the order of the WIT enum:
 * the named keys, the function keys, the letters, the digits, the punctuation,
 * `pause`, the navigation keys, and the keypad.
 */
export const KEY_NAMES: readonly string[] = [
  "tab",
  "enter",
  "escape",
  "space",
  "backspace",
  "up",
  "down",
  "left",
  "right",
  "shift",
  "control",
  "alt",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "minus",
  "equals",
  "comma",
  "period",
  "slash",
  "semicolon",
  "apostrophe",
  "left-bracket",
  "right-bracket",
  "backslash",
  "grave",
  "pause",
  "insert",
  "delete",
  "home",
  "end",
  "page-up",
  "page-down",
  "caps-lock",
  "kp0",
  "kp1",
  "kp2",
  "kp3",
  "kp4",
  "kp5",
  "kp6",
  "kp7",
  "kp8",
  "kp9",
  "kp-enter",
  "kp-period",
  "kp-plus",
  "kp-minus",
  "kp-multiply",
  "kp-divide",
];

export const KEY_COUNT = KEY_NAMES.length;

const ORDINALS: ReadonlyMap<string, number> = new Map(
  KEY_NAMES.map((name, ordinal) => [name, ordinal]),
);

/** The ordinal of a script key name, or -1 when there is no such key. */
export function keyCode(name: string): number {
  const ordinal = ORDINALS.get(name);
  return ordinal === undefined ? -1 : ordinal;
}

/**
 * `KeyboardEvent.code` values, which name physical keys independently of the
 * layout, mapped to the ordinals above. A left and a right modifier are the
 * same key to the SDK, as they are to the terminal runner.
 */
function codeNames(): Record<string, string> {
  const names: Record<string, string> = {
    Tab: "tab",
    Enter: "enter",
    Escape: "escape",
    Space: "space",
    Backspace: "backspace",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ShiftLeft: "shift",
    ShiftRight: "shift",
    ControlLeft: "control",
    ControlRight: "control",
    AltLeft: "alt",
    AltRight: "alt",
    Minus: "minus",
    Equal: "equals",
    Comma: "comma",
    Period: "period",
    Slash: "slash",
    Semicolon: "semicolon",
    Quote: "apostrophe",
    BracketLeft: "left-bracket",
    BracketRight: "right-bracket",
    Backslash: "backslash",
    Backquote: "grave",
    Pause: "pause",
    Insert: "insert",
    Delete: "delete",
    Home: "home",
    End: "end",
    PageUp: "page-up",
    PageDown: "page-down",
    CapsLock: "caps-lock",
    NumpadEnter: "kp-enter",
    NumpadDecimal: "kp-period",
    NumpadAdd: "kp-plus",
    NumpadSubtract: "kp-minus",
    NumpadMultiply: "kp-multiply",
    NumpadDivide: "kp-divide",
  };
  for (let n = 1; n <= 12; n++) names[`F${n}`] = `f${n}`;
  for (let n = 0; n < 26; n++) {
    const letter = String.fromCharCode(97 + n);
    names[`Key${letter.toUpperCase()}`] = letter;
  }
  for (let n = 0; n <= 9; n++) {
    names[`Digit${n}`] = `${n}`;
    names[`Numpad${n}`] = `kp${n}`;
  }
  return names;
}

export const CODE_TO_KEY: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(codeNames()).map(([code, name]) => [code, keyCode(name)]),
  ),
);
