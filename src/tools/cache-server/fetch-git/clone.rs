// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Simple CLI that clones a Git repository to a local directory.
//!
//! Usage: clone <repo-url> [rev] [out-dir]

use std::path::PathBuf;

use clap::Parser;
use dial9::{Dial9TokioHandle, RecorderTokioExt as _};

use fetch_git::objects::GitObjectType;

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

fn main() {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // This CLI never records; a disabled recorder attaches a plain tokio
    // runtime and hands out an inert handle, which is all `clone_repo_spooled`
    // needs to spawn with.
    let (_recorder, runtime) = dial9::recorder_disabled()
        .attach_tokio_runtime(|_| {})
        .unwrap();
    let handle = Dial9TokioHandle::current();

    runtime.block_on(async {
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

        let result = match fetch_git::clone_repo_spooled(
            &ssl,
            &args.repo,
            branch,
            commit,
            None,
            args.spool_dir.as_deref(),
            &handle,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        };

        eprintln!(
            "Fetched {} objects, {} MiB pack (commit {})",
            result.pack.object_count(),
            result.pack.pack_size() / (1024 * 1024),
            hex::encode(result.commit_sha),
        );

        // Create the output directory
        if let Err(e) = tokio::fs::create_dir_all(&args.out_dir).await {
            eprintln!("error creating output directory: {e}");
            std::process::exit(1);
        }

        let mut file_count: usize = 0;
        let mut dir_count: usize = 0;
        let mut errors = Vec::new();

        // Collect entries first since walk_tree takes &mut closure
        let mut entries = Vec::new();
        result
            .pack
            .walk_tree(&result.tree_sha, "", &mut |path, entry| {
                entries.push((path.to_string(), entry.clone()));
            })
            .unwrap_or_else(|e| {
                eprintln!("error walking tree: {e}");
                std::process::exit(1);
            });

        for (path, entry) in &entries {
            let full_path = args.out_dir.join(path);

            if entry.is_dir() {
                if let Err(e) = tokio::fs::create_dir_all(&full_path).await {
                    errors.push(format!("{path}: mkdir failed: {e}"));
                } else {
                    dir_count += 1;
                }
            } else if entry.is_submodule() {
                eprintln!("  skip submodule: {path}");
            } else if entry.is_symlink() {
                if let Ok(Some((GitObjectType::Blob, data))) = result.pack.get(&entry.sha) {
                    let target = String::from_utf8_lossy(&data);
                    // Ensure parent directory exists
                    if let Some(parent) = full_path.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    #[cfg(unix)]
                    if let Err(e) = tokio::fs::symlink(target.as_ref(), &full_path).await {
                        errors.push(format!("{path}: symlink failed: {e}"));
                    } else {
                        file_count += 1;
                    }
                } else {
                    errors.push(format!(
                        "{path}: symlink target blob {} not found in pack",
                        hex::encode(entry.sha)
                    ));
                }
            } else {
                // Regular file or executable
                if let Ok(Some((GitObjectType::Blob, data))) = result.pack.get(&entry.sha) {
                    // Ensure parent directory exists
                    if let Some(parent) = full_path.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    if let Err(e) = tokio::fs::write(&full_path, &data).await {
                        errors.push(format!("{path}: write failed: {e}"));
                    } else {
                        file_count += 1;
                        // Set executable bit on Unix
                        #[cfg(unix)]
                        if entry.is_executable() {
                            use std::os::unix::fs::PermissionsExt;
                            let perms = std::fs::Permissions::from_mode(0o755);
                            let _ = std::fs::set_permissions(&full_path, perms);
                        }
                    }
                } else {
                    errors.push(format!(
                        "{path}: blob {} not found in pack",
                        hex::encode(entry.sha)
                    ));
                }
            }
        }

        if !errors.is_empty() {
            eprintln!("\n{} errors:", errors.len());
            for e in &errors {
                eprintln!("  {e}");
            }
        }

        eprintln!(
            "Done: {file_count} files, {dir_count} directories written to {}",
            args.out_dir.display()
        );
    });
}
