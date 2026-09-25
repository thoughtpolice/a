// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  API_NAMESPACE,
  armorSshsig,
  base64UrlDecode,
  checkPermissionsText,
  cmdsAllow,
  dearmorSshsig,
  DEFAULT_CMDS,
  encodePermissions,
  fingerprint,
  formatPublicKeyLine,
  mintExe0,
  mintingTokenSource,
  parseOpenSshPrivateKey,
  parsePublicKeyLine,
  parseSshsig,
  parseToken,
  permissions,
  permissionsIssues,
  signerFromOpenSsh,
  SshFormatError,
  sshsigSign,
  sshsigVerify,
  TokenError,
  verifyExe0,
  vmNamespace,
} from "@celld/api/exedev";
import { virtualRuntime } from "@celld/api/exedev/testing";
import * as fixture from "./fixtures.ts";

function messages(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
) {
  return issues.map((issue) =>
    `${
      issue.path.length === 0 ? "(root)" : issue.path.join(".")
    }: ${issue.message}`
  );
}

async function throwsToken(
  promise: Promise<unknown> | (() => unknown),
): Promise<TokenError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    if (error instanceof TokenError) return error;
    throw error;
  }
  throw new Error("expected a TokenError");
}

Deno.test("minting reproduces ssh-keygen's exe0 token byte for byte", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({ signer, permissions: fixture.PERMISSIONS });
  assertEquals(token, fixture.TOKEN);
});

Deno.test("minting a VM token uses the v0@<vm>.exe.xyz namespace", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({
    signer,
    vm: fixture.VM_NAME,
    permissions: fixture.VM_PERMISSIONS,
  });
  assertEquals(token, fixture.VM_TOKEN);
  assertEquals(vmNamespace("web-0"), "v0@web-0.exe.xyz");
});

Deno.test("an SSHSIG blob matches ssh-keygen's armored signature", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const blob = await sshsigSign(
    signer,
    new TextEncoder().encode(fixture.PERMISSIONS),
    API_NAMESPACE,
  );
  assertEquals(armorSshsig(blob), fixture.SIGNATURE);
  assertEquals(dearmorSshsig(fixture.SIGNATURE), blob);
});

Deno.test("encoded permissions sign to the same token as the fixture text", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const encoded = encodePermissions({
    exp: 4102444799,
    cmds: ["ls", "whoami", "ssh fixture-vm"],
    ctx: { role: "ci" },
  });
  assertEquals(encoded, fixture.PERMISSIONS);
  assertEquals(
    await mintExe0({ signer, permissions: JSON.parse(encoded) }),
    fixture.TOKEN,
  );
});

Deno.test("the private key parses to the fixture's public key and fingerprint", async () => {
  const key = parseOpenSshPrivateKey(fixture.PRIVATE_KEY);
  assertEquals(key.comment, "exedev-test-fixture");
  assertEquals(
    formatPublicKeyLine(key.publicKey, key.comment),
    fixture.PUBLIC_KEY,
  );
  assertEquals(
    await fingerprint(parsePublicKeyLine(fixture.PUBLIC_KEY)),
    fixture.FINGERPRINT,
  );
});

Deno.test("parseToken decodes an exe0 payload and signature", () => {
  const parsed = parseToken(fixture.TOKEN);
  assert(parsed.kind === "exe0", "exe0");
  assertEquals(parsed.payload, fixture.PERMISSIONS);
  assertEquals(parsed.permissions.cmds, ["ls", "whoami", "ssh fixture-vm"]);
  assertEquals(parsed.permissions.ctx, { role: "ci" });
  assertEquals(parsed.issues, []);
  assertEquals(parsed.signature.namespace, "v0@exe.dev");
  assertEquals(parsed.signature.hashAlgorithm, "sha512");
  assertEquals(parsed.signature.signature.length, 64);
});

Deno.test("parseToken recognises exe1 handles and refuses junk", async () => {
  assertEquals(parseToken("exe1.AAA_b-9"), {
    kind: "exe1",
    token: "exe1.AAA_b-9",
  });
  for (
    const junk of ["", "exe0.abc", "exe2.x.y", "exe0.!!.x", "Bearer exe1.x"]
  ) {
    await throwsToken(() => parseToken(junk));
  }
  const bad = await throwsToken(() =>
    parseToken(`exe0.${fixture.TOKEN.split(".")[1]}.AAAA`)
  );
  assertEquals(bad.issues[0].path, ["signature"]);
});

