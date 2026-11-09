// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Installer that puts macOS apps in ~/Applications: each file it is given,
//! `NAME.app`, is an app bundle (a directory), copied whole to
//! `~/Applications/NAME.app`, as dragging an app there does. `macos_app`
//! (`//buck/installers:defs.bzl`) makes the bundles.
//!
//! ```sh
//! buck2 install //my:tool.app                       # into ~/Applications
//! buck2 install //my:tool.app -- --dir /Applications
//! ```
//!
//! A bundle is copied beside its destination first, then the one there is
//! moved aside, the new one renamed into its place, and the old one removed:
//! an install replaces a bundle whole, leaving none of the old one's files,
//! never a bundle half-copied, and an app that is running keeps the files it
//! has open. Buck's outputs are read-only; an installed bundle is writable by
//! its owner, so that the next install can remove it, and a file in it is
//! executable only if the output was.

use std::ffi::OsString;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Parser;
use common::{FileReadyInfo, FileResult, InstallerArgs, InstallerHandler};

#[derive(Parser, Debug)]
#[command(name = "app-installer")]
struct Args {
    #[command(flatten)]
    common: InstallerArgs,

    /// The directory apps are installed in. Defaults to ~/Applications.
    #[arg(long)]
    dir: Option<PathBuf>,
}

struct AppHandler {
    dir: PathBuf,
}

/// Where the app `name` goes in `dir`: a name alone, ending in `.app`.
fn destination(dir: &Path, name: &str) -> Result<PathBuf> {
    let mut components = Path::new(name).components();
    let single = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if !single || !name.ends_with(".app") || name == ".app" {
        bail!("{name:?}: an installed app's name must be NAME.app, with no directory");
    }
    Ok(dir.join(name))
}

/// A path beside `dest`, hidden, and this process's own, for `what` it
/// holds: the bundle being copied, or the one it replaces. Neither ends in
/// `.app`, so that Finder and LaunchServices take neither for an app.
fn beside(dest: &Path, what: &str) -> PathBuf {
    let mut name = OsString::from(".");
    name.push(dest.file_name().unwrap_or_default());
    name.push(format!(".{what}-{}", std::process::id()));
    dest.with_file_name(name)
}

/// Copies the tree at `src` to `dest`, which does not exist yet, following
/// links (Buck may materialize outputs as links into its cache).
fn copy_tree(src: &Path, dest: &Path) -> Result<()> {
    let meta = std::fs::metadata(src).with_context(|| format!("{}", src.display()))?;
    if meta.is_dir() {
        std::fs::create_dir(dest).with_context(|| format!("{}", dest.display()))?;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("{}", dest.display()))?;
        for entry in std::fs::read_dir(src).with_context(|| format!("{}", src.display()))? {
            let entry = entry.with_context(|| format!("{}", src.display()))?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        let mode = if meta.permissions().mode() & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        std::fs::copy(src, dest)
            .and_then(|_| std::fs::set_permissions(dest, std::fs::Permissions::from_mode(mode)))
            .with_context(|| format!("{}", dest.display()))?;
    }
    Ok(())
}

/// Removes what is at `path`: a tree, or a file or link alone (a link to an
/// app is removed, not what it names).
fn remove(path: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(path)?.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Puts `new` at `dest`, replacing what is there whole: it goes aside to
/// `old` first, comes back if `new` cannot take its place, and is removed
/// once `new` has.
fn replace(new: &Path, dest: &Path, old: &Path) -> Result<()> {
    let had = match std::fs::rename(dest, old) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => false,
        Err(e) => return Err(e).with_context(|| format!("{}", dest.display())),
    };
    if let Err(e) = std::fs::rename(new, dest) {
        if had {
            let _ = std::fs::rename(old, dest);
        }
        return Err(e).with_context(|| format!("{}", dest.display()));
    }
    if had {
        remove(old).with_context(|| format!("{}", old.display()))?;
    }
    Ok(())
}

