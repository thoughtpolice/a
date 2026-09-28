// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import { toBase64Url } from "@celld/sec/jwt";
import {
  RelyingParty,
  type RelyingPartyOptions,
  type StoredCredential,
  type VerifiedRegistration,
  WebAuthnError,
} from "@celld/sec/webauthn";
import {
  type AuthenticatorBehaviour,
  VirtualAuthenticator,
  type VirtualAuthenticatorOptions,
} from "@celld/sec/webauthn/testing";

const ORIGIN = "https://example.com";
const HANDLE = new Uint8Array(64).fill(7);

function rp(options: Partial<RelyingPartyOptions> = {}) {
  return new RelyingParty({ id: "example.com", origins: [ORIGIN], ...options });
}

async function refusedWith(code: string, fn: () => Promise<unknown>) {
  const error = await assertRejects(fn, WebAuthnError);
  assertEquals(error.code, code, error.message);
}

async function register(
  party: RelyingParty,
  authenticator: VirtualAuthenticator,
  overrides: AuthenticatorBehaviour = {},
): Promise<VerifiedRegistration> {
  const { options, challenge } = party.registrationOptions({
    user: { id: HANDLE, name: "ada@example.com", displayName: "Ada" },
  });
  const response = await authenticator.create(options, overrides);
  return await party.verifyRegistration(response, { challenge });
}

function stored(credential: VerifiedRegistration): StoredCredential {
  return {
    id: credential.id,
    userHandle: toBase64Url(HANDLE),
    publicKey: credential.publicKey,
    algorithm: credential.algorithm,
    signCount: credential.signCount,
    backupEligible: credential.backupEligible,
    uvInitialized: credential.userVerified,
  };
}

async function signIn(
  party: RelyingParty,
  authenticator: VirtualAuthenticator,
  credential: StoredCredential,
  overrides: AuthenticatorBehaviour = {},
  expected: { identified?: boolean; allowed?: string[] } = {},
) {
  const { options, challenge } = party.authenticationOptions();
  const response = await authenticator.get(options, overrides);
  return await party.verifyAuthentication(response, {
    challenge,
    credential,
    ...expected,
  });
}

function authenticator(options: Partial<VirtualAuthenticatorOptions> = {}) {
  return new VirtualAuthenticator({ origin: ORIGIN, ...options });
}

Deno.test("rp: options are a passkey's, with none attestation", () => {
  const { options, challenge } = rp().registrationOptions({
    user: { id: HANDLE, name: "ada@example.com" },
    exclude: [{ id: "AAEC", transports: ["usb", "bad transport"] }],
    hints: ["client-device"],
  });
  assertEquals(options.rp, { id: "example.com", name: "example.com" });
  assertEquals(options.user.displayName, "ada@example.com");
  assertEquals(options.pubKeyCredParams.map((p) => p.alg), [-8, -7, -257]);
  assertEquals(options.authenticatorSelection, {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
  });
  assertEquals(options.attestation, "none");
  assertEquals(options.excludeCredentials, [
    { type: "public-key", id: "AAEC", transports: ["usb"] },
  ]);
  assertEquals(options.hints, ["client-device"]);
  assertEquals(options.timeout, 300_000);
  assertEquals(challenge.length, 43);
  const request = rp().authenticationOptions();
  assertEquals(request.options.rpId, "example.com");
  assertEquals(request.options.allowCredentials, []);
  assert(request.challenge !== challenge, "fresh challenges");
});

Deno.test("rp: a passkey registers and signs in, for each key type", async () => {
  for (const algorithm of [-7, -8, -257] as const) {
    const party = rp();
    const device = authenticator({ algorithm });
    const credential = await register(party, device);
    assertEquals(credential.algorithm, algorithm);
    assertEquals(credential.attestationFormat, "none");
    assertEquals(credential.discoverable, true);
    assertEquals(credential.authenticatorAttachment, "platform");
    assertEquals(credential.transports, ["hybrid", "internal"]);
    assertEquals(credential.aaguid, "00000000-0000-0000-0000-000000000000");
    const result = await signIn(party, device, stored(credential));
    assertEquals(result.credentialId, credential.id);
    assertEquals([result.userVerified, result.backupState], [true, true]);
  }
});

Deno.test("rp: packed self attestation is verified", async () => {
  const credential = await register(
    rp(),
    authenticator({ selfAttestation: true }),
  );
  assertEquals(credential.attestationFormat, "packed");
});

