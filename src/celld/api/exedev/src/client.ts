// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The exe.dev control-plane client.
 *
 * ```ts
 * const client = ExeClient.fromEnv(env); // EXE_API_TOKEN
 * const { vms } = await client.ls();
 * const vm = await client.new({ name: "web-0", tags: ["web"], cpu: 2 });
 * const run = await client.runOnVm("web-0", ["uname", "-a"]);
 * run.exitCode; // 0
 * run.text;     // "Linux web-0 ..."
 * ```
 *
 * Every method builds one lobby command (see `command.ts`), sends it to
 * `POST /exec` (see `transport.ts`) and decodes the JSON. Reads are retried
 * on transient failures; commands that change anything are sent once, and a
 * failure that leaves it unknown whether they ran has `ambiguous: true`.
 *
 * It uses only `fetch`, `AbortController`, timers and `crypto`, so it runs in
 * celld Workers, Durable Objects and Workflows.
 *
 * @module
 */

import { truncatedBody } from "@celld/http";
import {
  BillingApi,
  DefaultsApi,
  DomainApi,
  encodeSetupScript,
  type ExeOps,
  IntegrationsApi,
  InviteApi,
  type ListOptions,
  PoolApi,
  ShareApi,
  ShelleyApi,
  SshKeyApi,
  TeamApi,
} from "./api.ts";
import { type CatalogDrift, catalogDrift, commandSpec } from "./catalog.ts";
import {
  buildCommand,
  type Command,
  type CommandInput,
  rawCommand,
} from "./command.ts";
import {
  type CreatedVm,
  decodeCreatedVm,
  decodeIssuedToken,
  decodeLs,
  decodeWhoami,
  type IssuedToken,
  type LsResult,
  type VmSummary,
  type WhoamiResult,
} from "./decode.ts";
import { ExeDecodeError, ExeError, ExeInvalidRequestError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import { lobbyWordIssues, sshCommandLine } from "./quote.ts";
import { signerFromOpenSsh } from "./sshsig.ts";
import {
  cmdsAllow,
  DEFAULT_CMDS,
  mintingTokenSource,
  parseToken,
  type TokenSource,
} from "./tokens.ts";
import {
  type CallOptions,
  ExeTransport,
  type RawResponse,
  type TransportOptions,
} from "./transport.ts";
import {
  checkBytes,
  checkChoice,
  checkInteger,
  Checks,
  checkVmName,
  checkWord,
  checkWords,
  Region,
  type Size,
  sizeText,
} from "./validate.ts";
import {
  detachedCommand,
  type DetachOptions,
  newExitMarker,
  parseExitMarker,
  type VmCommand,
  vmShellCommand,
  withExitMarker,
} from "./vmexec.ts";

/** How to construct an {@link ExeClient}. */
export interface ExeClientOptions extends TransportOptions {
  /**
   * Refuse commands a static exe0 token's `cmds` does not allow, and expired
   * tokens, before sending (saving a request and a rate-limit slot). Default
   * true; it has no effect for exe1 tokens and token sources.
   */
  readonly checkPermissions?: boolean;
}

/** The `env` bindings {@link ExeClient.fromEnv} reads. */
export interface ExeEnv {
  /** An exe0 or exe1 token, as a secret binding. */
  readonly EXE_API_TOKEN?: string;
  /**
   * Instead of a token: an unencrypted OpenSSH Ed25519 private key (a secret
   * binding) whose public key is on the account. Short-lived exe0 tokens are
   * minted from it locally.
   */
  readonly EXE_SSH_PRIVATE_KEY?: string;
  /** With the private key: the minted tokens' `cmds`, comma-separated. */
  readonly EXE_TOKEN_CMDS?: string;
  /** With the private key: each minted token's lifetime; default 3600. */
  readonly EXE_TOKEN_TTL_SECONDS?: string;
  /** Overrides the lobby origin, for proxies and tests. */
  readonly EXE_BASE_URL?: string;
}

/** The result of {@link ExeClient.exec}. */
export interface ExecResult {
  /** The response as JSON, or its text when it is not JSON. */
  readonly value: JsonValue;
  readonly status: number;
  readonly attempts: number;
  /** The command line sent, with secrets redacted. */
  readonly command: string;
}

/** Settings of `new`. */
export interface NewVmOptions {
  /** The VM's name; generated when absent. Give one to make retries safe. */
  readonly name?: string;
  /** A container image, e.g. `ubuntu:22.04`; default exeuntu. */
  readonly image?: string;
  /** vCPUs; default 2. */
  readonly cpu?: number;
  /** Memory, e.g. `4`, `4GB`, `8G`. */
  readonly memory?: Size;
  /** Disk, e.g. `20`, `20GB`, `50G`. */
  readonly disk?: Size;
  /** A short note, at most 200 bytes. */
  readonly comment?: string;
  /** Environment variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** Integrations to attach. */
  readonly integrations?: readonly string[];
  readonly tags?: readonly string[];
  /** Do not send the email notification. */
  readonly noEmail?: boolean;
  /** Create it in one of the team's pools. */
  readonly pool?: string;
  /** Ordinary placement even when the plan places new VMs in pools. */
  readonly noPool?: boolean;
  /** An initial prompt for Shelley (needs an image with Shelley). */
  readonly prompt?: string;
  /** Credentials for a private `image` registry. */
  readonly registryAuth?: {
    readonly username: string;
    readonly password: string;
  };
  /** Its own reserved capacity (needs a plan with standalone VMs). */
  readonly standalone?: boolean;
  /** Run once at first boot; at most 10 KiB. */
  readonly setupScript?: string;
}

/** Settings of `cp`. */
export interface CopyVmOptions {
  /** The copy's name; generated when absent. */
  readonly name?: string;
  readonly cpu?: number;
  readonly memory?: Size;
  readonly disk?: Size;
  readonly pool?: string;
  /** Copy the source's tags; the server's default is to copy them. */
  readonly copyTags?: boolean;
  readonly standalone?: boolean;
}

/** Settings of `resize`; give at least one. */
export interface ResizeOptions {
  readonly cpu?: number;
  readonly memory?: Size;
  /** The new total disk; must be larger than the current one. */
  readonly disk?: Size;
}

/** How {@link ExeClient.runOnVm} runs a command. */
export interface RunOnVmOptions extends CallOptions {
  /** Log in as this user (`user@vm`). */
  readonly user?: string;
  /**
   * How to learn the exit status: `marker` (default) appends a marker to the
   * output (see `vmexec.ts`); `header` only reads an `X-Exe-Exit` response
   * header, and reports `null` when there is none.
   */
  readonly exit?: "marker" | "header";
  /** A fixed marker, for tests. */
  readonly marker?: string;
  /**
   * Whether running it twice is harmless, which allows retries of transient
   * failures. Default false.
   */
  readonly idempotent?: boolean;
}

/** What a command on a VM produced. Plain data. */
export interface VmRunResult {
  readonly vm: string;
  /** The exit status, or null when it could not be learned. */
  readonly exitCode: number | null;
  /** Where `exitCode` came from. */
  readonly exitSource: "marker" | "header" | null;
  /** stdout and stderr, combined as the server sends them. */
  readonly output: Uint8Array;
  /** `output` decoded as UTF-8 (invalid bytes replaced). */
  readonly text: string;
  readonly attempts: number;
}

/** Result of {@link ExeClient.startDetached}. */
export interface DetachedStart {
  /** The detached process's id, when the VM reported it. */
  readonly pid: number | null;
  readonly run: VmRunResult;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const utf8 = new TextDecoder();

/** Settings of `ls` plus grouping. */
export type LsGroup = "none" | "tag" | "region" | "type";

/** A client for everything `POST /exec` offers; see the module notes. */
export class ExeClient {
  /** The underlying transport (base URL, retry policy, timeouts). */
  readonly transport: ExeTransport;
  /** `share ...`. */
  readonly share: ShareApi;
  /** `ssh-key ...`. */
  readonly sshKey: SshKeyApi;
  /** `integrations ...`. */
  readonly integrations: IntegrationsApi;
  /** `domain ...`. */
  readonly domain: DomainApi;
  /** `team ...`. */
  readonly team: TeamApi;
  /** `pool ...`. */
  readonly pool: PoolApi;
  /** `billing ...`. */
  readonly billing: BillingApi;
  /** `invite ...`. */
  readonly invite: InviteApi;
  /** `shelley ...`. */
  readonly shelley: ShelleyApi;
  /** `defaults ...`. */
  readonly defaults: DefaultsApi;

  readonly #permissions:
    | { cmds: readonly string[]; exp?: number; nbf?: number }
    | null;

  /**
   * @throws {TypeError} a missing token, or a base URL that is not http(s).
   * @throws {RangeError} a timeout or retry setting out of range.
   */
  constructor(options: ExeClientOptions) {
    this.transport = new ExeTransport(options);
    let permissions:
      | { cmds: readonly string[]; exp?: number; nbf?: number }
      | null = null;
    if (
      typeof options.token === "string" && options.checkPermissions !== false
    ) {
      try {
        const parsed = parseToken(options.token);
        if (parsed.kind === "exe0" && parsed.issues.length === 0) {
          permissions = {
            cmds: parsed.permissions.cmds ?? DEFAULT_CMDS,
            exp: parsed.permissions.exp,
            nbf: parsed.permissions.nbf,
          };
        }
      } catch {
        // The server decides about tokens this library cannot read.
      }
    }
    this.#permissions = permissions;
    const ops: ExeOps = {
      json: (input, callOptions) => this.#json(input, callOptions),
      typed: (input, decode, callOptions) =>
        this.#typed(input, decode, callOptions),
    };
    this.share = new ShareApi(ops);
    this.sshKey = new SshKeyApi(ops);
    this.integrations = new IntegrationsApi(ops);
    this.domain = new DomainApi(ops);
    this.team = new TeamApi(ops);
    this.pool = new PoolApi(ops);
    this.billing = new BillingApi(ops);
    this.invite = new InviteApi(ops);
    this.shelley = new ShelleyApi(ops);
    this.defaults = new DefaultsApi(ops);
  }

  /**
   * A client configured from Worker bindings (see {@link ExeEnv}): a token
   * in `EXE_API_TOKEN`, or a private key in `EXE_SSH_PRIVATE_KEY` from which
   * short-lived tokens are minted. Explicit options win.
   *
   * @throws {TypeError} when neither is bound.
   */
  static fromEnv(
    env: ExeEnv,
    options: Omit<ExeClientOptions, "token"> & {
      readonly token?: string | TokenSource;
    } = {},
  ): ExeClient {
    let token = options.token ?? (env.EXE_API_TOKEN?.trim() || undefined);
    if (
      token === undefined && env.EXE_SSH_PRIVATE_KEY !== undefined &&
      env.EXE_SSH_PRIVATE_KEY.trim() !== ""
    ) {
      const pem = env.EXE_SSH_PRIVATE_KEY;
      const cmds = env.EXE_TOKEN_CMDS?.split(",").map((cmd) => cmd.trim())
        .filter((cmd) => cmd !== "");
      const ttl = env.EXE_TOKEN_TTL_SECONDS === undefined
        ? 3600
        : Number(env.EXE_TOKEN_TTL_SECONDS);
      let source: TokenSource | null = null;
      token = {
        async token() {
          source ??= mintingTokenSource({
            signer: await signerFromOpenSsh(pem),
            cmds,
            ttlSeconds: ttl,
            refreshBeforeSeconds: Math.min(300, Math.floor(ttl / 2)),
            runtime: options.runtime,
          });
          return await source.token();
        },
      };
    }
    if (token === undefined) {
      throw new TypeError(
        "EXE_API_TOKEN (or EXE_SSH_PRIVATE_KEY) is not bound; add it as a secret for this Worker",
      );
    }
    return new ExeClient({
      ...options,
      token,
      baseUrl: options.baseUrl ?? (env.EXE_BASE_URL?.trim() || undefined),
    });
  }

  #checkPermission(command: Command, vm?: string): void {
    const permissions = this.#permissions;
    if (permissions === null) return;
    const now = Math.floor(this.transport.runtime.now() / 1000);
    if (permissions.exp !== undefined && now > permissions.exp) {
      throw new ExeInvalidRequestError([{
        path: ["token", "exp"],
        message: "the token has expired",
      }]);
    }
    if (permissions.nbf !== undefined && now < permissions.nbf) {
      throw new ExeInvalidRequestError([{
        path: ["token", "nbf"],
        message: "the token is not valid yet",
      }]);
    }
    if (commandSpec(command.path) === undefined) return;
    if (!cmdsAllow(permissions.cmds, command.path, vm)) {
      throw new ExeInvalidRequestError([{
        path: ["token", "cmds"],
        message: `the token's cmds do not allow ${
          command.path === "ssh" ? `ssh ${vm}` : command.path
        }`,
      }]);
    }
  }

  async #send(
    command: Command,
    options: CallOptions = {},
    vm?: string,
  ): Promise<RawResponse> {
    this.#checkPermission(command, vm);
    return await this.transport.send(command, options);
  }

  async #json(input: CommandInput, options?: CallOptions): Promise<JsonValue> {
    return (await this.exec(input, options)).value;
  }

  async #typed<T>(
    input: CommandInput | Command,
    decode: (value: unknown) => T,
    options?: CallOptions,
  ): Promise<T> {
    const command = "line" in input ? input : buildCommand(input);
    const response = await this.#send(command, options);
    const text = utf8.decode(response.body);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExeDecodeError([{
        path: [],
        message: "the response is not JSON",
      }], {
        status: response.status,
        command: command.redacted,
        body: truncatedBody(text),
        attempts: response.attempts,
      });
    }
    try {
      return decode(json);
    } catch (error) {
      if (error instanceof ExeDecodeError) {
        throw new ExeDecodeError(error.issues, {
          status: response.status,
          command: command.redacted,
          body: truncatedBody(text),
          attempts: response.attempts,
        });
      }
      throw error;
    }
  }

  /**
   * Sends any command: a {@link CommandInput} (checked against the catalog),
   * a built {@link Command}, or a command line you quoted yourself (sent
   * as is, never retried).
   */
  async exec(
    input: CommandInput | Command | string,
    options?: CallOptions,
  ): Promise<ExecResult> {
    const command = typeof input === "string"
      ? rawCommand(input)
      : "line" in input
      ? input
      : buildCommand(input);
    const response = await this.#send(command, options);
    const text = utf8.decode(response.body);
    let value: JsonValue;
    try {
      value = JSON.parse(text) as JsonValue;
    } catch {
      value = text;
    }
    return {
      value,
      status: response.status,
      attempts: response.attempts,
      command: command.redacted,
    };
  }

  // Introspection.

  /** `help` or `help <command...>`. */
  async help(command?: string, options?: CallOptions): Promise<JsonValue> {
    const args = command === undefined ? [] : command.trim().split(/\s+/);
    return await this.#json({ path: "help", args }, options);
  }

  /** `help all`: every command, one line each. */
  async helpAll(options?: CallOptions): Promise<JsonValue> {
    return await this.#json({ path: "help", args: ["all"] }, options);
  }

  /**
   * `<command> --help`: a command's flags and examples as JSON, without side
   * effects (the docs promise this for every command).
   */
  async commandHelp(path: string, options?: CallOptions): Promise<JsonValue> {
    return await this.#json({
      path,
      flags: { "--help": true },
      idempotent: true,
    }, options);
  }

  /** `doc [slug-or-query]`. */
  async doc(query?: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    if (query !== undefined && query.trim() === "") {
      checks.add(["query"], "must not be blank");
    }
    checks.done();
    return await this.#json({
      path: "doc",
      args: query === undefined ? [] : [query],
    }, options);
  }

  /**
   * Compares the live `help all` with this library's command table; see
   * `catalogDrift`. A non-empty `unknown` means exe.dev has commands this
   * library does not type yet; `missing` means documented ones went away.
   */
  async catalogDrift(options?: CallOptions): Promise<CatalogDrift> {
    return catalogDrift(await this.helpAll(options));
  }

  /** `whoami`. */
  async whoami(options?: CallOptions): Promise<WhoamiResult> {
    return await this.#typed({ path: "whoami" }, decodeWhoami, options);
  }

  // VMs.

  /** `ls [-l] [pattern]`. */
  async ls(flags: ListOptions = {}, options?: CallOptions): Promise<LsResult> {
    return await this.#typed(
      {
        path: "ls",
        args: flags.pattern === undefined ? [] : [flags.pattern],
        flags: { "-l": flags.long },
      },
      decodeLs,
      options,
    );
  }

  /** `ls --group=...`: the grouped listing, whose shape is not documented. */
  async lsGrouped(
    group: LsGroup,
    flags: ListOptions = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["group"], group, ["none", "tag", "region", "type"]);
    checks.done();
    return await this.#json({
      path: "ls",
      args: flags.pattern === undefined ? [] : [flags.pattern],
      flags: { "-l": flags.long, "--group": group },
    }, options);
  }

  /** One VM by exact name from `ls`, or null when there is none. */
  async getVm(
    name: string,
    flags: { readonly long?: boolean } = {},
    options?: CallOptions,
  ): Promise<VmSummary | null> {
    const checks = new Checks();
    checkVmName(checks, ["name"], name);
    checks.done();
    const { vms } = await this.ls({ long: flags.long }, options);
    return vms.find((vm) => vm.vm_name === name) ?? null;
  }

  /**
   * `new`: creates a VM. `new` is not idempotent: without a `name`, a retry
   * after an ambiguous failure could create a second VM. With a `name`, a
   * second `new` fails instead (names are unique), so name your VMs and
   * re-list after `ambiguous` failures; the fleet helpers do exactly that.
   */
  async new(
    settings: NewVmOptions = {},
    options?: CallOptions,
  ): Promise<CreatedVm> {
    const checks = new Checks();
    if (settings.name !== undefined) {
      checkVmName(checks, ["name"], settings.name);
    }
    if (settings.image !== undefined) {
      checkWord(checks, ["image"], settings.image, "image reference");
    }
    if (settings.cpu !== undefined) {
      checkInteger(checks, ["cpu"], settings.cpu, 1);
    }
    const memory = settings.memory === undefined
      ? undefined
      : sizeText(checks, ["memory"], settings.memory);
    const disk = settings.disk === undefined
      ? undefined
      : sizeText(checks, ["disk"], settings.disk);
    if (settings.comment !== undefined) {
      checkBytes(checks, ["comment"], settings.comment, 200);
    }
    const env: string[] = [];
    for (const [key, value] of Object.entries(settings.env ?? {})) {
      if (!ENV_KEY.test(key)) {
        checks.add(["env", key], "must be an environment variable name");
      }
      checks.issues.push(...lobbyWordIssues(value, ["env", key]));
      env.push(`${key}=${value}`);
    }
    checkWords(
      checks,
      ["integrations"],
      settings.integrations,
      "integration name",
    );
    checkWords(checks, ["tags"], settings.tags, "tag");
    if (settings.pool !== undefined) {
      checkWord(checks, ["pool"], settings.pool, "pool name");
    }
    if (settings.pool !== undefined && settings.noPool) {
      checks.add(["noPool"], "conflicts with pool");
    }
    if (settings.prompt !== undefined) {
      if (settings.prompt.trim() === "") {
        checks.add(["prompt"], "must not be blank");
      }
      if (settings.prompt.trim() === "/dev/stdin") {
        checks.add(
          ["prompt"],
          "the HTTPS API has no stdin; pass the prompt text",
        );
      }
    }
    let registryAuth: string | undefined;
    if (settings.registryAuth !== undefined) {
      if (
        settings.registryAuth.username.includes(":") ||
        settings.registryAuth.username === ""
      ) {
        checks.add(
          ["registryAuth", "username"],
          "must be non-empty without ':'",
        );
      }
      if (settings.image === undefined) {
        checks.add(["registryAuth"], "applies only with image");
      }
      registryAuth =
        `${settings.registryAuth.username}:${settings.registryAuth.password}`;
    }
    let setupScript: string | undefined;
    if (settings.setupScript !== undefined) {
      checkBytes(checks, ["setupScript"], settings.setupScript, 10 * 1024);
      if (settings.setupScript.trim() === "/dev/stdin") {
        checks.add(
          ["setupScript"],
          "the HTTPS API has no stdin; pass the script text",
        );
      }
    }
    checks.done();
    if (settings.setupScript !== undefined) {
      setupScript = encodeSetupScript(settings.setupScript);
    }
    return await this.#typed(
      {
        path: "new",
        flags: {
          "--name": settings.name,
          "--image": settings.image,
          "--cpu": settings.cpu,
          "--memory": memory,
          "--disk": disk,
          "--comment": settings.comment,
          "--env": env.length === 0 ? undefined : env,
          "--integration": settings.integrations?.length
            ? settings.integrations
            : undefined,
          "--tag": settings.tags?.length ? settings.tags : undefined,
          "--no-email": settings.noEmail,
          "--pool": settings.pool,
          "--no-pool": settings.noPool,
          "--prompt": settings.prompt,
          "--registry-auth": registryAuth,
          "--standalone": settings.standalone,
          "--setup-script": setupScript,
        },
        secretFlags: ["--registry-auth", "--env"],
      },
      decodeCreatedVm,
      options,
    );
  }

  /** `rm <vm>...`: deletes VMs. */
  async rm(
    vms: string | readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue> {
    const names = typeof vms === "string" ? [vms] : [...vms];
    const checks = new Checks();
    if (names.length === 0) checks.add(["vms"], "name at least one VM");
    names.forEach((name, index) => checkVmName(checks, ["vms", index], name));
    checks.done();
    return await this.#json({ path: "rm", args: names }, options);
  }

  /** `restart <vm>`. */
  async restart(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.#json({ path: "restart", args: [vm] }, options);
  }

  /** `rename <old> <new>`. */
  async rename(
    oldName: string,
    newName: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["oldName"], oldName);
    checkVmName(checks, ["newName"], newName);
    checks.done();
    return await this.#json(
      { path: "rename", args: [oldName, newName] },
      options,
    );
  }

  /** `tag <vm> <tag...>`: adds tags. */
  async tag(
    vm: string,
    tags: readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.#tag(vm, tags, false, options);
  }

  /** `tag -d <vm> <tag...>`: removes tags. */
  async untag(
    vm: string,
    tags: readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.#tag(vm, tags, true, options);
  }

  async #tag(
    vm: string,
    tags: readonly string[],
    remove: boolean,
    options?: CallOptions,
  ) {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (tags.length === 0) checks.add(["tags"], "name at least one tag");
    checkWords(checks, ["tags"], tags, "tag");
    checks.done();
    return await this.#json({
      path: "tag",
      args: [vm, ...tags],
      flags: { "-d": remove },
    }, options);
  }

  /** `cp <source> [name] ...`: copies a VM; not idempotent, like `new`. */
  async cp(
    source: string,
    settings: CopyVmOptions = {},
    options?: CallOptions,
  ): Promise<CreatedVm> {
    const checks = new Checks();
    checkVmName(checks, ["source"], source);
    if (settings.name !== undefined) {
      checkVmName(checks, ["name"], settings.name);
    }
    if (settings.cpu !== undefined) {
      checkInteger(checks, ["cpu"], settings.cpu, 1);
    }
    const memory = settings.memory === undefined
      ? undefined
      : sizeText(checks, ["memory"], settings.memory);
    const disk = settings.disk === undefined
      ? undefined
      : sizeText(checks, ["disk"], settings.disk);
    if (settings.pool !== undefined) {
      checkWord(checks, ["pool"], settings.pool, "pool name");
    }
    checks.done();
    return await this.#typed(
      {
        path: "cp",
        args: settings.name === undefined ? [source] : [source, settings.name],
        flags: {
          "--cpu": settings.cpu,
          "--memory": memory,
          "--disk": disk,
          "--pool": settings.pool,
          "--copy-tags": settings.copyTags === undefined
            ? undefined
            : String(settings.copyTags),
          "--standalone": settings.standalone,
        },
      },
      decodeCreatedVm,
      options,
    );
  }

  /** `resize <vm> [--cpu] [--memory] [--disk]`. */
  async resize(
    vm: string,
    settings: ResizeOptions,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (
      settings.cpu === undefined && settings.memory === undefined &&
      settings.disk === undefined
    ) {
      checks.add([], "give cpu, memory or disk");
    }
    if (settings.cpu !== undefined) {
      checkInteger(checks, ["cpu"], settings.cpu, 1);
    }
    const memory = settings.memory === undefined
      ? undefined
      : sizeText(checks, ["memory"], settings.memory);
    const disk = settings.disk === undefined
      ? undefined
      : sizeText(checks, ["disk"], settings.disk);
    checks.done();
    return await this.#json({
      path: "resize",
      args: [vm],
      flags: { "--cpu": settings.cpu, "--memory": memory, "--disk": disk },
    }, options);
  }

  /**
   * `comment <vm> <text>`: sets the comment (at most 200 bytes), or clears it
   * with `""`. Text starting with `-` is refused (see `command.ts`).
   */
  async comment(
    vm: string,
    text: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkBytes(checks, ["text"], text, 200);
    checks.done();
    return await this.#json({
      path: "comment",
      args: [vm, text],
      allowEmptyArgs: true,
    }, options);
  }

  /** `stat <vm> [--range]`: vCPU, disk, IO and network metrics. */
  async stat(
    vm: string,
    flags: { readonly range?: "24h" | "7d" | "30d" } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (flags.range !== undefined) {
      checkChoice(checks, ["range"], flags.range, ["24h", "7d", "30d"]);
    }
    checks.done();
    return await this.#json({
      path: "stat",
      args: [vm],
      flags: { "--range": flags.range },
    }, options);
  }

  /** `vm-logs <vm>`: boot logs (from exe.dev's agent skill; undocumented). */
  async vmLogs(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.#json({ path: "vm-logs", args: [vm] }, options);
  }

  /** `grant-support-root <vm> on|off`. */
  async grantSupportRoot(
    vm: string,
    enabled: boolean,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.#json({
      path: "grant-support-root",
      args: [vm, enabled ? "on" : "off"],
    }, options);
  }

  /** `set-region <code>`: the account's preferred region for new VMs. */
  async setRegion(code: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checks.schema(Region, ["code"], code.toLowerCase());
    checks.done();
    return await this.#json(
      { path: "set-region", args: [code.toLowerCase()] },
      options,
    );
  }

  /** `browser [--qr]`: a magic login link for a person. */
  async browser(
    flags: { readonly qr?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.#json(
      { path: "browser", flags: { "--qr": flags.qr } },
      options,
    );
  }

  /**
   * `exe0-to-exe1 [--vm=<vm>] <exe0>`: a short opaque handle for an exe0
   * token (validated by the server first; VM tokens need `vm`). Revoking the
   * exe0 token revokes the handle.
   */
  async exe0ToExe1(
    token: string,
    flags: { readonly vm?: string } = {},
    options?: CallOptions,
  ): Promise<IssuedToken> {
    const checks = new Checks();
    if (!/^exe0\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      checks.add(["token"], "must be an exe0 token");
    }
    if (flags.vm !== undefined) checkVmName(checks, ["vm"], flags.vm);
    checks.done();
    return await this.#typed(
      {
        path: "exe0-to-exe1",
        args: [token],
        flags: { "--vm": flags.vm },
        secretArgs: [0],
      },
      (value) => decodeIssuedToken(value, "exe1"),
      options,
    );
  }

  // Commands on VMs.

  /**
   * Runs a command on a VM (`ssh <vm> <command>` over `/exec`) and returns
   * its combined output and exit status. The request is bounded by the
   * server's 30 s; use {@link ExeClient.startDetached} for longer work.
   *
   * A non-zero exit is a result, not an error. Errors are for the request
   * itself: the VM does not exist, the token may not `ssh` to it, and so on.
   */
  async runOnVm(
    vm: string,
    command: VmCommand,
    options: RunOnVmOptions = {},
  ): Promise<VmRunResult> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (options.user !== undefined && !SSH_USER.test(options.user)) {
      checks.add(["user"], "must be a Unix user name");
    }
    checks.done();
    const mode = options.exit ?? "marker";
    let vmCommand = vmShellCommand(command);
    const marker = mode === "marker" ? options.marker ?? newExitMarker() : null;
    if (marker !== null) vmCommand = withExitMarker(vmCommand, marker);
    const lineIssues = lobbyWordIssues(vmCommand, ["command"]);
    if (lineIssues.length > 0) {
      throw new ExeInvalidRequestError(lineIssues.map((issue) => ({
        ...issue,
        message: `${issue.message}; send multi-line text as {script}`,
      })));
    }
    const built = rawCommand(sshCommandLine(vm, vmCommand, options.user), {
      path: "ssh",
      idempotent: options.idempotent ?? false,
    });
    const response = await this.#send(
      built,
      marker === null ? options : { ...options, acceptStatuses: [422] },
      vm,
    );
    if (response.status === 422) {
      // The docs say a failing command answers 422. If the marker made it
      // into the body, the command ran and this is its result; otherwise the
      // request itself failed (no such VM, say).
      const parsed = parseExitMarker(response.body, marker!);
      if (parsed.exitCode === null) {
        const error = this.transport.apiError(
          built,
          response.status,
          response.headers,
          response.body,
        );
        error.attempts = response.attempts;
        throw error;
      }
      return {
        vm,
        exitCode: parsed.exitCode,
        exitSource: "marker",
        output: parsed.output,
        text: utf8.decode(parsed.output),
        attempts: response.attempts,
      };
    }
    const header = response.headers.get("x-exe-exit");
    const headerCode = header !== null && /^\s*\d+\s*$/.test(header)
      ? Number(header)
      : null;
    let output = response.body;
    let exitCode: number | null = headerCode;
    let exitSource: VmRunResult["exitSource"] = headerCode === null
      ? null
      : "header";
    if (marker !== null) {
      const parsed = parseExitMarker(response.body, marker);
      if (parsed.exitCode !== null) {
        if (headerCode !== null && headerCode !== parsed.exitCode) {
          throw new ExeDecodeError([{
            path: ["X-Exe-Exit"],
            message:
              `the header says ${headerCode} but the command reported ${parsed.exitCode}`,
          }], {
            status: response.status,
            command: built.redacted,
            attempts: response.attempts,
          });
        }
        output = parsed.output;
        exitCode = parsed.exitCode;
        exitSource = "marker";
      }
    }
    return {
      vm,
      exitCode,
      exitSource,
      output,
      text: utf8.decode(output),
      attempts: response.attempts,
    };
  }

  /**
   * Starts a command on a VM detached from the request (`setsid nohup ... &`)
   * and returns at once with its process id. With `statusFile`, the exit
   * status is written there when it finishes, which is how to wait for work
   * longer than the 30 s request limit (poll it with `runOnVm`).
   */
  async startDetached(
    vm: string,
    command: VmCommand,
    detach: DetachOptions = {},
    options: RunOnVmOptions = {},
  ): Promise<DetachedStart> {
    const run = await this.runOnVm(
      vm,
      { shell: detachedCommand(vmShellCommand(command), detach) },
      options,
    );
    const match = /(\d+)\s*$/.exec(run.text);
    return { pid: match === null ? null : Number(match[1]), run };
  }
}

/** True when an error means the VM or name already exists. */
export function isAlreadyExists(error: unknown): boolean {
  if (!(error instanceof ExeError) || error.kind !== "command_failed") {
    return false;
  }
  const text = `${error.detail ?? ""} ${error.message}`.toLowerCase();
  return /already (exists|taken|in use)|name (is )?taken|not available|exists/
    .test(text);
}
