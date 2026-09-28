// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser client against the real routes: `fetch` goes to the app with
 * a cookie jar, and `navigator.credentials` is a virtual authenticator
 * behind the binary options and credentials a browser deals in. Deno has
 * no `PublicKeyCredential`, so the module's own JSON conversions run.
 */

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import { router, session } from "@celld/web/router";
import { RelyingParty } from "@celld/sec/webauthn";
import {
  type BrowserCredential,
  passkeyClient,
  PasskeyError,
} from "@celld/sec/webauthn/browser";
import { passkeyRoutes } from "@celld/sec/webauthn/router";
import {
  memoryPasskeyStore,
  VirtualAuthenticator,
} from "@celld/sec/webauthn/testing";

const ORIGIN = "https://example.com";
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

function app() {
  const sessions = session({ keys: [{ id: "k1", secret: "s".repeat(32) }] });
  const served = router({ auth: sessions });
  served.mount(
    "/passkeys",
    passkeyRoutes({
      rp: new RelyingParty({ id: "example.com", origins: [ORIGIN] }),
      store: memoryPasskeyStore(),
      sessions,
      ceremonyScope: "test",
      keys: [{ id: "w1", secret: "w".repeat(32) }],
      signUp: true,
      unsafeUnthrottledSignUp: true,
      authorizeRegistration: () => true,
    }),
  );
  return served;
}

/** A page's `fetch`: same-origin, with a cookie jar. */
function pageFetch(served: ReturnType<typeof app>): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) {
      headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await served.fetch(
      new Request(`${ORIGIN}${input}`, { ...init, headers }),
      {},
      ctx,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = [
        pair.slice(0, pair.indexOf("=")),
        pair.slice(pair.indexOf("=") + 1),
      ];
      if (/max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
}

function b64(bytes: BufferSource | undefined): string {
  return toBase64Url(
    bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(
      (bytes as Uint8Array).buffer,
      (bytes as Uint8Array).byteOffset,
      (bytes as Uint8Array).byteLength,
    ),
  );
}

function buffer(text: string | undefined): ArrayBuffer {
  return fromBase64Url(text!)!.buffer;
}

/** `navigator.credentials` over a virtual authenticator. */
function credentials(device: VirtualAuthenticator) {
  const calls: { mediation?: string }[] = [];
  return {
    calls,
    async create(options: CredentialCreationOptions) {
      const o = options.publicKey!;
      const json = await device.create({
        rp: { id: o.rp.id!, name: o.rp.name },
        user: {
          id: b64(o.user.id),
          name: o.user.name,
          displayName: o.user.displayName,
        },
        challenge: b64(o.challenge),
        pubKeyCredParams: o.pubKeyCredParams.map((p) => ({
          type: "public-key" as const,
          alg: p.alg,
        })),
        timeout: o.timeout ?? 300_000,
        excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
          type: "public-key" as const,
          id: b64(c.id),
        })),
        authenticatorSelection: o.authenticatorSelection as never,
        attestation: "none",
        extensions: { credProps: true },
      });
      return {
        id: json.id,
        rawId: buffer(json.rawId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: buffer(json.response.clientDataJSON),
          attestationObject: buffer(json.response.attestationObject),
          getTransports: () => [...json.response.transports],
          getAuthenticatorData: () => buffer(json.response.authenticatorData),
          getPublicKeyAlgorithm: () => json.response.publicKeyAlgorithm,
        },
        getClientExtensionResults: () => json.clientExtensionResults,
      } satisfies BrowserCredential;
    },
    async get(options: CredentialRequestOptions) {
      calls.push({ mediation: options.mediation });
      const o = options.publicKey!;
      const json = await device.get({
        challenge: b64(o.challenge),
        timeout: o.timeout ?? 300_000,
        rpId: o.rpId!,
        allowCredentials: (o.allowCredentials ?? []).map((c) => ({
          type: "public-key" as const,
          id: b64(c.id),
        })),
        userVerification: o.userVerification as "required",
      });
      return {
        id: json.id,
        rawId: buffer(json.rawId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: buffer(json.response.clientDataJSON),
          authenticatorData: buffer(json.response.authenticatorData),
          signature: buffer(json.response.signature),
          userHandle: json.response.userHandle === undefined
            ? null
            : buffer(json.response.userHandle),
        },
        getClientExtensionResults: () => json.clientExtensionResults,
      } satisfies BrowserCredential;
    },
  };
}

