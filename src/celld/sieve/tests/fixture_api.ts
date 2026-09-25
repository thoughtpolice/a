// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A small API module for the emitter's golden test: named schemas that
 * reference each other, a recursive one, and exports the emitter skips.
 *
 * @module
 */

import { v } from "@celld/sieve";

/** A severity; named, so every use is a `$ref`. */
export const Severity = v.enum(["low", "medium", "high"]).meta({
  id: "Severity",
  description: "How bad a finding is.",
});

/** A location in a file. */
export const Location = v.object({
  path: v.string().min(1),
  line: v.int().positive().optional(),
}).meta({ id: "Location" });

/** One finding. */
export const Finding = v.object({
  title: v.string().min(3).describe("What is wrong."),
  severity: Severity,
  at: Location.nullable(),
  tags: v.array(v.string()).default([]),
}).meta({ id: "Finding", title: "Finding" });

/**
 * A section of a report, which may nest. The input type differs from the
 * output (`tags` has a default), so the annotation leaves it `unknown`.
 */
export type Section = {
  heading: string;
  findings: v.Infer<typeof Finding>[];
  sections: Section[];
};
export const Section: v.Schema<Section, unknown> = v.object({
  heading: v.string(),
  findings: v.array(Finding),
  sections: v.array(v.lazy(() => Section)),
}).meta({ id: "Section" });

/** A message sent to the reviewer. */
export const Event = v.discriminatedUnion("type", [
  v.object({ type: v.literal("finding"), finding: Finding }),
  v.object({ type: v.literal("done"), sections: v.array(Section) }),
]).meta({ id: "Event" });

/** Unnamed, so the emitter leaves it out. */
export const Unnamed = v.object({ a: v.string() });

/** Not a schema. */
export const VERSION = 1;
