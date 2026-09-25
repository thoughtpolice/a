// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { decode } from "@celld/jwt";
import {
  FederationEntity,
  FederationError,
  federationJwks,
  issueTrustMark,
  issueTrustMarkDelegation,
  MEDIA_TYPES,
  signStatement,
  TrustChainResolver,
  type TrustChainResolverOptions,
  verifyStatement,
} from "@celld/oidc/federation";
import { memoryRecordStore } from "@celld/oauth/server";
import { routeFetch } from "@celld/oauth/testing";
import { clock, rejects, seconds } from "./fixture.ts";
import {
  federationKey,
  handlers,
  node,
  rebuild,
} from "./federation_fixture.ts";

const TA = "https://ta.test";
const INTER = "https://inter.test";
const RP = "https://rp.test";
const OP = "https://op.test";
const MARKS = "https://marks.test";

const RP_METADATA = {
  openid_relying_party: {
    redirect_uris: ["https://rp.test/callback"],
    token_endpoint_auth_method: "private_key_jwt",
    contacts: ["ops@rp.test"],
  },
  openid_provider: { issuer: "https://rp.test" },
};

/**
 * TA -> INTER -> RP, TA -> OP, and MARKS (a trust mark issuer) under TA.
 * The TA's policy: RPs use private_key_jwt and get a federation contact;
 * OPs' DPoP algorithms are limited to ES256.
 */
async function world(changes: {
  readonly inter?: Parameters<typeof rebuild>[1];
  readonly ta?: Parameters<typeof rebuild>[1];
} = {}) {
  const time = clock();
  const ta = await node(TA, { now: time.now });
  const inter = await node(INTER, { now: time.now });
  const rp = await node(RP, { now: time.now });
  const op = await node(OP, { now: time.now });
  const marks = await node(MARKS, { now: time.now });
  rebuild(ta, {
    now: time.now,
    metadata: { federation_entity: { organization_name: "Test Federation" } },
    trustMarkIssuers: { "https://ta.test/marks/certified": [MARKS] },
    subordinates: {
      [INTER]: {
        jwks: inter.jwks,
        metadataPolicy: {
          openid_relying_party: {
            token_endpoint_auth_method: {
              one_of: ["private_key_jwt"],
              essential: true,
            },
            contacts: { add: ["help@ta.test"] },
          },
        },
        intermediate: true,
      },
      [OP]: {
        jwks: op.jwks,
        metadataPolicy: {
          openid_provider: {
            dpop_signing_alg_values_supported: { subset_of: ["ES256"] },
          },
        },
        entityTypes: ["openid_provider"],
      },
      [MARKS]: { jwks: marks.jwks },
    },
    ...changes.ta,
  });
  rebuild(inter, {
    now: time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: { jwks: rp.jwks, entityTypes: ["openid_relying_party"] },
    },
    ...changes.inter,
  });
  rebuild(rp, {
    now: time.now,
    authorityHints: [INTER],
    metadata: RP_METADATA,
  });
  rebuild(op, {
    now: time.now,
    authorityHints: [TA],
    metadata: {
      openid_provider: {
        issuer: OP,
        dpop_signing_alg_values_supported: ["ES256", "RS256", "PS256"],
      },
    },
  });
  rebuild(marks, { now: time.now, authorityHints: [TA] });
  const nodes = [ta, inter, rp, op, marks];
  const fetch = routeFetch(handlers(nodes));
  const resolver = (options: Partial<TrustChainResolverOptions> = {}) =>
    new TrustChainResolver({
      trustAnchors: [{ entityId: TA, jwks: ta.jwks }],
      fetch,
      now: time.now,
      ...options,
    });
  return { time, ta, inter, rp, op, marks, fetch, resolver };
}

Deno.test("anchor -> intermediate -> leaf: the chain, its policies and its expiry", async () => {
  const w = await world();
  const chain = await w.resolver().resolve(RP);
  assertEquals(chain.subject, RP);
  assertEquals(chain.trustAnchor, TA);
  assertEquals(chain.statements.length, 4);
  assertEquals(
    chain.claims.map((statement) => [statement.iss, statement.sub]),
    [
      [RP, RP],
      [INTER, RP],
      [TA, INTER],
      [TA, TA],
    ],
  );
  assertEquals(chain.metadata.openid_relying_party.contacts, [
    "ops@rp.test",
    "help@ta.test",
  ]);
  assertEquals(chain.expiresAt, seconds(w.time.now) + 86400);
  assertEquals(chain.jwks, w.rp.jwks);
  for (const statement of chain.statements) {
    assertEquals(decode(statement).header.typ, MEDIA_TYPES.entityStatement);
  }
});

