// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { v } from "@celld/sieve";
import { bearer, router } from "@celld/web/router";
import { createClient, defineRoute } from "@celld/web/router/client";
import TestPage from "@celld/web/kit-test-page";
import { renderPage, respondPage } from "@celld/web/kit/server";

function bootProps(html: string): unknown {
  const match = html.match(
    /<script id="celld-boot" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert(match !== null, "missing inert hydration payload");
  return JSON.parse(match[1]);
}

Deno.test("renderPage separates escaped text and attributes from trusted rendered head", async () => {
  const message = '</script><script>alert("x")</script>&<>\u2028\u2029';
  const response = renderPage(TestPage, { message, count: 1 }, {
    title: '<b>&" title',
    lang: 'en" onload="evil',
    head: '<meta name="author" content="kit">',
    scripts: ['/assets/app.js?x="&y=<'],
    styles: ['/assets/app.css?x="&y=<'],
    headers: {
      "x-page": "supplied",
      "content-type": "text/plain",
      "content-length": "1",
    },
    status: 201,
    statusText: "Created",
  });
  const html = await response.text();
  assertEquals(response.status, 201);
  assertEquals(response.statusText, "Created");
  assertEquals(response.headers.get("x-page"), "supplied");
  assertEquals(response.headers.get("content-length"), null);
  assert(
    html.includes("<title>&lt;b&gt;&amp;&quot; title</title>"),
    "title must be escaped text",
  );
  assert(
    html.includes('<html lang="en&quot; onload=&quot;evil">'),
    "language must remain one attribute",
  );
  assert(
    html.includes('<meta name="author" content="kit">'),
    "authored head must remain HTML",
  );
  assert(
    html.includes(
      '<link rel="stylesheet" href="/assets/app.css?x=&quot;&amp;y=&lt;">',
    ),
    "style URLs must be escaped attributes",
  );
  assert(
    html.includes(
      '<script type="module" src="/assets/app.js?x=&quot;&amp;y=&lt;"></script>',
    ),
    "script URLs must be escaped attributes",
  );
  assert(
    !html.includes('<script>alert("x")</script>'),
    "props must not create executable scripts",
  );
  const payload = html.match(/type="application\/json">([\s\S]*?)<\/script>/)
    ?.[1];
  assert(payload !== undefined, "boot data must be present");
  assert(
    !/[<>&\u2028\u2029]/.test(payload),
    "boot script must escape HTML-significant characters and separators",
  );
  assertEquals(bootProps(html), { version: 1, props: { message, count: 1 } });
});

Deno.test("renderPage rejects lossy, executable and unsupported props without evaluating accessors", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const decorated: unknown[] = [1];
  Object.defineProperty(decorated, "extra", {
    value: "discarded",
    enumerable: true,
  });
  const hidden = Object.defineProperty({}, "secret", { value: "discarded" });
  let executed = false;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      executed = true;
      return "unsafe";
    },
  });
  for (
    const invalid of [
      undefined,
      () => "unsafe",
      Symbol("value"),
      1n,
      NaN,
      Infinity,
      -Infinity,
      -0,
      new Date(),
      new Map(),
      new Set(),
      cycle,
      new Array(2),
      decorated,
      hidden,
      getter,
      {
        toJSON() {
          executed = true;
          return {};
        },
      },
      { [Symbol("key")]: "discarded" },
    ]
  ) {
    const props = { message: "safe", count: 1, invalid };
    assertThrows(() => renderPage(TestPage, props));
  }
  assertEquals(executed, false);
});

Deno.test("renderPage rejects executable asset schemes and ambiguous hydration IDs", () => {
  const props = { message: "safe", count: 1 };
  assertThrows(
    () => renderPage(TestPage, props, { scripts: ["javascript:alert(1)"] }),
    TypeError,
  );
  assertThrows(
    () => renderPage(TestPage, props, { styles: ["data:text/css,body{}"] }),
    TypeError,
  );
  assertThrows(
    () => renderPage(TestPage, props, { targetId: "same", bootId: "same" }),
    TypeError,
  );
  assertThrows(
    () => renderPage(TestPage, props, { targetId: "two ids" }),
    TypeError,
  );
  assertThrows(
    () =>
      renderPage(TestPage, props, { title: "one", head: "<title>two</title>" }),
    TypeError,
  );
});

