// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The test vectors of Web Authentication Level 3, section 16
 * (https://www.w3.org/TR/webauthn-3/#sctn-test-vectors), in vectors.json,
 * base64url-encoded from the hex printed there. The vectors are Copyright
 * © 2026 World Wide Web Consortium, used under the W3C Software and
 * Document License (https://www.w3.org/copyright/software-license/).
 *
 * All use the RP ID example.org and the origin https://example.org. None
 * carries a user handle, so authentication is checked as an identified
 * user's (`identified: true`).
 */

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import {
  type CborMap,
  decodeCbor,
  derToP1363,
  parseAuthenticatorData,
  RelyingParty,
  type RelyingPartyOptions,
  type StoredCredential,
  WebAuthnError,
} from "@celld/sec/webauthn";
import fixture from "./vectors.json" with { type: "json" };

interface Vector {
  readonly section: string;
  readonly title: string;
  readonly registration: {
    readonly challenge: string;
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly credentialId: string;
    readonly algorithm: number;
    readonly fmt: string;
    readonly flags: string;
  };
  readonly authentication: {
    readonly challenge: string;
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
  };
}

const vectors = fixture.vectors as Vector[];

function vector(section: string): Vector {
  return vectors.find((v) => v.section === section)!;
}

function rp(options: Partial<RelyingPartyOptions> = {}): RelyingParty {
  return new RelyingParty({
    id: "example.org",
    origins: ["https://example.org"],
    // Several vectors register without user verification.
    userVerification: "preferred",
    algorithms: [-8, -7, -35, -36, -257],
    ...options,
  });
}

function registration(v: Vector) {
  return {
    id: v.registration.credentialId,
    rawId: v.registration.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: v.registration.clientDataJSON,
      attestationObject: v.registration.attestationObject,
      transports: [],
    },
    clientExtensionResults: {},
  };
}

function assertion(v: Vector) {
  return {
    id: v.registration.credentialId,
    rawId: v.registration.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: v.authentication.clientDataJSON,
      authenticatorData: v.authentication.authenticatorData,
      signature: v.authentication.signature,
    },
    clientExtensionResults: {},
  };
}

/** The credential a vector registers, read from its authenticator data. */
function stored(v: Vector): StoredCredential {
  const object = decodeCbor(fromBase64Url(v.registration.attestationObject)!)
    .value as CborMap;
  const data = parseAuthenticatorData(object.get("authData") as Uint8Array);
  const credential = data.attestedCredential!;
  return {
    id: toBase64Url(credential.id),
    userHandle: "dXNlcg",
    publicKey: toBase64Url(credential.publicKeyBytes),
    algorithm: credential.publicKey.alg,
    signCount: data.signCount,
    backupEligible: data.flags.backupEligible,
    uvInitialized: data.flags.userVerified,
  };
}

async function refusedWith(code: string, fn: () => Promise<unknown>) {
  const error = await assertRejects(fn, WebAuthnError);
  assertEquals(error.code, code, error.message);
}

Deno.test("vectors: none and packed self attestation register", async () => {
  for (const section of ["16.2", "16.3", "16.6"]) {
    const v = vector(section);
    const result = await rp().verifyRegistration(registration(v), {
      challenge: v.registration.challenge,
    });
    assertEquals(result.id, v.registration.credentialId, section);
    assertEquals(result.algorithm, v.registration.algorithm, section);
    assertEquals(result.attestationFormat, v.registration.fmt, section);
    assertEquals(result.signCount, 0, section);
  }
  // 16.6's credential ID is the longest allowed.
  assertEquals(
    fromBase64Url(vector("16.6").registration.credentialId)!.length,
    1023,
  );
});

Deno.test("vectors: the flags come from the authenticator data", async () => {
  const none = await rp().verifyRegistration(registration(vector("16.2")), {
    challenge: vector("16.2").registration.challenge,
  });
  // 0x59: UP, BE, BS, AT.
  assertEquals(
    [none.userVerified, none.backupEligible, none.backupState],
    [false, true, true],
  );
  const self = await rp().verifyRegistration(registration(vector("16.3")), {
    challenge: vector("16.3").registration.challenge,
  });
  // 0x5d: UP, UV, BE, BS, AT.
  assertEquals(
    [self.userVerified, self.backupEligible, self.backupState],
    [true, true, true],
  );
  assertEquals(self.aaguid.length, 36);
});

