// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Command-line entrypoint for the ephemeral S3 test server.
//!
//! Options use a small explicit parser; faultline validates typed fault plans
//! before the listener starts. The binary creates requested buckets before
//! accepting traffic, matching celld's assumption that its bucket exists.

use std::collections::BTreeSet;
use std::error::Error;
use std::io;
use std::net::SocketAddr;
use std::os::fd::RawFd;

use faultline::Injector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnectionBuilder;
use s3s::S3Result;
use s3s::access::{S3Access, S3AccessContext};
use s3s::auth::SimpleAuth;
use s3s::service::{S3Service, S3ServiceBuilder};
use tokio::net::TcpListener;

use chaos::{Chaos, ChaosConfig, PROFILE};
use faults::{FaultPlan, POINT_NAMES};
use memory::MemoryS3;

const USAGE: &str = r#"Usage: chaos3 [OPTIONS]

An ephemeral S3-compatible server for tests.

Options:
  --listen ADDRESS              Socket address to bind (default: 127.0.0.1:9000)
  --ready-fd FD                 Write the bound endpoint to descriptor FD, then close it
  --bucket NAME                 Pre-create a bucket; may be repeated (default: celld)
  --failpoint NAME=PLAN         Configure a named point; may be repeated
  --list-failpoints             List available points and exit
  --fault-seed SEED             Seed fault decisions with an unsigned 64-bit integer
  --chaos PROFILE               Run a seeded chaos profile; only storage-v1 exists
  --chaos-warmup-requests N     Admit N healthy requests first (default: 0)
  --chaos-requests N            Inject during N requests, then recover (default: unlimited)
  --chaos-trace                 Log every automatic boundary decision to stderr
  -h, --help                    Show this help

Plans: [percent%][count*]action[(payload)] joined by -> (ordered fallbacks).
Actions: off, return, sleep(milliseconds), pause, yield, panic(message).
Errors: InternalError (default), SlowDown, ServiceUnavailable, RequestTimeout, AccessDenied.
Body: s3.get_object.body runs before each 4 KiB chunk, and return(truncate) ends the body there.
Example: --failpoint 's3.get_object.before=2*return(SlowDown)'
Chaos count and trace options require --chaos, which is incompatible with --failpoint.
"#;

/// Access key accepted by the test server's SigV4/SigV2 verifier.
const ACCESS_KEY_ID: &str = "chaos3";

/// Secret key accepted by the test server's SigV4/SigV2 verifier.
const SECRET_ACCESS_KEY: &str = "chaos3";

#[derive(Debug)]
struct Args {
    listen: SocketAddr,
    ready_fd: Option<RawFd>,
    buckets: Vec<String>,
    failpoints: Vec<(String, FaultPlan)>,
    fault_seed: Option<u64>,
    chaos: Option<ChaosConfig>,
    list_failpoints: bool,
}

/// Accept a bucket name only if the S3 protocol layer could route it.
///
/// `s3s` rejects requests to buckets whose names fail AWS validation, so a
/// name allowed here that fails this check would answer every request with
/// `InvalidBucketName`. Failing at parse time turns that into a usage error.
fn validated_bucket(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("--bucket names cannot be empty".to_owned());
    }
    if !s3s::path::check_bucket_name(name) {
        return Err(format!(
            "invalid --bucket name {name:?}: must be 3-63 characters of lowercase \
             letters, digits, '.', or '-' and follow S3 bucket naming rules"
        ));
    }
    Ok(name.to_owned())
}

/// Test-only authorization policy that also permits anonymous requests.
#[derive(Clone, Copy, Debug)]
struct AllowAllAccess;

#[async_trait::async_trait]
impl S3Access for AllowAllAccess {
    async fn check(&self, _context: &mut S3AccessContext<'_>) -> S3Result<()> {
        Ok(())
    }
}

