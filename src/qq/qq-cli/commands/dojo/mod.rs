// SPDX-FileCopyrightText: © 2024 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Subcommand, Clone, Debug)]
enum DojoCommand {
    Call(call::CallArgs),
    Init(init::InitArgs),
}

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct DojoArgs {
    #[command(subcommand)]
    command: DojoCommand,
}

#[derive(clap::Parser, Clone, Debug)]
pub(crate) enum DojoSubcommand {
    /// Use the "dojo" cloud backend.
    Dojo(DojoArgs),
}

pub(crate) fn dojo_cmd(
    ui: &mut Ui,
    command: &CommandHelper,
    subcmd: DojoSubcommand,
) -> Result<(), CommandError> {
    match subcmd {
        DojoSubcommand::Dojo(args) => match args.command {
            DojoCommand::Call(args) => call::call_cmd(ui, command, args),
            DojoCommand::Init(args) => init::init_cmd(ui, command, args),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------------

mod call;
mod init;