Deno.test("a leaf under the anchor, with the anchor's policy applied", async () => {
  const w = await world();
  const chain = await w.resolver().resolve(OP);
  assertEquals(chain.statements.length, 3);
  assertEquals(
    chain.metadata.openid_provider.dpop_signing_alg_values_supported,
    ["ES256"],
  );
  const anchor = await w.resolver().resolve(TA);
  assertEquals(anchor.statements.length, 1);
});

Deno.test("the entity endpoints: content types, fetch errors, list filters", async () => {
  const w = await world();
  const configuration = await w.fetch(`${TA}/.well-known/openid-federation`);
  assertEquals(
    configuration.headers.get("content-type"),
    "application/entity-statement+jwt",
  );
  const claims = await verifyStatement(await configuration.text(), w.ta.jwks, {
    now: w.time.now,
  });
  assertEquals(
    (claims.metadata!.federation_entity as Record<string, unknown>)
      .federation_fetch_endpoint,
    `${TA}/federation_fetch`,
  );
  const missing = await w.fetch(
    `${TA}/federation_fetch?sub=https://nobody.test`,
  );
  assertEquals(missing.status, 404);
  assertEquals((await missing.json()).error, "not_found");
  const self = await w.fetch(`${TA}/federation_fetch?sub=${TA}`);
  assertEquals(self.status, 400);
  const noSub = await w.fetch(`${TA}/federation_fetch`);
  assertEquals(noSub.status, 400);
  assertEquals(await (await w.fetch(`${TA}/federation_list`)).json(), [
    INTER,
    OP,
    MARKS,
  ]);
  assertEquals(
    await (await w.fetch(`${TA}/federation_list?entity_type=openid_provider`))
      .json(),
    [OP],
  );
  assertEquals(
    await (await w.fetch(`${TA}/federation_list?intermediate=true`)).json(),
    [INTER],
  );
  assertEquals((await w.fetch(`${RP}/federation_fetch?sub=x`)).status, 404);
});

Deno.test("expiry: a chain validated after its statements expire is refused", async () => {
  const w = await world({ inter: { now: undefined, ttlSec: 120 } });
  rebuild(w.inter, {
    now: w.time.now,
    ttlSec: 120,
    authorityHints: [TA],
    subordinates: { [RP]: { jwks: w.rp.jwks } },
  });
  const resolver = w.resolver();
  const chain = await resolver.resolve(RP);
  assertEquals(chain.expiresAt, seconds(w.time.now) + 120);
  w.time.advance(200_000);
  await rejects(() => resolver.validate(chain.statements), { code: "expired" });
  const again = await resolver.resolve(RP);
  assertEquals(again.expiresAt, seconds(w.time.now) + 120, "refetched fresh");
});

Deno.test("a subordinate statement vouching for other keys breaks the chain", async () => {
  const w = await world();
  const impostor = await federationKey(RP);
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: { jwks: { keys: [{ ...impostor.publicJwk, kid: w.rp.key.kid }] } },
    },
  });
  const error = await rejects(() => w.resolver().resolve(RP), {
    code: "chain",
  });
  assert(error.message.includes("signature"), error.message);
});