/// Build the protocol service shared by the TCP server and wire-level tests.
pub(crate) fn service(store: MemoryS3) -> S3Service {
    let mut builder = S3ServiceBuilder::new(store);
    builder.set_auth(SimpleAuth::from_single(ACCESS_KEY_ID, SECRET_ACCESS_KEY));
    builder.set_access(AllowAllAccess);
    builder.build()
}

/// Serve S3 requests until the listener fails or the task is cancelled.
async fn serve(listener: TcpListener, store: MemoryS3) -> io::Result<()> {
    let service = service(store);
    let connections = ConnectionBuilder::new(TokioExecutor::new());

    loop {
        let (stream, peer) = listener.accept().await?;
        let connection = connections
            .serve_connection(TokioIo::new(stream), service.clone())
            .into_owned();
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("chaos3: connection from {peer} failed: {error}");
            }
        });
    }
}

/// Hand the bound endpoint to a supervisor through a descriptor it opened.
///
/// Closing the descriptor afterwards lets a supervisor read to end of file:
/// it then holds the whole announcement, or nothing if chaos3 exited first.
fn announce_ready(fd: RawFd, address: SocketAddr) -> io::Result<()> {
    use std::io::Write as _;
    use std::os::fd::FromRawFd as _;

    // SAFETY: the supervisor opened this descriptor for chaos3 to own, and
    // nothing else in the process refers to it.
    let mut ready = unsafe { std::fs::File::from_raw_fd(fd) };
    writeln!(ready, "http://{address}")
}

/// The value of an option, given inline after `=` or as the next argument.
fn option_value(
    flag: &str,
    inline: Option<String>,
    args: &mut impl Iterator<Item = String>,
    what: &str,
) -> Result<String, String> {
    inline
        .or_else(|| args.next())
        .ok_or_else(|| format!("{flag} requires {what}"))
}

