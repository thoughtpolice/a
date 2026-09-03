// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser host: a page that runs a packaged console application.
 *
 * Everything a run is a function of -- the fixed frame clock, the input queue,
 * the virtual root, the audio queue -- is the same code the headless runner
 * uses. What is here is only what a browser adds: fetching the package,
 * a gesture before audio may start, the animation frame that paces the loop,
 * the keyboard and pointer, and the two renderers.
 */

import { AudioSink } from "./audio.ts";
import { Canvas2dRenderer } from "./canvas2d.ts";
import { CODE_TO_KEY } from "./keys.ts";
import { fit, Renderer } from "./render.ts";
import { GpuRenderer } from "./gpu.ts";
import { Identity, Sinks } from "./hal.ts";
import { IndexedDbMirror } from "./storage.ts";
import { Manifest, parseManifest } from "./manifest.ts";
import { Outcome, Runner } from "./runner.ts";

/** A backlog past this is dropped rather than made up, as the native host drops one. */
const MAX_LAG_MS = 250;
/** The most frames one animation frame may run, so a stall cannot lock the page. */
const MAX_CATCH_UP = 10;
const LOG_LINES = 200;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
}

class Page {
  readonly canvas = element<HTMLCanvasElement>("screen");
  readonly overlay = element<HTMLDivElement>("overlay");
  readonly overlayTitle = element<HTMLDivElement>("overlay-title");
  readonly overlayMessage = element<HTMLDivElement>("overlay-message");
  readonly start = element<HTMLButtonElement>("start");
  readonly status = element<HTMLDivElement>("status");
  readonly log = element<HTMLPreElement>("log");
  readonly logToggle = element<HTMLButtonElement>("log-toggle");
  private readonly lines: string[] = [];

  say(title: string, message: string, action: string | null): void {
    this.overlayTitle.textContent = title;
    this.overlayMessage.textContent = message;
    this.start.hidden = action === null;
    if (action !== null) this.start.textContent = action;
    this.overlay.hidden = false;
  }

  hideOverlay(): void {
    this.overlay.hidden = true;
  }

  write(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_LINES) this.lines.shift();
    this.log.textContent = this.lines.join("\n");
    this.log.scrollTop = this.log.scrollHeight;
  }

  tail(count: number): string {
    return this.lines.slice(-count).join("\n");
  }
}

interface Options {
  manifest: string;
  renderer: "webgpu" | "canvas2d" | "auto";
  save: boolean;
  autostart: boolean;
  args: string[] | null;
}

function options(): Options {
  const params = new URLSearchParams(globalThis.location.search);
  const renderer = params.get("renderer");
  const args = params.getAll("arg");
  return {
    manifest: params.get("manifest") ?? "./manifest.json",
    renderer: renderer === "webgpu" || renderer === "canvas2d" ? renderer : "auto",
    save: !params.has("nosave"),
    autostart: params.has("autostart"),
    args: args.length > 0 ? args : null,
  };
}

