// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake TypeSafe server the jev examples run against: `FakeTypeSafe`
 * from `fake.ts`, whose module notes list the `script` entries a spec can
 * send. It sets `TYPESAFE_BASE_URL` to itself and `TYPESAFE_API_KEY` to the
 * key it accepts, which is how `JevClient.fromEnv` finds it.
 *
 * @module
 */

import {
  API_KEY,
  FakeTypeSafe,
  type Reply,
} from "@celld/api/jev/examples/fake";
import { serveUpstream } from "@celld/examples/upstream";

const typesafe = new FakeTypeSafe();

serveUpstream({
  fetch: (request) => typesafe.fetch(request),
  script: (instruction) => typesafe.script(instruction as Reply),
  vars: (origin) => ({ TYPESAFE_BASE_URL: origin, TYPESAFE_API_KEY: API_KEY }),
});
