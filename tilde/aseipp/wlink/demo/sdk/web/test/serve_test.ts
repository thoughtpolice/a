// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "../assert.ts";
import { parseOptions, resolve } from "../serve.ts";

Deno.test("a request never leaves the directory it was pointed at", () => {
  assertEquals(resolve("/pkg", "/"), "/pkg/index.html");
  assertEquals(resolve("/pkg", "/index.html"), "/pkg/index.html");
  assertEquals(resolve("/pkg", "/console.js"), "/pkg/console.js");
  assertEquals(resolve("/pkg", "/baseq2/pak0.pak"), "/pkg/baseq2/pak0.pak");
  assertEquals(resolve("/pkg", "/a/./b"), "/pkg/a/b");
  assertEquals(resolve("/pkg", "/a/../b"), "/pkg/b");
  assertEquals(resolve("/pkg", "/%2e%2e/secret"), null);
  assertEquals(resolve("/pkg", "/../secret"), null);
  assertEquals(resolve("/pkg", "/a/../../secret"), null);
  assertEquals(resolve("/pkg", "/a/%00b"), null);
  assertEquals(resolve("/pkg", "/with%20space.txt"), "/pkg/with space.txt");
});

Deno.test("the server takes a directory and where to listen", () => {
  assertEquals(parseOptions(["/pkg"]), { root: "/pkg", port: 8000, hostname: "127.0.0.1" });
  assertEquals(parseOptions(["/pkg", "--port", "9000", "--host", "0.0.0.0"]), {
    root: "/pkg",
    port: 9000,
    hostname: "0.0.0.0",
  });
  assertThrows(() => parseOptions([]), "usage: serve DIR");
  assertThrows(() => parseOptions(["/pkg", "/other"]), "unexpected argument");
  assertThrows(() => parseOptions(["/pkg", "--port", "no"]), "invalid --port");
  assertThrows(() => parseOptions(["/pkg", "--port", "70000"]), "invalid --port");
});
