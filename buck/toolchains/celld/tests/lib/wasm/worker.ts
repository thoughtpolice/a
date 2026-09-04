// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { add, COMPILED } from "@fixture/wasm";

export default {
  fetch(_request: Request): Response {
    return Response.json({ compiled: COMPILED, sum: add(2, 40) });
  },
};
