// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! An action's outputs: the directories they go in, before it runs, and
//! what it produced, uploaded, after.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{
    Command, Digest, Directory, DirectoryNode, FileNode, OutputDirectory, OutputFile,
    OutputSymlink, SymlinkNode, Tree,
};

use crate::cas::{Blob, Cas};
use crate::digest::{DigestFunction, Key, key};

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
pub fn expected(command: &Command) -> Result<Vec<String>> {
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

/// Upload what the command left at the `outputs` paths (see [`expected`])
/// under `working_directory`, and say what it was; and upload the files at
/// `streams`, such as its stdout and stderr, giving their digests. An
/// output the command did not produce is left out, as REAPI asks.
///
/// Buck's `strict` output mode lists outputs that may be either a file or
/// a directory as `output_files`, so a directory found there is reported
/// as an output directory; likewise a file found where a directory was
/// expected is reported as a file.
pub async fn upload<const N: usize>(
    cas: &Cas,
    function: DigestFunction,
    outputs: Vec<String>,
    working_directory: &Path,
    streams: [PathBuf; N],
) -> Result<(Produced, [Digest; N])> {
    let root = working_directory.to_path_buf();
    let (produced, streams, uploads) = tokio::task::spawn_blocking(move || {
        let (produced, mut uploads) = collect(function, &outputs, &root)?;
        let mut digests = Vec::with_capacity(N);
        for path in streams {
            let digest = function
                .of_file(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            uploads.file(digest.clone(), path);
            digests.push(digest);
        }
        let digests: [Digest; N] = digests.try_into().expect("a digest per stream");
        anyhow::Ok((produced, digests, uploads))
    })
    .await??;
    uploads.send(cas, function).await?;
    Ok((produced, streams))
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
        match entry(function, &mut uploads, &path, &metadata)? {
            Entry::Symlink(target) => produced.symlinks.push(OutputSymlink {
                path: output.clone(),
                target,
                node_properties: None,
            }),
            Entry::Directory => {
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
                uploads.0.push((tree_digest.clone(), Blob::Memory(encoded)));
                produced.directories.push(OutputDirectory {
                    path: output.clone(),
                    tree_digest: Some(tree_digest),
                    is_topologically_sorted: false,
                    root_directory_digest: None,
                });
            }
            Entry::File { digest, executable } => produced.files.push(OutputFile {
                path: output.clone(),
                digest: Some(digest),
                is_executable: executable,
                contents: Bytes::new(),
                node_properties: None,
            }),
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
            match entry(self.function, self.uploads, &path, &metadata)? {
                Entry::Symlink(target) => dir.symlinks.push(SymlinkNode {
                    name,
                    target,
                    node_properties: None,
                }),
                Entry::Directory => {
                    let sub = self.directory(&path)?;
                    let digest = self.function.of(&sub.encode_to_vec());
                    if self.seen.insert(key(&digest)) {
                        self.children.push(sub);
                    }
                    dir.directories.push(DirectoryNode {
                        name,
                        digest: Some(digest),
                    });
                }
                Entry::File { digest, executable } => dir.files.push(FileNode {
                    name,
                    digest: Some(digest),
                    is_executable: executable,
                    node_properties: None,
                }),
            }
        }
        Ok(dir)
    }
}

/// What is at a path, as an output or an entry of an output directory.
enum Entry {
    Symlink(String),
    /// A directory, for the caller to walk.
    Directory,
    File {
        digest: Digest,
        executable: bool,
    },
}

/// What is at `path`, whose metadata is `metadata`. A file is hashed and
/// added to `uploads`.
fn entry(
    function: DigestFunction,
    uploads: &mut Uploads,
    path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<Entry> {
    let kind = metadata.file_type();
    if kind.is_symlink() {
        let target = std::fs::read_link(path)?;
        Ok(Entry::Symlink(utf8(target.as_os_str(), path)?.to_string()))
    } else if kind.is_dir() {
        Ok(Entry::Directory)
    } else if kind.is_file() {
        let digest = function
            .of_file(path)
            .with_context(|| format!("reading {}", path.display()))?;
        uploads.file(digest.clone(), path.to_path_buf());
        Ok(Entry::File {
            digest,
            executable: metadata.permissions().mode() & 0o111 != 0,
        })
    } else {
        bail!(
            "{} is neither a file, a directory nor a symlink",
            path.display()
        )
    }
}

fn utf8<'a>(name: &'a std::ffi::OsStr, path: &Path) -> Result<&'a str> {
    name.to_str()
        .with_context(|| format!("{} is not UTF-8, which REAPI paths must be", path.display()))
}

/// Blobs to upload, and where each is.
#[derive(Debug, Default)]
struct Uploads(Vec<(Digest, Blob)>);

impl Uploads {
    fn file(&mut self, digest: Digest, path: PathBuf) {
        self.0.push((digest, Blob::File(path)));
    }

    /// Upload whichever of these the CAS does not have yet.
    async fn send(self, cas: &Cas, function: DigestFunction) -> Result<()> {
        let mut all = HashSet::new();
        let digests: Vec<Digest> = self
            .0
            .iter()
            .map(|(d, _)| d)
            .filter(|d| all.insert(key(d)))
            .cloned()
            .collect();
        let mut missing: HashSet<Key> = cas
            .find_missing(function, &digests)
            .await?
            .iter()
            .map(key)
            .collect();
        let blobs = self
            .0
            .into_iter()
            .filter(|(digest, _)| missing.remove(&key(digest)))
            .collect();
        cas.write_blobs(function, blobs).await
    }
}
