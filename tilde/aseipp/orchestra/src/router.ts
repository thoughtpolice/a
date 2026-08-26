// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Stateless public HTTP API: milestone submission/status, agent leases, verified
 * R2 JSON artifacts, Workflow status, Queue metrics, and D1 history. Internal
 * object mutation endpoints and notification RPC are not publicly forwarded.
 * This local prototype has no authentication; do not expose it to untrusted users.
 * @module
 */
import { STATE_VERSION } from "./util/constants.ts";
import { historyResponse } from "./history.ts";
import {
  errorMessage,
  requestObject,
  requireName,
  responseError,
  responseJson,
  rpcResponse,
} from "./util/http.ts";
import { epochCellName } from "./util/identifiers.ts";
import { digest, putBytes, readUpload } from "./util/artifacts.ts";
import {
  claimRequest,
  completeRequest,
  epochSubmission,
  renewRequest,
} from "./util/requests.ts";
import { workflowHistory } from "./util/workflow_history.ts";
import type { OrchestraEnvironment } from "./model.ts";

/** Route one request using only documented celld bindings. */
export async function routeRequest(
  request: Request,
  env: OrchestraEnvironment,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(
      decodeURIComponent,
    );
    if (
      request.method === "GET" &&
      (parts.length === 0 || url.pathname === "/health")
    ) {
      return responseJson({
        service: "orchestra",
        version: STATE_VERSION,
        architecture: "workflows-queues-r2",
      });
    }
    if (parts[0] !== "v1") return responseError(404, "route not found");
    if (
      parts[1] === "events" && parts.length === 2 && request.method === "GET"
    ) return responseJson(await env.EVENTS.metrics());
    if (parts[1] === "artifacts") {
      if (parts.length === 2 && request.method === "POST") {
        return responseJson(
          await putBytes(env.ARTIFACTS, await readUpload(request)),
          { status: 201 },
        );
      }
      if (
        parts.length === 4 && parts[2] === "sha256" &&
        /^[a-f0-9]{64}\.json$/.test(parts[3]) && request.method === "GET"
      ) {
        const object = await env.ARTIFACTS.get("sha256/" + parts[3]);
        if (!object) return responseError(404, "artifact not found");
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (await digest(bytes) !== parts[3].slice(0, -5)) {
          throw new Error("artifact integrity mismatch");
        }
        return new Response(bytes, {
          headers: {
            "content-type": "application/json",
            etag: object.httpEtag,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
    }
    if (parts[1] === "repos" && parts.length >= 3) {
      const repo = requireName(parts[2], "repo");
      const repository = env.REPOSITORY.getByName(repo);
      if (parts.length === 3 && request.method === "GET") {
        return responseJson(await repository.getState());
      }
      if (
        parts.length === 4 && parts[3] === "epochs" && request.method === "POST"
      ) {
        const result = await repository.submitEpoch(
          epochSubmission(repo, await requestObject(request)),
        );
        return rpcResponse(
          result,
          result.ok && result.value.created ? 201 : 200,
        );
      }
      if (
        parts.length === 4 && parts[3] === "history" && request.method === "GET"
      ) return historyResponse(request, env, repo);
      if (
        (parts.length === 5 || parts.length === 6) && parts[3] === "epochs" &&
        request.method === "GET"
      ) {
        const epochId = requireName(parts[4], "epoch_id");
        // Only genuine absence falls back to the repository reservation.
        // Routing/storage errors reject, rather than manufacturing queued state.
        const epoch =
          await env.EPOCH.getByName(epochCellName(repo, epochId)).getState() ??
            (await repository.getState()).epochs[epochId];
        if (!epoch) return responseError(404, "epoch not found");
        if (parts.length === 5) return responseJson(epoch);
        if (parts[5] === "workflow") {
          return responseJson(await workflowHistory(env, epoch));
        }
      }
    }
    if (parts[1] === "queues" && parts.length >= 3) {
      const stub = env.JOB_QUEUE.getByName(requireName(parts[2], "queue"));
      if (parts.length === 3 && request.method === "GET") {
        return rpcResponse(await stub.getState());
      }
      if (
        parts.length === 4 &&
        ["claim", "renew", "complete"].includes(parts[3]) &&
        request.method === "POST"
      ) {
        const input = await requestObject(request);
        if (parts[3] === "claim") {
          const result = await stub.claim(claimRequest(input));
          return result.ok && result.value === null
            ? new Response(null, { status: 204 })
            : rpcResponse(result);
        }
        if (parts[3] === "renew") {
          return rpcResponse(await stub.renew(renewRequest(input)));
        }
        return rpcResponse(await stub.complete(completeRequest(input)));
      }
    }
    return responseError(404, "route not found");
  } catch (error) {
    return responseError(
      error instanceof TypeError || error instanceof URIError ||
        error instanceof SyntaxError
        ? 400
        : 503,
      errorMessage(error),
    );
  }
}
