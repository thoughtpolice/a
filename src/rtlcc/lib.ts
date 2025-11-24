// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { runYowaspCommand, Tree } from "./util.ts";

import { commands as llvmCommands, runLLVM } from "@yowasp/clang";
import { runYosys } from "@yowasp/yosys";
import { runEcppack, runNextpnrEcp5 } from "@yowasp/nextpnr-ecp5";
import { runNextpnrNexus, runPrjoxide } from "@yowasp/nextpnr-nexus";
import { runNextpnrMachxo2 } from "@yowasp/nextpnr-machxo2";
import { runIcepack, runNextpnrIce40 } from "@yowasp/nextpnr-ice40";

// -------------------------------------------------------------------------------------------------

/**
 * Preload all @yowasp/runtime-based toolchain assets. This should be called around startup to
 * properly measure timings.
 */
export async function preloadAllToolchains(): Promise<void> {
  const fetchProgress = (_: any) => {};

  await runLLVM(undefined, undefined, { fetchProgress });
  await runYosys(undefined, undefined, { fetchProgress });

  await runNextpnrEcp5(undefined, undefined, { fetchProgress });
  await runNextpnrIce40(undefined, undefined, { fetchProgress });
  await runNextpnrMachxo2(undefined, undefined, { fetchProgress });
  await runNextpnrNexus(undefined, undefined, { fetchProgress });

  await runEcppack(undefined, undefined, { fetchProgress });
  await runIcepack(undefined, undefined, { fetchProgress });
  await runPrjoxide(undefined, undefined, { fetchProgress });
}

// -------------------------------------------------------------------------------------------------

// https://github.com/YosysHQ/nextpnr/blob/900573c77853209f54f0e23c860327593f5c874a/common/kernel/report.cc#L169

export type Utilization = {
  [key: string]: { used: number; available: number; utilization: number };
};

export type Fmax = {
  [key: string]: { achieved: number; constraint: number };
};

export type CriticalPath = {
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
  criticalPaths: CriticalPath[];
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

export function parseTimingReport(input: string): Report {
  const report = JSON.parse(input);
  return {
    fmax: report.fmax,
    utilization: report.utilization,
    criticalPaths: report.critical_paths,
  };
}

// -------------------------------------------------------------------------------------------------

interface Flow<Synth, PNR, Pack> {
  synthesize(input: Tree, args: Synth): Promise<Tree>;
  pnr(input: Tree, args: PNR): Promise<[Tree, Report]>;
  pack(input: Tree, args: Pack): Promise<Tree>;
}

// -------------------------------------------------------------------------------------------------

type Empty = Record<PropertyKey, never>;

/**
 * Synthesis flow for Lattice ECP5 FPGAs.
 */
export const latticeEcpFlow: Flow<
  // Synthesis options
  {
    /** Arguments to pass to Yosys */
    args: string[];
  },
  // Placement options
  {
    router: "router1" | "router2";
    placer: "heap" | "sa" | "static";
  },
  // Packing options
  Empty
> = {
  synthesize(input, opts) {
    return runYowaspCommand(runYosys, "yosys", input, opts.args, {});
  },

  async pnr(input, opts) {
    const args = [
      "--json",
      "design.synth.json",
      "--lpf",
      "pinout.lpf",
      "--textcfg",
      "out/design.pnr.config",
      "--report",
      "out/design.pnr.report",
      "--85k",
      "--package",
      "CABGA381",
      "--router",
      opts?.router ?? "router1",
      "--placer",
      opts?.placer ?? "heap",
    ];

    const resultTree = await runYowaspCommand(
      runNextpnrEcp5,
      "nextpnr-ecp5",
      input,
      args,
      {},
    );

    return [
      resultTree,
      parseTimingReport(resultTree["design.pnr.report"] as string),
    ];
  },

  pack(input, _) {
    const args = [
      "--idcode",
      "0x41113043",
      "design.pnr.config",
      "out/design.bit",
    ];

    return runYowaspCommand(runEcppack, "ecppack", input, args, {});
  },
};

/**
 * Run Yosys, in any way you want.
 */
export function yosys(input: Tree, args: string[]): Promise<Tree> {
  return runYowaspCommand(runYosys, "yosys", input, args, {});
}

/**
 * Run any LLVM tool, in any way you want.
 */
export function llvm(
  tool: "clang" | "clang++" | "wasm-ld",
  input: Tree,
  args: string[],
): Promise<Tree> {
  return runYowaspCommand(llvmCommands[tool], tool, input, args, {});
}

// -------------------------------------------------------------------------------------------------
