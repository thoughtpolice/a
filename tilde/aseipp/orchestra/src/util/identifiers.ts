// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic naming utilities for celld Durable Object cells.
 *
 * These names are part of Orchestra's internal addressing protocol: every
 * caller must derive the same cell name for a repository epoch so celld routes
 * them to the same single-writer object.
 *
 * @module
 */

/**
 * Returns the celld name of an epoch's Durable Object.
 *
 * @param repo Validated repository name.
 * @param epochId Repository-local epoch identifier.
 * @returns A stable compound name scoped by repository and epoch.
 */
export function epochCellName(repo: string, epochId: string): string {
  return `${repo}:${epochId}`;
}
