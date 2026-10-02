// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Simple CLI that clones a Git repository to a local directory.
//!
//! Usage: clone <repo-url> [rev] [out-dir]

use std::path::{Path, PathBuf};

use clap::Parser;
use dial9::{Dial9HandleTokioExt as _, Dial9TokioHandle, TokioAttachOptions};

use fetch_git::pack::{GitPack, ObjectKind};

#[derive(Parser)]
#[command(
    name = "git-fetch-clone",
    about = "Clone a Git repository via smart HTTP"
)]
struct Args {
    /// Git repository URL (e.g. https://github.com/user/repo.git)
    repo: String,

    /// Branch, tag, or 40-char commit SHA (default: main)
    #[arg(default_value = "main")]
    rev: String,

    /// Output directory (default: ./clone-output)
    #[arg(default_value = "./clone-output")]
    out_dir: PathBuf,

    /// Directory for the spooled packfile (default: system temp dir). Large
    /// clones write multi-GiB temporary files here.
    #[arg(long)]
    spool_dir: Option<PathBuf>,
}

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // This CLI never records; a disabled recorder attaches a plain tokio
    // runtime and hands out an inert handle, which is all `clone_repo`
    // needs to spawn with.
    let recorder = dial9::recorder_disabled();
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    let runtime = recorder
        .handle()
        .attach_tokio_runtime(builder, TokioAttachOptions::default())
        .unwrap();
    let handle = Dial9TokioHandle::current();

    let cloned = runtime.block_on(async {
        let ssl = fetch_git::transport::build_ssl_connector();

        // If rev looks like a 40-char hex SHA, treat it as a commit hash
        let is_sha = args.rev.len() == 40 && args.rev.chars().all(|c| c.is_ascii_hexdigit());
        let (branch, commit) = if is_sha {
            (None, Some(args.rev.as_str()))
        } else {
            (Some(args.rev.as_str()), None)
        };

        eprintln!(
            "Cloning {} @ {} -> {}",
            args.repo,
            args.rev,
            args.out_dir.display()
        );

        let options = fetch_git::CloneOptions {
            spool_dir: args.spool_dir.clone(),
            index_threads: 0,
        };
        fetch_git::clone_repo(&ssl, &args.repo, branch, commit, &options, &handle).await
    });
    let cloned = cloned.unwrap_or_else(|e| {
        eprintln!("error: {e}");
        std::process::exit(1);
    });

    eprintln!(
        "Fetched {} objects, {} MiB pack (commit {})",
        cloned.pack.object_count(),
        cloned.pack.pack_size() / (1024 * 1024),
        hex::encode(cloned.commit_sha),
    );

    let mut stats = Stats::default();
    if let Err(e) = checkout(&cloned.pack, &cloned.tree_sha, &args.out_dir, &mut stats) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
    if !stats.errors.is_empty() {
        eprintln!("\n{} errors:", stats.errors.len());
        for e in &stats.errors {
            eprintln!("  {e}");
        }
    }
    eprintln!(
        "Done: {} files, {} directories written to {}",
        stats.files,
        stats.dirs,
        args.out_dir.display()
    );
}

#[derive(Default)]
struct Stats {
    files: usize,
    dirs: usize,
    errors: Vec<String>,
}

/// Write the tree `tree_sha` out under `dir`. Tree entry names are
/// validated by [`fetch_git::tree::parse_tree`], so none escapes `dir`.
fn checkout(
    pack: &GitPack,
    tree_sha: &[u8; 20],
    dir: &Path,
    stats: &mut Stats,
) -> Result<(), String> {
    let mut pending = vec![(*tree_sha, dir.to_path_buf(), 0)];
    while let Some((sha, dir, depth)) = pending.pop() {
        if depth >= fetch_git::MAX_TREE_DEPTH {
            return Err(format!(
                "tree nesting exceeds {} levels",
                fetch_git::MAX_TREE_DEPTH
            ));
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("{}: mkdir failed: {e}", dir.display()))?;
        stats.dirs += 1;
        let entries = match pack.get(&sha).map_err(|e| e.to_string())? {
            Some((ObjectKind::Tree, data)) => {
                fetch_git::tree::parse_tree(&data).map_err(|e| e.to_string())?
            }
            _ => return Err(format!("tree {} missing from the pack", hex::encode(sha))),
        };
        for entry in entries {
            let path = dir.join(&entry.name);
            if entry.is_dir() {
                pending.push((entry.sha, path, depth + 1));
                continue;
            }
            if entry.is_submodule() {
                eprintln!("  skip submodule: {}", path.display());
                continue;
            }
            let data = match pack.get(&entry.sha) {
                Ok(Some((ObjectKind::Blob, data))) => data,
                _ => {
                    stats.errors.push(format!(
                        "{}: blob {} not found in pack",
                        path.display(),
                        hex::encode(entry.sha)
                    ));
                    continue;
                }
            };
            let written = if entry.is_symlink() {
                std::os::unix::fs::symlink(String::from_utf8_lossy(&data).as_ref(), &path)
            } else {
                std::fs::write(&path, &data).and_then(|()| {
                    if entry.is_executable() {
                        use std::os::unix::fs::PermissionsExt as _;
                        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    } else {
                        Ok(())
                    }
                })
            };
            match written {
                Ok(()) => stats.files += 1,
                Err(e) => stats.errors.push(format!("{}: {e}", path.display())),
            }
        }
    }
    Ok(())
}
