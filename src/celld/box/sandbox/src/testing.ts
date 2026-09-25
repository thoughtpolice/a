// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link localSandbox}: a real {@link SandboxCore} over
 * `@celld/box/container/testing`'s `FakeContainer`, whose exec runs host
 * processes in a temporary directory. Code written against the sandbox API
 * (the coding adapters, a Worker's handlers) can be tested with real files
 * and commands and no container engine.
 *
 * It is not a sandbox: commands run as the test's user on the host. Give
 * it trusted commands only. It never runs the escape sweep (an explicit
 * `sweepEscapes: true` is refused), which reads the whole of /proc and
 * would kill the host's own processes. Tests need `--allow-run`, `--allow-read`,
 * `--allow-write` and `--allow-env`.
 *
 * @module
 */

import {
  ContainerController,
  type ContainerOptions,
} from "@celld/box/container";
import {
  FakeContainer,
  type FakeContainerOptions,
  FakeState,
} from "@celld/box/container/testing";
import { SandboxCore, type SandboxSettings } from "./core.ts";

/** What {@link localSandbox} sets up. */
export interface LocalSandbox {
  readonly sandbox: SandboxCore;
  readonly controller: ContainerController;
  readonly container: FakeContainer;
  readonly state: FakeState;
  /** The temporary directory holding the workspace and the state directory. */
  readonly root: string;
  /** The workspace's absolute host path. */
  readonly workspace: string;
  /** Stops every process and removes the temporary directory. */
  close(): Promise<void>;
}

/** See the module documentation. */
export async function localSandbox(
  options: {
    readonly settings?: Partial<SandboxSettings>;
    readonly container?: ContainerOptions;
    readonly fake?: FakeContainerOptions;
  } = {},
): Promise<LocalSandbox> {
  if (options.settings?.sweepEscapes) {
    throw new Error(
      "localSandbox runs on the host: sweepEscapes would kill host processes",
    );
  }
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "celld-sandbox-" }),
  );
  const workspace = `${root}/workspace`;
  const container = new FakeContainer({ cwd: root, ...options.fake });
  const state = new FakeState(container);
  const controller = new ContainerController(state, options.container ?? {});
  const sandbox = new SandboxCore(controller, state.kv, {
    tier: "trusted",
    workspace,
    stateDir: `${root}/state`,
    user: null,
    setupUser: null,
    baseEnv: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `${root}/state/home`,
      LANG: "C.UTF-8",
    },
    ...options.settings,
    sweepEscapes: false,
  });
  return {
    sandbox,
    controller,
    container,
    state,
    root,
    workspace,
    async close() {
      await container.destroy();
      // Background processes started with setsid are not the fake's children.
      await new Deno.Command("/bin/sh", {
        args: [
          "-c",
          'for p in "$1"/state/proc/*/pid; do [ -e "$p" ] && kill -KILL -- "-$(cat "$p")" 2>/dev/null; done; true',
          "x",
          root,
        ],
      }).output();
      await Deno.remove(root, { recursive: true });
    },
  };
}