const PageSchema = v.object({
  message: v.string(),
  count: v.coerce.number().int(),
});
const PageRoute = defineRoute("GET", "/page/:id", {
  params: v.object({ id: v.coerce.number().int().positive() }),
  response: PageSchema,
});

Deno.test("a typed page client requests JSON rather than the SSR representation", async () => {
  const app = router({ auth: "none" }).register(
    PageRoute,
    (c) =>
      respondPage(c, PageRoute, TestPage, {
        message: `Page ${c.params.id}`,
        count: "3",
      }),
  );
  const api = createClient<typeof app>()({ page: PageRoute }, {
    baseUrl: "https://example.com",
    fetch: (input, init) => app.fetch(new Request(input, init), {}),
  });
  const result = await api.call("page", { params: { id: 2 } });
  assert(result.ok, "typed page client must receive its JSON representation");
  assertEquals(result.data, { message: "Page 2", count: 3 });
  assertEquals(
    result.response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
});

Deno.test("respondPage runs through router validation and negotiates one stripped schema result", async () => {
  let loaded = 0;
  const app = router({ auth: "none" }).register(PageRoute, (c) => {
    loaded++;
    const props = {
      message: `Page ${c.params.id}`,
      count: "3",
      secret: "never serialize",
    };
    return respondPage(c, PageRoute, TestPage, props, {
      headers: { vary: "Accept-Encoding", "x-loader": "ran" },
    });
  });
  const json = await app.fetch(
    new Request("https://example.com/page/2", {
      headers: { accept: "application/json" },
    }),
    {},
  );
  assertEquals(json.status, 200);
  assertEquals(json.headers.get("vary"), "Accept-Encoding, Accept");
  assertEquals(await json.json(), { message: "Page 2", count: 3 });
  const html = await app.fetch(
    new Request("https://example.com/page/2", {
      headers: { accept: "text/html" },
    }),
    {},
  );
  const document = await html.text();
  assert(
    !document.includes("never serialize"),
    "response schema must strip server-only data from HTML",
  );
  assertEquals(bootProps(document), {
    version: 1,
    props: { message: "Page 2", count: 3 },
  });
  const invalid = await app.fetch(
    new Request("https://example.com/page/bad"),
    {},
  );
  assertEquals(invalid.status, 400);
  assertEquals(loaded, 2);
});

Deno.test("respondPage preserves router auth instead of creating a parallel public handler", async () => {
  let loaded = false;
  const app = router({ auth: bearer({ verify: () => null }) }).register(
    PageRoute,
    { roles: ["reader"] },
    (c) => {
      loaded = true;
      return respondPage(c, PageRoute, TestPage, {
        message: "private",
        count: 1,
      });
    },
  );
  const response = await app.fetch(
    new Request("https://example.com/page/1"),
    {},
  );
  assertEquals(response.status, 401);
  assertEquals(loaded, false);
});

Deno.test("respondPage honors Accept specificity, refusal, status and HEAD", async () => {
  const app = router({ auth: "none" }).register(
    PageRoute,
    (c) =>
      respondPage(c, PageRoute, TestPage, { message: "status", count: 2 }, {
        status: 202,
      }),
  );
  const json = await app.fetch(
    new Request("https://example.com/page/1", {
      headers: { accept: "text/html;q=0, */*;q=1" },
    }),
    {},
  );
  assertEquals(json.status, 202);
  assertEquals(await json.json(), { message: "status", count: 2 });
  const refused = await app.fetch(
    new Request("https://example.com/page/1", {
      headers: { accept: "image/png" },
    }),
    {},
  );
  assertEquals(refused.status, 406);
  assertEquals(refused.headers.get("vary"), "Accept");
  const head = await app.fetch(
    new Request("https://example.com/page/1", {
      method: "HEAD",
      headers: { accept: "application/json" },
    }),
    {},
  );
  assertEquals(head.status, 202);
  assertEquals(await head.text(), "");
  assertEquals(
    head.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
});

Deno.test("respondPage validates non-success pages and status-specific schemas exactly once", async () => {
  let transforms = 0;
  const notFound = v.object({ message: v.string(), count: v.number() })
    .transform((value) => {
      transforms++;
      return { ...value, message: `${value.message}!` };
    });
  const definition = defineRoute("GET", "/missing", {
    response: PageSchema,
    responses: { 404: { description: "Missing page", schema: notFound } },
  });
  const app = router({ auth: "none" }).register(
    definition,
    (c) =>
      respondPage(c, definition, TestPage, { message: "Missing", count: 0 }, {
        status: 404,
      }),
  );
  const html = await app.fetch(new Request("https://example.com/missing"), {});
  assertEquals(html.status, 404);
  assertEquals(bootProps(await html.text()), {
    version: 1,
    props: { message: "Missing!", count: 0 },
  });
  const json = await app.fetch(
    new Request("https://example.com/missing", {
      headers: { accept: "application/json" },
    }),
    {},
  );
  assertEquals(json.status, 404);
  assertEquals(await json.json(), { message: "Missing!", count: 0 });
  assertEquals(transforms, 2);
});

Deno.test("an explicit status without its own schema uses response rather than the default entry", async () => {
  const definition = defineRoute("GET", "/status", {
    response: PageSchema,
    responses: {
      202: { description: "Accepted" },
      default: {
        description: "Other",
        schema: v.object({ other: v.string() }),
      },
    },
  });
  const app = router({ auth: "none" }).register(
    definition,
    (c) =>
      respondPage(
        c,
        definition,
        TestPage,
        { message: "accepted", count: "4" },
        { status: 202 },
      ),
  );
  const response = await app.fetch(
    new Request("https://example.com/status", {
      headers: { accept: "application/json" },
    }),
    {},
  );
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { message: "accepted", count: 4 });
});

Deno.test("invalid response props remain opaque router errors for HTML and JSON", async () => {
  const app = router({ auth: "none", requestId: () => "RID" }).register(
    PageRoute,
    (c) =>
      respondPage(c, PageRoute, TestPage, {
        message: "secret",
        count: "not a number",
      }),
  );
  for (const accept of ["text/html", "application/json"]) {
    const response = await app.fetch(
      new Request("https://example.com/page/1", { headers: { accept } }),
      {},
    );
    assertEquals(response.status, 500);
    const json = await response.json() as Record<string, unknown>;
    assertEquals(json.message, "internal error");
    assert(
      !JSON.stringify(json).includes("secret"),
      "validation errors must not disclose page props",
    );
  }
});

Deno.test("bodyless statuses do not construct illegal HTML or JSON response bodies", async () => {
  for (const status of [204, 205, 304]) {
    const response = renderPage(TestPage, { message: "omitted", count: 1 }, {
      status,
    });
    assertEquals(response.status, status);
    assertEquals(await response.text(), "");
    assertEquals(response.headers.get("content-type"), null);
    const app = router({ auth: "none" }).register(
      PageRoute,
      (c) =>
        respondPage(c, PageRoute, TestPage, { message: "omitted", count: 1 }, {
          status,
        }),
    );
    const negotiated = await app.fetch(
      new Request("https://example.com/page/1", {
        headers: { accept: "application/json" },
      }),
      {},
    );
    assertEquals(negotiated.status, status);
    assertEquals(await negotiated.text(), "");
    assertEquals(negotiated.headers.get("content-type"), null);
  }
});

/** Compile-time contracts: never called; the unit's type check must reject these inputs. */
export function serverTypeContracts(): void {
  // @ts-expect-error a compiled component's required props cannot be omitted
  renderPage(TestPage, { message: "missing count" });
  // @ts-expect-error a compiled component's numeric prop is not a wire coercion input
  renderPage(TestPage, { message: "wrong type", count: "3" });
  respondPage(
    { accepts: () => "text/html", method: "GET" },
    PageRoute,
    TestPage,
    // @ts-expect-error the route schema input requires message
    { count: 1 },
  );
  const incompatible = defineRoute("GET", "/incompatible", {
    response: v.object({ other: v.string() }),
  });
  respondPage(
    { accepts: () => "text/html", method: "GET" },
    incompatible,
    // @ts-expect-error schema output must supply the component's required props
    TestPage,
    { other: "value" },
  );
}