/** Fetches a file, reporting how far it has come when the size is known. */
async function fetchBytes(
  url: string,
  progress: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function bytesLabel(loaded: number, total: number): string {
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return total > 0 ? `${mb(loaded)} of ${mb(total)}` : mb(loaded);
}

async function boot(): Promise<void> {
  const page = new Page();
  const config = options();
  page.logToggle.addEventListener("click", () => {
    page.log.hidden = !page.log.hidden;
  });

  let manifest: Manifest;
  try {
    const response = await fetch(config.manifest);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    manifest = parseManifest(await response.json());
  } catch (error) {
    page.say("Cannot start", `${config.manifest}: ${describe(error)}`, null);
    return;
  }
  document.title = manifest.title;
  page.say(manifest.title, "Loading…", null);

  const base = new URL(config.manifest, globalThis.location.href);
  const url = (file: string) => new URL(file, base).href;

  let mounts: [string, Uint8Array][];
  let moduleBytes: Uint8Array;
  try {
    // Streaming compilation would save a copy, but the page also wants to show
    // how far the download has come, which needs the body read here.
    moduleBytes = await fetchBytes(url(manifest.module), (loaded, total) => {
      page.say(manifest.title, `Loading the game… ${bytesLabel(loaded, total)}`, null);
    });
    mounts = [];
    for (const mount of manifest.mounts) {
      const bytes = await fetchBytes(url(mount.file), (loaded, total) => {
        page.say(manifest.title, `Loading ${mount.path}… ${bytesLabel(loaded, total)}`, null);
      });
      mounts.push([mount.path, bytes]);
    }
  } catch (error) {
    page.say("Cannot start", describe(error), null);
    return;
  }

  let node: AudioWorkletNode | null = null;
  const audio: Audio = {
    clear: () => node?.port.postMessage({ type: "clear" }),
    underruns: 0,
  };
  const audioSink: AudioSink = {
    chunk(samples) {
      if (!node || samples.length === 0) return;
      node.port.postMessage(samples.buffer, [samples.buffer]);
    },
    silence() {
      // The device fills a gap with silence of its own; sending it would only
      // make the buffer drift.
    },
  };

  const mirror = config.save ? await IndexedDbMirror.open(manifest.name) : null;
  let wantsLock = false;

  const identity: Identity = {
    name: "web",
    unixSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
    randomSeed: () => crypto.getRandomValues(new BigUint64Array(1))[0],
    features: () => (mirror ? 1 : 0),
    capabilities: () => (canLockPointer() ? 7 | 8 : 7),
  };
  const sinks: Sinks = {
    log: (level, text) => page.write(`log ${level}: ${text}`),
    setTitle: (text) => {
      document.title = text || manifest.title;
    },
    capturePointer: (captured) => {
      wantsLock = captured;
      if (captured) requestLock();
      else if (document.pointerLockElement === page.canvas) document.exitPointerLock();
      return document.pointerLockElement === page.canvas ? 1 : 0;
    },
  };

  function canLockPointer(): boolean {
    return typeof page.canvas.requestPointerLock === "function";
  }

  function requestLock(): void {
    if (!wantsLock || document.pointerLockElement === page.canvas) return;
    try {
      const result = page.canvas.requestPointerLock() as unknown;
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // A lock needs a recent gesture; the next pointerdown tries again.
    }
  }

  let runner: Runner;
  try {
    runner = await Runner.instantiate(moduleBytes, {
      framesPerSecond: manifest.framesPerSecond,
      identity,
      sinks,
      audioSink,
    });
  } catch (error) {
    page.say(
      "Cannot start",
      `${describe(error)}\n\nThis package needs a browser with multi-memory WebAssembly: ` +
        `Chrome 120, Firefox 125, Safari 18 or newer.`,
      null,
    );
    return;
  }

  for (const [path, bytes] of mounts) {
    if (!runner.state.vfs.mountReadonly(path, bytes)) {
      page.say("Cannot start", `${path} cannot be mounted`, null);
      return;
    }
  }
  if (mirror) {
    runner.state.vfs.setMirror(mirror);
    await mirror.load(runner.state.vfs, (message) => page.write(message));
  }
  runner.state.args = [manifest.name, ...(config.args ?? manifest.args)];

  const renderers = new Renderers(page.canvas, config.renderer, (message) => page.write(message));
  await renderers.prepare();

  attachInput(page, runner, () => renderers.display(runner), requestLock, () => wantsLock);

  page.say(manifest.title, "Sound and the keyboard need a click to start.", "Click to start");
  // A run may only be started once: `autostart` skips the gesture, and the
  // button is still there for the click that an autostarted page needs before
  // audio may play.
  let started = false;
  const begin = () => {
    if (!started) {
      started = true;
      page.hideOverlay();
      run(page, runner, renderers, manifest, mirror, audio);
    }
    page.canvas.focus();
    if (!node) void startAudio();
  };
  page.start.addEventListener("click", begin);
  if (config.autostart) begin();

  async function startAudio(): Promise<void> {
    try {
      const context = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
      await context.audioWorklet.addModule(new URL("worklet.js", import.meta.url));
      node = new AudioWorkletNode(context, "console-sink", { outputChannelCount: [2] });
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "stats") audio.underruns = event.data.underruns ?? 0;
      };
      node.port.postMessage({
        type: "config",
        prime: Math.ceil((2 * 44100) / runner.state.framesPerSecond),
      });
      node.connect(context.destination);
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      page.write(`audio unavailable: ${describe(error)}`);
      node = null;
    }
  }
}

