// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Public API for Orchestra's pure FACF engine, ported from Rust at `zrqw`.
 *
 * The caller maps ordered commit IDs to positions, owns test/version lineage,
 * persists and deduplicates actual execution observations, enforces a budget,
 * and turns proposed positions into Buck jobs. This package only performs
 * inference and next-position selection. It has no network, storage, clock,
 * celld, or Buck dependency, so Workflow replays and unit tests share one model.
 *
 * See `search.ts` for provenance, model assumptions, edge cases, and intentional
 * numerical/API differences from the Rust implementation. The source paper is
 * https://storage.googleapis.com/gweb-research2023-media/pubtools/6969.pdf.
 *
 * @module
 */

export { Distribution } from "./distribution.ts";
export {
  DEFAULT_SEARCH_CONFIG,
  DETERMINISTIC_SEARCH_CONFIG,
  type Execution,
  FacfSearch,
  type SearchConfig,
  type SearchResult,
  type TestResult,
} from "./search.ts";
