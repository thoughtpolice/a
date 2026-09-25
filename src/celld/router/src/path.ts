// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Path patterns and the segment trie that matches them.
 *
 * A pattern is `/` or `/`-separated segments: a literal (`users`), a
 * parameter (`:id`, one non-empty segment) or, last, a wildcard (`*rest`,
 * the remaining segments, possibly none). Matching is a walk of a trie of
 * segments, never a generated regular expression or function, and tries
 * the children of a node in a fixed order: literal, then parameter, then
 * wildcard. So `/users/me` beats `/users/:id`, which beats `/users/*rest`,
 * whatever order they were added in.
 *
 * @module
 */

import { RouterError } from "./errors.ts";

type Segments<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? Head | Segments<Tail>
  : P;

type NameOf<S> = S extends `:${infer N}` ? N
  : S extends `*${infer N}` ? N
  : never;

/** The parameter names of a pattern: `"id" | "rest"` for `/a/:id/*rest`. */
export type ParamNames<P extends string> = NameOf<Segments<P>>;

/** The params a pattern captures: `{ id: string }` for `/users/:id`. */
export type PathParams<P extends string> = {
  readonly [K in ParamNames<P>]: string;
};

/** One segment of a parsed pattern. */
export type Segment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "wildcard"; readonly name: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The segments of `pattern`; throws {@link RouterError} for one that does
 * not start with `/`, has an empty segment or a trailing `/`, a bad or
 * repeated parameter name, or a wildcard before the end.
 */
export function parsePattern(pattern: string): Segment[] {
  if (!pattern.startsWith("/")) {
    throw new RouterError(`a path pattern starts with "/": ${pattern}`);
  }
  if (pattern === "/") return [];
  const parts = pattern.slice(1).split("/");
  const seen = new Set<string>();
  return parts.map((part, index) => {
    if (part === "") {
      throw new RouterError(
        `a path pattern has no empty segments or trailing "/": ${pattern}`,
      );
    }
    const sigil = part[0];
    if (sigil !== ":" && sigil !== "*") {
      return { kind: "static", value: part } as const;
    }
    const name = part.slice(1);
    if (!NAME.test(name)) {
      throw new RouterError(`bad parameter name "${part}" in ${pattern}`);
    }
    if (seen.has(name)) {
      throw new RouterError(`parameter "${name}" repeats in ${pattern}`);
    }
    seen.add(name);
    if (sigil === "*" && index !== parts.length - 1) {
      throw new RouterError(`a wildcard must be last: ${pattern}`);
    }
    return sigil === ":"
      ? { kind: "param", name } as const
      : { kind: "wildcard", name } as const;
  });
}

/** `segments` as a pattern again. */
export function formatPattern(segments: readonly Segment[]): string {
  if (segments.length === 0) return "/";
  return segments.map((segment) =>
    "/" +
    (segment.kind === "static"
      ? segment.value
      : (segment.kind === "param" ? ":" : "*") + segment.name)
  ).join("");
}

/** The pattern with parameter names erased, so two routes that collide share it. */
export function shapeOf(segments: readonly Segment[]): string {
  return "/" +
    segments.map((segment) =>
      segment.kind === "static"
        ? segment.value
        : segment.kind === "param"
        ? "\u0000:"
        : "\u0000*"
    ).join("/");
}

/**
 * The decoded segments of a request path, or null when one is not valid
 * percent-encoding. `/` is `[]`; `/a/` is `["a", ""]`.
 */
export function splitPath(pathname: string): string[] | null {
  if (pathname === "/" || pathname === "") return [];
  const raw = pathname.slice(1).split("/");
  const out: string[] = [];
  for (const segment of raw) {
    try {
      out.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return out;
}

class Node<T> {
  readonly statics = new Map<string, Node<T>>();
  param: Node<T> | null = null;
  readonly here = new Map<string, T>();
  readonly wildcard = new Map<string, T>();
}

/** One path match: the node's entries by method and the captured values, in order. */
export interface TrieMatch<T> {
  readonly entries: ReadonlyMap<string, T>;
  readonly values: readonly string[];
}

/**
 * A trie from segments to entries keyed by method. {@link match} lists
 * every entry set whose pattern matches a path, best first.
 */
export class Trie<T> {
  readonly #root = new Node<T>();

  /** Adds `value` for `method` at `segments`; throws if there is one already. */
  add(segments: readonly Segment[], method: string, value: T): void {
    let node = this.#root;
    let table = node.here;
    for (const segment of segments) {
      if (segment.kind === "static") {
        let next = node.statics.get(segment.value);
        if (next === undefined) {
          next = new Node<T>();
          node.statics.set(segment.value, next);
        }
        node = next;
        table = node.here;
      } else if (segment.kind === "param") {
        node = node.param ??= new Node<T>();
        table = node.here;
      } else {
        table = node.wildcard;
      }
    }
    if (table.has(method)) {
      throw new RouterError(
        `${method} ${formatPattern(segments)} is already routed`,
      );
    }
    table.set(method, value);
  }

  /** Every match for `path` (decoded segments), best first. */
  match(path: readonly string[]): TrieMatch<T>[] {
    const out: TrieMatch<T>[] = [];
    walk(this.#root, path, 0, [], out);
    return out;
  }
}

function walk<T>(
  node: Node<T>,
  path: readonly string[],
  index: number,
  values: string[],
  out: TrieMatch<T>[],
): void {
  if (index === path.length) {
    if (node.here.size > 0) {
      out.push({ entries: node.here, values: [...values] });
    }
    if (node.wildcard.size > 0) {
      out.push({ entries: node.wildcard, values: [...values, ""] });
    }
    return;
  }
  const segment = path[index];
  const next = node.statics.get(segment);
  if (next !== undefined) walk(next, path, index + 1, values, out);
  if (node.param !== null && segment !== "") {
    values.push(segment);
    walk(node.param, path, index + 1, values, out);
    values.pop();
  }
  if (node.wildcard.size > 0) {
    out.push({
      entries: node.wildcard,
      values: [...values, path.slice(index).join("/")],
    });
  }
}
