// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** SSR-safe headless DOM actions. Importing this module never reads the DOM. */
export { modalDialog, type ModalDialogOptions } from "./dialog.ts";
export { disclosure, type DisclosureOptions } from "./disclosure.ts";
export type { Action, OpenOptions } from "./dom.ts";
export { menu, type MenuOptions } from "./menu.ts";
export { nextEnabledIndex } from "./navigation.ts";
export { tabs, type TabsOptions } from "./tabs.ts";
export { tooltip, type TooltipOptions } from "./tooltip.ts";
