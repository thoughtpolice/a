// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! `kermit`, a command line in the style of radamsa's.
//!
//! It reads sample files or standard input and writes mutated outputs to
//! standard output, numbered files, or a TCP or UDP peer. A seed makes a
//! run repeatable, and a uniqueness filter drops outputs already written.

mod output;
mod samples;

use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use kermit::{Config, Kermit, Mutator, Pattern, Rng};
use output::{Name, Output};
use samples::{DEFAULT_GENERATORS, Generator, Samples};
use serde_json::json;
use sha1::Digest as _;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, SystemTime};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const ABOUT: &str = "\
Kermit is a general purpose fuzzer. It modifies given sample data in ways
which might expose errors in programs intended to process the data.

Kermit is a Rust port of radamsa, which Aki Helin wrote, initially at
OUSPG. See https://gitlab.com/akihe/radamsa.
";

/// The uniqueness filter forgets what it saw when it fills up, then holds
/// twice as many checksums, up to this many.
const MAX_CHECKSUMS: usize = 1 << 20;

/// How many duplicate outputs in a row end a run, since the samples and
/// mutators may allow no more distinct outputs.
const MAX_DUPLICATES: u32 = 10_000;

#[derive(Debug, Parser)]
#[command(
    name = "kermit",
    version = option_env!("depot_VERSION").unwrap_or("dev"),
    about = "A general purpose black-box fuzzer, ported from radamsa"
)]
struct Cli {
    /// Sample files, or with -r directories of them. A - or no paths at
    /// all reads standard input.
    paths: Vec<PathBuf>,

    /// Where outputs go: - for standard output, a path such as
    /// /tmp/fuzz-%n.%s, :80 to serve each output to one TCP client, or
    /// 127.0.0.1:80 to send each to a TCP server, with /udp for UDP.
    #[arg(short, long, default_value = "-", value_name = "PATTERN")]
    output: String,

    /// How many outputs to write, a number or inf.
    #[arg(
        short = 'n',
        long,
        default_value = "1",
        value_parser = parse_count,
        allow_negative_numbers = true
    )]
    count: Count,

    /// The random seed. Without one kermit picks a seed and, with -v or
    /// -M, reports it.
    #[arg(short, long)]
    seed: Option<u64>,

    /// Which mutations to use, with priorities, as in num=5,ld,bd=0.
    #[arg(short, long, default_value = kermit::DEFAULT_MUTATORS, value_name = "LIST")]
    mutations: String,

    /// Which mutation patterns to use, with priorities.
    #[arg(short, long, default_value = kermit::DEFAULT_PATTERNS, value_name = "LIST")]
    patterns: String,

    /// Which data generators to use, with priorities.
    #[arg(short, long, default_value = DEFAULT_GENERATORS, value_name = "LIST")]
    generators: String,

    /// An AFL or libFuzzer dictionary of tokens for di and dr. May be
    /// repeated.
    #[arg(short = 'D', long, value_name = "FILE")]
    dictionary: Vec<PathBuf>,

    /// Write a JSON line about each output to this file, or - for standard
    /// output, after a first line with the seed.
    #[arg(short = 'M', long, value_name = "FILE")]
    meta: Option<PathBuf>,

    /// Include the files under directories given as paths.
    #[arg(short, long)]
    recursive: bool,

    /// Start writing from the output with this number. Earlier outputs are
    /// made but not written, so a seed's later outputs can be repeated
    /// alone.
    #[arg(short = 'S', long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..))]
    seek: u64,

    /// Keep only the first N bytes of each output.
    #[arg(short = 'T', long, value_name = "N")]
    truncate: Option<usize>,

    /// Sleep this many milliseconds between outputs.
    #[arg(short, long, value_name = "MS")]
    delay: Option<u64>,

    /// List the mutations, patterns and generators.
    #[arg(short, long)]
    list: bool,

    /// How many checksums the uniqueness filter holds at first. 0 turns
    /// the filter off.
    #[arg(short = 'C', long, default_value_t = 10_000, value_name = "N")]
    checksums: usize,

    /// The hash behind the uniqueness filter and %h.
    #[arg(short = 'H', long, value_enum, default_value_t = Hash::Blake3)]
    hash: Hash,

    /// Wrap each output in a template where %f stands for the fuzzed data,
    /// as in "<html>%f</html>".
    #[arg(long, value_name = "TEMPLATE")]
    output_template: Option<String>,

    /// Report the seed and each output on standard error.
    #[arg(short, long)]
    verbose: bool,

    /// Say what kermit is.
    #[arg(short, long)]
    about: bool,
}

/// How many outputs to write. `None` means no limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Count(Option<u64>);

