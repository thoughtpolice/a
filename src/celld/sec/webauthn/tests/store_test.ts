// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "@celld/core/assert";
import {
  MAX_CREDENTIALS_PER_USER,
  type PasskeyCredential,
  type PasskeyUser,
} from "@celld/sec/webauthn";
import { memoryPasskeyStore } from "@celld/sec/webauthn/testing";

const T0 = Date.UTC(2026, 8, 28);

function user(handle: string, key = `key-${handle}`): PasskeyUser {
  return {
    handle,
    principal: { subject: handle },
    principalKey: key,
    name: handle,
    displayName: handle,
    createdAt: T0,
  };
}

function credential(id: string, userHandle: string): PasskeyCredential {
  return {
    id,
    userHandle,
    publicKey: "pk",
    algorithm: -7,
    signCount: 0,
    transports: [],
    backupEligible: true,
    backupState: true,
    uvInitialized: true,
    aaguid: "00000000-0000-0000-0000-000000000000",
    attestationFormat: "none",
    name: "Passkey",
    createdAt: T0,
    lastUsedAt: null,
  };
}

let serial = 0;
function challenge() {
  return { challenge: `c${serial++}`, expiresAt: T0 + 300_000 };
}

Deno.test("store: a registration creates the user once and the credential", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  const ada = user("ada");
  assertEquals(
    await store.register({
      challenge: challenge(),
      user: ada,
      credential: credential("k1", "ada"),
    }),
    { ok: true },
  );
  assertEquals(
    await store.register({
      challenge: challenge(),
      user: ada,
      credential: credential("k2", "ada"),
    }),
    { ok: true },
  );
  assertEquals((await store.credentials("ada")).map((c) => c.id), ["k1", "k2"]);
  assertEquals((await store.userByPrincipal("key-ada"))?.handle, "ada");
  assertEquals(await store.user("nobody"), null);
});

Deno.test("store: each rule a registration can break", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  const used = challenge();
  await store.register({
    challenge: used,
    user: user("ada"),
    credential: credential("k1", "ada"),
  });
  const refused = async (
    reason: string,
    input: Parameters<typeof store.register>[0],
  ) => assertEquals(await store.register(input), { ok: false, reason });
  await refused("challenge_used", {
    challenge: used,
    user: user("bob"),
    credential: credential("k9", "bob"),
  });
  await refused("credential_exists", {
    challenge: challenge(),
    user: user("bob"),
    credential: credential("k1", "bob"),
  });
  // Another handle for a principal that has a user, or ada's handle with
  // another principal.
  await refused("principal_taken", {
    challenge: challenge(),
    user: user("ada2", "key-ada"),
    credential: credential("k3", "ada2"),
  });
  await refused("principal_taken", {
    challenge: challenge(),
    user: user("ada", "key-mallory"),
    credential: credential("k4", "ada"),
  });
  assertEquals(await store.user("bob"), null, "a refusal stores nothing");
  for (let i = 1; i < MAX_CREDENTIALS_PER_USER; i++) {
    await store.register({
      challenge: challenge(),
      user: user("ada"),
      credential: credential(`extra${i}`, "ada"),
    });
  }
  await refused("too_many_credentials", {
    challenge: challenge(),
    user: user("ada"),
    credential: credential("one-too-many", "ada"),
  });
});

Deno.test("store: a sign-in updates the counter once, with a fresh challenge", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  await store.register({
    challenge: challenge(),
    user: user("ada"),
    credential: credential("k1", "ada"),
  });
  const login = challenge();
  const result = await store.authenticate({
    challenge: login,
    credentialId: "k1",
    expectedSignCount: 0,
    signCount: 5,
    backupState: false,
    authenticatorUserVerified: true,
    usedAt: T0 + 1,
  });
  assertEquals(result.ok && result.user.handle, "ada");
  const updated = (await store.credential("k1"))!;
  assertEquals([updated.signCount, updated.backupState, updated.lastUsedAt], [
    5,
    false,
    T0 + 1,
  ]);
  const again = (
    reason: string,
    input: Partial<Parameters<typeof store.authenticate>[0]>,
  ) =>
    store.authenticate({
      challenge: challenge(),
      credentialId: "k1",
      expectedSignCount: 5,
      signCount: 6,
      backupState: false,
      authenticatorUserVerified: true,
      usedAt: T0 + 2,
      ...input,
    }).then((answer) => assertEquals(answer, { ok: false, reason }));
  await again("challenge_used", { challenge: login });
  await again("stale", { expectedSignCount: 0 });
  await again("unknown_credential", { credentialId: "nope" });
});

