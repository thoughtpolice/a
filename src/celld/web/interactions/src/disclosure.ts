// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type Action,
  Attributes,
  closestIn,
  disabled,
  Listeners,
  observeChildren,
  type OpenOptions,
  partId,
  requireId,
  restoreFocus,
} from "./dom.ts";

export type DisclosureOptions = OpenOptions;

/** A native data-disclosure-trigger button and data-disclosure-panel region. */
export function disclosure(
  node: HTMLElement,
  initial: DisclosureOptions,
): Action<DisclosureOptions> {
  requireId(initial.id);
  const attrs = new Attributes();
  const listeners = new Listeners();
  let options = initial;
  let open = initial.open ?? false;
  let destroyed = false;

  function render(): void {
    if (destroyed) return;
    attrs.begin();
    const trigger = node.querySelector<HTMLElement>(
      "[data-disclosure-trigger]",
    );
    const panel = node.querySelector<HTMLElement>("[data-disclosure-panel]");
    if (trigger) {
      attrs.set(trigger, "id", partId(options.id, "trigger"));
      attrs.set(trigger, "aria-controls", partId(options.id, "panel"));
      attrs.set(trigger, "aria-expanded", String(open));
    }
    if (panel) {
      if (!open && panel.contains(node.ownerDocument.activeElement)) {
        restoreFocus(trigger);
      }
      attrs.set(panel, "id", partId(options.id, "panel"));
      attrs.set(panel, "role", "region");
      attrs.set(panel, "aria-labelledby", partId(options.id, "trigger"));
      attrs.set(panel, "hidden", open ? null : "");
    }
    attrs.end();
  }

  listeners.on(node, "click", (event) => {
    const trigger = closestIn(node, event, "[data-disclosure-trigger]");
    if (!trigger) return;
    event.preventDefault();
    if (disabled(trigger)) return;
    open = !open;
    render();
    options.onOpenChange?.(open);
  });
  render();
  const unobserve = observeChildren(node, render);
  return {
    update(next) {
      if (destroyed) return;
      requireId(next.id);
      options = next;
      if (next.open !== undefined) open = next.open;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unobserve();
      listeners.clear();
      attrs.restore();
    },
  };
}