/// Installs the bundle at `src` as `dest`.
fn install_bundle(src: &Path, dest: &Path) -> Result<()> {
    let meta = std::fs::metadata(src).with_context(|| format!("{}", src.display()))?;
    if !meta.is_dir() {
        bail!("{}: an app is a bundle, a directory", src.display());
    }
    let parent = dest.parent().context("no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| format!("{}", parent.display()))?;
    let partial = beside(dest, "install");
    let copied =
        copy_tree(src, &partial).and_then(|()| replace(&partial, dest, &beside(dest, "old")));
    if copied.is_err() {
        let _ = remove(&partial);
    }
    copied
}

#[common::async_trait]
impl InstallerHandler for AppHandler {
    async fn install(&self, install_id: &str, file_names: &[String]) -> Result<()> {
        tracing::info!(install_id, ?file_names, dir = %self.dir.display(), "install request");
        // Every name is checked before any bundle is ready, so a bad one
        // stops the install before anything is written.
        for name in file_names {
            destination(&self.dir, name)?;
        }
        Ok(())
    }

    async fn file_ready(&self, info: FileReadyInfo) -> Result<FileResult> {
        let dest = destination(&self.dir, &info.name)?;
        let src = info.path.clone();
        let to = dest.clone();
        tokio::task::spawn_blocking(move || install_bundle(&src, &to)).await??;
        println!("installed {}", dest.display());
        tracing::info!(name = %info.name, dest = %dest.display(), "installed");
        Ok(FileResult::default())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let dir = match args.dir {
        Some(dir) => dir,
        None => std::env::home_dir()
            .context("no home directory: pass --dir")?
            .join("Applications"),
    };
    common::run_installer(&args.common, AppHandler { dir }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(name: &str, path: PathBuf) -> FileReadyInfo {
        FileReadyInfo {
            install_id: "test".into(),
            name: name.into(),
            path,
            digest: String::new(),
            digest_algorithm: String::new(),
            size: 0,
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn write(path: &Path, text: &str, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A bundle as Buck leaves one: its files read-only, one executable.
    fn bundle(at: &Path, executable: &str) -> PathBuf {
        write(&at.join("Contents/Info.plist"), "plist", 0o444);
        write(&at.join("Contents/MacOS/tool"), executable, 0o555);
        at.to_path_buf()
    }

    fn names(dir: &Path) -> Vec<OsString> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn installs_a_bundle_whole_with_writable_modes() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let apps = tmp.path().join("Applications");
        let src = bundle(&tmp.path().join("out/tool.app"), "new");
        let handler = AppHandler { dir: apps.clone() };
        handler.install("test", &["tool.app".to_string()]).await?;
        handler.file_ready(ready("tool.app", src)).await?;

        let app = apps.join("tool.app");
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/MacOS/tool"))?,
            "new"
        );
        assert_eq!(mode(&app.join("Contents/MacOS/tool")), 0o755);
        assert_eq!(mode(&app.join("Contents/Info.plist")), 0o644);
        assert_eq!(mode(&app.join("Contents")), 0o755);
        assert_eq!(names(&apps), ["tool.app"]);
        Ok(())
    }

    #[tokio::test]
    async fn replaces_a_bundle_whole_leaving_nothing_beside_it() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let apps = tmp.path().join("Applications");
        let handler = AppHandler { dir: apps.clone() };
        let old = bundle(&tmp.path().join("old/tool.app"), "old");
        handler.file_ready(ready("tool.app", old)).await?;
        let app = apps.join("tool.app");
        write(&app.join("Contents/Resources/stale"), "stale", 0o644);
        // An app running from the old bundle keeps it: the new one is another.
        let running = std::fs::File::open(app.join("Contents/MacOS/tool"))?;

        let new = bundle(&tmp.path().join("new/tool.app"), "new");
        handler.file_ready(ready("tool.app", new)).await?;

        assert_eq!(
            std::fs::read_to_string(app.join("Contents/MacOS/tool"))?,
            "new"
        );
        assert!(
            !app.join("Contents/Resources").exists(),
            "the old bundle's files are gone"
        );
        assert_eq!(std::io::read_to_string(running)?, "old");
        assert_eq!(names(&apps), ["tool.app"]);
        Ok(())
    }

    #[tokio::test]
    async fn replaces_a_link_to_an_app_but_not_what_it_names() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let apps = tmp.path().join("Applications");
        let elsewhere = bundle(&tmp.path().join("elsewhere/tool.app"), "elsewhere");
        std::fs::create_dir_all(&apps)?;
        std::os::unix::fs::symlink(&elsewhere, apps.join("tool.app"))?;

        let new = bundle(&tmp.path().join("new/tool.app"), "new");
        let handler = AppHandler { dir: apps.clone() };
        handler.file_ready(ready("tool.app", new)).await?;

        let app = apps.join("tool.app");
        assert!(!std::fs::symlink_metadata(&app)?.is_symlink());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/MacOS/tool"))?,
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(elsewhere.join("Contents/MacOS/tool"))?,
            "elsewhere"
        );
        Ok(())
    }

    #[tokio::test]
    async fn refuses_names_that_are_not_an_app() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let handler = AppHandler {
            dir: tmp.path().join("Applications"),
        };
        for name in [
            "../tool.app",
            "/Applications/tool.app",
            "bin/tool.app",
            "tool.app/Contents",
            "tool",
            ".app",
            "",
        ] {
            assert!(
                handler.install("test", &[name.to_string()]).await.is_err(),
                "{name:?} accepted"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn refuses_a_file_that_is_not_a_bundle() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let apps = tmp.path().join("Applications");
        let file = tmp.path().join("tool");
        write(&file, "tool", 0o555);
        let handler = AppHandler { dir: apps.clone() };
        assert!(handler.file_ready(ready("tool.app", file)).await.is_err());
        assert!(!apps.join("tool.app").exists());
        Ok(())
    }
}
