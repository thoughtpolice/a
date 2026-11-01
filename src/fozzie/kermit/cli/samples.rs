// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! The data generators of `-g`, which pick or make each sample to mutate.

use anyhow::{Context, Result, bail};
use kermit::{Rng, Source, generate};
use std::fs;
use std::path::{Path, PathBuf};

/// radamsa's default generators and priorities. Standard input wins when
/// it is among the paths, and otherwise files win over splices.
pub const DEFAULT_GENERATORS: &str = "random,file=1000,jump=200,stdin=100000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generator {
    Random,
    File,
    Jump,
    Stdin,
}

impl Generator {
    pub const ALL: [Generator; 4] = [
        Generator::Random,
        Generator::File,
        Generator::Jump,
        Generator::Stdin,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Generator::Random => "random",
            Generator::File => "file",
            Generator::Jump => "jump",
            Generator::Stdin => "stdin",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Generator::Random => "generate random data",
            Generator::File => "read data from one of the given files",
            Generator::Jump => "splice two of the given files where they share context",
            Generator::Stdin => {
                "read data from standard input if no paths are given or - is among them"
            }
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|generator| generator.name() == name)
    }
}

/// One sample, and the paths it came from.
pub struct Sample {
    pub data: Vec<u8>,
    pub generator: Generator,
    pub paths: Vec<PathBuf>,
}

pub struct Samples {
    generators: Vec<(Generator, u32)>,
    files: Vec<PathBuf>,
    stdin: Vec<u8>,
}

impl Samples {
    /// Parses a generator list such as `random,file=1000` and keeps the
    /// generators that `paths` let run. `-` among the paths stands for
    /// standard input, which `read_stdin` reads once, if `stdin` runs.
    /// With `recursive`, a directory stands for the files under it.
    pub fn new(
        list: &str,
        paths: &[PathBuf],
        recursive: bool,
        read_stdin: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<Self> {
        let mut files = Vec::new();
        for path in paths.iter().filter(|path| path.as_os_str() != "-") {
            collect(path, recursive, &mut files)?;
        }
        let stdin = paths.iter().any(|path| path.as_os_str() == "-");
        let mut generators = Vec::new();
        for (generator, priority) in parse(list)? {
            let runs = match generator {
                Generator::Random => true,
                Generator::File | Generator::Jump => !files.is_empty(),
                Generator::Stdin => stdin,
            };
            if runs && priority > 0 {
                generators.push((generator, priority));
            }
        }
        if generators.is_empty() {
            bail!(
                "none of the generators {list:?} can run. file and jump need sample files, and stdin needs - or no paths"
            );
        }
        let stdin = if generators
            .iter()
            .any(|&(generator, _)| generator == Generator::Stdin)
        {
            read_stdin().context("cannot read standard input")?
        } else {
            Vec::new()
        };
        Ok(Self {
            generators,
            files,
            stdin,
        })
    }

    /// The sample files, in the order given, with directories expanded.
    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }

    /// Picks a generator by priority and runs it.
    pub fn next(&self, rng: &mut Rng) -> Result<Sample> {
        let total = self
            .generators
            .iter()
            .map(|&(_, priority)| priority as usize)
            .sum();
        let mut pick = rng.below(total);
        let generator = self
            .generators
            .iter()
            .find_map(
                |&(generator, priority)| match pick.checked_sub(priority as usize) {
                    Some(rest) => {
                        pick = rest;
                        None
                    }
                    None => Some(generator),
                },
            )
            .expect("the pick is below the total");
        let (data, paths) = match generator {
            Generator::Random => (generate::random(rng), Vec::new()),
            Generator::Stdin => (self.stdin.clone(), Vec::new()),
            Generator::File => {
                let path = &self.files[rng.below(self.files.len())];
                (read(path)?, vec![path.clone()])
            }
            Generator::Jump => {
                let head = &self.files[rng.below(self.files.len())];
                let tail = &self.files[rng.below(self.files.len())];
                let data = generate::jump(rng, &read(head)?, &read(tail)?);
                (data, vec![head.clone(), tail.clone()])
            }
        };
        Ok(Sample {
            data,
            generator,
            paths,
        })
    }
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).with_context(|| format!("cannot read {}", path.display()))
}

/// Parses a radamsa-style generator list, as kermit parses mutator lists.
fn parse(list: &str) -> Result<Vec<(Generator, u32)>> {
    let mut out: Vec<(Generator, u32)> = Vec::new();
    for entry in list.split(',') {
        let (name, priority) = entry.split_once('=').unwrap_or((entry, "1"));
        let Some(generator) = Generator::from_name(name) else {
            bail!("unknown generator {name:?}");
        };
        let Ok(priority) = priority.parse() else {
            bail!("bad priority {priority:?} for generator {name:?}");
        };
        if out.iter().any(|&(seen, _)| seen == generator) {
            bail!("generator {name:?} is listed twice");
        }
        out.push((generator, priority));
    }
    Ok(out)
}

/// Adds `path` to `files`, or with `recursive` the files under it, in
/// name order so that a seed always sees the same list.
fn collect(path: &Path, recursive: bool, files: &mut Vec<PathBuf>) -> Result<()> {
    let metadata = fs::metadata(path).with_context(|| format!("cannot read {}", path.display()))?;
    if !metadata.is_dir() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    if !recursive {
        bail!(
            "{} is a directory. Use -r to include the files under it",
            path.display()
        );
    }
    let mut entries = fs::read_dir(path)
        .with_context(|| format!("cannot list {}", path.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("cannot list {}", path.display()))?;
    entries.sort();
    for entry in entries {
        collect(&entry, recursive, files)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(list: &str, paths: &[&str]) -> Result<Samples> {
        let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        Samples::new(list, &paths, false, || Ok(b"from stdin".to_vec()))
    }

    #[test]
    fn parses_generator_lists() {
        assert_eq!(
            parse("random,file=1000,jump=0").unwrap(),
            [
                (Generator::Random, 1),
                (Generator::File, 1000),
                (Generator::Jump, 0)
            ]
        );
        for (list, error) in [
            ("pcapng", "unknown generator \"pcapng\""),
            ("file=x", "bad priority \"x\" for generator \"file\""),
            ("file,file", "generator \"file\" is listed twice"),
        ] {
            assert_eq!(parse(list).unwrap_err().to_string(), error);
        }
    }

    #[test]
    fn keeps_the_generators_that_can_run() {
        let only = |samples: Samples| {
            samples
                .generators
                .into_iter()
                .map(|(generator, _)| generator)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            only(samples(DEFAULT_GENERATORS, &["-"]).unwrap()),
            [Generator::Random, Generator::Stdin]
        );
        assert_eq!(
            only(samples("random=0,stdin", &["-"]).unwrap()),
            [Generator::Stdin]
        );
        assert_eq!(
            samples("file,jump", &["-"]).err().unwrap().to_string(),
            "none of the generators \"file,jump\" can run. file and jump need sample files, and stdin needs - or no paths"
        );
    }

    #[test]
    fn standard_input_is_read_once_and_only_if_used() {
        let mut rng = Rng::new(1);
        let stdin = samples("stdin", &["-"]).unwrap();
        for _ in 0..3 {
            assert_eq!(stdin.next(&mut rng).unwrap().data, b"from stdin");
        }
        let unread = Samples::new("random", &[PathBuf::from("-")], false, || {
            panic!("standard input is not needed")
        });
        assert!(unread.is_ok());
    }
}
