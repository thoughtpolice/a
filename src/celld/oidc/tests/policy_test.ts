// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  applyMetadataPolicy,
  checkParameterPolicy,
  FederationError,
  mergeParameterPolicy,
  type MetadataPolicy,
  resolveMetadataPolicy,
} from "@celld/oidc/federation";

function policyError(work: () => unknown, what: string): void {
  try {
    work();
  } catch (error) {
    assert(
      error instanceof FederationError && error.code === "policy",
      `${what}: expected a policy error, got ${error}`,
    );
    return;
  }
  throw new Error(`${what}: expected a policy error`);
}

// OpenID Federation 1.0 section 6.1.5, figures 10 to 14.
const TRUST_ANCHOR_POLICY: MetadataPolicy = {
  openid_relying_party: {
    grant_types: {
      default: ["authorization_code"],
      subset_of: ["authorization_code", "refresh_token"],
      superset_of: ["authorization_code"],
    },
    token_endpoint_auth_method: {
      one_of: ["private_key_jwt", "self_signed_tls_client_auth"],
      essential: true,
    },
    token_endpoint_auth_signing_alg: { one_of: ["PS256", "ES256"] },
    subject_type: { value: "pairwise" },
    contacts: { add: ["helpdesk@federation.example.org"] },
  },
};

const INTERMEDIATE_POLICY: MetadataPolicy = {
  openid_relying_party: {
    grant_types: { subset_of: ["authorization_code"] },
    token_endpoint_auth_method: { one_of: ["self_signed_tls_client_auth"] },
    contacts: { add: ["helpdesk@org.example.org"] },
  },
};

Deno.test("section 6.1.5: figure 12, the merged policy", () => {
  const merged = resolveMetadataPolicy([
    TRUST_ANCHOR_POLICY,
    INTERMEDIATE_POLICY,
  ]);
  assertEquals(merged.openid_relying_party, {
    grant_types: {
      default: ["authorization_code"],
      superset_of: ["authorization_code"],
      subset_of: ["authorization_code"],
    },
    token_endpoint_auth_method: {
      one_of: ["self_signed_tls_client_auth"],
      essential: true,
    },
    token_endpoint_auth_signing_alg: { one_of: ["PS256", "ES256"] },
    subject_type: { value: "pairwise" },
    contacts: {
      add: ["helpdesk@federation.example.org", "helpdesk@org.example.org"],
    },
  });
});

