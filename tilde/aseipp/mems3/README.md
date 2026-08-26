<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# mems3

`mems3` is a deliberately ephemeral S3-compatible HTTP server for repository
tests. It is built directly by Buck and stores buckets, objects, metadata, and
multipart-upload state in process memory. Stopping the process discards all of
it.

The implemented surface is the one celld and its `object_store` clients need:
bucket creation and inspection, PUT/GET/HEAD/DELETE, conditional ETag writes,
range reads, metadata, delimiter and paginated listing, batch deletion,
server-side copy, and multipart upload. It uses the `s3s` protocol adapter, so
clients speak normal S3 HTTP rather than a test-only RPC. Content-MD5 and
`x-amz-checksum-*` values are verified, and multipart ETags follow the Amazon S3
"MD5 of the concatenated part digests" formula.

Start a server with one or more pre-created buckets:

```console
$ buck2 run tilde//aseipp/mems3:mems3 -- \
    --listen 127.0.0.1:9000 \
    --bucket orchestra-dev
mems3 listening on http://127.0.0.1:9000
mems3 buckets: orchestra-dev
```

If no `--bucket` is supplied, `celld` is created. `--bucket` may be repeated.
The server accepts anonymous requests and signed requests using the fixed test
credentials `AWS_ACCESS_KEY_ID=mems3` and `AWS_SECRET_ACCESS_KEY=mems3`.
Signatures using other credentials are rejected.

For example, point Orchestra's celld node at it with path-style S3 requests:

```console
$ AWS_ACCESS_KEY_ID=mems3 AWS_SECRET_ACCESS_KEY=mems3 \
  buck2 run tilde//aseipp/orchestra:serve -- \
    --bucket s3://orchestra-dev \
    --endpoint http://127.0.0.1:9000 \
    --region us-east-1 \
    --listen 127.0.0.1:8080
```

This is not a production object store. It has no persistence, access control,
TLS, quotas, request-size limits, versioning, or replication. Keep it bound to
loopback and use it only in tests and local development.

A few behaviours differ from Amazon S3 by design. Requests are routed
path-style only, so point SDKs at an IP endpoint or set path-style addressing
(`forcePathStyle`) rather than virtual-hosted-style host names. Re-creating a
bucket you already own succeeds and keeps its contents, matching `us-east-1`. A
syntactically invalid `Range` header is rejected with `400` by the `s3s` layer
instead of being ignored. Operations celld does not use, including `ListObjects`
v1, `ListParts`, `ListMultipartUploads`, `GetObjectAttributes`, and
`GetBucketLocation`, are not implemented and answer `501 NotImplemented`.

## Tests

Fault injection is described below; the same suite exercises both healthy
servers and servers configured to fail through their ordinary S3 interface.

Run the complete test suite with:

```console
$ buck2 test tilde//aseipp/mems3/...
```

The suite has complementary layers:

- [Hurl scenarios](tests/hurl/) describe the public HTTP contract: bucket and
  object lifecycle, binary bodies and metadata, range boundaries, conditional
  reads and writes, pagination, copy and batch deletion, multipart validation
  and recovery, checksums, signatures, and intentionally unsupported APIs.
  Hurl performs its own HTTP, header, body, and XML assertions; no custom XML
  assertion helpers or hand-written request signing are needed in these cases.
- [FileCheck CLI tests](tests/cli.test) check exact help text, argument errors,
  output streams, and exit codes using the repository's `filecheck.lit` runner.
- The [Rust HTTP-adapter tests](tests/memory_test.rs) drive `s3s::S3Service`
  in process, which suits deterministic concurrent conditional writers,
  injected stream failures, and generated 1,001-object pagination. The
  [fault scenarios](tests/faults_test.rs) also check shared failure budgets,
  service isolation, async pauses/delays, and errors after committed writes.
- The [Python process tests](tests/cli_test.py) start the built binary on a
  real socket and cover startup, bind failure, process-local state, and
  signed requests, including replaying seeded BUGGIFY decisions across processes.
