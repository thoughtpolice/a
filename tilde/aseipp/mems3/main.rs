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

use faultline::{BuggifyConfig, Injector, Plan, Probability};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnectionBuilder;
use s3s::S3Result;
use s3s::access::{S3Access, S3AccessContext};
use s3s::auth::SimpleAuth;
use s3s::service::{S3Service, S3ServiceBuilder};
use tokio::net::TcpListener;

use chaos::{Chaos, ChaosConfig};
use faults::{POINT_NAMES, S3Fault};
use memory::MemoryS3;

const USAGE: &str = r#"Usage: mems3 [OPTIONS]

An ephemeral S3-compatible server for tests.

Options:
  --listen ADDRESS              Socket address to bind (default: 127.0.0.1:9000)
  --bucket NAME                 Pre-create a bucket; may be repeated (default: celld)
  --failpoint NAME=PLAN         Configure a named point; may be repeated
  --list-failpoints             List available points and exit
  --fault-seed SEED             Seed fault decisions with an unsigned 64-bit integer
  --buggify                     Enable random request yields and SlowDown errors
  --buggify-activation PERCENT  Site activation probability (default: 25; requires --buggify)
  --buggify-firing PERCENT      Per-visit firing probability (default: 25; requires --buggify)
  --auto-buggify                Run the seeded storage-v1 chaos profile
  --chaos-warmup-requests N     Admit N healthy requests first (default: 0)
  --chaos-requests N            Inject during N requests, then recover (default: unlimited)
  --chaos-trace                 Log every automatic boundary decision to stderr
  -h, --help                    Show this help

Plans: [percent%][count*]action[(payload)] joined by -> (ordered fallbacks).
Actions: off, return, sleep(milliseconds), pause, yield, panic(message).
Errors: InternalError (default), SlowDown, ServiceUnavailable, RequestTimeout, AccessDenied.
Example: --failpoint 's3.get_object.before=2*return(SlowDown)'
Automatic chaos options require --auto-buggify; incompatible with --buggify/--failpoint.
"#;

/// Access key accepted by the test server's SigV4/SigV2 verifier.
const ACCESS_KEY_ID: &str = "mems3";

/// Secret key accepted by the test server's SigV4/SigV2 verifier.
const SECRET_ACCESS_KEY: &str = "mems3";

