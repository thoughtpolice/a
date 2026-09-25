// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Both sides of exe.dev's HTTPS proxy in front of a VM (`https://<vm>.exe.xyz`).
 *
 * **On the VM** (a celld Worker serving the VM's port): {@link exeIdentity}
 * reads the headers the proxy adds, and {@link exeAuth} makes them an
 * `@celld/router` auth scheme. `X-ExeDev-UserID` and `X-ExeDev-Email`
 * name a logged-in user, or the token's owner for token requests;
 * `X-ExeDev-Token-Ctx` carries a token's signed `ctx` verbatim;
 * `X-Exedev-Source-Vm` names the calling VM of a VM-to-VM integration. The
 * proxy strips and sets these, so they are trustworthy **only for requests
 * that came through the proxy**: a server that is also reachable another way
 * (localhost, a tunnel) must not trust them there.
 *
 * **Calling a VM** from elsewhere: {@link VmEndpointClient} sends a VM token
 * (namespace `v0@<vm>.exe.xyz`) in `X-Exedev-Authorization: Bearer`, the
 * preferred form; {@link basicAuthorization} is the form `git` uses.
 *
 * @module
 */

import { parseIp } from "@celld/ip";
import type { AuthScheme } from "@celld/router";
import { ExeInvalidRequestError } from "./errors.ts";
import { type JsonValue, parseStrictJson } from "./json.ts";
import { base64Encode, joinCommandLine } from "./quote.ts";
import type { FetchLike } from "./runtime.ts";
import { globalFetch } from "./runtime.ts";
import type { TokenSource } from "./tokens.ts";

/** The identity headers exe.dev's proxy sets. */
export const IDENTITY_HEADERS = Object.freeze({
  userId: "x-exedev-userid",
  email: "x-exedev-email",
  tokenCtx: "x-exedev-token-ctx",
  sourceVm: "x-exedev-source-vm",
  authorization: "x-exedev-authorization",
});

/** What a request carried about who sent it. */
export interface ExeIdentity {
  /** A stable, unique user id; null for anonymous requests to a public VM. */
  readonly userId: string | null;
  readonly email: string | null;
  /** The token's `ctx`, exactly as signed; null without a token or ctx. */
  readonly tokenCtxRaw: string | null;
  /** `tokenCtxRaw` parsed; undefined when absent or not valid JSON. */
  readonly tokenCtx: JsonValue | undefined;
  /** The calling VM of a VM-to-VM (peer) integration. */
  readonly sourceVm: string | null;
  /**
   * `X-Forwarded-Proto`, `-Host` and the `-For` chain. Each hop of the chain
   * is an IP address in canonical form; hops that are not addresses are
   * dropped.
   */
  readonly forwarded: {
    readonly proto: string | null;
    readonly host: string | null;
    readonly for: readonly string[];
  };
}

function headersOf(input: Request | Headers): Headers {
  return input instanceof Headers ? input : input.headers;
}

/** Reads the identity headers of a request that came through the proxy. */
export function exeIdentity(input: Request | Headers): ExeIdentity {
  const headers = headersOf(input);
  const get = (name: string) => {
    const value = headers.get(name);
    return value === null || value.trim() === "" ? null : value.trim();
  };
  const ctxRaw = headers.get(IDENTITY_HEADERS.tokenCtx);
  let ctx: JsonValue | undefined;
  if (ctxRaw !== null && ctxRaw !== "") {
    const parsed = parseStrictJson(ctxRaw);
    ctx = parsed.ok ? parsed.value : undefined;
  }
  return {
    userId: get(IDENTITY_HEADERS.userId),
    email: get(IDENTITY_HEADERS.email),
    tokenCtxRaw: ctxRaw === "" ? null : ctxRaw,
    tokenCtx: ctx,
    sourceVm: get(IDENTITY_HEADERS.sourceVm),
    forwarded: {
      proto: get("x-forwarded-proto"),
      host: get("x-forwarded-host"),
      for: (headers.get("x-forwarded-for") ?? "").split(",").flatMap(
        (part) => {
          const ip = parseIp(part.trim());
          return ip === null ? [] : [ip.toString()];
        },
      ),
    },
  };
}

/** Whether the request came from a logged-in user or a token. */
export function isAuthenticated(identity: ExeIdentity): boolean {
  return identity.userId !== null;
}

/**
 * The login URL on a VM's own host: `/__exe.dev/login?redirect=<path>`.
 * {@link exeAuth} sends anonymous browsers there on routes that need a
 * login. `redirect` must be a path on the same host.
 */
export function loginPath(redirect = "/"): string {
  if (!redirect.startsWith("/") || redirect.startsWith("//")) {
    throw new ExeInvalidRequestError([{
      path: ["redirect"],
      message: "must be a path on this host",
    }]);
  }
  return `/__exe.dev/login?redirect=${encodeURIComponent(redirect)}`;
}

/** The logout path; POST to it to drop the login cookie for the VM's domain. */
export const LOGOUT_PATH = "/__exe.dev/logout";

/** Options for {@link exeAuth}. */
export interface ExeAuthOptions {
  /** The scheme's name, `Principal.scheme`; default `exe`. */
  readonly name?: string;
  /**
   * Whether an anonymous browser `GET` or `HEAD` (one whose `Accept`
   * prefers `text/html` to JSON) on a route that needs a login is sent to
   * the proxy's login page with a 302, keeping its path and query; default
   * true. Other anonymous requests get the router's 401.
   */
  readonly loginRedirect?: boolean;
}

/**
 * An `@celld/router` scheme for a Worker served behind exe.dev's HTTPS
 * proxy. The principal is the logged-in user (or the token's owner):
 * `subject` is `X-ExeDev-UserID`, and `claims` holds `email`, `tokenCtx`,
 * `tokenCtxRaw` and `sourceVm` as {@link exeIdentity} reads them. A request
 * without a user id is anonymous (null), so public routes still serve it.
 *
 * The scheme is `ambient`: the proxy's login is a cookie the browser sends
 * by itself, so the router's CSRF check applies to state-changing requests.
 * The Worker sees the VM's port, not `https://<vm>.exe.xyz`, so list that
 * origin in `csrf.trustedOrigins` for browsers that send `Origin` but not
 * `Sec-Fetch-Site`.
 *
 * **Only behind the proxy.** The proxy strips and sets these headers, so
 * they can be trusted only for requests that came through it. A Worker that
 * is also reachable another way (localhost, a tunnel, another VM's port)
 * would let anyone claim any user by sending the headers themselves.
 *
 * ```ts
 * const app = router({ auth: exeAuth() });
 * app.get("/me", (c) => c.json({ user: c.principal.subject }));
 * ```
 */
export function exeAuth(options: ExeAuthOptions = {}): AuthScheme {
  const redirect = options.loginRedirect ?? true;
  return {
    name: options.name ?? "exe",
    ambient: true,
    authenticate(c) {
      const identity = exeIdentity(c.req);
      if (identity.userId === null) return null;
      return {
        subject: identity.userId,
        claims: {
          email: identity.email,
          tokenCtx: identity.tokenCtx,
          tokenCtxRaw: identity.tokenCtxRaw,
          sourceVm: identity.sourceVm,
        },
      };
    },
    unauthenticated(c) {
      const method = c.req.method;
      if (
        !redirect || (method !== "GET" && method !== "HEAD") ||
        // A browser prefers HTML; curl's `*/*` and a missing Accept do not.
        c.accepts("application/json", "text/html") !== "text/html"
      ) {
        return null;
      }
      const path = c.url.pathname.startsWith("//") ? "/" : c.url.pathname;
      return new Response(null, {
        status: 302,
        headers: { location: loginPath(`${path}${c.url.search}`) },
      });
    },
    openapi: {
      type: "apiKey",
      in: "header",
      name: "X-ExeDev-UserID",
      description:
        "Set by exe.dev's HTTPS proxy for a logged-in user or a token's owner; log in at /__exe.dev/login.",
    },
  };
}

/**
 * Headers that stand in for the proxy during local development (the docs
 * use mitmdump for this): add them to requests to `localhost`.
 */
export function devIdentityHeaders(
  identity: {
    readonly userId: string;
    readonly email: string;
    readonly ctx?: JsonValue;
    readonly sourceVm?: string;
  },
): Record<string, string> {
  const out: Record<string, string> = {
    "X-ExeDev-UserID": identity.userId,
    "X-ExeDev-Email": identity.email,
  };
  if (identity.ctx !== undefined) {
    out["X-ExeDev-Token-Ctx"] = JSON.stringify(identity.ctx);
  }
  if (identity.sourceVm !== undefined) {
    out["X-Exedev-Source-Vm"] = identity.sourceVm;
  }
  return out;
}

/** An `Authorization: Basic` value carrying a token (the username is ignored). */
export function basicAuthorization(token: string, username = "exe"): string {
  return `Basic ${base64Encode(`${username}:${token}`)}`;
}

/** `https://<vm>.exe.xyz[:port]`; ports 3000-9999 are forwarded besides 443. */
export function vmOrigin(
  vm: string,
  port?: number,
  domain = "exe.xyz",
): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(vm)) {
    throw new ExeInvalidRequestError([{
      path: ["vm"],
      message: "must be a VM name",
    }]);
  }
  if (
    port !== undefined && port !== 443 &&
    !(Number.isInteger(port) && port >= 3000 && port <= 9999)
  ) {
    throw new ExeInvalidRequestError([{
      path: ["port"],
      message: "the proxy forwards 443 and 3000-9999 only",
    }]);
  }
  return `https://${vm}.${domain}${
    port === undefined || port === 443 ? "" : `:${port}`
  }`;
}

