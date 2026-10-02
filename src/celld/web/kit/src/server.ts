// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Server-only Svelte rendering with inert, checked hydration props. */
import { jsonSnapshot, type SnapshotLimits } from "@celld/core/bounds";
import type { AnySchema, Input, Output } from "@celld/sieve";
import { type Context, HttpError } from "@celld/web/router";
import type { BrowserRoute } from "@celld/web/router/client";
import type { Component } from "svelte";
import { render } from "svelte/server";

/** The inert hydration payload consumed by hydratePage in the browser. */
export interface PageBoot<Props> {
  readonly version: 1;
  readonly props: Props;
}

export interface PageOptions extends ResponseInit {
  /** Escaped document title. Do not also declare a title in Svelte's head. */
  readonly title?: string;
  readonly lang?: string;
  /** Trusted authored HTML, not user input; compiler-rendered head is retained. */
  readonly head?: string;
  readonly targetId?: string;
  readonly bootId?: string;
  /** Explicit external module script URLs; no executable inline bootstrap. */
  readonly scripts?: readonly string[];
  readonly styles?: readonly string[];
  /** Limits for core's strict, immutable JSON snapshot of the props. */
  readonly snapshotLimits?: SnapshotLimits;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function jsonText(value: unknown): string {
  // The snapshot has already rejected getters, toJSON, holes and non-JSON values.
  // Reject the one finite number whose identity JSON.stringify would change.
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && Object.is(item, -0)) {
      throw new TypeError("page props cannot contain negative zero");
    }
    return item;
  });
}

function scriptData(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

function assetUrl(url: string): string {
  const parsed = new URL(url, "https://celld.invalid/");
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("page asset URLs must be relative, HTTP or HTTPS");
  }
  return escapeHtml(url);
}

function responseInit(
  options: PageOptions,
  contentType?: string,
): ResponseInit {
  const headers = new Headers(options.headers);
  // A supplied length describes neither the rendered document nor JSON encoding.
  headers.delete("content-length");
  if (contentType !== undefined) headers.set("content-type", contentType);
  return { status: options.status, statusText: options.statusText, headers };
}

function bodyless(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function checkedProps<Props extends object>(
  props: Props,
  limits?: SnapshotLimits,
): Props {
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    throw new TypeError("page props must be a JSON object");
  }
  return jsonSnapshot(props, limits);
}

function renderDocument<Props extends object>(
  component: Component<Props>,
  props: Props,
  boot: string,
  options: PageOptions,
): string {
  const targetId = options.targetId ?? "celld-page";
  const bootId = options.bootId ?? "celld-boot";
  if (
    !targetId || !bootId || /\s/.test(targetId) || /\s/.test(bootId) ||
    targetId === bootId
  ) {
    throw new TypeError(
      "page target and boot IDs must be distinct, nonempty IDs without whitespace",
    );
  }
  const rendered = render(component, { props });
  const head = rendered.head + (options.head ?? "");
  if (options.title !== undefined && /<title(?:\s|>)/i.test(head)) {
    throw new TypeError(
      "a page title must be supplied either by options or the component head, not both",
    );
  }
  const title = options.title === undefined
    ? ""
    : `<title>${escapeHtml(options.title)}</title>`;
  const styles = (options.styles ?? []).map((url) =>
    `<link rel="stylesheet" href="${assetUrl(url)}">`
  ).join("");
  const scripts = (options.scripts ?? []).map((url) =>
    `<script type="module" src="${assetUrl(url)}"></script>`
  ).join("");
  // Keep Svelte's complete body, including hydration boundary comments, intact.
  return `<!doctype html><html lang="${
    escapeHtml(options.lang ?? "en")
  }"><head><meta charset="utf-8">${title}${head}${styles}</head><body><div id="${
    escapeHtml(targetId)
  }">${rendered.body}</div><script id="${
    escapeHtml(bootId)
  }" type="application/json">${boot}</script>${scripts}</body></html>`;
}

/** Render a real compiled Svelte component, sharing one snapshot with hydration. */
export function renderPage<Props extends object>(
  component: Component<Props>,
  props: NoInfer<Props>,
  options: PageOptions = {},
): Response {
  if (bodyless(options.status ?? 200)) {
    return new Response(null, responseInit(options));
  }
  const snapshot = checkedProps(props, options.snapshotLimits);
  const boot = scriptData(
    jsonText({ version: 1, props: snapshot } satisfies PageBoot<Props>),
  );
  return new Response(
    renderDocument(component, snapshot, boot, options),
    responseInit(options, "text/html; charset=utf-8"),
  );
}

type PageDefinition = BrowserRoute & {
  readonly options: { readonly response: AnySchema };
};
type EntrySchema<Entry, Fallback extends AnySchema> = Entry extends
  { readonly schema: infer S extends AnySchema } ? S : Fallback;
type SchemaAtStatus<D extends PageDefinition, Status extends number> =
  D["options"] extends { readonly responses: infer R }
    ? Status extends keyof R ? EntrySchema<R[Status], D["options"]["response"]>
    : `${Status}` extends keyof R
      ? EntrySchema<R[`${Status}`], D["options"]["response"]>
    : "default" extends keyof R
      ? EntrySchema<R["default"], D["options"]["response"]>
    : D["options"]["response"]
    : D["options"]["response"];
type PageProps<D extends PageDefinition, Status extends number> =
  Output<SchemaAtStatus<D, Status>> extends object
    ? Output<SchemaAtStatus<D, Status>>
    : never;

function varyAccept(headers: Headers): void {
  const vary = headers.get("vary");
  if (
    vary?.split(",").some((name) =>
      name.trim() === "*" || name.trim().toLowerCase() === "accept"
    )
  ) return;
  headers.set("vary", vary ? `${vary}, Accept` : "Accept");
}

/**
 * Call inside Router.register's handler, after its auth and request validation.
 * The shared response schema (or status-specific schema) parses the loader's
 * input once; only its stripped/transformed output reaches SSR, hydration or
 * JSON. This does not register a route or call the loader itself.
 */
export function respondPage<
  const D extends PageDefinition,
  const Status extends number = 200,
>(
  context: Pick<Context, "accepts" | "method">,
  definition: D,
  component: Component<NoInfer<PageProps<D, Status>>>,
  input: NoInfer<Input<SchemaAtStatus<D, Status>>>,
  options: PageOptions & { readonly status?: Status } = {},
): Response {
  const headers = new Headers(options.headers);
  varyAccept(headers);
  const media = context.accepts("text/html", "application/json");
  if (media === null) {
    throw new HttpError(
      406,
      "this page offers text/html and application/json",
      { headers },
    );
  }
  const status = options.status ?? 200;
  if (bodyless(status)) {
    return new Response(null, responseInit({ ...options, headers }));
  }
  const entries = definition.options.responses;
  const entry = entries?.[status] ?? entries?.default;
  const schema = entry?.schema ?? definition.options.response;
  const result = schema.safeParse(input);
  if (!result.success) {
    // Router error handling turns this programming error into an opaque 500.
    throw new Error(
      `the response does not match the route's schema: ${result.error.message}`,
    );
  }
  const props = checkedProps(
    result.data as PageProps<D, Status>,
    options.snapshotLimits,
  );
  const json = jsonText(props);
  const init = responseInit(
    { ...options, headers },
    media === "text/html"
      ? "text/html; charset=utf-8"
      : "application/json; charset=utf-8",
  );
  if (context.method === "HEAD") return new Response(null, init);
  if (media === "application/json") return new Response(json, init);
  const boot = scriptData(`{"version":1,"props":${json}}`);
  return new Response(renderDocument(component, props, boot, options), init);
}
