// SPDX-FileCopyrightText: © 2020-2026 Stepan Koltsov <stepan.koltsov@gmail.com>
// SPDX-License-Identifier: MIT

use std::process::Child;
use std::process::Command;
use std::process::Stdio;

pub fn spawn_sh(script: &str) -> anyhow::Result<Child> {
    #[cfg(not(windows))]
    {
        Ok(Command::new("/bin/sh")
            .args(&["-ec", &script])
            .stdin(Stdio::null())
            .spawn()?)
    }
    #[cfg(windows)]
    {
        Ok(Command::new("powershell.exe")
            .args(&["-Command", &script])
            .stdin(Stdio::null())
            .spawn()?)
    }
}
