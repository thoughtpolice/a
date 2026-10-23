// SPDX-FileCopyrightText: © 2020-2026 Stepan Koltsov <stepan.koltsov@gmail.com>
// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

use std::fmt;
use std::io::IsTerminal;

use crate::ansi::strip_csi;

#[derive(Debug)]
pub struct ConsoleWriter {
    color: bool,
}

fn is_tty() -> bool {
    !cfg!(windows) && std::io::stderr().is_terminal()
}

impl ConsoleWriter {
    pub fn auto() -> ConsoleWriter {
        ConsoleWriter { color: is_tty() }
    }
}

impl fmt::Write for ConsoleWriter {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.color {
            eprint!("{}", s);
        } else {
            eprint!("{}", strip_csi(s));
        }
        Ok(())
    }
}
