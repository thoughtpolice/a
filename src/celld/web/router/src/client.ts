// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Browser-safe HTTP client. Worker imports are exclusively type-only. */
import { type Output, type SieveError, v } from "@celld/sieve";
import type {
  BrowserRoute,
  RegisteredRoutes,
  RouteRequest,
  RoutesOf,
  RouteSuccess,
} from "./contract.ts";
import { parsePattern } from "./path.ts";
export { defineRoute } from "./contract.ts";
export type {
  BrowserRoute,
  ContractOptions,
  RegisteredRoutes,
  RouteRequest,
  RoutesOf,
  RouteSuccess,
} from "./contract.ts";
export { parsePattern, splitPath, Trie } from "./path.ts";
export type { ParamNames, PathParams, Segment } from "./path.ts";

const errorSchema = v.looseObject({
  error: v.string(),
  message: v.string(),
  requestId: v.string(),
});
const validationSchema = v.object({
  error: v.literal("validation_failed"),
  message: v.string(),
  requestId: v.string(),
  location: v.enum(["params", "query", "body"]),
  formErrors: v.array(v.string()),
  fieldErrors: v.record(v.string(), v.array(v.string())),
  issues: v.array(
    v.object({
      path: v.array(v.union([v.string(), v.number()])),
      code: v.string(),
      message: v.string(),
    }),
  ),
});
export type RouterErrorBody = Output<typeof errorSchema>;
export type ValidationErrorBody = Output<typeof validationSchema>;

export type ClientFailure =
  | {
    readonly ok: false;
    readonly kind: "validation";
    readonly status: 400;
    readonly error: ValidationErrorBody;
    readonly response: Response;
  }
  | {
    readonly ok: false;
    readonly kind: "auth";
    readonly status: 401 | 403;
    readonly error: RouterErrorBody;
    readonly challenge: string | null;
    readonly response: Response;
  }
  | {
    readonly ok: false;
    readonly kind: "http";
    readonly status: number;
    readonly error: RouterErrorBody;
    readonly data: unknown;
    readonly response: Response;
  }
  | {
    readonly ok: false;
    readonly kind: "response";
    readonly status: number;
    readonly cause: unknown;
    readonly issues?: SieveError;
    readonly response: Response;
  }
  | {
    readonly ok: false;
    readonly kind: "transport" | "cancelled";
    readonly cause: unknown;
  }
  | { readonly ok: false; readonly kind: "request"; readonly cause: unknown };
export type ClientResult<D extends BrowserRoute> =
  | RouteSuccess<D>
  | ClientFailure;

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly credentials?: RequestCredentials;
  readonly headers?: HeadersInit;
}
export interface ClientOptions {
  /** Absolute HTTP(S) URL; its path is a deployment prefix for every route. */
  readonly baseUrl: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly credentials?: RequestCredentials;
  readonly headers?: HeadersInit;
}
export type BrowserContracts<R> = Readonly<
  Record<string, Extract<RoutesOf<R>, BrowserRoute>>
>;
export interface BrowserClient<
  C extends Readonly<Record<string, BrowserRoute>>,
> {
  call<K extends keyof C & string>(
    name: K,
    request: RouteRequest<C[K]> & CallOptions,
  ): Promise<ClientResult<C[K]>>;
}

type ClientBuilder<R> = <const C extends BrowserContracts<R>>(
  routes: C,
  options: ClientOptions,
) => BrowserClient<C>;

/** Infer directly from shared definitions, or use createClient<typeof app>() for registration checking. */
export function createClient<R extends RegisteredRoutes>(): ClientBuilder<R>;
export function createClient<
  const C extends Readonly<Record<string, BrowserRoute>>,
>(routes: C, options: ClientOptions): BrowserClient<C>;
export function createClient(
  routes?: Readonly<Record<string, BrowserRoute>>,
  options?: ClientOptions,
):
  | BrowserClient<Readonly<Record<string, BrowserRoute>>>
  | ClientBuilder<RegisteredRoutes> {
  if (routes === undefined) {
    return (definitions, settings) => makeClient(definitions, settings);
  }
  if (options === undefined) {
    throw new TypeError("createClient requires options");
  }
  return makeClient(routes, options);
}

function scalar(value: unknown): string {
  if (
    typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
  ) return String(value);
  throw new TypeError(
    "path, query and form values must be strings, booleans or finite numbers",
  );
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("params, query and form body must be records");
  }
  return value as Readonly<Record<string, unknown>>;
}
function fields(value: unknown): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, item] of Object.entries(record(value))) {
    if (item === undefined) continue;
    for (const entry of Array.isArray(item) ? item : [item]) {
      result.append(key, scalar(entry));
    }
  }
  return result;
}

