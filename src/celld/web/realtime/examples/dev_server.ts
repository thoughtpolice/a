// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `celld dev` for a runtime test written in Deno: a private copy of a
 * packaged project with a `.dev.vars`, served on a free loopback port, as
 * the example harness does (which drives only HTTP; WebSockets need a
 * client of their own). The environment is scrubbed of proxies and
 * `CELLD_*`, `AWS_*` and `S3_*` settings.
 *
 * @module
 */

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true, mode: 0o755 });
  for await (const entry of Deno.readDir(from)) {
    const source = `${from}/${entry.name}`;
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) await copyTree(source, target);
    else {
      await Deno.copyFile(source, target);
      // Buck's outputs are read-only; celld keeps its state beside them.
      await Deno.chmod(target, 0o644);
    }
  }
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    if (
      /^(https?|all|no)_proxy$/i.test(name) || /^(CELLD|AWS|S3)_/.test(name)
    ) continue;
    env[name] = value;
  }
  return env;
}

/** A `celld dev` supervisor over a copy of a project. */
export class DevServer {
  readonly origin: string;
  #process: Deno.ChildProcess | null = null;
  #log = "";

  private constructor(
    readonly celld: string,
    readonly directory: string,
    readonly port: number,
  ) {
    this.origin = `http://127.0.0.1:${port}`;
  }

  /** Copies `project`, writes `vars` to `.dev.vars`, and starts serving it. */
  static async start(
    celld: string,
    project: string,
    vars: Record<string, unknown>,
  ): Promise<DevServer> {
    const directory = await Deno.makeTempDir({ prefix: "celld-dev-" });
    await copyTree(project, `${directory}/project`);
    // Each value between single quotes, verbatim: celld reads no escapes.
    const lines = Object.entries(vars).map(([name, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.includes("'") || text.includes("\n")) {
        throw new Error(`${name} cannot be written to .dev.vars`);
      }
      return `${name}='${text}'`;
    });
    await Deno.writeTextFile(
      `${directory}/project/.dev.vars`,
      lines.join("\n") + "\n",
    );
    const server = new DevServer(celld, directory, freePort());
    await server.#spawn();
    return server;
  }

  /** What celld has logged. */
  get log(): string {
    return this.#log;
  }

  async #spawn(): Promise<void> {
    const process = new Deno.Command(this.celld, {
      args: [
        "dev",
        `${this.directory}/project`,
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        "--logs",
        "--no-watch",
      ],
      env: cleanEnvironment(),
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#process = process;
    const decoder = new TextDecoder();
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) this.#log += decoder.decode(chunk);
    };
    drain(process.stdout).catch(() => {});
    drain(process.stderr).catch(() => {});
    const ready = `ready  ${this.origin}`;
    const deadline = Date.now() + 60_000;
    while (!this.#log.includes(ready)) {
      if (Date.now() > deadline) {
        throw new Error(`celld dev did not start:\n${this.#log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Stops and starts again on the same port, keeping the storage. */
  async restart(): Promise<void> {
    await this.#stop();
    this.#log = "";
    await this.#spawn();
  }

  async #stop(): Promise<void> {
    const process = this.#process;
    if (process === null) return;
    this.#process = null;
    try {
      process.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Gone.
      }
    }, 40_000);
    await process.status;
    clearTimeout(timer);
  }

  /** Stops the server and removes its copy. */
  async stop(): Promise<void> {
    await this.#stop();
    await Deno.remove(this.directory, { recursive: true }).catch(() => {});
  }
}
