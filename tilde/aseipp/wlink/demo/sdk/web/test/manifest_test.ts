// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "../assert.ts";
import { parseManifest } from "../manifest.ts";

const DOOM = {
  name: "doom",
  title: "Doom",
  module: "linked.wasm",
  frames_per_second: 35,
  aspect: "4:3",
  option: "iwad",
  args: ["-warp", "1"],
  mounts: [{ path: "doom2.wad", file: "doom2.wad", size: 19321722 }],
};

Deno.test("a package describes itself completely", () => {
  const manifest = parseManifest(DOOM);
  assertEquals(manifest.name, "doom");
  assertEquals(manifest.framesPerSecond, 35);
  assertEquals(manifest.aspect, "4:3");
  assertEquals(manifest.option, "iwad");
  assertEquals(manifest.args, ["-warp", "1"]);
  assertEquals(manifest.mounts, [{ path: "doom2.wad", file: "doom2.wad", size: 19321722 }]);
});

Deno.test("an application without assets declares none", () => {
  const manifest = parseManifest({ ...DOOM, option: null, mounts: [], args: [] });
  assertEquals(manifest.option, null);
  assertEquals(manifest.mounts, []);
});

Deno.test("a manifest the runner cannot honour is refused", () => {
  const refused: [string, unknown][] = [
    ["expected an object", []],
    ["expected an object", null],
    ["missing name", { ...DOOM, name: undefined }],
    ["name is not a string", { ...DOOM, name: 7 }],
    ["frames_per_second is not a positive integer", { ...DOOM, frames_per_second: 0 }],
    ["frames_per_second is not a positive integer", { ...DOOM, frames_per_second: 1.5 }],
    ["aspect square is not 4:3 or frame", { ...DOOM, aspect: "square" }],
    ["args is not a list", { ...DOOM, args: "one" }],
    ["mounts is not a list", { ...DOOM, mounts: {} }],
    ["mounts[0].size is not a byte count", {
      ...DOOM,
      mounts: [{ path: "a", file: "a", size: -1 }],
    }],
    ["option iwad needs exactly one mount", { ...DOOM, mounts: [] }],
  ];
  for (const [message, value] of refused) {
    assertThrows(() => parseManifest(value), message);
  }
});
