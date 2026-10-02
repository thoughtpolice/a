// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Find the next enabled index with wraparound. `from = -1` starts before the
 * first item (forward) or after the last (backward). Returns -1 if none exist.
 */
export function nextEnabledIndex(
  enabled: readonly boolean[],
  from: number,
  direction: 1 | -1,
): number {
  const length = enabled.length;
  if (length === 0) return -1;
  const start = from < 0 ? (direction === 1 ? -1 : 0) : from;
  for (let step = 1; step <= length; step++) {
    const index = ((start + step * direction) % length + length) % length;
    if (enabled[index]) return index;
  }
  return -1;
}
