// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Stateless default Worker entrypoint.
 *
 * celld invokes this object for public HTTP traffic. It intentionally contains
 * no business logic or mutable state: request interpretation belongs to the
 * router, and durable coordination belongs to the named object modules. This
 * separation keeps the fleet-scalable Worker layer disposable.
 *
 * @module
 */

import type { OrchestraEnvironment } from "./model.ts";
import { routeRequest } from "./router.ts";

/** Default celld module handler that delegates all HTTP traffic to the router. */
const worker: ExportedHandler<OrchestraEnvironment> = {
  /** Routes one incoming HTTP request using the current deployment bindings. */
  fetch(request, env): Response | Promise<Response> {
    return routeRequest(request, env);
  },
};

/** The default export registered by celld as Orchestra's public Worker. */
export default worker;
