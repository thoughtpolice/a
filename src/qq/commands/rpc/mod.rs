// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Subcommand, Clone, Debug)]
enum RpcCommand {
    Init(init::InitArgs),
}

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct RpcArgs {
    #[command(subcommand)]
    command: RpcCommand,
}

#[derive(clap::Parser, Clone, Debug)]
pub(crate) enum RpcSubcommand {
    /// Use the RPC ("cloud") backend, which proxies storage to an HTTP server.
    Rpc(RpcArgs),
}

pub(crate) async fn rpc_cmd(
    ui: &mut Ui,
    command: &CommandHelper,
    subcmd: RpcSubcommand,
) -> Result<(), CommandError> {
    match subcmd {
        RpcSubcommand::Rpc(args) => match args.command {
            RpcCommand::Init(args) => init::init_cmd(ui, command, args),
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------------

mod init;
