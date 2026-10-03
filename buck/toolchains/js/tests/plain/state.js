// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

export let count = 0;
export function bump() {
  count += 1;
  return count;
}
