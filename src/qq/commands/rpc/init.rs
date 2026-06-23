// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::Write as _;

use jj_cli::{
    cli_util::CommandHelper,
    command_error::{user_error_with_message, CommandError},
    ui::Ui,
};
use jj_lib::file_util;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct InitArgs {
    /// The directory in which to create the repo. Defaults to the current
    /// directory.
    #[arg(default_value = ".")]
    destination: String,
}

pub(crate) fn init_cmd(
    ui: &mut Ui,
    command: &CommandHelper,
    args: InitArgs,
) -> Result<(), CommandError> {
    let cwd = command.cwd();
    let wc_path = cwd.join(&args.destination);
    let wc_path = file_util::create_or_reuse_dir(&wc_path)
        .and_then(|_| std::fs::canonicalize(&wc_path))
        .map_err(|e| user_error_with_message("Failed to create workspace", e))?;

    let (settings, _config_env) = command.settings_for_new_workspace(ui, &wc_path)?;
    qq_rpc_backend::init_workspace(&settings, &wc_path)?;

    let relative_wc_path = file_util::relative_path(cwd, &wc_path);
    writeln!(
        ui.status(),
        r#"Initialized RPC-backed repo in "{}""#,
        relative_wc_path.display()
    )?;
    Ok(())
}
