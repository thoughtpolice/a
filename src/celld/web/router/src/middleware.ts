// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Onion-model middleware: `(c, next) => Response`, where `next()` runs
 * everything inside and returns its response.
 *
 * @module
 */

import type { AnyContextTypes, Context } from "./context.ts";

/** No fields: the state a router starts with. */
export type Empty = Record<never, never>;

/** Runs the rest of the chain and returns its response. */
export type Next = () => Promise<Response>;

/**
 * Middleware that may add the fields `Adds` to `c.state`. Build one with
 * {@link middleware} to declare what it adds; the router then types
 * `c.state` for the routes it wraps.
 */
export interface Middleware<Adds extends object = Empty> {
  (c: Context, next: Next): Response | Promise<Response>;
  /** Type-level only; never set. */
  readonly "~adds"?: Adds;
}

/** What a middleware adds to the state. */
export type AddsOf<M> = M extends Middleware<infer A>
  ? (unknown extends A ? Empty : A)
  : Empty;

type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends
  (value: infer I) => void ? I
  : never;

/** What a list of middleware adds, together. */
export type AddsAll<M extends readonly unknown[]> = M extends readonly []
  ? Empty
  : Intersect<AddsOf<M[number]>>;

/** The context a middleware that adds `Adds` sees: it may set those fields. */
export type MiddlewareContext<Adds extends object> = Context<
  Omit<AnyContextTypes, "state"> & { state: Adds }
>;

/**
 * Declares middleware adding `Adds` to `c.state`:
 *
 * ```ts
 * const timing = middleware<{ started: number }>(async (c, next) => {
 *   c.state.started = Date.now();
 *   return await next();
 * });
 * app.use(timing).get("/", { public: true }, (c) => c.json({ at: c.state.started }));
 * ```
 */
export function middleware<Adds extends object = Empty>(
  fn: (c: MiddlewareContext<Adds>, next: Next) => Response | Promise<Response>,
): Middleware<Adds> {
  return fn as Middleware<Adds>;
}

/** Runs `chain` around `inner`; `next()` may be called at most once per layer. */
export function compose(
  chain: readonly Middleware<object>[],
  inner: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
  if (chain.length === 0) return inner;
  return (c) => {
    const run = async (index: number): Promise<Response> => {
      if (index === chain.length) return await inner(c);
      let called = false;
      return await chain[index](c, () => {
        if (called) throw new Error("next() called more than once");
        called = true;
        return run(index + 1);
      });
    };
    return run(0);
  };
}