/** How to construct a {@link VmEndpointClient}. */
export interface VmEndpointClientOptions {
  readonly vm: string;
  /** A VM token (`v0@<vm>.exe.xyz`), or a source of them. */
  readonly token: string | TokenSource;
  readonly port?: number;
  readonly fetch?: FetchLike;
  /** Replaces `exe.xyz` (tests). */
  readonly domain?: string;
  /** Replaces the whole origin (tests). */
  readonly origin?: string;
}

/**
 * Calls a VM's HTTPS endpoints through the proxy with a VM token in
 * `X-Exedev-Authorization`, which the proxy consumes and strips. Returns raw
 * responses: the VM's own API decides what they mean.
 */
export class VmEndpointClient {
  readonly origin: string;
  readonly #tokens: TokenSource;
  readonly #fetch: FetchLike;

  constructor(options: VmEndpointClientOptions) {
    this.origin =
      (options.origin ?? vmOrigin(options.vm, options.port, options.domain))
        .replace(/\/+$/, "");
    this.#tokens = typeof options.token === "string"
      ? { token: () => Promise.resolve(options.token as string) }
      : options.token;
    this.#fetch = options.fetch ?? globalFetch;
  }

  /** Sends a request to `path` on the VM. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/")) {
      throw new ExeInvalidRequestError([{
        path: ["path"],
        message: "must start with /",
      }]);
    }
    const headers = new Headers(init.headers);
    headers.set(
      "X-Exedev-Authorization",
      `Bearer ${await this.#tokens.token()}`,
    );
    return await this.#fetch(`${this.origin}${path}`, { ...init, headers });
  }
}

/**
 * `https://exe.dev/suggest?command=...`: a page that shows a person one
 * command to review and approve, for actions an agent should not take on
 * its own. `preflight` asks whether the command can be suggested (200) without
 * showing it.
 */
export function suggestLink(
  words: readonly string[] | string,
  options: { readonly preflight?: boolean } = {},
): string {
  const command = typeof words === "string" ? words : joinCommandLine(words);
  const query = new URLSearchParams({ command });
  if (options.preflight) query.set("preflight", "1");
  return `https://exe.dev/suggest?${query}`;
}

/**
 * `https://exe.dev/new?...`: the "Deploy on exe.dev" / "Build with Shelley"
 * link, pre-filled with a repository, prompt and tags.
 */
export function newVmLink(
  options: {
    readonly repo?: string;
    readonly prompt?: string;
    readonly tags?: readonly string[];
  },
): string {
  const query = new URLSearchParams();
  if (options.repo !== undefined) query.set("repo", options.repo);
  if (options.prompt !== undefined) query.set("prompt", options.prompt);
  if (options.tags !== undefined && options.tags.length > 0) {
    query.set("tags", options.tags.join(","));
  }
  return `https://exe.dev/new${query.size === 0 ? "" : `?${query}`}`;
}

/**
 * `https://exe.dev/integrations/add?service=<handle>&...`: pre-fills the add
 * dialog for a person; credentials never go in the link.
 */
export function integrationAddLink(
  service: string,
  options: {
    readonly attach?: string;
    readonly for?: string;
    readonly source?: string;
  } = {},
): string {
  const query = new URLSearchParams({ service });
  if (options.attach !== undefined) query.set("attach", options.attach);
  if (options.for !== undefined) query.set("for", options.for);
  if (options.source !== undefined) query.set("source", options.source);
  return `https://exe.dev/integrations/add?${query}`;
}
