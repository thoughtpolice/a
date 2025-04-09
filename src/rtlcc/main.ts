// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { walk } from "jsr:@std/fs/walk";

import { Tree } from "npm:@yowasp/runtime@9.0.56";
import { runYosys } from "npm:@yowasp/yosys@0.52.893";
import { runEcppack, runNextpnrEcp5 } from "npm:@yowasp/nextpnr-ecp5@0.8.620";

import {
  Command,
  EnumType,
  HelpCommand,
} from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts";

// -------------------------------------------------------------------------------------------------

export async function walkDirectoryForTree(path: string): Promise<Tree> {
  const files: Tree = {};
  const dirpath = path + (path.endsWith("/") ? "" : "/");

  // first, walk all the normal files and add them to the tree
  for await (const entry of walk(path, { maxDepth: 1 })) {
    if (entry.path === path) {
      continue;
    }

    const relpath = entry.path.slice(dirpath.length);

    if (entry.isDirectory) {
      files[relpath] = await walkDirectoryForTree(entry.path);
    } else {
      files[relpath] = await Deno.readFile(entry.path);
    }
  }

  return files;
}

export function yowaspPrintLine(line: string) {
  if (Deno.env.get("YOWASP_VERBOSE") === "1") {
    console.log(line);
  }
}

export const barf = (d: unknown, colors = true) =>
  console.log(
    Deno.inspect(d, {
      breakLength: 140,
      colors: colors,
      depth: Infinity,
      strAbbreviateSize: Infinity,
    }),
  );

// -------------------------------------------------------------------------------------------------

const verbose = Deno.env.get("YOWASP_VERBOSE") === "1";
const outputStreams = {
  stdout: (data: Uint8Array | null) => {
    if (verbose && data !== null) {
      Deno.stdout.writeSync(data);
    }
  },
  stderr: (data: Uint8Array | null) => {
    if (verbose && data !== null) {
      Deno.stderr.writeSync(data);
    }
  },
};

// -------------------------------------------------------------------------------------------------

export async function synthesis(
  inputTree: Tree,
): Promise<Tree> {
  const result = await runYosys(
    [
      "synth.ys",
    ],
    inputTree,
    outputStreams,
  );

  if (result == undefined) {
    throw new Error("Yosys failed to generate a result");
  }

  return result;
}

// -------------------------------------------------------------------------------------------------

export type Fmax = {
  [key: string]: { achieved: number; constraint: number };
};

export type Utilization = {
  [key: string]: { used: number; available: number; utilization: number };
};

export type CritPath = {
  from: string;
  to: string;
  path: {
    delay: number;
    type: string;
    net: string | undefined;
    from: {
      cell: string;
      port: string;
      loc: number[];
    };
    to: {
      cell: string;
      port: string;
      loc: number[];
    };
  }[];
};

export type Report = {
  fmax: Fmax;
  utilization: Utilization;
  criticalPaths: CritPath[];
};

export function parseTimingReport(input: string): Report {
  const report = JSON.parse(input);
  return {
    fmax: report.fmax,
    utilization: report.utilization,
    criticalPaths: report.critical_paths,
  };
}

// pnr options. router can be router1 or router2. placer can be heap or sa or static
type PnrOptions = {
  router: "router1" | "router2";
  placer: "heap" | "sa" | "static";
};

export function cleanReportUtilization(
  report: Utilization,
): Utilization {
  const util: Utilization = {};
  for (const [k, v] of Object.entries(report)) {
    if (v.used > 0) {
      v.utilization = Math.round((v.used / v.available) * 10000) / 100;
      util[k] = v;
    }
  }
  return util;
}

export async function placeAndRoute(
  inputTree: Tree,
  opts?: PnrOptions,
): Promise<[Tree, Report]> {
  const router = opts?.router ?? "router1";
  const placer = opts?.placer ?? "heap";
  const tree = await runNextpnrEcp5(
    [
      "--json",
      "design.synth.json",
      "--lpf",
      "pinout.lpf",
      "--textcfg",
      "design.pnr.config",
      "--report",
      "design.report.json",
      "--85k",
      "--package",
      "CABGA381",
      "--router",
      router,
      "--placer",
      placer,
    ],
    inputTree,
    outputStreams,
  );

  // bail if tree is undefined
  if (tree === undefined) {
    throw new Error("Place and route failed, tree is undefined");
  }

  return [tree, parseTimingReport(tree["design.report.json"] as string)];
}

// -------------------------------------------------------------------------------------------------

export async function packBitstream(inputTree: Tree): Promise<Uint8Array> {
  const tree = await runEcppack(
    [
      "--idcode",
      "0x41113043",
      "design.pnr.config",
      "output.bit",
    ],
    inputTree,
    outputStreams,
  );

  // bail if tree is undefined
  if (tree === undefined) {
    throw new Error("Pack bitstream failed, tree is undefined");
  }

  return (tree["output.bit"] as Uint8Array);
}

// -------------------------------------------------------------------------------------------------

export const LogLevelType = new EnumType(["debug", "info", "warn", "error"]);

// -------------------------------------------------------------------------------------------------

const yosys = new Command()
  .arguments("<synth-script:string> <rtl-directory:string>")
  .description("Run a yosys script on a directory of RTL files.")
  .option("--no-color", "Disable color output.")
  .action(async (_options, script, rtlDir) => {
    const inputTree = await walkDirectoryForTree(rtlDir);
    inputTree["synth.ys"] = await Deno.readFile(script);
    const tree = await synthesis(inputTree);
    const json = JSON.parse(tree["design.synth.json"] as string);
    barf(json, _options.color);
  });

async function main() {
  await new Command()
    .name("macabre")
    .version("0.1.0")
    .description("Portable, determistic, push-button FPGA tooling")
    .type("log-level", LogLevelType)
    .env("DEBUG=<enable:boolean>", "Enable debug output.")
    .option("-d, --debug", "Enable debug output.")
    .option("-l, --log-level <level:log-level>", "Set log level.", {
      default: "info" as const,
    })
    .arguments("<dir:file> [out:file]")
    .action(async (_options, ..._args) => {
      const dir = _args[0];
      const bitstreamOutfile = _args[1] ?? "out.bit";
      const inputTree = await walkDirectoryForTree(dir);

      console.time("synthesis time");
      const synthTree = await synthesis(inputTree);
      console.timeEnd("synthesis time");

      console.time("place and route time");
      const [pnrTree, report] = await placeAndRoute(synthTree, {
        placer: "static",
        router: "router1",
      });
      console.timeEnd("place and route time");

      console.log("fMAX: ", report.fmax);
      // when showing utilization, don't show items that have 0 uses
      // as that's just noise
      console.log(
        "utilization: ",
        cleanReportUtilization(report.utilization),
      );

      console.time("writing bitstream");
      const bitstream = await packBitstream(pnrTree);
      await Deno.writeFile(
        bitstreamOutfile,
        bitstream,
      );
      console.timeEnd("writing bitstream");
    })
    .command("help", new HelpCommand().global())
    .command("yosys", yosys)
    .parse(Deno.args);
}

await main();
