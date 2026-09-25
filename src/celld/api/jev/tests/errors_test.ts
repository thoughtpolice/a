// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  type AnyJevError,
  isJevError,
  JevAbortError,
  JevApiError,
  JevConnectionError,
  JevDecodeError,
  JevError,
  type JevErrorData,
  jevErrorFromData,
  JevInvalidRequestError,
  JevTimeoutError,
  kindForStatus,
  validationIssues,
} from "@celld/api/jev";

Deno.test("statuses map to kinds", () => {
  assertEquals(
    [400, 401, 403, 404, 408, 409, 422, 429, 500, 503, 529, 599].map(
      kindForStatus,
    ),
    [
      "bad_request",
      "authentication",
      "permission",
      "not_found",
      "http",
      "http",
      "validation",
      "rate_limited",
      "server",
      "server",
      "overloaded",
      "server",
    ],
  );
});

Deno.test("transient kinds are retryable", () => {
  const api = (status: number) =>
    new JevApiError(kindForStatus(status), "x", { status });
  assertEquals(
    [401, 408, 422, 429, 500, 529].map((status) => api(status).retryable),
    [false, true, false, true, true, true],
  );
  assert(new JevConnectionError("x").retryable, "connection");
  assert(new JevTimeoutError("x").retryable, "timeout");
  assert(!new JevAbortError().retryable, "aborted");
  assert(!new JevDecodeError([]).retryable, "decode");
  assert(!new JevInvalidRequestError([]).retryable, "invalid");
});

Deno.test("errors survive a round trip through plain data", () => {
  const originals: AnyJevError[] = [
    new JevApiError("rate_limited", "slow down", {
      status: 429,
      retryAfterMs: 2000,
      requestId: "req-1",
      body: { detail: "rate limited" },
      attempts: 3,
    }),
    new JevApiError("validation", "bad", {
      status: 422,
      issues: [{
        code: "custom",
        path: ["questions", "q"],
        message: "field required",
      }],
    }),
    new JevInvalidRequestError([{
      code: "custom",
      path: ["state"],
      message: "state is required",
    }]),
    new JevDecodeError([{
      code: "custom",
      path: ["answers"],
      message: "missing",
    }], {
      status: 200,
    }),
    new JevConnectionError("reset"),
    new JevTimeoutError("slow"),
    new JevAbortError(),
  ];
  for (const original of originals) {
    // Structured clone is what DO RPC and Workflow steps do to results.
    const data: JevErrorData = structuredClone(original.toJSON());
    assertEquals(JSON.parse(JSON.stringify(original)), data);
    const rebuilt = jevErrorFromData(data);
    assert(rebuilt instanceof JevError, "a JevError");
    assertEquals(rebuilt.constructor, original.constructor);
    assertEquals(rebuilt.toJSON(), original.toJSON());
    assertEquals(rebuilt.message, original.message);
  }
});

Deno.test("the union narrows on kind", () => {
  const error: unknown = new JevApiError("rate_limited", "x", { status: 429 });
  if (isJevError(error) && error.kind === "rate_limited") {
    // Narrowed to JevApiError, whose status is a number.
    const status: number = error.status;
    assertEquals(status, 429);
  } else {
    throw new Error("expected to narrow");
  }
  assert(!isJevError(new Error("x")), "plain errors are not ours");
});

Deno.test("422 bodies become located issues", () => {
  assertEquals(
    validationIssues({
      detail: [
        {
          loc: ["body", "questions", "q", "criteria"],
          msg: "too many options",
        },
        { loc: ["body", "state"], msg: "field required", type: "missing" },
        "junk",
      ],
    }),
    [
      {
        code: "custom",
        path: ["questions", "q", "criteria"],
        message: "too many options",
      },
      { code: "custom", path: ["state"], message: "field required" },
    ],
  );
  assertEquals(validationIssues({ detail: "state is too long" }), [
    { code: "custom", path: [], message: "state is too long" },
  ]);
  assertEquals(validationIssues({ error: { message: "nope" } }), [
    { code: "custom", path: [], message: "nope" },
  ]);
  assertEquals(validationIssues(null), []);
});
