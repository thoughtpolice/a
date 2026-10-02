// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { type ClientFailure, defineRoute } from "@celld/web/router/client";
import {
  createPageLoader,
  createPageMatcher,
  definePage,
  type NavigationState,
  type PageResult,
  queryValues,
} from "@celld/web/kit/navigation";

Deno.test("pages share router precedence and decode segments exactly once", () => {
  const wild = definePage(
    defineRoute("GET", "/items/*rest"),
    () => Promise.resolve({ ok: true, data: "wild" }),
  );
  const param = definePage(
    defineRoute("GET", "/items/:id"),
    () => Promise.resolve({ ok: true, data: "param" }),
  );
  const fixed = definePage(
    defineRoute("GET", "/items/me"),
    () => Promise.resolve({ ok: true, data: "fixed" }),
  );
  const match = createPageMatcher([wild, param, fixed]);
  assertEquals(match(new URL("https://example.test/items/me"))?.page, fixed);
  assertEquals(
    match(new URL("https://example.test/items/a%2Fb%252F"))?.params,
    { id: "a/b%2F" },
  );
  assertEquals(match(new URL("https://example.test/items/"))?.params, {
    rest: "",
  });
  assertEquals(match(new URL("https://example.test/items/a/b"))?.params, {
    rest: "a/b",
  });
  assertEquals(match(new URL("https://example.test/items/%GG")), null);
});

Deno.test("query fields retain repeated values, plus encoding and prototype-like names", () => {
  const values = queryValues(
    new URLSearchParams(
      "tag=a%2Bb&tag=c+d&__proto__=safe&constructor=own&empty=",
    ),
  );
  assertEquals(values.tag, ["a+b", "c d"]);
  assertEquals(values.__proto__, "safe");
  assertEquals(values.constructor, "own");
  assertEquals(values.empty, "");
});

Deno.test("superseded page success cannot commit or overwrite the newest settled state", async () => {
  const jobs: {
    signal: AbortSignal;
    finish: (result: PageResult<string>) => void;
  }[] = [];
  const states: NavigationState<string>[] = [];
  const commits: string[] = [];
  const page = definePage(defineRoute("GET", "/items/:id"), ({ signal }) => {
    const { promise, resolve } = Promise.withResolvers<PageResult<string>>();
    jobs.push({ signal, finish: resolve });
    return promise;
  });
  const loader = createPageLoader({
    pages: [page],
    onState: (state) => {
      states.push(state);
    },
    commit: (data) => {
      commits.push(data);
    },
  });
  const first = loader.load(new URL("https://example.test/items/1"));
  const second = loader.load(new URL("https://example.test/items/2"));
  assert(jobs[0].signal.aborted, "new navigation must abort the old loader");
  jobs[1].finish({ ok: true, data: "second" });
  assertEquals(await second, true);
  jobs[0].finish({ ok: true, data: "stale" });
  assertEquals(await first, false);
  assertEquals(commits, ["second"]);
  assertEquals(states.map((state) => state.status), [
    "pending",
    "pending",
    "success",
  ]);
  assertEquals(loader.state, {
    status: "success",
    url: new URL("https://example.test/items/2"),
    data: "second",
  });
});

Deno.test("failed navigation retains prior page; update and destroy abort outstanding work", async () => {
  const failure: ClientFailure = {
    ok: false,
    kind: "transport",
    cause: new Error("offline"),
  };
  const jobs: {
    signal: AbortSignal;
    finish: (result: PageResult<string>) => void;
  }[] = [];
  const commits: string[] = [];
  const states: NavigationState<string>[] = [];
  const page = definePage(defineRoute("GET", "/"), ({ signal }) => {
    const { promise, resolve } = Promise.withResolvers<PageResult<string>>();
    jobs.push({ signal, finish: resolve });
    return promise;
  });
  const options = {
    pages: [page],
    onState: (state: NavigationState<string>) => {
      states.push(state);
    },
    commit: (data: string) => {
      commits.push(data);
    },
  };
  const loader = createPageLoader(options);
  const failed = loader.load(new URL("https://example.test/"));
  jobs[0].finish(failure);
  assertEquals(await failed, false);
  assertEquals(loader.state.status, "error");
  assertEquals(commits, []);
  const replaced = loader.load(new URL("https://example.test/"));
  loader.update(options);
  assert(jobs[1].signal.aborted, "updating pages must abort the old loader");
  jobs[1].finish({ ok: true, data: "old" });
  assertEquals(await replaced, false);
  assertEquals(loader.state.status, "idle");
  const disposed = loader.load(new URL("https://example.test/"));
  loader.destroy();
  assert(
    jobs[2].signal.aborted,
    "destroying the loader must abort pending work",
  );
  jobs[2].finish(failure);
  assertEquals(await disposed, false);
  assertEquals(states.map((state) => state.status), [
    "pending",
    "error",
    "pending",
    "idle",
    "pending",
  ]);
  assertEquals(await loader.load(new URL("https://example.test/")), false);
});
