// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake's Turnstile: widgets, the tokens a solved challenge would give
 * a visitor, and siteverify. See `FakeCloudflare.turnstile`.
 *
 * Siteverify refuses as Cloudflare documents: a missing or unknown secret,
 * a missing or unknown token, a token of another widget, and a token
 * already spent or older than five minutes (`timeout-or-duplicate`). A
 * repeated `idempotency_key` gets its first answer back. The documented
 * test secrets behave as documented with the dummy token.
 *
 * @module
 */

import type { FakeCloudflare, FakeRequest } from "./testing.ts";
import { TEST_KEYS, TOKEN_LIFETIME_MS, type Widget } from "./turnstile.ts";

interface IssuedToken {
  readonly sitekey: string;
  readonly hostname: string;
  readonly action?: string;
  readonly cdata?: string;
  readonly remoteip?: string;
  readonly issuedAt: number;
  spent: boolean;
}

/** What a visitor's solved challenge carries. */
export interface ChallengeInput {
  /** The page's hostname. */
  readonly hostname: string;
  readonly action?: string;
  readonly cdata?: string;
  /** The visitor's address; siteverify refuses the token from another. */
  readonly remoteip?: string;
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export class FakeTurnstile {
  readonly #fake: FakeCloudflare;
  readonly #widgets = new Map<string, Widget & { secret: string }>();
  /** Secrets replaced by a rotation that still verify, by sitekey. */
  readonly #previous = new Map<string, string>();
  readonly #tokens = new Map<string, IssuedToken>();
  readonly #idempotent = new Map<string, Record<string, unknown>>();
  #serial = 0;

  constructor(fake: FakeCloudflare) {
    this.#fake = fake;
    this.#routes();
  }

  /** Adds a widget to the fake's account. */
  addWidget(fields: Partial<Widget> & { readonly name: string }): Widget {
    const sitekey = `0x4AAAAAAA${this.#random(14)}`;
    const widget = {
      sitekey,
      secret: `0x4AAAAAAA${this.#random(24)}`,
      domains: [],
      mode: "managed",
      bot_fight_mode: false,
      clearance_level: "no_clearance",
      ephemeral_id: false,
      offlabel: false,
      region: "world",
      created_on: this.#fake.timestamp(),
      modified_on: this.#fake.timestamp(),
      ...fields,
    } as Widget & { secret: string };
    this.#widgets.set(sitekey, widget);
    return widget;
  }

  /** The widget, with its secret. */
  widget(sitekey: string): (Widget & { secret: string }) | undefined {
    return this.#widgets.get(sitekey);
  }

  /**
   * A token, as the widget would give a visitor who solved its challenge
   * on `hostname`.
   */
  issueToken(sitekey: string, challenge: ChallengeInput): string {
    if (!this.#widgets.has(sitekey)) {
      throw new Error(`no widget ${sitekey}`);
    }
    const token = `0.${this.#random(40)}.${this.#random(40)}`;
    this.#tokens.set(token, {
      sitekey,
      ...challenge,
      issuedAt: this.#fake.nowMs(),
      spent: false,
    });
    return token;
  }

  #random(length: number): string {
    // Deterministic per fake, so a failing spec shows the same values twice.
    let out = "";
    for (let i = 0; i < length; i++) {
      this.#serial = (this.#serial * 1103515245 + 12345) % 2147483648;
      out += ALPHABET[this.#serial % ALPHABET.length];
    }
    return out;
  }

  #routes(): void {
    const fake = this.#fake;
    const { ok, error } = fake.answers;
    const base = `/accounts/${fake.accountId}/challenges/widgets`;
    const noSecret = ({ secret: _secret, ...widget }: Widget) => widget;
    fake.route("GET", base, (request) => {
      const filter = request.query.get("filter");
      const [field, value] = filter === null ? [null, null] : [
        filter.slice(0, filter.indexOf(":")),
        filter.slice(filter.indexOf(":") + 1),
      ];
      if (field !== null && field !== "name" && field !== "sitekey") {
        return error(
          400,
          10400,
          "filter must be name:<text> or sitekey:<sitekey>",
        );
      }
      const widgets = [...this.#widgets.values()].filter((widget) =>
        field === null ||
        (field === "name"
          ? widget.name.toLowerCase().includes(value!.toLowerCase())
          : widget.sitekey === value)
      );
      return fake.paged(widgets.map(noSecret), request.query, 25, 1000);
    });
    fake.route("POST", base, (request) => {
      const body = request.body as Partial<Widget> | null;
      if (typeof body?.name !== "string" || !Array.isArray(body.domains)) {
        return error(400, 10400, "name and domains are required");
      }
      return ok(this.addWidget(body as Widget));
    });
    const key = "(0x[A-Za-z0-9_-]+)";
    fake.route("GET", `${base}/${key}`, (_request, [sitekey]) => {
      const widget = this.#widgets.get(sitekey);
      return widget ? ok(widget) : error(404, 10404, "widget not found");
    });
    fake.route("PUT", `${base}/${key}`, (request, [sitekey]) => {
      const widget = this.#widgets.get(sitekey);
      if (widget === undefined) return error(404, 10404, "widget not found");
      const updated = {
        ...widget,
        ...(request.body as object),
        sitekey,
        secret: widget.secret,
        modified_on: fake.timestamp(),
      };
      this.#widgets.set(sitekey, updated);
      return ok(updated);
    });
    fake.route("DELETE", `${base}/${key}`, (_request, [sitekey]) => {
      const widget = this.#widgets.get(sitekey);
      if (widget === undefined) return error(404, 10404, "widget not found");
      this.#widgets.delete(sitekey);
      this.#previous.delete(sitekey);
      return ok(noSecret(widget));
    });
    fake.route("POST", `${base}/${key}/rotate_secret`, (request, [sitekey]) => {
      const widget = this.#widgets.get(sitekey);
      if (widget === undefined) return error(404, 10404, "widget not found");
      const immediately =
        (request.body as { invalidate_immediately?: boolean } | null)
          ?.invalidate_immediately === true;
      if (immediately) this.#previous.delete(sitekey);
      else this.#previous.set(sitekey, widget.secret);
      const rotated = {
        ...widget,
        secret: `0x4AAAAAAA${this.#random(24)}`,
        modified_on: fake.timestamp(),
      };
      this.#widgets.set(sitekey, rotated);
      return ok(rotated);
    });
    fake.routeOther("POST", "/turnstile/v0/siteverify", (request) => {
      const body = this.#verify(request);
      // Siteverify answers 200 for any token; 400 only for the secret.
      const codes = body["error-codes"] as string[];
      const status = codes.includes("missing-input-secret") ||
          codes.includes("invalid-input-secret")
        ? 400
        : 200;
      return { status, body };
    });
  }

  #verify(request: FakeRequest): Record<string, unknown> {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const key = typeof body.idempotency_key === "string"
      ? body.idempotency_key
      : undefined;
    if (key !== undefined && this.#idempotent.has(key)) {
      return this.#idempotent.get(key)!;
    }
    const answer = this.#decide(body);
    if (key !== undefined) this.#idempotent.set(key, answer);
    return answer;
  }

  #decide(body: Record<string, unknown>): Record<string, unknown> {
    const refuse = (code: string) => ({
      success: false,
      "error-codes": [code],
      messages: [],
    });
    const secret = body.secret;
    const token = body.response;
    if (typeof secret !== "string" || secret === "") {
      return refuse("missing-input-secret");
    }
    if (typeof token !== "string" || token === "") {
      return refuse("missing-input-response");
    }
    const test = Object.values(TEST_KEYS.secrets) as string[];
    if (test.includes(secret)) {
      if (secret === TEST_KEYS.secrets.alwaysFails) {
        return refuse("invalid-input-response");
      }
      if (secret === TEST_KEYS.secrets.alreadySpent) {
        return refuse("timeout-or-duplicate");
      }
      // As observed: no action or cdata, and a testing-key flag.
      return token === TEST_KEYS.dummyToken
        ? {
          success: true,
          "error-codes": [],
          challenge_ts: this.#fake.timestamp(),
          hostname: "example.com",
          metadata: { result_with_testing_key: true },
        }
        : refuse("invalid-input-response");
    }
    const sitekey =
      [...this.#widgets.values()].find((widget) => widget.secret === secret)
        ?.sitekey ??
        [...this.#previous].find(([, old]) => old === secret)?.[0];
    if (sitekey === undefined) return refuse("invalid-input-secret");
    const issued = this.#tokens.get(token);
    if (issued === undefined || issued.sitekey !== sitekey) {
      return refuse("invalid-input-response");
    }
    if (
      issued.spent ||
      this.#fake.nowMs() - issued.issuedAt > TOKEN_LIFETIME_MS
    ) {
      return refuse("timeout-or-duplicate");
    }
    if (
      issued.remoteip !== undefined && typeof body.remoteip === "string" &&
      body.remoteip !== issued.remoteip
    ) {
      return refuse("invalid-input-response");
    }
    issued.spent = true;
    return {
      success: true,
      "error-codes": [],
      challenge_ts: new Date(issued.issuedAt).toISOString(),
      hostname: issued.hostname,
      action: issued.action ?? "",
      cdata: issued.cdata ?? "",
      metadata: { interactive: false },
      messages: [],
    };
  }
}