fn parse_u64(flag: &str, value: &str) -> Result<u64, String> {
    value
        .parse()
        .map_err(|error| format!("invalid {flag} {value:?}: {error}"))
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<Args>, String> {
    let mut listen = "127.0.0.1:9000".parse().expect("static socket address");
    let mut ready_fd = None;
    let mut buckets = Vec::new();
    let mut failpoints = Vec::new();
    let mut point_names = BTreeSet::new();
    let mut fault_seed = None;
    let mut chaos_profile = false;
    // A chaos count creates its configuration, which is only valid once the
    // profile is also named.
    let mut chaos: Option<ChaosConfig> = None;
    let mut list_failpoints = false;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        // Options take their value either as the next argument or after an
        // `=`; everything after the first `=` is the value, `=` included.
        let (flag, inline) = match arg.split_once('=') {
            Some((
                flag @ ("--listen"
                | "--ready-fd"
                | "--bucket"
                | "--failpoint"
                | "--fault-seed"
                | "--chaos"
                | "--chaos-warmup-requests"
                | "--chaos-requests"),
                value,
            )) => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "-h" | "--help" => return Ok(None),
            "--list-failpoints" => list_failpoints = true,
            "--chaos" => {
                let value = option_value(flag, inline, &mut args, "a profile name")?;
                if value != PROFILE {
                    return Err(format!(
                        "unknown chaos profile {value:?}; expected {PROFILE}"
                    ));
                }
                chaos_profile = true;
            }
            "--chaos-trace" => chaos.get_or_insert_default().trace = true,
            "--chaos-warmup-requests" | "--chaos-requests" => {
                let value = option_value(flag, inline, &mut args, "an unsigned 64-bit integer")?;
                let count = parse_u64(flag, &value)?;
                let chaos = chaos.get_or_insert_default();
                if flag == "--chaos-warmup-requests" {
                    chaos.warmup_requests = count;
                } else {
                    if count == 0 {
                        return Err("--chaos-requests must be positive".to_owned());
                    }
                    chaos.requests = Some(count);
                }
            }
            "--listen" => {
                let value = option_value(flag, inline, &mut args, "an address")?;
                listen = value
                    .parse()
                    .map_err(|error| format!("invalid --listen address {value:?}: {error}"))?;
            }
            "--ready-fd" => {
                let value = option_value(flag, inline, &mut args, "a descriptor number")?;
                ready_fd = Some(
                    value
                        .parse::<RawFd>()
                        .ok()
                        .filter(|fd| *fd >= 0)
                        .ok_or_else(|| {
                            format!("invalid {flag} {value:?}: expected a descriptor number")
                        })?,
                );
            }
            "--bucket" => {
                let value = option_value(flag, inline, &mut args, "a name")?;
                buckets.push(validated_bucket(&value)?);
            }
            "--failpoint" => {
                let value = option_value(flag, inline, &mut args, "NAME=PLAN")?;
                let (name, plan) = value
                    .split_once('=')
                    .ok_or("--failpoint requires NAME=PLAN")?;
                let name = name.trim();
                if !POINT_NAMES.contains(&name) {
                    return Err(format!("unknown failpoint {name:?}; use --list-failpoints"));
                }
                if !point_names.insert(name.to_owned()) {
                    return Err(format!("duplicate --failpoint name {name:?}"));
                }
                let plan = FaultPlan::parse(name, plan)
                    .map_err(|error| format!("invalid --failpoint {name:?}: {error}"))?;
                failpoints.push((name.to_owned(), plan));
            }
            "--fault-seed" => {
                let value = option_value(flag, inline, &mut args, "an unsigned 64-bit integer")?;
                fault_seed = Some(parse_u64(flag, &value)?);
            }
            _ => return Err(format!("unknown argument {arg:?}")),
        }
    }

    if chaos.is_some() && !chaos_profile {
        return Err("--chaos-* options require --chaos".to_owned());
    }
    if chaos_profile && !failpoints.is_empty() {
        return Err("--chaos is incompatible with --failpoint".to_owned());
    }
    let chaos = chaos_profile.then(|| chaos.unwrap_or_default());
    if chaos.is_some_and(|chaos| {
        chaos
            .requests
            .is_some_and(|n| chaos.warmup_requests.checked_add(n).is_none())
    }) {
        return Err(
            "chaos warmup plus active requests exceeds the unsigned 64-bit range".to_owned(),
        );
    }

    if buckets.is_empty() {
        buckets.push("celld".to_owned());
    }
    Ok(Some(Args {
        listen,
        ready_fd,
        buckets,
        failpoints,
        fault_seed,
        chaos,
        list_failpoints,
    }))
}

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(Some(args)) => args,
        Ok(None) => {
            print!("{USAGE}");
            return Ok(());
        }
        Err(error) => {
            eprintln!("chaos3: {error}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    if args.list_failpoints {
        for name in POINT_NAMES {
            println!("{name}");
        }
        return Ok(());
    }
    let injector = args
        .fault_seed
        .map_or_else(Injector::new, Injector::with_seed);
    let mut store = MemoryS3::with_buckets_and_faults(&args.buckets, injector);
    for (name, plan) in args.failpoints {
        store.faults().configure(&name, plan)?;
    }
    eprintln!("chaos3 fault seed: {}", store.faults().seed());
    if let Some(config) = args.chaos {
        let chaos = Chaos::new(store.faults().seed(), config)?;
        store = store.with_chaos(chaos.clone());
        chaos.announce();
        tokio::spawn(async move {
            // Reporting time has no role in admission, RNG, or phase decisions.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                chaos.report();
            }
        });
    }
    let listener = TcpListener::bind(args.listen).await?;
    let address = listener.local_addr()?;
    if let Some(fd) = args.ready_fd {
        announce_ready(fd, address)?;
    }
    println!("chaos3 listening on http://{address}");
    println!("chaos3 buckets: {}", args.buckets.join(", "));
    serve(listener, store).await?;
    Ok(())
}

mod chaos;
mod faults;
mod handlers;
mod memory;

#[cfg(test)]
#[path = "tests/args_test.rs"]
mod args_test;
#[cfg(test)]
#[path = "tests/memory_test.rs"]
mod memory_test;
