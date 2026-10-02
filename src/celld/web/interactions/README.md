<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/web/interactions

First-party, headless DOM actions for hydrated celld web applications. Module
initialization is SSR-safe: no `window`, `document`, timers, or listeners are read
or created at import time. The actions require a real browser DOM when invoked.
They provide behavior and ARIA, not styling or positioning. Import them through
`@celld/web/interactions` and declare the `:interactions` library as a direct dep.

Every action has the Svelte-compatible signature
`(node: HTMLElement, options) => { update(options), destroy() }`. An action update
replaces its options, rather than patching them. `destroy()` is idempotent,
disconnects observers, clears timers and every listener, and restores the
attributes the action took ownership of, including attributes originally absent.
Updates after destroy are ignored. DOM children added/removed after hydration
are discovered automatically; native `disabled` and `aria-disabled` changes also
refresh roving navigation. Consumers must not bind action-owned attributes (`id`,
`role`, `tabindex`, `hidden`, and the ARIA relationships below) concurrently.

Supply a stable, unique, nonempty, whitespace-free `id`. Child IDs are
`<id>-<part>-<encodeURIComponent(value)>`; do not reuse item values within a
widget. Provide accessible names and application-specific styling yourself.
Use **native buttons with `type="button"`** for triggers and tabs. Menu items may
be buttons or links. `disabled` and `aria-disabled="true"` items cannot activate
and are skipped by roving focus. Do not place interactive controls inside a
button or a menu command.

## Options and state

`modalDialog`, `disclosure`, `menu`, and `tooltip` accept `id`, optional `open`,
and optional `onOpenChange(open)`. Initial `open` defaults to false. User actions
update the widget immediately and call the callback when its state changes.
Supplying `open` on a subsequent options update synchronizes state without
calling the callback; omitting it preserves local state. For controlled usage,
write the callback result back to the state used in your options. Action-managed
state is not persisted across remounts.

`tabs` accepts `id`, optional `selected` (the `data-tab` value),
`orientation: "horizontal" | "vertical"` (default horizontal),
`activation: "automatic" | "manual"` (default automatic), and
`onSelect(value)`. Selection falls back to the first enabled tab if absent,
removed or disabled. Options updates supplying `selected` synchronize selection;
user transitions call `onSelect`, not options synchronization.
Each tab container owns its own list and panels. Tabs nested inside a panel
retain independent IDs, selection and keyboard handling. Disabling or removing
the focused tab/item recovers focus to an enabled destination rather than leaving
the document body focused; panels also return focus when their content is hidden.

`modalDialog` additionally accepts `trigger?: HTMLElement | null`,
`initialFocus?: () => HTMLElement | null`, and `closeOnOutside?: boolean`
(default true). Use it only on native `<dialog>`. The browser's `showModal()`
provides top-layer rendering, document inertness, and focus trapping. The
optional initial-focus callback is evaluated on each open; its target must be
visible, enabled and inside the dialog. Native focus selection is otherwise
preserved. Closing returns focus to the supplied trigger, or the element focused
before opening, if still connected and focusable. The trigger gets
`aria-haspopup="dialog"`, `aria-controls`, and `aria-expanded`. Give the dialog an
accessible name through `aria-labelledby` or `aria-label`. Native dialog close
buttons may use `<form method="dialog">`; native `close()` events synchronize the
action and invoke `onOpenChange(false)`. A native dialog-supporting browser is
required; there is no nonmodal fallback.

`menu` additionally accepts `onSelect(value, event: MouseEvent)`. Selection closes
the menu and returns focus to its trigger before invoking this callback. Native
link navigation is retained; call `event.preventDefault()` in `onSelect` when the
application intentionally handles it itself. Use menus for commands; a list of
ordinary site-navigation links usually does not need menu keyboard semantics.

`tooltip` additionally accepts `delay?: number` (default 300 milliseconds) for
pointer hover. Delay must be finite and nonnegative. Focus opens immediately.
It preserves the trigger's existing `aria-describedby` tokens and adds the
consumer's tooltip ID. Tooltip content must be noninteractive and must not be
an essential instruction or the trigger's sole accessible name. Position it so
users can move the pointer from trigger to content without crossing a gap.
Touch-only interactions do not open a tooltip on hover.

## Keyboard contracts