Deno.test("an anchor whose configuration is not signed by the configured keys is not trusted", async () => {
  const w = await world();
  const other = await federationKey(TA);
  const resolver = new TrustChainResolver({
    trustAnchors: [{
      entityId: TA,
      jwks: { keys: [{ ...other.publicJwk, kid: w.ta.key.kid }] },
    }],
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(() => resolver.resolve(RP), { code: "chain" });
  const stranger = new TrustChainResolver({
    trustAnchors: [{ entityId: "https://other-ta.test", jwks: w.ta.jwks }],
    fetch: w.fetch,
    now: w.time.now,
  });
  await rejects(() => stranger.resolve(RP), { code: "chain" });
});

Deno.test("loops in authority_hints end, and a second path is used", async () => {
  const w = await world();
  const loop = await node("https://loop.test", { now: w.time.now });
  rebuild(loop, {
    now: w.time.now,
    authorityHints: [INTER],
    subordinates: { [INTER]: { jwks: w.inter.jwks } },
  });
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: ["https://loop.test", TA],
    subordinates: {
      [RP]: { jwks: w.rp.jwks },
      "https://loop.test": { jwks: loop.jwks },
    },
  });
  const fetch = routeFetch(handlers([w.ta, w.inter, w.rp, w.op, loop]));
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: w.ta.jwks }],
    fetch,
    now: w.time.now,
  });
  const chain = await resolver.resolve(RP);
  assertEquals(chain.statements.length, 4);
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: ["https://loop.test"],
    subordinates: {
      [RP]: { jwks: w.rp.jwks },
      "https://loop.test": { jwks: loop.jwks },
    },
  });
  const fresh = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: w.ta.jwks }],
    fetch,
    now: w.time.now,
  });
  const error = await rejects(() => fresh.resolve(RP), { code: "chain" });
  assert(error.message.includes("loop"), error.message);
});

Deno.test("path length: the resolver's limit and max_path_length constraints", async () => {
  const w = await world();
  await rejects(() => w.resolver({ maxPathLength: 0 }).resolve(RP), {
    code: "chain",
  });
  const constrained = await world({
    ta: {
      subordinates: {},
    },
  });
  rebuild(constrained.ta, {
    now: constrained.time.now,
    subordinates: {
      [INTER]: {
        jwks: constrained.inter.jwks,
        constraints: { max_path_length: 0 },
      },
    },
  });
  const error = await rejects(() => constrained.resolver().resolve(RP), {
    code: "chain",
  });
  assert(error.message.includes("intermediates"), error.message);
  rebuild(constrained.ta, {
    now: constrained.time.now,
    subordinates: {
      [INTER]: {
        jwks: constrained.inter.jwks,
        constraints: { max_path_length: 1 },
      },
    },
  });
  await constrained.resolver().resolve(RP);
});

Deno.test("naming constraints: permitted and excluded hosts", async () => {
  const w = await world();
  const constrain = (naming: Record<string, string[]>) =>
    rebuild(w.ta, {
      now: w.time.now,
      subordinates: {
        [INTER]: {
          jwks: w.inter.jwks,
          constraints: { naming_constraints: naming },
        },
      },
    });
  constrain({ permitted: [".test"] });
  await w.resolver().resolve(RP);
  constrain({ permitted: [".example.com"] });
  await rejects(() => w.resolver().resolve(RP), { code: "chain" });
  constrain({ permitted: [".test"], excluded: ["rp.test"] });
  await rejects(() => w.resolver().resolve(RP), { code: "chain" });
  constrain({ permitted: ["inter.test", "rp.test"] });
  await w.resolver().resolve(RP);
});

Deno.test("allowed entity types remove the others, before policies", async () => {
  const w = await world();
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: {
        jwks: w.rp.jwks,
        constraints: { allowed_entity_types: ["openid_relying_party"] },
      },
    },
  });
  const chain = await w.resolver().resolve(RP);
  assertEquals(Object.keys(chain.metadata).sort(), ["openid_relying_party"]);
});

Deno.test("the superior's metadata overrides the leaf's, then policies apply", async () => {
  const w = await world();
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: {
        jwks: w.rp.jwks,
        metadata: {
          openid_relying_party: { contacts: ["registry@inter.test"] },
          oauth_client: { ignored: true },
        },
      },
    },
  });
  const chain = await w.resolver().resolve(RP);
  assertEquals(chain.metadata.openid_relying_party.contacts, [
    "registry@inter.test",
    "help@ta.test",
  ]);
  assertEquals(chain.metadata.oauth_client, undefined);
});

Deno.test("policy conflicts between superiors invalidate the chain", async () => {
  const w = await world();
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: {
        jwks: w.rp.jwks,
        metadataPolicy: {
          openid_relying_party: {
            token_endpoint_auth_method: { one_of: ["client_secret_basic"] },
          },
        },
      },
    },
  });
  const error = await rejects(() => w.resolver().resolve(RP), {
    code: "chain",
  });
  assert(error.message.includes("nothing in common"), error.message);
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: {
        jwks: w.rp.jwks,
        metadataPolicy: {
          openid_relying_party: { contacts: { value: ["x@inter.test"] } },
        },
      },
    },
  });
  const combination = await rejects(() => w.resolver().resolve(RP), {
    code: "chain",
  });
  assert(combination.message.includes("add"), combination.message);
});

