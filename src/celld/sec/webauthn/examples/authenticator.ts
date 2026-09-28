// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The `passkeys` spec's stand-in for a browser and its authenticators:
 * `VirtualAuthenticator`s behind two endpoints the spec calls directly
 * (`"url": "{upstream}/create"`). The Worker never calls it.
 *
 * - `POST /create` `{device, options, overrides?}`: what
 *   `navigator.credentials.create()` would post back for the options.
 * - `POST /get` `{device, options, overrides?}`: likewise for `get()`.
 *
 * `device` names an authenticator, made on first use: `phone` is a synced
 * passkey (backed up, no counter), `key` a security key (single-device,
 * counting signatures). Both run on `http://localhost:9876`, the origin
 * the spec configures. `overrides` makes one answer misbehave (another
 * origin, a bad signature, ...); see `AuthenticatorBehaviour`.
 *
 * @module
 */

import { serveUpstream } from "@celld/examples/upstream";
import {
  type AuthenticatorBehaviour,
  VirtualAuthenticator,
} from "@celld/sec/webauthn/testing";

const ORIGIN = "http://localhost:9876";

const devices = new Map<string, VirtualAuthenticator>();

function device(name: unknown): VirtualAuthenticator {
  if (name !== "phone" && name !== "key") {
    throw new TypeError('device is "phone" or "key"');
  }
  let found = devices.get(name);
  if (found === undefined) {
    found = new VirtualAuthenticator(
      name === "phone"
        ? { origin: ORIGIN }
        : { origin: ORIGIN, backupEligible: false, counter: true },
    );
    devices.set(name, found);
  }
  return found;
}

serveUpstream({
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/create" && path !== "/get")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const body = await request.json() as {
        device: string;
        options: never;
        overrides?: AuthenticatorBehaviour;
      };
      const authenticator = device(body.device);
      return Response.json(
        path === "/create"
          ? await authenticator.create(body.options, body.overrides)
          : await authenticator.get(body.options, body.overrides),
      );
    } catch (error) {
      // What a browser would reject the call with.
      return Response.json({
        error: error instanceof DOMException ? error.name : "TypeError",
        message: (error as Error).message,
      }, { status: 400 });
    }
  },
});