- The [resource helper tests](resource/main_test.go) cover startup deadlines,
  early exits, malformed readiness announcements, JSON handoff, and cleanup
  after failure.

Run just the HTTP contracts or one scenario with:

```console
$ buck2 test tilde//aseipp/mems3:http-tests
$ buck2 test tilde//aseipp/mems3:hurl-multipart
$ buck2 test tilde//aseipp/mems3:cli-output-test
```

Each Hurl target gets its own Buck `LocalResourceInfo` fixture: the real mems3
binary on a fresh ephemeral loopback port, with the scenario's bucket created.
Buck injects the endpoint and credentials and terminates the server after the
test; no manually running mems3 is needed. Buck keys local resource pools by
target label and holds a pool entry for the duration of a test, so one resource
target per scenario keeps whole-bucket listings and mutable state isolated when
tests run in parallel. Requests have timeouts, retries are disabled, and HTTP
test results are not cached.

Buck downloads the checksum-pinned [Hurl tool](../../../buck/tools/hurl/README.md).
Its upstream binaries require host libraries as documented there. Binary fixtures,
including a 5 MiB multipart part, are generated deterministically by
[`tests/fixtures:fixtures`](tests/fixtures/BUILD), not checked into source control.
The tests require no AWS account, external service, or additional Python packages.

## Reusable Buck resource

Other integration tests can use the rules in [`defs.bzl`](defs.bzl).
`mems3_hurl_test` pairs one Hurl scenario with a private server, and
`mems3_local_resource` declares a server for any other kind of test:

```python
load("@tilde//aseipp/mems3:defs.bzl", "mems3_hurl_test", "mems3_local_resource")

mems3_hurl_test(
    name = "http-test",
    src = "http.hurl",
    bucket = "my-test",
)

mems3_local_resource(
    name = "s3-resource",
    buckets = ["my-test"],
)
```

In the Hurl file, use `{{endpoint}}` and `{{bucket}}`; signing credentials are
available as `{{access_key_id}}`, `{{secret_access_key}}`, and `{{region}}`.
Tests that name a `mems3_local_resource` in `local_resources` receive
`MEMS3_ENDPOINT`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, and `MEMS3_LOG`. The last points to a temporary server log
retained after successful setup for diagnosis; failed setup removes its log and
kills and reaps its child. Buck owns teardown after successful handoff. Buck
keys resource pools by target label and holds an entry for the whole test, so
give each test that mutates server state its own resource target.

## Fault injection

Each server owns a [faultline](../../../src/crates/faultline/README.md) injector.
Clones of its backend share plans, limits, and BUGGIFY state. Separate servers
and independently created backends are isolated. Faults are inactive by
default, and initial `--bucket` creation bypasses request instrumentation.

To fail the first two GET operations with S3 `SlowDown` errors, then resume
ordinary handling:

```console
$ buck2 run tilde//aseipp/mems3:mems3 -- \
    --fault-seed 42 \
    --failpoint 's3.get_object.before=2*return(SlowDown)'
```

`--failpoint NAME=PLAN` is repeatable for different names and also accepts
`--failpoint=NAME=PLAN`. Unknown names, duplicate names, invalid plans, and
unknown S3 error payloads are usage errors before the listener starts.
Quote plans in a shell, particularly when they contain parentheses or `->`.
`--list-failpoints` prints every available name and exits without starting a
server:

```console
$ buck2 run tilde//aseipp/mems3:mems3 -- --list-failpoints
```

### Boundaries and plans

Every implemented operation has a `s3.<operation>.before` point:
`create_bucket`, `delete_bucket`, `head_bucket`, `list_buckets`, `put_object`,
`get_object`, `head_object`, `delete_object`, `copy_object`, `delete_objects`,
`list_objects_v2`, `create_multipart_upload`, `upload_part`,
`complete_multipart_upload`, and `abort_multipart_upload`.

