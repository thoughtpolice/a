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
  - Built in support for `http(s)` URIs.

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

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --address` | `127.0.0.1:8080` | Listen address (ip:port) |
| `--store` | `memory` | Storage backend: `memory`, `file:///path/to/dir`, or `s3://bucket[/prefix]` |
| `--console-log` | `info` | tracing filter level for console output |
| `--tokio-console` | `false` | Enable tokio-console debugging subscriber |
| `--request-timeout` | `300` | Per-request timeout in seconds (0 = no timeout) |
| `--max-concurrent-requests` | `8192` | Max concurrent requests across all connections |
| `--git-spool-dir` | system temp | Directory for spooling git packfiles during clones |
| `--otel-enabled` | `false` | Enable OpenTelemetry export |
| `--otel-endpoint` | — | OTLP endpoint (e.g. `http://localhost:4317`) |
| `--otel-service-name` | `buck2-cache-server` | Service name for OTEL resource |
| `--otel-sampling-ratio` | always_on | Trace sampling ratio (0.0–1.0) |
| `--default-ttl-days` | `30` | Default TTL for cache entries in days (0 = no expiry) |

## Environment variables

Every CLI flag can also be set via an environment variable. The env var takes
precedence over the compiled default but is overridden by an explicit flag.

| Variable | Flag |
|----------|------|
| `CACHE_SERVER_ADDRESS` | `--address` |
| `CACHE_SERVER_STORE` | `--store` |
| `CACHE_SERVER_LOG` | `--console-log` |
| `CACHE_SERVER_REQUEST_TIMEOUT` | `--request-timeout` |
| `CACHE_SERVER_MAX_CONCURRENT_REQUESTS` | `--max-concurrent-requests` |
| `CACHE_SERVER_GIT_SPOOL_DIR` | `--git-spool-dir` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `--otel-endpoint` |
| `CACHE_SERVER_OTEL_SERVICE_NAME` | `--otel-service-name` |
| `CACHE_SERVER_OTEL_SAMPLING_RATIO` | `--otel-sampling-ratio` |
| `CACHE_SERVER_DEFAULT_TTL_DAYS` | `--default-ttl-days` |

## Storage backends

- **memory** — In-memory store backed by SlateDB's in-memory object store.
  Fast, but all data is lost when the process exits. Good for CI or
  single-build sessions.
- **file://\<path\>** — Persistent local-filesystem store. Data survives
  restarts. Suitable for developer workstations.
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

All backends use content-defined chunking (FastCDC) for large blobs and
store chunks in a flat SlateDB keyspace.

## Observability

The server supports OpenTelemetry traces and metrics via OTLP/gRPC export.
Enable with `--otel-enabled` or by setting `OTEL_EXPORTER_OTLP_ENDPOINT`.

gRPC reflection and the standard gRPC health service are always enabled.

## Health check

The server implements the standard
[gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md).
Each registered service reports its status independently.

Example using `grpcurl`:

```sh
grpcurl -plaintext 127.0.0.1:8080 grpc.health.v1.Health/Check
```


## Limitations

- **Digest function support** — The server supports SHA-256, Blake3, and
  SHA-256/TREE. Other digest functions will be rejected.
- **No authentication or authorization** — bind to localhost only.
- **TTL-based expiry only** — entries expire after `--default-ttl-days` (default
  30). There is no LRU or size-based eviction. Pre-existing entries written
  before TTL was enabled have no expiration.
- **No TLS** — use a sidecar proxy if encryption is needed.
- **Single-writer only** — You can have multiple read instances thanks to
  SlateDB, but only one writer. SlateDB's manifest fencing (built on S3
  conditional writes) makes a stale writer fail fast rather than corrupt
  the store.
