// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { count, greet, later } from "@fixture/plain";
import { count as sharedCount } from "@fixture/plain/state";
import { configValue } from "@fixture/config";

const greetings = [greet("Ada"), greet("Grace")];
console.log(
  JSON.stringify({
    count,
    live: sharedCount,
    greetings,
    dynamic: await later(),
    config: configValue,
  }),
);
