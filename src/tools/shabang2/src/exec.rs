// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Process execution — replaces the current process with the cached binary.

use std::path::Path;

use anyhow::{Context, Result};

/// Replace the current process with the binary at `path`, passing `args`.
///
/// On Unix this uses `exec()` which never returns on success. On Windows
/// this spawns a child process and exits with its status code.
pub fn exec_binary(binary: &Path, args: &[String]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let err = std::process::Command::new(binary).args(args).exec();
        // exec() only returns on error
        Err(err).with_context(|| format!("exec failed: {}", binary.display()))
    }

    #[cfg(windows)]
    {
        let status = std::process::Command::new(binary)
            .args(args)
            .status()
            .with_context(|| format!("spawn failed: {}", binary.display()))?;

        std::process::exit(status.code().unwrap_or(1));
    }
}
