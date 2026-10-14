<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# barf

barf runs HTTP scenario scripts: a sequence of requests, each followed by the
status and checks its response must satisfy. It is a small, static Go program
built from source with no host library requirements. It replaces the upstream
Hurl binaries, which needed the host's `libcurl.so.4` and `libxml2.so.2`.

```console
buck2 run root//buck/tools/barf:barf -- --var endpoint=http://127.0.0.1:9000 script.barf
buck2 test root//buck/tools/barf/...
```

## Scripts

```text
# Comments start with '#'. Indentation is only for readers.
PUT /{bucket}/cas
  header If-None-Match: *
  body original
expect 200
  capture original = header ETag

GET /{bucket}?list-type=2
  query prefix: special/
  sign
expect 200
  xml KeyCount = 1
  xml Contents/Key = cas
```

Each step starts with a request line, `METHOD TARGET`. A target starting with
`/` is appended to the `endpoint` variable; otherwise it must be an absolute
`http` or `https` URL. It is sent as written, so percent-encode reserved
characters yourself. Lines after it, until `expect STATUS`, describe the
request; lines after `expect` check the response. Every value runs to the end
of its line, with surrounding whitespace removed, and `{name}` refers to a
variable. A brace not followed by a valid name and `}` is literal text.

| Request line | Meaning |
| --- | --- |
| `header NAME: VALUE` | Add a request header. `Host` sets the request's host. |
| `query NAME: VALUE` | Append a query parameter, percent-encoding both parts (a space is `%20`). |
| `body TEXT` | Send `TEXT` as the body. |
| `body-file PATH` | Send a file's bytes. Relative paths are under `--file-root`. |
| `body-hex HEX` | Send the bytes the hex digits spell. |
| `sign [NAME=VALUE...]` | Sign with AWS SigV4 for `s3`, after all headers are set. |

`sign` uses the `access_key_id`, `secret_access_key`, and `region` variables,
each of which can be overridden for one request, as in
`sign secret_access_key=wrong`. It signs every request header with a hash of
the actual payload.

| Response line | Passes when |
| --- | --- |
| `expect STATUS` | The status code is `STATUS`. Required for every request. |
| `header NAME: VALUE` | Some `NAME` header has exactly this value. |
| `header NAME != VALUE` | `NAME` is present and no value equals `VALUE`. |
| `header NAME present` / `absent` | Whether any `NAME` header exists. |
| `xml PATH = VALUE` / `!= VALUE` | The first element `PATH` selects exists and its text is (not) `VALUE`. |
| `xml PATH count N` | `PATH` selects exactly `N` elements. |
| `xml PATH present` / `absent` | Whether `PATH` selects any element. |
| `xml PATH nonempty` | The first selected element exists and has text. |
| `body TEXT` | The body is exactly `TEXT`. |
| `body-file PATH` / `body-hex HEX` | The body is exactly those bytes. |
| `body-size N` | The body has `N` bytes. |
| `body-sha256 HEX` | The body's SHA-256 digest is `HEX`. |
| `capture NAME = header HEADER` | Set variable `NAME` to the first `HEADER` value. |
| `capture NAME = xml PATH` | Set variable `NAME` to the first selected element's text. |

XML paths match elements by local name, ignoring namespaces. The first segment
matches at any depth, or only the root element after a leading `/`, as in
`/ListBucketResult/Prefix`; later segments match children. A segment's 1-based
index keeps one of its matches in document order: `Bucket[2]/Name` is the
`Name` of the second `Bucket`. An element's text includes all text inside it.

Captures run before checks, so a check can use a capture from its own
response. Hex digits are literal; other values may use variables. Multiple
checks of the same response are all reported. barf stops a script at the first
failing request, and reports each failed line, then the full response, with the
body truncated to 4 KiB.

## Command line

```text
barf [--var NAME=VALUE]... [--file-root DIR] [--connect-timeout D] [--timeout D] [-v] SCRIPT...
```

Variables also come from `BARF_VAR_NAME` environment variables; `--var` takes
precedence. `--file-root` defaults to each script's directory.
`--connect-timeout` (default 5s) bounds each connection, and `--timeout`
(default 30s) bounds each whole request, including its response body. Both
accept Go durations such as `1200ms`. barf never retries, never follows
redirects, and never requests compression. It reuses connections and honors
the standard proxy environment variables, which never apply to loopback
addresses. It exits with 0 when every script passes, 1 when a request or check
fails, and 2 for usage errors or scripts it cannot read or parse.

## Buck API

```starlark
load("@root//buck/tools/barf:defs.bzl", "barf")

barf.test(
    name = "objects",
    src = "tests/objects.barf",
    variables = {"bucket": "objects-test"},
    file_root = ":generated-fixtures",
    data = ["tests/extra-input.json"],
    local_resources = {"server": ":test-server"},
)
```

`barf.test` runs one script as one Buck test, using an execution dependency on
`root//buck/tools/barf:barf`. `connect_timeout` and `request_timeout` default
to `"5s"` and `"30s"`; the latter applies **per request**, not per script.
HTTP results depend on live state, so they are never cached.

`variables` become `--var` arguments. `file_root` supplies `--file-root`. It
and any artifact-valued variables are tracked Buck inputs; other files a script
reads belong in `data`. Test commands run from the project root. The rule also
accepts ordinary `env`, `labels`, and `contacts` attributes.

`local_resources` maps names to dependencies that provide Buck's
`LocalResourceInfo`. They are target-configuration dependencies, so a release
build tests a release server, and they are required only for execution, not
listing. To pass a resource's dynamic values to a script, map its fields to
`BARF_VAR_NAME` environment variables; for example, `BARF_VAR_endpoint` makes
`{endpoint}` available and lets targets start with `/`. Use `buck2 test` to get
resource provisioning; `buck2 run` runs the same command but expects the caller
to provide the server and environment.

Keep server lifecycle outside barf. Each scenario must either own a private
fixture or use disjoint names, so tests running in parallel cannot interfere.

`tests:default-arguments` and `tests:custom-arguments` substitute a strict
recording executable to check the rule's flags, environment, argument
boundaries, and generated-file inputs. The `unit` tests run barf against an
in-process server, including every kind of failure, and check SigV4 against
AWS's published example. [chaos3](../../../src/chaos3/README.md) runs the real
scenarios.
