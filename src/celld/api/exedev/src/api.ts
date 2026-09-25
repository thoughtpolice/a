// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed methods for the lobby's command groups, reached through `ExeClient`
 * (`client.share`, `client.sshKey`, `client.integrations`, `client.team`,
 * `client.pool`, `client.billing`, `client.invite`, `client.shelley`,
 * `client.domain`, `client.defaults`).
 *
 * Each method builds one command with `buildCommand` (quoting, flag checks,
 * the 64 KiB limit) after checking its own arguments, sends it, and returns
 * the JSON. Results the docs do not describe are returned as
 * {@link JsonValue} as received; see `decode.ts` for the ones that are typed.
 *
 * @module
 */

import { parseDateTime } from "@celld/isotime";
import type { CommandInput, FlagValue } from "./command.ts";
import {
  decodeIntegrations,
  decodeIssuedToken,
  decodeSshKeys,
  type IntegrationInfo,
  type IssuedToken,
  type SshKeyInfo,
} from "./decode.ts";
import { ExeInvalidRequestError } from "./errors.ts";
import type { JsonValue } from "./json.ts";
import type { CallOptions } from "./transport.ts";
import {
  checkBytes,
  checkChoice,
  checkDate,
  checkDuration,
  checkEmail,
  checkInteger,
  checkMonth,
  checkPort,
  Checks,
  checkUrl,
  checkVmName,
  checkWord,
} from "./validate.ts";

/** What the groups need from the client. */
export interface ExeOps {
  /** Sends a command and returns its JSON (or text, when not JSON). */
  json(input: CommandInput, options?: CallOptions): Promise<JsonValue>;
  /** Sends a command and decodes its JSON. */
  typed<T>(
    input: CommandInput,
    decode: (value: unknown) => T,
    options?: CallOptions,
  ): Promise<T>;
}

