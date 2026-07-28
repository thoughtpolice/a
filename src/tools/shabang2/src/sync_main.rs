// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! shabang2-sync — publish a manifest's artifacts to a remote REAPI cache.
//!
//! Deliberately a separate binary from the launcher. Publishing is an
//! outward-facing act with its own credentials, concurrency and failure
//! modes; folding it into the shebang path would put upload latency on the
//! critical path of every tool invocation in the tree.
//!
//! One invocation covers **every platform** in **every** manifest named on the
//! command line, so a single run from any machine populates the cache for
//! linux/macos/windows alike. That is possible because this tool only ever
//! handles raw artifact bytes: it verifies size and digest and never extracts,
//! so it needs no ability to unpack or run foreign-platform binaries.
//!
//! Unlike the launcher, this is a foreground command a human ran on purpose,
//! so it reports what it is doing.

mod http;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::Parser;
use dotslash_manifest::{HashAlgorithm, PlatformEntry, parse_manifest_file};
use futures::StreamExt as _;
use reapi_client::{ConnectOptions, Digest, DigestFunction, ReapiClient};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Attempts per provider URL before moving to the next one.
const FETCH_ATTEMPTS: u32 = 3;

/// Initial backoff between attempts; doubles each time.
const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);

/// Publish DotSlash manifest artifacts to a remote REAPI cache.
#[derive(Parser)]
#[command(name = "shabang2-sync", version = "0.1.0")]
struct Cli {
    /// REAPI server URL.
    #[arg(
        short,
        long,
        env = "SHABANG2_REMOTE_CACHE",
        default_value = "http://127.0.0.1:8080"
    )]
    server: String,

    /// Instance name for REAPI requests.
    #[arg(short, long, env = "SHABANG2_REMOTE_INSTANCE", default_value = "")]
    instance: String,

    /// Maximum artifacts in flight at once.
    #[arg(short = 'j', long, default_value_t = 4)]
    jobs: usize,

    /// Only sync these platform keys. Repeatable; defaults to every platform
    /// in each manifest.
    #[arg(short, long)]
    platform: Vec<String>,

    /// Manifest files to publish.
    #[arg(required = true)]
    manifests: Vec<PathBuf>,
}

/// One artifact to publish: a single platform's entry from a single manifest.
struct Item {
    label: String,
    entry: PlatformEntry,
}

impl Item {
    fn function(&self) -> DigestFunction {
        // Manifest hash algorithms map one-to-one onto REAPI digest
        // functions, which is what lets a manifest digest double as a CAS
        // digest with no translation.
        match self.entry.hash {
            HashAlgorithm::Sha256 => DigestFunction::Sha256,
            HashAlgorithm::Blake3 => DigestFunction::Blake3,
        }
    }