Deno.test("rp: registrations are refused for what the spec refuses", async () => {
  const cases: [string, AuthenticatorBehaviour][] = [
    ["origin_not_allowed", { origin: "https://evil.example" }],
    ["origin_not_allowed", { origin: "https://example.com:8443" }],
    ["origin_not_allowed", {
      crossOrigin: true,
      topOrigin: "https://evil.example",
    }],
    ["wrong_ceremony", { type: "webauthn.get" }],
    ["challenge_mismatch", { challenge: "AAAA" }],
    ["rp_id_mismatch", { rpId: "evil.example" }],
    ["user_not_present", { userPresent: false }],
    ["user_not_verified", { userVerified: false }],
    ["backup_flags", { backupEligible: false, backupState: true }],
    ["invalid_response", { reservedFlags: 0x02 }],
    ["invalid_response", { reservedFlags: 0x20 }],
  ];
  for (const [code, overrides] of cases) {
    const error = await assertRejects(
      () => register(rp(), authenticator(), overrides),
      WebAuthnError,
    );
    assertEquals(error.code, code, JSON.stringify(overrides));
  }
});

Deno.test("rp: user verification may be preferred instead", async () => {
  const credential = await register(
    rp({ userVerification: "preferred" }),
    authenticator(),
    { userVerified: false },
  );
  assertEquals(credential.userVerified, false);
});

Deno.test("rp: UV is trusted only after independent initialization", async () => {
  const preferred = rp({ userVerification: "preferred" });
  const device = authenticator();
  const registration = await register(preferred, device, {
    userVerified: false,
  });
  const uninitialized = stored(registration);

  const observed = await signIn(preferred, device, uninitialized);
  assertEquals(
    [
      observed.authenticatorUserVerified,
      observed.userVerified,
      observed.uvInitialized,
    ],
    [true, false, false],
  );
  await refusedWith(
    "user_not_verified",
    () => signIn(rp(), device, uninitialized),
  );

  const initialized = await signIn(preferred, device, {
    ...uninitialized,
    uvInitialized: true,
  });
  assertEquals(
    [initialized.authenticatorUserVerified, initialized.userVerified],
    [true, true],
  );
});

Deno.test("rp: a credential with an algorithm not offered is refused", async () => {
  // An authenticator that ignores the offer is caught by the relying party.
  const party = rp({ algorithms: [-7] });
  const { options, challenge } = party.registrationOptions({
    user: { id: HANDLE, name: "ada" },
  });
  const response = await authenticator({ algorithm: -8 }).create({
    ...options,
    pubKeyCredParams: [{ type: "public-key", alg: -8 }],
  });
  await refusedWith(
    "unsupported_algorithm",
    () => party.verifyRegistration(response, { challenge }),
  );
});

Deno.test("rp: registration responses are checked for shape", async () => {
  const party = rp();
  const { options, challenge } = party.registrationOptions({
    user: { id: HANDLE, name: "ada" },
  });
  const response = await authenticator().create(options);
  const bad: unknown[] = [
    null,
    { ...response, type: "password" },
    { ...response, id: "AAAA" },
    { ...response, rawId: "not base64url!" },
    { ...response, response: { ...response.response, clientDataJSON: 5 } },
    {
      ...response,
      response: { ...response.response, attestationObject: "oA" },
    },
    {
      ...response,
      response: { ...response.response, attestationObject: "AAAA" },
    },
  ];
  for (const candidate of bad) {
    await refusedWith(
      "invalid_response",
      () => party.verifyRegistration(candidate, { challenge }),
    );
  }
});

Deno.test("rp: frames are allowed only from listed pages", async () => {
  const framed = { crossOrigin: true, topOrigin: "https://portal.example.net" };
  await register(
    rp({ topOrigins: ["https://portal.example.net"] }),
    authenticator(),
    framed,
  );
  await register(rp({ topOrigins: "any" }), authenticator(), {
    crossOrigin: true,
  });
  await refusedWith(
    "origin_not_allowed",
    () =>
      register(
        rp({ topOrigins: ["https://portal.example.net"] }),
        authenticator(),
        {
          crossOrigin: true,
        },
      ),
  );
  await refusedWith(
    "origin_not_allowed",
    () =>
      register(rp({ topOrigins: "any" }), authenticator(), {
        topOrigin: "https://portal.example.net",
      }),
  );
});

