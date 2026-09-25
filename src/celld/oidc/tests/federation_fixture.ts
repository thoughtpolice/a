// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Federations for the suites: entities on their own origins, reached
 * through one routing `fetch`.
 *
 * @module
 */

import {
  FederationEntity,
  type FederationEntityOptions,
  federationJwks,
} from "@celld/oidc/federation";
import { generateSigningKey, type SigningKey } from "@celld/oauth/server";
import type { Jwks } from "@celld/jwt";

/** An entity, its key and its public keys. */
export interface Node {
  readonly id: string;
  readonly key: SigningKey;
  readonly jwks: Jwks;
  entity: FederationEntity;
}

/** A federation key for `id` (its `kid` names the entity, for readable failures). */
export async function federationKey(id: string): Promise<SigningKey> {
  return await generateSigningKey("ES256", `${new URL(id).hostname}-fed`);
}

/** An entity with a fresh key; `options` may be changed later with {@link rebuild}. */
export async function node(
  id: string,
  options: Omit<FederationEntityOptions, "entityId" | "keys"> = {},
): Promise<Node> {
  const key = await federationKey(id);
  return {
    id,
    key,
    jwks: federationJwks([key]),
    entity: new FederationEntity({ entityId: id, keys: [key], ...options }),
  };
}

/** Replaces a node's entity with one built from new options (same key). */
export function rebuild(
  target: Node,
  options: Omit<FederationEntityOptions, "entityId" | "keys">,
): void {
  target.entity = new FederationEntity({
    entityId: target.id,
    keys: [target.key],
    ...options,
  });
}

/** A handler for each node's origin, answering 404 for paths it does not serve. */
export function handlers(
  nodes: readonly Node[],
): Record<string, (request: Request) => Promise<Response>> {
  const out: Record<string, (request: Request) => Promise<Response>> = {};
  for (const item of nodes) {
    out[new URL(item.id).origin] = async (request) =>
      await item.entity.handle(request) ??
        new Response("not found", { status: 404 });
  }
  return out;
}
