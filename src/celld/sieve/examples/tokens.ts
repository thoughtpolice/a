// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Personal access tokens: sieve checks the shapes, `@celld/jwt` the
 * signatures.
 *
 * `POST /tokens` parses the request with `TokenRequest`: an owner email,
 * a name, one to three distinct scopes, and a lifetime `ttl` as an ISO 8601
 * duration, which `v.iso.duration().toDuration()` checks strictly and
 * turns into a `Temporal.Duration` (default `P7D`). It is refined to a
 * fixed length of at most 90 days (`P1M` has no fixed length, so it is
 * refused). The token is an HS256 JWT signed with `TOKEN_SECRET`.
 *
 * Requests with a token go through three steps, each with its own answer:
 *
 * 1. `Authorization` is parsed by a schema that strips `Bearer ` and pipes
 *    the rest into `v.jwt({ alg: "HS256" })`, a structural check: a header
 *    that is not a bearer JWT at all is a 400 with the issues, before any
 *    cryptography;
 * 2. `verify` checks the signature and expiry (401 with the code);
 * 3. the verified claims are parsed with `Claims`, which turns the space-
 *    separated `scope` into a list of known scopes, so handlers get typed
 *    claims rather than `unknown`.
 *
 * - `GET /whoami` returns the token's owner, name and scopes.
 * - `POST /notes` needs the `write` scope (else 403).
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:tokens-dev
 * curl -sS -X POST localhost:9876/tokens \
 *   -d '{"owner": "ada@example.com", "name": "ci", "scopes": ["read"], "ttl": "PT1H"}'
 * ```
 *
 * @module
 */

import { fromBase64Url, JwtError, sign, verify } from "@celld/jwt";
import { type Infer, v } from "@celld/sieve";
import { ulid } from "@celld/ulid";

interface Env {
  readonly TOKEN_SECRET: string;
}

const MAX_TTL_SECONDS = 90 * 86_400;

const Scope = v.enum(["read", "write", "admin"]);

/**
 * A duration's length in seconds, or null when it has none: years and
 * months vary, while weeks are seven days and days 24 hours.
 */
function fixedSeconds(duration: Temporal.Duration): number | null {
  return duration.years || duration.months ? null : duration.total({
    unit: "seconds",
    relativeTo: Temporal.Now.plainDateISO(),
  });
}

const TokenRequest = v.strictObject({
  owner: v.email().toLowerCase(),
  name: v.string().trim().min(1).max(50),
  scopes: v.array(Scope).min(1).max(3).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "scopes must not repeat",
  ),
  ttl: v.iso.duration().toDuration().refine((ttl) => {
    const seconds = fixedSeconds(ttl);
    return seconds !== null && seconds >= 1 && seconds <= MAX_TTL_SECONDS;
  }, "must be a fixed length from 1 second to 90 days (P90D)")
    .default(Temporal.Duration.from({ days: 7 })),
});

const Bearer = v.string("missing Authorization")
  .startsWith("Bearer ", "expected Bearer <token>")
  .transform((header) => header.slice("Bearer ".length))
  .pipe(v.jwt({ alg: "HS256", message: "not an HS256 JWT" }));

const Claims = v.object({
  sub: v.email(),
  name: v.string(),
  scope: v.string().transform((scope) => scope.split(" ")).pipe(v.array(Scope)),
  jti: v.ulid(),
  exp: v.int(),
});

type Claims = Infer<typeof Claims>;

function secret(env: Env): Uint8Array {
  const bytes = fromBase64Url(env.TOKEN_SECRET);
  if (bytes === null) throw new Error("TOKEN_SECRET is not base64url");
  return bytes;
}

async function issue(request: Request, env: Env): Promise<Response> {
  const parsed = TokenRequest.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return Response.json(parsed.error.flatten(), { status: 400 });
  }
  const { owner, name, scopes, ttl } = parsed.data;
  const now = Date.now();
  const expiresIn = Math.floor(fixedSeconds(ttl)!);
  const token = await sign(
    { sub: owner, name, scope: scopes.join(" "), jti: ulid(now) },
    secret(env),
    { alg: "HS256", expiresIn, now },
  );
  return Response.json({
    token,
    scopes,
    expires: Temporal.Instant.fromEpochMilliseconds(now)
      .add({ seconds: expiresIn })
      .toString({ smallestUnit: "second" }),
  }, { status: 201 });
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<Claims | Response> {
  const header = Bearer.safeParse(
    request.headers.get("authorization") ?? undefined,
  );
  if (!header.success) {
    return Response.json({ error: header.error.format() }, { status: 400 });
  }
  let payload: unknown;
  try {
    ({ payload } = await verify(header.data, secret(env), {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
    }));
  } catch (error) {
    if (error instanceof JwtError) {
      return Response.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
  // The signature proves who wrote the claims, not that they have the
  // shape this code expects.
  const claims = Claims.safeParse(payload);
  if (!claims.success) {
    return Response.json({
      error: "invalid_claims",
      issues: claims.error.format(),
    }, {
      status: 401,
    });
  }
  return claims.data;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "POST /tokens") return await issue(request, env);
    if (route !== "GET /whoami" && route !== "POST /notes") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const claims = await authenticate(request, env);
    if (claims instanceof Response) return claims;
    if (route === "GET /whoami") {
      return Response.json({
        owner: claims.sub,
        name: claims.name,
        scopes: claims.scope,
        expires: Temporal.Instant.fromEpochMilliseconds(claims.exp * 1000)
          .toString(),
      });
    }
    if (!claims.scope.includes("write")) {
      return Response.json({ error: "needs the write scope" }, { status: 403 });
    }
    return Response.json({ saved: await request.text() }, { status: 201 });
  },
};
