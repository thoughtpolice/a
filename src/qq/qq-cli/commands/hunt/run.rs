// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::Write;

use jj_cli::{
    cli_util::{CommandHelper, RevisionArg},
    command_error::{CommandError, user_error, user_error_with_message},
    ui::Ui,
};
use jj_lib::commit::Commit;
use jj_lib::object_id::ObjectId;

use super::facf::search::{SearchConfig, SearchResult, State, TestResult};
use super::tui::{CulpritInfo, HuntSnapshot, HuntStatus, HuntTui, LogEntry};

// -------------------------------------------------------------------------------------------------

/// Run a flake-aware bisection to find a bug-introducing commit.
///
/// Uses the FACF (Flake Aware Culprit Finding) algorithm to find culprit
/// commits even when tests are flaky. Unlike traditional bisect which assumes
/// deterministic tests, FACF uses Bayesian inference to handle non-deterministic
/// test failures.
#[derive(clap::Args, Clone, Debug)]
pub(crate) struct RunArgs {
    /// Range of revisions to search (e.g., "trunk()..@")
    #[arg(long, short, value_name = "REVSETS", required = true)]
    range: Vec<RevisionArg>,

    /// Command to run for each revision
    ///
    /// Exit codes: 0=pass, 125=skip, 127=abort, other=fail
    #[arg(required = true)]
    command: String,

    /// Arguments to pass to the command
    args: Vec<String>,

    /// Estimated flake rate (0.0-1.0)
    ///
    /// Probability that a test fails due to flakiness rather than an actual bug.
    /// Default 0.01 (1%). Use 0.0 for deterministic tests.
    #[arg(long, short = 'f', default_value = "0.01")]
    flake_rate: f64,

    /// Confidence threshold for termination (0.0-1.0)
    ///
    /// Algorithm terminates when max probability exceeds this threshold.
    /// Default 0.9 (90% confidence).
    #[arg(long, short = 't', default_value = "0.9")]
    threshold: f64,

    /// Disable interactive TUI and use plain line-by-line output
    #[arg(long)]
    no_tui: bool,

    /// Don't restore the working copy after the hunt finishes
    #[arg(long)]
    no_restore: bool,
}

// -------------------------------------------------------------------------------------------------

/// Result of evaluating a single commit
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Evaluation {
    Pass,
    Fail,
    Skip,
    Abort,
}

// -------------------------------------------------------------------------------------------------

pub(crate) fn run_cmd(
    ui: &mut Ui,
    command: &CommandHelper,
    args: RunArgs,
) -> Result<(), CommandError> {
    // Validate arguments
    if !(0.0..=1.0).contains(&args.flake_rate) {
        return Err(user_error(format!(
            "Flake rate must be between 0.0 and 1.0, got {}",
            args.flake_rate
        )));
    }
    if !(0.0..=1.0).contains(&args.threshold) {
        return Err(user_error(format!(
            "Threshold must be between 0.0 and 1.0, got {}",
            args.threshold
        )));
    }

    let workspace_command = command.workspace_helper(ui)?;

    // Resolve the revision range to an ordered list of commits (oldest to newest)
    let commits = resolve_commits_in_order(ui, &workspace_command, &args.range)?;

    if commits.is_empty() {
        return Err(user_error("Revision range is empty - no commits to search"));
    }

    let num_suspects = commits.len();

    // Save initial operation ID for restore
    let initial_op_id = workspace_command.repo().op_id().hex();

    // Initialize FACF algorithm
    let config = SearchConfig {
        flake_rate: args.flake_rate,
        threshold: args.threshold,
        use_info_gain_weighting: true,
    };
    let mut facf = State::new(num_suspects, config);

    let cmd_display = if args.args.is_empty() {
        args.command.clone()
    } else {
        format!("{} {}", args.command, args.args.join(" "))
    };

    if args.no_tui {
        run_plain(ui, command, &args, &commits, &mut facf, &initial_op_id)
    } else {
        run_tui(
            ui,
            command,
            &args,
            &commits,
            &mut facf,
            &cmd_display,
            &initial_op_id,
        )
    }
}

// -------------------------------------------------------------------------------------------------
// Plain (non-TUI) output mode
// -------------------------------------------------------------------------------------------------