/** The audio device, as the frame loop needs to see it. */
interface Audio {
  clear(): void;
  underruns: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The renderer in use, and the fallback when the preferred one gives up. */
class Renderers {
  private readonly canvas: HTMLCanvasElement;
  private readonly preferred: "webgpu" | "canvas2d" | "auto";
  private readonly warn: (message: string) => void;
  private renderer: Renderer | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    preferred: "webgpu" | "canvas2d" | "auto",
    warn: (message: string) => void,
  ) {
    this.canvas = canvas;
    this.preferred = preferred;
    this.warn = warn;
  }

  async prepare(): Promise<void> {
    if (this.preferred !== "canvas2d") {
      const gpu = await GpuRenderer.create(this.canvas, (reason) => {
        this.warn(`WebGPU stopped: ${reason}`);
        this.fallBack();
      });
      if (gpu) {
        this.renderer = gpu;
        return;
      }
      if (this.preferred === "webgpu") this.warn("WebGPU is unavailable; drawing with canvas 2D");
    }
    this.fallBack();
  }

  private fallBack(): void {
    const fallback = Canvas2dRenderer.create(this.canvas);
    if (!fallback) {
      this.warn("this browser has neither WebGPU nor a 2D canvas");
      return;
    }
    this.renderer = fallback;
  }

  display(runner: Runner) {
    return fit(
      { width: runner.state.width, height: runner.state.height },
      { width: this.canvas.width, height: this.canvas.height },
      this.aspect,
    );
  }

  aspect: "4:3" | "frame" = "4:3";

  update(width: number, height: number, rgba: Uint8Array): void {
    this.renderer?.update({ width, height, rgba });
  }

  draw(runner: Runner): void {
    this.renderer?.draw(this.display(runner));
  }

  resize(width: number, height: number): void {
    this.renderer?.resize(width, height);
  }
}

function attachInput(
  page: Page,
  runner: Runner,
  display: () => { x: number; y: number; width: number; height: number },
  requestLock: () => void,
  wantsLock: () => boolean,
): void {
  const held = new Set<string>();
  const input = runner.state.input;
  const canvas = page.canvas;

  canvas.addEventListener("keydown", (event) => {
    if (event.altKey && event.code === "Enter") {
      event.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen();
      else void canvas.requestFullscreen().catch(() => {});
      return;
    }
    const key = CODE_TO_KEY[event.code];
    if (key !== undefined && !event.ctrlKey && !event.metaKey) event.preventDefault();
    if (event.repeat) return;
    if (key !== undefined && !held.has(event.code)) {
      held.add(event.code);
      input.pushKey(key, true);
    }
    // A printable key also types; a modifier combination is a command.
    if (!event.ctrlKey && !event.altKey && !event.metaKey && [...event.key].length === 1) {
      const code = event.key.codePointAt(0) ?? 0;
      if (code >= 0x20 && code !== 0x7f) input.typeText(new TextEncoder().encode(event.key));
    }
  });

  canvas.addEventListener("keyup", (event) => {
    const key = CODE_TO_KEY[event.code];
    if (key !== undefined && held.delete(event.code)) input.pushKey(key, false);
  });

  canvas.addEventListener("blur", () => {
    held.clear();
    input.releaseAll();
  });

  const toFrame = (event: PointerEvent | MouseEvent): [number, number] | null => {
    const box = canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const target = display();
    if (target.width === 0 || target.height === 0) return null;
    const scale = canvas.width / box.width;
    const x = (event.clientX - box.left) * scale - target.x;
    const y = (event.clientY - box.top) * scale - target.y;
    const frameX = Math.floor((x / target.width) * runner.state.width);
    const frameY = Math.floor((y / target.height) * runner.state.height);
    return [
      Math.max(0, Math.min(runner.state.width - 1, frameX)),
      Math.max(0, Math.min(runner.state.height - 1, frameY)),
    ];
  };

  canvas.addEventListener("pointermove", (event) => {
    if (document.pointerLockElement === canvas) {
      input.addMotion(event.movementX, event.movementY);
      input.setPosition(
        Math.max(0, Math.min(runner.state.width - 1, input.mouseX + event.movementX)),
        Math.max(0, Math.min(runner.state.height - 1, input.mouseY + event.movementY)),
      );
      return;
    }
    const at = toFrame(event);
    // The HAL's button bits are the DOM's own, so they cross unchanged.
    if (at) input.moveMouse(at[0], at[1], event.buttons & 7, 0);
  });

  const buttons = (event: PointerEvent) => {
    if (document.pointerLockElement === canvas) input.setButtons(event.buttons & 7);
    else {
      const at = toFrame(event);
      if (at) input.moveMouse(at[0], at[1], event.buttons & 7, 0);
      else input.setButtons(event.buttons & 7);
    }
  };

  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    if (wantsLock()) requestLock();
    buttons(event);
  });
  canvas.addEventListener("pointerup", buttons);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    // A notch is what the guest counts, whatever the device reports it in.
    const notches = event.deltaMode === 0
      ? -Math.trunc(event.deltaY / 100) || -Math.sign(event.deltaY)
      : -Math.sign(event.deltaY);
    input.addWheel(notches);
  }, { passive: false });
}

