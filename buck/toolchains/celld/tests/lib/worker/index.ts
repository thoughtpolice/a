// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { score } from "@fixture/top";

export { Counter } from "@fixture/objects";

export default {
  fetch(_request: Request): Response {
    return new Response(String(score(1)));
  },
};
