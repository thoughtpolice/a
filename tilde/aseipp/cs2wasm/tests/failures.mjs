// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A run that goes on past a failing case (tests/behavior.mjs,
// tests/differential.mjs) checks every case and reports each that failed,
// by its key, so one run shows everything a change broke. The run fails
// if any case did.
export function reportFailures(failures, passed) {
  for (const [key, message] of [...failures].sort()) {
    console.log(`FAILURE ${key}: ${message}`);
  }
  console.log(`${passed.size} of ${passed.size + failures.size} cases passed.`);
  return failures.size === 0;
}
