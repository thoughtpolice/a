// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Laying out an action's input root.
//!
//! The tree's directories are read a level at a time, a batch per level,
//! and kept in memory, since the same toolchain directories appear under
//! action after action. Its files come from the [`FileCache`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{Digest, Directory};

use crate::cache::FileCache;
use crate::cas::Cas;
use crate::digest::{DigestFunction, Key, key, show};

/// Directories kept in memory.
const DIRECTORY_CACHE_ENTRIES: usize = 100_000;

/// A tree's directories, by digest.
type Tree = HashMap<Key, Arc<Directory>>;

/// See the module documentation.
pub struct Inputs {
    files: Arc<FileCache>,
    directories: quick_cache::sync::Cache<(DigestFunction, Key), Arc<Directory>>,
}

impl Inputs {
    pub fn new(files: Arc<FileCache>) -> Self {
        Self {
            files,
            directories: quick_cache::sync::Cache::new(DIRECTORY_CACHE_ENTRIES),
        }
    }

    /// Lay out the tree rooted at `root` in `dest`, an empty directory.
    pub async fn materialize(
        &self,
        cas: &Cas,
        function: DigestFunction,
        root: &Digest,
        dest: &Path,
    ) -> Result<()> {
        let tree = self.tree(cas, function, root).await?;
        let files: Vec<Digest> = tree
            .values()
            .flat_map(|dir| &dir.files)
            .map(|file| {
                file.digest
                    .clone()
                    .with_context(|| format!("input file {:?} has no digest", file.name))
            })
            .collect::<Result<_>>()?;
        let pinned = self.files.fetch(cas, function, &files).await?;

        let files = self.files.clone();
        let (root, dest) = (root.clone(), dest.to_path_buf());
        let laid_out =
            tokio::task::spawn_blocking(move || lay_out(&files, function, &tree, &root, &dest))
                .await?;
        drop(pinned);
        laid_out
    }

    /// Every directory of the tree rooted at `root`.
    async fn tree(&self, cas: &Cas, function: DigestFunction, root: &Digest) -> Result<Tree> {
        let mut tree = Tree::new();
        let mut level = vec![root.clone()];
        while !level.is_empty() {
            let mut found = Vec::new();
            let mut fetch = Vec::new();
            for digest in level.drain(..) {
                let k = key(&digest);
                if tree.contains_key(&k) {
                    continue;
                }
                match self.directories.get(&(function, k.clone())) {
                    Some(dir) => {
                        tree.insert(k, dir.clone());
                        found.push(dir);
                    }
                    None if fetch.iter().any(|d: &Digest| key(d) == k) => {}
                    None => fetch.push(digest),
                }
            }
            for (k, data) in cas.read_blobs(function, &fetch).await? {
                let dir = Directory::decode(data.as_ref())
                    .with_context(|| format!("input directory {}/{} does not decode", k.0, k.1))?;
                reapi_client::check_entry_names(&dir)
                    .with_context(|| format!("input directory {}/{}", k.0, k.1))?;
                let dir = Arc::new(dir);
                self.directories.insert((function, k.clone()), dir.clone());
                tree.insert(k, dir.clone());
                found.push(dir);
            }
            for dir in found {
                for sub in &dir.directories {
                    level.push(sub.digest.clone().with_context(|| {
                        format!("input directory {:?} has no digest", sub.name)
                    })?);
                }
            }
        }
        Ok(tree)
    }
}

fn lay_out(
    files: &FileCache,
    function: DigestFunction,
    tree: &Tree,
    digest: &Digest,
    path: &Path,
) -> Result<()> {
    let dir = tree
        .get(&key(digest))
        .with_context(|| format!("directory {} is not in the tree", show(digest)))?;
    for file in &dir.files {
        let dest = path.join(&file.name);
        let digest = file.digest.as_ref().expect("checked when fetching");
        files
            .copy_to(function, digest, file.is_executable, &dest)
            .with_context(|| format!("creating {}", dest.display()))?;
    }
    for symlink in &dir.symlinks {
        let dest = path.join(&symlink.name);
        std::os::unix::fs::symlink(&symlink.target, &dest)
            .with_context(|| format!("creating {}", dest.display()))?;
    }
    for sub in &dir.directories {
        let dest = path.join(&sub.name);
        std::fs::create_dir(&dest).with_context(|| format!("creating {}", dest.display()))?;
        let digest = sub.digest.as_ref().expect("checked when fetching");
        lay_out(files, function, tree, digest, &dest)?;
    }
    Ok(())
}