These points run at handler entry before storage locks or streaming object
body consumption. The S3 adapter has already routed and authenticated the
request and may have decoded XML inputs. Requests rejected before reaching
the handler do not consume its failure budget. Limits apply across all
requests reaching that point, including different buckets and keys.

Five operations also have `s3.<operation>.after_commit` points: `put_object`,
`copy_object`, `delete_object`, `delete_objects`, and
`complete_multipart_upload`. They run after releasing the storage lock and
making the mutation visible. An error here means the requested mutation has
already happened, even though the caller receives an error. For example:

```console
$ buck2 run tilde//aseipp/mems3:mems3 -- \
    --failpoint 's3.put_object.after_commit=1*return(InternalError)'
```

The first successful PUT commits but responds with `InternalError`. A later
GET sees the object. Retrying a conditional create may return
`PreconditionFailed`; a failed response from committed multipart completion
leaves the completed object present and the upload ID consumed. `after_commit`
means a completed in-memory mutation, not durable storage.

| Plan | Behavior |
| --- | --- |
| `2*return(SlowDown)` | Fail two visits with HTTP 503, then continue |
| `3*off->return(AccessDenied)` | Allow three visits, then return HTTP 403 |
| `10%return(ServiceUnavailable)` | Select an HTTP 503 error on about 10% of visits |
| `1*sleep(5000)` | Delay one operation for five seconds, yielding the executor |
| `return` | Return `InternalError`, equivalent to `return(InternalError)` |

Supported error payloads are `InternalError`, `SlowDown`, `ServiceUnavailable`,
`RequestTimeout`, and `AccessDenied`. The returned status and error code use
the ordinary S3 adapter; HEAD responses remain bodiless. `RequestTimeout` is
an S3 error response, while `sleep` can induce an actual client-side timeout.
Plans also support `pause`, `yield`, and `panic(message)`.

`->` denotes ordered fallback: a visit executes at most one action.
`sleep(100)->return(SlowDown)` always sleeps; it does not sleep and then fail.
Use a delay at `before` and an error at `after_commit` if both effects are
needed for a write. CLI configuration stays fixed for the process lifetime;
there is no runtime admin endpoint. A CLI `pause` waits indefinitely. Use
in-process guards to release pauses in deterministic concurrency tests.

### Automatic adversarial campaigns

Use `--auto-buggify` to exercise a client's failure handling without selecting
individual failpoints. Point the service under test at this mems3 endpoint, then
run its workload with the normal S3 client and retry policy:

```console
buck2 run tilde//aseipp/mems3:mems3 -- \
    --bucket slatedb --fault-seed 42 --auto-buggify \
    --chaos-warmup-requests 20 --chaos-requests 2000 --chaos-trace
```

The first 20 admitted S3 operations run normally; the next 2,000 participate
in chaos; all subsequent admissions run normally. Retried operations count as
new requests. Initial `--bucket` creation, connection setup, and requests rejected
by the protocol/authentication layer before reaching a handler do not count.
Use an appropriate warmup count for the workload: it is a count of **S3
operations**, not database transactions or seconds. Without these count options,
injection starts immediately and continues until the server stops. The finite
count must be positive; counts and their sum must fit in an unsigned 64-bit
integer. The server stays available after a finite campaign finishes.

The built-in **`storage-v1`** profile applies at every implemented operation's
entry boundary and the five post-commit boundaries listed above. Each boundary
selects at most one effect, in this order:

| Effect | Entry boundary | Post-commit boundary |
| --- | --- | --- |
| Error | 10% `SlowDown` (HTTP 503), storage untouched | 5% `InternalError` (HTTP 500), mutation already visible |
| Long delay | 2% chance of 1,000 ms | 2% chance of 1,000 ms |
| Short delay | 10% chance of 50 ms | 10% chance of 50 ms |
| Scheduler yield | 20% chance | 20% chance |
| Normal execution | When no earlier effect fires | When no earlier effect fires |

