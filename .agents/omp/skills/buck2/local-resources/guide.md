<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Buck2 local resources

Use a local resource when a test needs a separate service process: a database,
HTTP server, message queue, or Unix socket server. Prefer ordinary unit tests or
in-memory alternatives when no process is needed; SQLite alone does not require
a dummy background process.

Build three pieces: a setup broker, a rule providing `LocalResourceInfo`, and a
test providing `ExternalRunnerTestInfo`. Buck's test runner starts the broker,
reads connection details, supplies environment variables, and terminates the
reported process after use.

## Write the broker

1. Identify the service command, connection details, readiness signal, and startup
   deadline. Declare service binaries through Buck dependencies when possible;
   using a broker does not make undeclared host tools hermetic.
2. Create isolated files under `${TMPDIR:-/tmp}` with `mktemp -d`. Use a unique
   Unix socket or bind to loopback port `0`, then obtain the assigned endpoint
   from the service's readiness output or API. Do not use fixed ports or reserve
   a port and release it before the service binds.
3. Start the service in the background and capture `$!`. Disconnect its stdin;
   send stdout/stderr to a diagnostic log or stderr, never protocol stdout.
4. Wait for actual readiness with a bounded deadline. Check startup failures and
   fail if readiness never arrives. Process existence alone is not readiness;
   a health request or a readiness pipe after binding is stronger evidence.
5. Emit one JSON object to stdout only after readiness. Use a JSON encoder rather
   than interpolating unescaped paths or credentials into JSON.

```json
{"pid": 12345, "resources": [{"url": "http://127.0.0.1:45678", "port": "45678"}]}
```

`pid` identifies the live service process to terminate. `resources` is an array
of resource records; keys such as `url`, `port`, `socket_path`, or `db_path` become
available through explicit environment mappings. A broker serving one instance
can return one record, as above.

Before the JSON handoff, kill and reap the child and remove private files on any
failure, including an output failure. After a successful handoff, let Buck own
the reported PID. Plan temporary-file cleanup separately: terminating a process
does not itself remove directories, sockets, or database files.

For Bash brokers, use `set -euo pipefail`, quote paths, and explicitly check the
readiness loop's result; reaching the loop limit is not success.

## Define the broker and test rules

Use the repository's `rule`, `DefaultInfo`, `RunInfo`, `LocalResourceInfo`,
`ExternalRunnerTestInfo`, and `RequiredTestLocalResource` providers. For example,
put this in the test package's `defs.bzl`:

```starlark
_broker = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(ctx.attrs.script[DefaultInfo].default_outputs[0])),
        LocalResourceInfo(
            setup = cmd_args(ctx.attrs.script[DefaultInfo].default_outputs[0]),
            resource_env_vars = {
                "HTTP_URL": "url",
                "HTTP_PORT": "port",
            },
        ),
    ],
    attrs = {"script": attrs.exec_dep()},
)

_test = rule(
    impl = lambda ctx: [
        DefaultInfo(),
        RunInfo(args = cmd_args(["/usr/bin/env", "bash", ctx.attrs.script])),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd_args(["/usr/bin/env", "bash", ctx.attrs.script])],
            local_resources = {"http": ctx.attrs.broker.label},
            required_local_resources = [
                RequiredTestLocalResource("http", listing = False, execution = True),
            ],
        ),
    ],
    attrs = {
        "script": attrs.source(),
        "broker": attrs.exec_dep(providers = [LocalResourceInfo]),
    },
)

resources = struct(broker = _broker, test = _test)
```

- `setup` is the broker command. An executable broker script can be exported as a
  file; a compiled broker can use its `RunInfo` command instead.
- `resource_env_vars` maps **environment variable name → JSON key**. Here,
  `resources[0].url` supplies `$HTTP_URL`; JSON keys are not automatically env names.
- `local_resources` maps a resource name to a broker target label. Match that name
  exactly in `RequiredTestLocalResource`.
- `listing = False` means discovery/listing does not need the resource;
  `execution = True` requests it for test execution. Enable listing only if the
  test's discovery step also requires the service.
- Add another broker attribute, `local_resources` entry, and matching requirement
  for each additional service. Avoid conflicting environment names across brokers.
- `RunInfo` permits manual invocation; it does not replace test-runner resource
  provisioning. Exercise the integrated path with `buck2 test`.

## Wire the BUILD targets

```starlark
load("@root//buck/shims:shims.bzl", depot = "shims")
load(":defs.bzl", "resources")

depot.export_file(
    name = "http-broker-script",
    src = "http-broker.sh",
)

resources.broker(
    name = "http-resource",
    script = ":http-broker-script",
)

resources.test(
    name = "http-test",
    script = "http-test.sh",
    broker = ":http-resource",
)
```

Make the exported broker executable, or explicitly invoke its interpreter in
`setup`. Include the repository's SPDX copyright and Apache-2.0 headers in new
scripts, BUILD files, and Starlark files.

Consume the mapped variables and assert the service's observable behavior in
the test. For the HTTP example, a Bash test can use `curl --fail --silent
--show-error "$HTTP_URL/index.html"` and compare the response with the expected
content. Return a nonzero status on failure.

## Verify and diagnose

1. Run the broker once outside Buck and validate its stdout with `jq .`. Record
   its PID and resource values; do not start extra instances just to inspect JSON.
2. Set the mapped environment variables manually and run the test. Terminate only
   the PID started by this smoke run, then remove its private files.
3. Run `buck2 test depot//path/to/package:http-test`; use
   `buck2 test depot//path/to/package:http-test -v 2` for diagnostics. Follow the
   [test workflow](../test-workflow/guide.md) for repository-wide verification.

| Failure | Check |
| --- | --- |
| Invalid broker JSON | Extra stdout, escaping, and missing `pid`/`resources`; keep service logs separate. |
| Missing environment variable | JSON key, `resource_env_vars` direction, and use of the test runner. |
| Resource unavailable | Matching resource names and a broker dependency providing `LocalResourceInfo`. |
| Startup timeout or hang | Readiness protocol, child failure logs, bounded probes, and inherited pipes keeping stdout open. |
| Port or socket conflict | Unique paths and service-assigned ports; terminate only identified leaked PIDs, not broad `pkill -f` matches. |

## Repository examples

- `src/chaos3/resource/main.go`: ephemeral loopback port, readiness pipe, JSON
  encoding, and failure cleanup before handing a child to Buck.
- `buck/third-party/by-name/qe/qemu-static/defs.bzl` and `run-swtpm`: the broker
  provider, socket environment mapping, and test dependency wiring. Inspect its
  lifecycle before copying; add isolation and readiness checks where needed.
- `docs/buck2.md`: background documentation for local resources. Prefer current
  code when older examples or paths disagree.

Use [build troubleshooting](../build-troubleshoot/guide.md) for build failures
and [query guidance](../query-helper/guide.md) for resource dependency queries.
