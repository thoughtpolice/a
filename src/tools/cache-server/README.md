<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# cache-server

A server implementing the [Remote Build APIs][REAPI] specification, built on
top of [SlateDB]. This is primarily designed for my use with [Buck2] but I also
regularly test it with [Reninja]. It also comes with a few extra tools like a
REAPI client and some buck-specific helper utilities.

Currently supports the following REAPI services:

- ContentAddressableStorage
  - Including recent new FastCDC/chunking algorithms
- ActionCache
- Remote Asset API
  - `http(s)` URIs, verified against a `checksum.sri` qualifier.
  - Git repositories over smart HTTP (see [Git fetches](#git-fetches)).
  - Container images from OCI registries (see [OCI images](#oci-images)).

Execution may come at a later time, once I think about how I want orchestration
to behave.

[REAPI]: https://github.com/bazelbuild/remote-apis
[Buck2]: https://buck2.build
[Reninja]: https://github.com/buildbuddy-io/reninja
[SlateDB]: https://slatedb.io

## Quick start

There is a built-in Buck alias that you can use from anywhere in the tree. Run
with in-memory storage in release mode (ephemeral, lost on restart):

```sh
buck2 run cache-server?release
```

Or with persistent file-backed storage:

```sh
buck2 run cache-server?release -- --store file:///tmp/cache
```

Configure Buck to use the cache by adding something like the following to
`.buckconfig.local`:

```ini
[buck2_re_client]
address = grpc://127.0.0.1:8080
tls = false
```

Then you can use `buck2 build @mode//cached-upload $MORE_ARGS` in order to
build/upload things to the cache, and also download from the cache when there is
a hit. The alternative `@mode//cached` will only use the cache and never upload
actions.

You can also specify the following in your local buckconfig as well:

```ini
[buck2_re_client]
# enable the cache
default_mode=cache-only
# optional: also upload actions into it
cache_upload=true
```

## CLI reference

`cache-server [GLOBAL FLAGS] [serve|compact] [FLAGS]`. With no subcommand it
runs `serve` as if given no flags, so `serve`'s environment variables still
apply; `compact` runs SlateDB compaction standalone, against a store whose
server runs with `--disable-compactor`.

Global flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--store` | `memory` | Storage backend: `memory`, `file:///path/to/dir` (or a bare path), or `s3://bucket[/prefix]` |
| `--console-log` | `info` | What the console log shows: a level, or `RUST_LOG`-style directives such as `info,slatedb=debug` |
| `--default-ttl-days` | `30` | Default TTL for cache entries in days (0 = no expiry) |
| `--trace-dir` | `$TMPDIR/cache-server-traces` | Where dial9 runtime traces go (see [Runtime traces](#runtime-traces)) |
| `--trace-max-file-mib` | `10` | Size at which a trace segment is sealed |
| `--trace-max-total-mib` | `50` | Disk budget for one subcommand's traces, across restarts |
| `--trace-sched-sample-interval` | `10` | Record one in this many kernel context switches |
| `--disable-dial9` | `false` | Run without dial9 tracing |

`serve` flags:

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --address` | `127.0.0.1:8080` | Listen address (ip:port) |
| `--request-timeout` | `900` | Per-request timeout in seconds (0 = no timeout), for every RPC but Remote Asset fetches |
| `--fetch-timeout` | `1800` | The longest a Remote Asset fetch may run, in seconds (0 = no limit) |
| `--max-concurrent-requests` | `8192` | Max concurrent requests across all connections (and 256 per connection) |
| `--max-connections` | ¾ of the open-files limit | Most connections open at once. At the cap, a newcomer gets in by the connection that has gone longest without a request being let go (gracefully, its requests in flight finishing first); more newcomers wait in the listen backlog meanwhile. The server raises its soft open-files limit to the hard one at startup. A connection that sends no request within 30 s is closed, and one idle for 10 minutes is shut down gracefully |
| `--disable-compactor` | `false` | Leave compaction to a `compact` process |
| `--block-cache-mib` | `512` | In-memory cache of SST data blocks (action cache entries, blob manifests and the small blobs stored in them, assets, and chunks of 64 KiB or less; larger chunks bypass it) |
| `--meta-cache-mib` | `128` | In-memory cache of SST indexes and bloom filters, which every lookup consults |
| `--small-blob-cache-mib` | `64` | In-memory cache of small blobs (64 KiB or less), kept once read, verified and decompressed, so reading them again skips the store's lookups (0 = off) |
| `--action-result-cache-mib` | `64` | In-memory cache of action cache entries, kept once read so reading them again skips the store's lookups, and dropped when written (0 = off) |
| `--manifest-cache-mib` | `32` | In-memory cache of blob manifests (of blobs over 4 KiB), kept once read so reading the blob again skips one of the store's lookups (0 = off) |
| `--write-buffer-mib` | `1024` (SlateDB's) | Most writes held in memory before they are flushed to L0 SSTs; past it, writes wait for a flush. Must exceed the 64 MiB L0 SST size. Flushes keep up with a single upload stream at any size, so this bounds memory only under ingest heavier than the flushes; then in-flight requests and the caches hold more than this does |
| `--object-store-cache-dir` | — | S3 only: a local disk cache of SST data read from (and written to) S3 |
| `--object-store-cache-gib` | `16` | Size of the object store cache |
| `--disk-reserve-gib` | a tenth of the disk, ≥ 1 | Local stores: refuse uploads while the store's disk has less free (0 = off); see [Disk space](#disk-space) |
| `--tls-cert`, `--tls-key` | — | PEM certificate chain and key; serve TLS |
| `--git-spool-dir` | system temp | Where git packs spool during clones (multi-GiB for large repositories; avoid tmpfs) |
| `--max-concurrent-http-fetches` | `16` | Remote Asset HTTP fetches at once (each holds up to 256 MiB) |
| `--max-concurrent-git-clones` | `2` | Remote Asset git clones at once (cores are shared between them) |
| `--max-concurrent-oci-fetches` | `4` | Remote Asset OCI image fetches at once (each streams up to four layers at a time into the store) |
| `--oci-auth-file` | — | A Docker `config.json` holding credentials for OCI registries that refuse anonymous pulls; see [OCI images](#oci-images) |
| `--tokio-console` | `false` | Enable the tokio-console debugging subscriber |
| `--otel-enabled` | `false` | Enable OpenTelemetry export |
| `--otel-endpoint` | — | OTLP endpoint (e.g. `http://localhost:4317`) |
| `--otel-service-name` | `buck2-cache-server` | Service name for OTEL resource |
| `--otel-sampling-ratio` | always_on | Trace sampling ratio (0.0–1.0) |

## Environment variables

Every CLI flag except `--tokio-console`, `--otel-enabled`, and
`--disable-compactor` can also be set via an environment variable. The env
var takes precedence over the compiled default but is overridden by an
explicit flag.

| Variable | Flag |
|----------|------|
| `CACHE_SERVER_STORE` | `--store` |
| `CACHE_SERVER_LOG` | `--console-log` |
| `CACHE_SERVER_DEFAULT_TTL_DAYS` | `--default-ttl-days` |
| `CACHE_SERVER_TRACE_DIR` | `--trace-dir` |
| `CACHE_SERVER_TRACE_MAX_FILE_MIB` | `--trace-max-file-mib` |
| `CACHE_SERVER_TRACE_MAX_TOTAL_MIB` | `--trace-max-total-mib` |
| `CACHE_SERVER_TRACE_SCHED_SAMPLE_INTERVAL` | `--trace-sched-sample-interval` |
| `CACHE_SERVER_DISABLE_DIAL9` | `--disable-dial9` |
| `CACHE_SERVER_ADDRESS` | `--address` |
| `CACHE_SERVER_REQUEST_TIMEOUT` | `--request-timeout` |
| `CACHE_SERVER_FETCH_TIMEOUT` | `--fetch-timeout` |
| `CACHE_SERVER_MAX_CONCURRENT_REQUESTS` | `--max-concurrent-requests` |
| `CACHE_SERVER_MAX_CONNECTIONS` | `--max-connections` |
| `CACHE_SERVER_BLOCK_CACHE_MIB` | `--block-cache-mib` |
| `CACHE_SERVER_META_CACHE_MIB` | `--meta-cache-mib` |
| `CACHE_SERVER_SMALL_BLOB_CACHE_MIB` | `--small-blob-cache-mib` |
| `CACHE_SERVER_ACTION_RESULT_CACHE_MIB` | `--action-result-cache-mib` |
| `CACHE_SERVER_MANIFEST_CACHE_MIB` | `--manifest-cache-mib` |
| `CACHE_SERVER_WRITE_BUFFER_MIB` | `--write-buffer-mib` |
| `CACHE_SERVER_OBJECT_STORE_CACHE_DIR` | `--object-store-cache-dir` |
| `CACHE_SERVER_OBJECT_STORE_CACHE_GIB` | `--object-store-cache-gib` |
| `CACHE_SERVER_DISK_RESERVE_GIB` | `--disk-reserve-gib` |
| `CACHE_SERVER_TLS_CERT` | `--tls-cert` |
| `CACHE_SERVER_TLS_KEY` | `--tls-key` |
| `CACHE_SERVER_GIT_SPOOL_DIR` | `--git-spool-dir` |
| `CACHE_SERVER_MAX_CONCURRENT_HTTP_FETCHES` | `--max-concurrent-http-fetches` |
| `CACHE_SERVER_MAX_CONCURRENT_GIT_CLONES` | `--max-concurrent-git-clones` |
| `CACHE_SERVER_MAX_CONCURRENT_OCI_FETCHES` | `--max-concurrent-oci-fetches` |
| `CACHE_SERVER_OCI_AUTH_FILE` | `--oci-auth-file` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `--otel-endpoint` |
| `CACHE_SERVER_OTEL_SERVICE_NAME` | `--otel-service-name` |
| `CACHE_SERVER_OTEL_SAMPLING_RATIO` | `--otel-sampling-ratio` |

## Storage backends

- **memory** — In-memory store backed by SlateDB's in-memory object store.
  Fast, but all data is lost when the process exits. Good for CI or
  single-build sessions.
- **file://\<path\>** — Persistent local-filesystem store, created if
  missing. Data survives restarts. Suitable for developer workstations.
- **s3://\<bucket\>[/prefix]** — S3 or any S3-compatible service (MinIO,
  R2, Tigris, Garage, ...), via a first-party `ObjectStore` backend that
  signs requests with AWS SigV4 and speaks TLS through BoringSSL. It is
  configured with the standard environment variables: `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` (or
  `AWS_DEFAULT_REGION`), `AWS_ENDPOINT_URL` (or `AWS_ENDPOINT_URL_S3` /
  `AWS_ENDPOINT`), plus `AWS_ALLOW_HTTP=true` for plain-HTTP endpoints and
  `AWS_VIRTUAL_HOSTED_STYLE_REQUEST=true` to address buckets as subdomains
  instead of path-style. The service must support conditional writes
  (`If-None-Match`/`If-Match` on PUT), which SlateDB uses for manifest
  compare-and-swap; AWS S3, MinIO, R2, and Tigris all do.

All backends use content-defined chunking (FastCDC) for large blobs, and
store blobs of 4 KiB or less (most Directories, Commands, and small files)
in their manifests, so reading one is a single lookup. Each kind of entry (chunks, blob manifests, action cache entries, assets) is kept
in its own SlateDB LSM tree (a segment), so metadata lookups and compactions
never wade through chunk data. The split is fixed when a store is created;
SlateDB refuses to open a store created without it.

Every write is acknowledged only once it is durable: SlateDB makes writes
durable on its next WAL flush, and the server waits for it, so an upload the
client was told succeeded survives a crash. Concurrent writes share a flush.
The flush interval is the floor on write latency: 5 ms on `memory` and
`file://` stores, SlateDB's default of 100 ms on S3 (where each flush is a
billable PUT). Whether a blob is already stored (FindMissingBlobs, or an
upload deciding it can be skipped) is decided on durable data only.

### Uploads and lookups

- A ByteStream `Write` of a blob already stored is answered from its first
  message (`committed_size` the full size, or -1 for a compressed upload, as
  REAPI specifies), and the rest of the stream is read and discarded rather
  than reset: resetting streams at volume makes HTTP/2 servers close the
  whole connection. Other uploads stream into the store as their chunks are
  cut, so an upload of any size holds a few MiB in the server; the blob
  appears only once its manifest is written, after every chunk.
- A `BatchUpdateBlobs` is checked off the async workers and written in one
  write, so it waits for one durable flush however many blobs it carries.
  Compressed blobs may expand to no more than their digests say, and to at
  most 64 MiB per batch.
- The empty blob is always stored, uploaded or not, as REAPI requires; an
  empty Directory is the empty blob.
- The server remembers about a million blobs it knows are stored (and when
  they expire), so asking about them again (every action names the same
  toolchain and headers) skips the LSM. It looks each one up again at least
  every 10 minutes.
- Blobs of 4 KiB or less are read with their manifests, and other blobs of
  64 KiB or less through the block cache; larger chunks bypass it.
- Every chunk `SplitBlob` names is stored as a blob of its own, which
  expires with the blob it came from, so clients can fetch the chunks they
  lack like any other blob. Splitting a blob in the last half of its TTL
  renews it and its chunks, as uploading it again would.
- A ByteStream `Read` keeps up to 8 chunks in flight ahead of its client,
  within 1 GiB of read-ahead shared by all reads; it always has its next
  chunk in flight, so clients that stop reading neither pin unbounded
  memory nor slow anyone else's reads down.

### Expiry

Entries expire `--default-ttl-days` after they are written, and read as
missing from then on. A blob in the last half of its TTL counts as missing
for FindMissingBlobs (and for skipping an upload, and for answering a Remote
Asset fetch from cache), so clients upload it again and the write renews
it: blobs in use stay, at the cost of one re-upload per half-life, and
unused ones expire. Action cache entries are renewed only by being written
again.

An action result is returned only while every blob it names (output files,
the files of output directories and their Tree blobs, stdout, stderr) is
stored by that same rule; otherwise `GetActionResult` reports a miss. A
client told an action ran may never download its outputs, and later name
them as inputs, so a hit has to imply FindMissingBlobs would call them
present. The client runs the action again, and uploading its outputs renews
them.

### Tuning

SSTs always carry bloom filters (compacted ones too), and large chunks stay
out of the in-memory block cache, so uploads do not evict the small, hot
metadata (repeated chunk reads are served by the OS page cache, or for S3 by
`--object-store-cache-dir`). The compactor looks for work every 100 ms on
local stores (every second on S3, where each look is a LIST and a GET), and
up to 16 L0 SSTs per kind of key may wait for it, so a stream of uploads
does not stall behind a compaction that has yet to start. Any other [SlateDB setting] can be overridden
with an environment variable named `CACHE_SERVER_SLATEDB_` plus the setting
(`.` separates a nested one), e.g. `CACHE_SERVER_SLATEDB_L0_SST_SIZE_BYTES`
or `CACHE_SERVER_SLATEDB_COMPACTOR_OPTIONS.MAX_CONCURRENT_COMPACTIONS`, for
the server and the `compact` process alike.

[SlateDB setting]: https://docs.rs/slatedb/0.17.0/slatedb/config/struct.Settings.html

### Disk space

Fully compacted, a store takes about its data's size on disk (a run that
uploaded 6.6 GB settled at 6.9 GB). While writes come in it takes several
times that: size-tiered compaction writes each merged run before deleting
its inputs, the WAL holds every write until its memtable is flushed, and
SlateDB keeps the SSTs a compaction replaces for two minutes (a checkpoint
of the old manifest, which in-flight readers may still use), and any SST for
five minutes after it was written, before garbage collection, which runs
every minute, may delete them. Provision a local
disk for a few times the data, and expect an S3 bucket to hold more than
the data for a while after heavy uploads.

A local store refuses uploads (`RESOURCE_EXHAUSTED`) while the disk under
it has less free than `--disk-reserve-gib`, a tenth of the filesystem by
default. Reads go on, and compaction and garbage collection get the room to
bring usage back down; a disk that filled outright would stop the store,
and the server with it.

## Remote Asset fetches

Origin fetches are bounded three ways:

- **Time**: a fetch gets the request's `timeout`, else 60 s for HTTP, 10
  minutes for an OCI image, and 30 minutes for git, but never more than
  `--fetch-timeout` (30 minutes).
  Fetch requests are exempt from `--request-timeout`; the server cuts them
  off 2 s after `--fetch-timeout`, so a fetch out of time answers
  `DEADLINE_EXCEEDED` itself first.
- **Concurrency**: `--max-concurrent-http-fetches`,
  `--max-concurrent-git-clones`, and `--max-concurrent-oci-fetches`.
  Identical requests in flight at once share one fetch.
- **Size**: 256 MiB per HTTP body (hashed while it downloads); 32 GiB per git
  pack, 20 million objects, and 2 GiB per object; 16 GiB per OCI image, 2 GiB
  per layer or blob, and 4 MiB per manifest or config.

`FetchBlob` fetches `http(s)` URIs, and blobs from OCI registries (see
[OCI images](#oci-images)). Qualifiers that name a tree (`vcs.branch`,
`vcs.commit`, `directory`, or `resource_type=application/x-git`) find only
blobs pushed under them: fetched as a blob, a repository's URI gives its web
page, not its contents. `FetchDirectory` fetches git repositories and OCI
images.

### Git fetches

`FetchDirectory` clones a repository when the URI ends in `.git` or carries
`resource_type=application/x-git`, at `vcs.commit` (a 40-digit SHA-1) or
`vcs.branch` (a branch or tag), or with neither, at the default branch. It
returns the tree, or the subtree named by a `directory` qualifier. A
branch moves, so a fetch of one answers with the tree it cached until that
needs renewing, or until the request's `oldest_content_accepted` is newer.

Only the one commit is fetched, the way `git clone --depth 1` does: protocol
v2 when the server speaks it (any commit is then fetchable by id), else v0,
with `deepen 1` when the server supports shallow fetches. The pack spools to
`--git-spool-dir` and is indexed with gitoxide; the tree is then converted
to REAPI Directories on several threads, blobs and Directories streaming
into CAS in batches. Submodules are skipped, and SHA-256 repositories are
not supported.

Ingests are incremental. Each records its blobs' CAS digests by git object
id, so a later fetch of another commit (or the same one, once its cached
tree needs renewing) neither decodes nor writes blobs already stored with
at least half their TTL left; nor does it rewrite Directories that are.
Fetching the next release of a repository writes little more than what
changed.

### OCI images

`FetchDirectory` fetches a container image when the URI is
`oci://registry/repository@sha256:<digest>` (`docker://` works too, and
`docker.io` means Docker Hub, whose official images are
`library/<name>`), and no `vcs.*` qualifier is given. The
reference must be pinned by digest; tags are refused. It returns an [OCI
Image Layout] as a tree:

```text
oci-layout
index.json
blobs/sha256/<hex>    the manifest, the config, and each layer
```

Materialized, the tree is a layout that `skopeo` and `podman` read as
`oci:<dir>`. A digest naming an image index (a multi-platform image)
resolves to its `linux/amd64` manifest, or to the platform an
`oci.platform` qualifier names (`os/architecture[/variant]`, as in
`linux/arm64/v8`; without a variant, any variant matches). An image named
by its own manifest's digest is taken as it is, unless `oci.platform` is
given and its config says otherwise.

Layers stream from the registry into the store, each checked against its
digest as it arrives, so an image holds only a few MiB of the server's
memory at a time. Under SHA-256, a layer's CAS digest is its OCI digest,
and a layer already stored with at least half its TTL left is not
downloaded again: images that share layers share their storage and their
downloads. (Under other digest functions every layer is downloaded, to hash
it.)

`FetchBlob` of the same URI form fetches the one blob the digest names (a
layer, say, or failing that a manifest), checked against its digest and any
`checksum.sri` qualifier.

Registries are reached over HTTPS. Public images need no configuration:
the server takes the anonymous bearer token a registry hands out. For
registries that refuse anonymous pulls, `--oci-auth-file` names a Docker
`config.json` whose `auths` hold credentials by registry host, as an `auth`
(base64 of `username:password`) or a `username` and `password` (a registry
access token goes in `password`); credential helpers and identity tokens are
not supported. Credentials go only to the registry they are for and to the
token service its challenges name, and only over TLS; a registry that wants
credentials the server lacks is refused (`PERMISSION_DENIED`).

[OCI Image Layout]: https://github.com/opencontainers/image-spec/blob/main/image-layout.md

## Observability

The server supports OpenTelemetry traces and metrics via OTLP/gRPC export.
Enable with `--otel-enabled` or by setting `OTEL_EXPORTER_OTLP_ENDPOINT`.
Metrics include SlateDB's own (`slatedb.*`: writes, flushes and L0 stalls,
cache hits, object store requests and latency, compaction, GC); the
`compact` process exports them when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

gRPC reflection and the standard gRPC health service are always enabled.

Each log statement prints at most 20 times a second (SlateDB, for one,
warns on every write it holds back while compaction catches up); every
10 s the server logs how many lines it dropped. OpenTelemetry exports spans
and events at `INFO` and above.

### Runtime traces

Unless `--disable-dial9` is given, the server records [dial9] runtime traces
(task polls and wakes, CPU and allocation samples, and kernel scheduler
events where `perf_event_paranoid` allows) into `--trace-dir`/`serve` (or
`/compact`). Segments are sealed every minute or every
`--trace-max-file-mib`, symbolized, and gzipped as `trace.N.bin.gz`; the
oldest are evicted to stay within `--trace-max-total-mib`, across restarts,
so a crashed run's traces are still there afterwards. Segments record the
service version, host, pid, subcommand, and store.

Each directory has one writer at a time: a second process finding it in use
runs untraced (give it its own `--trace-dir`). Send `SIGUSR1` to pause or
resume recording.

[dial9]: https://github.com/dial9-rs/dial9

## Benchmarking

`cache-bench` (`//src/tools/cache-server/bench:cache-bench`) puts a server
under load and checks every answer it gets: reads are verified against their
digests, FindMissingBlobs answers against what it knows it stored, and any
mismatch fails the run. Each workload stores what it needs first, then runs
`--concurrency` closed-loop workers over `--connections` HTTP/2 connections
for `--duration` (or `--ops` operations), and prints throughput and latency
percentiles per RPC (`--json` appends them to a file):

```sh
buck2 run //src/tools/cache-server/bench:cache-bench?release -- upload
buck2 run //src/tools/cache-server/bench:cache-bench?release -- --concurrency 128 fmb --hit-ratio 0.9
```

Workloads: `upload` (BatchUpdateBlobs of new blobs), `fmb`, `read`
(BatchReadBlobs, `--zstd` too), `bs-write` (ByteStream, new blobs or
`--pool N` stored ones), `bs-read`, `ac`, `tree` (GetTree), and `build`
(actions against a cold cache that warms as it runs). For profiling, pin the
server and the bench to different cores (`taskset`) and run `perf record -g`
on the server; release builds keep frame pointers.

## Health check

The server implements the standard
[gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md).
Each registered service reports its status independently, and all turn
`NOT_SERVING` as soon as a shutdown begins.

If the store stops under the server (another writer opened it, fencing this
one off, or a SlateDB background task failed), the server shuts down and
exits non-zero rather than fail every request.

Example using `grpcurl`:

```sh
grpcurl -plaintext 127.0.0.1:8080 grpc.health.v1.Health/Check
```


## Limitations

- **Digest function support** — The server supports SHA-256, Blake3, and
  SHA-256/TREE. Other digest functions will be rejected.
- **No authentication or authorization** — bind to localhost, or put the
  server behind something that authenticates clients.
- **TTL-based expiry only** — entries expire after `--default-ttl-days` (default
  30), renewed as described under [Expiry](#expiry). There is no LRU or
  size-based eviction. Entries written before TTL was enabled have no
  expiration.
- **TLS without client certificates** — `--tls-cert`/`--tls-key` encrypt
  the listener, but clients are not authenticated.
- **Single-writer only** — You can have multiple read instances thanks to
  SlateDB, but only one writer. SlateDB's manifest fencing (built on S3
  conditional writes) makes a stale writer stop rather than corrupt the
  store; the server then exits (see [Health check](#health-check)).