/** `on`/`off`, from a boolean. */
function onOff(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

/** Who a share is with: an email address, or `team`. */
export type ShareTarget = string;

/** `share` subcommands: web and root access, links, the proxy port, inbound email. */
export class ShareApi {
  constructor(private readonly ops: ExeOps) {}

  /** `share show <vm>`: current shares and proxy settings. */
  async show(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json({ path: "share show", args: [vm] }, options);
  }

  /**
   * `share port <vm> [port]`: sets the HTTP proxy port, keeping the current
   * visibility. Without `port` it reports the current one (read-only).
   */
  async port(
    vm: string,
    port?: number,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (port !== undefined) checkPort(checks, ["port"], port);
    checks.done();
    return await this.ops.json({
      path: "share port",
      args: port === undefined ? [vm] : [vm, port],
      idempotent: port === undefined,
    }, options);
  }

  /** `share set-public <vm>`: anyone may reach the proxy without logging in. */
  async setPublic(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json(
      { path: "share set-public", args: [vm] },
      options,
    );
  }

  /** `share set-private <vm>`: only users with access. */
  async setPrivate(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json(
      { path: "share set-private", args: [vm] },
      options,
    );
  }

  /**
   * `share add <vm> <email|team>`: web access, or with `root` shell access
   * (SSH, Terminal, Shelley). Root needs an existing exe.dev account.
   */
  async add(
    vm: string,
    target: ShareTarget,
    flags: { readonly root?: boolean; readonly message?: string } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (target !== "team") checkEmail(checks, ["target"], target);
    checks.done();
    return await this.ops.json({
      path: "share add",
      args: [vm, target],
      flags: { "--root": flags.root, "--message": flags.message },
    }, options);
  }

  /**
   * `share remove <vm> <email|team>`: removes all access, or with `root`
   * downgrades root access to web access.
   */
  async remove(
    vm: string,
    target: ShareTarget,
    flags: { readonly root?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (target !== "team") checkEmail(checks, ["target"], target);
    checks.done();
    return await this.ops.json({
      path: "share remove",
      args: [vm, target],
      flags: { "--root": flags.root },
    }, options);
  }

  /** `share add-link <vm>`: a link granting web access after login. */
  async addLink(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json({ path: "share add-link", args: [vm] }, options);
  }

  /** `share remove-link <vm> <token>`: stops new people using the link. */
  async removeLink(
    vm: string,
    token: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkWord(checks, ["token"], token, "link token");
    checks.done();
    return await this.ops.json({
      path: "share remove-link",
      args: [vm, token],
      secretArgs: [1],
    }, options);
  }

  /**
   * `share receive-email <vm> [on|off] [--reply-policy=...]`. With neither
   * `enabled` nor `replyPolicy` it reports the current setting (read-only).
   */
  async receiveEmail(
    vm: string,
    settings: {
      readonly enabled?: boolean;
      readonly replyPolicy?: "all" | "known" | "owner" | "none";
    } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (settings.replyPolicy !== undefined) {
      checkChoice(checks, ["replyPolicy"], settings.replyPolicy, [
        "all",
        "known",
        "owner",
        "none",
      ]);
    }
    checks.done();
    const args: (string | number)[] = [vm];
    if (settings.enabled !== undefined) args.push(onOff(settings.enabled));
    return await this.ops.json({
      path: "share receive-email",
      args,
      flags: { "--reply-policy": settings.replyPolicy },
      idempotent: settings.enabled === undefined &&
        settings.replyPolicy === undefined,
    }, options);
  }
}

/** Settings of `ssh-key generate-api-key`. */
export interface GenerateApiKeyOptions {
  /** A label for the token's (new) SSH key. */
  readonly label?: string;
  /** Scope the token to this VM's HTTPS endpoints instead of lobby commands. */
  readonly vm?: string;
  /** Allowed commands; empty or absent means the server's defaults. */
  readonly cmds?: readonly string[];
  /** Expiry as a duration (`30d`, `1y`) or `never`. */
  readonly exp?: string;
}

/** `ssh-key` subcommands. */
export class SshKeyApi {
  constructor(private readonly ops: ExeOps) {}

  /** `ssh-key list`. The JSON shape is not documented; see `decodeSshKeys`. */
  async list(options?: CallOptions): Promise<SshKeyInfo[]> {
    return await this.ops.typed(
      { path: "ssh-key list" },
      decodeSshKeys,
      options,
    );
  }

  /** `ssh-key add [--tag=TAG] <public-key>`; `tag` scopes it to tagged VMs. */
  async add(
    publicKey: string,
    flags: { readonly tag?: string } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    if (
      !/^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+ [A-Za-z0-9+/=]+( .*)?$/.test(
        publicKey.trim(),
      )
    ) {
      checks.add(
        ["publicKey"],
        "must be an authorized_keys line: '<type> <base64> [comment]'",
      );
    }
    if (flags.tag !== undefined) checkWord(checks, ["tag"], flags.tag, "tag");
    checks.done();
    return await this.ops.json({
      path: "ssh-key add",
      args: [publicKey.trim()],
      flags: { "--tag": flags.tag },
    }, options);
  }

  /** `ssh-key remove <name|fingerprint|public-key>`: revokes every token it signed. */
  async remove(key: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    if (key.trim() === "") checks.add(["key"], "must not be empty");
    checks.done();
    return await this.ops.json(
      { path: "ssh-key remove", args: [key.trim()] },
      options,
    );
  }

  /** `ssh-key rename <old-name> <new-name>`. */
  async rename(
    oldName: string,
    newName: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["oldName"], oldName, "key name");
    checkWord(checks, ["newName"], newName, "key name");
    checks.done();
    return await this.ops.json({
      path: "ssh-key rename",
      args: [oldName, newName],
    }, options);
  }

  /**
   * `ssh-key generate-api-key`: the server makes a key and returns a token.
   * The response shape is not documented; the token is found in it (see
   * `decodeIssuedToken`) and the whole response is kept in `raw`.
   */
  async generateApiKey(
    settings: GenerateApiKeyOptions = {},
    options?: CallOptions,
  ): Promise<IssuedToken> {
    const checks = new Checks();
    if (settings.label !== undefined) {
      checkWord(checks, ["label"], settings.label, "label");
    }
    if (settings.vm !== undefined) checkVmName(checks, ["vm"], settings.vm);
    settings.cmds?.forEach((cmd, index) => {
      if (!/^[a-z0-9][a-z0-9-]*( [a-z0-9][a-z0-9._-]*)*$/.test(cmd)) {
        checks.add(
          ["cmds", index],
          "must be command words separated by single spaces",
        );
      }
    });
    if (settings.exp !== undefined && settings.exp !== "never") {
      checkDuration(checks, ["exp"], settings.exp);
    }
    checks.done();
    return await this.ops.typed(
      {
        path: "ssh-key generate-api-key",
        flags: {
          "--label": settings.label,
          "--vm": settings.vm,
          "--cmds": settings.cmds === undefined
            ? undefined
            : settings.cmds.join(","),
          "--exp": settings.exp,
        },
      },
      (value) => decodeIssuedToken(value),
      options,
    );
  }
}

/** Where an integration is attached: a VM, a tag, or every VM. */
export type AttachSpec = `vm:${string}` | `tag:${string}` | "auto:all";

/** Builds `vm:<name>`. */
export function attachVm(vm: string): AttachSpec {
  return `vm:${vm}`;
}

/** Builds `tag:<name>`. */
export function attachTag(tag: string): AttachSpec {
  return `tag:${tag}`;
}

function checkSpec(
  checks: Checks,
  path: (string | number)[],
  spec: string,
): void {
  if (spec === "auto:all") return;
  if (spec.startsWith("vm:")) checkVmName(checks, path, spec.slice(3));
  else if (spec.startsWith("tag:")) {
    checkWord(checks, path, spec.slice(4), "tag");
  } else checks.add(path, "must be vm:<name>, tag:<name> or auto:all");
}

/** Reflection fields an integration may expose. */
export type ReflectionField =
  | "email"
  | "integrations"
  | "tags"
  | "comment"
  | "default_port";

/** Settings every `integrations add` takes. */
export interface IntegrationCommon {
  /** The integration's name; attached VMs reach it as `<name>.int.exe.xyz`. */
  readonly name: string;
  /** Create a team integration (`<name>.team.exe.xyz`; tag attachments only). */
  readonly team?: boolean;
  /** Attach at creation. */
  readonly attach?: readonly AttachSpec[];
  /** Time-box every `attach` (e.g. `2h`). */
  readonly for?: string;
  readonly comment?: string;
  /**
   * Flags for integration types or options this library does not type, such
   * as a catalog service's `--base-url`. Checked for injection, not meaning.
   */
  readonly extraFlags?: Readonly<Record<string, FlagValue>>;
}

/** The documented integration types and their settings. */
export type IntegrationSpec =
  | {
    readonly type: "http-proxy";
    readonly target: string;
    /** Headers to inject, as `Name:value`. */
    readonly headers?: readonly string[];
    readonly bearer?: string;
    readonly noAuth?: boolean;
    /** Make it a VM-to-VM integration: `target` is another of your VMs. */
    readonly peer?: boolean;
    readonly stripPrefix?: string;
  }
  | {
    readonly type: "github";
    /** `owner/repo`. */
    readonly repository: string;
    readonly readonly?: boolean;
    readonly actAsUser?: boolean;
  }
  | {
    readonly type: "llm";
    readonly openai?: "managed" | "byok" | "chatgpt" | "disabled";
    readonly openaiKey?: string;
    readonly openaiAccount?: string;
    readonly anthropic?: "managed" | "byok" | "disabled";
    readonly anthropicKey?: string;
    readonly fireworks?: "managed" | "byok" | "disabled";
    readonly fireworksKey?: string;
    readonly deepgram?: "managed" | "byok" | "disabled";
    readonly deepgramKey?: string;
    /** `id=https://base/url`. */
    readonly customProviders?: readonly string[];
    readonly customProviderApis?: readonly string[];
    readonly bearer?: string;
    readonly headers?: readonly string[];
  }
  | {
    readonly type: "slack";
    /** A send-only incoming webhook... */
    readonly webhookUrl?: string;
    /** ...or a two-way bot. */
    readonly botToken?: string;
    readonly appToken?: string;
  }
  | {
    readonly type: "discord";
    readonly webhookUrl?: string;
    readonly botToken?: string;
  }
  | {
    readonly type: "s3";
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  }
  | {
    readonly type: "reflection";
    /** Fields to expose, `all` or `none`. */
    readonly fields: readonly ReflectionField[] | "all" | "none";
  }
  | {
    readonly type: "wif";
    readonly audience: string;
    readonly consumer: "gcp" | "aws";
    /** `key=value` pairs the VM reads back from `/metadata`. */
    readonly metadata?: Readonly<Record<string, string>>;
  }
  | {
    /** A catalog service handle (`stripe`, `db:neon`, `quay`, ...). */
    readonly type: string;
    readonly catalog: true;
  };

function fieldsText(
  fields: readonly ReflectionField[] | "all" | "none",
): string {
  return typeof fields === "string" ? fields : fields.join(",");
}

/** Settings of `integrations edit`. */
export interface IntegrationEdit {
  readonly team?: boolean;
  readonly target?: string;
  /** Replaces all existing headers. */
  readonly headers?: readonly string[];
  readonly clearHeaders?: boolean;
  readonly bearer?: string;
  readonly noAuth?: boolean;
  /** An empty string removes the prefix. */
  readonly stripPrefix?: string;
  readonly repository?: string;
  readonly readonly?: boolean;
  readonly actAsUser?: boolean;
  readonly comment?: string;
  readonly fields?: readonly ReflectionField[] | "all" | "none";
  readonly webhookUrl?: string;
  readonly extraFlags?: Readonly<Record<string, FlagValue>>;
}

/** `integrations` subcommands. */
export class IntegrationsApi {
  constructor(private readonly ops: ExeOps) {}

  /** `integrations list`, with per-VM usage when `usage` is set. */
  async list(
    flags: { readonly usage?: boolean } = {},
    options?: CallOptions,
  ): Promise<IntegrationInfo[]> {
    return await this.ops.typed(
      { path: "integrations list", flags: { "--usage": flags.usage } },
      decodeIntegrations,
      options,
    );
  }

  /**
   * `integrations add <type> --name=<name> ...`. Credentials travel in the
   * command line (the HTTPS API has no stdin for the CLI's `-` form); they are
   * redacted from error messages but reach exe.dev like any other argument.
   */
  async add(
    spec: IntegrationSpec & IntegrationCommon,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], spec.name, "integration name");
    if (
      typeof spec.type !== "string" ||
      !/^(db:)?[a-z0-9][a-z0-9-]*$/.test(spec.type)
    ) {
      checks.add(["type"], "must be an integration type or catalog handle");
    }
    spec.attach?.forEach((item, index) =>
      checkSpec(checks, ["attach", index], item)
    );
    if (spec.for !== undefined) checkDuration(checks, ["for"], spec.for);
    const flags: Record<string, FlagValue> = {
      "--name": spec.name,
      "--team": spec.team,
      "--attach": spec.attach,
      "--for": spec.for,
      "--comment": spec.comment,
    };
    const s = spec as IntegrationSpec;
    if ("catalog" in s) {
      // Catalog services take flags this library does not type.
    } else {
      switch (s.type) {
        case "http-proxy":
          checkUrl(checks, ["target"], s.target, ["https:", "http:"]);
          if (s.noAuth && s.peer) checks.add(["noAuth"], "conflicts with peer");
          if (
            s.stripPrefix !== undefined &&
            !/^(\/[A-Za-z0-9._~-]+)+\/?$/.test(s.stripPrefix)
          ) {
            checks.add(
              ["stripPrefix"],
              "must be /segments of letters, digits and - _ . ~",
            );
          }
          Object.assign(flags, {
            "--target": s.target,
            "--header": s.headers,
            "--bearer": s.bearer,
            "--no-auth": s.noAuth,
            "--peer": s.peer,
            "--strip-prefix": s.stripPrefix,
          });
          break;
        case "github":
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repository)) {
            checks.add(["repository"], "must be owner/repo");
          }
          if (spec.team && s.actAsUser) {
            checks.add(["actAsUser"], "is not available on team integrations");
          }
          Object.assign(flags, {
            "--repository": s.repository,
            "--readonly": s.readonly,
            "--act-as-user": s.actAsUser,
          });
          break;
        case "llm":
          if (s.openai === "chatgpt" && spec.team) {
            checks.add(
              ["openai"],
              "ChatGPT subscriptions are only for personal integrations",
            );
          }
          if (s.openai === "chatgpt" && s.openaiAccount === undefined) {
            checks.add(["openaiAccount"], "is needed with openai: chatgpt");
          }
          for (
            const [key, mode, secret] of [
              ["openai", s.openai, s.openaiKey],
              ["anthropic", s.anthropic, s.anthropicKey],
              ["fireworks", s.fireworks, s.fireworksKey],
              ["deepgram", s.deepgram, s.deepgramKey],
            ] as const
          ) {
            if (mode === "byok" && secret === undefined) {
              checks.add([`${key}Key`], `is needed with ${key}: byok`);
            }
          }
          Object.assign(flags, {
            "--openai": s.openai,
            "--openai-key": s.openaiKey,
            "--openai-account": s.openaiAccount,
            "--anthropic": s.anthropic,
            "--anthropic-key": s.anthropicKey,
            "--fireworks": s.fireworks,
            "--fireworks-key": s.fireworksKey,
            "--deepgram": s.deepgram,
            "--deepgram-key": s.deepgramKey,
            "--custom-provider": s.customProviders,
            "--custom-provider-api": s.customProviderApis,
            "--bearer": s.bearer,
            "--header": s.headers,
          });
          break;
        case "slack":
        case "discord":
          if ((s.webhookUrl === undefined) === (s.botToken === undefined)) {
            checks.add(["webhookUrl"], "give a webhookUrl or a botToken");
          }
          if (s.webhookUrl !== undefined) {
            checkUrl(checks, ["webhookUrl"], s.webhookUrl);
          }
          Object.assign(flags, {
            "--webhook-url": s.webhookUrl,
            "--bot-token": s.botToken,
            "--app-token": s.type === "slack" ? s.appToken : undefined,
          });
          break;
        case "s3":
          checkUrl(checks, ["endpoint"], s.endpoint);
          Object.assign(flags, {
            "--endpoint": s.endpoint,
            "--region": s.region,
            "--bucket": s.bucket,
            "--access-key-id": s.accessKeyId,
            "--secret-access-key": s.secretAccessKey,
          });
          break;
        case "reflection":
          Object.assign(flags, { "--fields": fieldsText(s.fields) });
          break;
        case "wif":
          checkUrl(checks, ["audience"], s.audience, ["https:", "sts:"]);
          for (const key of Object.keys(s.metadata ?? {})) {
            checkWord(checks, ["metadata", key], key, "metadata key");
          }
          Object.assign(flags, {
            "--audience": s.audience,
            "--consumer": s.consumer,
            "--metadata": Object.entries(s.metadata ?? {}).map(([key, value]) =>
              `${key}=${value}`
            ),
          });
          break;
      }
    }
    checks.done();
    return await this.ops.json({
      path: "integrations add",
      args: [spec.type],
      flags,
      extraFlags: spec.extraFlags,
      secretFlags: ["--header", "--custom-provider"],
    }, options);
  }

  /** `integrations remove <name> [--team]`. */
  async remove(
    name: string,
    flags: { readonly team?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    checks.done();
    return await this.ops.json({
      path: "integrations remove",
      args: [name],
      flags: { "--team": flags.team },
    }, options);
  }

  /** `integrations test <name> [--team]`: checks the stored credential. */
  async test(
    name: string,
    flags: { readonly team?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    checks.done();
    return await this.ops.json({
      path: "integrations test",
      args: [name],
      flags: { "--team": flags.team },
    }, options);
  }

  /** `integrations edit <name> ...`. */
  async edit(
    name: string,
    edit: IntegrationEdit,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    if (edit.target !== undefined) {
      checkUrl(checks, ["target"], edit.target, ["https:", "http:"]);
    }
    if (edit.webhookUrl !== undefined) {
      checkUrl(checks, ["webhookUrl"], edit.webhookUrl);
    }
    if (
      edit.stripPrefix !== undefined && edit.stripPrefix !== "" &&
      !/^(\/[A-Za-z0-9._~-]+)+\/?$/.test(edit.stripPrefix)
    ) {
      checks.add(
        ["stripPrefix"],
        "must be /segments of letters, digits and - _ . ~, or empty",
      );
    }
    checks.done();
    return await this.ops.json({
      path: "integrations edit",
      args: [name],
      flags: {
        "--team": edit.team,
        "--target": edit.target,
        "--header": edit.headers,
        "--clear-header": edit.clearHeaders,
        "--bearer": edit.bearer,
        "--no-auth": edit.noAuth,
        "--strip-prefix": edit.stripPrefix,
        "--repository": edit.repository,
        "--readonly": edit.readonly,
        "--act-as-user": edit.actAsUser,
        "--comment": edit.comment,
        "--fields": edit.fields === undefined
          ? undefined
          : fieldsText(edit.fields),
        "--webhook-url": edit.webhookUrl,
      },
      extraFlags: edit.extraFlags,
      secretFlags: ["--header"],
    }, options);
  }

  /**
   * `integrations attach <name> <spec>`, optionally time-boxed with `for`
   * (a duration) or `until` (an instant, or RFC 3339 text with `Z` or an
   * offset, sent as UTC). Re-attaching the same spec with a new limit
   * extends or shortens it. Team integrations take only `tag:` specs.
   */
  async attach(
    name: string,
    spec: AttachSpec,
    flags: {
      readonly team?: boolean;
      readonly for?: string;
      readonly until?: Temporal.Instant | string;
    } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    checkSpec(checks, ["spec"], spec);
    if (flags.team && !spec.startsWith("tag:")) {
      checks.add(["spec"], "team integrations attach to tag:<name> only");
    }
    if (flags.for !== undefined && flags.until !== undefined) {
      checks.add(["for"], "give for or until, not both");
    }
    if (flags.for !== undefined) checkDuration(checks, ["for"], flags.for);
    const instant = typeof flags.until === "string"
      ? parseDateTime(flags.until, { offset: true })
      : flags.until;
    if (instant === null) checks.add(["until"], "must be an RFC 3339 time");
    const until = instant?.toString();
    checks.done();
    return await this.ops.json({
      path: "integrations attach",
      args: [name, spec],
      flags: { "--team": flags.team, "--for": flags.for, "--until": until },
    }, options);
  }

  /** `integrations detach <name> <spec> [--team]`. */
  async detach(
    name: string,
    spec: AttachSpec,
    flags: { readonly team?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    checkSpec(checks, ["spec"], spec);
    checks.done();
    return await this.ops.json({
      path: "integrations detach",
      args: [name, spec],
      flags: { "--team": flags.team },
    }, options);
  }

  /** `integrations rename <name> <new-name> [--team]`. */
  async rename(
    name: string,
    newName: string,
    flags: { readonly team?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "integration name");
    checkWord(checks, ["newName"], newName, "integration name");
    checks.done();
    return await this.ops.json({
      path: "integrations rename",
      args: [name, newName],
      flags: { "--team": flags.team },
    }, options);
  }

  /** `integrations catalog [term]`: the catalog, or a search of it. */
  async catalog(term?: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    if (term !== undefined) checkWord(checks, ["term"], term, "search term");
    checks.done();
    return await this.ops.json({
      path: "integrations catalog",
      args: term === undefined ? [] : [term],
    }, options);
  }

  /**
   * `integrations setup github [--list|--verify|-d]`. Linking an account
   * happens in the browser; this lists, verifies or disconnects.
   */
  async setupGithub(
    action: "list" | "verify" | "delete",
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["action"], action, ["list", "verify", "delete"]);
    checks.done();
    return await this.ops.json({
      path: "integrations setup github",
      flags: { [`--${action}`]: true },
      idempotent: action !== "delete",
    }, options);
  }

  /**
   * `integrations setup chatgpt`: `connect` starts the device-code flow for
   * account `name` (its output has the URL and code to hand to a person);
   * `list`, `verify` and `delete` manage connected accounts.
   */
  async setupChatgpt(
    action: "connect" | "list" | "verify" | "delete",
    name?: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["action"], action, [
      "connect",
      "list",
      "verify",
      "delete",
    ]);
    if (name !== undefined) checkWord(checks, ["name"], name, "account name");
    checks.done();
    return await this.ops.json({
      path: "integrations setup chatgpt",
      flags: {
        "--name": name,
        "--list": action === "list",
        "--verify": action === "verify",
        "--delete": action === "delete",
      },
      idempotent: action === "list" || action === "verify",
    }, options);
  }

  /**
   * `integrations setup slack` or `discord`: starts the OAuth flow that
   * creates a webhook integration; the output holds a link for a person.
   */
  async setupWebhook(
    service: "slack" | "discord",
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["service"], service, ["slack", "discord"]);
    checks.done();
    return await this.ops.json(
      { path: `integrations setup ${service}` },
      options,
    );
  }
}

