// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::cli::{ReplayOptions, TargetOptions};
use crate::corpus::{digest, persist_new};
use crate::executor::{ExecutorConfig, Finding, FindingKind};
use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ArtifactSink {
    directory: PathBuf,
    target: PathBuf,
    target_label: Option<String>,
    target_digest: String,
    target_args: Vec<OsString>,
    timeout_ms: u64,
    max_input: usize,
    feature_capacity: usize,
    cmp_capacity: usize,
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
    target: String,
    target_label: Option<&'a str>,
    target_digest: &'a str,
    target_args: Vec<String>,
    timeout_ms: u64,
    max_input: usize,
    feature_capacity: usize,
    cmp_capacity: usize,
    campaign_seed: u64,
    sanitizer: &'a str,
    execution: u64,
    stderr: String,
    repro: &'a str,
    replay: ReplayManifest,
}

// Display strings in finding metadata may replace invalid UTF-8. These
// fields carry the original bytes and make large findings replayable without
// putting their entire input in a single command-line argument.
#[derive(Serialize, Deserialize)]
struct ReplayManifest {
    target_base64: String,
    target_args_base64: Vec<String>,
    input_base64: String,
    timeout_ms: u64,
    max_input: usize,
    feature_capacity: usize,
    cmp_capacity: usize,
}

#[derive(Deserialize)]
struct ReplayDocument {
    schema_version: u32,
    target_digest: String,
    input_digest: String,
    replay: ReplayManifest,
}

