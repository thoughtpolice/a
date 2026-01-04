// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client wrapper for build-worker communication
 */

import type { Tree } from "./util.ts";
import type { Report } from "./lib.ts";

class BuildClient {
  private worker: Worker;

  constructor(workerPath: string) {
    this.worker = new Worker(workerPath, {
      type: "module",
    });
  }

  private sendMessage<T>(type: string, data?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        const response = e.data;

        if (response.type === "error") {
          this.worker.removeEventListener("message", handler);
          reject(new Error(response.error));
        } else if (response.type === `${type}-complete`) {
          this.worker.removeEventListener("message", handler);
          resolve(response as T);
        }
      };

      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ type, data });
    });
  }

  async preloadAllToolchains(): Promise<void> {
    await this.sendMessage("preload");
  }

  async synthesize(
    inputTree: Tree,
    opts: { args: string[] },
  ): Promise<Tree> {
    const result = await this.sendMessage<{ result: Tree }>("synthesize", {
      inputTree,
      opts,
    });
    return result.result;
  }

  async pnr(
    inputTree: Tree,
    opts: { router: string; placer: string },
  ): Promise<[Tree, Report]> {
    const result = await this.sendMessage<{ tree: Tree; report: Report }>(
      "pnr",
      { inputTree, opts },
    );
    return [result.tree, result.report];
  }

  async pack(inputTree: Tree, opts: Record<string, never>): Promise<Tree> {
    const result = await this.sendMessage<{ result: Tree }>("pack", {
      inputTree,
      opts,
    });
    return result.result;
  }

  async yosys(inputTree: Tree, args: string[]): Promise<Tree> {
    const result = await this.sendMessage<{ result: Tree }>("yosys", {
      inputTree,
      args,
    });
    return result.result;
  }

  async llvm(
    command: string,
    inputTree: Tree,
    args: string[],
  ): Promise<Tree> {
    const result = await this.sendMessage<{ result: Tree }>("llvm", {
      command,
      inputTree,
      args,
    });
    return result.result;
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export function createBuildClient(workerPath: string): BuildClient {
  return new BuildClient(workerPath);
}
