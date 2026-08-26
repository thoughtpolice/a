// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared control-plane policy constants used across Orchestra modules.
 *
 * Keeping persisted-state versions and scheduling limits here gives every
 * Durable Object the same protocol defaults without introducing dependencies
 * between the object implementations.
 *
 * @module
 */

/** Schema/protocol version written into every persisted Orchestra state record. */
export const STATE_VERSION = 4;

/** Schema version accepted for target-determination manifests. */
export const TARGET_MANIFEST_VERSION = 2;

/** Queue selected when an epoch request does not name an execution queue. */
export const DEFAULT_QUEUE = "default";

/** Claim/renewal duration granted to an agent that does not request a duration. */
export const DEFAULT_LEASE_MS = 30_000;

/** Smallest per-request claim/renewal duration accepted from an agent. */
export const MIN_LEASE_MS = 1_000;

/** Largest per-request duration; live renewals can keep a job running longer. */
export const MAX_LEASE_MS = 5 * 60_000;
