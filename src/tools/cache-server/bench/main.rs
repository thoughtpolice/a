// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! cache-bench: puts a cache-server (or any REAPI cache) under load and
//! checks every answer it gets while doing so.
//!
//! Each workload stores what it needs first (untimed), then runs
//! `--concurrency` closed-loop workers over `--connections` HTTP/2
//! connections for `--duration`, and prints throughput and latency per RPC.
//! Reads are verified against their digests and FindMissingBlobs answers
//! against what is known to be stored; any mismatch fails the run.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use clap::{Args, Parser, Subcommand};

use protos::build::bazel::remote::execution::v2::{Digest, UpdateActionResultRequest};

mod data;
mod hist;
mod rpc;
mod run;
mod workloads;

use data::{Blob, Contents};
use rpc::Clients;
use run::{Recorder, Workload};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "cache-bench")]
struct Cli {
    /// The cache's gRPC endpoint.
    #[arg(long, default_value = "http://127.0.0.1:8080", global = true)]
    server: String,

    /// REAPI instance name.
    #[arg(long, default_value = "", global = true)]
    instance: String,

    /// HTTP/2 connections to spread the load over.
    #[arg(long, default_value_t = 8, global = true)]
    connections: usize,

    /// Requests in flight at once (closed loop: each worker sends its next
    /// request when the last one is answered).
    #[arg(long, default_value_t = 64, global = true)]
    concurrency: usize,

    /// How long to apply the load, e.g. 10s or 2m.
    #[arg(long, default_value = "10s", value_parser = parse_duration, global = true)]
    duration: Duration,

    /// Stop after this many operations (steps of the workload), even if
    /// --duration has not passed: a fixed amount of work rather than time.
    #[arg(long, global = true)]
    ops: Option<u64>,

    /// Seed for generated contents and choices; a fresh one per run unless
    /// given, so each run uploads blobs the cache has not seen.
    #[arg(long, global = true)]
    seed: Option<u64>,

    /// Client runtime threads (default: every CPU this process may use).
    #[arg(long, global = true)]
    threads: Option<usize>,

    /// Bytes per ByteStream WriteRequest message.
    #[arg(long, default_value = "1MiB", value_parser = parse_size, global = true)]
    message_size: usize,

    /// Append a JSON line of the results here.
    #[arg(long, global = true)]
    json: Option<PathBuf>,

    /// No per-second progress lines.
    #[arg(long, global = true)]
    quiet: bool,

    #[command(subcommand)]
    workload: Command,
}

#[derive(Args, Clone)]
struct Sizes {
    /// Smallest blob, e.g. 100 or 4KiB.
    #[arg(long, default_value = "100", value_parser = parse_size)]
    min_size: usize,
    /// Largest blob.
    #[arg(long, default_value = "64KiB", value_parser = parse_size)]
    max_size: usize,
    /// How compressible blob contents are.
    #[arg(long, value_enum, default_value_t = Contents::Random)]
    contents: Contents,
}

#[derive(Subcommand)]
enum Command {
    /// BatchUpdateBlobs of new blobs.
    Upload {
        #[arg(long, default_value_t = 100)]
        batch: usize,
        #[command(flatten)]
        sizes: Sizes,
    },
    /// FindMissingBlobs over a stored corpus and digests never stored.
    Fmb {
        #[arg(long, default_value_t = 20_000)]
        corpus: usize,
        #[arg(long, default_value_t = 1000)]
        batch: usize,
        /// Fraction of each request that is stored.
        #[arg(long, default_value_t = 0.9)]
        hit_ratio: f64,
    },
    /// BatchReadBlobs of a stored corpus.
    Read {
        #[arg(long, default_value_t = 10_000)]
        corpus: usize,
        #[arg(long, default_value_t = 50)]
        batch: usize,
        #[command(flatten)]
        sizes: Sizes,
        /// Ask for zstd-compressed responses.
        #[arg(long)]
        zstd: bool,
    },
    /// ByteStream writes.
    BsWrite {
        #[arg(long, default_value = "16MiB", value_parser = parse_size)]
        size: usize,
        #[arg(long, value_enum, default_value_t = Contents::Random)]
        contents: Contents,
        /// Upload zstd-compressed (compressed-blobs/zstd).
        #[arg(long)]
        zstd: bool,
        /// Write the same N stored blobs over and over instead of new ones.
        #[arg(long, default_value_t = 0)]
        pool: usize,
    },
    /// ByteStream reads of a stored corpus.
    BsRead {
        #[arg(long, default_value = "16MiB", value_parser = parse_size)]
        size: usize,
        #[arg(long, default_value_t = 32)]
        blobs: usize,
        #[arg(long, value_enum, default_value_t = Contents::Random)]
        contents: Contents,
        /// Read compressed-blobs/zstd.
        #[arg(long)]
        zstd: bool,
        /// Stop reading after the first message for this long, like a
        /// client that falls behind (what does a stalled reader pin?).
        #[arg(long, value_parser = parse_duration)]
        hold: Option<Duration>,
    },
    /// GetActionResult over stored entries, with some UpdateActionResult.
    Ac {
        #[arg(long, default_value_t = 10_000)]
        entries: u64,
        /// Output files per entry.
        #[arg(long, default_value_t = 4)]
        outputs: usize,
        #[arg(long, default_value_t = 0.05)]
        write_ratio: f64,
    },
    /// A build against a cold cache that warms as it runs.
    Build {
        #[arg(long, default_value_t = 20_000)]
        actions: u64,
        /// Inputs per action, drawn (skewed) from the input pool.
        #[arg(long, default_value_t = 30)]
        inputs: usize,
        /// Distinct input blobs.
        #[arg(long, default_value_t = 20_000)]
        pool: usize,
        #[arg(long, default_value_t = 3)]
        outputs: usize,
        #[command(flatten)]
        sizes: Sizes,
    },
    /// GetTree of a stored tree.
    Tree {
        #[arg(long, default_value_t = 4)]
        depth: u32,
        #[arg(long, default_value_t = 8)]
        fanout: usize,
        #[arg(long, default_value_t = 16)]
        files: usize,
    },
}