Deno.test("parseToken reports payload rule breaks without throwing", () => {
  const payload = btoa('{"exp":2e9}').replace(/=+$/, "");
  const signature = fixture.TOKEN.split(".")[2];
  const parsed = parseToken(`exe0.${payload}.${signature}`);
  assert(parsed.kind === "exe0", "exe0");
  assertEquals(messages(parsed.issues), [
    "exp: must be written as an integer, not 2e9",
  ]);
});

Deno.test("verifyExe0 accepts the fixture and reports its key", async () => {
  const result = await verifyExe0(fixture.TOKEN, {
    namespace: API_NAMESPACE,
    keys: [fixture.PUBLIC_KEY],
    now: Date.parse("2030-01-01T00:00:00Z"),
  });
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.fingerprint, fixture.FINGERPRINT);
  assertEquals(result.namespace, "v0@exe.dev");
  const vm = await verifyExe0(fixture.VM_TOKEN, {
    vm: fixture.VM_NAME,
    keys: [fixture.FINGERPRINT],
  });
  assert(vm.ok, JSON.stringify(vm));
});

Deno.test("verifyExe0 refuses wrong namespaces, keys, times and tampering", async () => {
  const cases: [string, Parameters<typeof verifyExe0>[1], string][] = [
    [
      fixture.TOKEN,
      { vm: "fixture-vm" },
      "signed for v0@exe.dev, expected v0@fixture-vm.exe.xyz",
    ],
    [
      fixture.VM_TOKEN,
      { namespace: API_NAMESPACE },
      "signed for v0@fixture-vm.exe.xyz, expected v0@exe.dev",
    ],
    [
      fixture.TOKEN,
      { keys: ["SHA256:nope"] },
      `signed by an unknown key ${fixture.FINGERPRINT}`,
    ],
    [fixture.TOKEN, { now: 4102444800_000 + 1000 }, "expired"],
  ];
  for (const [token, options, reason] of cases) {
    const result = await verifyExe0(token, options);
    assertEquals(result, { ok: false, reason });
  }
  const [, , signature] = fixture.TOKEN.split(".");
  const forged = `exe0.${
    btoa('{"cmds":["rm"]}').replace(/=+$/, "")
  }.${signature}`;
  assertEquals(await verifyExe0(forged), {
    ok: false,
    reason: "the signature does not verify",
  });
  const exe1 = await verifyExe0("exe1.abc");
  assert(!exe1.ok, "exe1 cannot be verified");
});

Deno.test("verifyExe0 honours nbf", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const token = await mintExe0({ signer, permissions: { nbf: 2000000000 } });
  assertEquals(await verifyExe0(token, { now: 1999999999_000 }), {
    ok: false,
    reason: "not yet valid",
  });
  assert(
    (await verifyExe0(token, { now: 2000000001_000 })).ok,
    "valid after nbf",
  );
});

Deno.test("permission text rules follow the HTTPS API page", () => {
  const cases: [string, string[]][] = [
    ["{}", []],
    [' {"exp":2000000000}', ["(root): no leading or trailing whitespace"]],
    ['{"exp":2000000000}\n', [
      "(root): no leading or trailing whitespace",
      "(root): no newlines",
    ]],
    ['{"exp":2000000000.0}', [
      "exp: must be written as an integer, not 2000000000.0",
    ]],
    ['{"exp":2e9}', ["exp: must be written as an integer, not 2e9"]],
    ['{"exp":946684799}', ["exp: must be between 946684800 and 4102444800"]],
    ['{"nbf":4102444801}', ["nbf: must be between 946684800 and 4102444800"]],
    ['{"exp":"2000000000"}', ["exp: must be an integer, got a string"]],
    ['{"cmds":["ls"],"cmds":["rm"]}', ["cmds: duplicate key"]],
    ['{"ctx":{"a":1,"a":2}}', ["ctx.a: duplicate key"]],
    ['{"jti":"x"}', ["jti: unknown field; only exp, nbf, cmds and ctx"]],
    ['{"ctx":"\\u0000"}', ["(root): no NUL bytes", "ctx: no NUL bytes"]],
    ['{"exp":3000000000,"nbf":3000000001}', [
      "nbf: is after exp, so the token is never valid",
    ]],
    ['{"cmds":"ls"}', ["cmds: must be an array of command names"]],
  ];
  for (const [text, expected] of cases) {
    const result = checkPermissionsText(text);
    const found = result.ok
      ? []
      : messages(result.issues).map((line) =>
        line.replace(/ at offset \d+$/, "")
      );
    for (const message of expected) {
      assert(
        found.includes(message),
        `${text}: expected ${message} in ${JSON.stringify(found)}`,
      );
    }
    if (expected.length === 0) {
      assert(result.ok, `${text}: ${JSON.stringify(found)}`);
    }
  }
  assert(!checkPermissionsText("{not json").ok, "malformed JSON");
});

