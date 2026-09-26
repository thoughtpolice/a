// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { withBrowserFixture } from "@celld/box/browser";

// This is a real browser/DOM smoke test over a container-local HTTP page.
// Cross-site cookies, TLS, HSTS and deployed preview ingress need separate tests.
const HTML = `<!doctype html>
<html><head><title>celld browser POC</title></head><body>
<button id="increment" type="button">Increment</button>
<output id="counter">0</output>
<script>
  document.getElementById("increment").addEventListener("click", () => {
    const counter = document.getElementById("counter");
    counter.textContent = String(Number(counter.textContent) + 1);
    document.title = "celld browser clicked";
  });
</script>
</body></html>`;

function options() {
  const endpoint = Deno.env.get("CELLD_BROWSER_ENDPOINT");
  const token = Deno.env.get("CELLD_BROWSER_TOKEN");
  assert(endpoint, "the Buck browser runner must provide its fixture endpoint");
  assert(token, "the Buck browser runner must provide its fixture credential");
  // Room for the sandbox's 60-second wait for Chromium's port, and the test.
  return { endpoint, token, html: HTML, timeoutMs: 120_000 };
}

interface PageState {
  title: string;
  counter: number;
  origin: string;
}

interface Evaluation<T> {
  result: { value?: T };
  exceptionDetails?: unknown;
}

async function assertDestroyed(sessionId: string): Promise<void> {
  const { endpoint, token } = options();
  const response = await fetch(`${endpoint}/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { closed: true, status: "stopped" });
}

Deno.test("runsc browser: remote CDP drives real page JavaScript and DOM", async () => {
  let fixtureId = "";
  await withBrowserFixture(
    options(),
    async ({ cdp, origin, sessionId: id }) => {
      fixtureId = id;
      const version = await cdp.send<{
        product: string;
        protocolVersion: string;
      }>("Browser.getVersion");
      assert(version.product.includes("Chrome"), "expected a Chromium browser");
      assert(version.protocolVersion.length > 0, "CDP must report its version");

      const { targetId } = await cdp.send<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const session = { sessionId };
      await cdp.send("Page.enable", {}, session);
      const navigation = await cdp.send<{ errorText?: string }>(
        "Page.navigate",
        { url: origin },
        session,
      );
      assertEquals(navigation.errorText, undefined);

      // CDP navigation can answer before the new document's execution context
      // exists. Retry only that transition, and await the real DOMContentLoaded.
      let state: PageState | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const ready = await cdp.send<Evaluation<PageState>>(
            "Runtime.evaluate",
            {
              expression: `new Promise((resolve) => {
              const ready = () => resolve({
                title: document.title,
                counter: Number(document.getElementById("counter")?.textContent),
                origin: location.origin
              });
              if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", ready, { once: true });
              } else ready();
            })`,
              awaitPromise: true,
              returnByValue: true,
            },
            session,
          );
          assertEquals(ready.exceptionDetails, undefined);
          state = ready.result.value;
          if (state?.title === "celld browser POC") break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/Execution context was destroyed|Cannot find context with specified id/
              .test(error.message)
          ) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assertEquals(state, {
        title: "celld browser POC",
        counter: 0,
        origin: new URL(origin).origin,
      });

      const clicked = await cdp.send<Evaluation<PageState>>(
        "Runtime.evaluate",
        {
          expression: `document.getElementById("increment").click(); ({
          title: document.title,
          counter: Number(document.getElementById("counter").textContent),
          origin: location.origin
        })`,
          awaitPromise: true,
          returnByValue: true,
        },
        session,
      );
      assertEquals(clicked.exceptionDetails, undefined);
      assertEquals(clicked.result.value, {
        title: "celld browser clicked",
        counter: 1,
        origin: new URL(origin).origin,
      });
      const screenshot = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        session,
      );
      assert(
        screenshot.data.startsWith("iVBORw0KGgo"),
        "expected a rendered PNG screenshot",
      );
    },
  );
  await assertDestroyed(fixtureId);
});

Deno.test("runsc browser: callback failure closes the fixture CDP connection", async () => {
  const failure = new Error("intentional browser fixture callback failure");
  let afterClose: (() => Promise<unknown>) | undefined;
  let caught: unknown;
  let fixtureId = "";
  try {
    await withBrowserFixture(options(), async ({ cdp, sessionId }) => {
      fixtureId = sessionId;
      await cdp.send("Browser.getVersion");
      afterClose = () => cdp.send("Browser.getVersion");
      throw failure;
    });
  } catch (error) {
    caught = error;
  }
  assert(caught === failure, "the fixture must preserve the callback failure");
  assert(afterClose, "the fixture must reach its browser callback");
  let rejected = false;
  try {
    await afterClose();
  } catch {
    rejected = true;
  }
  assert(rejected, "the fixture must not retain a usable CDP connection");
  await assertDestroyed(fixtureId);
});
