// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { type Component, hydrate } from "svelte";

export interface PageBoot<Props extends object> {
  readonly version: 1;
  readonly props: Props;
}

export interface HydratePageOptions<Props extends object> {
  readonly target?: Element | string;
  readonly boot?: PageBoot<Props>;
  readonly bootId?: string;
  /** Validate untrusted boot props before passing them to the component. */
  readonly parseProps?: (value: unknown) => Props;
}

/** Hydrate the exact server body; never replace its hydration markers. */
export function hydratePage<Props extends object, Exports extends object>(
  component: Component<Props, Exports>,
  options: HydratePageOptions<Props> = {},
): Exports {
  const target =
    typeof options.target === "string" || options.target === undefined
      ? document.querySelector(options.target ?? "#celld-page")
      : options.target;
  if (target === null) throw new TypeError("hydratePage target was not found");
  let boot: unknown = options.boot;
  if (boot === undefined) {
    const script = target.ownerDocument.getElementById(
      options.bootId ?? "celld-boot",
    );
    if (
      script === null || script.tagName !== "SCRIPT" ||
      script.getAttribute("type") !== "application/json"
    ) {
      throw new TypeError(
        "hydratePage requires an application/json boot script",
      );
    }
    boot = JSON.parse(script.textContent ?? "");
  }
  if (
    typeof boot !== "object" || boot === null || !("version" in boot) ||
    boot.version !== 1 || !("props" in boot)
  ) {
    throw new TypeError("unsupported hydratePage boot envelope");
  }
  const props = options.parseProps
    ? options.parseProps(boot.props)
    : boot.props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    throw new TypeError("hydratePage props must be an object");
  }
  return hydrate(component, { target, props: props as Props });
}