fn run_plain(
    ui: &mut Ui,
    command: &CommandHelper,
    args: &RunArgs,
    commits: &[Commit],
    facf: &mut State,
    initial_op_id: &str,
) -> Result<(), CommandError> {
    let num_suspects = commits.len();

    writeln!(
        ui.stdout(),
        "Starting flake-aware hunt with {} suspects (flake_rate={}, threshold={})",
        num_suspects,
        args.flake_rate,
        args.threshold
    )?;
    writeln!(ui.stdout())?;

    // Use a null Ui for tx.finish() to suppress jj working copy messages
    let null_ui = Ui::null();

    let mut workspace_command = command.workspace_helper(ui)?;

    let hunt_result = loop {
        if let Some(result) = facf.result() {
            break result;
        }

        let positions = facf.next_runs(1);
        if positions.is_empty() {
            writeln!(
                ui.warning_default(),
                "No more positions to test, terminating early"
            )?;
            break SearchResult::NoCulprit { confidence: 0.0 };
        }

        let position = positions[0];
        let commit = &commits[position];
        let commit_id = commit.id().hex();
        let short_id = &commit_id[..12.min(commit_id.len())];

        // Checkout the commit, suppressing jj output
        {
            let mut tx = workspace_command.start_transaction();
            tx.check_out(commit)?;
            tx.finish(
                &null_ui,
                format!("Updated to revision {} for hunt", short_id),
            )?;
        }

        let evaluation = evaluate_command(args, &commit_id, position)?;

        let (test_result, result_str) = match evaluation {
            Evaluation::Pass => (TestResult::Pass, "PASS"),
            Evaluation::Fail => (TestResult::Fail, "FAIL"),
            Evaluation::Skip => (TestResult::Fail, "SKIP"),
            Evaluation::Abort => {
                restore_workspace(ui, initial_op_id, args.no_restore)?;
                return Err(user_error("Hunt aborted by command (exit code 127)"));
            }
        };

        facf.record_result(position, test_result);

        let dist = facf.distribution();
        let max_prob = dist.max();
        let argmax = dist.argmax();
        let argmax_str = if argmax == facf.num_suspects() {
            "no-culprit".to_string()
        } else {
            format!("{}", argmax + 1)
        };
        writeln!(
            ui.stdout(),
            "#{}\t{}/{}\t{}\t{}\t{:.1}%\t@{}",
            facf.iterations(),
            position + 1,
            num_suspects,
            short_id,
            result_str,
            max_prob * 100.0,
            argmax_str
        )?;

        workspace_command = command.workspace_helper(ui)?;
    };

    let culprit_info = build_culprit_info(&hunt_result, commits);
    print_final_result(ui, facf, &hunt_result, &culprit_info)?;
    restore_workspace(ui, initial_op_id, args.no_restore)?;

    Ok(())
}

// -------------------------------------------------------------------------------------------------
// Interactive TUI mode
// -------------------------------------------------------------------------------------------------

