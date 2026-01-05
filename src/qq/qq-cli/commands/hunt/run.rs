// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct RunArgs {}

pub(crate) fn run_cmd(
    _ui: &mut Ui,
    _command: &CommandHelper,
    _args: RunArgs,
) -> Result<(), CommandError> {
    Ok(())
}
