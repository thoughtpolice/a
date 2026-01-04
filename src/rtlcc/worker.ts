// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Web Worker for running WASM-based FPGA toolchain operations off the main thread
 */

/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import * as macabre from "./lib.ts";
import type { Tree } from "./util.ts";

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  try {
    if (type === "preload") {
      await macabre.preloadAllToolchains();
      self.postMessage({ type: "preload-complete" });
    } else if (type === "synthesize") {
      const result = await macabre.latticeEcpFlow.synthesize(
        data.inputTree as Tree,
        data.opts,
      );
      self.postMessage({ type: "synthesize-complete", result });
    } else if (type === "pnr") {
      const [tree, report] = await macabre.latticeEcpFlow.pnr(
        data.inputTree as Tree,
        data.opts,
      );
      self.postMessage({ type: "pnr-complete", tree, report });
    } else if (type === "pack") {
      const result = await macabre.latticeEcpFlow.pack(
        data.inputTree as Tree,
        data.opts,
      );
      self.postMessage({ type: "pack-complete", result });
    } else if (type === "yosys") {
      const result = await macabre.yosys(
        data.inputTree as Tree,
        data.args,
      );
      self.postMessage({ type: "yosys-complete", result });
    } else if (type === "llvm") {
      const result = await macabre.llvm(
        data.command,
        data.inputTree as Tree,
        data.args,
      );
      self.postMessage({ type: "llvm-complete", result });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
