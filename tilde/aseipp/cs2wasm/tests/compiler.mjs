// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The Native AOT deliverable is a single executable: copy it into `directory`
// on its own and run it where no SDK, Roslyn libraries or reference
// assemblies are reachable, and no external tool can be found through PATH.
import fs from "node:fs";
import path from "node:path";

export function isolateCompiler(nativeCompiler, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(
    directory,
    process.platform === "win32" ? "gameplayc.exe" : "gameplayc",
  );
  fs.copyFileSync(path.resolve(nativeCompiler), executable);
  fs.chmodSync(executable, 0o755);
  const noSdk = path.join(directory, "no-sdk");
  return {
    executable,
    environment: {
      ...process.env,
      PATH: "",
      DOTNET_ROOT: noSdk,
      DOTNET_ROOT_X64: noSdk,
      DOTNET_ROOT_ARM64: noSdk,
      DOTNET_MULTILEVEL_LOOKUP: "0",
    },
  };
}