/** `domain` subcommands: custom domains. */
export class DomainApi {
  constructor(private readonly ops: ExeOps) {}

  /**
   * `domain add [--wildcard] <vm> <domain>`. Set up the CNAME first; with
   * `wildcard` the first run prints a second CNAME to add, then run it again.
   */
  async add(
    vm: string,
    domain: string,
    flags: { readonly wildcard?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkDomain(checks, ["domain"], domain);
    checks.done();
    return await this.ops.json({
      path: "domain add",
      args: [vm, domain],
      flags: { "--wildcard": flags.wildcard },
    }, options);
  }

  /** `domain rm <vm> <domain>`. */
  async rm(
    vm: string,
    domain: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkDomain(checks, ["domain"], domain);
    checks.done();
    return await this.ops.json(
      { path: "domain rm", args: [vm, domain] },
      options,
    );
  }

  /** `domain ls <vm>`, or `domain ls -a` when `vm` is omitted. */
  async ls(vm?: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    if (vm !== undefined) checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json(
      vm === undefined
        ? { path: "domain ls", flags: { "-a": true } }
        : { path: "domain ls", args: [vm] },
      options,
    );
  }
}

function checkDomain(
  checks: Checks,
  path: (string | number)[],
  domain: string,
): void {
  if (
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
      .test(domain)
  ) {
    checks.add(path, "must be a domain name such as app.example.com");
  }
}

/** A team role. */
export type TeamRole = "user" | "admin" | "billing_owner";

/** Billing contact details (`billing update`, `team billing update`). */
export interface BillingContact {
  readonly email?: string;
  readonly name?: string;
  readonly businessName?: string;
  readonly phone?: string;
  readonly addressLine1?: string;
  readonly addressLine2?: string;
  readonly addressCity?: string;
  readonly addressState?: string;
  readonly addressPostalCode?: string;
  readonly addressCountry?: string;
  readonly taxIdType?: string;
  readonly taxIdValue?: string;
}

function contactFlags(
  checks: Checks,
  contact: BillingContact,
): Record<string, FlagValue> {
  if (contact.email !== undefined) checkEmail(checks, ["email"], contact.email);
  if (Object.values(contact).every((value) => value === undefined)) {
    checks.add([], "give at least one field to update");
  }
  return {
    "--email": contact.email,
    "--name": contact.name,
    "--business-name": contact.businessName,
    "--phone": contact.phone,
    "--address-line1": contact.addressLine1,
    "--address-line2": contact.addressLine2,
    "--address-city": contact.addressCity,
    "--address-state": contact.addressState,
    "--address-postal-code": contact.addressPostalCode,
    "--address-country": contact.addressCountry,
    "--tax-id-type": contact.taxIdType,
    "--tax-id-value": contact.taxIdValue,
  };
}

/** `ls`-style listing options. */
export interface ListOptions {
  /** Detailed information (`-l`). */
  readonly long?: boolean;
  /** A VM name or pattern. */
  readonly pattern?: string;
}

/** `team` subcommands; team admins and billing owners only. */
export class TeamApi {
  /** `team billing ...`. */
  readonly billing: {
    show(options?: CallOptions): Promise<JsonValue>;
    plan(
      flags?: { readonly all?: boolean },
      options?: CallOptions,
    ): Promise<JsonValue>;
    update(contact: BillingContact, options?: CallOptions): Promise<JsonValue>;
  };
  /** `team auth ...`: SSO. */
  readonly auth: {
    show(options?: CallOptions): Promise<JsonValue>;
    requireOidc(mode: "web" | "off", options?: CallOptions): Promise<JsonValue>;
    set(
      provider: "default" | "google" | "oidc",
      oidc?: {
        readonly issuerUrl: string;
        readonly clientId: string;
        /** `***` keeps the stored secret. */
        readonly clientSecret: string;
        readonly displayName?: string;
      },
      options?: CallOptions,
    ): Promise<JsonValue>;
  };
  /** `team settings ...`. */
  readonly settings: {
    show(options?: CallOptions): Promise<JsonValue>;
    vmPlacement(options?: CallOptions): Promise<JsonValue>;
    vmPlacementDefault(options?: CallOptions): Promise<JsonValue>;
    vmPlacementPool(pool: string, options?: CallOptions): Promise<JsonValue>;
    vmPlacementMemberPool(
      settings: {
        readonly cpus: number;
        readonly maxVms?: number;
        readonly host?: string;
      },
      options?: CallOptions,
    ): Promise<JsonValue>;
    vmPlacementPoolless(options?: CallOptions): Promise<JsonValue>;
    standalone(
      mode: "off" | "admins-only" | "all-users",
      options?: CallOptions,
    ): Promise<JsonValue>;
    llmGateway(enabled: boolean, options?: CallOptions): Promise<JsonValue>;
    vmSharing(
      mode: "admins-only" | "all-members",
      options?: CallOptions,
    ): Promise<JsonValue>;
    autoJoin(enabled: boolean, options?: CallOptions): Promise<JsonValue>;
  };
  /** `team vm ...`: every member's VMs. */
  readonly vm: {
    show(options?: CallOptions): Promise<JsonValue>;
    ls(
      flags?: ListOptions & {
        readonly group?: "none" | "tag" | "region" | "type" | "user" | "access";
      },
      options?: CallOptions,
    ): Promise<JsonValue>;
  };

