// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type BrowserRoute,
  type ClientFailure,
  parsePattern,
  type PathParams,
  splitPath,
  Trie,
} from "@celld/web/router/client";
import { focusElement } from "./focus.ts";

export type PageResult<T> =
  | { readonly ok: true; readonly data: T }
  | ClientFailure;
export interface PageContext<P extends string = string> {
  readonly url: URL;
  readonly params: string extends P ? Readonly<Record<string, string>>
    : PathParams<P>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly signal: AbortSignal;
}
export interface PageDefinition<T> {
  readonly route: BrowserRoute<"GET">;
  readonly load: (context: PageContext) => Promise<PageResult<T>>;
}

/** Bind component/data loading to the same GET descriptor registered on the server. */
export function definePage<T, const P extends string>(
  route: BrowserRoute<"GET", P>,
  load: (context: PageContext<P>) => Promise<PageResult<T>>,
): PageDefinition<T> {
  return { route, load: load as unknown as PageDefinition<T>["load"] };
}

/** Repeated fields retain their order; unsafe names are ordinary own properties. */
export function queryValues(
  search: URLSearchParams,
): Readonly<Record<string, string | readonly string[]>> {
  const values: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of search) {
    const previous = values[key];
    if (previous === undefined) values[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else values[key] = [previous, value];
  }
  return values;
}

/** Uses the router's matcher, including static > parameter > wildcard precedence. */
export function createPageMatcher<T>(pages: readonly PageDefinition<T>[]) {
  const trie = new Trie<{ page: PageDefinition<T>; names: string[] }>();
  for (const page of pages) {
    if (page.route.method !== "GET") {
      throw new TypeError("page routes must use GET");
    }
    const segments = parsePattern(page.route.path);
    trie.add(segments, "GET", {
      page,
      names: segments.filter((s) => s.kind !== "static").map((s) => s.name),
    });
  }
  return (
    url: URL,
  ): { page: PageDefinition<T>; params: Record<string, string> } | null => {
    const path = splitPath(url.pathname);
    if (path === null) return null;
    const match = trie.match(path)[0];
    if (!match) return null;
    const entry = match.entries.get("GET")!;
    return {
      page: entry.page,
      params: Object.fromEntries(
        entry.names.map((name, index) => [name, match.values[index]]),
      ),
    };
  };
}

export type NavigationState<T> =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly url: URL }
  | { readonly status: "success"; readonly url: URL; readonly data: T }
  | {
    readonly status: "error";
    readonly url: URL;
    readonly error: ClientFailure;
  };
export interface PageLoaderOptions<T> {
  readonly pages: readonly PageDefinition<T>[];
  readonly onState: (state: NavigationState<T>) => void;
  /** Await rendering; check context.signal before any asynchronous DOM mutation. */
  readonly commit: (data: T, context: PageContext) => void | Promise<void>;
}

/** DOM-independent latest-load-wins controller, also useful for imperative navigation. */
export function createPageLoader<T>(initial: PageLoaderOptions<T>) {
  let options = initial;
  let match = createPageMatcher(initial.pages);
  let pending: AbortController | undefined;
  let generation = 0;
  let destroyed = false;
  let state: NavigationState<T> = { status: "idle" };
  const publish = (next: NavigationState<T>) => {
    state = next;
    options.onState(next);
  };
  const cancel = () => {
    generation++;
    pending?.abort();
    pending = undefined;
  };
  return {
    get state() {
      return state;
    },
    matches(url: URL) {
      return match(url) !== null;
    },
    async load(url: URL): Promise<boolean> {
      if (destroyed) return false;
      const selected = match(url);
      cancel();
      if (selected === null) {
        publish({ status: "idle" });
        return false;
      }
      const id = generation;
      const controller = pending = new AbortController();
      const context: PageContext = {
        url: new URL(url),
        params: selected.params,
        query: queryValues(url.searchParams),
        signal: controller.signal,
      };
      publish({ status: "pending", url: context.url });
      let result: PageResult<T>;
      try {
        result = await selected.page.load(context);
      } catch (cause) {
        result = {
          ok: false,
          kind: controller.signal.aborted ? "cancelled" : "transport",
          cause,
        };
      }
      if (id !== generation || controller.signal.aborted) return false;
      if (result.ok) {
        try {
          await options.commit(result.data, context);
        } catch (cause) {
          result = { ok: false, kind: "transport", cause };
        }
      }
      if (id !== generation || controller.signal.aborted) return false;
      pending = undefined;
      if (!result.ok) {
        publish({ status: "error", url: context.url, error: result });
        return false;
      }
      publish({ status: "success", url: context.url, data: result.data });
      return true;
    },
    update(next: PageLoaderOptions<T>) {
      if (destroyed) return;
      const nextMatch = createPageMatcher(next.pages);
      cancel();
      options = next;
      match = nextMatch;
      publish({ status: "idle" });
    },
    destroy() {
      if (!destroyed) {
        cancel();
        destroyed = true;
        state = { status: "idle" };
      }
    },
  };
}