function run(
  page: Page,
  runner: Runner,
  renderers: Renderers,
  manifest: Manifest,
  mirror: IndexedDbMirror | null,
  audio: Audio,
): void {
  renderers.aspect = manifest.aspect;
  const canvas = page.canvas;
  const observer = new ResizeObserver(() => {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      renderers.resize(width, height);
    }
  });
  observer.observe(canvas);

  let running = true;
  let backlog = 0;
  let last = performance.now();
  let drawn = 0;
  let shownAt = last;
  let dropped = 0;

  const finish = (outcome: Outcome) => {
    running = false;
    observer.disconnect();
    runner.state.input.releaseAll();
    runner.state.vfs.flushAll();
    audio.clear();
    const message = outcome === "exit"
      ? `exited with code ${runner.state.exitCode}`
      : outcome === "trap"
      ? `guest trapped: ${runner.trapMessage}\n\n${page.tail(8)}`
      : "game over";
    page.say(manifest.title, message, null);
    const failure = runner.state.vfs.saveError ?? mirror?.error ?? null;
    if (failure !== null) page.write(`saves not written: ${failure}`);
  };

  const start = () => {
    const outcome = runner.start();
    if (outcome !== "continue") {
      finish(outcome);
      return;
    }
    requestAnimationFrame(tick);
  };

  function tick(now: number): void {
    if (!running) return;
    const period = 1000 / runner.state.framesPerSecond;
    backlog += now - last;
    last = now;
    if (backlog > MAX_LAG_MS) {
      dropped += Math.floor(backlog / period);
      backlog = 0;
    }
    let steps = 0;
    while (backlog >= period && steps < MAX_CATCH_UP) {
      backlog -= period;
      steps++;
      const outcome = runner.step();
      if (outcome !== "continue") {
        if (runner.state.frameDirty && runner.state.pixels) {
          renderers.update(runner.state.width, runner.state.height, runner.state.pixels);
          renderers.draw(runner);
        }
        finish(outcome);
        return;
      }
    }
    if (steps === MAX_CATCH_UP && backlog >= period) {
      dropped += Math.floor(backlog / period);
      backlog = 0;
    }
    if (runner.state.frameDirty && runner.state.pixels) {
      runner.state.frameDirty = false;
      renderers.update(runner.state.width, runner.state.height, runner.state.pixels);
      drawn++;
    }
    renderers.draw(runner);
    if (now - shownAt >= 500) {
      const fps = (drawn * 1000) / (now - shownAt);
      page.status.textContent = `${runner.state.frames} frames · ${fps.toFixed(0)} fps · ` +
        `${dropped} dropped · ${runner.state.audio.queued()} audio frames queued · ` +
        `${audio.underruns} underruns`;
      drawn = 0;
      shownAt = now;
    }
    requestAnimationFrame(tick);
  }

  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    if (document.hidden) {
      runner.state.input.releaseAll();
      audio.clear();
    } else {
      last = performance.now();
      backlog = 0;
    }
  });

  globalThis.addEventListener("pagehide", () => {
    runner.state.vfs.flushAll();
  });

  start();
}

boot().catch((error) => {
  const overlay = document.getElementById("overlay-message");
  if (overlay) overlay.textContent = describe(error);
});