  constructor(private readonly ops: ExeOps) {
    const choice = async <T extends string>(
      path: string,
      value: T,
      choices: readonly T[],
      options?: CallOptions,
    ) => {
      const checks = new Checks();
      checkChoice(checks, ["value"], value, choices);
      checks.done();
      return await ops.json({ path, args: [value] }, options);
    };
    this.billing = {
      show: (options) => ops.json({ path: "team billing" }, options),
      plan: (flags = {}, options) =>
        ops.json(
          { path: "team billing plan", flags: { "--all": flags.all } },
          options,
        ),
      update: async (contact, options) => {
        const checks = new Checks();
        const flags = contactFlags(checks, contact);
        checks.done();
        return await ops.json({ path: "team billing update", flags }, options);
      },
    };
    this.auth = {
      show: (options) => ops.json({ path: "team auth" }, options),
      requireOidc: (mode, options) =>
        choice("team auth require-oidc", mode, ["web", "off"], options),
      set: async (provider, oidc, options) => {
        const checks = new Checks();
        checkChoice(checks, ["provider"], provider, [
          "default",
          "google",
          "oidc",
        ]);
        if (provider === "oidc" && oidc === undefined) {
          checks.add(["oidc"], "is needed for the oidc provider");
        }
        if (provider !== "oidc" && oidc !== undefined) {
          checks.add(["oidc"], "applies only to the oidc provider");
        }
        if (oidc !== undefined) {
          checkUrl(checks, ["oidc", "issuerUrl"], oidc.issuerUrl);
        }
        checks.done();
        return await ops.json({
          path: "team auth set",
          args: [provider],
          flags: {
            "--issuer-url": oidc?.issuerUrl,
            "--client-id": oidc?.clientId,
            "--client-secret": oidc?.clientSecret,
            "--display-name": oidc?.displayName,
          },
          secretFlags: ["--client-secret"],
        }, options);
      },
    };
    this.settings = {
      show: (options) => ops.json({ path: "team settings" }, options),
      vmPlacement: (options) =>
        ops.json({ path: "team settings vm-placement" }, options),
      vmPlacementDefault: (options) =>
        ops.json({ path: "team settings vm-placement default" }, options),
      vmPlacementPool: async (pool, options) => {
        const checks = new Checks();
        checkWord(checks, ["pool"], pool, "pool name");
        checks.done();
        return await ops.json({
          path: "team settings vm-placement pool",
          args: [pool],
        }, options);
      },
      vmPlacementMemberPool: async (settings, options) => {
        const checks = new Checks();
        checkPoolCpus(checks, ["cpus"], settings.cpus);
        if (settings.maxVms !== undefined) {
          checkInteger(checks, ["maxVms"], settings.maxVms, 1);
        }
        if (settings.host !== undefined) {
          checkWord(checks, ["host"], settings.host, "host alias");
        }
        checks.done();
        return await ops.json({
          path: "team settings vm-placement member-pool",
          flags: {
            "--cpus": settings.cpus,
            "--max-vms": settings.maxVms,
            "--host": settings.host,
          },
        }, options);
      },
      vmPlacementPoolless: (options) =>
        ops.json({ path: "team settings vm-placement poolless" }, options),
      standalone: (mode, options) =>
        choice("team settings standalone", mode, [
          "off",
          "admins-only",
          "all-users",
        ], options),
      llmGateway: (enabled, options) =>
        ops.json(
          { path: "team settings llm-gateway", args: [onOff(enabled)] },
          options,
        ),
      vmSharing: (mode, options) =>
        choice(
          "team settings vm-sharing",
          mode,
          ["admins-only", "all-members"],
          options,
        ),
      autoJoin: (enabled, options) =>
        ops.json(
          { path: "team settings auto-join", args: [onOff(enabled)] },
          options,
        ),
    };
    this.vm = {
      show: (options) => ops.json({ path: "team vm" }, options),
      ls: async (flags = {}, options) => {
        const checks = new Checks();
        if (flags.group !== undefined) {
          checkChoice(checks, ["group"], flags.group, [
            "none",
            "tag",
            "region",
            "type",
            "user",
            "access",
          ]);
        }
        checks.done();
        return await ops.json({
          path: "team vm ls",
          args: flags.pattern === undefined ? [] : [flags.pattern],
          flags: { "-l": flags.long, "--group": flags.group },
        }, options);
      },
    };
  }

