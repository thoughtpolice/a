// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  type Action,
  activeElement,
  Attributes,
  disabled,
  focusable,
  Listeners,
  type OpenOptions,
  requireId,
  restoreFocus,
} from "./dom.ts";

export interface ModalDialogOptions extends OpenOptions {
  /** External native button that opens the dialog and receives focus on close. */
  trigger?: HTMLElement | null;
  /** Optional initial focus target within the dialog, evaluated on every open. */
  initialFocus?: () => HTMLElement | null;
  /** Dismiss a pointer click on the native backdrop. Defaults to true. */
  closeOnOutside?: boolean;
}

/** Native modal dialog: the browser supplies inertness and the focus trap. */
export function modalDialog(
  node: HTMLElement,
  initial: ModalDialogOptions,
): Action<ModalDialogOptions> {
  if (node.localName !== "dialog") {
    throw new TypeError("modalDialog requires a native <dialog> element");
  }
  requireId(initial.id);
  const dialog = node as HTMLDialogElement;
  const attrs = new Attributes();
  const listeners = new Listeners();
  let options = initial;
  let open = false;
  let returnTo: HTMLElement | null = null;
  let backdropDown = false;
  let destroyed = false;

  function render(): void {
    attrs.set(node, "id", options.id);
    attrs.set(node, "aria-modal", "true");
    attrs.set(node, "tabindex", "-1");
    if (options.trigger) {
      attrs.set(options.trigger, "aria-haspopup", "dialog");
      attrs.set(options.trigger, "aria-controls", options.id);
      attrs.set(options.trigger, "aria-expanded", String(open));
    }
  }

  function setOpen(next: boolean, notify: boolean): void {
    if (destroyed || next === open) return;
    if (next) {
      returnTo = activeElement(node.ownerDocument);
      // SSR may have supplied `open`; showModal must still enter the top layer.
      if (dialog.open) dialog.close();
      dialog.showModal();
      open = true;
      const target = options.initialFocus?.();
      if (target && node.contains(target) && focusable(target)) target.focus();
    } else {
      open = false;
      if (dialog.open) dialog.close();
      restoreFocus(options.trigger ?? returnTo);
      returnTo = null;
    }
    render();
    if (notify) options.onOpenChange?.(open);
  }

  function isBackdrop(event: PointerEvent | MouseEvent): boolean {
    if (event.target !== node) return false;
    const bounds = node.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  }

  function bind(): void {
    listeners.clear();
    if (options.trigger) {
      listeners.on(options.trigger, "click", () => {
        if (!disabled(options.trigger!)) setOpen(!open, true);
      });
    }
    listeners.on(node, "cancel", (event) => {
      event.preventDefault();
      setOpen(false, true);
    });
    listeners.on(node, "close", () => {
      if (!dialog.open && open) setOpen(false, true);
    });
    listeners.on(node, "pointerdown", (event) => {
      backdropDown = isBackdrop(event);
    });
    listeners.on(node, "click", (event) => {
      if (
        backdropDown && isBackdrop(event) && options.closeOnOutside !== false
      ) {
        setOpen(false, true);
      }
      backdropDown = false;
    });
  }

  render();
  bind();
  setOpen(initial.open ?? false, false);
  // An SSR `open` without a requested modal state must not stay visible.
  if (!open && dialog.open) dialog.close();

  return {
    update(next) {
      if (destroyed) return;
      requireId(next.id);
      attrs.restore();
      options = next;
      bind();
      if (next.open !== undefined) setOpen(next.open, false);
      render();
    },
    destroy() {
      if (destroyed) return;
      listeners.clear();
      setOpen(false, false);
      destroyed = true;
      attrs.restore();
    },
  };
}
