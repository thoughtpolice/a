// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A headless runner for a packaged console application, with the options and
 * the output of the SDK's native runner.
 *
 * There is no terminal mode here: a browser is the interactive host, and this
 * exists so the same package can be replayed, traced and compared with the
 * native runner frame by frame. Everything it reports -- the log lines, the
 * `frame=` traces, the summary, the PPM capture, the WAV track and the save
 * directory -- is what `sdk/host/host.c` reports for the same inputs.
 */

import { AudioSink } from "./audio.ts";
import { DirectoryMirror } from "./mirror_dir.ts";
import { Identity, Sinks } from "./hal.ts";
import { Manifest, parseManifest } from "./manifest.ts";
import { parseScript, Recorder, ScriptEvent } from "./input.ts";
import { ppm, SeekableOutput, WavWriter } from "./dump.ts";
import { Runner } from "./runner.ts";

const encoder = new TextEncoder();

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `usage: console-web --package DIR [--MOUNT-OPTION PATH]
       [--module PATH] [--name NAME] [--frames-per-second N] [--mount PATH=FILE]
       --headless --frames N [--script PATH] [--record PATH] [--trace]
       [--dump-frame PATH] [--dump-audio PATH] [--no-audio] [--renderer NAME]
       [--save-dir PATH | --no-save] [--seed N] [--unix-time N]
       [-- GUEST_ARGS...]
A package is a directory built by console_web: a manifest, the linked module,
and the application's mounted assets. --module replaces the module inside it,
which is how a test build is run against a production package. Scripts contain
sorted 'frame key down|up', 'frame mouse x y buttons wheel', and 'frame text
...' lines; --record writes one from the input the application receives, and
replaying it repeats the run. Files the application writes last for the session
unless --save-dir names a directory. --seed is the entropy the run reports and
--unix-time its wall clock, both zero unless given.
`;

interface Options {
  packageDir: string | null;
  module: string | null;
  name: string | null;
  framesPerSecond: number | null;
  mounts: Map<string, string>;
  assetOverrides: Map<string, string>;
  headless: boolean;
  trace: boolean;
  noSave: boolean;
  limit: number;
  script: string | null;
  record: string | null;
  capture: string | null;
  wav: string | null;
  saveDir: string | null;
  seed: bigint;
  unixTime: bigint;
  args: string[];
}

class UsageError extends Error {}

/** A failure whose message is already what the runner should print. */
class RunError extends Error {}

function parseCount(value: string, message: string): number {
  if (!/^\d+$/.test(value)) throw new RunError(message);
  return Number(value);
}

function parseUnsigned(value: string, option: string): bigint {
  if (!/^\d+$/.test(value)) throw new RunError(`invalid ${option}`);
  return BigInt.asUintN(64, BigInt(value));
}

function splitMount(value: string): [string, string] {
  const at = value.indexOf("=");
  if (at <= 0) throw new RunError("expected --mount PATH=FILE");
  return [value.slice(0, at), value.slice(at + 1)];
}