Deno.test("cmds entries must name commands, spaced singly, without repeats", () => {
  const found = messages(permissionsIssues({
    cmds: ["ls", "ssh-key  list", "ssh my-vm", "frobnicate", "ls", 7, "Ls"],
  }));
  assertEquals(found, [
    'cmds.1: must be command words separated by single spaces, such as "ssh-key list"',
    "cmds.3: names no known command; known ones are " +
    found[1].split("known ones are ")[1],
    "cmds.4: repeats an earlier entry",
    "cmds.5: must be a string, got a number",
    'cmds.6: must be command words separated by single spaces, such as "ssh-key list"',
  ]);
  assertEquals(
    permissionsIssues({ cmds: ["frobnicate"] }, { knownCommandsOnly: false }),
    [],
  );
});

Deno.test("cmdsAllow: exact paths, no parent grants, ssh per VM, defaults", () => {
  assert(cmdsAllow(["ssh-key list"], "ssh-key list"), "exact");
  assert(
    !cmdsAllow(["ssh-key"], "ssh-key list"),
    "a parent grants no subcommand",
  );
  assert(
    !cmdsAllow(["ssh-key list"], "ssh-key"),
    "a subcommand grants no parent",
  );
  assert(cmdsAllow(["ssh"], "ssh", "any-vm"), "ssh allows every VM");
  assert(cmdsAllow(["ssh web-0"], "ssh", "web-0"), "ssh <vm> allows that VM");
  assert(!cmdsAllow(["ssh web-0"], "ssh", "web-1"), "and no other");
  assert(!cmdsAllow(["ssh web-0"], "ssh"), "nor an unknown one");
  assert(cmdsAllow(undefined, "exe0-to-exe1"), "defaults include exe0-to-exe1");
  assert(!cmdsAllow(undefined, "rm"), "defaults exclude rm");
  assertEquals(DEFAULT_CMDS.length, 9);
});

Deno.test("permissions() builds relative expiry and checks the result", async () => {
  const built = permissions({
    expiresInSeconds: 3600,
    cmds: ["ls"],
    now: 1_800_000_000_000,
  });
  assertEquals(built, { exp: 1_800_003_600, cmds: ["ls"] });
  // The docs' own example value; it falls on 2030-12-08 UTC.
  assertEquals(
    permissions({
      expiresAt: Temporal.Instant.fromEpochMilliseconds(1922918400_999),
    }),
    {
      exp: 1922918400,
    },
  );
  assertEquals(
    permissions({
      expiresAt: 1922918400,
      notBefore: Temporal.Instant.from("2030-03-17T17:46:40Z"),
    }),
    {
      exp: 1922918400,
      nbf: 1900000000,
    },
  );
  await throwsToken(() => permissions({ expiresAt: 1, expiresInSeconds: 1 }));
  await throwsToken(() => permissions({ expiresInSeconds: -2_000_000_000 }));
  await throwsToken(() => encodePermissions({ exp: 1.5 }));
});

Deno.test("minting refuses bad permissions, bad text and oversize tokens", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  await throwsToken(mintExe0({ signer, permissions: { exp: 10 } }));
  await throwsToken(mintExe0({ signer, permissions: '{"exp": 2000000000} ' }));
  await throwsToken(
    mintExe0({ signer, vm: "a", namespace: "b", permissions: {} }),
  );
  const huge = await throwsToken(
    mintExe0({ signer, permissions: { ctx: "x".repeat(8000) } }),
  );
  assert(huge.message.includes("at most 8192"), huge.message);
});

