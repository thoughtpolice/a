// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! An action's outputs: the directories they go in, before it runs, and
//! what it produced, uploaded, after.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{
    Command, Digest, Directory, DirectoryNode, FileNode, OutputDirectory, OutputFile,
    OutputSymlink, SymlinkNode, Tree,
};

use crate::cas::{BATCH_BLOB_MAX, Cas};
use crate::digest::{DigestFunction, Key, key};

/// Large files uploaded at once.
const PARALLEL_UPLOADS: usize = 4;

/// What an action produced, as an `ActionResult` names it.
#[derive(Debug, Default)]
pub struct Produced {
    pub files: Vec<OutputFile>,
    pub directories: Vec<OutputDirectory>,
    pub symlinks: Vec<OutputSymlink>,
}

/// The paths, relative to the working directory, where the command may
/// leave outputs. Whether each was declared a file or a directory does not
/// matter (see [`upload`]).
fn expected(command: &Command) -> Result<Vec<String>> {
    #[allow(deprecated)]
    let outputs: Vec<String> = if command.output_paths.is_empty() {
        command
            .output_files
            .iter()
            .chain(&command.output_directories)
            .cloned()
            .collect()
    } else {
        command.output_paths.clone()
    };
    for path in &outputs {
        let relative = Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
        if path.is_empty() || !relative {
            bail!("output path {path:?} is not a relative path inside the working directory");
        }
    }
    Ok(outputs)
}

/// Create the directories the command's outputs go in, as REAPI says the
/// worker must: their parents, not the outputs themselves.
pub fn prepare(command: &Command, working_directory: &Path) -> Result<()> {
    for output in expected(command)? {
        if let Some(parent) = Path::new(&output).parent() {
            let parent = working_directory.join(parent);
            std::fs::create_dir_all(&parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
    }
    Ok(())
}

/// Upload what the command left at its output paths under
/// `working_directory`, and say what it was. An output the command did not
/// produce is left out, as REAPI asks.
///
/// Buck's `strict` output mode lists outputs that may be either a file or
/// a directory as `output_files`, so a directory found there is reported
/// as an output directory; likewise a file found where a directory was
/// expected is reported as a file.
pub async fn upload(
    cas: &Cas,
    function: DigestFunction,
    command: &Command,
    working_directory: &Path,
) -> Result<Produced> {
    let outputs = expected(command)?;
    let root = working_directory.to_path_buf();
    let (produced, uploads) =
        tokio::task::spawn_blocking(move || collect(function, &outputs, &root)).await??;
    uploads.send(cas, function).await?;
    Ok(produced)
}

/// Upload the file at `path`, returning its digest.
pub async fn upload_file(cas: &Cas, function: DigestFunction, path: &Path) -> Result<Digest> {
    let path = path.to_path_buf();
    let (digest, uploads) = tokio::task::spawn_blocking(move || {
        let digest = function
            .of_file(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let mut uploads = Uploads::default();
        uploads.files.push((digest.clone(), path));
        anyhow::Ok((digest, uploads))
    })
    .await??;
    uploads.send(cas, function).await?;
    Ok(digest)
}

fn collect(
    function: DigestFunction,
    outputs: &[String],
    root: &Path,
) -> Result<(Produced, Uploads)> {
    let mut produced = Produced::default();
    let mut uploads = Uploads::default();
    for output in outputs {
        let path = root.join(output);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).with_context(|| format!("examining {}", path.display())),
        };
        let kind = metadata.file_type();
        if kind.is_symlink() {
            let target = std::fs::read_link(&path)?;
            produced.symlinks.push(OutputSymlink {
                path: output.clone(),
                target: utf8(target.as_os_str(), &path)?.to_string(),
                node_properties: None,
            });
        } else if kind.is_dir() {
            let mut tree = TreeBuilder {
                function,
                uploads: &mut uploads,
                children: Vec::new(),
                seen: HashSet::new(),
            };
            let root_dir = tree.directory(&path)?;
            let tree = Tree {
                root: Some(root_dir),
                children: tree.children,
            };
            let encoded = Bytes::from(tree.encode_to_vec());
            let tree_digest = function.of(&encoded);
            uploads.blobs.push((tree_digest.clone(), encoded));
            produced.directories.push(OutputDirectory {
                path: output.clone(),
                tree_digest: Some(tree_digest),
                is_topologically_sorted: false,
                root_directory_digest: None,
            });
        } else if kind.is_file() {
            let digest = function
                .of_file(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            uploads.files.push((digest.clone(), path));
            produced.files.push(OutputFile {
                path: output.clone(),
                digest: Some(digest),
                is_executable: metadata.permissions().mode() & 0o111 != 0,
                contents: Bytes::new(),
                node_properties: None,
            });
        } else {
            bail!(
                "output {} is neither a file, a directory nor a symlink",
                path.display()
            );
        }
    }
    Ok((produced, uploads))
}

/// Builds a `Tree` of an output directory.
struct TreeBuilder<'a> {
    function: DigestFunction,
    uploads: &'a mut Uploads,
    children: Vec<Directory>,
    /// Children already listed, by digest.
    seen: HashSet<Key>,
}

impl TreeBuilder<'_> {
    fn directory(&mut self, path: &Path) -> Result<Directory> {
        let mut entries: Vec<(String, PathBuf)> = std::fs::read_dir(path)
            .with_context(|| format!("listing {}", path.display()))?
            .map(|entry| {
                let entry = entry?;
                let name = utf8(&entry.file_name(), &entry.path())?.to_string();
                anyhow::Ok((name, entry.path()))
            })
            .collect::<Result<_>>()?;
        // REAPI wants each kind of entry sorted by name.
        entries.sort();

        let mut dir = Directory::default();
        for (name, path) in entries {
            let metadata = std::fs::symlink_metadata(&path)?;
            let kind = metadata.file_type();
            if kind.is_symlink() {
                let target = std::fs::read_link(&path)?;
                dir.symlinks.push(SymlinkNode {
                    name,
                    target: utf8(target.as_os_str(), &path)?.to_string(),
                    node_properties: None,
                });
            } else if kind.is_dir() {
                let sub = self.directory(&path)?;
                let digest = self.function.of(&sub.encode_to_vec());
                if self.seen.insert(key(&digest)) {
                    self.children.push(sub);
                }
                dir.directories.push(DirectoryNode {
                    name,
                    digest: Some(digest),
                });
            } else if kind.is_file() {
                let digest = self
                    .function
                    .of_file(&path)
                    .with_context(|| format!("reading {}", path.display()))?;
                self.uploads.files.push((digest.clone(), path));
                dir.files.push(FileNode {
                    name,
                    digest: Some(digest),
                    is_executable: metadata.permissions().mode() & 0o111 != 0,
                    node_properties: None,
                });
            } else {
                bail!(
                    "{} is neither a file, a directory nor a symlink",
                    path.display()
                );
            }
        }
        Ok(dir)
    }
}

