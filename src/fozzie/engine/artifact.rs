// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::corpus::{digest, persist_new};
use crate::executor::{Finding, FindingKind};
use anyhow::{Context, Result};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ArtifactSink {
    directory: PathBuf,
    target: PathBuf,
    target_label: Option<String>,
    target_digest: String,
    campaign_seed: u64,
    sanitizer: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RecordedFinding {
    pub kind: FindingKind,
    pub confirmed: bool,
    pub input_digest: String,
    pub input_path: PathBuf,
    pub metadata_path: PathBuf,
    pub detail: String,
    pub repro: String,
}

#[derive(Serialize)]
struct FindingMetadata<'a> {
    schema_version: u32,
    fozzie_version: &'static str,
    instrumentation_schema: &'static str,
    kind: &'a FindingKind,
    confirmed: bool,
    detail: &'a str,
    input_digest: &'a str,
    input_size: usize,
    target: &'a Path,
    target_label: Option<&'a str>,
    target_digest: &'a str,
    campaign_seed: u64,
    sanitizer: &'a str,
    execution: u64,
    stderr: String,
    repro: &'a str,
}

fn digest_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("opening target {} for hashing", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let amount = file
            .read(&mut buffer)
            .with_context(|| format!("hashing target {}", path.display()))?;
        if amount == 0 {
            break;
        }
        hasher.update(&buffer[..amount]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

impl ArtifactSink {
    pub fn new(
        workdir: &Path,
        target: PathBuf,
        target_label: Option<String>,
        campaign_seed: u64,
        sanitizer: String,
    ) -> Result<Self> {
        let directory = workdir.join("artifacts");
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating artifact directory {}", directory.display()))?;
        let target_digest = digest_file(&target)?;
        Ok(Self {
            directory,
            target,
            target_label,
            target_digest,
            campaign_seed,
            sanitizer,
        })
    }

    pub fn record(
        &self,
        input: &[u8],
        finding: &Finding,
        confirmed: bool,
        execution: u64,
    ) -> Result<RecordedFinding> {
        let input_digest = digest(input);
        let kind = kind_name(&finding.kind);
        let stem = format!("{kind}-{input_digest}");
        let input_path = self.directory.join(&stem);
        let metadata_path = self.directory.join(format!("{stem}.json"));
        persist_new(&input_path, input)?;

        let encoded = STANDARD.encode(input);
        let repro = format!(
            "fozzie replay --target {} --base64 {}",
            shell_word(&self.target),
            shell_quote(&encoded)
        );
        let metadata = FindingMetadata {
            schema_version: 1,
            fozzie_version: option_env!("DEPOT_VERSION").unwrap_or("development"),
            instrumentation_schema: "fozzie-sancov-v1",
            kind: &finding.kind,
            confirmed,
            detail: &finding.detail,
            input_digest: &input_digest,
            input_size: input.len(),
            target: &self.target,
            target_label: self.target_label.as_deref(),
            target_digest: &self.target_digest,
            campaign_seed: self.campaign_seed,
            sanitizer: &self.sanitizer,
            execution,
            stderr: String::from_utf8_lossy(&finding.stderr).into_owned(),
            repro: &repro,
        };
        let mut bytes =
            serde_json::to_vec_pretty(&metadata).context("encoding finding metadata")?;
        bytes.push(b'\n');
        persist_replace(&metadata_path, &bytes)?;

        Ok(RecordedFinding {
            kind: finding.kind.clone(),
            confirmed,
            input_digest,
            input_path,
            metadata_path,
            detail: finding.detail.clone(),
            repro,
        })
    }
}

fn persist_replace(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("artifact metadata has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating temporary metadata in {}", parent.display()))?;
    temporary
        .write_all(contents)
        .with_context(|| format!("writing temporary metadata for {}", path.display()))?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("publishing metadata {}", path.display()))?;
    Ok(())
}

fn kind_name(kind: &FindingKind) -> &'static str {
    match kind {
        FindingKind::Crash => "crash",
        FindingKind::Hang => "hang",
        FindingKind::NonzeroHarness => "nonzero",
        FindingKind::Exit => "exit",
    }
}

fn shell_word(path: &Path) -> String {
    shell_quote(&path.to_string_lossy())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_reproduction_arguments() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn records_input_and_machine_readable_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::write(&target, b"binary").unwrap();
        let sink = ArtifactSink::new(
            directory.path(),
            target,
            Some("//demo:fuzz".into()),
            7,
            "address".into(),
        )
        .unwrap();
        let finding = Finding {
            kind: FindingKind::Crash,
            detail: "signal 6".into(),
            stderr: b"backtrace".to_vec(),
        };
        let recorded = sink.record(b"bad", &finding, true, 9).unwrap();
        assert_eq!(fs::read(&recorded.input_path).unwrap(), b"bad");
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&recorded.metadata_path).unwrap()).unwrap();
        assert_eq!(metadata["confirmed"], true);
        assert_eq!(metadata["target_label"], "//demo:fuzz");
        assert_eq!(metadata["sanitizer"], "address");
        assert!(recorded.repro.contains("--base64 'YmFk'"));
    }
}
