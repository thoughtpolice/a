// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Plays a linked console application in a terminal, through the same core as
 * the browser and headless hosts: for the modules the native runner cannot
 * translate (wasm2c has no garbage collector, so a gameplayc game is one).
 *
 * Frames are drawn as half-block cells in 24-bit colour, only the cells that
 * changed, and dropped while the terminal is still absorbing earlier ones.
 * Keys come from the terminal's bytes; a terminal reports no releases, so a
 * key is held for a moment after each press and auto-repeat keeps it down, as
 * the native runner does without the kitty protocol. SGR mouse reports place
 * the pointer. Sound goes to the first of `pw-cat`, `aplay`, SoX's `play` or
 * `ffplay` that runs, unless `--no-audio`. Saves persist under
 * `$XDG_DATA_HOME/console/<name>` unless `--save-dir` or `--no-save` says
 * otherwise. `--frames N` runs that many frames without waiting and without a
 * keyboard, which is how a build tests it.
 */

import { AudioSink } from "./audio.ts";
import { DirectoryMirror } from "./mirror_dir.ts";
import { Identity, Sinks } from "./hal.ts";
import { Runner } from "./runner.ts";
import { CellRenderer, decodeInput } from "./tty.ts";

const USAGE =
  `usage: console-terminal --module PATH [--name NAME] [--frames-per-second N]
       [--frames N] [--seed N] [--save-dir PATH | --no-save] [--no-audio]
       [-- GUEST_ARGS...]
`;

// How long a key stays down after a press the terminal reports.
const HOLD_MS = 160;

// A backlog of frames past this is dropped rather than caught up.
const MAX_BACKLOG_MS = 250;

const encoder = new TextEncoder();

interface Options {
  module: string;
  name: string;
  framesPerSecond: number;
  frames: number | null;
  seed: bigint | null;
  saveDir: string | null;
  noSave: boolean;
  audio: boolean;
  args: string[];
}

function parse(argv: string[]): Options | null {
  const options: Options = {
    module: "",
    name: "game",
    framesPerSecond: 60,
    frames: null,
    seed: null,
    saveDir: null,
    noSave: false,
    audio: true,
    args: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--") {
      options.args = argv.slice(i + 1);
      break;
    }
    if (option === "--no-save") {
      options.noSave = true;
      continue;
    }
    if (option === "--no-audio") {
      options.audio = false;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return null;
    if (option === "--module") options.module = value;
    else if (option === "--name") options.name = value;
    else if (option === "--frames-per-second") {
      options.framesPerSecond = Number(value);
    } else if (option === "--frames") options.frames = Number(value);
    else if (option === "--seed") options.seed = BigInt(value);
    else if (option === "--save-dir") options.saveDir = value;
    else return null;
  }
  const valid = options.module !== "" &&
    Number.isInteger(options.framesPerSecond) && options.framesPerSecond > 0 &&
    (options.frames === null ||
      (Number.isInteger(options.frames) && options.frames > 0)) &&
    !(options.saveDir !== null && options.noSave);
  return valid ? options : null;
}

function writeAll(bytes: Uint8Array): void {
  let at = 0;
  while (at < bytes.length) at += Deno.stdout.writeSync(bytes.subarray(at));
}

