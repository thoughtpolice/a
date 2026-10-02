// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type Action,
  Attributes,
  closestIn,
  disabled,
  Listeners,
  observeChildren,
  partId,
  requireId,
} from "./dom.ts";
import { nextEnabledIndex } from "./navigation.ts";

export interface TabsOptions {
  /** Stable unique prefix for tab and panel IDs. */
  id: string;
  /** Selected data-tab value; omission preserves local selection. */
  selected?: string;
  orientation?: "horizontal" | "vertical";
  /** Automatic activates on arrow focus; manual requires Enter or Space. */
  activation?: "automatic" | "manual";
  onSelect?: (value: string) => void;
}

/** Container with a data-tab-list, native data-tab buttons and matching panels. */
export function tabs(
  node: HTMLElement,
  initial: TabsOptions,
): Action<TabsOptions> {
  requireId(initial.id);
  const attrs = new Attributes();
  const listeners = new Listeners();
  let options = initial;
  let selected = initial.selected;
  let focused: string | undefined;
  let items: HTMLElement[] = [];
  let focusOwner: HTMLElement | null = null;
  let destroyed = false;

  function insideNestedPanel(element: HTMLElement): boolean {
    const panel = element.parentElement?.closest("[data-tab-panel]");
    return !!panel && panel !== node && node.contains(panel);
  }

  function render(): void {
    if (destroyed) return;
    attrs.begin();
    let list: HTMLElement | undefined;
    for (
      const candidate of node.querySelectorAll<HTMLElement>("[data-tab-list]")
    ) {
      if (!insideNestedPanel(candidate)) {
        list = candidate;
        break;
      }
    }
    items = [];
    if (list) {
      for (const item of list.querySelectorAll<HTMLElement>("[data-tab]")) {
        if (item.closest("[data-tab-list]") === list) items.push(item);
      }
    }
    const active = node.ownerDocument.activeElement;
    let returnToTab = !!focusOwner &&
      (disabled(focusOwner) || !node.contains(focusOwner)) &&
      (active === focusOwner || active === node.ownerDocument.body);
    const enabled = items.filter((item) => !disabled(item));
    if (!enabled.some((item) => item.dataset.tab === selected)) {
      selected = enabled[0]?.dataset.tab;
    }
    if (!enabled.some((item) => item.dataset.tab === focused)) {
      focused = selected;
    }
    if (list) {
      attrs.set(list, "role", "tablist");
      attrs.set(list, "aria-orientation", options.orientation ?? "horizontal");
    }
    for (const item of items) {
      const value = item.dataset.tab!;
      attrs.set(item, "role", "tab");
      attrs.set(item, "id", partId(options.id, "tab", value));
      attrs.set(item, "aria-controls", partId(options.id, "panel", value));
      attrs.set(item, "aria-selected", String(value === selected));
      attrs.set(
        item,
        "tabindex",
        value === focused && !disabled(item) ? "0" : "-1",
      );
    }
    for (
      const panel of node.querySelectorAll<HTMLElement>("[data-tab-panel]")
    ) {
      if (insideNestedPanel(panel)) continue;
      const value = panel.dataset.tabPanel!;
      if (value !== selected && panel.contains(active)) returnToTab = true;
      attrs.set(panel, "id", partId(options.id, "panel", value));
      attrs.set(panel, "role", "tabpanel");
      attrs.set(panel, "aria-labelledby", partId(options.id, "tab", value));
      attrs.set(panel, "tabindex", "0");
      attrs.set(panel, "hidden", value === selected ? null : "");
    }
    attrs.end();
    if (returnToTab) {
      focusOwner = null;
      items.find((item) => item.dataset.tab === selected && !disabled(item))
        ?.focus();
    }
  }

  function select(item: HTMLElement): void {
    if (disabled(item)) return;
    const changed = selected !== item.dataset.tab;
    selected = item.dataset.tab;
    focused = selected;
    render();
    if (changed) options.onSelect?.(selected!);
  }

  listeners.on(node, "click", (event) => {
    const item = closestIn(node, event, "[data-tab]");
    if (!item || !items.includes(item)) return;
    event.preventDefault();
    if (!disabled(item)) {
      select(item);
      item.focus();
    }
  });
  listeners.on(node, "focusin", (event) => {
    const item = closestIn(node, event, "[data-tab]");
    if (item && items.includes(item) && !disabled(item)) {
      focusOwner = item;
      focused = item.dataset.tab;
      if (options.activation !== "manual") select(item);
      else render();
    }
  });
  listeners.on(node, "focusout", (event) => {
    const item = closestIn(node, event, "[data-tab]");
    if (item && item === focusOwner && !disabled(item) && node.contains(item)) {
      focusOwner = null;
    }
  });
  listeners.on(node, "keydown", (event) => {
    const item = closestIn(node, event, "[data-tab]");
    if (
      !item || !items.includes(item) || disabled(item) || event.altKey ||
      event.ctrlKey || event.metaKey
    ) return;
    const enabled = items.map((entry) => !disabled(entry));
    let target = -1;
    const vertical = options.orientation === "vertical";
    const rtl =
      node.ownerDocument.defaultView?.getComputedStyle(node).direction ===
        "rtl";
    if (event.key === "Home") target = nextEnabledIndex(enabled, -1, 1);
    else if (event.key === "End") target = nextEnabledIndex(enabled, -1, -1);
    else if (
      vertical && (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      target = nextEnabledIndex(
        enabled,
        items.indexOf(item),
        event.key === "ArrowDown" ? 1 : -1,
      );
    } else if (
      !vertical && (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      const forward = event.key === "ArrowRight" ? !rtl : rtl;
      target = nextEnabledIndex(enabled, items.indexOf(item), forward ? 1 : -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(item);
      return;
    } else return;
    event.preventDefault();
    if (target >= 0) {
      focused = items[target].dataset.tab;
      if (options.activation !== "manual") select(items[target]);
      else render();
      items[target].focus();
    }
  });
  render();
  const unobserve = observeChildren(node, render);
  return {
    update(next) {
      if (destroyed) return;
      requireId(next.id);
      options = next;
      if (next.selected !== undefined) {
        selected = next.selected;
        focused = selected;
      }
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
