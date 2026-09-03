// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The headless runner against real linked packages.
 *
 * Buck hands the modules and the IWAD through the environment, so the test is
 * skipped when it is run by hand outside the build graph.
 */

import { assert, assertEquals } from "../assert.ts";
import { Io, main } from "../headless.ts";

const GAME = Deno.env.get("CONSOLE_WEB_GAME_WASM");
const CONTRACT = Deno.env.get("CONSOLE_WEB_CONTRACT_WASM");
const IWAD = Deno.env.get("CONSOLE_WEB_IWAD");

/** The input the contract checks for: a key, the pointer, and typed text. */
const CONTRACT_SCRIPT = "0 a down\n0 a up\n0 pause down\n0 pause up\n" +
  "0 page-up down\n0 page-up up\n0 mouse 5 6 1 0\n0 text hi\u2603\n";

class Output implements Io {
  out = "";
  err = "";

  stdout(text: string): void {
    this.out += text;
  }

  stderr(text: string): void {
    this.err += text;
  }
}

function script(text: string): string {
  const path = Deno.makeTempFileSync({
    prefix: "console-script-",
    suffix: ".txt",
  });
  Deno.writeTextFileSync(path, text);
  return path;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function summary(output: string): Record<string, string> {
  const line = output.split("\n").find((candidate) =>
    candidate.startsWith("summary ")
  );
  assert(line !== undefined, `no summary in ${output.slice(-2000)}`);
  return Object.fromEntries(
    line.slice("summary ".length).split(" ").map((field) => {
      const at = field.indexOf("=");
      return [field.slice(0, at), field.slice(at + 1)];
    }),
  );
}

Deno.test({
  name: "the rectangle demo runs to its own end",
  ignore: GAME === undefined,
  fn: async () => {
    const path = script("1 right down\n3 right up\n3 enter down\n");
    const io = new Output();
    const code = await main([
      "--module",
      GAME as string,
      "--headless",
      "--frames",
      "10",
      "--script",
      path,
    ], io);
    Deno.removeSync(path);
    assertEquals(code, 0);
    assertEquals(io.err, "");
    assert(io.out.includes("log 1: game: init\n"), io.out);
    assert(io.out.includes("log 1: game: frame 1 at (104, 80)\n"), io.out);
    assert(io.out.includes("log 1: game: frame 3 at (108, 80)\n"), io.out);
    const fields = summary(io.out);
    assertEquals(fields.frames, "3");
    assertEquals(fields.presents, "3");
    assertEquals(fields.width, "320");
    assertEquals(fields.height, "240");
    assertEquals(fields.exit, "0");
  },
});

Deno.test({
  name: "every stage of the SDK contract passes",
  ignore: CONTRACT === undefined || IWAD === undefined,
  fn: async () => {
    const path = script(CONTRACT_SCRIPT);
    const capture = Deno.makeTempFileSync({
      prefix: "console-frame-",
      suffix: ".ppm",
    });
    const io = new Output();
    const code = await main([
      "--module",
      CONTRACT as string,
      "--mount",
      `doom2.wad=${IWAD}`,
      "--name",
      "sdk-contract",
      "--frames-per-second",
      "35",
      "--headless",
      "--frames",
      "280",
      "--script",
      path,
      "--seed",
      "42",
      "--unix-time",
      "1234567",
      "--dump-frame",
      capture,
    ], io);
    Deno.removeSync(path);
    assertEquals(code, 0);
    assert(!io.err.includes("guest trapped"), io.err);
    for (
      const stage of [
        "args",
        "allocator",
        "directories",
        "streams",
        "files",
        "large lists",
        "system",
        "display info",
        "audio",
        "input",
        "audio playback",
        "clock",
        "contract",
      ]
    ) {
      assert(
        io.out.includes(`PASS sdk ${stage}`),
        `PASS sdk ${stage} is missing`,
      );
    }
    const fields = summary(io.out);
    assertEquals(fields.played, "44100");
    assertEquals(fields.presents, "1");
    assertEquals(fields.width, "2");
    assertEquals(fields.height, "2");

    const image = Deno.readFileSync(capture);
    Deno.removeSync(capture);
    const expected = new Uint8Array([
      ...new TextEncoder().encode("P6\n2 2\n255\n"),
      255,
      0,
      0,
      0,
      255,
      0,
      0,
      0,
      255,
      255,
      255,
      255,
    ]);
    assertEquals(image, expected);
  },
});

Deno.test({
  name: "a guest that exits or traps says so in its status",
  ignore: CONTRACT === undefined || IWAD === undefined,
  fn: async () => {
    const base = [
      "--module",
      CONTRACT as string,
      "--mount",
      `doom2.wad=${IWAD}`,
      "--name",
      "sdk-contract",
      "--frames-per-second",
      "35",
      "--headless",
      "--frames",
      "1",
      "--",
    ];
    const exited = new Output();
    assertEquals(await main([...base, "--exit-7"], exited), 7);
    assert(!exited.err.includes("guest trapped"), exited.err);
    assertEquals(summary(exited.out).exit, "7");

    const trapped = new Output();
    assertEquals(await main([...base, "--trap"], trapped), 1);
    assert(trapped.err.includes("guest trapped:"), trapped.err);
    assertEquals(summary(trapped.out).exit, "1");
  },
});

Deno.test({
  name: "a save directory outlasts the run",
  ignore: CONTRACT === undefined || IWAD === undefined,
  fn: async () => {
    const save = Deno.makeTempDirSync({ prefix: "console-save-" });
    const path = script(CONTRACT_SCRIPT);
    const options = (extra: string[]) => [
      "--module",
      CONTRACT as string,
      "--mount",
      `doom2.wad=${IWAD}`,
      "--name",
      "sdk-contract",
      "--frames-per-second",
      "35",
      "--headless",
      "--frames",
      "280",
      "--script",
      path,
      "--seed",
      "42",
      "--unix-time",
      "1234567",
      "--save-dir",
      save,
      "--",
      ...extra,
    ];
    const first = new Output();
    assertEquals(
      await main(options(["--persistent"]), first),
      0,
      first.out.slice(-2000),
    );
    assert(!first.err.includes("saves not written"), first.err);
    assert(first.out.includes("PASS sdk contract"), first.out);
    assertEquals(
      Deno.readFileSync(`${save}/contract.tmp`),
      new TextEncoder().encode("aXYZa"),
    );
    assertEquals(
      Deno.readFileSync(`${save}/contract-stream.tmp`),
      new TextEncoder().encode("alXYZ"),
    );
    assertEquals(
      Deno.statSync(`${save}/contract-large.tmp`).size,
      2 * 1024 * 1024 + 17,
    );

    Deno.mkdirSync(`${save}/preexisting`);
    Deno.writeTextFileSync(`${save}/preexisting/hello.txt`, "hi");
    const second = new Output();
    assertEquals(
      await main(options(["--expect-saved", "--persistent"]), second),
      0,
    );
    assert(second.out.includes("PASS sdk saved state"), second.out);
    assert(!second.err.includes("saves not written"), second.err);
    assertEquals(
      exists(`${save}/preexisting`),
      false,
      "the guest removed what it read",
    );

    Deno.removeSync(path);
    Deno.removeSync(save, { recursive: true });
  },
});