function makeClient<const C extends Readonly<Record<string, BrowserRoute>>>(
  routes: C,
  options: ClientOptions,
): BrowserClient<C> {
  const base = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) || base.username ||
    base.password || base.search || base.hash
  ) {
    throw new TypeError(
      "baseUrl must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  const prefix = base.pathname.replace(/\/$/, "");
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const defaults = new Headers(options.headers);
  const definitions = Object.fromEntries(
    Object.entries(routes).map(([name, definition]) => [name, {
      definition,
      segments: parsePattern(definition.path),
    }]),
  );
  return {
    async call(name, request) {
      const entry = Object.hasOwn(definitions, name)
        ? definitions[name]
        : undefined;
      if (entry === undefined) throw new TypeError(`unknown route: ${name}`);
      const { definition, segments } = entry;
      let url: URL;
      let init: RequestInit;
      try {
        const params = record(request.params);
        const path = segments.map((segment) => {
          if (segment.kind === "static") return segment.value;
          const value = scalar(params[segment.name]);
          if (segment.kind === "param") {
            if (value === "") {
              throw new TypeError(`empty path parameter: ${segment.name}`);
            }
            if (value === "." || value === "..") {
              throw new TypeError(
                "dot path segments cannot be represented by Fetch URLs",
              );
            }
            return encodeURIComponent(value);
          }
          return value.split("/").map((part) => {
            if (part === "." || part === "..") {
              throw new TypeError(
                "dot path segments cannot be represented by Fetch URLs",
              );
            }
            return encodeURIComponent(part);
          }).join("/");
        }).join("/");
        url = new URL(base);
        url.pathname = `${prefix}/${path}`;
        url.search = fields(request.query).toString();
        const headers = new Headers(defaults);
        new Headers(request.headers).forEach((value, key) =>
          headers.set(key, value)
        );
        if (!headers.has("accept")) headers.set("accept", "application/json");
        let body: string | undefined;
        if (request.body !== undefined) {
          if (definition.options.bodyType === "form") {
            body = fields(request.body).toString();
            headers.set(
              "content-type",
              "application/x-www-form-urlencoded;charset=UTF-8",
            );
          } else {
            body = JSON.stringify(request.body);
            if (body === undefined) {
              throw new TypeError("body is not JSON serializable");
            }
            headers.set("content-type", "application/json");
          }
        }
        init = {
          method: definition.method,
          headers,
          body,
          signal: request.signal,
          credentials: request.credentials ?? options.credentials ??
            "same-origin",
          redirect: "manual",
        };
      } catch (cause) {
        return { ok: false, kind: "request", cause };
      }
      let response: Response;
      try {
        response = await send(url, init);
      } catch (cause) {
        return {
          ok: false,
          kind: request.signal?.aborted ? "cancelled" : "transport",
          cause,
        };
      }
      let readingBody = false;
      try {
        const declared = definition.options.responses;
        const status = response.status;
        if (response.ok) {
          const successKeys = Object.keys(declared ?? {}).filter((key) =>
            /^2\d\d$/.test(key)
          );
          if (
            successKeys.length
              ? !successKeys.includes(String(status))
              : status !== 200
          ) {
            throw new TypeError(`undeclared success status: ${status}`);
          }
          if (
            definition.method === "HEAD" || status === 204 || status === 205
          ) {
            return {
              ok: true,
              status,
              data: undefined,
              response,
            } as ClientResult<C[typeof name]>;
          }
          const schema = declared?.[status]?.schema ??
            definition.options.response;
          const json = schema !== undefined ||
            /\bjson\b/i.test(response.headers.get("content-type") ?? "");
          readingBody = true;
          const text = await response.text();
          readingBody = false;
          const value: unknown = json ? JSON.parse(text) : text;
          const parsed = await (schema ?? (json ? v.json() : v.string()))
            .safeParseAsync(value);
          if (!parsed.success) {
            return {
              ok: false,
              kind: "response",
              status,
              cause: parsed.error,
              issues: parsed.error,
              response,
            };
          }
          return {
            ok: true,
            status,
            data: parsed.data,
            response,
          } as ClientResult<C[typeof name]>;
        }
        readingBody = true;
        const text = await response.text();
        readingBody = false;
        const value: unknown = JSON.parse(text);
        const envelope = await errorSchema.safeParseAsync(value);
        if (!envelope.success) {
          return {
            ok: false,
            kind: "response",
            status,
            cause: envelope.error,
            issues: envelope.error,
            response,
          };
        }
        if (status === 400 && envelope.data.error === "validation_failed") {
          const parsed = await validationSchema.safeParseAsync(value);
          if (!parsed.success) {
            return {
              ok: false,
              kind: "response",
              status,
              cause: parsed.error,
              issues: parsed.error,
              response,
            };
          }
          return {
            ok: false,
            kind: "validation",
            status,
            error: parsed.data,
            response,
          };
        }
        if (status === 401 || status === 403) {
          return {
            ok: false,
            kind: "auth",
            status,
            error: envelope.data,
            challenge: response.headers.get("www-authenticate"),
            response,
          };
        }
        const schema = declared?.[status]?.schema ??
          declared?.default?.schema ?? v.json();
        const parsed = await schema.safeParseAsync(value);
        if (!parsed.success) {
          return {
            ok: false,
            kind: "response",
            status,
            cause: parsed.error,
            issues: parsed.error,
            response,
          };
        }
        return {
          ok: false,
          kind: "http",
          status,
          error: envelope.data,
          data: parsed.data,
          response,
        };
      } catch (cause) {
        if (request.signal?.aborted) {
          return { ok: false, kind: "cancelled", cause };
        }
        if (readingBody) return { ok: false, kind: "transport", cause };
        return {
          ok: false,
          kind: "response",
          status: response.status,
          cause,
          response,
        };
      }
    },
  };
}