  /** `team`: a summary (name, your role, members, VM count). */
  async show(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "team" }, options);
  }

  /** `team members`. */
  async members(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "team members" }, options);
  }

  /** `team usage`: pool, disk and bandwidth this billing period. */
  async usage(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "team usage" }, options);
  }

  /** `team add <email> [role]`: sends an invite that expires in 24 hours. */
  async add(
    email: string,
    role?: TeamRole,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkEmail(checks, ["email"], email);
    if (role !== undefined) {
      checkChoice(checks, ["role"], role, ["user", "admin", "billing_owner"]);
    }
    checks.done();
    return await this.ops.json({
      path: "team add",
      args: role === undefined ? [email] : [email, role],
    }, options);
  }

  /**
   * `team remove <email> [--transfer-vms-to <email>]`. Transfers commit one
   * VM at a time; after a partial failure, run it again.
   */
  async remove(
    email: string,
    flags: { readonly transferVmsTo?: string } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkEmail(checks, ["email"], email);
    if (flags.transferVmsTo !== undefined) {
      checkEmail(checks, ["transferVmsTo"], flags.transferVmsTo);
      if (flags.transferVmsTo === email) {
        checks.add(["transferVmsTo"], "must be another member");
      }
    }
    checks.done();
    return await this.ops.json({
      path: "team remove",
      args: [email],
      flags: { "--transfer-vms-to": flags.transferVmsTo },
    }, options);
  }

  /** `team role <email> <role>`. */
  async role(
    email: string,
    role: TeamRole,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkEmail(checks, ["email"], email);
    checkChoice(checks, ["role"], role, ["user", "admin", "billing_owner"]);
    checks.done();
    return await this.ops.json(
      { path: "team role", args: [email, role] },
      options,
    );
  }

  /** `team rename <name>`. */
  async rename(name: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    if (name.trim() === "") checks.add(["name"], "must not be empty");
    checks.done();
    return await this.ops.json({ path: "team rename", args: [name] }, options);
  }

  /** `team transfer <vm> <email>`: changes the owner and clears all shares. */
  async transfer(
    vm: string,
    email: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkEmail(checks, ["email"], email);
    checks.done();
    return await this.ops.json(
      { path: "team transfer", args: [vm, email] },
      options,
    );
  }

  /** `team disable --yes`: disbands the team (billing owner, no other members). */
  async disable(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({
      path: "team disable",
      flags: { "--yes": true },
    }, options);
  }
}

