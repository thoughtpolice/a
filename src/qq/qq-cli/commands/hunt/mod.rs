// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Subcommand, Clone, Debug)]
enum HuntCommand {
    Run(run::RunArgs),
}

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct HuntArgs {
    #[command(subcommand)]
    command: HuntCommand,
}

#[derive(clap::Parser, Clone, Debug)]
pub(crate) enum HuntSubcommand {
    Hunt(HuntArgs),
}

pub(crate) async fn hunt_cmd(
    ui: &mut Ui,
    command: &CommandHelper,
    subcmd: HuntSubcommand,
) -> Result<(), CommandError> {
    match subcmd {
        HuntSubcommand::Hunt(args) => match args.command {
            HuntCommand::Run(args) => run::run_cmd(ui, command, args),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------------

mod run;