export interface NavigationOptions<T> extends PageLoaderOptions<T> {
  readonly root?: Document | Element;
  readonly window?: Window;
  /** false keeps focus/scroll unchanged; default focuses [data-page-focus], h1, then main. */
  readonly focus?: false | ((url: URL) => void);
}
export interface NavigateOptions {
  readonly history?: "push" | "replace" | "none";
}

/** Only intercept ordinary same-origin links whose shared page definition matches. */
export function createNavigation<T>(initial: NavigationOptions<T>) {
  let options = initial;
  let win = options.window ?? window;
  let root = options.root ?? win.document;
  let destroyed = false;
  let serial = 0;
  const loader = createPageLoader(options);
  let renderedUrl = new URL(win.location.href);
  let releaseFocus: (() => void) | undefined;
  function focus(url: URL) {
    if (options.focus === false) return;
    if (typeof options.focus === "function") {
      options.focus(url);
      return;
    }
    const element = root.querySelector<HTMLElement>("[data-page-focus]") ??
      root.querySelector<HTMLElement>("h1") ??
      root.querySelector<HTMLElement>("main");
    if (element) {
      releaseFocus?.();
      releaseFocus = focusElement(element, true);
    }
    win.scrollTo(0, 0);
  }
  async function navigate(
    value: string | URL,
    settings: NavigateOptions = {},
  ): Promise<boolean> {
    if (destroyed) return false;
    const url = new URL(value, win.location.href);
    if (
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password
    ) {
      throw new TypeError(
        "navigation requires an HTTP(S) URL without credentials",
      );
    }
    if (
      url.origin !== win.location.origin || url.hash || !loader.matches(url)
    ) {
      loader.update(options);
      serial++;
      win.location.assign(url.href);
      return false;
    }
    const id = ++serial;
    const success = await loader.load(url);
    if (destroyed || id !== serial || !success) return false;
    if (settings.history !== "none") {
      const method =
        settings.history === "replace" || url.href === win.location.href
          ? "replaceState"
          : "pushState";
      win.history[method](win.history.state, "", url.href);
    }
    renderedUrl = new URL(url);
    focus(url);
    return true;
  }
  const click = (event: Event) => {
    const mouse = event as MouseEvent;
    if (
      event.defaultPrevented || mouse.button !== 0 || mouse.metaKey ||
      mouse.ctrlKey || mouse.shiftKey || mouse.altKey
    ) return;
    const anchor = event.composedPath().find((
      node,
    ): node is HTMLAnchorElement =>
      typeof node === "object" && node !== null && "tagName" in node &&
      node.tagName === "A"
    ) as HTMLAnchorElement | undefined;
    if (
      !anchor || !anchor.hasAttribute("href") ||
      anchor.hasAttribute("download") || anchor.hasAttribute("target") ||
      anchor.relList.contains("external") ||
      win.document.querySelector("base[target]")
    ) return;
    const url = new URL(anchor.href, win.location.href);
    if (
      url.origin !== win.location.origin ||
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password
    ) return;
    if (url.hash || anchor.getAttribute("href")?.startsWith("#")) {
      serial++;
      loader.update(options);
      return;
    }
    if (!loader.matches(url)) return;
    event.preventDefault();
    void navigate(url);
  };
  const pop = () => {
    if (win.location.hash) {
      serial++;
      loader.update(options);
      const url = new URL(win.location.href);
      if (
        url.pathname !== renderedUrl.pathname ||
        url.search !== renderedUrl.search
      ) win.location.reload();
      return;
    }
    void navigate(win.location.href, { history: "none" });
  };
  const attach = () => {
    root.addEventListener("click", click);
    win.addEventListener("popstate", pop);
  };
  const detach = () => {
    root.removeEventListener("click", click);
    win.removeEventListener("popstate", pop);
  };
  attach();
  return {
    get state() {
      return loader.state;
    },
    navigate,
    refresh: () => navigate(win.location.href, { history: "none" }),
    update(next: NavigationOptions<T>) {
      if (destroyed) return;
      releaseFocus?.();
      releaseFocus = undefined;
      detach();
      serial++;
      options = next;
      loader.update(next);
      win = next.window ?? window;
      root = next.root ?? win.document;
      attach();
      renderedUrl = new URL(win.location.href);
    },
    destroy() {
      if (!destroyed) {
        destroyed = true;
        serial++;
        detach();
        loader.destroy();
        releaseFocus?.();
        releaseFocus = undefined;
      }
    },
  };
}
