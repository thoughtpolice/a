// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { count, greet, later } from "@fixture/plain";
export default {
  async fetch() {
    return Response.json({
      greeting: greet("Worker"),
      count,
      dynamic: await later(),
    });
  },
};