Deno.test("metadata that does not comply with the policy invalidates the chain", async () => {
  const w = await world();
  rebuild(w.rp, {
    now: w.time.now,
    authorityHints: [INTER],
    metadata: {
      openid_relying_party: {
        redirect_uris: ["https://rp.test/callback"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    },
  });
  const error = await rejects(() => w.resolver().resolve(RP), {
    code: "chain",
  });
  assert(error.message.includes("token_endpoint_auth_method"), error.message);
});

Deno.test("critical claims and operators that are not understood are refused", async () => {
  const w = await world();
  rebuild(w.inter, {
    now: w.time.now,
    authorityHints: [TA],
    subordinates: {
      [RP]: {
        jwks: w.rp.jwks,
        metadataPolicy: { openid_relying_party: { contacts: { regexp: "@" } } },
        metadataPolicyCrit: ["regexp"],
      },
    },
  });
  await rejects(() => w.resolver().resolve(RP), { code: "chain" });
  const iat = seconds(w.time.now);
  const statement = await signStatement({
    iss: RP,
    sub: RP,
    iat,
    exp: iat + 60,
    jwks: w.rp.jwks,
    crit: ["jti_of_doom"],
  }, w.rp.key);
  await rejects(
    () => verifyStatement(statement, w.rp.jwks, { now: w.time.now }),
    {
      code: "malformed",
    },
  );
  const wrongTyp = await signStatement(
    {
      iss: RP,
      sub: RP,
      iat,
      exp: iat + 60,
      jwks: w.rp.jwks,
    },
    w.rp.key,
    "JWT",
  );
  await rejects(
    () => verifyStatement(wrongTyp, w.rp.jwks, { now: w.time.now }),
    {
      code: "typ",
    },
  );
});

Deno.test("fetched statements are cached in a record store", async () => {
  const w = await world();
  const cache = memoryRecordStore({ now: w.time.now });
  await w.resolver({ cache }).resolve(RP);
  const first = w.fetch.requests.length;
  await w.resolver({ cache }).resolve(RP);
  assertEquals(
    w.fetch.requests.length,
    first,
    "the second resolution fetched nothing",
  );
});

Deno.test("a trust anchor's rotated keys make the resolver refetch past its cache", async () => {
  const w = await world();
  const cache = memoryRecordStore({ now: w.time.now });
  await w.resolver({ cache }).resolve(RP);
  const rotated = await federationKey(TA);
  w.ta.entity = new FederationEntity({
    entityId: TA,
    keys: [rotated],
    now: w.time.now,
    subordinates: { [INTER]: { jwks: w.inter.jwks } },
  });
  const before = w.fetch.requests.length;
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: TA, jwks: federationJwks([rotated]) }],
    fetch: w.fetch,
    now: w.time.now,
    cache,
  });
  const chain = await resolver.resolve(RP);
  assertEquals(chain.trustAnchor, TA);
  assert(
    w.fetch.requests.length > before,
    "the stale statements were refetched",
  );
});

Deno.test("trust marks: accepted issuers, expiry, subject and delegation", async () => {
  const w = await world();
  const type = "https://ta.test/marks/certified";
  const good = await w.marks.entity.issueTrustMark(RP, type, { ttlSec: 3600 });
  const expired = await w.marks.entity.issueTrustMark(RP, type, { ttlSec: 1 });
  const other = await w.marks.entity.issueTrustMark(OP, type);
  const unlisted = await w.inter.entity.issueTrustMark(RP, type);
  const byAnchor = await w.ta.entity.issueTrustMark(
    RP,
    "https://ta.test/marks/member",
  );
  w.time.advance(60_000);
  rebuild(w.rp, {
    now: w.time.now,
    authorityHints: [INTER],
    metadata: RP_METADATA,
    trustMarks: [
      { trust_mark_type: type, trust_mark: good },
      { trust_mark_type: type, trust_mark: expired },
      { trust_mark_type: type, trust_mark: other },
      { trust_mark_type: type, trust_mark: unlisted },
      { trust_mark_type: "https://ta.test/marks/member", trust_mark: byAnchor },
      { trust_mark_type: "https://ta.test/marks/other", trust_mark: good },
    ],
  });
  const chain = await w.resolver().resolve(RP);
  assertEquals(
    chain.trustMarks.map((mark) => [mark.trustMarkType, mark.issuer]),
    [
      [type, MARKS],
      ["https://ta.test/marks/member", TA],
    ],
  );
  assertEquals(chain.rejectedTrustMarks.length, 4);
});

