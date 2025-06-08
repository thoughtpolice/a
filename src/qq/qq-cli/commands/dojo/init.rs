// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::Write;

use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct InitArgs {}

pub(crate) fn init_cmd(
    ui: &mut Ui,
    _command: &CommandHelper,
    _args: InitArgs,
) -> Result<(), CommandError> {
    writeln!(ui.stdout(), "dojo init")?;
    Ok(())
}
