// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles for code that uses `@celld/api/exedev`, with no network and no
 * exe.dev account:
 *
 * - {@link FakeExe}: an in-memory lobby behind a `fetch`. It parses the body
 *   with the same shell lexer rules, resolves commands and flags against the
 *   catalog (unknown flags are a 422), checks tokens (exe1 handles it issued,
 *   or exe0 tokens signed by keys you register) and their `cmds` (403), and
 *   keeps VM state across calls: `new`, `ls`, `rm`, `rename`, `tag`, `cp`,
 *   `resize`, `comment`, `share`, `integrations`, `ssh-key`, `domain`,
 *   `exe0-to-exe1`, `ssh` (through a handler you supply) and more. Faults can
 *   be injected, including "the command ran but the answer was lost".
 * - {@link fakeFetch} and {@link jsonResponse}: a recording `fetch` and
 *   its answers.
 * - `virtualRuntime` and `fakeStep`, re-exported from `@celld/http/testing`:
 *   a clock that sleeps instantly, and a Workflow step runner with replay
 *   for testing Workflow code in plain Deno tests.
 *
 * The fake's JSON is its own reading of the docs: `ls` and `new` answer with
 * the documented fields; other commands answer with small objects of this
 * module's choosing. Code that must not depend on undocumented shapes should
 * not assert on those.
 *
 * @module
 */

import { COMMANDS, resolveCommand } from "./catalog.ts";
import { MAX_BODY_BYTES } from "./command.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { splitCommandLine } from "./quote.ts";
import type { FetchLike } from "./runtime.ts";
import {
  fingerprint,
  parsePublicKeyLine,
  type SshPublicKey,
} from "./sshsig.ts";
import {
  API_NAMESPACE,
  cmdsAllow,
  type Permissions,
  verifyExe0,
  vmNamespace,
} from "./tokens.ts";
import { REGIONS } from "./validate.ts";

export {
  type FakeStep,
  fakeStep,
  type VirtualRuntime,
  virtualRuntime,
} from "@celld/http/testing";

/** A JSON response with the given status and headers. */
export function jsonResponse(
  body: unknown,
  init: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** One request a {@link fakeFetch} received. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The body as text, or undefined for none. */
  readonly body: string | undefined;
  readonly signal: AbortSignal | null;
}

/** A `fetch` that answers from a handler and records every request. */
export type FakeFetch = FetchLike & { readonly calls: RecordedRequest[] };

/**
 * A `fetch` that hands each request to `handler` with its zero-based index.
 * Throwing from the handler fakes a connection failure.
 */
export function fakeFetch(
  handler: (
    request: RecordedRequest,
    index: number,
  ) => Response | Promise<Response>,
): FakeFetch {
  const calls: RecordedRequest[] = [];
  const fake = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    // The clients pass a URL string and an init; a Request's own body is
    // not read, only its URL, method and headers.
    const from = input instanceof Request ? input : undefined;
    const request: RecordedRequest = {
      url: from?.url ?? String(input),
      method: init.method ?? from?.method ?? "GET",
      headers: new Headers(init.headers ?? from?.headers),
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? null,
    };
    calls.push(request);
    return await handler(request, calls.length - 1);
  };
  return Object.assign(fake, { calls });
}

/** A VM in the fake. */
export interface FakeVm {
  name: string;
  status: string;
  region: string;
  image: string;
  cpu: number;
  memory: string;
  disk: string;
  tags: string[];
  comment: string;
  integrations: Set<string>;
  sharePublic: boolean;
  sharePort: number | null;
  shares: Map<string, "web" | "root">;
  links: string[];
  receiveEmail: boolean;
  replyPolicy: string;
  domains: string[];
  env: Record<string, string>;
  setupScript: string | null;
  /** `ls` calls left before the VM reports `running`. */
  bootPolls: number;
}

/** What a VM command handler returns. */
export interface FakeVmRun {
  readonly output?: string | Uint8Array;
  readonly exitCode?: number;
}

/** A fault to inject. */
export type FakeFault =
  | {
    readonly status: number;
    readonly body?: JsonValue;
    readonly headers?: Record<string, string>;
    /** Run the command first, then answer with this status (a lost answer). */
    readonly execute?: boolean;
  }
  | { readonly connection: true; readonly execute?: boolean };

