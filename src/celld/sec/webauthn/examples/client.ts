// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `passkeys` example's page script, bundled for the browser and served
 * as `/client.js`: buttons for each ceremony, and a sign-in waiting in the
 * name field's autofill where the browser supports it.
 *
 * @module
 */

import { passkeyClient } from "@celld/sec/webauthn/browser";

const passkeys = passkeyClient({ base: "/passkeys" });

function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function show(value: unknown): void {
  element("out").textContent = value instanceof Error
    ? `${value.name}: ${value.message}`
    : JSON.stringify(value, null, 2);
}

function on(id: string, action: () => Promise<unknown>): void {
  element(id).addEventListener("click", () => {
    action().then(show, show);
  });
}

let autofill: AbortController | null = null;

/** Waits for a passkey picked from the name field's autofill. */
async function waitForAutofill(): Promise<void> {
  if (!await passkeys.autofillAvailable()) return;
  autofill?.abort();
  autofill = new AbortController();
  passkeys.signIn({ conditional: true, signal: autofill.signal })
    .then(show, () => {});
}

function name(): string {
  return (element("name") as HTMLInputElement).value;
}

addEventListener("DOMContentLoaded", () => {
  on("signup", () => {
    autofill?.abort();
    return passkeys.signUp({ name: name() });
  });
  on("signin", () => {
    autofill?.abort();
    return passkeys.signIn();
  });
  on("add", () => passkeys.add());
  on("list", () => passkeys.list({ signal: true }));
  on("me", () => fetch("/me").then((response) => response.json()));
  waitForAutofill();
});
