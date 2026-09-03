// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug)]
pub struct Corpus {
    entries: Vec<Arc<Vec<u8>>>,
    hashes: HashSet<String>,
    output: PathBuf,
    max_input: usize,
}

impl Corpus {
    pub fn load(paths: &[PathBuf], output: PathBuf, max_input: usize) -> Result<Self> {
        fs::create_dir_all(&output)
            .with_context(|| format!("creating corpus directory {}", output.display()))?;
        let mut corpus = Self {
            entries: Vec::new(),
            hashes: HashSet::new(),
            output,
            max_input,
        };
        let mut files = Vec::new();
        collect_files(&corpus.output, &mut files)?;
        for path in paths {
            collect_files(path, &mut files)?;
        }
        files.sort();
        for path in files {
            let input = fs::read(&path)
                .with_context(|| format!("reading seed input {}", path.display()))?;
            if input.len() > max_input {
                bail!(
                    "seed {} is {} bytes, above --max-input {max_input}",
                    path.display(),
                    input.len()
                );
            }
            corpus.insert_memory(input);
        }
        if corpus.entries.is_empty() {
            corpus.insert_memory(Vec::new());
        }
        Ok(corpus)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn get(&self, index: usize) -> Arc<Vec<u8>> {
        Arc::clone(&self.entries[index % self.entries.len()])
    }

    pub fn snapshot_pair(&self, first: usize, second: usize) -> (Arc<Vec<u8>>, Arc<Vec<u8>>) {
        (self.get(first), self.get(second))
    }

    pub fn all(&self) -> Vec<Arc<Vec<u8>>> {
        self.entries.clone()
    }

    pub fn add_interesting(&mut self, input: Vec<u8>) -> Result<bool> {
        if input.len() > self.max_input {
            return Ok(false);
        }
        let hash = digest(&input);
        if self.hashes.contains(&hash) {
            return Ok(false);
        }
        persist_new(&self.output.join(&hash), &input)?;
        self.hashes.insert(hash);
        self.entries.push(Arc::new(input));
        Ok(true)
    }

    fn insert_memory(&mut self, input: Vec<u8>) -> bool {
        let hash = digest(&input);
        if !self.hashes.insert(hash) {
            return false;
        }
        self.entries.push(Arc::new(input));
        true
    }
}

pub fn digest(input: &[u8]) -> String {
    blake3::hash(input).to_hex().to_string()
}

pub fn persist_new(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("content-addressed path has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating temporary file in {}", parent.display()))?;
    temporary
        .write_all(contents)
        .with_context(|| format!("writing temporary file for {}", path.display()))?;
    temporary
        .as_file()
        .sync_all()
        .with_context(|| format!("syncing temporary file for {}", path.display()))?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.error).with_context(|| format!("publishing {}", path.display())),
    }
}

fn collect_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("examining seed path {}", path.display()))?;
    if metadata.is_file() {
        output.push(path.to_path_buf());
    } else if metadata.is_dir() {
        let mut children = fs::read_dir(path)
            .with_context(|| format!("reading seed directory {}", path.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children {
            collect_files(&child.path(), output)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_and_persists_interesting_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let mut corpus = Corpus::load(&[], directory.path().to_path_buf(), 8).unwrap();
        assert_eq!(corpus.len(), 1);
        assert!(corpus.add_interesting(b"new".to_vec()).unwrap());
        assert!(!corpus.add_interesting(b"new".to_vec()).unwrap());
        assert!(directory.path().join(digest(b"new")).is_file());
        let reloaded = Corpus::load(&[], directory.path().to_path_buf(), 8).unwrap();
        assert_eq!(reloaded.len(), 1);
    }

    #[test]
    fn failed_publication_does_not_poison_the_in_memory_hash_set() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("corpus");
        let mut corpus = Corpus::load(&[], output.clone(), 8).unwrap();
        fs::remove_dir(&output).unwrap();

        assert!(corpus.add_interesting(b"retry".to_vec()).is_err());
        fs::create_dir(&output).unwrap();
        assert!(corpus.add_interesting(b"retry".to_vec()).unwrap());
        assert_eq!(fs::read(output.join(digest(b"retry"))).unwrap(), b"retry");
    }
}