/** How to construct a {@link FakeExe}. */
export interface FakeExeOptions {
  readonly email?: string;
  readonly userId?: string;
  /** The account region; default `lax`. */
  readonly region?: string;
  /** `ls` calls a new VM spends in `starting`; default 0 (running at once). */
  readonly bootPolls?: number;
  /** Whether `ls` entries include `tags` and `comment`; default true. */
  readonly listDetails?: boolean;
  /** Runs `ssh <vm> <command>`; default: no output, exit 0. */
  readonly vmExec?: (
    vm: string,
    command: string,
    user: string | null,
  ) => FakeVmRun | Promise<FakeVmRun>;
  /** Send `X-Exe-Exit` as a header; default true. */
  readonly exitHeader?: boolean;
  /** The clock, for token `exp`/`nbf`; default `Date.now`. */
  readonly now?: () => number;
  /** The most VMs the account may have; default 50. */
  readonly maxVms?: number;
}

/** One request the fake served. */
export interface FakeExecRecord {
  readonly body: string;
  /** The resolved command path, or null when none resolved. */
  readonly path: string | null;
  readonly words: readonly string[];
  readonly status: number;
  readonly token: string | null;
}

interface Parsed {
  readonly path: string;
  readonly flags: Map<string, string[]>;
  readonly switches: Set<string>;
  readonly args: string[];
}

class Refusal {
  constructor(readonly status: number, readonly message: string) {}
}

const MARKER =
  /^\( ([\s\S]*) \) <\/dev\/null; rc=\$\?; printf '\\n([A-Za-z0-9_]{8,64})%s\\n' "\$rc"; exit "\$rc"$/;

/** An in-memory exe.dev lobby; see the module notes. */
export class FakeExe {
  readonly vms = new Map<string, FakeVm>();
  readonly requests: FakeExecRecord[] = [];
  readonly integrations = new Map<string, {
    name: string;
    type: string;
    team: boolean;
    comment: string;
    config: JsonObject;
    attachments: Set<string>;
  }>();
  readonly sshKeys: {
    name: string;
    line: string;
    key: SshPublicKey;
    fingerprint: string | null;
  }[] = [];
  /** The `fetch` to give the client. */
  readonly fetch: FetchLike;
  region: string;

