<!-- SPDX-FileCopyrightText: 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native bootstrap configuration

Buck builds cellar targets from anywhere in the repository. Inside `cellar/`,
its `.buckroot` makes a standalone project with no prelude cell, injected BUILD
symbols, ancestor PACKAGE policies, or external platform rules. From the parent
project, `root//buck/platforms:execution` registers `:execution` after the
repository's own executor. Buck picks the first executor whose constraints a
target accepts, and only cellar's carries `:linux` and `:amd64`. The parent
names cellar in `[platforms] standalone_cells`, so its configuration
constructor applies none of the parent's modifiers, such as build modes, to
cellar's platforms, and Buck configures every cellar target the same way from
either root. The Buck executable can live anywhere. It is infrastructure, not
an input to bootstrap compiler actions.

```sh
buck2 build @cellar//bootstrap/platforms/sandbox cellar//bootstrap/...
```

Both the target and execution configuration are always native x86_64 Linux.
`:default` supplies cellar's own `:linux` and `:amd64` constraints and also
names the executor that `:execution` registers. This shared identity keeps
compiler execution dependencies in the same configuration as delivered
programs. Executable rules declare both target and execution compatibility;
executable inputs use `attrs.exec_dep` so Buck checks and configures their
execution ABI. The `:aarch64` constraint remains for unsupported
source-selection branches and negative tests; it does not register another
execution platform.

Local execution is available only on an x86_64 Linux client. Other clients get
no local platform, and both this project's registration and the parent's use
`fallback = "error"`. No host or unspecified fallback may execute Linux
binaries on Windows, macOS, or ARM Linux. The `sandbox` mode selects Buck's
native Landlock policy, with cellar's own path lists. Bootstrap actions and
tests read only their declared inputs and `/proc/self`, never the host's
`/usr`, `/etc` or `/nix/store`. Writes keep Buck's default device nodes and add
`/dev/ptmx` and `/dev/pts`, so a test can open a pseudo-terminal.

`:configuration-test` runs the host's `python3` and `buck2`, so it takes the
executor of `:host-tests`, which keeps Buck's default read paths. `:host-tests`
is never registered, so it only changes how that test runs, not how anything is
configured.

The standalone project uses Buck's built-in `fs_hash_crawler` watcher. It
detects source changes by scanning and hashing the source tree, skipping
`buck-out` before descending into generated directories. This avoids recursive
watches and scans of the large compiler output trees, including source aliases,
without an external watcher service or changes to operating-system watch
limits. The parent project keeps its watchman watcher and ignores
`cellar/buck-out`, where standalone builds write.

Cellar rules declare every output with `has_content_based_path = False`. The
parent project enables content-based output paths, under which an action writes
each output to a placeholder path and Buck then copies it to its content-hashed
path, keeping both. That deduplicates actions shared across configurations, but
cellar builds everything in one configuration, so it would only store every
output twice.

## Remote Linux workers

From the parent project, `@mode//buildbuddy` builds on BuildBuddy, whose endpoint
the parent's common configuration names. Buck reads the API key from
`BUILDBUDDY_API_KEY` in the environment its daemon starts in; the repository
holds no credentials. The mode makes cellar's executor remote-only and runs
every action in the distroless `static` image, pinned by digest, which holds no
shell and no tools. Bootstrap actions read only their inputs, as the local
sandbox already enforces, so an image with nothing to lean on keeps remote
builds as hermetic as local ones.

```sh
buck2 build @mode//buildbuddy cellar//bootstrap/...
buck2 test @mode//buildbuddy --unstable-allow-compatible-tests-on-re \
  cellar//bootstrap/...
```

The standalone project names no endpoint. Configure the RE connection with
standard Buck `[buck2_re_client]` settings in `cellar/.buckconfig.local` or an
explicit `--config-file`: `engine_address`, `action_cache_address`,
`cas_address`, and the endpoint's TLS and authentication settings. The
scheduler must advertise workers with the properties `OSFamily=Linux` and
`Arch=amd64`, the Go and OCI spelling that BuildBuddy's executors register. Add
scheduler-specific properties, such as a worker image, using:

```ini
[bootstrap]
remote_properties = {"container-image":"your-bootstrap-worker"}
remote_use_case = buck2-bootstrap
```

Then, from any supported Buck client OS:

```sh
buck2 build @cellar//bootstrap/platforms/remote cellar//bootstrap/...
buck2 test @cellar//bootstrap/platforms/remote \
  --unstable-allow-compatible-tests-on-re cellar//bootstrap/...
```

Remote mode disables local execution completely, including fallbacks, and uses
Unix argument paths even when the client runs Windows. The two mandatory worker
properties select Linux x86_64; additional properties do not change the ABI.
Buck copies the raw stage0 seed with its explicit executable-bit override,
which keeps the seed's bytes and gives Linux workers executable metadata even
when the source file comes from a Windows client. `buck2 run` still runs its
final program on the client, so use `build` or remote `test` when the client
cannot execute Linux ELF binaries. Buck's source downloads and orchestration
also stay on the client.

## Configuration checks

The configuration test uses Buck's `--fake-host` and `--fake-arch` flags to
analyze the stage0 seed graph as each client would. It runs no actions and
needs no RE service:

```sh
buck2 test cellar//bootstrap/platforms:configuration-test
```

The test starts a second Buck daemon for the standalone project, in the
`platform-audit` isolation directory, and finds `buck2` on `PATH`. Run from the
parent project, it repeats every check with a daemon for the parent, and also
checks that the parent's build modes leave cellar's configuration unchanged. It
carries the `nested-buck` label. The `sandbox` mode excludes that label, since
the native sandbox cannot host a second daemon, and cellar's and the parent's
`remote` modes exclude it, since a remote worker has no `python3`, `buck2` or
checkout. Naming the target still runs it.

It checks native local execution, local rejection on macOS, Windows and ARM
Linux, remote-only Linux execution and Unix paths on every client, unsupported
target rejection, the sandbox's read paths and devices, the host test executor,
and custom worker properties. Only the negative fixtures under `tests/` declare
non-native target platforms. It also checks that a Windows client copies the
seed into a generated artifact with an executable command, and that test
commands, such as stage0's answer test, run from the project root with
project-relative paths. A native build then runs that copy, and stage0's
answers check everything it builds.

These rules use built-in `ConfigurationInfo`, `PlatformInfo`,
`ExecutionPlatformInfo`, `ExecutionPlatformRegistrationInfo`, and
`CommandExecutorConfig`. See Buck's
[configuration documentation][configurations],
[remote execution documentation][remote-execution] and [Starlark APIs][api].

[configurations]: https://buck2.build/docs/rule_authors/configurations/
[remote-execution]: https://buck2.build/docs/users/remote_execution/
[api]: https://buck2.build/docs/api/