Deno.test("private keys: encrypted, non-ed25519 and corrupt keys are refused", () => {
  const refuse = (text: string) => {
    try {
      parseOpenSshPrivateKey(text);
    } catch (error) {
      assert(error instanceof SshFormatError, String(error));
      return error.message;
    }
    throw new Error("expected a refusal");
  };
  assert(refuse("hello").includes("not an OpenSSH private key"), "armor");
  const bytes = base64UrlDecode(
    fixture.PRIVATE_KEY.split("\n").slice(1, -2).join("").replace(/\+/g, "-")
      .replace(/\//g, "_").replace(/=+$/, ""),
  );
  const encrypted = bytes.slice();
  // Rewrite the cipher name "none" at its known offset to "aesX".
  const at = new TextDecoder().decode(bytes).indexOf("none");
  encrypted.set(new TextEncoder().encode("aesX"), at);
  const armored = (data: Uint8Array) =>
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${
      btoa(String.fromCharCode(...data))
    }\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert(refuse(armored(encrypted)).includes("encrypted"), "encrypted");
  const truncated = bytes.slice(0, 60);
  assert(refuse(armored(truncated)).length > 0, "truncated");
});

Deno.test("a signature over other bytes does not verify", async () => {
  const signature = parseSshsig(dearmorSshsig(fixture.SIGNATURE));
  assert(
    await sshsigVerify(
      signature,
      new TextEncoder().encode(fixture.PERMISSIONS),
    ),
    "the original verifies",
  );
  assert(
    !await sshsigVerify(
      signature,
      new TextEncoder().encode(fixture.PERMISSIONS + " "),
    ),
    "a changed payload does not",
  );
});

Deno.test("mintingTokenSource reuses a token until shortly before expiry", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const runtime = virtualRuntime({ start: 1_800_000_000_000 });
  const source = mintingTokenSource({
    signer,
    cmds: ["ls"],
    ttlSeconds: 600,
    refreshBeforeSeconds: 60,
    runtime,
  });
  const [a, b] = await Promise.all([source.token(), source.token()]);
  assertEquals(a, b);
  const parsed = parseToken(a);
  assert(parsed.kind === "exe0", "exe0");
  assertEquals(parsed.permissions, { exp: 1_800_000_600, cmds: ["ls"] });
  runtime.advance(530_000);
  assertEquals(await source.token(), a);
  runtime.advance(20_000);
  const c = await source.token();
  assert(c !== a, "refreshed inside the last minute");
  assertEquals(
    (parseToken(c) as { permissions: { exp: number } }).permissions.exp,
    1_800_001_150,
  );
});

Deno.test("mintingTokenSource refuses nonsense lifetimes", () => {
  const signer = {
    publicKey: parsePublicKeyLine(fixture.PUBLIC_KEY),
    sign: () => Promise.resolve(new Uint8Array(64)),
  };
  for (
    const options of [{ ttlSeconds: 0 }, {
      ttlSeconds: 60,
      refreshBeforeSeconds: 60,
    }]
  ) {
    try {
      mintingTokenSource({ signer, ...options });
      throw new Error("accepted");
    } catch (error) {
      assert(error instanceof RangeError, String(error));
    }
  }
});

Deno.test("a pluggable signer may return a bare Ed25519 signature", async () => {
  const real = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  let calls = 0;
  const token = await mintExe0({
    permissions: fixture.PERMISSIONS,
    signer: {
      publicKey: real.publicKey,
      sign: (data) => {
        calls++;
        return real.sign(data);
      },
    },
  });
  assertEquals(calls, 1);
  assertEquals(token, fixture.TOKEN);
});

Deno.test("ctx must be plain JSON, and base64url must be canonical", async () => {
  const error = await throwsToken(() =>
    permissions({
      ctx: { n: Number.NaN, when: new Date(0), list: [1, undefined] },
    } as never)
  );
  assertEquals(messages(error.issues), [
    "ctx.n: NaN is not a JSON number",
    "ctx.when: a Date is not a plain JSON object",
    "ctx.list.1: undefined is not JSON; omit the key or use null",
  ]);
  assertEquals([...base64UrlDecode("AAE")], [0, 1]);
  for (const bad of ["AAE=", "AAF", "A+E", "A"]) {
    try {
      base64UrlDecode(bad);
      throw new Error(`accepted ${bad}`);
    } catch (caught) {
      assert(caught instanceof SshFormatError, String(caught));
    }
  }
});
