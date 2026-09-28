// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A waitlist behind Turnstile.
 *
 * `GET /` is the sign-up page with the Turnstile widget. `POST /signup`
 * with `{"email", "token"}` (the widget's `cf-turnstile-response`) checks
 * the token with siteverify (for this widget, on `TURNSTILE_HOSTNAME`,
 * for the `signup` action) and only then adds the address to the list: a
 * `Waitlist` Durable Object whose insert is the claim, so a second sign-up
 * of one address is told it is already there. A refused token is a 403
 * with siteverify's codes; siteverify being unreachable is a 503, since
 * the check fails closed. Bodies over 16 KiB are a 413.
 *
 * Both routes are public on purpose: a waitlist is for strangers, and
 * Turnstile is what keeps bots out. Anyone can still learn whether an
 * address is on the list by signing it up, and each token signs up one
 * address. The widget's secret is a Worker secret (`TURNSTILE_SECRET`):
 * siteverify takes it in the body, where an exe.dev integration cannot
 * add it.
 *
 * ```sh
 * buck2 run root//src/celld/api/cloudflare/examples:signup-dev
 * TOKEN=$(curl -sS -X POST "$UPSTREAM/__turnstile/token" -d '{"action": "signup"}' | jq -r .token)
 * curl -sS -X POST localhost:9876/signup -H 'content-type: application/json' \
 *   -d "{\"email\": \"ada@example.com\", \"token\": \"$TOKEN\"}"
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { verifyTurnstile } from "@celld/api/cloudflare/turnstile";
import { router } from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly WAITLIST: DurableObjectNamespace<Waitlist>;
  readonly TURNSTILE_SITEKEY: string;
  /** A secret. */
  readonly TURNSTILE_SECRET: string;
  /** The hostname the page is served on; default `example.com`. */
  readonly TURNSTILE_HOSTNAME?: string;
  /** For a fake siteverify in development. */
  readonly TURNSTILE_SITEVERIFY_URL?: string;
  readonly TURNSTILE_LOOPBACK_FOR_DEVELOPMENT?: string;
}

/** The list; adding is atomic, so each address is added once. */
export class Waitlist extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
    );
  }

  /** Whether `email` was added now (false: it was already there). */
  add(email: string): boolean {
    const cursor = this.ctx.storage.sql.exec(
      "INSERT INTO waitlist (email, added_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING",
      email,
      Date.now(),
    );
    return cursor.rowsWritten === 1;
  }

  size(): number {
    return this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM waitlist",
    ).one().n;
  }
}

const SignUp = v.strictObject({
  email: v.string().trim().toLowerCase().email().max(254),
  token: v.string().min(1).max(2048),
});

const app = router<Env>({ auth: "none", limits: { body: 16 * 1024 } });

// Public on purpose: the page anyone may load.
app.get("/", { public: true }, (c) =>
  c.html(`<!doctype html>
<meta charset="utf-8">
<title>Join the waitlist</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="signup">
  <input name="email" type="email" required placeholder="you@example.com">
  <div class="cf-turnstile" data-sitekey="${
    escape(c.env.TURNSTILE_SITEKEY)
  }" data-action="signup"></div>
  <button>Join</button>
</form>
<script>
document.getElementById("signup").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const answer = await fetch("/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: form.get("email"),
      token: form.get("cf-turnstile-response"),
    }),
  });
  event.target.replaceWith((await answer.json()).status ?? "Something went wrong");
});
</script>`));

// Public on purpose: Turnstile, not a login, decides who may sign up.
app.post("/signup", { public: true, body: SignUp }, async (c) => {
  let verdict;
  try {
    verdict = await verifyTurnstile({
      secret: c.env.TURNSTILE_SECRET,
      token: c.body.token,
      remoteip: c.ip()?.toString(),
      expectedHostname: c.env.TURNSTILE_HOSTNAME ?? "example.com",
      expectedAction: "signup",
      siteverifyUrl: c.env.TURNSTILE_SITEVERIFY_URL,
      allowLoopbackForDevelopment:
        c.env.TURNSTILE_LOOPBACK_FOR_DEVELOPMENT === "true",
    });
  } catch (error) {
    console.error("siteverify unreachable:", error);
    return c.json({ error: "verification_unavailable" }, 503);
  }
  if (!verdict.success) {
    return c.json(
      { error: "challenge_failed", codes: verdict.errorCodes },
      403,
    );
  }
  const added = await c.env.WAITLIST.getByName("waitlist").add(c.body.email);
  return added
    ? c.json({ status: "added" }, 201)
    : c.json({ status: "already_on_the_list" });
});

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export default { fetch: app.fetch };