// The first sound player that starts, fed raw interleaved 16-bit stereo.
function player(): AudioSink & { close(): void } {
  const candidates: [string, string[]][] = [
    ["pw-cat", [
      "--playback",
      "--format",
      "s16",
      "--rate",
      "44100",
      "--channels",
      "2",
      "-",
    ]],
    ["aplay", ["-q", "-f", "S16_LE", "-r", "44100", "-c", "2"]],
    ["play", [
      "-q",
      "-t",
      "raw",
      "-e",
      "signed",
      "-b",
      "16",
      "-r",
      "44100",
      "-c",
      "2",
      "-",
    ]],
    ["ffplay", [
      "-loglevel",
      "quiet",
      "-nodisp",
      "-f",
      "s16le",
      "-ar",
      "44100",
      "-ch_layout",
      "stereo",
      "-",
    ]],
  ];
  for (const [command, args] of candidates) {
    try {
      const child = new Deno.Command(command, {
        args,
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const writer = child.stdin.getWriter();
      let pending = 0;
      const send = (bytes: Uint8Array) => {
        // A player that falls behind loses sound, never the frame loop.
        if (pending > 8) return;
        pending++;
        writer.write(bytes).then(() => pending--, () => pending--);
      };
      return {
        chunk(samples: Int16Array): void {
          send(
            new Uint8Array(
              samples.buffer,
              samples.byteOffset,
              samples.byteLength,
            ).slice(),
          );
        },
        silence(frames: number): void {
          if (frames > 0) send(new Uint8Array(frames * 4));
        },
        close(): void {
          writer.close().catch(() => {});
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        },
      };
    } catch {
      // Not installed: the next.
    }
  }
  return { chunk(): void {}, silence(): void {}, close(): void {} };
}

function saveDirectory(options: Options): string | null {
  if (options.noSave) return null;
  if (options.saveDir !== null) return options.saveDir;
  const data = Deno.env.get("XDG_DATA_HOME") ??
    `${Deno.env.get("HOME") ?? "."}/.local/share`;
  return `${data}/console/${options.name}`;
}

export async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (options === null) {
    Deno.stderr.writeSync(encoder.encode(USAGE));
    return 1;
  }

  const interactive = options.frames === null && Deno.stdin.isTerminal();
  const logs: string[] = [];
  const saves = saveDirectory(options);
  const seed = options.seed ??
    BigInt(crypto.getRandomValues(new Uint32Array(1))[0]);
  const identity: Identity = {
    name: "terminal",
    unixSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
    randomSeed: () => seed,
    features: () => (saves !== null ? 1 : 0),
    // Text and the mouse; no real key releases.
    capabilities: () => 6,
  };
  const sinks: Sinks = {
    log: (_level, text) => {
      logs.push(text);
      if (logs.length > 200) logs.shift();
      if (!interactive) Deno.stderr.writeSync(encoder.encode(`log: ${text}\n`));
    },
    setTitle: (text) => {
      if (interactive) writeAll(encoder.encode(`\x1b]2;${text}\x07`));
    },
    capturePointer: () => 0,
  };
  const audio = options.audio && interactive ? player() : null;
  const runner = await Runner.instantiate(Deno.readFileSync(options.module), {
    framesPerSecond: options.framesPerSecond,
    identity,
    sinks,
    audioSink: audio ?? undefined,
  });
  if (saves !== null) {
    const mirror = DirectoryMirror.create(saves);
    runner.state.vfs.setMirror(mirror);
    mirror.load(runner.state.vfs, (message) => logs.push(message));
  }
  runner.state.args = [options.name, ...options.args];

  const size = interactive ? Deno.consoleSize() : { columns: 80, rows: 25 };
  const renderer = new CellRenderer(size.columns, size.rows - 1);
  const held = new Map<number, number>();
  let buttons = 0;
  let quit = false;

  const leave = () => {
    if (!interactive) return;
    writeAll(
      encoder.encode("\x1b[?1006l\x1b[?1003l\x1b[0m\x1b[?25h\x1b[?1049l"),
    );
    Deno.stdin.setRaw(false);
  };
  if (interactive) {
    Deno.stdin.setRaw(true);
    writeAll(
      encoder.encode("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h"),
    );
    (async () => {
      const buffer = new Uint8Array(4096);
      while (!quit) {
        const count = await Deno.stdin.read(buffer);
        if (count === null) break;
        for (const input of decodeInput(buffer.subarray(0, count))) {
          if (input.kind === "interrupt") {
            quit = true;
          } else if (input.kind === "key") {
            if (!held.has(input.key)) {
              runner.state.input.pushKey(input.key, true);
            }
            held.set(input.key, performance.now() + HOLD_MS);
            if (input.text !== null) {
              runner.state.input.typeText(encoder.encode(input.text));
            }
          } else {
            const { x, y } = renderer.pixelAt(input.column, input.row);
            if (input.action === "press") buttons |= input.button;
            if (input.action === "release") buttons &= ~input.button;
            runner.state.input.moveMouse(x, y, buttons, input.wheel);
          }
        }
      }
    })();
  }

  let outcome = runner.start();
  const period = 1000 / options.framesPerSecond;
  let next = performance.now();
  let writing: Promise<unknown> | null = null;
  let shown = "";
  try {
    while (outcome === "continue" && !quit) {
      if (options.frames !== null && runner.state.frames >= options.frames) {
        break;
      }
      if (interactive) {
        const now = performance.now();
        if (now < next) {
          await new Promise((resolve) => setTimeout(resolve, next - now));
          continue;
        }
        if (now - next > MAX_BACKLOG_MS) next = now;
        next += period;
        for (const [key, until] of held) {
          if (now >= until) {
            held.delete(key);
            runner.state.input.pushKey(key, false);
          }
        }
      }
      outcome = runner.step();
      const pixels = runner.state.pixels;
      if (
        pixels === null ||
        (options.frames !== null && runner.state.frames % 10 !== 0)
      ) continue;
      if (writing !== null) continue;
      let text = renderer.draw(pixels, runner.state.width, runner.state.height);
      // The last log line below the picture, when it changes.
      const status = (logs[logs.length - 1] ?? "").slice(
        0,
        renderer.columns - 1,
      );
      if (status !== shown) {
        text += `\x1b[${renderer.rows + 1};1H\x1b[0m\x1b[2K${status}`;
        shown = status;
      }
      if (interactive) {
        writing = Deno.stdout.write(encoder.encode(text)).then(
          () => (writing = null),
        );
      } else {
        writeAll(encoder.encode(text + "\n"));
      }
    }
  } finally {
    await writing;
    leave();
    audio?.close();
    runner.state.vfs.flushAll();
  }

  if (runner.trapMessage !== null && !runner.state.exitRequested) {
    Deno.stderr.writeSync(
      encoder.encode(`guest trapped: ${runner.trapMessage}\n`),
    );
    for (const line of logs.slice(-10)) {
      Deno.stderr.writeSync(encoder.encode(`log: ${line}\n`));
    }
    return 1;
  }
  return runner.state.exitCode;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
