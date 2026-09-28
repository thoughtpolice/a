// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/cloudflare/tunnels`: Cloudflare Tunnel (`cfd_tunnel`):
 * creating tunnels, the token `cloudflared` runs with, the ingress
 * configuration Cloudflare holds for remotely managed tunnels, and the DNS
 * records that send a hostname to one.
 *
 * ```ts
 * const tunnels = new Tunnels(cf, accountId);
 * const tunnel = await tunnels.create({ name: "web" });
 * const token = await tunnels.token(tunnel.id); // cloudflared tunnel run --token <token>
 * await tunnels.publish(tunnel.id, {
 *   hostname: "app.example.com",
 *   service: "http://localhost:8080",
 *   zoneId,
 * });
 * ```
 *
 * A token for this area needs `Account > Cloudflare Tunnel > Edit` (reading
 * a tunnel's token too), and `Zone > DNS > Edit` for {@link Tunnels.publish}.
 * A `<id>.cfargotunnel.com` CNAME only works in the tunnel's own account.
 *
 * @module
 */

import type {
  CloudflareClient,
  ListOptions,
  RequestOptions,
} from "./client.ts";
import { CloudflareError } from "./errors.ts";
import { cloudflareId, uuid } from "./ids.ts";
import { type DnsRecord, DnsRecords } from "./zones.ts";

type Call = Omit<RequestOptions, "body" | "query">;

/** A tunnel, as Cloudflare describes it. */
export interface Tunnel {
  readonly id: string;
  readonly name: string;
  readonly account_tag?: string;
  readonly created_at?: string;
  readonly deleted_at?: string | null;
  /** `inactive` until a connector runs; then `healthy`, `degraded` or `down`. */
  readonly status?: "inactive" | "degraded" | "healthy" | "down" | string;
  /** Whether Cloudflare holds its configuration (`config_src: "cloudflare"`). */
  readonly remote_config?: boolean;
  readonly config_src?: "cloudflare" | "local" | string;
  /**
   * Deprecated: Cloudflare stops sending it on 2026-10-05; use
   * {@link Tunnels.connections}.
   */
  readonly connections?: readonly TunnelConnection[];
  readonly conns_active_at?: string | null;
  readonly conns_inactive_at?: string | null;
  readonly tun_type?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** One connection from a connector to a Cloudflare data center. */
export interface TunnelConnection {
  readonly id?: string;
  readonly colo_name?: string;
  readonly client_id?: string;
  readonly client_version?: string;
  readonly origin_ip?: string;
  readonly opened_at?: string;
  readonly is_pending_reconnect?: boolean;
  readonly [field: string]: unknown;
}

/** A connector (a running `cloudflared`) and its connections. */
export interface TunnelConnector {
  readonly id: string;
  readonly version?: string;
  readonly arch?: string;
  readonly run_at?: string;
  readonly config_version?: number;
  readonly conns?: readonly TunnelConnection[];
  readonly [field: string]: unknown;
}

/** Which tunnels {@link Tunnels.list} returns. */
export interface TunnelFilter {
  readonly name?: string;
  /** Default false: deleted tunnels are left out. */
  readonly includeDeleted?: boolean;
  readonly status?: "inactive" | "degraded" | "healthy" | "down";
  readonly uuid?: string;
}

/** A new tunnel. */
export interface TunnelInput {
  readonly name: string;
  /**
   * `cloudflare` (the default here): Cloudflare holds the ingress rules,
   * set with {@link Tunnels.configure}. `local`: `cloudflared` reads them
   * from its own config file.
   */
  readonly config_src?: "cloudflare" | "local";
  /**
   * The tunnel's secret, 32 or more random bytes in base64. Left out,
   * Cloudflare makes one.
   */
  readonly tunnel_secret?: string;
}

/** Options for reaching an origin, as `cloudflared` names them; times in seconds. */
export interface OriginRequest {
  /** Seconds to wait for a connection to the origin (default 30). */
  readonly connectTimeout?: number;
  readonly tlsTimeout?: number;
  readonly tcpKeepAlive?: number;
  readonly keepAliveConnections?: number;
  readonly keepAliveTimeout?: number;
  readonly noHappyEyeballs?: boolean;
  readonly httpHostHeader?: string;
  readonly originServerName?: string;
  /** Sends each request's host as the TLS server name, over `originServerName`. */
  readonly matchSNItoHost?: boolean;
  /** A path on the connector's host. */
  readonly caPool?: string;
  /** Skips checking the origin's certificate: only for origins you control. */
  readonly noTLSVerify?: boolean;
  readonly disableChunkedEncoding?: boolean;
  readonly http2Origin?: boolean;
  readonly proxyType?: "" | "socks";
  readonly access?: {
    readonly required?: boolean;
    readonly teamName: string;
    readonly audTag: readonly string[];
  };
  readonly [option: string]: unknown;
}

/** One ingress rule: requests for `hostname` (and `path`) go to `service`. */
export interface IngressRule {
  /** Left out on the last, catch-all rule. `*.example.com` matches subdomains. */
  readonly hostname?: string;
  /** A regular expression over the request path. */
  readonly path?: string;
  /**
   * Where matching requests go: `http://localhost:8080`, `https://...`,
   * `tcp://`, `ssh://`, `rdp://`, `smb://`, `unix:/path`, `unix+tls:/path`,
   * `http_status:404` or `bastion` (and `hello_world`, for locally managed
   * tunnels only).
   */
  readonly service: string;
  readonly originRequest?: OriginRequest;
}

/** A remotely managed tunnel's configuration. */
export interface TunnelConfig {
  /** The rules in order; the last must match everything. */
  readonly ingress: readonly IngressRule[];
  /** Defaults for every rule, each rule's own overriding them. */
  readonly originRequest?: OriginRequest;
}

/** The configuration as Cloudflare stores it. */
export interface TunnelConfiguration {
  readonly tunnel_id: string;
  readonly version: number;
  readonly config:
    | (TunnelConfig & {
      /** Read-only: on when the tunnel has a private network route. */
      readonly "warp-routing"?: { readonly enabled?: boolean };
    })
    | null;
  readonly source?: "cloudflare" | "local" | string;
  readonly created_at?: string;
  readonly [field: string]: unknown;
}

/** What {@link Tunnels.publish} does. */
export interface PublishInput {
  readonly hostname: string;
  readonly service: string;
  readonly path?: string;
  readonly originRequest?: OriginRequest;
  /** The zone the hostname is in, for its CNAME. */
  readonly zoneId: string;
}

const SERVICE =
  /^(?:(?:https?|tcp|ssh|rdp|smb|unix|unix\+tls|socks5):\S+|http_status:[1-5][0-9]{2}|hello_world|bastion)$/;
const HOSTNAME =
  /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;

/** The hostname a tunnel's CNAME records point at. */
export function tunnelTarget(tunnelId: string): string {
  return `${uuid(tunnelId, "tunnelId")}.cfargotunnel.com`;
}

/**
 * Checks an ingress list as `cloudflared` would: every rule has a
 * service it knows, every rule but the last matches a hostname (or a
 * path), and the last matches everything. With `remote`, for a
 * configuration Cloudflare holds, `hello_world` is refused too.
 *
 * @throws {TypeError} naming the rule.
 */
export function checkIngress(
  ingress: readonly IngressRule[],
  options: { readonly remote?: boolean } = {},
): void {
  if (!Array.isArray(ingress) || ingress.length === 0) {
    throw new TypeError(
      'ingress needs at least one rule, the catch-all (such as { service: "http_status:404" })',
    );
  }
  ingress.forEach((rule, index) => {
    const where = `ingress[${index}]`;
    if (rule === null || typeof rule !== "object") {
      throw new TypeError(`${where} must be an object`);
    }
    if (typeof rule.service !== "string" || !SERVICE.test(rule.service)) {
      throw new TypeError(
        `${where}.service ${
          JSON.stringify(rule.service)
        } is not a service cloudflared knows`,
      );
    }
    if (options.remote && rule.service === "hello_world") {
      throw new TypeError(
        `${where}.service hello_world only runs in locally managed tunnels`,
      );
    }
    if (rule.hostname !== undefined && !HOSTNAME.test(rule.hostname)) {
      throw new TypeError(`${where}.hostname is not a hostname`);
    }
    if (rule.path !== undefined) {
      try {
        new RegExp(rule.path);
      } catch {
        throw new TypeError(`${where}.path is not a regular expression`);
      }
    }
    const last = index === ingress.length - 1;
    const catchAll = rule.hostname === undefined && rule.path === undefined;
    if (last && !catchAll) {
      throw new TypeError(
        `the last ingress rule must match everything (no hostname, no path); add { service: "http_status:404" }`,
      );
    }
    if (!last && catchAll) {
      throw new TypeError(
        `${where} matches everything, so the rules after it never run`,
      );
    }
  });
}

/** An account's tunnels. */
export class Tunnels {
  readonly #client: CloudflareClient;
  readonly accountId: string;

  constructor(client: CloudflareClient, accountId: string) {
    this.#client = client;
    this.accountId = cloudflareId(accountId, "accountId");
  }

  get #base(): string {
    return `/accounts/${this.accountId}/cfd_tunnel`;
  }

  async list(
    filter: TunnelFilter = {},
    options?: ListOptions,
  ): Promise<Tunnel[]> {
    const tunnels = await this.#client.list<Tunnel>(this.#base, {
      name: filter.name,
      is_deleted: filter.includeDeleted ? undefined : false,
      status: filter.status,
      uuid: filter.uuid === undefined ? undefined : uuid(filter.uuid, "uuid"),
    }, options);
    return tunnels.map(checkTunnel);
  }

  async get(tunnelId: string, options?: Call): Promise<Tunnel> {
    return checkTunnel(
      await this.#client.result("GET", this.#tunnel(tunnelId), options),
    );
  }

  /** The live tunnel named `name`, or null. */
  async byName(name: string, options?: Call): Promise<Tunnel | null> {
    const found = await this.list({ name }, { ...options, maxItems: 100 });
    return found.find((tunnel) => tunnel.name === name) ?? null;
  }

  /**
   * Creates a tunnel, remotely managed unless `config_src` says `local`.
   * Not retried: a second one of the same name would be refused, but a
   * lost answer can still leave the first behind (see {@link byName}).
   */
  async create(input: TunnelInput, options?: Call): Promise<Tunnel> {
    if (
      typeof input.name !== "string" || input.name === "" ||
      input.name.length > 256
    ) {
      throw new TypeError("name must be 1 to 256 characters");
    }
    const body: Record<string, unknown> = {
      name: input.name,
      config_src: input.config_src ?? "cloudflare",
    };
    if (input.tunnel_secret !== undefined) {
      body.tunnel_secret = tunnelSecret(input.tunnel_secret);
    }
    return checkTunnel(
      await this.#client.result("POST", this.#base, { ...options, body }),
    );
  }

  /** Renames a tunnel, or gives it a new secret. */
  async edit(
    tunnelId: string,
    edit: { readonly name?: string; readonly tunnel_secret?: string },
    options?: Call,
  ): Promise<Tunnel> {
    const body: Record<string, unknown> = {};
    if (edit.name !== undefined) body.name = edit.name;
    if (edit.tunnel_secret !== undefined) {
      body.tunnel_secret = tunnelSecret(edit.tunnel_secret);
    }
    return checkTunnel(
      await this.#client.result("PATCH", this.#tunnel(tunnelId), {
        ...options,
        body,
      }),
    );
  }

  /**
   * Deletes a tunnel. Cloudflare refuses while connectors are connected;
   * stop them, or {@link cleanupConnections} first.
   */
  async delete(tunnelId: string, options?: Call): Promise<Tunnel> {
    return checkTunnel(
      await this.#client.result("DELETE", this.#tunnel(tunnelId), options),
    );
  }

  /**
   * The token `cloudflared tunnel run --token <token>` runs the tunnel
   * with. It is a credential: anyone holding it can serve the tunnel's
   * hostnames.
   */
  async token(tunnelId: string, options?: Call): Promise<string> {
    const token = await this.#client.result<unknown>(
      "GET",
      `${this.#tunnel(tunnelId)}/token`,
      options,
    );
    if (typeof token !== "string" || token === "") {
      throw new CloudflareError("response", "the tunnel token is not a string");
    }
    return token;
  }

  /** The connectors running the tunnel. */
  async connections(
    tunnelId: string,
    options?: Call,
  ): Promise<TunnelConnector[]> {
    const connectors = await this.#client.result<unknown>(
      "GET",
      `${this.#tunnel(tunnelId)}/connections`,
      options,
    );
    if (!Array.isArray(connectors)) {
      throw new CloudflareError("response", "connections are not a list");
    }
    return connectors as TunnelConnector[];
  }

  /**
   * Drops stale connections (all of them, or one connector's by
   * `clientId`), as `cloudflared tunnel cleanup` does.
   */
  async cleanupConnections(
    tunnelId: string,
    options: Call & { readonly clientId?: string } = {},
  ): Promise<void> {
    const { clientId, ...call } = options;
    await this.#client.result(
      "DELETE",
      `${this.#tunnel(tunnelId)}/connections`,
      {
        ...call,
        query: {
          client_id: clientId === undefined
            ? undefined
            : uuid(clientId, "clientId"),
        },
      },
    );
  }

  /** A remotely managed tunnel's configuration. */
  async configuration(
    tunnelId: string,
    options?: Call,
  ): Promise<TunnelConfiguration> {
    return checkConfiguration(
      await this.#client.result(
        "GET",
        `${this.#tunnel(tunnelId)}/configurations`,
        options,
      ),
    );
  }

  /**
   * Replaces a remotely managed tunnel's configuration; running
   * connectors pick it up without a restart. The ingress rules are
   * checked first (see {@link checkIngress}).
   */
  async configure(
    tunnelId: string,
    config: TunnelConfig,
    options?: Call,
  ): Promise<TunnelConfiguration> {
    checkIngress(config?.ingress, { remote: true });
    // `warp-routing` is Cloudflare's to set; a configuration read back and
    // written again leaves it out.
    const { "warp-routing": _readOnly, ...writable } = config as
      & TunnelConfig
      & {
        "warp-routing"?: unknown;
      };
    return checkConfiguration(
      await this.#client.result(
        "PUT",
        `${this.#tunnel(tunnelId)}/configurations`,
        { ...options, body: { config: writable } },
      ),
    );
  }

  /**
   * Serves `hostname` from the tunnel: its ingress rule goes in (replacing
   * one for the same hostname and path, ahead of the catch-all), then a
   * proxied CNAME to the tunnel is made the name's one record.
   *
   * The two steps are separate requests. When the second fails the rule
   * is in place without DNS, and calling `publish` again finishes it.
   */
  async publish(
    tunnelId: string,
    input: PublishInput,
    options?: Call,
  ): Promise<{ configuration: TunnelConfiguration; record: DnsRecord }> {
    const rule: IngressRule = {
      hostname: input.hostname,
      service: input.service,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.originRequest === undefined
        ? {}
        : { originRequest: input.originRequest }),
    };
    checkIngress([rule, { service: "http_status:404" }], { remote: true });
    const dns = new DnsRecords(this.#client, input.zoneId);
    const current = await this.configuration(tunnelId, options);
    const ingress = current.config?.ingress ?? [];
    const kept = ingress.filter((existing) =>
      !(existing.hostname === rule.hostname && existing.path === rule.path)
    );
    const catchAll = kept.length > 0 &&
        kept[kept.length - 1].hostname === undefined &&
        kept[kept.length - 1].path === undefined
      ? kept.pop()!
      : { service: "http_status:404" };
    const configuration = await this.configure(tunnelId, {
      ...(current.config ?? {}),
      ingress: [...kept, rule, catchAll],
    }, options);
    const { record } = await dns.upsert({
      type: "CNAME",
      name: input.hostname,
      content: tunnelTarget(tunnelId),
      proxied: true,
      comment: `cloudflare tunnel ${tunnelId}`,
    }, options);
    return { configuration, record };
  }

  /**
   * Stops serving `hostname`: removes its ingress rules and, when it
   * points at this tunnel, its CNAME.
   */
  async unpublish(
    tunnelId: string,
    input: { readonly hostname: string; readonly zoneId: string },
    options?: Call,
  ): Promise<void> {
    const current = await this.configuration(tunnelId, options);
    const ingress = current.config?.ingress ?? [];
    const kept = ingress.filter((rule) => rule.hostname !== input.hostname);
    if (kept.length !== ingress.length) {
      await this.configure(
        tunnelId,
        { ...current.config!, ingress: kept },
        options,
      );
    }
    const dns = new DnsRecords(this.#client, input.zoneId);
    for (const record of await dns.find(input.hostname, "CNAME", options)) {
      if (record.content === tunnelTarget(tunnelId)) {
        await dns.delete(record.id, options);
      }
    }
  }

  #tunnel(tunnelId: string): string {
    return `${this.#base}/${uuid(tunnelId, "tunnelId")}`;
  }
}

function tunnelSecret(secret: string): string {
  let bytes: number;
  try {
    bytes = atob(secret).length;
  } catch {
    throw new TypeError("tunnel_secret must be base64");
  }
  if (bytes < 32) {
    throw new TypeError("tunnel_secret must be at least 32 random bytes");
  }
  return secret;
}

function checkTunnel(value: unknown): Tunnel {
  if (
    value === null || typeof value !== "object" ||
    typeof (value as Tunnel).id !== "string" ||
    typeof (value as Tunnel).name !== "string"
  ) {
    throw new CloudflareError("response", "a tunnel without an id and a name");
  }
  return value as Tunnel;
}

function checkConfiguration(value: unknown): TunnelConfiguration {
  if (value === null || typeof value !== "object") {
    throw new CloudflareError(
      "response",
      "a tunnel configuration is not an object",
    );
  }
  const config = (value as TunnelConfiguration).config;
  if (
    config !== null && config !== undefined &&
    (typeof config !== "object" ||
      (config.ingress !== undefined && !Array.isArray(config.ingress)))
  ) {
    throw new CloudflareError(
      "response",
      "a tunnel configuration without ingress rules",
    );
  }
  return value as TunnelConfiguration;
}