fn parse_duration(s: &str) -> Result<Duration, String> {
    let (num, unit) = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .map_or((s, "s"), |i| s.split_at(i));
    let n: f64 = num.parse().map_err(|_| format!("bad duration {s:?}"))?;
    let secs = match unit {
        "ms" => n / 1e3,
        "s" => n,
        "m" => n * 60.0,
        "h" => n * 3600.0,
        _ => return Err(format!("bad duration unit in {s:?}")),
    };
    Ok(Duration::from_secs_f64(secs))
}

fn parse_size(s: &str) -> Result<usize, String> {
    let (num, unit) = s
        .find(|c: char| !c.is_ascii_digit())
        .map_or((s, ""), |i| s.split_at(i));
    let n: usize = num.parse().map_err(|_| format!("bad size {s:?}"))?;
    let mul = match unit {
        "" | "B" => 1,
        "KiB" | "K" => 1 << 10,
        "MiB" | "M" => 1 << 20,
        "GiB" | "G" => 1 << 30,
        "KB" => 1000,
        "MB" => 1_000_000,
        _ => return Err(format!("bad size unit in {s:?}")),
    };
    Ok(n * mul)
}

/// Blobs `0..count` of the stream `tag`, sized between `min` and `max`,
/// made on every core.
fn corpus(seed: u64, tag: u64, count: usize, min: usize, max: usize, c: Contents) -> Vec<Blob> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let per = count.div_ceil(threads).max(1);
    std::thread::scope(|s| {
        let parts: Vec<_> = (0..count)
            .step_by(per)
            .map(|start| {
                s.spawn(move || {
                    (start..(start + per).min(count))
                        .map(|i| {
                            let id = (tag << 56) | i as u64;
                            let mut rng = data::Rng::keyed(&[seed, id]);
                            let size = rng.between(min as u64, max as u64) as usize;
                            Blob::new(seed, id, size, c)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        parts
            .into_iter()
            .flat_map(|p| p.join().expect("corpus thread"))
            .collect()
    })
}

async fn store(clients: &Clients, what: &str, blobs: &[Blob], concurrency: usize) -> Result<()> {
    let bytes: usize = blobs.iter().map(|b| b.data.len()).sum();
    let t = Instant::now();
    clients
        .upload_all(blobs, concurrency)
        .await
        .with_context(|| format!("storing the {what}"))?;
    let secs = t.elapsed().as_secs_f64();
    eprintln!(
        "stored {what}: {} blobs, {:.1} MB in {secs:.2}s ({:.1} MB/s)",
        blobs.len(),
        bytes as f64 / 1e6,
        bytes as f64 / 1e6 / secs
    );
    Ok(())
}

fn digests(blobs: &[Blob]) -> Vec<Digest> {
    blobs.iter().map(|b| b.digest.clone()).collect()
}

async fn go<W: Workload>(cli: &Cli, name: &str, w: W) -> Result<Recorder> {
    eprintln!(
        "running {name}: {} workers over {} connections for {:?}",
        cli.concurrency, cli.connections, cli.duration
    );
    let (rec, elapsed) = run::run(
        Arc::new(w),
        cli.concurrency,
        cli.duration,
        cli.ops,
        cli.quiet,
    )
    .await;
    run::report(name, &rec, elapsed);
    if let Some(path) = &cli.json {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(f, "{}", run::to_json(name, &rec, elapsed))?;
    }
    Ok(rec)
}

async fn main_async(cli: Cli, seed: u64) -> Result<Recorder> {
    let clients = Clients::connect(
        &cli.server,
        cli.connections,
        cli.instance.clone(),
        cli.message_size,
    )
    .await?;
    let setup = cli.concurrency.clamp(8, 64);
    match &cli.workload {
        Command::Upload { batch, sizes } => {
            let w = workloads::Upload {
                clients,
                seed,
                batch: *batch,
                min_size: sizes.min_size,
                max_size: sizes.max_size,
                contents: sizes.contents,
            };
            go(&cli, "upload", w).await
        }
        Command::Fmb {
            corpus: n,
            batch,
            hit_ratio,
        } => {
            let blobs = corpus(seed, 0x10, *n, 100, 4096, Contents::Random);
            store(&clients, "corpus", &blobs, setup).await?;
            let w = workloads::FindMissing {
                clients,
                seed,
                corpus: digests(&blobs),
                batch: *batch,
                hit_ratio: *hit_ratio,
            };
            go(&cli, "fmb", w).await
        }
        Command::Read {
            corpus: n,
            batch,
            sizes,
            zstd,
        } => {
            let blobs = corpus(
                seed,
                0x11,
                *n,
                sizes.min_size,
                sizes.max_size,
                sizes.contents,
            );
            store(&clients, "corpus", &blobs, setup).await?;
            let w = workloads::BatchRead {
                clients,
                seed,
                corpus: digests(&blobs),
                batch: *batch,
                zstd: *zstd,
            };
            go(&cli, "read", w).await
        }
        Command::BsWrite {
            size,
            contents,
            zstd,
            pool,
        } => {
            let pool: Vec<(Blob, Option<Bytes>)> =
                corpus(seed, 0x12, *pool, *size, *size, *contents)
                    .into_iter()
                    .map(|b| {
                        let packed = zstd
                            .then(|| Bytes::from(zstd::bulk::compress(&b.data, 1).expect("zstd")));
                        (b, packed)
                    })
                    .collect();
            if !pool.is_empty() {
                let blobs: Vec<Blob> = pool.iter().map(|(b, _)| b.clone()).collect();
                store(&clients, "pool", &blobs, setup).await?;
            }
            let w = workloads::BsWrite {
                clients,
                seed,
                size: *size,
                contents: *contents,
                zstd: *zstd,
                pool,
            };
            go(&cli, "bs-write", w).await
        }
        Command::BsRead {
            size,
            blobs: n,
            contents,
            zstd,
            hold,
        } => {
            let blobs = corpus(seed, 0x13, *n, *size, *size, *contents);
            store(&clients, "corpus", &blobs, setup).await?;
            let w = workloads::BsRead {
                clients,
                seed,
                corpus: digests(&blobs),
                zstd: *zstd,
                hold: *hold,
            };
            go(&cli, "bs-read", w).await
        }
        Command::Ac {
            entries,
            outputs,
            write_ratio,
        } => {
            let pool = corpus(seed, 0x14, 4096, 100, 16 << 10, Contents::Random);
            store(&clients, "output pool", &pool, setup).await?;
            let pool = digests(&pool);
            let t = Instant::now();
            {
                use futures::{StreamExt as _, TryStreamExt as _};
                let (clients, pool) = (&clients, &pool);
                futures::stream::iter(0..*entries)
                    .map(|i| async move {
                        clients
                            .ac(i as usize)
                            .update_action_result(UpdateActionResultRequest {
                                instance_name: clients.instance.clone(),
                                action_digest: Some(workloads::action_digest(seed, i)),
                                action_result: Some(workloads::action_result(i, *outputs, pool)),
                                results_cache_policy: None,
                                digest_function: 0,
                            })
                            .await
                    })
                    .buffer_unordered(setup)
                    .try_collect::<Vec<_>>()
                    .await
                    .context("storing action results")?;
            }
            eprintln!(
                "stored {entries} action results in {:.2}s",
                t.elapsed().as_secs_f64()
            );
            let w = workloads::ActionCache {
                clients,
                seed,
                entries: *entries,
                outputs: *outputs,
                pool,
                write_ratio: *write_ratio,
            };
            go(&cli, "ac", w).await
        }
        Command::Build {
            actions,
            inputs,
            pool,
            outputs,
            sizes,
        } => {
            let blobs = corpus(
                seed,
                4,
                *pool,
                sizes.min_size,
                sizes.max_size,
                sizes.contents,
            );
            let w = workloads::Build {
                clients,
                seed,
                actions: *actions,
                inputs: *inputs,
                pool_sizes: blobs.iter().map(|b| b.data.len()).collect(),
                pool: digests(&blobs),
                outputs: *outputs,
                min_size: sizes.min_size,
                max_size: sizes.max_size,
                contents: sizes.contents,
            };
            drop(blobs);
            go(&cli, "build", w).await
        }
        Command::Tree {
            depth,
            fanout,
            files,
        } => {
            let tree = workloads::make_tree(seed, *depth, *fanout, *files);
            store(&clients, "tree", &tree.blobs, setup).await?;
            let w = workloads::Tree {
                clients,
                root: tree.root,
                directories: tree.directories,
            };
            go(&cli, "tree", w).await
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let seed = cli.seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(1, |d| d.as_nanos() as u64)
    });
    eprintln!("seed {seed}");
    let mut rt = tokio::runtime::Builder::new_multi_thread();
    rt.enable_all();
    if let Some(n) = cli.threads {
        rt.worker_threads(n);
    }
    let rec = rt.build()?.block_on(main_async(cli, seed))?;
    if rec.verify_failures > 0 {
        bail!("{} answers did not check out", rec.verify_failures);
    }
    Ok(())
}
