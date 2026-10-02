// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type BrowserRoute,
  type ClientFailure,
  type ClientResult,
  parsePattern,
  type RouteSuccess,
  splitPath,
  Trie,
} from "@celld/web/router/client";
import { queryValues } from "./navigation.ts";
import { focusElement } from "./focus.ts";

export type ActionState<T> =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error"; readonly error: ClientFailure };
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | ClientFailure;
export interface ActionOptions<Input, T> {
  readonly submit: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<ActionResult<T>>;
  readonly onState: (state: ActionState<T>) => void;
}

/** Single action state: submitting again aborts the old request and ignores its result. */
export function createAction<Input, T>(initial: ActionOptions<Input, T>) {
  let options = initial;
  let controller: AbortController | undefined;
  let generation = 0;
  let destroyed = false;
  let state: ActionState<T> = { status: "idle" };
  const publish = (next: ActionState<T>) => {
    state = next;
    options.onState(next);
  };
  return {
    get state() {
      return state;
    },
    async submit(input: Input): Promise<ActionResult<T> | undefined> {
      if (destroyed) return undefined;
      controller?.abort();
      const id = ++generation;
      const pending = controller = new AbortController();
      publish({ status: "pending" });
      let result: ActionResult<T>;
      try {
        result = await options.submit(input, pending.signal);
      } catch (cause) {
        result = {
          ok: false,
          kind: pending.signal.aborted ? "cancelled" : "transport",
          cause,
        };
      }
      if (id !== generation || pending.signal.aborted) return undefined;
      controller = undefined;
      publish(
        result.ok
          ? { status: "success", data: result.data }
          : { status: "error", error: result },
      );
      return result;
    },
    update(next: ActionOptions<Input, T>) {
      if (destroyed) return;
      generation++;
      controller?.abort();
      controller = undefined;
      options = next;
      publish({ status: "idle" });
    },
    destroy() {
      if (!destroyed) {
        destroyed = true;
        generation++;
        controller?.abort();
        controller = undefined;
        state = { status: "idle" };
      }
    },
  };
}

export interface FormContext {
  readonly url: URL;
  readonly method: "GET" | "POST";
  /** Native successful controls, including the submit button; repeated values retained. */
  readonly data: FormData;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly submitter: HTMLElement | null;
}
export type FormActionData<D extends BrowserRoute> = RouteSuccess<D>["data"];

export interface FormActionOptions<D extends BrowserRoute> {
  readonly route: D;
  /** Map native controls explicitly to the shared contract's typed client request. */
  readonly submit: (
    context: FormContext,
    signal: AbortSignal,
  ) => Promise<ClientResult<D>>;
  readonly onState: (state: ActionState<FormActionData<D>>) => void;
  /** Default focuses the first named validation control; otherwise a status region. */
  readonly focus?:
    | false
    | ((state: ActionState<unknown>, form: HTMLFormElement) => void);
}

function formMatcher(route: BrowserRoute) {
  const segments = parsePattern(route.path);
  const names = segments.filter((segment) => segment.kind !== "static").map((
    segment,
  ) => segment.name);
  const trie = new Trie<true>();
  trie.add(segments, route.method, true);
  return { trie, names };
}