Deno.test("trust marks with an owner need the owner's delegation", async () => {
  const w = await world();
  const type = "https://owner.test/marks/audited";
  const ownerKey = await federationKey("https://owner.test");
  const ownerJwks = { keys: [{ ...ownerKey.publicJwk, kid: ownerKey.kid }] };
  rebuild(w.ta, {
    now: w.time.now,
    trustMarkIssuers: { [type]: [] },
    trustMarkOwners: { [type]: { sub: "https://owner.test", jwks: ownerJwks } },
    subordinates: {
      [INTER]: { jwks: w.inter.jwks },
      [MARKS]: { jwks: w.marks.jwks },
    },
  });
  const delegation = await issueTrustMarkDelegation(ownerKey, {
    owner: "https://owner.test",
    issuer: MARKS,
    trustMarkType: type,
    now: w.time.now,
  });
  const delegated = await w.marks.entity.issueTrustMark(RP, type, {
    delegation,
  });
  const bare = await w.marks.entity.issueTrustMark(RP, type);
  const wrongIssuer = await issueTrustMark(w.inter.key, {
    issuer: INTER,
    subject: RP,
    trustMarkType: type,
    delegation,
    now: w.time.now,
  });
  rebuild(w.rp, {
    now: w.time.now,
    authorityHints: [INTER],
    metadata: RP_METADATA,
    trustMarks: [delegated, bare, wrongIssuer].map((mark) => ({
      trust_mark_type: type,
      trust_mark: mark,
    })),
  });
  const chain = await w.resolver().resolve(RP);
  assertEquals(chain.trustMarks.length, 1);
  assertEquals(chain.trustMarks[0].trustMark, delegated);
  assert(
    chain.rejectedTrustMarks.some((mark) => mark.reason.includes("delegation")),
    JSON.stringify(chain.rejectedTrustMarks),
  );
});

Deno.test("the resolve endpoint answers a signed resolution", async () => {
  const w = await world();
  const resolver = w.resolver();
  rebuild(w.ta, {
    now: w.time.now,
    resolver,
    subordinates: {
      [INTER]: { jwks: w.inter.jwks },
      [OP]: { jwks: w.op.jwks },
    },
  });
  const response = await w.fetch(
    `${TA}/federation_resolve?sub=${encodeURIComponent(RP)}&trust_anchor=${
      encodeURIComponent(TA)
    }&entity_type=openid_relying_party`,
  );
  assertEquals(
    response.headers.get("content-type"),
    "application/resolve-response+jwt",
  );
  const claims = await verifyStatement(await response.text(), w.ta.jwks, {
    now: w.time.now,
    typ: MEDIA_TYPES.resolveResponse,
    requireJwks: false,
  });
  assertEquals(Object.keys(claims.metadata!), ["openid_relying_party"]);
  assertEquals((claims.trust_chain as string[]).length, 4);
  const unknown = await w.fetch(
    `${TA}/federation_resolve?sub=https://nobody.test&trust_anchor=${TA}`,
  );
  assertEquals(unknown.status, 404);
  assertEquals((await unknown.json()).error, "invalid_trust_chain");
});

Deno.test("statement claims: shape errors are malformed", async () => {
  const w = await world();
  const iat = seconds(w.time.now);
  const cases: Record<string, unknown>[] = [
    { authority_hints: [] },
    { metadata: { openid_relying_party: { a: null } } },
    { metadata_policy: {} },
    { iss: "not a url" },
  ];
  for (const change of cases) {
    const jwt = await signStatement({
      iss: RP,
      sub: RP,
      iat,
      exp: iat + 60,
      jwks: w.rp.jwks,
      ...change,
    }, w.rp.key);
    await rejects(() => verifyStatement(jwt, w.rp.jwks, { now: w.time.now }), {
      code: "malformed",
    }).catch((error) => {
      throw new Error(`${JSON.stringify(change)}: ${error.message}`);
    });
  }
  assert(new FederationError("chain", "x") instanceof Error, "an Error");
});
