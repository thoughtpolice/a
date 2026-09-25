// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The schemas of a small ticketing API, as their own library
 * (`@sieve-example/api`), so the same module is what the `schema` example
 * Worker parses with and what `sieve_json_schema` exports at build time.
 * Every exported schema with a `meta({ id })` becomes a `$defs` entry.
 *
 * @module
 */

import { v } from "@celld/sieve";

/** How urgent a ticket is. */
export const Priority = v.enum(["low", "normal", "high", "urgent"]).meta({
  id: "Priority",
  description: "How urgent a ticket is.",
});

/** Who reported a ticket. */
export const Contact = v.object({
  name: v.string().trim().min(1).max(100),
  email: v.email(),
}).meta({ id: "Contact" });

/** A new ticket, as a client submits it. */
export const Ticket = v.object({
  title: v.string().trim().min(5).max(200).describe("One line."),
  body: v.string().max(10_000).default(""),
  priority: Priority.default("normal"),
  reporter: Contact,
  labels: v.array(v.string().regex(/^[a-z0-9-]+$/)).max(10).default([]),
  due: v.iso.date().optional(),
}).meta({ id: "Ticket", title: "Ticket" });

/** A change to a ticket: any subset of its fields but the reporter. */
export const TicketPatch = Ticket.omit({ reporter: true }).partial().strict()
  .meta({ id: "TicketPatch" });