/** Enhance only forms that still work as GET or urlencoded POST without JavaScript. */
export function enhanceForm<D extends BrowserRoute>(
  form: HTMLFormElement,
  initial: FormActionOptions<D>,
) {
  let options = initial;
  let destroyed = false;
  let modified = false;
  let matcher = formMatcher(initial.route);
  let releaseFocus: (() => void) | undefined;
  const activation = (event: Event) => {
    const input = event as MouseEvent | KeyboardEvent;
    modified = input.metaKey || input.ctrlKey || input.shiftKey || input.altKey;
    queueMicrotask(() => {
      modified = false;
    });
  };
  type Data = FormActionData<D>;
  function onState(state: ActionState<Data>) {
    options.onState(state);
    if (
      state.status === "idle" || state.status === "pending" ||
      options.focus === false
    ) return;
    if (typeof options.focus === "function") {
      options.focus(state, form);
      return;
    }
    let target: HTMLElement | undefined;
    if (state.status === "error" && state.error.kind === "validation") {
      const fields = state.error.error.fieldErrors;
      target = Array.from(form.elements).find((
        element,
      ): element is HTMLElement =>
        "name" in element && typeof element.name === "string" &&
        Object.hasOwn(fields, element.name) &&
        "focus" in element &&
        !("disabled" in element && element.disabled === true) &&
        !("type" in element && element.type === "hidden")
      );
    }
    target ??= form.querySelector<HTMLElement>(
      state.status === "error"
        ? "[data-action-error]"
        : "[data-action-success]",
    ) ?? undefined;
    if (target) {
      releaseFocus?.();
      releaseFocus = focusElement(target);
    }
  }
  const action = createAction<FormContext, Data>({
    submit: (context, signal) =>
      options.submit(context, signal) as Promise<ActionResult<Data>>,
    onState,
  });
  const listener = (event: Event) => {
    if (event.defaultPrevented || destroyed || modified) return;
    const submitter = (event as SubmitEvent).submitter;
    const button = submitter as HTMLButtonElement | HTMLInputElement | null;
    // Image-button coordinates cannot be recovered from a submit event: keep it native.
    if (button?.tagName === "INPUT" && button.type === "image") return;
    if (
      form.hasAttribute("target") || button?.hasAttribute("formtarget") ||
      form.ownerDocument.querySelector("base[target]")
    ) return;
    const method =
      (button?.hasAttribute("formmethod") ? button.formMethod : form.method)
        .toUpperCase();
    const encoding = button?.hasAttribute("formenctype")
      ? button.formEnctype
      : form.enctype;
    if (
      (method !== "GET" && method !== "POST") ||
      method !== options.route.method ||
      encoding !== "application/x-www-form-urlencoded"
    ) return;
    if (method === "POST" && options.route.options.bodyType !== "form") return;
    const win = form.ownerDocument.defaultView;
    if (!win) return;
    const url = new URL(
      button?.hasAttribute("formaction") ? button.formAction : form.action,
      form.ownerDocument.baseURI,
    );
    if (
      url.origin !== win.location.origin ||
      !["http:", "https:"].includes(url.protocol) || url.username ||
      url.password || url.hash
    ) return;
    const path = splitPath(url.pathname);
    if (path === null) return;
    const match = matcher.trie.match(path)[0];
    if (!match) return;
    const params = Object.fromEntries(
      matcher.names.map((name, index) => [name, match.values[index]]),
    );
    const data = new FormData(form, submitter);
    // Uploads and their native filename/encoding semantics stay with the browser.
    if (Array.from(data.values()).some((value) => typeof value !== "string")) {
      return;
    }
    if (method === "GET") {
      const query = new URLSearchParams();
      for (const [key, value] of data) query.append(key, value as string);
      url.search = query.toString();
    }
    event.preventDefault();
    void action.submit({
      url,
      method,
      data,
      params,
      query: queryValues(url.searchParams),
      submitter,
    });
  };
  form.addEventListener("submit", listener);
  form.addEventListener("click", activation, true);
  form.addEventListener("keydown", activation, true);
  return {
    get state() {
      return action.state;
    },
    /** requestSubmit preserves constraint validation, submitter overrides and native fallback. */
    submit(submitter?: HTMLButtonElement | HTMLInputElement) {
      if (!destroyed) form.requestSubmit(submitter);
    },
    update(next: FormActionOptions<D>) {
      if (destroyed) return;
      const nextMatcher = formMatcher(next.route);
      releaseFocus?.();
      releaseFocus = undefined;
      matcher = nextMatcher;
      form.removeEventListener("submit", listener);
      options = next;
      form.removeEventListener("click", activation, true);
      form.removeEventListener("keydown", activation, true);
      modified = false;
      action.update({
        submit: (context, signal) =>
          options.submit(context, signal) as Promise<ActionResult<Data>>,
        onState,
      });
      form.addEventListener("submit", listener);
      form.addEventListener("click", activation, true);
      form.addEventListener("keydown", activation, true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      form.removeEventListener("submit", listener);
      form.removeEventListener("click", activation, true);
      form.removeEventListener("keydown", activation, true);
      action.destroy();
      releaseFocus?.();
      releaseFocus = undefined;
    },
  };
}