Deno.test("section 6.1.5: figure 14, the resolved metadata", () => {
  const merged = resolveMetadataPolicy([
    TRUST_ANCHOR_POLICY,
    INTERMEDIATE_POLICY,
  ]);
  const leaf = {
    openid_relying_party: {
      redirect_uris: ["https://rp.example.org/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "self_signed_tls_client_auth",
      contacts: ["rp_admins@rp.example.org"],
      // Figure 11's metadata from the intermediate, already applied.
      sector_identifier_uri: "https://org.example.org/sector-ids.json",
      policy_uri: "https://org.example.org/policy.html",
    },
  };
  assertEquals(applyMetadataPolicy(leaf, merged).openid_relying_party, {
    redirect_uris: ["https://rp.example.org/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "self_signed_tls_client_auth",
    subject_type: "pairwise",
    sector_identifier_uri: "https://org.example.org/sector-ids.json",
    policy_uri: "https://org.example.org/policy.html",
    contacts: [
      "rp_admins@rp.example.org",
      "helpdesk@federation.example.org",
      "helpdesk@org.example.org",
    ],
  });
});

Deno.test("section 6.1.3.1.8, table 1: essential with subset_of", () => {
  const rows: [boolean, unknown, unknown][] = [
    [true, ["a", "e"], ["a"]],
    [false, ["a", "e"], ["a"]],
    [true, ["d", "e"], []],
    [false, ["d", "e"], []],
    [true, undefined, "error"],
    [false, undefined, undefined],
  ];
  for (const [essential, input, output] of rows) {
    const metadata = { t: input === undefined ? {} : { p: input } };
    const policy = { t: { p: { essential, subset_of: ["a", "b", "c"] } } };
    if (output === "error") {
      policyError(() => applyMetadataPolicy(metadata, policy), "essential");
      continue;
    }
    assertEquals(applyMetadataPolicy(metadata, policy).t.p, output);
  }
});

Deno.test("each operator applied on its own", () => {
  const apply = (
    parameters: Record<string, unknown>,
    policy: Record<string, Record<string, unknown>>,
  ) => applyMetadataPolicy({ t: parameters }, { t: policy }).t;
  assertEquals(apply({ a: "x" }, { a: { value: "y" } }), { a: "y" });
  assertEquals(apply({}, { a: { value: ["y"] } }), { a: ["y"] });
  assertEquals(apply({ a: "x" }, { a: { value: null } }), {});
  assertEquals(apply({ a: ["x"] }, { a: { add: ["y", "x"] } }), {
    a: ["x", "y"],
  });
  assertEquals(apply({}, { a: { add: ["y"] } }), { a: ["y"] });
  assertEquals(apply({}, { a: { default: "d" } }), { a: "d" });
  assertEquals(apply({ a: "x" }, { a: { default: "d" } }), { a: "x" });
  assertEquals(apply({ a: "x" }, { a: { one_of: ["x", "y"] } }), { a: "x" });
  assertEquals(apply({}, { a: { one_of: ["x"] } }), {});
  assertEquals(apply({ a: ["x", "z"] }, { a: { subset_of: ["x", "y"] } }), {
    a: ["x"],
  });
  assertEquals(apply({ a: ["x", "y"] }, { a: { superset_of: ["x"] } }), {
    a: ["x", "y"],
  });
  assertEquals(apply({ a: { any: 1 } }, { a: { essential: true } }), {
    a: { any: 1 },
  });
  policyError(() => apply({ a: "z" }, { a: { one_of: ["x", "y"] } }), "one_of");
  policyError(
    () => apply({ a: ["y"] }, { a: { superset_of: ["x"] } }),
    "superset_of",
  );
  policyError(
    () => apply({ a: "x" }, { a: { add: ["y"] } }),
    "add to a string",
  );
  policyError(
    () => apply({ a: "x" }, { a: { subset_of: ["x"] } }),
    "subset_of a string",
  );
});

Deno.test("scope is a space-separated array to the operators", () => {
  const out = applyMetadataPolicy(
    { t: { scope: "openid email phone" } },
    { t: { scope: { subset_of: ["openid", "email", "profile"] } } },
  );
  assertEquals(out.t.scope, "openid email");
  const added = applyMetadataPolicy(
    { t: {} },
    { t: { scope: { default: "openid", add: ["profile"] } } },
  );
  assertEquals(added.t.scope, "profile");
});

Deno.test("combinations: allowed ones with their conditions, and the forbidden ones", () => {
  const ok: Record<string, unknown>[] = [
    { value: ["a"], add: ["a"] },
    { value: "a", default: "b" },
    { value: "a", one_of: ["a", "b"] },
    { value: ["a"], subset_of: ["a", "b"] },
    { value: ["a", "b"], superset_of: ["a"] },
    { value: null, essential: false },
    { add: ["a"], subset_of: ["a", "b"], superset_of: ["a"] },
    { one_of: ["a"], default: "a", essential: true },
    { subset_of: ["a", "b"], superset_of: ["a", "b"] },
  ];
  for (const policy of ok) checkParameterPolicy("p", policy);
  const bad: [string, Record<string, unknown>][] = [
    ["add outside value", { value: ["a"], add: ["b"] }],
    ["default with null value", { value: null, default: "a" }],
    ["value outside one_of", { value: "c", one_of: ["a"] }],
    ["value outside subset_of", { value: ["c"], subset_of: ["a"] }],
    ["value not a superset", { value: ["a"], superset_of: ["a", "b"] }],
    ["null value essential", { value: null, essential: true }],
    ["add outside subset_of", { add: ["c"], subset_of: ["a"] }],
    ["subset_of narrower than superset_of", {
      subset_of: ["a"],
      superset_of: ["a", "b"],
    }],
    ["one_of with add", { one_of: ["a"], add: ["a"] }],
    ["one_of with subset_of", { one_of: ["a"], subset_of: ["a"] }],
    ["one_of with superset_of", { one_of: ["a"], superset_of: ["a"] }],
    ["add not an array", { add: "a" }],
    ["essential not a boolean", { essential: "yes" }],
    ["default null", { default: null }],
  ];
  for (const [what, policy] of bad) {
    policyError(() => checkParameterPolicy("p", policy), what);
  }
});

Deno.test("merges: what each operator does with a subordinate's", () => {
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    mergeParameterPolicy(
      "p",
      checkParameterPolicy("p", a),
      checkParameterPolicy("p", b),
    );
  assertEquals(merge({ value: "a" }, { value: "a" }), { value: "a" });
  assertEquals(merge({ add: ["a"] }, { add: ["b", "a"] }), { add: ["a", "b"] });
  assertEquals(merge({ default: "a" }, { default: "a" }), { default: "a" });
  assertEquals(merge({ one_of: ["a", "b"] }, { one_of: ["b", "c"] }), {
    one_of: ["b"],
  });
  assertEquals(merge({ subset_of: ["a"] }, { subset_of: ["b"] }), {
    subset_of: [],
  });
  assertEquals(merge({ superset_of: ["a"] }, { superset_of: ["b"] }), {
    superset_of: ["a", "b"],
  });
  assertEquals(merge({ essential: true }, { essential: false }), {
    essential: true,
  });
  assertEquals(merge({ essential: false }, { essential: false }), {
    essential: false,
  });
  assertEquals(merge({ one_of: ["a"] }, { default: "a" }), {
    one_of: ["a"],
    default: "a",
  });
  policyError(() => merge({ value: "a" }, { value: "b" }), "different values");
  policyError(
    () => merge({ default: "a" }, { default: "b" }),
    "different defaults",
  );
  policyError(
    () => merge({ one_of: ["a"] }, { one_of: ["b"] }),
    "empty one_of",
  );
  policyError(
    () => merge({ subset_of: ["a", "b"] }, { superset_of: ["c"] }),
    "a merge that breaks a combination",
  );
  policyError(
    () => merge({ one_of: ["a"] }, { add: ["a"] }),
    "one_of then add",
  );
});

Deno.test("values compare as JSON: object key order does not matter", () => {
  const merged = mergeParameterPolicy(
    "p",
    checkParameterPolicy("p", { value: { a: 1, b: 2 } }),
    checkParameterPolicy("p", { value: { b: 2, a: 1 } }),
  );
  assertEquals(merged, { value: { a: 1, b: 2 } });
});

Deno.test("unknown operators: ignored, unless critical", () => {
  assertEquals(checkParameterPolicy("p", { regexp: "^a$", default: "a" }), {
    default: "a",
  });
  policyError(
    () => checkParameterPolicy("p", { regexp: "^a$" }, new Set(["regexp"])),
    "critical",
  );
  policyError(
    () =>
      resolveMetadataPolicy(
        [{ t: { p: { regexp: "^a$" } } }],
        new Set(["regexp"]),
      ),
    "critical in a chain",
  );
});

Deno.test("a policy for a type the entity lacks does nothing", () => {
  const out = applyMetadataPolicy(
    { openid_relying_party: { a: 1 } },
    { openid_provider: { a: { value: 2 } } },
  );
  assertEquals(out, { openid_relying_party: { a: 1 } });
});