Probabilities after the error row are conditional on earlier effects not
firing. A successful write can encounter an effect both before and after its
mutation. Delays use Tokio timers outside storage locks; each selected delay is
bounded to one second. Every automatic site is activated, so the campaign
explores the whole profile instead of possibly excluding every error site for
a seed. Fault selection still uses faultline's BUGGIFY probability machinery.
The versioned profile keeps this policy explicit; low-level percentages remain
available through the separate `--buggify` and `--failpoint` modes.

These faults model transient service failures, slow responses, and ambiguous
writes while preserving mems3's stored bytes and visibility rules. A failed
conditional PUT may have committed; a retry can return `PreconditionFailed`.
A failed multipart completion may have consumed its upload. Clients need to
reconcile those outcomes, not assume every 500 means nothing happened. Automatic
mode does not inject permission errors, infinite pauses, panics, corrupt bytes,
stale listings, or broken response streams. It cannot be combined with manual
failpoints or basic `--buggify`, so reaching recovery ends automatic injection
without another mode continuing to fail requests.

#### What is deterministic?

Campaign phases depend only on admission counts. On entry, each active request
gets its own BUGGIFY controller, seeded from the campaign seed and its active
request ordinal. Static boundary/action names separate its decision streams.
The request retains that controller through commit. Warmup consumes no random
decisions; an error, cancellation, or retry never rewinds a request number.

For the same seed, profile, code/dependency versions, and admitted operation
sequence, **the selected faults and delay lengths repeat**. Concurrent writes
finishing in a different order do not exchange their post-commit faults. A
request admitted during chaos remains eligible at its post-commit boundary even
if newer requests have already entered recovery. Join outstanding requests
before auditing recovered state; a phase transition does not cancel them.

The whole distributed execution is not deterministic: client concurrency can
change admission order, timers can wake later than requested, a cancellation
can prevent a later boundary from being reached, and clients can make different
retry decisions. For a minimal reproducer, serialize the client's S3 operations
and retain its workload seed and inputs alongside the mems3 seed. The regression
suite also fixes admission order while varying completion order to check the
stronger server-side guarantee.

#### Coverage and reproduction

Startup logs the profile, effective seed, and campaign counts. Every ten seconds,
stderr reports the next admission's phase, total requests, handlers in flight,
active boundary visits, entry errors, post-commit errors, delays, and yields.
A finite campaign also reports when all admitted handlers have drained after
reaching recovery. These counters record selected effects at reached boundaries,
including effects whose handlers were later cancelled; they do not prove that
the client observed an error response. A short run may select no errors, so
check coverage instead of treating a passing workload alone as a chaos result.

`--chaos-trace` additionally logs **every reached boundary**, including normal
decisions, with its request number and original admission phase:

```text
mems3 chaos trace: seed=42 request=27 boundary=s3.put_object.after_commit phase=active action=Error(InternalError)
```

The line illustrates the format, not a promised outcome for request 27. Trace
lines can arrive out of order under concurrency; correlate them by request
number. Object keys and payloads are omitted. Retain client operation logs for
mapping those numbers back to workload inputs. Tracing can produce substantial
output and affect scheduling; redirect stderr to a file or continuously drain
it when running mems3 as a subprocess. Buck fixtures retain it in `MEMS3_LOG`.

A Buck fixture uses the same policy:

```python
mems3_local_resource(
    name = "slatedb-chaos-resource",
    buckets = ["slatedb"],
    fault_seed = 42,
    auto_buggify = True,
    chaos_warmup_requests = 20,
    chaos_requests = 2000,
    chaos_trace = True,
)
```

Attach this private resource to the workload test as described above. Run a
fixed seed in regression tests and separate seeds in a broader campaign; give
each run a fresh server and isolated data. Treat exhausted retry budgets and
incorrect recovered state as distinct outcomes. Assert both fault coverage and
the service's externally visible invariants.

