// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type Action,
  Attributes,
  disabled,
  eventElement,
  Listeners,
  observeChildren,
  type OpenOptions,
  outside,
  requireId,
} from "./dom.ts";

export interface TooltipOptions extends OpenOptions {
  /** Pointer hover delay in milliseconds; keyboard focus opens immediately. */
  delay?: number;
}

/** Focusable trigger and noninteractive content, not a replacement for a label. */
export function tooltip(
  node: HTMLElement,
  initial: TooltipOptions,
): Action<TooltipOptions> {
  validate(initial);
  const attrs = new Attributes();
  const listeners = new Listeners();
  const openListeners = new Listeners();
  let options = initial;
  let open = initial.open ?? false;
  let hovered = false;
  let suppressed = false;
  let trigger: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let timer: number | undefined;
  let destroyed = false;

  function render(): void {
    if (destroyed) return;
    attrs.begin();
    trigger = node.querySelector<HTMLElement>("[data-tooltip-trigger]");
    content = node.querySelector<HTMLElement>("[data-tooltip-content]");
    if (!trigger || disabled(trigger)) {
      clearTimeout(timer);
      timer = undefined;
      open = false;
      openListeners.clear();
    }
    if (trigger) {
      const descriptions =
        (attrs.originalValue(trigger, "aria-describedby") ?? "")
          .split(/\s+/).filter(Boolean);
      if (!descriptions.includes(options.id)) descriptions.push(options.id);
      attrs.set(trigger, "aria-describedby", descriptions.join(" "));
    }
    if (content) {
      attrs.set(content, "id", options.id);
      attrs.set(content, "role", "tooltip");
      attrs.set(content, "hidden", open ? null : "");
    }
    attrs.end();
  }

  function setOpen(next: boolean, notify: boolean): void {
    clearTimeout(timer);
    timer = undefined;
    if (destroyed || open === next) return;
    open = next;
    render();
    bindOpen();
    if (notify) options.onOpenChange?.(open);
  }

  function bindOpen(): void {
    openListeners.clear();
    if (!open) return;
    openListeners.on(node.ownerDocument, "keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        suppressed = true;
        setOpen(false, true);
      }
    });
    openListeners.on(node.ownerDocument, "pointerdown", (event) => {
      if (outside(event, node)) {
        suppressed = true;
        setOpen(false, true);
      }
    }, true);
  }

  function schedule(): void {
    if (destroyed || suppressed || !trigger || disabled(trigger) || open) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (hovered && !suppressed && trigger && !disabled(trigger)) {
        setOpen(true, true);
      }
    }, options.delay ?? 300);
  }

  listeners.on(node, "pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const target = eventElement(event);
    if (target && (trigger?.contains(target) || content?.contains(target))) {
      if (hovered) return;
      hovered = true;
      schedule();
    }
  });
  listeners.on(node, "pointerout", (event) => {
    if (event.pointerType === "touch") return;
    const next = event.relatedTarget as Node | null;
    if (next && (trigger?.contains(next) || content?.contains(next))) return;
    hovered = false;
    suppressed = false;
    clearTimeout(timer);
    timer = undefined;
    if (!trigger?.contains(node.ownerDocument.activeElement)) {
      setOpen(false, true);
    }
  });
  listeners.on(node, "focusin", (event) => {
    const target = eventElement(event);
    if (
      trigger && target && trigger.contains(target) && !disabled(trigger) &&
      !suppressed
    ) {
      setOpen(true, true);
    }
  });
  listeners.on(node, "focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && trigger?.contains(next)) return;
    suppressed = false;
    if (!hovered) setOpen(false, true);
  });
  render();
  bindOpen();
  const unobserve = observeChildren(node, render);
  return {
    update(next) {
      if (destroyed) return;
      validate(next);
      clearTimeout(timer);
      timer = undefined;
      options = next;
      if (next.open !== undefined) setOpen(next.open, false);
      render();
      if (hovered && next.open === undefined) schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      unobserve();
      listeners.clear();
      openListeners.clear();
      attrs.restore();
    },
  };
}

function validate(options: TooltipOptions): void {
  requireId(options.id);
  if (
    options.delay !== undefined &&
    (!Number.isFinite(options.delay) || options.delay < 0)
  ) {
    throw new TypeError("Tooltip delay must be a finite nonnegative number");
  }
}