fn parse_count(text: &str) -> Result<Count, String> {
    match text {
        "inf" | "infinity" | "forever" | "-1" => Ok(Count(None)),
        _ => match text.parse::<u64>() {
            Ok(count) if count > 0 => Ok(Count(Some(count))),
            _ => Err("expected a positive number or inf".to_string()),
        },
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Hash {
    Blake3,
    Sha1,
    Sha256,
}

impl Hash {
    fn digest(self, data: &[u8]) -> Vec<u8> {
        match self {
            Hash::Blake3 => blake3::hash(data).as_bytes().to_vec(),
            Hash::Sha1 => sha1::Sha1::digest(data).to_vec(),
            Hash::Sha256 => sha2::Sha256::digest(data).to_vec(),
        }
    }
}

/// Remembers the checksums of written outputs.
struct Seen {
    checksums: HashSet<Vec<u8>>,
    capacity: usize,
}

impl Seen {
    fn new(capacity: usize) -> Self {
        Self {
            checksums: HashSet::new(),
            capacity,
        }
    }

    /// Records `checksum`, and says whether it is new. With no capacity
    /// every checksum is new.
    fn insert(&mut self, checksum: &[u8]) -> bool {
        if self.capacity == 0 {
            return true;
        }
        if self.checksums.len() == self.capacity {
            self.checksums.clear();
            self.capacity = (self.capacity * 2).min(MAX_CHECKSUMS);
        }
        self.checksums.insert(checksum.to_vec())
    }
}

/// The text around `%f` in an output template.
struct Template {
    before: Vec<u8>,
    after: Vec<u8>,
}

impl Template {
    fn parse(template: &str) -> Result<Self> {
        let (Some((before, _)), Some((_, after))) =
            (template.split_once("%f"), template.rsplit_once("%f"))
        else {
            bail!("the output template {template:?} has no %f for the fuzzed data");
        };
        Ok(Self {
            before: before.as_bytes().to_vec(),
            after: after.as_bytes().to_vec(),
        })
    }

    fn wrap(&self, data: Vec<u8>) -> Vec<u8> {
        [&self.before[..], &data, &self.after].concat()
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        // A reader such as `head` that stops early ends the run.
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe) =>
        {
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("kermit: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<()> {
    if cli.about {
        print!("{ABOUT}");
        return Ok(());
    }
    if cli.list {
        print!("{}", list());
        return Ok(());
    }
    let mut tokens = Vec::new();
    for path in &cli.dictionary {
        let text = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
        tokens.extend(kermit::parse_dictionary(&text).with_context(|| path.display().to_string())?);
    }
    let config = Config::parse(&cli.mutations, &cli.patterns)?.dictionary(tokens);
    let paths = if cli.paths.is_empty() {
        vec![PathBuf::from("-")]
    } else {
        cli.paths.clone()
    };
    let samples = Samples::new(&cli.generators, &paths, cli.recursive, || {
        let mut data = Vec::new();
        io::stdin().read_to_end(&mut data)?;
        Ok(data)
    })?;
    let first_suffix = samples
        .files()
        .first()
        .and_then(|path| output::suffix(path))
        .unwrap_or("data");
    let mut output = Output::parse(&cli.output, first_suffix)?;
    if cli.count != Count(Some(1)) && !output.names_each_output() {
        bail!(
            "refusing to write many outputs to the one file {:?}. Add %n, %0Nn or %h to the path",
            cli.output
        );
    }
    let template = cli
        .output_template
        .as_deref()
        .map(Template::parse)
        .transpose()?;
    let mut meta = match &cli.meta {
        None => None,
        Some(path) if path.as_os_str() == "-" => Some(Box::new(io::stdout()) as Box<dyn Write>),
        Some(path) => Some(Box::new(BufWriter::new(
            File::create(path).with_context(|| format!("cannot write to {}", path.display()))?,
        )) as Box<dyn Write>),
    };

    let seed = cli.seed.unwrap_or_else(random_seed);
    if cli.verbose {
        eprintln!("Random seed: {seed}");
    }
    if let Some(meta) = &mut meta {
        writeln!(meta, "{}", json!({ "seed": seed }))?;
    }
    let mut rng = Rng::new(seed);
    let mut engine = Kermit::new(&config, &mut rng);
    let mut seen = Seen::new(cli.checksums);
    let mut duplicates = 0;
    let mut nth = 1;
    let mut written = 0;
    while cli.count.0.is_none_or(|count| written < count) {
        let sample = samples.next(&mut rng)?;
        let mutation = engine.mutate(&mut rng, &sample.data);
        let mut data = match &template {
            Some(template) => template.wrap(mutation.data),
            None => mutation.data,
        };
        if let Some(truncate) = cli.truncate {
            data.truncate(truncate);
        }
        let digest = cli.hash.digest(&data);
        if !seen.insert(&digest) {
            duplicates += 1;
            if duplicates == MAX_DUPLICATES {
                bail!(
                    "stopped after {MAX_DUPLICATES} duplicate outputs in a row. Try other samples or mutations, or turn the filter off with -C 0"
                );
            }
            continue;
        }
        duplicates = 0;
        if nth >= cli.seek {
            let checksum: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            let name = Name {
                nth,
                checksum: &checksum,
                source: sample.paths.first().map(PathBuf::as_path),
            };
            let (destination, length) = output.write(&data, &name)?;
            if cli.verbose {
                eprintln!(" - {nth} to {destination}: {}", human_size(length));
            }
            if let Some(meta) = &mut meta {
                let mut record = json!({
                    "nth": nth,
                    "generator": sample.generator.name(),
                    "pattern": mutation.pattern.name(),
                    "mutations": mutation.applied.iter().map(Mutator::name).collect::<Vec<_>>(),
                    "checksum": checksum,
                    "output": destination.kind(),
                    "length": length,
                });
                let fields = record.as_object_mut().expect("the record is an object");
                match sample.paths.as_slice() {
                    [source] => {
                        fields.insert("source".into(), json!(source.display().to_string()));
                    }
                    [head, tail] => {
                        fields.insert("head".into(), json!(head.display().to_string()));
                        fields.insert("tail".into(), json!(tail.display().to_string()));
                    }
                    _ => {}
                }
                match &destination {
                    output::Destination::Stdout => {}
                    output::Destination::File(path) => {
                        fields.insert("path".into(), json!(path.display().to_string()));
                    }
                    output::Destination::TcpServer(address)
                    | output::Destination::TcpClient(address)
                    | output::Destination::Udp(address) => {
                        fields.insert("address".into(), json!(address.to_string()));
                    }
                }
                writeln!(meta, "{record}")?;
            }
            written += 1;
            if let Some(delay) = cli.delay {
                thread::sleep(Duration::from_millis(delay));
            }
        }
        nth += 1;
    }
    if let Some(meta) = &mut meta {
        meta.flush()?;
    }
    Ok(())
}

/// The text of `--list`.
fn list() -> String {
    let mut out = String::from("Mutations (-m)\n");
    for mutator in Mutator::ALL {
        out.push_str(&format!(
            "  {}: {}\n",
            mutator.name(),
            mutator.description()
        ));
    }
    out.push_str("\nMutation patterns (-p)\n");
    for pattern in Pattern::ALL {
        out.push_str(&format!(
            "  {}: {}\n",
            pattern.name(),
            pattern.description()
        ));
    }
    out.push_str("\nGenerators (-g)\n");
    for generator in Generator::ALL {
        out.push_str(&format!(
            "  {}: {}\n",
            generator.name(),
            generator.description()
        ));
    }
    out
}

/// A seed from the kernel, or failing that from the clock.
fn random_seed() -> u64 {
    let mut bytes = [0; 8];
    match File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)) {
        Ok(()) => u64::from_le_bytes(bytes),
        Err(_) => SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos() as u64),
    }
}

/// A byte count in b, K, M, G or T, rounded down, as radamsa prints it.
fn human_size(mut size: usize) -> String {
    let units = ["b", "K", "M", "G", "T"];
    let mut unit = 0;
    while size >= 1024 && unit + 1 < units.len() {
        size /= 1024;
        unit += 1;
    }
    format!("{size}{}", units[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_counts() {
        assert_eq!(parse_count("3"), Ok(Count(Some(3))));
        for forever in ["inf", "infinity", "forever", "-1"] {
            assert_eq!(parse_count(forever), Ok(Count(None)));
        }
        assert!(parse_count("0").is_err());
        assert!(parse_count("-2").is_err());
    }

    #[test]
    fn wraps_outputs_in_templates() {
        let template = Template::parse("<a>%f</a>").unwrap();
        assert_eq!(template.wrap(b"x".to_vec()), b"<a>x</a>");
        assert!(Template::parse("<a></a>").is_err());
    }

    #[test]
    fn the_filter_forgets_when_full() {
        let mut seen = Seen::new(2);
        assert!(seen.insert(b"a"));
        assert!(!seen.insert(b"a"));
        assert!(seen.insert(b"b"));
        // Full: forget a and b, then hold up to four.
        assert!(seen.insert(b"a"));
        assert_eq!(seen.capacity, 4);
        let mut off = Seen::new(0);
        assert!(off.insert(b"a"));
        assert!(off.insert(b"a"));
    }

    #[test]
    fn prints_sizes_like_radamsa() {
        assert_eq!(human_size(1023), "1023b");
        assert_eq!(human_size(4096), "4K");
        assert_eq!(human_size(5 << 20), "5M");
    }

    #[test]
    fn lists_everything() {
        let list = list();
        for mutator in Mutator::ALL {
            assert!(list.contains(&format!("  {}: ", mutator.name())));
        }
        assert!(list.contains("  jump: "));
    }

    #[test]
    fn the_arguments_hold_together() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