| Widget | Keyboard and dismissal |
| --- | --- |
| Modal dialog | Enter/Space activate its native trigger. Native modal Tab/Shift+Tab stay inside the dialog. Escape cancels and restores focus. A click beginning and ending on the native backdrop dismisses unless `closeOnOutside` is false. |
| Tabs | One enabled tab is in the tab order. Horizontal Left/Right (reversed in RTL) or vertical Up/Down wrap past disabled tabs. Home/End select focus boundaries. Automatic mode selects with focus; manual mode selects with Enter/Space or click. Tab moves into the selected panel, which is focusable and linked by `aria-labelledby`. |
| Disclosure | Enter/Space and click toggle its native button. `aria-expanded` and `aria-controls` link the hidden panel. Closing while focus is inside the panel returns focus to the trigger. No Escape or outside dismissal. |
| Menu | Enter/Space on the native trigger opens the first enabled item; Down opens first, Up opens last. Up/Down wrap, Home/End reach boundaries. Printable characters search command labels; repeated characters cycle matching initials. Enter/Space activate commands. Escape dismisses and restores trigger focus. Tab/Shift+Tab leave normally and dismiss. Outside pointerdown and focus leaving the widget dismiss. |
| Tooltip | Trigger focus opens immediately; blur hides unless pointer remains over trigger/content. Hover opens after delay and stays open while the pointer is over either. Escape or outside pointerdown hides; Escape suppresses reopening until a leave/blur. Tooltip content never receives focus. |

## Actual Svelte action usage

These actions are ordinary imports, not Svelte compiler/runtime wrappers. The
following component uses all five APIs. The consumer controls names, IDs, native
controls, and markup. Closed SSR content is marked `hidden` to avoid flashing
before hydration; do not subsequently bind `hidden` while an action owns it.
The dialog starts without `open`, so it is also closed during SSR.

```svelte
<script lang="ts">
  import { disclosure, menu, modalDialog, tabs, tooltip } from '@celld/web/interactions';

  let dialogTrigger = $state<HTMLButtonElement>();
  let dialogOpen = $state(false);
  let selected = $state('account');
  let menuChoice = $state('');
</script>

<button type="button" bind:this={dialogTrigger}>Edit profile</button>
<dialog
  aria-labelledby="profile-title"
  use:modalDialog={{
    id: 'profile-dialog',
    trigger: dialogTrigger,
    open: dialogOpen,
    onOpenChange: (value) => { dialogOpen = value; },
  }}
>
  <h2 id="profile-title">Edit profile</h2>
  <label>Name <input name="name" autofocus /></label>
  <form method="dialog"><button type="submit">Done</button></form>
</dialog>

<section use:tabs={{ id: 'settings', selected, onSelect: (value) => { selected = value; } }}>
  <div data-tab-list aria-label="Settings sections">
    <button type="button" data-tab="account">Account</button>
    <button type="button" data-tab="billing">Billing</button>
    <button type="button" data-tab="unavailable" disabled>Unavailable</button>
  </div>
  <section data-tab-panel="account">Account details</section>
  <section data-tab-panel="billing" hidden>Billing details</section>
  <section data-tab-panel="unavailable" hidden>Unavailable details</section>
</section>

<section use:disclosure={{ id: 'advanced' }}>
  <button type="button" data-disclosure-trigger>Advanced settings</button>
  <div data-disclosure-panel hidden><label>Alias <input name="alias" /></label></div>
</section>

<div use:menu={{ id: 'commands', onSelect: (value) => { menuChoice = value; } }}>
  <button type="button" data-menu-trigger>Commands</button>
  <div data-menu-panel hidden>
    <button type="button" data-menu-item="save">Save</button>
    <button type="button" data-menu-item="archive" disabled>Archive</button>
    <a href="/help" data-menu-item="help">Help</a>
  </div>
</div>
<p aria-live="polite">Last command: {menuChoice}</p>

<span use:tooltip={{ id: 'save-description' }}>
  <button type="button" data-tooltip-trigger>Save</button>
  <span data-tooltip-content hidden>Save the current changes.</span>
</span>
```

All compound-widget markers belong to a single action container. Do not nest a
second instance of the same primitive inside that container. Supply exactly one
trigger/panel pair for disclosure, menu and tooltip, and a `data-tab-list` with
matching unique tab/panel values for tabs. Supply `aria-label` or
`aria-labelledby` on the tab list; the action does not invent a label.

The exported `nextEnabledIndex(enabled, from, direction)` is the deterministic
roving-focus calculation used by tabs and menus. It wraps, skips disabled
entries, returns `-1` if none are enabled, and accepts `from = -1` to find the
first (`direction = 1`) or last (`direction = -1`) enabled entry. Its library
tests cover boundary and disabled-item behavior without substituting a fake DOM
for actual browser focus. Browser examples must also exercise native dialog
focus trapping and action teardown after hydration.

The actual native-compiled SSR/hydration fixture is
`toolchains//celld/tests/svelte:hydration-project`, with bindings in
[`TestPage.svelte`](../../../../buck/toolchains/celld/tests/svelte/TestPage.svelte).
It includes nested manual/vertical tabs, disabled items and a conditional
unmount/remount path. Modal, tab, disclosure, menu and tooltip behavior is owned
by these actions, not by an npm component implementation.