function parseArguments(
  argv: string[],
  manifestOption: string | null,
): Options {
  const options: Options = {
    packageDir: null,
    module: null,
    name: null,
    framesPerSecond: null,
    mounts: new Map(),
    assetOverrides: new Map(),
    headless: false,
    trace: false,
    noSave: false,
    limit: 0,
    script: null,
    record: null,
    capture: null,
    wav: null,
    saveDir: null,
    seed: 0n,
    unixTime: 0n,
    args: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--") {
      options.args = argv.slice(i + 1);
      break;
    }
    if (option === "--headless") {
      options.headless = true;
      continue;
    }
    if (option === "--trace") {
      options.trace = true;
      continue;
    }
    if (option === "--no-save") {
      options.noSave = true;
      continue;
    }
    if (option === "--no-audio") continue;
    if (i + 1 >= argv.length) throw new UsageError(option);
    const value = argv[++i];
    if (manifestOption !== null && option === `--${manifestOption}`) {
      options.assetOverrides.set(manifestOption, value);
    } else if (option === "--package") options.packageDir = value;
    else if (option === "--module") options.module = value;
    else if (option === "--name") options.name = value;
    else if (option === "--frames-per-second") {
      options.framesPerSecond = parseCount(
        value,
        "invalid --frames-per-second",
      );
    } else if (option === "--mount") {
      const [path, file] = splitMount(value);
      options.mounts.set(path, file);
    } else if (option === "--renderer") continue;
    else if (option === "--script") options.script = value;
    else if (option === "--record") options.record = value;
    else if (option === "--dump-frame") options.capture = value;
    else if (option === "--dump-audio") options.wav = value;
    else if (option === "--save-dir") options.saveDir = value;
    else if (option === "--seed") options.seed = parseUnsigned(value, "--seed");
    else if (option === "--unix-time") {
      options.unixTime = parseUnsigned(value, "--unix-time");
    } else if (option === "--frames") {
      options.limit = parseCount(value, "invalid frame limit");
      if (options.limit === 0 || options.limit > 100000000) {
        throw new RunError("invalid frame limit");
      }
    } else throw new UsageError(option);
  }
  return options;
}

