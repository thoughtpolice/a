// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

Deno.test("unbundled packages preserve live exports, enums, registration effects and types", async () => {
  const root = await Deno.makeTempDir({ prefix: "js-package-consumer-" });
  try {
    const imports: Record<string, string> = {};
    for (const variable of ["PLAIN", "TOKENS", "TYPED", "DEPENDENT"]) {
      const directory = Deno.env.get(variable)!;
      const metadata = JSON.parse(
        await Deno.readTextFile(directory + "/package.json"),
      );
      for (const [subpath, target] of Object.entries(metadata.exports)) {
        const entry = typeof target === "string"
          ? target
          : (target as { import: string }).import;
        const specifier = metadata.name +
          (subpath === "." ? "" : subpath.slice(1));
        imports[specifier] =
          new URL(entry, pathToFileURL(resolve(directory) + "/")).href;
      }
    }
    imports["@fixture/private"] =
      pathToFileURL(resolve(Deno.env.get("PRIVATE")!)).href;
    const map = root + "/imports.json";
    await Deno.writeTextFile(map, JSON.stringify({ imports }));
    const entry = root + "/consumer.mjs";
    await Deno.writeTextFile(
      entry,
      'import {count,greet,later} from "@fixture/plain";\n' +
        'import {count as shared} from "@fixture/plain/state";\n' +
        'import {Label,events,doubled,lazy,identity} from "@fixture/typed";\n' +
        'import {longValue} from "@fixture/tokens/long";\n' +
        'import {answer} from "@fixture/dependent";\n' +
        'const greetings=[greet("Ada"),greet("Grace")];\n' +
        'console.log(JSON.stringify({greetings,count,shared,dynamic:await later(),typed:await lazy(),doubled:doubled(4),enum:[Label.One,Label.Alias],events,identity:identity({value:"ok"}).value,longValue,answer}));\n',
    );
    const command = async (mode: string, source: string) => {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [mode, "--no-config", "--no-lock", "--import-map", map, source],
        stdout: "piped",
        stderr: "piped",
        env: { NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" },
      }).output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      };
    };
    const result = await command("run", entry);
    if (result.code !== 0) throw new Error(result.stderr);
    const expected = {
      greetings: ["hello, Ada #1", "hello, Grace #2"],
      count: 2,
      shared: 2,
      dynamic: "café:ready",
      typed: "naïve:typed",
      doubled: 8,
      enum: ["one", "one"],
      events: ["registered"],
      identity: "ok",
      longValue: 42,
      answer: 43,
    };
    if (
      JSON.stringify(JSON.parse(result.stdout)) !== JSON.stringify(expected)
    ) throw new Error(result.stdout);
    const typed = root + "/consumer.ts";
    await Deno.writeTextFile(
      typed,
      'import {doubled} from "@fixture/typed"; import type {Options} from "@fixture/typed/math"; const options: Options = {base:"ok",extra:"augmented"}; const value: number = doubled(4); export {value,options};\n',
    );
    const valid = await command("check", typed);
    if (valid.code !== 0) throw new Error(valid.stderr);
    await Deno.writeTextFile(
      typed,
      'import {doubled} from "@fixture/typed"; const value: string = doubled(4); export {value};\n',
    );
    const invalid = await command("check", typed);
    if (invalid.code === 0 || !invalid.stderr.includes("TS2322")) {
      throw new Error(invalid.stderr);
    }
    await Deno.writeTextFile(
      entry,
      'import {fail} from "@fixture/typed"; fail();\n',
    );
    const mapped = await command("run", entry);
    const source = new URL("./typed/index.ts", import.meta.url).href;
    await Deno.writeTextFile(
      entry,
      `import {fail} from ${JSON.stringify(source)}; fail();\n`,
    );
    const authored = await command("run", entry);
    const authoredFrame = authored.stderr.match(/\/typed\/index\.ts:(\d+:\d+)/);
    const mappedFrame = mapped.stderr.match(/\/modules\/index\.ts:(\d+:\d+)/);
    if (
      authored.code === 0 || mapped.code === 0 || !authoredFrame ||
      !mappedFrame || mappedFrame[1] !== authoredFrame[1]
    ) {
      throw new Error(
        `Authored source:\n${authored.stderr}\nPackaged source:\n${mapped.stderr}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