  readonly #options: FakeExeOptions;
  readonly #tokens = new Map<string, Permissions>();
  readonly #faults: {
    match: (path: string | null, words: readonly string[]) => boolean;
    fault: FakeFault;
    times: number;
  }[] = [];
  #counter = 0;

  constructor(options: FakeExeOptions = {}) {
    this.#options = options;
    this.region = options.region ?? "lax";
    this.fetch = (input, init) => this.#handle(input, init);
  }

  /** Issues an exe1 token with these permissions (default: everything the defaults allow). */
  issueToken(permissions: Permissions = {}): string {
    const token = `exe1.fake${++this.#counter}${
      crypto.randomUUID().replace(/-/g, "")
    }`;
    this.#tokens.set(token, permissions);
    return token;
  }

  /** A token allowed to run every catalog command, `ssh` included. */
  issueAdminToken(): string {
    return this.issueToken({ cmds: COMMANDS.map((command) => command.path) });
  }

  /** Registers a public key (an `authorized_keys` line) so exe0 tokens it signs verify. */
  addSshKey(line: string, name = `key${this.sshKeys.length + 1}`): void {
    this.sshKeys.push({
      name,
      line: line.trim(),
      key: parsePublicKeyLine(line),
      fingerprint: null,
    });
  }

  /**
   * Makes the next `times` requests whose command path is `path` (or which
   * `match` accepts) fail with `fault`.
   */
  failNext(
    path: string | ((path: string | null, words: readonly string[]) => boolean),
    fault: FakeFault,
    times = 1,
  ): void {
    this.#faults.push({
      match: typeof path === "string" ? (resolved) => resolved === path : path,
      fault,
      times,
    });
  }

  /** How many requests resolved to `path` (answered or not). */
  count(path: string): number {
    return this.requests.filter((request) => request.path === path).length;
  }

  /** Adds a VM directly, as if created earlier. */
  seedVm(name: string, settings: Partial<Omit<FakeVm, "name">> = {}): FakeVm {
    const vm: FakeVm = {
      name,
      status: "running",
      region: this.region,
      image: "exeuntu",
      cpu: 2,
      memory: "8GB",
      disk: "20GB",
      tags: [],
      comment: "",
      integrations: new Set(),
      sharePublic: false,
      sharePort: null,
      shares: new Map(),
      links: [],
      receiveEmail: false,
      replyPolicy: "all",
      domains: [],
      env: {},
      setupScript: null,
      bootPolls: 0,
      ...settings,
    };
    this.vms.set(name, vm);
    return vm;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async #authorize(
    header: string | null,
  ): Promise<{ token: string; permissions: Permissions } | Refusal> {
    const match = header === null ? null : /^Bearer (\S+)$/.exec(header);
    if (match === null) return new Refusal(401, "missing bearer token");
    const token = match[1];
    let permissions = this.#tokens.get(token);
    if (permissions === undefined && token.startsWith("exe0.")) {
      if (this.sshKeys.length > 0) {
        const verified = await verifyExe0(token, {
          namespace: API_NAMESPACE,
          keys: this.sshKeys.map((key) => key.key),
        });
        if (verified.ok) permissions = verified.permissions;
      }
    }
    if (permissions === undefined) return new Refusal(401, "invalid token");
    const now = Math.floor(this.#now() / 1000);
    if (permissions.exp !== undefined && now > permissions.exp) {
      return new Refusal(401, "token expired");
    }
    if (permissions.nbf !== undefined && now < permissions.nbf) {
      return new Refusal(401, "token not yet valid");
    }
    return { token, permissions };
  }

  #parse(words: readonly string[]): Parsed | Refusal {
    const resolved = resolveCommand(words);
    if (resolved === undefined) {
      return new Refusal(404, `unknown command: ${words[0] ?? ""}`);
    }
    const flags = new Map<string, string[]>();
    const switches = new Set<string>();
    const args: string[] = [];
    const rest = [...resolved.rest];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (resolved.path === "ssh" && args.length > 0) {
        args.push(word);
        continue;
      }
      if (!word.startsWith("-") || word === "-") {
        args.push(word);
        continue;
      }
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      const spec = resolved.spec.flags[name];
      if (spec === undefined) {
        return new Refusal(422, `unknown flag ${name} for ${resolved.path}`);
      }
      if (!spec.value) {
        if (eq >= 0) return new Refusal(422, `${name} takes no value`);
        switches.add(name);
        continue;
      }
      let value: string;
      if (eq >= 0) value = word.slice(eq + 1);
      else if (i + 1 < rest.length) value = rest[++i];
      else return new Refusal(422, `${name} needs a value`);
      const list = flags.get(name) ?? [];
      if (list.length > 0 && !spec.repeatable) {
        return new Refusal(422, `${name} given twice`);
      }
      list.push(value);
      flags.set(name, list);
    }
    return { path: resolved.path, flags, switches, args };
  }

  #respond(
    status: number,
    body: JsonValue | Uint8Array,
    headers: Record<string, string> = {},
  ): Response {
    if (body instanceof Uint8Array) {
      return new Response(body as Uint8Array<ArrayBuffer>, { status, headers });
    }
    return jsonResponse(body, { status, headers });
  }

  async #handle(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const body = typeof init.body === "string" ? init.body : "";
    const record = (
      path: string | null,
      words: readonly string[],
      status: number,
      token: string | null,
    ) => this.requests.push({ body, path, words, status, token });
    const url = input instanceof Request ? input.url : input;
    if (!new URL(url).pathname.endsWith("/exec")) {
      record(null, [], 404, null);
      return this.#respond(404, { error: "not found" });
    }
    if ((init.method ?? "GET").toUpperCase() !== "POST") {
      record(null, [], 405, null);
      return this.#respond(405, { error: "method not allowed" });
    }
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      record(null, [], 413, null);
      return this.#respond(413, { error: "request too large" });
    }
    const split = splitCommandLine(body);
    if (!split.ok || split.words.length === 0) {
      record(null, [], 400, null);
      return this.#respond(400, {
        error: split.ok ? "empty command" : split.message,
      });
    }
    const words = split.words;
    const path = resolveCommand(words)?.path ?? null;
    const auth = await this.#authorize(
      new Headers(init.headers).get("authorization"),
    );
    if (auth instanceof Refusal) {
      record(path, words, auth.status, null);
      return this.#respond(auth.status, { error: auth.message });
    }
    const fault = this.#faults.find((item) =>
      item.times > 0 && item.match(path, words)
    );
    if (fault !== undefined) fault.times--;
    if (fault !== undefined && !fault.fault.execute) {
      record(
        path,
        words,
        "status" in fault.fault ? fault.fault.status : 0,
        auth.token,
      );
      if ("connection" in fault.fault) {
        throw new TypeError("connection reset (fake)");
      }
      return this.#respond(
        fault.fault.status,
        fault.fault.body ?? { error: "injected failure" },
        fault.fault.headers,
      );
    }
    let response: Response;
    const parsed = this.#parse(words);
    if (parsed instanceof Refusal) {
      response = this.#respond(parsed.status, { error: parsed.message });
    } else {
      const vm = parsed.path === "ssh" ? this.#sshTarget(parsed).vm : undefined;
      if (!cmdsAllow(auth.permissions.cmds, parsed.path, vm)) {
        response = this.#respond(403, {
          error: `command not allowed by token permissions: ${parsed.path}`,
        });
      } else {
        try {
          response = await this.#run(parsed);
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          response = this.#respond(error.status, { error: error.message });
        }
      }
    }
    if (fault !== undefined) {
      record(
        path,
        words,
        "status" in fault.fault ? fault.fault.status : 0,
        auth.token,
      );
      if ("connection" in fault.fault) {
        throw new TypeError("connection reset after running (fake)");
      }
      return this.#respond(
        fault.fault.status,
        fault.fault.body ?? { error: "injected failure" },
        fault.fault.headers,
      );
    }
    record(path, words, response.status, auth.token);
    return response;
  }

  #vm(name: string | undefined): FakeVm {
    if (name === undefined) throw new Refusal(422, "missing VM name");
    const vm = this.vms.get(name);
    if (vm === undefined) throw new Refusal(422, `no such VM: ${name}`);
    return vm;
  }

  #listing(vm: FakeVm): JsonObject {
    const region = vm.region as keyof typeof REGIONS;
    const out: JsonObject = {
      vm_name: vm.name,
      status: vm.status,
      region: vm.region,
      region_display: REGIONS[region] ?? vm.region,
      https_url: `https://${vm.name}.exe.xyz`,
      ssh_dest: `${vm.name}.exe.xyz`,
      ssh_host: `${vm.name}.exe.xyz`,
    };
    if (this.#options.listDetails ?? true) {
      out.tags = [...vm.tags];
      out.comment = vm.comment;
    }
    return out;
  }

  #sshTarget(parsed: Parsed): { vm: string | undefined; user: string | null } {
    const target = parsed.args[0];
    if (target === undefined) return { vm: undefined, user: null };
    const at = target.lastIndexOf("@");
    return at < 0
      ? { vm: target, user: parsed.flags.get("-l")?.[0] ?? null }
      : { vm: target.slice(at + 1), user: target.slice(0, at) };
  }

  #newName(): string {
    const words = [
      "amber",
      "brisk",
      "cobalt",
      "dune",
      "ember",
      "fjord",
      "glade",
      "harbor",
    ];
    for (;;) {
      const name = `${words[this.#counter % words.length]}-${
        words[(this.#counter * 3 + 1) % words.length]
      }-${++this.#counter}`;
      if (!this.vms.has(name)) return name;
    }
  }

  #create(name: string | undefined, settings: Partial<FakeVm>): FakeVm {
    if (name !== undefined && this.vms.has(name)) {
      throw new Refusal(422, `VM name ${name} already exists`);
    }
    if (this.vms.size >= (this.#options.maxVms ?? 50)) {
      throw new Refusal(422, "VM limit reached for your plan");
    }
    const bootPolls = this.#options.bootPolls ?? 0;
    return this.seedVm(name ?? this.#newName(), {
      ...settings,
      status: bootPolls > 0 ? "starting" : "running",
      bootPolls,
    });
  }

  #created(vm: FakeVm): JsonObject {
    return {
      vm_name: vm.name,
      status: vm.status,
      ssh_dest: `${vm.name}.exe.xyz`,
      ssh_host: `${vm.name}.exe.xyz`,
      https_url: `https://${vm.name}.exe.xyz`,
      region: vm.region,
    };
  }

  #splitList(values: string[] | undefined): string[] {
    return (values ?? []).flatMap((value) => value.split(",")).map((value) =>
      value.trim()
    ).filter((value) => value !== "");
  }

  async #run(parsed: Parsed): Promise<Response> {
    const { path, args, flags, switches } = parsed;
    const flag = (name: string) => flags.get(name)?.[0];
    const ok = (extra: JsonObject = {}) =>
      this.#respond(200, { ok: true, ...extra });
    if (switches.has("--help")) {
      const spec = COMMANDS.find((command) => command.path === path)!;
      return this.#respond(200, {
        command: path,
        usage: spec.usage,
        flags: Object.keys(spec.flags),
      });
    }
    switch (path) {
      case "help":
        return this.#respond(200, {
          commands: COMMANDS.map((command) => ({
            name: command.path,
            description: command.summary,
          })),
        });
      case "whoami":
        return this.#respond(200, {
          email: this.#options.email ?? "fake@example.com",
          user_id: this.#options.userId ?? "usr_fake",
          region: this.region,
          ssh_keys: await Promise.all(this.sshKeys.map(async (key) => {
            key.fingerprint ??= await fingerprint(key.key);
            return {
              name: key.name,
              fingerprint: key.fingerprint,
              public_key: key.line,
              current: false,
            };
          })),
        });
      case "ls": {
        for (const vm of this.vms.values()) {
          if (vm.bootPolls > 0 && --vm.bootPolls === 0) vm.status = "running";
        }
        const pattern = args[0];
        const vms = [...this.vms.values()].filter((vm) =>
          pattern === undefined ||
          new RegExp(
            `^${
              pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
            }$`,
          ).test(vm.name)
        );
        return this.#respond(200, { vms: vms.map((vm) => this.#listing(vm)) });
      }
      case "new": {
        if (switches.has("--pool") && switches.has("--no-pool")) {
          throw new Refusal(422, "--pool conflicts with --no-pool");
        }
        const env: Record<string, string> = {};
        for (const item of flags.get("--env") ?? []) {
          const eq = item.indexOf("=");
          if (eq <= 0) {
            throw new Refusal(422, `--env needs KEY=VALUE, got ${item}`);
          }
          env[item.slice(0, eq)] = item.slice(eq + 1);
        }
        const integrations = this.#splitList(flags.get("--integration"));
        for (const integration of integrations) {
          if (!this.integrations.has(integration)) {
            throw new Refusal(422, `no such integration: ${integration}`);
          }
        }
        const vm = this.#create(flag("--name"), {
          image: flag("--image") ?? "exeuntu",
          cpu: flag("--cpu") === undefined ? 2 : Number(flag("--cpu")),
          memory: flag("--memory") ?? "8GB",
          disk: flag("--disk") ?? "20GB",
          comment: flag("--comment") ?? "",
          tags: this.#splitList(flags.get("--tag")),
          integrations: new Set(integrations),
          env,
          setupScript: flag("--setup-script")?.replace(/\\n/g, "\n") ?? null,
        });
        return this.#respond(200, this.#created(vm));
      }
      case "rm": {
        if (args.length === 0) throw new Refusal(422, "usage: rm <vmname>...");
        for (const name of args) this.#vm(name);
        for (const name of args) this.vms.delete(name);
        return ok({ deleted: args });
      }
      case "restart":
        this.#vm(args[0]);
        return ok({ restarted: args[0] });
      case "rename": {
        const vm = this.#vm(args[0]);
        const next = args[1];
        if (next === undefined) {
          throw new Refusal(422, "usage: rename <oldname> <newname>");
        }
        if (this.vms.has(next)) {
          throw new Refusal(422, `VM name ${next} already exists`);
        }
        this.vms.delete(vm.name);
        vm.name = next;
        this.vms.set(next, vm);
        return ok({ vm_name: next });
      }
      case "tag": {
        const vm = this.#vm(args[0]);
        const tags = args.slice(1);
        if (tags.length === 0) {
          throw new Refusal(422, "usage: tag [-d] <vm> <tag-name>...");
        }
        vm.tags = switches.has("-d")
          ? vm.tags.filter((tag) => !tags.includes(tag))
          : [...new Set([...vm.tags, ...tags])];
        return ok({ vm_name: vm.name, tags: [...vm.tags] });
      }
      case "cp": {
        const source = this.#vm(args[0]);
        const copyTags = flag("--copy-tags") !== "false";
        const vm = this.#create(args[1], {
          image: source.image,
          cpu: flag("--cpu") === undefined ? source.cpu : Number(flag("--cpu")),
          memory: flag("--memory") ?? source.memory,
          disk: flag("--disk") ?? source.disk,
          tags: copyTags ? [...source.tags] : [],
          comment: source.comment,
        });
        return this.#respond(200, this.#created(vm));
      }
      case "resize": {
        const vm = this.#vm(args[0]);
        if (
          flag("--cpu") === undefined && flag("--memory") === undefined &&
          flag("--disk") === undefined
        ) {
          throw new Refusal(422, "nothing to resize");
        }
        if (flag("--cpu") !== undefined) vm.cpu = Number(flag("--cpu"));
        if (flag("--memory") !== undefined) vm.memory = flag("--memory")!;
        if (flag("--disk") !== undefined) vm.disk = flag("--disk")!;
        return ok({
          vm_name: vm.name,
          cpu: vm.cpu,
          memory: vm.memory,
          disk: vm.disk,
        });
      }
      case "comment": {
        const vm = this.#vm(args[0]);
        const text = args.slice(1).join(" ");
        if (new TextEncoder().encode(text).length > 200) {
          throw new Refusal(422, "comment too long");
        }
        vm.comment = text;
        return ok({ vm_name: vm.name, comment: text });
      }
      case "stat":
        this.#vm(args[0]);
        return this.#respond(200, {
          vm_name: args[0],
          range: flag("--range") ?? "24h",
          samples: [],
        });
      case "vm-logs":
        this.#vm(args[0]);
        return this.#respond(200, { vm_name: args[0], logs: "" });
      case "set-region":
        if (!(args[0] in REGIONS)) {
          throw new Refusal(422, `unknown region ${args[0]}`);
        }
        this.region = args[0];
        return ok({ region: args[0] });
      case "grant-support-root":
        this.#vm(args[0]);
        if (args[1] !== "on" && args[1] !== "off") {
          throw new Refusal(422, "usage: grant-support-root <vm> on|off");
        }
        return ok();
      case "share show": {
        const vm = this.#vm(args[0]);
        return this.#respond(200, {
          vm_name: vm.name,
          public: vm.sharePublic,
          port: vm.sharePort,
          shares: [...vm.shares].map(([who, access]) => ({ who, access })),
          links: [...vm.links],
        });
      }
      case "share port": {
        const vm = this.#vm(args[0]);
        if (args[1] !== undefined) {
          const port = Number(args[1]);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Refusal(422, "bad port");
          }
          vm.sharePort = port;
        }
        return ok({ vm_name: vm.name, port: vm.sharePort });
      }
      case "share set-public":
        this.#vm(args[0]).sharePublic = true;
        return ok();
      case "share set-private":
        this.#vm(args[0]).sharePublic = false;
        return ok();
      case "share add": {
        const vm = this.#vm(args[0]);
        if (args[1] === undefined) {
          throw new Refusal(422, "usage: share add <vm> <email|team>");
        }
        vm.shares.set(
          args[1],
          switches.has("--root") ? "root" : vm.shares.get(args[1]) ?? "web",
        );
        return ok();
      }
      case "share remove": {
        const vm = this.#vm(args[0]);
        if (switches.has("--root")) {
          if (vm.shares.get(args[1]) === "root") vm.shares.set(args[1], "web");
        } else {
          vm.shares.delete(args[1]);
        }
        return ok();
      }
      case "share add-link": {
        const vm = this.#vm(args[0]);
        const token = `link${++this.#counter}`;
        vm.links.push(token);
        return ok({ url: `https://${vm.name}.exe.xyz/?share=${token}`, token });
      }
      case "share remove-link": {
        const vm = this.#vm(args[0]);
        if (!vm.links.includes(args[1])) throw new Refusal(422, "no such link");
        vm.links = vm.links.filter((link) => link !== args[1]);
        return ok();
      }
      case "share receive-email": {
        const vm = this.#vm(args[0]);
        if (args[1] === "on") vm.receiveEmail = true;
        else if (args[1] === "off") vm.receiveEmail = false;
        else if (args[1] !== undefined) {
          throw new Refusal(422, "usage: share receive-email <vm> [on|off]");
        }
        if (flag("--reply-policy") !== undefined) {
          vm.replyPolicy = flag("--reply-policy")!;
        }
        return ok({
          receive_email: vm.receiveEmail,
          reply_policy: vm.replyPolicy,
        });
      }
      case "ssh-key list":
        return this.#respond(200, {
          ssh_keys: await Promise.all(this.sshKeys.map(async (key) => {
            key.fingerprint ??= await fingerprint(key.key);
            return {
              name: key.name,
              fingerprint: key.fingerprint,
              public_key: key.line,
            };
          })),
        });
      case "ssh-key add": {
        try {
          this.addSshKey(
            args.join(" "),
            parsePublicKeyLine(args.join(" ")).comment || undefined,
          );
        } catch (error) {
          throw new Refusal(422, `bad public key: ${(error as Error).message}`);
        }
        return ok();
      }
      case "ssh-key remove": {
        const before = this.sshKeys.length;
        for (let i = this.sshKeys.length - 1; i >= 0; i--) {
          const key = this.sshKeys[i];
          key.fingerprint ??= await fingerprint(key.key);
          if ([key.name, key.fingerprint, key.line].includes(args[0])) {
            this.sshKeys.splice(i, 1);
          }
        }
        if (this.sshKeys.length === before) {
          throw new Refusal(422, "no such key");
        }
        return ok();
      }
      case "ssh-key rename": {
        const key = this.sshKeys.find((item) => item.name === args[0]);
        if (key === undefined) throw new Refusal(422, "no such key");
        key.name = args[1];
        return ok();
      }
      case "ssh-key generate-api-key": {
        const cmds = flag("--cmds");
        const vm = flag("--vm");
        if (vm !== undefined) this.#vm(vm);
        const token = this.issueToken({
          ...(cmds === undefined || cmds === ""
            ? {}
            : { cmds: cmds.split(",") }),
        });
        return this.#respond(200, {
          token,
          label: flag("--label") ?? null,
          vm: vm ?? null,
        });
      }
      case "exe0-to-exe1": {
        const vm = flag("--vm");
        const verified = await verifyExe0(args[0] ?? "", {
          namespace: vm === undefined ? API_NAMESPACE : vmNamespace(vm),
          keys: this.sshKeys.map((key) => key.key),
          now: this.#now(),
        });
        if (!verified.ok) {
          throw new Refusal(422, `invalid exe0 token: ${verified.reason}`);
        }
        return this.#respond(200, {
          token: this.issueToken(verified.permissions),
        });
      }
      case "integrations list":
        return this.#respond(
          200,
          [...this.integrations.values()].map((item) => ({
            name: item.name,
            type: item.type,
            team: item.team,
            comment: item.comment,
            config: item.config,
            attachments: [...item.attachments],
          })),
        );
      case "integrations add": {
        const name = flag("--name");
        if (name === undefined) throw new Refusal(422, "--name is required");
        if (this.integrations.has(name)) {
          throw new Refusal(422, `integration ${name} already exists`);
        }
        const type = args[0];
        if (type === undefined) {
          throw new Refusal(
            422,
            "usage: integrations add <type> --name=<name>",
          );
        }
        if (type === "http-proxy" && flag("--target") === undefined) {
          throw new Refusal(422, "--target is required");
        }
        const config: JsonObject = {};
        for (const [key, values] of flags) {
          if (key === "--name" || key === "--attach" || key === "--comment") {
            continue;
          }
          config[key.slice(2)] =
            /key|token|secret|bearer|password|header|webhook/.test(key)
              ? "***"
              : values.join(",");
        }
        this.integrations.set(name, {
          name,
          type,
          team: switches.has("--team"),
          comment: flag("--comment") ?? "",
          config,
          attachments: new Set(flags.get("--attach") ?? []),
        });
        return ok({ name });
      }
      case "integrations remove":
      case "integrations test":
      case "integrations edit": {
        const item = this.integrations.get(args[0]);
        if (item === undefined) {
          throw new Refusal(422, `no such integration: ${args[0]}`);
        }
        if (path === "integrations remove") {
          this.integrations.delete(args[0]);
          for (const vm of this.vms.values()) vm.integrations.delete(args[0]);
        }
        if (path === "integrations edit" && flag("--comment") !== undefined) {
          item.comment = flag("--comment")!;
        }
        return ok({ name: args[0] });
      }
      case "integrations attach":
      case "integrations detach": {
        const item = this.integrations.get(args[0]);
        if (item === undefined) {
          throw new Refusal(422, `no such integration: ${args[0]}`);
        }
        const spec = args[1] ?? "";
        if (!/^(vm:|tag:)\S+$|^auto:all$/.test(spec)) {
          throw new Refusal(422, `bad attach spec ${spec}`);
        }
        if (spec.startsWith("vm:")) {
          const vm = this.#vm(spec.slice(3));
          if (path === "integrations attach") vm.integrations.add(item.name);
          else vm.integrations.delete(item.name);
        }
        if (path === "integrations attach") item.attachments.add(spec);
        else item.attachments.delete(spec);
        return ok({ name: item.name, spec });
      }
      case "integrations rename": {
        const item = this.integrations.get(args[0]);
        if (item === undefined) {
          throw new Refusal(422, `no such integration: ${args[0]}`);
        }
        this.integrations.delete(args[0]);
        item.name = args[1];
        this.integrations.set(args[1], item);
        return ok({ name: args[1] });
      }
      case "domain add": {
        const vm = this.#vm(args[0]);
        if (args[1] === undefined) {
          throw new Refusal(422, "usage: domain add <vm> <domain>");
        }
        if (!vm.domains.includes(args[1])) vm.domains.push(args[1]);
        return ok({ vm_name: vm.name, domain: args[1] });
      }
      case "domain rm": {
        const vm = this.#vm(args[0]);
        if (!vm.domains.includes(args[1])) {
          throw new Refusal(422, "no such domain");
        }
        vm.domains = vm.domains.filter((domain) => domain !== args[1]);
        return ok();
      }
      case "domain ls":
        if (switches.has("-a")) {
          return this.#respond(
            200,
            [...this.vms.values()].flatMap((vm) =>
              vm.domains.map((domain) => ({ vm_name: vm.name, domain }))
            ),
          );
        }
        return this.#respond(
          200,
          this.#vm(args[0]).domains.map((domain) => ({
            vm_name: args[0],
            domain,
          })),
        );
      case "ssh":
        return await this.#ssh(parsed);
      default:
        return ok({ command: path, args });
    }
  }

  async #ssh(parsed: Parsed): Promise<Response> {
    const { vm: name, user } = this.#sshTarget(parsed);
    const vm = this.#vm(name);
    if (vm.status !== "running") {
      throw new Refusal(422, `${vm.name} is ${vm.status}`);
    }
    const command = parsed.args.slice(1).join(" ");
    const wrapped = MARKER.exec(command.trimStart());
    const inner = wrapped === null ? command : wrapped[1];
    const result = await (this.#options.vmExec?.(vm.name, inner, user) ?? {});
    const exitCode = result.exitCode ?? 0;
    const output = typeof result.output === "string"
      ? new TextEncoder().encode(result.output)
      : result.output ?? new Uint8Array();
    let body = output;
    if (wrapped !== null) {
      const tail = new TextEncoder().encode(`\n${wrapped[2]}${exitCode}\n`);
      body = new Uint8Array(output.length + tail.length);
      body.set(output);
      body.set(tail, output.length);
    }
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
    };
    if (this.#options.exitHeader ?? true) {
      headers["x-exe-exit"] = String(exitCode);
    }
    return this.#respond(200, body, headers);
  }
}
