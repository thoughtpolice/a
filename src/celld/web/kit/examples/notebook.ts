// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type { Note } from "@celld/web/fieldnotes/contracts";
import { DurableObject } from "cloudflare:workers";

/** A notebook whose notes survive object eviction and runtime restarts. */
export class Notebook extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL)",
    ).toArray();
  }

  /** Return every saved note, newest first. */
  list(): Note[] {
    return this.ctx.storage.sql.exec<Note>(
      "SELECT id, title, body FROM notes ORDER BY id DESC",
    ).toArray();
  }

  /** Insert a validated note and return the resulting notebook atomically. */
  add(title: string, body: string): Note[] {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO notes (title, body) VALUES (?, ?)",
        title,
        body,
      ).toArray();
      return this.list();
    });
  }
}