Deno.test("store: expired challenges are forgotten a few at a time", async () => {
  let now = T0;
  const store = memoryPasskeyStore({ now: () => now });
  for (let i = 0; i < 40; i++) {
    await store.register({
      challenge: { challenge: `old${i}`, expiresAt: T0 + 1000 },
      user: user("ada"),
      credential: credential(`k${i}`, "ada"),
    }).catch(() => {});
  }
  assertEquals(store.tables.challenges.size, 40);
  now = T0 + 2000;
  await store.register({
    challenge: challenge(),
    user: user("bob"),
    credential: credential("b1", "bob"),
  });
  assertEquals(store.tables.challenges.size, 40 - 16 + 1);
});

Deno.test("store: an already-expired challenge is atomically refused", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  assertEquals(
    await store.register({
      challenge: { challenge: "expired-registration", expiresAt: T0 },
      user: user("ada"),
      credential: credential("k1", "ada"),
    }),
    { ok: false, reason: "challenge_used" },
  );
  assertEquals(await store.credential("k1"), null);

  await store.register({
    challenge: challenge(),
    user: user("ada"),
    credential: credential("k1", "ada"),
  });
  assertEquals(
    await store.authenticate({
      challenge: { challenge: "expired-authentication", expiresAt: T0 },
      credentialId: "k1",
      expectedSignCount: 0,
      signCount: 1,
      backupState: true,
      authenticatorUserVerified: true,
      usedAt: T0,
    }),
    { ok: false, reason: "challenge_used" },
  );
  assertEquals((await store.credential("k1"))!.signCount, 0);
});

Deno.test("store: UV initialization requires explicit independent authorization", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  await store.register({
    challenge: challenge(),
    user: user("ada"),
    credential: { ...credential("k1", "ada"), uvInitialized: false },
  });
  await store.authenticate({
    challenge: challenge(),
    credentialId: "k1",
    expectedSignCount: 0,
    signCount: 1,
    backupState: true,
    authenticatorUserVerified: true,
    usedAt: T0 + 1,
  });
  assertEquals((await store.credential("k1"))!.uvInitialized, false);

  const promotion = challenge();
  await assertRejects(
    () =>
      store.authenticate({
        challenge: promotion,
        credentialId: "k1",
        expectedSignCount: 1,
        signCount: 2,
        backupState: true,
        authenticatorUserVerified: false,
        initializeUserVerification: { independentlyAuthorized: true },
        usedAt: T0 + 2,
      }),
    TypeError,
  );
  await assertRejects(
    () =>
      store.authenticate({
        challenge: promotion,
        credentialId: "k1",
        expectedSignCount: 1,
        signCount: 2,
        backupState: true,
        authenticatorUserVerified: true,
        initializeUserVerification: null as never,
        usedAt: T0 + 2,
      }),
    TypeError,
  );
  await assertRejects(
    () =>
      store.authenticate({
        challenge: promotion,
        credentialId: "k1",
        expectedSignCount: 1,
        signCount: 2,
        backupState: true,
        authenticatorUserVerified: true,
        initializeUserVerification: {
          independentlyAuthorized: true,
          extra: true,
        } as never,
        usedAt: T0 + 2,
      }),
    TypeError,
  );
  assertEquals((await store.credential("k1"))!.uvInitialized, false);
  const initialized = await store.authenticate({
    challenge: promotion,
    credentialId: "k1",
    expectedSignCount: 1,
    signCount: 2,
    backupState: true,
    authenticatorUserVerified: true,
    initializeUserVerification: { independentlyAuthorized: true },
    usedAt: T0 + 2,
  });
  assertEquals(initialized.ok, true);
  assertEquals((await store.credential("k1"))!.uvInitialized, true);
});

Deno.test("store: renames and removals only touch the user's own", async () => {
  const store = memoryPasskeyStore({ now: () => T0 });
  await store.register({
    challenge: challenge(),
    user: user("ada"),
    credential: credential("k1", "ada"),
  });
  await store.register({
    challenge: challenge(),
    user: user("bob"),
    credential: credential("k2", "bob"),
  });
  assertEquals(await store.rename("bob", "k1", "mine now"), false);
  assertEquals(await store.rename("ada", "k1", "  Laptop  "), true);
  assertEquals((await store.credential("k1"))!.name, "Laptop");
  await assertRejects(() => store.rename("ada", "k1", "bad\nname"), TypeError);
  await assertRejects(
    () => store.rename("ada", "k1", "x".repeat(65)),
    TypeError,
  );
  assertEquals(await store.remove("bob", "k1"), "not_found");
  assertEquals(await store.remove("ada", "k1", { keepLast: true }), "last");
  assertEquals((await store.credential("k1"))!.name, "Laptop");
  assertEquals(await store.remove("ada", "k1"), "removed");
  assertEquals(await store.credential("k1"), null);
});