/** Installs a `PublicKeyCredential` with only the signal methods, recording calls. */
function withSignals() {
  const signals: [string, unknown][] = [];
  const global = globalThis as { PublicKeyCredential?: unknown };
  const previous = global.PublicKeyCredential;
  global.PublicKeyCredential = {
    signalUnknownCredential: (o: unknown) => {
      signals.push(["unknown", o]);
      return Promise.resolve();
    },
    signalAllAcceptedCredentials: (o: unknown) => {
      signals.push(["accepted", o]);
      return Promise.resolve();
    },
  };
  return { signals, restore: () => global.PublicKeyCredential = previous };
}

Deno.test("browser: sign up, add, list, sign in, rename, remove", async () => {
  const served = app();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const laptop = new VirtualAuthenticator({ origin: ORIGIN });
  const page = pageFetch(served);
  const onPhone = credentials(phone);
  const client = passkeyClient({ fetch: page, credentials: onPhone });
  const created = await client.signUp({
    name: "ada@example.com",
    displayName: "Ada",
  });
  assertEquals(created.user.name, "ada@example.com");

  // Another page without the session cannot add one.
  const anonymous = passkeyClient({
    fetch: pageFetch(served),
    credentials: credentials(laptop),
  });
  const refused = await assertRejects(() => anonymous.add(), PasskeyError);
  assertEquals(refused.status, 401);
  // The signed-in page adds the laptop.
  const added = await passkeyClient({
    fetch: page,
    credentials: credentials(laptop),
  }).add();

  const elsewhere = pageFetch(served);
  const signIn = passkeyClient({ fetch: elsewhere, credentials: onPhone });
  const signedIn = await signIn.signIn({ conditional: true });
  assertEquals(signedIn.user.subject, created.user.subject);
  assertEquals(onPhone.calls.at(-1)?.mediation, "conditional");
  await signIn.signIn();
  assertEquals(onPhone.calls.at(-1)?.mediation, undefined);

  const { signals, restore } = withSignals();
  try {
    const listed = await signIn.list({ signal: true });
    assertEquals(listed.map((passkey) => passkey.id), [
      created.credential.id,
      added.credential.id,
    ]);
    const [kind, sent] = signals[0] as [
      string,
      { rpId: string; allAcceptedCredentialIds: string[] },
    ];
    assertEquals([kind, sent.rpId, sent.allAcceptedCredentialIds.length], [
      "accepted",
      "example.com",
      2,
    ]);
  } finally {
    restore();
  }
  await signIn.rename(added.credential.id, "Laptop");
  assertEquals((await signIn.list())[1].name, "Laptop");
  await signIn.remove(created.credential.id);
  const last = await assertRejects(
    () => signIn.remove(added.credential.id),
    PasskeyError,
  );
  assertEquals([last.status, last.code], [409, "last_passkey"]);
  assertEquals(await signIn.autofillAvailable(), false);
});

Deno.test("browser: a passkey the server does not know is signalled to the browser", async () => {
  const served = app();
  const stranger = new VirtualAuthenticator({ origin: ORIGIN });
  // Registered with another deployment, so unknown to this one.
  await passkeyClient({
    fetch: pageFetch(app()),
    credentials: credentials(stranger),
  })
    .signUp({ name: "elsewhere" });
  const { signals, restore } = withSignals();
  try {
    const error = await assertRejects(
      () =>
        passkeyClient({
          fetch: pageFetch(served),
          credentials: credentials(stranger),
        }).signIn(),
      PasskeyError,
    );
    assertEquals([error.status, error.code], [401, "unknown_credential"]);
    const [kind, sent] = signals[0] as [
      string,
      { rpId: string; credentialId: string },
    ];
    assertEquals([kind, sent.rpId, sent.credentialId], [
      "unknown",
      "example.com",
      stranger.credentials()[0].id,
    ]);
  } finally {
    restore();
  }
  assert(signals.length === 1, "one signal");
});