The executable model in [`tests/auto_buggify_test.rs`](tests/auto_buggify_test.rs)
writes immutable objects with `If-None-Match: *`, retries 500/503 responses,
resolves an ambiguous write by reading and comparing its bytes, and audits
contents, listings, and deletions during recovery. Tests also cover cancellation,
unlocked delayed commits, isolated servers, and reordered completion. The CLI
suite compares complete traces across two server processes.

For SlateDB itself, the next integration step is an S3-backed `ObjectStore`
and a workload that writes, flushes, closes, reopens, and verifies data through
chaos and recovery. This tree currently disables SlateDB's AWS features and
builds `object_store` with filesystem support; cache-server exposes memory and
local filesystem backends. The model test validates mems3's fault behavior and
reconciliation mechanics, not SlateDB's recovery. Once that client wiring exists,
the fixture above can exercise it without more mems3 fault instrumentation.

### Basic BUGGIFY and seeds

```console
$ buck2 run tilde//aseipp/mems3:mems3 -- \
    --fault-seed 42 --buggify \
    --buggify-activation 100 --buggify-firing 10
```

`--buggify` enables two named branches after each operation's `before` point
continues: `s3.request.yield` yields to another task, then
`s3.request.slow_down` may return `SlowDown`. The sites share their activation
and visit sequences across all operations in that server. They do not alter
committed data or fabricate partial responses.

Site activation is chosen once per run; firing is chosen on each visit to an
active site. Both probabilities default to 25%. The percentage options accept
finite values from 0 to 100, including fractions, and require `--buggify`.
At the default activation rate a run may have neither site active. Use 100%
activation when every site must participate, or use a named failpoint for an
exact required failure.

The effective seed is logged as `mems3 fault seed: N`; provide
`--fault-seed N` to reproduce it. Seeds replay per-point/site decisions for
the same visit ordering and code/dependency versions. They do not reproduce
concurrent scheduling, and retries can change the order of subsequent visits.

### Configured Buck fixtures

Both `mems3_local_resource` and `mems3_hurl_test` accept fault settings:

```python
mems3_local_resource(
    name = "s3-retry-resource",
    buckets = ["my-test"],
    failpoints = ["s3.get_object.before=2*return(SlowDown)"],
    fault_seed = 42,
)

mems3_hurl_test(
    name = "s3-stress-test",
    src = "stress.hurl",
    buggify = True,
    buggify_activation = 100,
    buggify_firing = 10,
    fault_seed = 42,
)
```

Fixture percentages are integer values from 0 to 100. Plans are passed as
literal subprocess arguments. Give each test its own resource target so its
fault budgets belong to that test. The helper's startup check observes the
server's announcement rather than making an S3 request, so readiness does
not consume a failure budget. The seed and server diagnostics are available
through `MEMS3_LOG`.

The [fault HTTP scenario](tests/hurl/faults.hurl) demonstrates a committed PUT
with an error response, two retryable GET errors followed by success, and a
committed DELETE with an error response. The
[BUGGIFY scenario](tests/hurl/buggify.hurl) forces both branch probabilities to
100% through the same fixture options.

### In-process coordination

Tests in this package can construct `MemoryS3::with_buckets_and_faults` with
an `Injector<S3Fault>`, or clone the injector returned by `store.faults()`.
Keep that controller when moving the store into `service(store)`, then use
the regular faultline API. Install `Action::Pause.times(1)` with `scoped` on
`s3.put_object.after_commit`, spawn a PUT, and await `guard.wait_for_pauses(1)`
inside a test timeout. A concurrent GET can then observe the object while the
PUT response is paused. Release the guard and join the PUT worker to check its
response. The complete executable version is in
[`tests/faults_test.rs`](tests/faults_test.rs). Service state locks are released
before a pause or delay awaits. Guard cleanup releases only its own plan, so
dropping an old guard cannot erase a newer test configuration.
