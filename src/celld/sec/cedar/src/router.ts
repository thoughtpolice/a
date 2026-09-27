// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Cedar decisions as "@celld/web/router" route authorization.
 *
 * ```ts
 * import { cedarAuthorize, decisionOf } from "@celld/sec/cedar/router";
 *
 * const canRead = cedarAuthorize({
 *   authorizer,
 *   principal: (p) => uid("User", p.key),
 *   action: "read",
 *   resource: (c) => uid("Doc", c.params.id),
 *   context: (_, c) => ({ mfa: c.principal?.claims.amr === "mfa" }),
 *   onDecision: (decision, c) => audit(c.requestId, decision),
 * });
 *
 * app.get("/docs/:id", { authorize: canRead }, (c) => {
 *   return c.json({ reasons: decisionOf(c)?.reasons });
 * });
 * ```
 *
 * The route answers 403 unless Cedar allows, including when the request
 * is invalid (a context the schema refuses) or a callback throws: those are
 * denies, reported to `onDecision` with the reason in `invalid`.
 *
 * Always map an authenticated owner from the router's `Principal.key`
 * (scheme, issuer, tenant, client and subject). A bare `subject` may repeat
 * across issuers and silently merge two callers into one Cedar entity.
 *
 * @module
 */

import type { Context, Principal } from "@celld/web/router";
import type { Authorizer, Decision } from "./authorizer.ts";
import type { Entity, EntitySet } from "./entities.ts";
import type { CedarInput, EntityUid } from "./values.ts";

type Awaitable<T> = T | Promise<T>;

/** How a route's request becomes a Cedar request. */
export interface CedarRouteOptions {
  /** The authorizer, or one per request (a policy store's current one). */
  readonly authorizer: Authorizer | ((c: Context) => Awaitable<Authorizer>);
  /** The principal's entity uid. */
  readonly principal: (principal: Principal, c: Context) => EntityUid;
  /** The action: a uid, an action id, or one per request. */
  readonly action: EntityUid | string | ((c: Context) => EntityUid | string);
  /** The resource the route acts on. */
  readonly resource: (c: Context, principal: Principal) => Awaitable<EntityUid>;
  readonly context?: (
    principal: Principal,
    c: Context,
  ) => Awaitable<{ readonly [key: string]: CedarInput | undefined }>;
  /**
   * Entities beyond what the authorizer's loader finds: the principal's own
   * entity built from its claims, say.
   */
  readonly entities?: (
    principal: Principal,
    c: Context,
  ) => Awaitable<EntitySet | readonly Entity[]>;
  /** Every decision, allowed or not (for an audit log). Errors here are ignored. */
  readonly onDecision?: (decision: Decision, c: Context) => void;
}

const decisions = new WeakMap<Context, Decision>();

/** The decision the route's `cedarAuthorize` made for this request. */
export function decisionOf(c: Context): Decision | undefined {
  return decisions.get(c);
}

/** An `authorize` for a route: true exactly when Cedar allows. */
export function cedarAuthorize(
  options: CedarRouteOptions,
): (principal: Principal, c: Context) => Promise<boolean> {
  return async (principal, c) => {
    let decision: Decision;
    try {
      const authorizer = typeof options.authorizer === "function"
        ? await options.authorizer(c)
        : options.authorizer;
      const action = typeof options.action === "function"
        ? options.action(c)
        : options.action;
      const [resource, context, entities] = await Promise.all([
        options.resource(c, principal),
        options.context?.(principal, c),
        options.entities?.(principal, c),
      ]);
      decision = await authorizer.authorize({
        principal: options.principal(principal, c),
        action,
        resource,
        ...(context !== undefined ? { context } : {}),
        ...(entities !== undefined ? { entities } : {}),
      });
    } catch (error) {
      decision = {
        allowed: false,
        decision: "deny",
        reasons: [],
        errors: [],
        invalid: [{
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
          spans: [],
          related: [],
        }],
        warnings: [],
      };
    }
    decisions.set(c, decision);
    try {
      options.onDecision?.(decision, c);
    } catch {
      // An audit hook cannot change the answer.
    }
    return decision.allowed;
  };
}
