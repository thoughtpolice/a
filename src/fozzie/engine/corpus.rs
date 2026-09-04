// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
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
        for path in collect_existing_entries(&corpus.output)? {
            let input = read_bounded(&path, max_input)?;
            let expected = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("corpus entry has a non-UTF-8 digest name")?;
            let actual = digest(&input);
            if actual != expected {
                bail!(
                    "corpus entry {} does not match its digest name",
                    path.display()
                );
            }
            corpus.insert_loaded(input, actual);
        }

        let mut files = Vec::new();
        let mut visited_directories = HashSet::from([fs::canonicalize(&corpus.output)?]);
        for path in paths {
            collect_files(path, &mut files, &mut visited_directories)?;
        }
        files.sort();
        for path in files {
            let input = read_bounded(&path, max_input)?;
            corpus.insert_persisted(input)?;
        }
        if corpus.entries.is_empty() {
            corpus.insert_persisted(Vec::new())?;
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
        self.insert_persisted(input)
    }

    fn insert_persisted(&mut self, input: Vec<u8>) -> Result<bool> {
        let hash = digest(&input);
        if self.hashes.contains(&hash) {
            return Ok(false);
        }
        persist_new(&self.output.join(&hash), &input)?;
        let inserted = self.insert_loaded(input, hash);
        debug_assert!(inserted);
        Ok(true)
    }

    fn insert_loaded(&mut self, input: Vec<u8>, hash: String) -> bool {
        if !self.hashes.insert(hash) {
            return false;
        }
        self.entries.push(Arc::new(input));
        true
    }
}

fn collect_existing_entries(output: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = fs::read_dir(output)
        .with_context(|| format!("reading corpus directory {}", output.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    let mut paths = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.len() == 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && entry.file_type()?.is_file()
        {
            paths.push(entry.path());
        }
    }
    Ok(paths)
}

pub fn digest(input: &[u8]) -> String {
    blake3::hash(input).to_hex().to_string()
}

pub fn persist_new(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = publication_parent(path)?;
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
        Ok(_) => sync_parent(parent),
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
            verify_existing(path, contents)
        }
        Err(error) => Err(error.error).with_context(|| format!("publishing {}", path.display())),
    }
}

pub fn persist_replace(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = publication_parent(path)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating temporary file in {}", parent.display()))?;
    temporary
        .write_all(contents)
        .with_context(|| format!("writing temporary file for {}", path.display()))?;
    temporary
        .as_file()
        .sync_all()
        .with_context(|| format!("syncing temporary file for {}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("publishing {}", path.display()))?;
    sync_parent(parent)
}

fn publication_parent(path: &Path) -> Result<&Path> {
    let parent = path.parent().context("publication path has no parent")?;
    Ok(if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    })
}

fn verify_existing(path: &Path, expected: &[u8]) -> Result<()> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("examining existing corpus entry {}", path.display()))?;
    let expected_size = u64::try_from(expected.len()).unwrap_or(u64::MAX);
    if metadata.len() != expected_size {
        bail!(
            "existing corpus entry {} has unexpected contents",
            path.display()
        );
    }
    let mut actual = Vec::with_capacity(expected.len());
    File::open(path)
        .with_context(|| format!("opening existing corpus entry {}", path.display()))?
        .take(expected_size.saturating_add(1))
        .read_to_end(&mut actual)
        .with_context(|| format!("reading existing corpus entry {}", path.display()))?;
    if actual != expected {
        bail!(
            "existing corpus entry {} has unexpected contents",
            path.display()
        );
    }
    Ok(())
}

fn sync_parent(parent: &Path) -> Result<()> {
    File::open(parent)
        .with_context(|| format!("opening directory {} for sync", parent.display()))?
        .sync_all()
        .with_context(|| format!("syncing directory {}", parent.display()))
}

pub(crate) fn read_bounded(path: &Path, max_input: usize) -> Result<Vec<u8>> {
    let mut input = Vec::new();
    let limit = u64::try_from(max_input)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    File::open(path)
        .with_context(|| format!("opening seed input {}", path.display()))?
        .take(limit)
        .read_to_end(&mut input)
        .with_context(|| format!("reading seed input {}", path.display()))?;
    if input.len() > max_input {
        bail!(
            "seed {} is larger than --max-input {max_input}",
            path.display()
        );
    }
    Ok(input)
}

fn collect_files(
    path: &Path,
    output: &mut Vec<PathBuf>,
    visited_directories: &mut HashSet<PathBuf>,
) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("examining seed path {}", path.display()))?;
    if metadata.is_file() {
        output.push(path.to_path_buf());
    } else if metadata.is_dir() {
        let canonical = fs::canonicalize(path)
            .with_context(|| format!("resolving seed directory {}", path.display()))?;
        if !visited_directories.insert(canonical) {
            return Ok(());
        }
        let mut children = fs::read_dir(path)
            .with_context(|| format!("reading seed directory {}", path.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children {
            collect_files(&child.path(), output, visited_directories)?;
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
        assert_eq!(reloaded.len(), 2);
    }

    #[test]
    fn failed_publication_does_not_poison_the_in_memory_hash_set() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("corpus");
        let mut corpus = Corpus::load(&[], output.clone(), 8).unwrap();
        fs::remove_dir_all(&output).unwrap();

        assert!(corpus.add_interesting(b"retry".to_vec()).is_err());
        fs::create_dir(&output).unwrap();
        assert!(corpus.add_interesting(b"retry".to_vec()).unwrap());
        assert_eq!(fs::read(output.join(digest(b"retry"))).unwrap(), b"retry");
    }

    #[test]
    fn imports_seed_files_into_a_self_contained_campaign() {
        let directory = tempfile::tempdir().unwrap();
        let seed = directory.path().join("seed");
        let output = directory.path().join("campaign");
        fs::write(&seed, b"seed bytes").unwrap();
        let corpus = Corpus::load(std::slice::from_ref(&seed), output.clone(), 32).unwrap();
        assert_eq!(corpus.len(), 1);
        assert_eq!(
            fs::read(output.join(digest(b"seed bytes"))).unwrap(),
            b"seed bytes"
        );
    }

    #[test]
    fn rejects_a_conflicting_existing_content_addressed_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(digest(b"expected"));
        fs::write(&path, b"corrupt!").unwrap();
        assert!(persist_new(&path, b"expected").is_err());
    }

    #[test]
    fn ignores_staging_files_but_rejects_corrupt_digest_entries() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(".tmp-partial"), b"partial").unwrap();
        fs::write(directory.path().join(digest(b"valid")), b"valid").unwrap();
        let corpus = Corpus::load(&[], directory.path().to_path_buf(), 16).unwrap();
        assert_eq!(corpus.len(), 1);

        fs::write(directory.path().join(digest(b"expected")), b"corrupt").unwrap();
        assert!(Corpus::load(&[], directory.path().to_path_buf(), 16).is_err());
    }
}