/** The option a package declares, so `--iwad` is known before the rest is parsed. */
function manifestOptionOf(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === "--package" && i + 1 < argv.length) {
      try {
        return readManifest(argv[i + 1]).option;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readManifest(directory: string): Manifest {
  const text = Deno.readTextFileSync(`${directory}/manifest.json`);
  return parseManifest(JSON.parse(text));
}

function defaultManifest(name: string, framesPerSecond: number): Manifest {
  return {
    name,
    title: name,
    module: "",
    framesPerSecond,
    aspect: "4:3",
    option: null,
    args: [],
    mounts: [],
  };
}

/** A file the WAV writer can seek back into. */
function wavOutput(path: string): SeekableOutput {
  const file = Deno.openSync(path, {
    write: true,
    create: true,
    truncate: true,
  });
  return {
    writeSync(bytes: Uint8Array): void {
      let at = 0;
      while (at < bytes.length) at += file.writeSync(bytes.subarray(at));
    },
    seekSync(offset: number): void {
      file.seekSync(offset, Deno.SeekMode.Start);
    },
    close(): void {
      file.close();
    },
  };
}

export async function main(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--help")) {
    io.stdout(USAGE);
    return 0;
  }

  let options: Options;
  try {
    options = parseArguments(argv, manifestOptionOf(argv));
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(USAGE);
      return 1;
    }
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }

  try {
    return await run(options, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(USAGE);
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(options: Options, io: Io): Promise<number> {
  const manifest = options.packageDir !== null
    ? readManifest(options.packageDir)
    : defaultManifest(options.name ?? "game", options.framesPerSecond ?? 60);
  if (options.name !== null) manifest.name = options.name;
  if (options.framesPerSecond !== null) {
    manifest.framesPerSecond = options.framesPerSecond;
  }

  const modulePath = options.module ??
    (options.packageDir !== null
      ? `${options.packageDir}/${manifest.module}`
      : null);
  if (modulePath === null) throw new UsageError("--module");
  if (!options.headless) throw new UsageError("--headless");
  if (options.limit === 0) throw new UsageError("--frames");
  if (options.saveDir !== null && options.noSave) {
    throw new UsageError("--save-dir");
  }

  // Every mount of the package, then what the command line replaced or added.
  const mounts = new Map<string, string>();
  for (const mount of manifest.mounts) {
    mounts.set(mount.path, `${options.packageDir}/${mount.file}`);
  }
  if (manifest.option !== null) {
    const replacement = options.assetOverrides.get(manifest.option);
    if (replacement !== undefined) {
      mounts.set(manifest.mounts[0].path, replacement);
    }
  }
  for (const [path, file] of options.mounts) mounts.set(path, file);

  let script: ScriptEvent[] = [];
  if (options.script !== null) {
    try {
      script = parseScript(Deno.readFileSync(options.script));
    } catch (error) {
      throw new RunError(`${options.script}: ${(error as Error).message}`);
    }
  }

  const identity: Identity = {
    name: "headless",
    unixSeconds: () => options.unixTime,
    randomSeed: () => options.seed,
    features: () => (options.saveDir !== null ? 1 : 0),
    capabilities: () => 7,
  };
  const sinks: Sinks = {
    log: (level, text) => io.stdout(`log ${level}: ${text}\n`),
    setTitle: () => {},
    capturePointer: () => 0,
  };

  const wav = options.wav !== null
    ? new WavWriter(wavOutput(options.wav))
    : null;
  const audioSink: AudioSink = wav === null
    ? { chunk: () => {}, silence: () => {} }
    : {
      chunk: (samples) => wav.samples(samples),
      silence: (frames) => wav.silence(frames),
    };

  const runner = await Runner.instantiate(Deno.readFileSync(modulePath), {
    framesPerSecond: manifest.framesPerSecond,
    identity,
    sinks,
    audioSink,
  });

  for (const [path, file] of mounts) {
    if (!runner.state.vfs.mountReadonly(path, Deno.readFileSync(file))) {
      throw new RunError(`${file}: cannot be mounted at ${path}`);
    }
  }

  let mirror: DirectoryMirror | null = null;
  if (options.saveDir !== null) {
    mirror = DirectoryMirror.create(options.saveDir);
    runner.state.vfs.setMirror(mirror);
    mirror.load(runner.state.vfs, (message) => io.stderr(`${message}\n`));
  }

  const record = options.record !== null
    ? Deno.openSync(options.record, {
      write: true,
      create: true,
      truncate: true,
    })
    : null;
  if (record !== null) {
    runner.setRecorder(
      new Recorder(manifest.name, (line) => {
        record.writeSync(encoder.encode(line));
      }),
    );
  }

  runner.state.args = [
    manifest.name,
    ...(options.args.length > 0 ? options.args : manifest.args),
  ];
  runner.setScript(script);

  let outcome = runner.start();
  if (outcome === "continue") {
    while (runner.state.frames < options.limit) {
      outcome = runner.step();
      if (outcome !== "continue") break;
      if (options.trace) io.stdout(`${runner.traceLine()}\n`);
    }
  }

  runner.state.vfs.flushAll();

  let result = runner.state.exitCode;
  if (record !== null) {
    try {
      record.close();
    } catch (error) {
      io.stderr(`${options.record}: ${(error as Error).message}\n`);
      result = 1;
    }
  }
  if (wav !== null) {
    try {
      wav.close();
    } catch (error) {
      io.stderr(`${options.wav}: ${(error as Error).message}\n`);
      result = 1;
    }
  }
  if (runner.trapMessage !== null && !runner.state.exitRequested) {
    io.stderr(`guest trapped: ${runner.trapMessage}\n`);
    result = 1;
  }
  if (runner.state.vfs.saveError !== null) {
    io.stderr(`saves not written: ${runner.state.vfs.saveError}\n`);
  }
  if (options.capture !== null) {
    if (runner.state.pixels === null) {
      io.stderr("no frame to capture\n");
      result = 1;
    } else {
      try {
        Deno.writeFileSync(
          options.capture,
          ppm(runner.state.width, runner.state.height, runner.state.pixels),
        );
      } catch (error) {
        io.stderr(`${options.capture}: ${(error as Error).message}\n`);
        result = 1;
      }
    }
  }
  io.stdout(`${runner.summaryLine(result)}\n`);
  return ((result % 256) + 256) % 256;
}

function writeAll(
  stream: { writeSync(bytes: Uint8Array): number },
  text: string,
): void {
  const bytes = encoder.encode(text);
  let at = 0;
  while (at < bytes.length) at += stream.writeSync(bytes.subarray(at));
}

if (import.meta.main) {
  // Synchronous writes, so the exit below never truncates what was reported.
  const io: Io = {
    stdout: (text) => writeAll(Deno.stdout, text),
    stderr: (text) => writeAll(Deno.stderr, text),
  };
  Deno.exit(await main(Deno.args, io));
}