function checkPoolCpus(
  checks: Checks,
  path: (string | number)[],
  cpus: number,
): void {
  checkInteger(checks, path, cpus, 4, 512);
  if (Number.isInteger(cpus) && cpus % 2 !== 0) {
    checks.add(path, "must be even");
  }
}

/** `pool` subcommands: reserved capacity for team VMs. */
export class PoolApi {
  constructor(private readonly ops: ExeOps) {}

  /**
   * `pool new <name> --cpus=N (--region=R | --host=H) [--max-vms=M]`. CPUs
   * are even from 4 to 512, with 2 GiB of memory per vCPU.
   */
  async new(
    name: string,
    settings: {
      readonly cpus: number;
      readonly region?: string;
      readonly host?: string;
      readonly maxVms?: number;
    },
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "pool name");
    checkPoolCpus(checks, ["cpus"], settings.cpus);
    if ((settings.region === undefined) === (settings.host === undefined)) {
      checks.add(["region"], "give a region or a host, not both");
    }
    if (settings.region !== undefined) {
      checkWord(checks, ["region"], settings.region, "region code");
    }
    if (settings.host !== undefined) {
      checkWord(checks, ["host"], settings.host, "host alias");
    }
    if (settings.maxVms !== undefined) {
      checkInteger(checks, ["maxVms"], settings.maxVms, 1);
    }
    checks.done();
    return await this.ops.json({
      path: "pool new",
      args: [name],
      flags: {
        "--cpus": settings.cpus,
        "--region": settings.region,
        "--host": settings.host,
        "--max-vms": settings.maxVms,
      },
    }, options);
  }

  /** `pool hosts`: dedicated hosts assigned to the team. */
  async hosts(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "pool hosts" }, options);
  }

  /** `pool list [name] [--usage [--range=...]]`. */
  async list(
    flags: {
      readonly name?: string;
      readonly usage?: boolean;
      readonly range?: "24h" | "7d" | "30d";
    } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    if (flags.name !== undefined) {
      checkWord(checks, ["name"], flags.name, "pool name");
    }
    if (flags.range !== undefined) {
      checkChoice(checks, ["range"], flags.range, ["24h", "7d", "30d"]);
      if (!flags.usage) checks.add(["range"], "requires usage");
    }
    checks.done();
    return await this.ops.json({
      path: "pool list",
      args: flags.name === undefined ? [] : [flags.name],
      flags: { "--usage": flags.usage, "--range": flags.range },
    }, options);
  }

  /** `pool adopt --vm=<vm> --pool=<pool>`; can take several minutes. */
  async adopt(
    vm: string,
    pool: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checkWord(checks, ["pool"], pool, "pool name");
    checks.done();
    return await this.ops.json({
      path: "pool adopt",
      flags: { "--vm": vm, "--pool": pool },
    }, options);
  }

  /** `pool detach --vm=<vm>`: into its own standalone capacity. */
  async detach(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json(
      { path: "pool detach", flags: { "--vm": vm } },
      options,
    );
  }

  /** `pool resize <name> --cpus=N` or `--max-vms=N [--force]`. */
  async resize(
    name: string,
    settings: { readonly cpus: number } | {
      readonly maxVms: number;
      readonly force?: boolean;
    },
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "pool name");
    let flags: Record<string, FlagValue>;
    if ("cpus" in settings) {
      checkPoolCpus(checks, ["cpus"], settings.cpus);
      flags = { "--cpus": settings.cpus };
    } else {
      checkInteger(checks, ["maxVms"], settings.maxVms, 1);
      flags = { "--max-vms": settings.maxVms, "--force": settings.force };
    }
    checks.done();
    return await this.ops.json(
      { path: "pool resize", args: [name], flags },
      options,
    );
  }

  /** `pool delete <name> [--force]`; `force` detaches its VMs first. */
  async delete(
    name: string,
    flags: { readonly force?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkWord(checks, ["name"], name, "pool name");
    checks.done();
    return await this.ops.json({
      path: "pool delete",
      args: [name],
      flags: { "--force": flags.force },
    }, options);
  }
}

