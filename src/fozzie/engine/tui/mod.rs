// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! `fozzie tui`: an AFL++-style status screen over the campaigns a machine
//! is running, read from their status files and finding metadata.

mod format;
mod model;
mod source;
mod view;

use crate::cli::TuiOptions;
use crate::interrupt;
use crate::status::unix_now_ms;
use anyhow::{Context, Result, bail};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use model::{Action, Model};
use ratatui::backend::TestBackend;
use ratatui::buffer::{Buffer, CellWidth};
use ratatui::{DefaultTerminal, Terminal};
use source::Poller;
use std::io::{IsTerminal, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

pub fn run(options: TuiOptions) -> Result<ExitCode> {
    let mut poller = Poller::new(options.workdirs.clone(), !options.no_registry);
    let mut model = Model::new(options.refresh_ms);
    if options.once {
        return run_once(&options, &mut poller, &mut model);
    }
    if !std::io::stdout().is_terminal() {
        bail!("tui needs a terminal; use --once");
    }
    run_interactive(&options, &mut poller, &mut model)
}

/// Renders one frame into a buffer and prints it as plain text, so scripts
/// and tests see the same screen without a terminal.
fn run_once(options: &TuiOptions, poller: &mut Poller, model: &mut Model) -> Result<ExitCode> {
    let terminal_size = std::io::stdout()
        .is_terminal()
        .then(|| crossterm::terminal::size().ok())
        .flatten();
    let width = options
        .width
        .or(terminal_size.map(|(width, _)| width))
        .unwrap_or(120)
        .max(1);
    let height = options
        .height
        .or(terminal_size.map(|(_, height)| height))
        .unwrap_or(40)
        .max(1);
    refresh(model, poller);
    let mut terminal = Terminal::new(TestBackend::new(width, height))?;
    terminal.draw(|frame| view::draw(model, frame))?;
    let mut stdout = std::io::stdout().lock();
    for line in plain_lines(terminal.backend().buffer()) {
        writeln!(stdout, "{line}").context("writing the screen")?;
    }
    Ok(ExitCode::SUCCESS)
}

fn run_interactive(
    options: &TuiOptions,
    poller: &mut Poller,
    model: &mut Model,
) -> Result<ExitCode> {
    // Raw mode turns Ctrl-C into a key; the handler still catches a signal
    // sent from elsewhere, and the loop leaves through the same restore.
    let _signals = interrupt::Handler::install().context("installing signal handlers")?;
    let mut terminal = ratatui::try_init().context("entering raw mode")?;
    let refresh_every = Duration::from_millis(options.refresh_ms.max(50));
    let result = event_loop(&mut terminal, model, poller, refresh_every);
    ratatui::restore();
    match result? {
        Some(signal) => Ok(ExitCode::from((128 + signal) as u8)),
        None => Ok(ExitCode::SUCCESS),
    }
}

/// Draws, waits for a key until the next refresh is due, and refreshes;
/// `Some(signal)` when a signal ended the loop.
fn event_loop(
    terminal: &mut DefaultTerminal,
    model: &mut Model,
    poller: &mut Poller,
    refresh_every: Duration,
) -> Result<Option<i32>> {
    refresh(model, poller);
    let mut next = Instant::now() + refresh_every;
    loop {
        terminal
            .draw(|frame| view::draw(model, frame))
            .context("drawing the screen")?;
        if model.quit {
            return Ok(None);
        }
        if let Some(signal) = interrupt::signal() {
            return Ok(Some(signal));
        }
        let timeout = next.saturating_duration_since(Instant::now());
        if event::poll(timeout).context("waiting for terminal events")? {
            if let Event::Key(key) = event::read().context("reading terminal events")? {
                if key.kind == KeyEventKind::Press {
                    if let Some(action) = key_to_action(key) {
                        model.handle(action);
                    }
                }
            }
        }
        if model.refresh_requested || Instant::now() >= next {
            refresh(model, poller);
            next = Instant::now() + refresh_every;
        }
    }
}

fn refresh(model: &mut Model, poller: &mut Poller) {
    let snapshots = poller.poll();
    model.registry_note = poller.note().to_owned();
    model.load_average = load_average();
    model.apply(snapshots, unix_now_ms());
    model.refresh_requested = false;
}

fn key_to_action(key: KeyEvent) -> Option<Action> {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    Some(match key.code {
        KeyCode::Char('c') if control => Action::Quit,
        KeyCode::Char('q') => Action::Quit,
        KeyCode::Esc => Action::Back,
        KeyCode::Char('j') | KeyCode::Down => Action::Next,
        KeyCode::Char('k') | KeyCode::Up => Action::Previous,
        KeyCode::Tab => Action::FocusNext,
        KeyCode::BackTab => Action::FocusPrevious,
        KeyCode::Enter => Action::Activate,
        KeyCode::PageDown => Action::PageDown,
        KeyCode::PageUp => Action::PageUp,
        KeyCode::Home | KeyCode::Char('g') => Action::First,
        KeyCode::End | KeyCode::Char('G') => Action::Last,
        KeyCode::Char('r') => Action::Refresh,
        KeyCode::Char('?') => Action::ToggleHelp,
        _ => return None,
    })
}

/// The buffer's rows as text, trailing spaces trimmed and the cells hidden
/// behind wide characters skipped.
fn plain_lines(buffer: &Buffer) -> Vec<String> {
    let width = (buffer.area.width as usize).max(1);
    buffer
        .content
        .chunks(width)
        .map(|cells| {
            let mut line = String::new();
            let mut hidden = 0u16;
            for cell in cells {
                if hidden == 0 {
                    line.push_str(cell.symbol());
                }
                hidden = hidden.max(cell.cell_width()).saturating_sub(1);
            }
            line.trim_end().to_owned()
        })
        .collect()
}

fn load_average() -> Option<f64> {
    let mut samples = [0.0_f64; 1];
    // SAFETY: getloadavg writes at most the requested number of values into
    // the buffer and reads nothing else.
    let written = unsafe { libc::getloadavg(samples.as_mut_ptr(), 1) };
    (written >= 1).then_some(samples[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn keys_map_to_actions() {
        assert_eq!(
            key_to_action(press(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(Action::Quit)
        );
        assert_eq!(
            key_to_action(press(KeyCode::Char('c'), KeyModifiers::NONE)),
            None
        );
        assert_eq!(
            key_to_action(press(KeyCode::Char('q'), KeyModifiers::NONE)),
            Some(Action::Quit)
        );
        assert_eq!(
            key_to_action(press(KeyCode::Down, KeyModifiers::NONE)),
            Some(Action::Next)
        );
        assert_eq!(
            key_to_action(press(KeyCode::Char('G'), KeyModifiers::SHIFT)),
            Some(Action::Last)
        );
        assert_eq!(
            key_to_action(press(KeyCode::BackTab, KeyModifiers::SHIFT)),
            Some(Action::FocusPrevious)
        );
        assert_eq!(
            key_to_action(press(KeyCode::Char('?'), KeyModifiers::NONE)),
            Some(Action::ToggleHelp)
        );
        assert_eq!(
            key_to_action(press(KeyCode::F(1), KeyModifiers::NONE)),
            None
        );
    }

    #[test]
    fn plain_lines_skip_cells_hidden_by_wide_characters() {
        let mut buffer = Buffer::empty(ratatui::layout::Rect::new(0, 0, 6, 2));
        buffer.set_string(0, 0, "日本", ratatui::style::Style::new());
        buffer.set_string(0, 1, "ab", ratatui::style::Style::new());
        assert_eq!(plain_lines(&buffer), ["日本", "ab"]);
    }
}