Deno.test("rp: sign-ins are refused for what the spec refuses", async () => {
  const party = rp();
  const device = authenticator();
  const credential = stored(await register(party, device));
  const cases: [string, AuthenticatorBehaviour][] = [
    ["origin_not_allowed", { origin: "https://evil.example" }],
    ["wrong_ceremony", { type: "webauthn.create" }],
    ["challenge_mismatch", { challenge: "AAAA" }],
    ["rp_id_mismatch", { rpId: "evil.example" }],
    ["user_not_present", { userPresent: false }],
    ["user_not_verified", { userVerified: false }],
    ["backup_flags", { backupEligible: false }],
    ["invalid_response", { reservedFlags: 0x02 }],
    ["bad_signature", { badSignature: true }],
    ["user_handle_mismatch", { omitUserHandle: true }],
  ];
  for (const [code, overrides] of cases) {
    const error = await assertRejects(
      () => signIn(party, device, credential, overrides),
      WebAuthnError,
    );
    assertEquals(error.code, code, JSON.stringify(overrides));
  }
  // An identified user's sign-in may leave the handle out.
  await signIn(party, device, credential, { omitUserHandle: true }, {
    identified: true,
  });
  // Backup state may change; eligibility may not.
  const unbacked = await signIn(party, device, credential, {
    backupState: false,
  });
  assertEquals(unbacked.backupState, false);
});

Deno.test("rp: the credential and handle must be the stored ones", async () => {
  const party = rp();
  const device = authenticator();
  const credential = stored(await register(party, device));
  await refusedWith(
    "user_handle_mismatch",
    () => signIn(party, device, { ...credential, userHandle: "AAAA" }),
  );
  await refusedWith(
    "unknown_credential",
    () => signIn(party, device, { ...credential, id: "AAAA" }),
  );
  await refusedWith(
    "unknown_credential",
    () => signIn(party, device, credential, {}, { allowed: ["AAAA"] }),
  );
  await signIn(party, device, credential, {}, { allowed: [credential.id] });
});

Deno.test("rp: a counter that does not advance is a clone warning", async () => {
  const party = rp();
  const device = authenticator({ counter: true });
  const registered = await register(party, device);
  let credential = stored(registered);
  const first = await signIn(party, device, credential);
  assertEquals(first.signCount, 1);
  credential = { ...credential, signCount: first.signCount };
  await refusedWith(
    "counter_regressed",
    () => signIn(party, device, credential, { signCount: 1 }),
  );
  const accepting = rp({ counterRegression: "accept" });
  const accepted = await signIn(accepting, device, credential, {
    signCount: 0,
  });
  assertEquals([accepted.counterRegressed, accepted.signCount], [true, 1]);
  // Both zero is a credential without a counter, never a regression.
  const synced = authenticator();
  const zero = stored(await register(party, synced));
  assertEquals((await signIn(party, synced, zero)).counterRegressed, false);
});

Deno.test("rp: options are checked when the relying party is made", () => {
  const cases: [Partial<RelyingPartyOptions>, RegExp][] = [
    [{ id: "Example.com" }, /lower-case domain/],
    [{ origins: [] }, /at least one origin/],
    [{ origins: ["https://example.com/"] }, /as the browser does/],
    [{ origins: ["http://example.com"] }, /not https/],
    [{ origins: ["https://example.net"] }, /not on example.com/],
    [{ relatedOrigins: ["http://example.net"] }, /not https/],
    [{ algorithms: [-7, -7] }, /distinct/],
    [{ algorithms: [-53 as never] }, /supported/],
    [{ timeoutMs: 1000 }, /30000/],
    [{ userVerification: "discouraged" as never }, /userVerification/],
    [{ extra: 1 } as never, /no option "extra"/],
  ];
  for (const [options, message] of cases) {
    const error = assertThrows(() => rp(options));
    assert(message.test(error.message), `${message}: ${error.message}`);
  }
  rp({ origins: ["https://example.com", "https://app.example.com"] });
  new RelyingParty({ id: "localhost", origins: ["http://localhost:8787"] });
  const related = rp({
    relatedOrigins: ["https://example.net", "android:apk-key-hash:abc"],
  });
  assertEquals(related.relatedOriginsDocument(), {
    origins: ["https://example.com", "https://example.net"],
  });
});

Deno.test("rp: a related origin's ceremony is accepted", async () => {
  const party = rp({ relatedOrigins: ["https://example.net"] });
  await register(party, authenticator({ origin: "https://example.net" }));
});

Deno.test("rp: registration input is checked", () => {
  const party = rp();
  assertThrows(
    () =>
      party.registrationOptions({ user: { id: new Uint8Array(0), name: "a" } }),
    TypeError,
  );
  assertThrows(
    () =>
      party.registrationOptions({
        user: { id: new Uint8Array(65), name: "a" },
      }),
    TypeError,
  );
  assertThrows(
    () => party.registrationOptions({ user: { id: HANDLE, name: "" } }),
    TypeError,
  );
  assertThrows(
    () =>
      party.registrationOptions({
        user: { id: HANDLE, name: "a" },
        hints: ["phone" as never],
      }),
    TypeError,
  );
  assertThrows(
    () =>
      party.registrationOptions({
        user: { id: HANDLE, name: "a" },
        exclude: [{ id: "!!" }],
      }),
    TypeError,
  );
});