/** `billing` subcommands. */
export class BillingApi {
  /** `billing credits ...`: Shelley credits. */
  readonly credits: {
    show(options?: CallOptions): Promise<JsonValue>;
    usage(
      flags?: {
        readonly month?: string;
        readonly group?: "model" | "day" | "box";
        readonly detail?: boolean;
      },
      options?: CallOptions,
    ): Promise<JsonValue>;
    transactions(
      flags?: { readonly limit?: number },
      options?: CallOptions,
    ): Promise<JsonValue>;
    /**
     * Buys credits (`--yes` is always sent: there is no prompt over HTTPS).
     * With `idempotencyKey` a repeated purchase of the same amount charges
     * once, so the call is retried like a read.
     */
    buy(
      dollars: number,
      flags?: { readonly idempotencyKey?: string },
      options?: CallOptions,
    ): Promise<JsonValue>;
  };
  /** `billing payment ...`: payment methods. */
  readonly payment: {
    show(options?: CallOptions): Promise<JsonValue>;
    list(options?: CallOptions): Promise<JsonValue>;
    remove(ref: string, options?: CallOptions): Promise<JsonValue>;
    setDefault(ref: string, options?: CallOptions): Promise<JsonValue>;
  };

  constructor(private readonly ops: ExeOps) {
    const ref = async (path: string, value: string, options?: CallOptions) => {
      const checks = new Checks();
      checkWord(checks, ["ref"], value, "payment method reference");
      checks.done();
      return await ops.json({ path, args: [value] }, options);
    };
    this.credits = {
      show: (options) => ops.json({ path: "billing credits" }, options),
      usage: async (flags = {}, options) => {
        const checks = new Checks();
        if (flags.month !== undefined) {
          checkMonth(checks, ["month"], flags.month);
        }
        if (flags.group !== undefined) {
          checkChoice(checks, ["group"], flags.group, ["model", "day", "box"]);
        }
        checks.done();
        return await ops.json({
          path: "billing credits usage",
          flags: {
            "--month": flags.month,
            "--group": flags.group,
            "--detail": flags.detail,
          },
        }, options);
      },
      transactions: async (flags = {}, options) => {
        const checks = new Checks();
        if (flags.limit !== undefined) {
          checkInteger(checks, ["limit"], flags.limit, 1, 100);
        }
        checks.done();
        return await ops.json({
          path: "billing credits transactions",
          flags: { "--limit": flags.limit },
        }, options);
      },
      buy: async (dollars, flags = {}, options) => {
        const checks = new Checks();
        checkInteger(checks, ["dollars"], dollars, 1);
        if (flags.idempotencyKey !== undefined) {
          checkWord(checks, ["idempotencyKey"], flags.idempotencyKey, "key");
        }
        checks.done();
        return await ops.json({
          path: "billing credits buy",
          args: [dollars],
          flags: { "--yes": true, "--idempotency-key": flags.idempotencyKey },
          idempotent: flags.idempotencyKey !== undefined,
        }, options);
      },
    };
    this.payment = {
      show: (options) => ops.json({ path: "billing payment" }, options),
      list: (options) => ops.json({ path: "billing payment list" }, options),
      remove: (value, options) => ref("billing payment remove", value, options),
      setDefault: (value, options) =>
        ref("billing payment default", value, options),
    };
  }

