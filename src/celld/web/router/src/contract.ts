// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Schema-only route definitions shared by a Worker and its browser client. */
import type { AnySchema, Input, Output } from "@celld/sieve";
import { RouterError } from "./errors.ts";
import { parsePattern, type PathParams } from "./path.ts";
import type { RouteOptions } from "./router.ts";

/** Only wire schemas and encoding metadata; never handlers or auth settings. */
export type ContractOptions = Pick<
  RouteOptions,
  "params" | "query" | "body" | "bodyType" | "response" | "responses"
>;

export interface BrowserRoute<
  M extends string = string,
  P extends string = string,
  O extends ContractOptions = ContractOptions,
> {
  readonly method: M;
  readonly path: P;
  readonly options: O;
}

/** Define once, then pass this same definition to Router.register and createClient. */
export function defineRoute<
  const M extends string,
  const P extends string,
  const O extends ContractOptions = Record<never, never>,
>(
  method: M,
  path: P,
  options: O & Record<Exclude<keyof O, keyof ContractOptions>, never> = {} as
    & O
    & Record<Exclude<keyof O, keyof ContractOptions>, never>,
): BrowserRoute<M, P, O> {
  if (
    !/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/.test(method) || method === "TRACE" ||
    method === "CONNECT"
  ) {
    throw new RouterError(`not a supported upper-case method: ${method}`);
  }
  parsePattern(path);
  const allowed = [
    "params",
    "query",
    "body",
    "bodyType",
    "response",
    "responses",
  ];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new RouterError(`not a contract option: ${key}`);
    }
  }
  const responses = options.responses === undefined ? undefined : Object.freeze(
    Object.fromEntries(
      Object.entries(options.responses).map(([status, entry]) => [
        status,
        Object.freeze({
          description: entry.description,
          ...(entry.schema === undefined ? {} : { schema: entry.schema }),
        }),
      ]),
    ),
  );
  return Object.freeze({
    method,
    path,
    options: Object.freeze({
      ...options,
      ...(responses === undefined ? {} : { responses }),
    }) as O,
  });
}

type SchemaOf<O, K extends string> = O extends
  { readonly [P in K]: infer S extends AnySchema } ? S : never;
type RequestField<O, K extends string> = [SchemaOf<O, K>] extends [never]
  ? { readonly [P in K]?: never }
  : undefined extends Input<SchemaOf<O, K>>
    ? { readonly [P in K]?: Input<SchemaOf<O, K>> }
  : { readonly [P in K]: Input<SchemaOf<O, K>> };

/** Values sent on the wire, before the server's Sieve coercions/transforms. */
export type RouteRequest<D extends BrowserRoute> =
  & ([SchemaOf<D["options"], "params">] extends [never]
    ? keyof PathParams<D["path"]> extends never ? { readonly params?: never }
    : { readonly params: PathParams<D["path"]> }
    : RequestField<D["options"], "params">)
  & ([SchemaOf<D["options"], "query">] extends [never]
    ? { readonly query?: Readonly<Record<string, string | readonly string[]>> }
    : RequestField<D["options"], "query">)
  & ([SchemaOf<D["options"], "body">] extends [never]
    ? { readonly body?: never }
    : RequestField<D["options"], "body">);

type Responses<O> = O extends { readonly responses: infer R } ? R
  : Record<never, never>;
type SuccessKeys<O> = {
  [K in keyof Responses<O>]: `${K & (string | number)}` extends `2${string}` ? K
    : never;
}[keyof Responses<O>];
type Status<K> = K extends number ? K
  : K extends `${infer N extends number}` ? N
  : never;
type ResponseData<O> = [SchemaOf<O, "response">] extends [never] ? unknown
  : Output<SchemaOf<O, "response">>;
type Data<O, K> = Status<K> extends 204 | 205 ? undefined
  : K extends keyof Responses<O>
    ? Responses<O>[K] extends { readonly schema: infer S extends AnySchema }
      ? Output<S>
    : ResponseData<O>
  : ResponseData<O>;

/** The declared successful status selects its own Sieve result type. */
export type RouteSuccess<D extends BrowserRoute> =
  [SuccessKeys<D["options"]>] extends [never] ? {
      readonly ok: true;
      readonly status: 200;
      readonly data: D["method"] extends "HEAD" ? undefined
        : ResponseData<D["options"]>;
      readonly response: Response;
    }
    : {
      [K in SuccessKeys<D["options"]>]: {
        readonly ok: true;
        readonly status: Status<K>;
        readonly data: D["method"] extends "HEAD" ? undefined
          : Data<D["options"], K>;
        readonly response: Response;
      };
    }[SuccessKeys<D["options"]>];

/** Phantom-only registration evidence: importing this type never imports a Worker. */
export interface RegisteredRoutes<R = unknown> {
  readonly "~clientRoutes": R;
}
export type RoutesOf<R> = R extends RegisteredRoutes<infer D> ? D : never;