Deno.test("vectors: requiring user verification refuses a registration without it", async () => {
  const v = vector("16.2");
  await refusedWith(
    "user_not_verified",
    () =>
      rp({ userVerification: "required" }).verifyRegistration(registration(v), {
        challenge: v.registration.challenge,
      }),
  );
});

Deno.test("vectors: frames are refused unless their embedders are allowed", async () => {
  const framed = vector("16.4"); // crossOrigin, no topOrigin
  const topped = vector("16.5"); // crossOrigin, topOrigin https://example.com
  for (const v of [framed, topped]) {
    await refusedWith(
      "origin_not_allowed",
      () =>
        rp().verifyRegistration(registration(v), {
          challenge: v.registration.challenge,
        }),
    );
  }
  const listed = rp({ topOrigins: ["https://example.com"] });
  await listed.verifyRegistration(registration(topped), {
    challenge: topped.registration.challenge,
  });
  await refusedWith(
    "origin_not_allowed",
    () =>
      listed.verifyRegistration(registration(framed), {
        challenge: framed.registration.challenge,
      }),
  );
  await rp({ topOrigins: "any" }).verifyRegistration(registration(framed), {
    challenge: framed.registration.challenge,
  });
});

Deno.test("vectors: certificate and platform attestations are not supported", async () => {
  for (
    const section of [
      "16.7",
      "16.8",
      "16.9",
      "16.10",
      "16.11",
      "16.13",
      "16.14",
      "16.15",
      "16.16",
    ]
  ) {
    const v = vector(section);
    const error = await assertRejects(
      () =>
        rp().verifyRegistration(registration(v), {
          challenge: v.registration.challenge,
        }),
      WebAuthnError,
    );
    assertEquals(error.code, "unsupported_attestation", section);
  }
});

Deno.test("vectors: Ed448 is refused as an algorithm WebCrypto lacks", async () => {
  const v = vector("16.12");
  await refusedWith(
    "unsupported_algorithm",
    () =>
      rp().verifyRegistration(registration(v), {
        challenge: v.registration.challenge,
      }),
  );
});

Deno.test("vectors: every assertion verifies with its registered key", async () => {
  for (const v of vectors) {
    if (v.section === "16.12") continue;
    const party = v.section === "16.4"
      ? rp({ topOrigins: "any" })
      : v.section === "16.5"
      ? rp({ topOrigins: ["https://example.com"] })
      : rp();
    const credential = stored(v);
    const result = await party.verifyAuthentication(assertion(v), {
      challenge: v.authentication.challenge,
      credential,
      identified: true,
    });
    assertEquals(result.credentialId, credential.id, v.section);
    assertEquals(result.counterRegressed, false, v.section);
  }
});

Deno.test("vectors: an assertion checked against the wrong challenge or key fails", async () => {
  const v = vector("16.2");
  const credential = stored(v);
  await refusedWith(
    "challenge_mismatch",
    () =>
      rp().verifyAuthentication(assertion(v), {
        challenge: v.registration.challenge,
        credential,
        identified: true,
      }),
  );
  await refusedWith(
    "bad_signature",
    () =>
      rp().verifyAuthentication(assertion(v), {
        challenge: v.authentication.challenge,
        credential: {
          ...credential,
          publicKey: stored(vector("16.3")).publicKey,
        },
        identified: true,
      }),
  );
  await refusedWith(
    "user_handle_mismatch",
    () =>
      rp().verifyAuthentication(assertion(v), {
        challenge: v.authentication.challenge,
        credential,
      }),
  );
});

Deno.test("vectors: the spec's DER signature with a 30-byte s", () => {
  const example = fixture.derSignatureExample;
  const hex = (text: string) =>
    Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
  const raw = derToP1363(hex(example.der), 32);
  assert(raw !== null, "it parses");
  assertEquals(toBase64Url(raw), toBase64Url(hex(example.p1363)));
});
