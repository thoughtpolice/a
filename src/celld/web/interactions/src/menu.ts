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
  outside,
  partId,
  requireId,
  restoreFocus,
} from "./dom.ts";
import { nextEnabledIndex } from "./navigation.ts";

export interface MenuOptions extends OpenOptions {
  /** Activated data-menu-item value. Native link navigation is not prevented. */
  onSelect?: (value: string, event: MouseEvent) => void;
}

/** Native menu trigger, menu panel, and native button/link command items. */
export function menu(
  node: HTMLElement,
  initial: MenuOptions,
): Action<MenuOptions> {
  requireId(initial.id);
  const attrs = new Attributes();
  const listeners = new Listeners();
  const outsideListeners = new Listeners();
  let options = initial;
  let open = initial.open ?? false;
  let trigger: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let items: HTMLElement[] = [];
  let focused: HTMLElement | null = null;
  let focusOwner: HTMLElement | null = null;
  let destroyed = false;
  let search = "";
  let lastSearch = 0;
  let tabTimer: number | undefined;

  function render(): void {
    if (destroyed) return;
    attrs.begin();
    trigger = node.querySelector<HTMLElement>("[data-menu-trigger]");
    panel = node.querySelector<HTMLElement>("[data-menu-panel]");
    items = panel
      ? Array.from(panel.querySelectorAll<HTMLElement>("[data-menu-item]"))
      : [];
    const active = node.ownerDocument.activeElement;
    const refocus = open && !!focusOwner &&
      (disabled(focusOwner) || !node.contains(focusOwner)) &&
      (active === focusOwner || active === node.ownerDocument.body);
    if (!focused || !items.includes(focused) || disabled(focused)) {
      focused = items.find((item) => !disabled(item)) ?? null;
    }
    if (trigger) {
      attrs.set(trigger, "id", partId(options.id, "trigger"));
      attrs.set(trigger, "aria-haspopup", "menu");
      attrs.set(trigger, "aria-controls", partId(options.id, "menu"));
      attrs.set(trigger, "aria-expanded", String(open));
    }
    if (panel) {
      attrs.set(panel, "id", partId(options.id, "menu"));
      attrs.set(panel, "role", "menu");
      attrs.set(panel, "aria-labelledby", partId(options.id, "trigger"));
      attrs.set(panel, "tabindex", "-1");
      attrs.set(panel, "hidden", open ? null : "");
    }
    for (const item of items) {
      attrs.set(item, "role", "menuitem");
      attrs.set(item, "id", partId(options.id, "item", item.dataset.menuItem!));
      attrs.set(
        item,
        "tabindex",
        open && item === focused && !disabled(item) ? "0" : "-1",
      );
    }
    attrs.end();
    if (refocus) {
      focusOwner = null;
      (focused ?? panel)?.focus();
    }
  }

  function setOpen(next: boolean, notify: boolean, returnFocus = false): void {
    if (destroyed || next === open) return;
    open = next;
    search = "";
    if (!open) {
      if (returnFocus || panel?.contains(node.ownerDocument.activeElement)) {
        restoreFocus(trigger);
      }
      clearTimeout(tabTimer);
      tabTimer = undefined;
    }
    render();
    if (open) (focused ?? panel)?.focus();
    bindOutside();
    if (notify) options.onOpenChange?.(open);
  }

  function bindOutside(): void {
    outsideListeners.clear();
    if (!open) return;
    outsideListeners.on(node.ownerDocument, "pointerdown", (event) => {
      if (outside(event, node)) setOpen(false, true);
    }, true);
  }

  function move(index: number): void {
    if (index < 0) {
      panel?.focus();
      return;
    }
    focused = items[index];
    render();
    focused.focus();
  }

  function openAt(direction: 1 | -1): void {
    setOpen(true, true);
    move(nextEnabledIndex(items.map((item) => !disabled(item)), -1, direction));
  }

  listeners.on(node, "click", (event) => {
    const button = closestIn(node, event, "[data-menu-trigger]");
    if (button) {
      event.preventDefault();
      if (disabled(button)) return;
      if (open) setOpen(false, true, true);
      else openAt(1);
      return;
    }
    const item = closestIn(node, event, "[data-menu-item]");
    if (!item || !panel?.contains(item)) return;
    if (!open || disabled(item)) {
      event.preventDefault();
      return;
    }
    const value = item.dataset.menuItem!;
    setOpen(false, true, true);
    options.onSelect?.(value, event);
  });
  listeners.on(node, "focusin", (event) => {
    const item = closestIn(node, event, "[data-menu-item]");
    if (open && item && items.includes(item) && !disabled(item)) {
      focusOwner = item;
      focused = item;
      render();
    }
  });
  listeners.on(node, "focusout", (event) => {
    const item = closestIn(node, event, "[data-menu-item]");
    if (item && item === focusOwner && !disabled(item) && node.contains(item)) {
      focusOwner = null;
    }
    const target = event.relatedTarget as Node | null;
    if (open && target && !node.contains(target)) setOpen(false, true);
  });
  listeners.on(node, "keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const button = closestIn(node, event, "[data-menu-trigger]");
    if (button && !disabled(button)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openAt(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
    }
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true, true);
      return;
    }
    if (event.key === "Tab") {
      // Let native sequential navigation finish before removing the focused item.
      clearTimeout(tabTimer);
      tabTimer = setTimeout(() => {
        tabTimer = undefined;
        setOpen(false, true);
      }, 0);
      return;
    }
    const item = closestIn(node, event, "[data-menu-item]");
    if (!item) {
      if (
        event.target === panel && (
          event.key === "ArrowDown" || event.key === "Home" ||
          event.key === "ArrowUp" || event.key === "End"
        )
      ) {
        event.preventDefault();
        const direction = event.key === "ArrowDown" || event.key === "Home"
          ? 1
          : -1;
        move(
          nextEnabledIndex(
            items.map((entry) => !disabled(entry)),
            -1,
            direction,
          ),
        );
      }
      return;
    }
    if (!items.includes(item)) return;
    const enabled = items.map((entry) => !disabled(entry));
    let index = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      index = nextEnabledIndex(
        enabled,
        items.indexOf(item),
        event.key === "ArrowDown" ? 1 : -1,
      );
    } else if (event.key === "Home") index = nextEnabledIndex(enabled, -1, 1);
    else if (event.key === "End") index = nextEnabledIndex(enabled, -1, -1);
    else if (event.key === " ") {
      event.preventDefault();
      item.click();
      return;
    } else if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const key = event.key.toLocaleLowerCase();
      search = now - lastSearch > 500 ? key : search + key;
      lastSearch = now;
      const prefix = Array.from(search).every((char) => char === key)
        ? key
        : search;
      for (let step = 1; step <= items.length; step++) {
        const candidate = (items.indexOf(item) + step) % items.length;
        const label = items[candidate].getAttribute("aria-label") ??
          items[candidate].textContent ?? "";
        if (
          enabled[candidate] &&
          label.trim().toLocaleLowerCase().startsWith(prefix)
        ) {
          index = candidate;
          break;
        }
      }
    } else return;
    event.preventDefault();
    if (index >= 0) move(index);
  });
  render();
  if (open) openAt(1);
  bindOutside();
  const unobserve = observeChildren(node, render);
  return {
    update(next) {
      if (destroyed) return;
      requireId(next.id);
      options = next;
      if (next.open !== undefined) setOpen(next.open, false);
      render();
    },
    destroy() {
      if (destroyed) return;
      if (open && panel?.contains(node.ownerDocument.activeElement)) {
        restoreFocus(trigger);
      }
      destroyed = true;
      clearTimeout(tabTimer);
      unobserve();
      listeners.clear();
      outsideListeners.clear();
      attrs.restore();
    },
  };
}