fn run_tui(
    ui: &mut Ui,
    command: &CommandHelper,
    args: &RunArgs,
    commits: &[Commit],
    facf: &mut State,
    cmd_display: &str,
    initial_op_id: &str,
) -> Result<(), CommandError> {
    let num_suspects = commits.len();
    let null_ui = Ui::null();

    let mut tui =
        HuntTui::new().map_err(|e| user_error(format!("Failed to initialize TUI: {}", e)))?;

    let mut log: Vec<LogEntry> = Vec::new();
    let mut workspace_command = command.workspace_helper(ui)?;

    // Initial draw
    let snap = HuntSnapshot {
        facf,
        current_position: None,
        current_short_id: None,
        num_suspects,
        log: &log,
        status: HuntStatus::Running,
        command: cmd_display.to_string(),
        final_result: None,
        final_short_id: None,
        culprit_info: None,
    };
    let _ = tui.draw(&snap);

    let hunt_result = loop {
        // Check for quit
        if tui.poll_quit().unwrap_or(false) {
            tui.restore().ok();
            restore_workspace(ui, initial_op_id, args.no_restore)?;
            return Err(user_error("Hunt aborted by user"));
        }

        if let Some(result) = facf.result() {
            break result;
        }

        let positions = facf.next_runs(1);
        if positions.is_empty() {
            break SearchResult::NoCulprit { confidence: 0.0 };
        }

        let position = positions[0];
        let commit = &commits[position];
        let commit_id = commit.id().hex();
        let short_id = commit_id[..12.min(commit_id.len())].to_string();

        // Draw with current test info
        let snap = HuntSnapshot {
            facf,
            current_position: Some(position),
            current_short_id: Some(short_id.clone()),
            num_suspects,
            log: &log,
            status: HuntStatus::Running,
            command: cmd_display.to_string(),
            final_result: None,
            final_short_id: None,
            culprit_info: None,
        };
        let _ = tui.draw(&snap);

        // Checkout the commit, suppressing jj output
        {
            let mut tx = workspace_command.start_transaction();
            tx.check_out(commit)?;
            tx.finish(
                &null_ui,
                format!("Updated to revision {} for hunt", short_id),
            )?;
        }

        let evaluation = evaluate_command(args, &commit_id, position)?;

        let test_result = match evaluation {
            Evaluation::Pass => TestResult::Pass,
            Evaluation::Fail => TestResult::Fail,
            Evaluation::Skip => TestResult::Fail,
            Evaluation::Abort => {
                tui.restore().ok();
                restore_workspace(ui, initial_op_id, args.no_restore)?;
                return Err(user_error("Hunt aborted by command (exit code 127)"));
            }
        };

        facf.record_result(position, test_result);

        log.push(LogEntry {
            iteration: facf.iterations(),
            position,
            num_suspects,
            short_id: short_id.clone(),
            result: test_result,
        });

        // Redraw with updated state
        let snap = HuntSnapshot {
            facf,
            current_position: Some(position),
            current_short_id: Some(short_id),
            num_suspects,
            log: &log,
            status: HuntStatus::Running,
            command: cmd_display.to_string(),
            final_result: None,
            final_short_id: None,
            culprit_info: None,
        };
        let _ = tui.draw(&snap);

        workspace_command = command.workspace_helper(ui)?;
    };

    // Build culprit info before final screen
    let culprit_info = build_culprit_info(&hunt_result, commits);

    let final_short_id = match &hunt_result {
        SearchResult::Culprit { position, .. } => {
            let id = commits[*position].id().hex();
            Some(id[..12.min(id.len())].to_string())
        }
        SearchResult::NoCulprit { .. } => None,
    };

    let snap = HuntSnapshot {
        facf,
        current_position: None,
        current_short_id: None,
        num_suspects,
        log: &log,
        status: HuntStatus::Finished,
        command: cmd_display.to_string(),
        final_result: Some(hunt_result.clone()),
        final_short_id: final_short_id.clone(),
        culprit_info: culprit_info.clone(),
    };
    let _ = tui.draw(&snap);
    let _ = tui.wait_for_key();
    tui.restore().ok();

    // Print final result to normal stdout after TUI exits
    print_final_result(ui, facf, &hunt_result, &culprit_info)?;
    restore_workspace(ui, initial_op_id, args.no_restore)?;

    Ok(())
}

// -------------------------------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------------------------------

fn build_culprit_info(hunt_result: &SearchResult, commits: &[Commit]) -> Option<CulpritInfo> {
    match hunt_result {
        SearchResult::Culprit {
            position,
            confidence,
        } => {
            let commit = &commits[*position];
            let commit_id = commit.id().hex();
            let change_id = commit.change_id().reverse_hex();
            let description = commit.description().to_string();
            let author = commit.author();
            Some(CulpritInfo {
                position: *position,
                confidence: *confidence,
                commit_id,
                change_id,
                description,
                author_name: author.name.clone(),
                author_email: author.email.clone(),
            })
        }
        SearchResult::NoCulprit { .. } => None,
    }
}