fn utf8<'a>(name: &'a std::ffi::OsStr, path: &Path) -> Result<&'a str> {
    name.to_str()
        .with_context(|| format!("{} is not UTF-8, which REAPI paths must be", path.display()))
}

/// Blobs to upload: files on disk, and encoded messages in memory.
#[derive(Debug, Default)]
struct Uploads {
    files: Vec<(Digest, PathBuf)>,
    blobs: Vec<(Digest, Bytes)>,
}

impl Uploads {
    /// Upload whichever of these the CAS does not have yet.
    async fn send(self, cas: &Cas, function: DigestFunction) -> Result<()> {
        let mut all = HashSet::new();
        let digests: Vec<Digest> = self
            .files
            .iter()
            .map(|(d, _)| d)
            .chain(self.blobs.iter().map(|(d, _)| d))
            .filter(|d| all.insert(key(d)))
            .cloned()
            .collect();
        let mut missing: HashSet<Key> = cas
            .find_missing(function, &digests)
            .await?
            .iter()
            .map(key)
            .collect();

        let mut small = Vec::new();
        for (digest, data) in self.blobs {
            if missing.remove(&key(&digest)) {
                small.push((digest, data));
            }
        }
        let mut large = Vec::new();
        for (digest, path) in self.files {
            if !missing.remove(&key(&digest)) {
                continue;
            }
            if digest.size_bytes <= BATCH_BLOB_MAX {
                let data = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("reading {}", path.display()))?;
                small.push((digest, data.into()));
            } else {
                large.push((digest, path));
            }
        }
        cas.write_blobs(function, small).await?;
        futures::stream::iter(large)
            .map(|(digest, path)| async move { cas.write_file(function, &digest, &path).await })
            .buffer_unordered(PARALLEL_UPLOADS)
            .try_collect::<()>()
            .await
    }
}
