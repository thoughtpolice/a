// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

export interface Action<Options> {
  update(options: Options): void;
  destroy(): void;
}

export interface OpenOptions {
  /** Unique, stable, whitespace-free ID prefix supplied by the consumer. */
  id: string;
  /** Initial state; subsequent action updates with this value synchronize state. */
  open?: boolean;
  /** Called on user transitions, not when options synchronize state. */
  onOpenChange?: (open: boolean) => void;
}

export function requireId(id: string): void {
  if (!id || /\s/.test(id)) {
    throw new TypeError("Interaction id must be nonempty and whitespace-free");
  }
}

export function partId(id: string, part: string, value?: string): string {
  return `${id}-${part}${
    value === undefined ? "" : `-${encodeURIComponent(value)}`
  }`;
}

/** Tracks only attributes owned by an action, including their original absence. */
export class Attributes {
  private readonly original = new Map<Element, Map<string, string | null>>();
  private readonly touched = new Map<Element, Set<string>>();

  begin(): void {
    this.touched.clear();
  }

  originalValue(node: Element, name: string): string | null {
    const attrs = this.original.get(node);
    return attrs?.has(name) ? attrs.get(name)! : node.getAttribute(name);
  }

  set(node: Element, name: string, value: string | null): void {
    let attrs = this.original.get(node);
    if (!attrs) {
      attrs = new Map();
      this.original.set(node, attrs);
    }
    if (!attrs.has(name)) attrs.set(name, node.getAttribute(name));
    let names = this.touched.get(node);
    if (!names) {
      names = new Set();
      this.touched.set(node, names);
    }
    names.add(name);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }

  /** Release removed nodes without temporarily hiding or unfocusing live nodes. */
  end(): void {
    for (const [node, attrs] of this.original) {
      for (const [name, value] of attrs) {
        if (this.touched.get(node)?.has(name)) continue;
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
        attrs.delete(name);
      }
      if (attrs.size === 0) this.original.delete(node);
    }
    this.touched.clear();
  }

  restore(): void {
    for (const [node, attrs] of this.original) {
      for (const [name, value] of attrs) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    }
    this.original.clear();
    this.touched.clear();
  }
}

export class Listeners {
  private cleanup: (() => void)[] = [];

  on<K extends keyof HTMLElementEventMap>(
    node: HTMLElement | Document,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ): void {
    const handler = listener as EventListener;
    node.addEventListener(type, handler, capture);
    this.cleanup.push(() => node.removeEventListener(type, handler, capture));
  }

  clear(): void {
    for (const remove of this.cleanup) remove();
    this.cleanup = [];
  }
}

export function observeChildren(
  node: HTMLElement,
  sync: () => void,
): () => void {
  const Observer = node.ownerDocument.defaultView?.MutationObserver;
  if (!Observer) return () => {};
  const observer = new Observer(sync);
  observer.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "disabled",
      "aria-disabled",
      "data-tab",
      "data-tab-panel",
      "data-menu-item",
    ],
  });
  return () => observer.disconnect();
}

export function eventElement(event: Event): Element | null {
  const target = event.target as Node | null;
  return target?.nodeType === 1 ? target as Element : null;
}

export function closestIn(
  root: HTMLElement,
  event: Event,
  selector: string,
): HTMLElement | null {
  const element = eventElement(event)?.closest<HTMLElement>(selector);
  return element && root.contains(element) ? element : null;
}

export function disabled(node: HTMLElement): boolean {
  return node.matches(":disabled") ||
    node.getAttribute("aria-disabled") === "true" ||
    node.closest("[inert]") !== null;
}

export function focusable(node: HTMLElement): boolean {
  return !disabled(node) && !node.closest("[hidden]") &&
    node.getClientRects().length > 0;
}

export function restoreFocus(node: HTMLElement | null): void {
  if (node?.isConnected && focusable(node)) node.focus();
}

export function activeElement(document: Document): HTMLElement | null {
  const active = document.activeElement;
  return active && "focus" in active ? active as HTMLElement : null;
}

/** True when the pointer is outside a node, including shadow-DOM composed paths. */
export function outside(event: Event, node: HTMLElement): boolean {
  return !event.composedPath().includes(node);
}
