// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Removing a temporary tabindex while focused sends Chromium focus to body. */
export function focusElement(
  element: HTMLElement,
  preventScroll = false,
): () => void {
  let temporary = false;
  const restore = () => {
    element.removeEventListener("blur", restore);
    if (temporary && element.getAttribute("tabindex") === "-1") {
      element.removeAttribute("tabindex");
    }
  };
  element.focus({ preventScroll });
  if (!element.matches(":focus") && !element.hasAttribute("tabindex")) {
    temporary = true;
    element.setAttribute("tabindex", "-1");
    element.addEventListener("blur", restore, { once: true });
    element.focus({ preventScroll });
    if (!element.matches(":focus")) restore();
  }
  return restore;
}
