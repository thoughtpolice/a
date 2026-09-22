<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native bootstrap configuration

Buck builds cellar targets from anywhere in the repository. Inside `cellar/`,
its `.buckroot` makes a standalone project with no prelude cell, injected BUILD
symbols, ancestor PACKAGE policies, or external platform rules. From the
parent project, `root//buck/platforms:execution` registers `:execution` after
the repository's own executor. Buck picks the first executor whose constraints
a target accepts, and only cellar's carries `:linux` and `:amd64`. The parent
names cellar in `[platforms] standalone_cells`, so its configuration
constructor applies none of the parent's modifiers, such as build modes, to
cellar's platforms, and every cellar target is configured the same way from
either root. The Buck executable can live anywhere; it is infrastructure, not an input to bootstrap
compiler actions.

```sh
buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/stage1:all
```

Both the target and execution configuration are always native x86_64 Linux.
`:default` supplies cellar's own `:linux` and `:amd64` constraints and also names
the executor registered by `:execution`. This shared identity keeps compiler
execution dependencies in the same configuration as delivered programs.
Executable rules declare both target and execution compatibility; executable
inputs use `attrs.exec_dep` so Buck checks and configures their execution ABI.
The `:aarch64` constraint remains for unsupported source-selection branches and
negative tests; it does not register another execution platform.

Local execution is available only on an x86_64 Linux client. Other clients get
no local platform, and both this project's registration and the parent's use
`fallback = "error"`. No host or
unspecified fallback may execute Linux binaries on Windows, macOS, or ARM Linux.
The `sandbox` mode selects Buck's native Landlock policy, with cellar's own
path lists. Bootstrap actions and tests read only their declared inputs and
`/proc/self`, never the host's `/usr`, `/etc` or `/nix/store`. Writes keep
Buck's default device nodes and add `/dev/ptmx` and `/dev/pts`, so a test can
open a pseudo-terminal.

Tests that run host programs, like the Python audit tests, take the executor
of `:host-tests` instead, which keeps Buck's default read paths. It is never
registered, so it only changes how those tests run, not how anything is
configured. `command_test(host_paths = True)` does the same for the driver
tests that put the host's `/usr/bin` on `PATH` to check that GCC ignores it.

The standalone project uses Buck's built-in `fs_hash_crawler` watcher. It detects source changes
by scanning and hashing the source tree, skipping `buck-out` before descending
into generated directories. This avoids recursive watches and scans of the
large compiler output trees, including source aliases, without an external
watcher service or changes to operating-system watch limits. The parent
project keeps its watchman watcher and ignores `cellar/buck-out`, where
standalone builds write.

## Remote Linux workers

Configure the RE connection using standard Buck `[buck2_re_client]` settings in
`cellar/.buckconfig.local` or an explicit `--config-file`: `engine_address`,
`action_cache_address`, `cas_address`, and the endpoint's TLS/authentication
settings. The repository does not contain an RE endpoint or credentials.
The scheduler must advertise workers with properties `OSFamily=Linux` and
`Arch=x86_64`. Add scheduler-specific properties, such as a worker image, using:

```ini
[bootstrap]
remote_properties = {"container-image":"your-bootstrap-worker"}
remote_use_case = buck2-bootstrap
```

From any supported Buck client OS:

```sh
buck2 build @cellar//bootstrap/platforms/remote cellar//bootstrap/stage1:all
buck2 test @cellar//bootstrap/platforms/remote \
  --unstable-allow-compatible-tests-on-re cellar//bootstrap/stage1/...
```

Remote mode disables local execution completely, including fallbacks, and uses
Unix argument paths even when the client runs Windows. The two mandatory worker
properties select Linux x86_64; additional properties do not change the ABI.
The raw stage0 seed is copied with Buck's explicit executable-bit override,
preserving its bytes while giving Linux workers executable metadata even when
the source file comes from a Windows client.
`buck2 run` still runs its final program on the client, so use `build` or remote
`test` when the client cannot execute Linux ELF binaries.

The configuration is ready for an RE service; a live remote build remains to be
validated after connecting one. Buck's source downloads and orchestration still
run on the client. All bootstrap compiler and generator command actions are
eligible for the selected Linux executor.

## Configuration checks

The following uses Buck's `--fake-host` and `--fake-arch` flags to analyze the
actual stage0 seed graph. It runs no remote actions and requires no RE service:

```sh
buck2 test cellar//bootstrap/platforms:configuration-test
```

The test starts a second Buck daemon for the standalone project, in the
`platform-audit` isolation directory, and finds `buck2` on `PATH`. Run from the
parent project, it repeats every check with a daemon for the parent, and also
checks that the parent's build modes leave cellar's configuration unchanged.
It carries the `nested-buck` label, which the `sandbox` mode file excludes.

It checks native local execution, local rejection on macOS/Windows/ARM Linux,
remote-only Linux execution and Unix paths on every client, unsupported target
rejection, sandbox selection, and custom worker properties. Only the negative
fixtures under `tests/` declare non-native target platforms. It also verifies
the seed's copy action and executable provider; source-byte equality and the
copied file's executable mode are checked after a native seed build.

These rules use built-in `ConfigurationInfo`, `PlatformInfo`,
`ExecutionPlatformInfo`, `ExecutionPlatformRegistrationInfo`, and
`CommandExecutorConfig`. See Buck's [configuration documentation](https://buck2.build/docs/rule_authors/configurations/),
[remote execution documentation](https://buck2.build/docs/users/remote_execution/),
and [Starlark APIs](https://buck2.build/docs/api/).