    fn digest(&self) -> Result<Digest> {
        let size = i64::try_from(self.entry.size)
            .with_context(|| format!("{}: size {} is out of range", self.label, self.entry.size))?;
        Ok(Digest::new(self.entry.digest.clone(), size))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();

    let items = collect_items(&cli.manifests, &cli.platform)?;
    if items.is_empty() {
        bail!("no platform entries matched");
    }
    eprintln!(
        "syncing {} artifact(s) from {} manifest(s) to {}",
        items.len(),
        cli.manifests.len(),
        cli.server
    );

    let client = ReapiClient::connect(
        ConnectOptions::new(&cli.server).instance_name(&cli.instance),
    )
    .await
    .with_context(|| format!("connecting to {}", cli.server))?;

    let present = probe_present(client.clone(), &items).await?;

    // Each artifact runs the whole download -> verify -> upload -> push chain
    // independently. A failure is recorded and skipped rather than aborting:
    // one dead mirror should not discard everything else that succeeded.
    let results = futures::stream::iter(items.iter().zip(present).map(|(item, already_present)| {
        let mut client = client.clone();
        async move {
            let outcome = sync_item(&mut client, item, already_present).await;
            (item, outcome)
        }
    }))
    .buffer_unordered(cli.jobs.max(1))
    .collect::<Vec<_>>()
    .await;

    let mut failures = Vec::new();
    for (item, outcome) in results {
        match outcome {
            Ok(uploaded) => eprintln!(
                "  ok   {} ({})",
                item.label,
                if uploaded { "uploaded" } else { "already present" }
            ),
            Err(err) => {
                eprintln!("  FAIL {}: {err:#}", item.label);
                failures.push(item.label.clone());
            }
        }
    }

    if failures.is_empty() {
        eprintln!("synced {} artifact(s)", items.len());
        Ok(())
    } else {
        bail!(
            "{} of {} artifact(s) failed: {}",
            failures.len(),
            items.len(),
            failures.join(", ")
        )
    }
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_env("SHABANG2_LOG").unwrap_or_else(|_| EnvFilter::new("off"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

/// Read every manifest and flatten it into one artifact per platform entry,
/// in a stable order (manifest order, then platform key) so that runs are
/// reproducible and output is diffable.
fn collect_items(manifests: &[PathBuf], platforms: &[String]) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    for path in manifests {
        let manifest = parse_manifest_file(path)
            .with_context(|| format!("failed to load: {}", path.display()))?;

        let sorted: BTreeMap<_, _> = manifest.platforms.iter().collect();
        for (platform, entry) in sorted {
            if !platforms.is_empty() && !platforms.iter().any(|p| p == platform) {
                continue;
            }
            items.push(Item {
                label: format!("{}/{}", manifest.name, platform),
                entry: entry.clone(),
            });
        }
    }
    Ok(items)
}

/// Ask the server which artifacts it already holds, returning one flag per
/// item in `items` order.
///
/// Indexed by position rather than keyed by label, because two manifests may
/// legitimately share a `name` and so produce identical labels.
///
/// `FindMissingBlobsRequest` carries a single `digest_function`, so a mixed
/// SHA-256/BLAKE3 set costs one request per function — two, regardless of how
/// many artifacts are involved.
async fn probe_present(mut client: ReapiClient, items: &[Item]) -> Result<Vec<bool>> {
    let mut present = vec![true; items.len()];

    for function in [DigestFunction::Sha256, DigestFunction::Blake3] {
        let group: Vec<(usize, Digest)> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.function() == function)
            .map(|(index, item)| item.digest().map(|digest| (index, digest)))
            .collect::<Result<_>>()?;
        if group.is_empty() {
            continue;
        }

        let digests: Vec<Digest> = group.iter().map(|(_, digest)| digest.clone()).collect();
        let missing = client
            .find_missing(function, &digests)
            .await
            .with_context(|| format!("probing {function} digests"))?;

        for (index, digest) in &group {
            if missing.contains(digest) {
                present[*index] = false;
            }
        }
    }

    Ok(present)
}

/// Download (if needed), verify, upload, and map one artifact.
///
/// Returns whether an upload actually happened.
async fn sync_item(client: &mut ReapiClient, item: &Item, already_present: bool) -> Result<bool> {
    let function = item.function();
    let digest = item.digest()?;

    let uploaded = if already_present {
        false
    } else {
        let data = fetch_from_providers(item).await?;

        // Verify before publishing. Everything downstream trusts that a
        // mapping in the cache names the bytes the manifest describes, so a
        // corrupt or substituted download must never reach the store.
        let actual = Digest::of(function, &data);
        if actual != digest {
            bail!(
                "artifact does not match the manifest:\n  expected {digest}\n  got      {actual}"
            );
        }

        client
            .write_blob(function, &digest, bytes::Bytes::from(data))
            .await
            .context("uploading to CAS")?;
        true
    };

    // Record the URI mappings even when the blob was already present: a blob
    // in the CAS does not imply anyone recorded which URL produced it.
    let uris: Vec<String> = item
        .entry
        .providers
        .iter()
        .map(|provider| provider.url.clone())
        .collect();

    client
        .push_blob(function, &digest, &uris, &[])
        .await
        .context("recording the bare-URI asset mapping")?;

    // A second mapping under `checksum.sri`, so clients that present a
    // checksum qualifier (as Bazel-style ones do) also get a hit. Qualifiers
    // are part of the asset lookup key, so the bare mapping alone would not
    // be found by them. BLAKE3 has no SRI encoding, so it gets only the bare
    // form.
    if let Some(sri) = digest.to_sri(function) {
        client
            .push_blob(
                function,
                &digest,
                &uris,
                &[("checksum.sri".to_string(), sri)],
            )
            .await
            .context("recording the checksum.sri asset mapping")?;
    }

    Ok(uploaded)
}

/// Try each provider in order, retrying each with exponential backoff before
/// falling through to the next.
async fn fetch_from_providers(item: &Item) -> Result<Vec<u8>> {
    let mut last_err = None;

    for provider in &item.entry.providers {
        match fetch_with_retry(&provider.url).await {
            Ok(data) => return Ok(data),
            Err(err) => {
                tracing::warn!(url = %provider.url, %err, "provider failed");
                last_err = Some(err.context(format!("provider {}", provider.url)));
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no providers configured")))
}

async fn fetch_with_retry(url: &str) -> Result<Vec<u8>> {
    let mut delay = RETRY_BASE_DELAY;
    let mut last_err = None;

    for attempt in 1..=FETCH_ATTEMPTS {
        match http::fetch_url(url).await {
            Ok(data) => return Ok(data),
            Err(err) => {
                tracing::warn!(url, attempt, %err, "fetch failed");
                last_err = Some(err);
                if attempt < FETCH_ATTEMPTS {
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                }
            }
        }
    }

    Err(last_err.expect("at least one attempt was made"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use dotslash_manifest::{ArchiveFormat, Provider};

    fn write_manifest(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    const TWO_PLATFORMS: &str = r#"#!/usr/bin/env shabang2
{
  "name": "tool",
  "platforms": {
    "linux-x86_64": {
      "size": 1,
      "hash": "sha256",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "path": "t",
      "providers": [{ "url": "https://example.com/a" }]
    },
    "macos-aarch64": {
      "size": 2,
      "hash": "blake3",
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "path": "t",
      "providers": [{ "url": "https://example.com/b" }]
    }
  }
}"#;

    /// Every platform is published, not just the host's — that is the whole
    /// point of syncing from one machine.
    #[test]
    fn collects_every_platform_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(dir.path(), "tool.json", TWO_PLATFORMS);

        let items = collect_items(&[path], &[]).unwrap();
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();

        assert_eq!(labels, vec!["tool/linux-x86_64", "tool/macos-aarch64"]);
    }

    #[test]
    fn platform_filter_narrows_the_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(dir.path(), "tool.json", TWO_PLATFORMS);

        let items = collect_items(&[path], &["macos-aarch64".to_string()]).unwrap();
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();

        assert_eq!(labels, vec!["tool/macos-aarch64"]);
    }

    /// Ordering must not depend on HashMap iteration order, or output and
    /// scheduling would vary run to run.
    #[test]
    fn ordering_is_stable_across_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(dir.path(), "tool.json", TWO_PLATFORMS);

        let first: Vec<String> = collect_items(&[path.clone()], &[])
            .unwrap()
            .iter()
            .map(|i| i.label.clone())
            .collect();
        for _ in 0..8 {
            let again: Vec<String> = collect_items(&[path.clone()], &[])
                .unwrap()
                .iter()
                .map(|i| i.label.clone())
                .collect();
            assert_eq!(first, again);
        }
    }

    #[test]
    fn each_hash_algorithm_maps_to_its_digest_function() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(dir.path(), "tool.json", TWO_PLATFORMS);
        let items = collect_items(&[path], &[]).unwrap();

        assert_eq!(items[0].function(), DigestFunction::Sha256);
        assert_eq!(items[1].function(), DigestFunction::Blake3);
    }

    #[test]
    fn digest_carries_the_manifest_values_unchanged() {
        let item = Item {
            label: "x".to_string(),
            entry: PlatformEntry {
                size: 4242,
                hash: HashAlgorithm::Sha256,
                digest: "c".repeat(64),
                format: ArchiveFormat::Zst,
                path: "t".to_string(),
                providers: vec![Provider {
                    url: "https://example.com/x".to_string(),
                }],
            },
        };

        let digest = item.digest().unwrap();
        assert_eq!(digest.hash, "c".repeat(64));
        assert_eq!(digest.size, 4242);
    }
}
