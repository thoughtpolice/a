// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * An OpenID Federation in one Worker: a trust anchor at `/ta` with two
 * subordinate relying parties, `/leaf` and `/rogue`, and a resolver that
 * trusts the anchor.
 *
 * - `GET /{ta,leaf,rogue}/.well-known/openid-federation`: each entity's
 *   configuration, an `application/entity-statement+jwt`.
 * - `GET /ta/federation_fetch?sub=`, `/ta/federation_list`,
 *   `/ta/federation_resolve?sub=&trust_anchor=`: the anchor's endpoints
 *   (a fetch for an entity it does not know is a 404 `not_found`).
 * - `GET /resolve?entity=leaf`: the trust chain from `/leaf` to the
 *   anchor, as JSON: the chain's length and expiry, the metadata after the
 *   anchor's policy, and which trust marks validated. A chain that does
 *   not resolve is a 422 with the `FederationError` code only (`chain`,
 *   `fetch`, ...); its message goes to the log.
 *
 * The anchor's statement about each leaf carries a metadata policy: an
 * RP must use `private_key_jwt` (`one_of`, `essential`), gets the
 * federation's contact added (`add`), may only use the code and refresh
 * grants (`subset_of`, with a `default`), and must use DPoP-bound tokens
 * (`value`). `/leaf` complies (its `client_credentials` grant is cut);
 * `/rogue` asks for `client_secret_basic`, so its chain is invalid. The
 * anchor issues `/leaf` a trust mark; `/leaf` also carries one it signed
 * itself, which the anchor does not accept.
 *
 * Entity identifiers are `FEDERATION_ORIGIN` plus a path; a deployment
 * sets it. Without it (development only) the origin is the request's, and
 * only when its host is a loopback IP literal, so the example works on any
 * port but a `Host` header cannot name new entities. The resolver reaches
 * the entities in process: a Worker does not call itself over the network.
 * Under `celld dev` the entities are http://127.0.0.1 URLs, which the
 * resolver's egress policy allows only with
 * `FEDERATION_LOOPBACK_FOR_DEVELOPMENT="true"` (the spec's `vars` set it).
 * Keys are made per isolate.
 *
 * ```sh
 * buck2 run root//src/celld/sec/oidc/examples:federation-dev
 * curl -sS 'localhost:9876/resolve?entity=leaf'
 * ```
 *
 * @module
 */

import { generateSigningKey, type SigningKey } from "@celld/sec/oauth/server";
import {
  FederationEntity,
  FederationError,
  federationJwks,
  type MetadataPolicy,
  TrustChainResolver,
} from "@celld/sec/oidc/federation";
import { router } from "@celld/web/router";

const MARK = "https://federation.example/marks/certified";
const SELF_MARK = "https://federation.example/marks/self-asserted";

const POLICY: MetadataPolicy = {
  openid_relying_party: {
    token_endpoint_auth_method: {
      one_of: ["private_key_jwt"],
      essential: true,
    },
    contacts: { add: ["ops@federation.example"] },
    grant_types: {
      default: ["authorization_code"],
      subset_of: ["authorization_code", "refresh_token"],
    },
    dpop_bound_access_tokens: { value: true },
  },
};

interface Env {
  /** The federation's origin, such as `https://federation.example`; a deployment sets it. */
  readonly FEDERATION_ORIGIN?: string;
  /** `"true"` only for entities on http://127.0.0.1 during development. */
  readonly FEDERATION_LOOPBACK_FOR_DEVELOPMENT?: string;
}

interface Federation {
  readonly origin: string;
  readonly anchor: FederationEntity;
  readonly entities: readonly FederationEntity[];
  readonly resolver: TrustChainResolver;
}

let keys: Promise<SigningKey[]> | null = null;
/** The one federation, for the one origin; never one per `Host`. */
let current:
  | { readonly origin: string; readonly federation: Promise<Federation> }
  | null = null;

async function build(origin: string, env: Env): Promise<Federation> {
  keys ??= Promise.all(
    ["ta", "leaf", "rogue"].map((name) => generateSigningKey("ES256", name)),
  );
  const [taKey, leafKey, rogueKey] = await keys;
  const [ta, leafId, rogueId] = ["ta", "leaf", "rogue"].map((name) =>
    `${origin}/${name}`
  );
  const resolver = new TrustChainResolver({
    trustAnchors: [{ entityId: ta, jwks: federationJwks([taKey]) }],
    fetch: (input, init) => local(new Request(input, init)),
    // Under `celld dev` the entities are http://127.0.0.1 URLs, which the
    // egress policy allows only as the development override; a deployed
    // Worker's https origin never needs it.
    allowLoopbackForDevelopment:
      env.FEDERATION_LOOPBACK_FOR_DEVELOPMENT === "true",
  });
  const anchor = new FederationEntity({
    entityId: ta,
    keys: [taKey],
    metadata: {
      federation_entity: { organization_name: "Example Federation" },
    },
    trustMarkIssuers: { [MARK]: [ta] },
    subordinates: {
      [leafId]: {
        jwks: federationJwks([leafKey]),
        metadataPolicy: POLICY,
        constraints: { max_path_length: 0 },
        entityTypes: ["openid_relying_party"],
      },
      [rogueId]: {
        jwks: federationJwks([rogueKey]),
        metadataPolicy: POLICY,
        entityTypes: ["openid_relying_party"],
      },
    },
    resolver,
  });
  const leaf: FederationEntity = new FederationEntity({
    entityId: leafId,
    keys: [leafKey],
    authorityHints: [ta],
    metadata: {
      openid_relying_party: {
        client_name: "Leaf",
        redirect_uris: [`${leafId}/callback`],
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: [
          "authorization_code",
          "refresh_token",
          "client_credentials",
        ],
        contacts: ["dev@leaf.example"],
      },
    },
    trustMarks: async () => [
      {
        trust_mark_type: MARK,
        trust_mark: await anchor.issueTrustMark(leafId, MARK, { ttlSec: 3600 }),
      },
      {
        trust_mark_type: SELF_MARK,
        trust_mark: await leaf.issueTrustMark(leafId, SELF_MARK),
      },
    ],
  });
  const rogue = new FederationEntity({
    entityId: rogueId,
    keys: [rogueKey],
    authorityHints: [ta],
    metadata: {
      openid_relying_party: {
        redirect_uris: [`${rogueId}/callback`],
        token_endpoint_auth_method: "client_secret_basic",
      },
    },
  });
  const entities = [anchor, leaf, rogue];
  const local = async (request: Request): Promise<Response> => {
    for (const entity of entities) {
      const answer = await entity.handle(request);
      if (answer !== null) return answer;
    }
    return new Response("not found", { status: 404 });
  };
  return { origin, anchor, entities, resolver };
}

function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The federation's origin: `FEDERATION_ORIGIN` when set. Otherwise, for
 * development, the request's origin when its host is a loopback IP
 * literal, and null for any other host (which is refused).
 */
function originOf(url: URL, env: Env): string | null {
  if (
    env.FEDERATION_ORIGIN !== undefined && env.FEDERATION_ORIGIN !== ""
  ) {
    const origin = new URL(env.FEDERATION_ORIGIN).origin;
    return url.origin === origin ? origin : null;
  }
  return isLoopbackLiteral(url.hostname) ? url.origin : null;
}

function federation(url: URL, env: Env): Promise<Federation> {
  const origin = originOf(url, env);
  // The fetch handler refuses such a request before it gets here.
  if (origin === null) throw new Error("not this federation's host");
  if (current === null || current.origin !== origin) {
    current = { origin, federation: build(origin, env) };
  }
  return current.federation;
}

// Deliberately unauthenticated: `/resolve` lets anyone resolve the trust
// chain of one of this Worker's own entities (a lower-case name, checked
// below) and see its public metadata after policy and which trust marks
// validated, all of which the entities publish anyway. It reaches nothing
// outside this Worker.
const app = router<Env>({ auth: "none" });

app.get("/resolve", async (c) => {
  const { origin, resolver } = await federation(c.url, c.env);
  const entity = c.url.searchParams.get("entity") ?? "";
  if (!/^[a-z]+$/.test(entity)) return c.fail(400, "entity is a name");
  try {
    const chain = await resolver.resolve(`${origin}/${entity}`);
    return c.json({
      subject: chain.subject,
      trustAnchor: chain.trustAnchor,
      statements: chain.statements.length,
      expiresIn: chain.expiresAt - Math.floor(Date.now() / 1000),
      metadata: chain.metadata,
      trustMarks: chain.trustMarks.map((mark) => mark.trustMarkType),
      rejectedTrustMarks: chain.rejectedTrustMarks.map((mark) =>
        mark.trustMarkType
      ),
    });
  } catch (error) {
    if (!(error instanceof FederationError)) throw error;
    // The code only: the message can quote fetched URLs, network errors and
    // other parties' metadata, so it goes to the log.
    console.warn(`resolve ${entity}: ${error.code}: ${error.message}`);
    return c.json({ error: error.code }, { status: 422 });
  }
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (originOf(url, env) === null) {
      return new Response("not this federation's host", { status: 421 });
    }
    const { entities } = await federation(url, env);
    for (const entity of entities) {
      const answer = await entity.handle(request);
      if (answer !== null) return answer;
    }
    return await app.fetch(request, env, ctx);
  },
};
