// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake's Cloudflare Tunnel: tunnels, their tokens and remotely managed
 * configurations, and connectors a test attaches with `connect`. See
 * `FakeCloudflare.tunnels`.
 *
 * It refuses a second live tunnel of one name, a configuration for a
 * locally managed tunnel, an ingress list whose last rule does not match
 * everything, and deleting a tunnel with connectors attached. The token
 * is Cloudflare's format: base64 of `{"a": account, "t": tunnel, "s":
 * secret}`.
 *
 * @module
 */

import type { FakeCloudflare } from "./testing.ts";
import type {
  Tunnel,
  TunnelConfig,
  TunnelConfiguration,
  TunnelConnector,
} from "./tunnels.ts";

interface Stored {
  tunnel: Tunnel;
  secret: string;
  configuration: TunnelConfiguration;
  connectors: Map<string, TunnelConnector>;
}

const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

export class FakeTunnels {
  readonly #fake: FakeCloudflare;
  readonly #tunnels = new Map<string, Stored>();
  #serial = 0;

  constructor(fake: FakeCloudflare) {
    this.#fake = fake;
    this.#routes();
  }

  /** The tunnel, as the API would describe it now. */
  tunnel(tunnelId: string): Tunnel | undefined {
    const stored = this.#tunnels.get(tunnelId);
    return stored === undefined ? undefined : this.#describe(stored);
  }

  /** The tunnel's configuration. */
  configuration(tunnelId: string): TunnelConfiguration | undefined {
    return this.#tunnels.get(tunnelId)?.configuration;
  }

  /**
   * Attaches a connector, as a `cloudflared` started with the tunnel's
   * token would; returns its client id.
   */
  connect(tunnelId: string, colo = "DFW"): string {
    const stored = this.#tunnels.get(tunnelId);
    if (stored === undefined) throw new Error(`no tunnel ${tunnelId}`);
    const id = this.#uuid();
    stored.connectors.set(id, {
      id,
      version: "2026.9.0",
      arch: "linux_amd64",
      run_at: this.#fake.timestamp(),
      config_version: stored.configuration.version,
      conns: [0, 1].map((n) => ({
        id: this.#uuid(),
        colo_name: `${colo}${n}`,
        client_id: id,
        client_version: "2026.9.0",
        origin_ip: "198.51.100.7",
        opened_at: this.#fake.timestamp(),
        is_pending_reconnect: false,
      })),
    });
    return id;
  }

  /** Detaches a connector, as stopping its `cloudflared` would. */
  disconnect(tunnelId: string, clientId: string): void {
    this.#tunnels.get(tunnelId)?.connectors.delete(clientId);
  }

  #uuid(): string {
    this.#serial++;
    const hex = this.#serial.toString(16).padStart(12, "0");
    return `c10dfa1e-0000-4000-8000-${hex}`;
  }

  /** The tunnel without `connections`, which Cloudflare drops on 2026-10-05. */
  #describe(stored: Stored): Tunnel {
    const connected = stored.connectors.size > 0;
    return {
      ...stored.tunnel,
      status: stored.tunnel.deleted_at
        ? "down"
        : connected
        ? "healthy"
        : "inactive",
    };
  }

  #routes(): void {
    const fake = this.#fake;
    const { ok, error } = fake.answers;
    const base = `/accounts/${fake.accountId}/cfd_tunnel`;
    const live = () =>
      [...this.#tunnels.values()].filter((stored) => !stored.tunnel.deleted_at);
    const find = (id: string) => this.#tunnels.get(id);
    const missing = () => error(404, 1003, "Tunnel not found");

    fake.route("GET", base, (request) => {
      const q = request.query;
      const list = [...this.#tunnels.values()].filter((stored) =>
        (q.get("is_deleted") !== "false" || !stored.tunnel.deleted_at) &&
        (q.get("name") === null || stored.tunnel.name === q.get("name")) &&
        (q.get("uuid") === null || stored.tunnel.id === q.get("uuid"))
      ).map((stored) => this.#describe(stored)).filter((tunnel) =>
        q.get("status") === null || tunnel.status === q.get("status")
      );
      return fake.paged(list, q, 20, 1000);
    });
    fake.route("POST", base, (request) => {
      const body = request.body as {
        name?: string;
        config_src?: string;
        tunnel_secret?: string;
      } | null;
      if (typeof body?.name !== "string" || body.name === "") {
        return error(400, 1000, "Tunnel name is required");
      }
      if (live().some((stored) => stored.tunnel.name === body.name)) {
        return error(409, 1013, "You already have a tunnel with this name");
      }
      const id = this.#uuid();
      const configSrc = body.config_src === "local" ? "local" : "cloudflare";
      const stored: Stored = {
        tunnel: {
          id,
          name: body.name,
          account_tag: fake.accountId,
          created_at: fake.timestamp(),
          deleted_at: null,
          remote_config: configSrc === "cloudflare",
          config_src: configSrc,
          tun_type: "cfd_tunnel",
          metadata: {},
        },
        secret: body.tunnel_secret ??
          btoa(String.fromCharCode(...new Uint8Array(32).fill(this.#serial))),
        configuration: {
          tunnel_id: id,
          version: 0,
          config: null,
          source: configSrc,
          created_at: fake.timestamp(),
        },
        connectors: new Map(),
      };
      this.#tunnels.set(id, stored);
      return ok(this.#describe(stored));
    });
    fake.route("GET", `${base}/${UUID}`, (_request, [id]) => {
      const stored = find(id);
      return stored ? ok(this.#describe(stored)) : missing();
    });
    fake.route("PATCH", `${base}/${UUID}`, (request, [id]) => {
      const stored = find(id);
      if (stored === undefined || stored.tunnel.deleted_at) return missing();
      const body = request.body as { name?: string; tunnel_secret?: string };
      if (body?.name !== undefined) {
        stored.tunnel = { ...stored.tunnel, name: body.name };
      }
      if (body?.tunnel_secret !== undefined) stored.secret = body.tunnel_secret;
      return ok(this.#describe(stored));
    });
    fake.route("DELETE", `${base}/${UUID}`, (_request, [id]) => {
      const stored = find(id);
      if (stored === undefined || stored.tunnel.deleted_at) return missing();
      if (stored.connectors.size > 0) {
        return error(
          400,
          1022,
          "Cannot delete tunnel because it has active connections",
        );
      }
      stored.tunnel = { ...stored.tunnel, deleted_at: fake.timestamp() };
      return ok(this.#describe(stored));
    });
    fake.route("GET", `${base}/${UUID}/token`, (_request, [id]) => {
      const stored = find(id);
      if (stored === undefined || stored.tunnel.deleted_at) return missing();
      return ok(
        btoa(JSON.stringify({ a: fake.accountId, t: id, s: stored.secret })),
      );
    });
    fake.route("GET", `${base}/${UUID}/connections`, (_request, [id]) => {
      const stored = find(id);
      return stored ? ok([...stored.connectors.values()]) : missing();
    });
    fake.route("DELETE", `${base}/${UUID}/connections`, (request, [id]) => {
      const stored = find(id);
      if (stored === undefined) return missing();
      const client = request.query.get("client_id");
      if (client === null) stored.connectors.clear();
      else stored.connectors.delete(client);
      return ok(null);
    });
    fake.route("GET", `${base}/${UUID}/configurations`, (_request, [id]) => {
      const stored = find(id);
      return stored ? ok(stored.configuration) : missing();
    });
    fake.route("PUT", `${base}/${UUID}/configurations`, (request, [id]) => {
      const stored = find(id);
      if (stored === undefined || stored.tunnel.deleted_at) return missing();
      if (!stored.tunnel.remote_config) {
        return error(
          400,
          1056,
          "This tunnel is managed locally; its configuration is cloudflared's",
        );
      }
      const config = (request.body as { config?: TunnelConfig } | null)?.config;
      const ingress = config?.ingress;
      const last = ingress?.[ingress.length - 1];
      if (
        !Array.isArray(ingress) || last === undefined ||
        last.hostname !== undefined || last.path !== undefined
      ) {
        return error(
          400,
          1055,
          "The last ingress rule must match all URLs (no hostname or path)",
        );
      }
      stored.configuration = {
        ...stored.configuration,
        version: stored.configuration.version + 1,
        // Checked above: a config with an ingress list.
        config: config as TunnelConfig,
        created_at: fake.timestamp(),
      };
      return ok(stored.configuration);
    });
  }
}