fn print_final_result(
    ui: &mut Ui,
    facf: &State,
    hunt_result: &SearchResult,
    culprit_info: &Option<CulpritInfo>,
) -> Result<(), CommandError> {
    writeln!(ui.stdout())?;
    writeln!(
        ui.stdout(),
        "Hunt complete after {} iterations.",
        facf.iterations()
    )?;
    writeln!(ui.stdout())?;

    match hunt_result {
        SearchResult::Culprit { .. } => {
            let info = culprit_info.as_ref().unwrap();
            let short_commit = &info.commit_id[..12.min(info.commit_id.len())];
            let short_change = &info.change_id[..12.min(info.change_id.len())];
            writeln!(
                ui.stdout(),
                "Found culprit at position {}/{} ({:.1}% confidence):",
                info.position + 1,
                facf.num_suspects(),
                info.confidence * 100.0,
            )?;
            writeln!(ui.stdout(), "  Change:  {}", short_change)?;
            writeln!(ui.stdout(), "  Commit:  {}", short_commit)?;
            writeln!(
                ui.stdout(),
                "  Author:  {} <{}>",
                info.author_name,
                info.author_email
            )?;
            let first_line = info
                .description
                .lines()
                .next()
                .unwrap_or("(no description)");
            writeln!(ui.stdout(), "  Description: {}", first_line)?;
        }
        SearchResult::NoCulprit { confidence } => {
            writeln!(
                ui.stdout(),
                "No culprit found ({:.1}% confidence) - the original failure was likely a flake",
                confidence * 100.0
            )?;
        }
    }

    Ok(())
}

fn restore_workspace(
    ui: &mut Ui,
    initial_op_id: &str,
    no_restore: bool,
) -> Result<(), CommandError> {
    let short_op = &initial_op_id[..12.min(initial_op_id.len())];

    if no_restore {
        writeln!(ui.stdout())?;
        writeln!(ui.stdout(), "To restore workspace to pre-hunt state, run:")?;
        writeln!(ui.stdout(), "  jj op restore {}", short_op)?;
        return Ok(());
    }

    writeln!(ui.stdout())?;
    writeln!(ui.stdout(), "Restoring workspace to pre-hunt state...")?;

    let exe = std::env::current_exe()
        .map_err(|e| user_error(format!("Failed to find current executable: {}", e)))?;

    let status = std::process::Command::new(&exe)
        .args(["op", "restore", initial_op_id])
        .status()
        .map_err(|e| user_error(format!("Failed to run 'op restore': {}", e)))?;

    if status.success() {
        writeln!(ui.stdout(), "Workspace restored to operation {}", short_op)?;
    } else {
        writeln!(
            ui.warning_default(),
            "Failed to restore workspace. To restore manually, run:"
        )?;
        writeln!(ui.warning_default(), "  jj op restore {}", short_op)?;
    }

    Ok(())
}

fn resolve_commits_in_order(
    ui: &Ui,
    workspace_command: &jj_cli::cli_util::WorkspaceCommandHelper,
    revision_args: &[RevisionArg],
) -> Result<Vec<Commit>, CommandError> {
    let expression = workspace_command.parse_union_revsets(ui, revision_args)?;

    let commit_iter = expression.evaluate_to_commits()?;
    let mut commits: Vec<Commit> = Vec::new();
    for commit_result in commit_iter {
        commits.push(commit_result?);
    }

    // Reverse to get oldest-to-newest order (position 0 = oldest)
    commits.reverse();

    Ok(commits)
}

fn evaluate_command(
    args: &RunArgs,
    commit_id: &str,
    position: usize,
) -> Result<Evaluation, CommandError> {
    let mut cmd = std::process::Command::new(&args.command);
    cmd.args(&args.args);

    cmd.env("JJ_HUNT_TARGET", commit_id);
    cmd.env("JJ_HUNT_POSITION", position.to_string());

    if let Ok(exe_path) = std::env::current_exe() {
        cmd.env("JJ_EXECUTABLE_PATH", exe_path);
    }

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let status = cmd.status().map_err(|err| {
        user_error_with_message(
            format!("Failed to run evaluation command '{}'", args.command),
            err,
        )
    })?;

    let evaluation = if status.success() {
        Evaluation::Pass
    } else {
        match status.code() {
            Some(125) => Evaluation::Skip,
            Some(127) => Evaluation::Abort,
            _ => Evaluation::Fail,
        }
    };

    Ok(evaluation)
}