pub fn replay_options(metadata: &Path) -> Result<ReplayOptions> {
    let file = fs::File::open(metadata)
        .with_context(|| format!("opening replay artifact {}", metadata.display()))?;
    let document: ReplayDocument =
        serde_json::from_reader(BufReader::new(file)).context("reading replay artifact")?;
    ensure!(
        document.schema_version == 3,
        "unsupported replay artifact schema"
    );
    let manifest = document.replay;
    let decode_os = |encoded: &str| -> Result<OsString> {
        Ok(OsString::from_vec(
            STANDARD
                .decode(encoded)
                .context("decoding replay argument")?,
        ))
    };
    let target = PathBuf::from(decode_os(&manifest.target_base64)?);
    ensure!(
        digest_file(&target)? == document.target_digest,
        "replay target digest has changed"
    );
    let input = STANDARD
        .decode(&manifest.input_base64)
        .context("decoding replay input")?;
    ensure!(
        input.len() <= manifest.max_input,
        "replay input exceeds --max-input"
    );
    ensure!(
        digest(&input) == document.input_digest,
        "replay input digest does not match artifact"
    );
    Ok(ReplayOptions {
        target: TargetOptions {
            target,
            target_args: manifest
                .target_args_base64
                .iter()
                .map(|argument| decode_os(argument))
                .collect::<Result<_>>()?,
            timeout_ms: manifest.timeout_ms,
            max_input: manifest.max_input,
            feature_capacity: manifest.feature_capacity,
            cmp_capacity: manifest.cmp_capacity,
        },
        input: None,
        base64: Some(manifest.input_base64),
        expect_finding: false,
    })
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
        config: &ExecutorConfig,
        target_label: Option<String>,
        campaign_seed: u64,
        sanitizer: String,
    ) -> Result<Self> {
        let directory = workdir.join("artifacts");
        fs::create_dir_all(&directory)
            .with_context(|| format!("creating artifact directory {}", directory.display()))?;
        let target_digest = digest_file(&config.target)?;
        Ok(Self {
            directory,
            target: config.target.clone(),
            target_label,
            target_digest,
            target_args: config.target_args.clone(),
            timeout_ms: config.timeout.as_millis() as u64,
            max_input: config.max_input,
            feature_capacity: config.feature_capacity,
            cmp_capacity: config.cmp_capacity,
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

        let replay = ReplayManifest {
            target_base64: STANDARD.encode(self.target.as_os_str().as_bytes()),
            target_args_base64: self
                .target_args
                .iter()
                .map(|argument| STANDARD.encode(argument.as_bytes()))
                .collect(),
            input_base64: STANDARD.encode(input),
            timeout_ms: self.timeout_ms,
            max_input: self.max_input,
            feature_capacity: self.feature_capacity,
            cmp_capacity: self.cmp_capacity,
        };
        let repro = self
            .reproduction_command(&replay.input_base64)
            .unwrap_or_else(|| {
                format!(
                    "buck2 run root//src/fozzie/engine:fozzie -- replay-artifact {}",
                    shell_word(&metadata_path)
                )
            });
        let metadata = FindingMetadata {
            schema_version: 3,
            fozzie_version: option_env!("DEPOT_VERSION").unwrap_or("development"),
            instrumentation_schema: "fozzie-sancov-v1",
            kind: &finding.kind,
            confirmed,
            detail: &finding.detail,
            input_digest: &input_digest,
            input_size: input.len(),
            target: self.target.to_string_lossy().into_owned(),
            target_label: self.target_label.as_deref(),
            target_digest: &self.target_digest,
            target_args: self
                .target_args
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect(),
            timeout_ms: self.timeout_ms,
            max_input: self.max_input,
            feature_capacity: self.feature_capacity,
            cmp_capacity: self.cmp_capacity,
            campaign_seed: self.campaign_seed,
            sanitizer: &self.sanitizer,
            execution,
            stderr: String::from_utf8_lossy(&finding.stderr).into_owned(),
            repro: &repro,
            replay,
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

    fn reproduction_command(&self, encoded: &str) -> Option<String> {
        const MAX_INLINE_COMMAND_BYTES: usize = 32 * 1024;
        if encoded.len() > MAX_INLINE_COMMAND_BYTES {
            return None;
        }
        let mut command = format!(
            "buck2 run root//src/fozzie/engine:fozzie -- replay --target {}",
            shell_quote(self.target.to_str()?)
        );
        for argument in &self.target_args {
            command.push_str(" --target-arg ");
            command.push_str(&shell_quote(argument.to_str()?));
            if command.len() > MAX_INLINE_COMMAND_BYTES {
                return None;
            }
        }
        command.push_str(&format!(
            " --timeout-ms {} --max-input {} --feature-capacity {} --cmp-capacity {} --base64 {}",
            self.timeout_ms,
            self.max_input,
            self.feature_capacity,
            self.cmp_capacity,
            shell_quote(encoded),
        ));
        (command.len() <= MAX_INLINE_COMMAND_BYTES).then_some(command)
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
    use std::ffi::OsString;
    use std::time::Duration;

    #[test]
    fn quotes_reproduction_arguments() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn records_input_and_machine_readable_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        fs::write(&target, b"binary").unwrap();
        let config = ExecutorConfig {
            target,
            target_args: vec![OsString::from("--mode=a b")],
            max_input: 4096,
            timeout: Duration::from_millis(77),
            feature_capacity: 123,
            cmp_capacity: 45,
        };
        let sink = ArtifactSink::new(
            directory.path(),
            &config,
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
        assert_eq!(metadata["schema_version"], 3);
        assert_eq!(metadata["target_args"][0], "--mode=a b");
        assert_eq!(metadata["timeout_ms"], 77);
        assert_eq!(metadata["max_input"], 4096);
        assert!(
            recorded
                .repro
                .starts_with("buck2 run root//src/fozzie/engine:fozzie -- replay")
        );
        assert!(recorded.repro.contains("--target-arg '--mode=a b'"));
        assert!(recorded.repro.contains("--timeout-ms 77"));
        assert!(recorded.repro.contains("--base64 'YmFk'"));
        let replay = replay_options(&recorded.metadata_path).unwrap();
        assert_eq!(replay.target.target_args, config.target_args);
        assert_eq!(replay.target.target, config.target);
        assert_eq!(replay.base64.as_deref(), Some("YmFk"));

        let mut corrupted = metadata.clone();
        corrupted["replay"]["input_base64"] = "YWJj".into();
        fs::write(
            &recorded.metadata_path,
            serde_json::to_vec(&corrupted).unwrap(),
        )
        .unwrap();
        assert!(
            replay_options(&recorded.metadata_path)
                .unwrap_err()
                .to_string()
                .contains("input digest")
        );
        fs::write(
            &recorded.metadata_path,
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        fs::write(&config.target, b"different binary").unwrap();
        assert!(
            replay_options(&recorded.metadata_path)
                .unwrap_err()
                .to_string()
                .contains("target digest")
        );
    }
}