  /** `billing`: an overview. */
  async show(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "billing" }, options);
  }

  /** `billing plan [--all]`: the plan and its limits, or the plans on offer. */
  async plan(
    flags: { readonly all?: boolean } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.ops.json({
      path: "billing plan",
      flags: { "--all": flags.all },
    }, options);
  }

  /** `billing usage [--range=...] [--group=vm]`. */
  async usage(
    flags: {
      readonly range?: "cycle" | "24h" | "7d" | "30d";
      readonly group?: "vm";
    } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    if (flags.range !== undefined) {
      checkChoice(checks, ["range"], flags.range, [
        "cycle",
        "24h",
        "7d",
        "30d",
      ]);
    }
    if (flags.group !== undefined) {
      checkChoice(checks, ["group"], flags.group, ["vm"]);
    }
    checks.done();
    return await this.ops.json({
      path: "billing usage",
      flags: { "--range": flags.range, "--group": flags.group },
    }, options);
  }

  /** `billing rewards`. */
  async rewards(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "billing rewards" }, options);
  }

  /**
   * `billing capacity [--cpu=N] --yes`: changes the plan's vCPU pool (2, 4, 8
   * or 16). Without `cpu` it reports the current capacity.
   */
  async capacity(
    cpu?: 2 | 4 | 8 | 16,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    if (cpu !== undefined && ![2, 4, 8, 16].includes(cpu)) {
      checks.add(["cpu"], "must be 2, 4, 8 or 16");
    }
    checks.done();
    return await this.ops.json({
      path: "billing capacity",
      flags: cpu === undefined ? {} : { "--cpu": cpu, "--yes": true },
      idempotent: cpu === undefined,
    }, options);
  }

  /** `billing manage`: a link to the billing page. */
  async manage(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "billing manage" }, options);
  }

  /** `billing update ...`: invoice contact details. */
  async update(
    contact: BillingContact,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    const flags = contactFlags(checks, contact);
    checks.done();
    return await this.ops.json({ path: "billing update", flags }, options);
  }

  /** `billing invoices`. */
  async invoices(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "billing invoices" }, options);
  }

  /** `billing receipts [--from] [--to]`, dates as YYYY-MM-DD. */
  async receipts(
    flags: { readonly from?: string; readonly to?: string } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.#period("billing receipts", flags, options);
  }

  /** `billing statement [--from] [--to]`. */
  async statement(
    flags: { readonly from?: string; readonly to?: string } = {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.#period("billing statement", flags, options);
  }

  async #period(
    path: string,
    flags: { readonly from?: string; readonly to?: string },
    options?: CallOptions,
  ) {
    const checks = new Checks();
    if (flags.from !== undefined) checkDate(checks, ["from"], flags.from);
    if (flags.to !== undefined) checkDate(checks, ["to"], flags.to);
    if (
      flags.from !== undefined && flags.to !== undefined &&
      flags.from > flags.to
    ) {
      checks.add(["to"], "is before from");
    }
    checks.done();
    return await this.ops.json({
      path,
      flags: { "--from": flags.from, "--to": flags.to },
    }, options);
  }

  /** `billing provider link <aws|azure> --token=... [--size] [--team-name]`. */
  async providerLink(
    provider: "aws" | "azure",
    settings: {
      readonly token: string;
      readonly size?: "small" | "medium" | "large" | "xlarge";
      readonly teamName?: string;
    },
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["provider"], provider, ["aws", "azure"]);
    checkWord(checks, ["token"], settings.token, "link token");
    if (settings.size !== undefined) {
      checkChoice(checks, ["size"], settings.size, [
        "small",
        "medium",
        "large",
        "xlarge",
      ]);
    }
    checks.done();
    return await this.ops.json({
      path: "billing provider link",
      args: [provider],
      flags: {
        "--token": settings.token,
        "--size": settings.size,
        "--team-name": settings.teamName,
      },
      secretFlags: ["--token"],
    }, options);
  }
}

/** An invite reward. */
export type InviteReward =
  | "standard"
  | "bonus-credits"
  | "extra-memory"
  | "extra-disk";

/** `invite` subcommands. */
export class InviteApi {
  constructor(private readonly ops: ExeOps) {}

  async show(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite show" }, options);
  }

  async link(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite link" }, options);
  }

  async rewards(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite rewards" }, options);
  }

  async setReward(
    reward: InviteReward,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkChoice(checks, ["reward"], reward, [
      "standard",
      "bonus-credits",
      "extra-memory",
      "extra-disk",
    ]);
    checks.done();
    return await this.ops.json(
      { path: "invite set-reward", args: [reward] },
      options,
    );
  }

  async activity(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite activity" }, options);
  }

  async request(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite request" }, options);
  }

  async manage(options?: CallOptions): Promise<JsonValue> {
    return await this.ops.json({ path: "invite manage" }, options);
  }
}

/** Shelley reasoning levels. */
export type ShelleyReasoning =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** `shelley` subcommands. */
export class ShelleyApi {
  constructor(private readonly ops: ExeOps) {}

  /** `shelley install <vm>`: installs or upgrades Shelley. */
  async install(vm: string, options?: CallOptions): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    checks.done();
    return await this.ops.json(
      { path: "shelley install", args: [vm] },
      options,
    );
  }

  /**
   * `shelley prompt [--model] [--reasoning] <vm> <prompt>`. The prompt may
   * not contain newlines (one command line); send longer prompts as a file
   * through `runOnVm`.
   */
  async prompt(
    vm: string,
    prompt: string,
    flags: { readonly model?: string; readonly reasoning?: ShelleyReasoning } =
      {},
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkVmName(checks, ["vm"], vm);
    if (prompt.trim() === "") checks.add(["prompt"], "must not be empty");
    if (flags.model !== undefined) {
      checkWord(checks, ["model"], flags.model, "model name");
    }
    if (flags.reasoning !== undefined) {
      checkChoice(checks, ["reasoning"], flags.reasoning, [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    checks.done();
    return await this.ops.json({
      path: "shelley prompt",
      args: [vm, prompt],
      flags: { "--model": flags.model, "--reasoning": flags.reasoning },
    }, options);
  }
}

/**
 * `defaults read|write|delete dev.exe <key>`, from the customization page
 * (outside the CLI reference). The docs show `write` reading the value from
 * stdin, which `/exec` does not have; this passes it as an argument instead,
 * and whether the lobby accepts that is not documented.
 */
export class DefaultsApi {
  constructor(private readonly ops: ExeOps) {}

  async read(
    key = "new.setup-script",
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.ops.json({
      path: "defaults read",
      args: ["dev.exe", checkedKey(key)],
    }, options);
  }

  async write(
    key: string,
    value: string,
    options?: CallOptions,
  ): Promise<JsonValue> {
    const checks = new Checks();
    checkBytes(checks, ["value"], value, 10 * 1024);
    checks.done();
    return await this.ops.json({
      path: "defaults write",
      args: ["dev.exe", checkedKey(key), encodeSetupScript(value)],
      allowEmptyArgs: true,
    }, options);
  }

  async delete(
    key = "new.setup-script",
    options?: CallOptions,
  ): Promise<JsonValue> {
    return await this.ops.json({
      path: "defaults delete",
      args: ["dev.exe", checkedKey(key)],
    }, options);
  }
}

function checkedKey(key: string): string {
  const checks = new Checks();
  if (!/^[a-z][a-z0-9.-]*$/.test(key)) {
    checks.add(["key"], "must be a defaults key such as new.setup-script");
  }
  checks.done();
  return key;
}

/**
 * A setup script as `new --setup-script` takes it on one line: the docs say
 * the flag "supports \n for newlines", so newlines become the two characters
 * `\n`. A script that already contains a literal backslash-n would then be
 * ambiguous, and is refused.
 */
export function encodeSetupScript(script: string): string {
  if (!script.includes("\n") && !script.includes("\r")) return script;
  if (script.includes("\\n")) {
    throw new ExeInvalidRequestError([{
      path: ["setupScript"],
      message:
        "contains both newlines and a literal \\n, which the lobby would confuse",
    }]);
  }
  if (/\r(?!\n)/.test(script)) {
    throw new ExeInvalidRequestError([{
      path: ["setupScript"],
      message: "contains a bare carriage return",
    }]);
  }
  return script.replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}