#[derive(Debug)]
struct Args {
    listen: SocketAddr,
    buckets: Vec<String>,
    failpoints: Vec<(String, Plan<S3Fault>)>,
    fault_seed: Option<u64>,
    buggify: Option<BuggifyConfig>,
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
                eprintln!("mems3: connection from {peer} failed: {error}");
            }
        });
    }
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<Args>, String> {
    let mut listen = "127.0.0.1:9000".parse().expect("static socket address");
    let mut buckets = Vec::new();
    let mut failpoints = Vec::new();
    let mut point_names = BTreeSet::new();
    let mut fault_seed = None;
    let mut buggify = false;
    let mut buggify_config = BuggifyConfig::default();
    let mut buggify_probabilities_set = false;
    let mut auto_buggify = false;
    let mut chaos = ChaosConfig::default();
    let mut chaos_options_set = false;
    let mut list_failpoints = false;
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        // Options take their value either as the next argument or after an
        // `=`; everything after the first `=` is the value, `=` included.
        let (flag, inline) = match arg.split_once('=') {
            Some((
                flag @ ("--listen"
                | "--bucket"
                | "--failpoint"
                | "--fault-seed"
                | "--buggify-activation"
                | "--buggify-firing"
                | "--chaos-warmup-requests"
                | "--chaos-requests"),
                value,
            )) => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "-h" | "--help" => return Ok(None),
            "--list-failpoints" => list_failpoints = true,
            "--buggify" => buggify = true,
            "--auto-buggify" => auto_buggify = true,
            "--chaos-trace" => {
                chaos.trace = true;
                chaos_options_set = true;
            }
            "--chaos-warmup-requests" | "--chaos-requests" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or_else(|| format!("{flag} requires an unsigned 64-bit integer"))?;
                let count = value
                    .parse::<u64>()
                    .map_err(|error| format!("invalid {flag} {value:?}: {error}"))?;
                if flag == "--chaos-warmup-requests" {
                    chaos.warmup_requests = count;
                } else {
                    if count == 0 {
                        return Err("--chaos-requests must be positive".to_owned());
                    }
                    chaos.requests = Some(count);
                }
                chaos_options_set = true;
            }
            "--listen" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--listen requires an address")?;
                listen = value
                    .parse()
                    .map_err(|error| format!("invalid --listen address {value:?}: {error}"))?;
            }
            "--bucket" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--bucket requires a name")?;
                buckets.push(validated_bucket(&value)?);
            }
            "--failpoint" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--failpoint requires NAME=PLAN")?;
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
                let plan = plan
                    .parse::<Plan<S3Fault>>()
                    .map_err(|error| format!("invalid --failpoint {name:?}: {error}"))?;
                failpoints.push((name.to_owned(), plan));
            }
            "--fault-seed" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or("--fault-seed requires an unsigned 64-bit integer")?;
                fault_seed = Some(
                    value
                        .parse::<u64>()
                        .map_err(|error| format!("invalid --fault-seed {value:?}: {error}"))?,
                );
            }
            "--buggify-activation" | "--buggify-firing" => {
                let value = inline
                    .or_else(|| args.next())
                    .ok_or_else(|| format!("{flag} requires a percentage"))?;
                let invalid = || {
                    format!(
                        "invalid {flag} {value:?}: expected a finite percentage between 0 and 100"
                    )
                };
                let percent = value.parse::<f64>().map_err(|_| invalid())?;
                // Check the percent itself, before division can round or underflow.
                if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
                    return Err(invalid());
                }
                let probability = Probability::new(percent / 100.0).map_err(|_| invalid())?;
                if flag == "--buggify-activation" {
                    buggify_config.activation = probability;
                } else {
                    buggify_config.firing = probability;
                }
                buggify_probabilities_set = true;
            }
            _ => return Err(format!("unknown argument {arg:?}")),
        }
    }

    if buggify_probabilities_set && !buggify {
        return Err("--buggify-activation and --buggify-firing require --buggify".to_owned());
    }
    if chaos_options_set && !auto_buggify {
        return Err("--chaos-* options require --auto-buggify".to_owned());
    }
    if auto_buggify && (buggify || !failpoints.is_empty()) {
        return Err("--auto-buggify is incompatible with --buggify and --failpoint".to_owned());
    }
    if chaos
        .requests
        .is_some_and(|n| chaos.warmup_requests.checked_add(n).is_none())
    {
        return Err(
            "chaos warmup plus active requests exceeds the unsigned 64-bit range".to_owned(),
        );
    }

    if buckets.is_empty() {
        buckets.push("celld".to_owned());
    }
    Ok(Some(Args {
        listen,
        buckets,
        failpoints,
        fault_seed,
        buggify: buggify.then_some(buggify_config),
        chaos: auto_buggify.then_some(chaos),
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
            eprintln!("mems3: {error}\n\n{USAGE}");
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
    if let Some(config) = args.buggify {
        store.faults().buggify().enable(config)?;
    }
    let chaos = args
        .chaos
        .map(|config| Chaos::new(store.faults().seed(), config))
        .transpose()?;
    if let Some(chaos) = &chaos {
        store = store.with_chaos(chaos.clone());
    }
    let listener = TcpListener::bind(args.listen).await?;
    let address = listener.local_addr()?;
    println!("mems3 listening on http://{address}");
    println!("mems3 buckets: {}", args.buckets.join(", "));
    eprintln!("mems3 fault seed: {}", store.faults().seed());
    if let Some(chaos) = chaos {
        chaos.announce();
        tokio::spawn(async move {
            // Reporting time has no role in admission, RNG, or phase decisions.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                chaos.report();
            }
        });
    }
    serve(listener, store).await?;
    Ok(())
}

mod chaos;
mod faults;
mod memory;

#[cfg(test)]
#[path = "tests/args_test.rs"]
mod args_test;
#[cfg(test)]
#[path = "tests/memory_test.rs"]
mod memory_test;
