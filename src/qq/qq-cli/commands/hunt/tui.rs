// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Stdout};

use crossterm::{
    ExecutableCommand,
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Frame, Terminal,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Bar, BarChart, BarGroup, Block, Borders, Paragraph, Wrap},
};

use super::facf::search::{SearchResult, State, TestResult};

// -------------------------------------------------------------------------------------------------

/// A single log entry for the TUI history.
#[derive(Clone)]
pub(crate) struct LogEntry {
    pub iteration: usize,
    pub position: usize,
    pub num_suspects: usize,
    pub short_id: String,
    pub result: TestResult,
}

/// Details about the culprit commit, if found.
#[derive(Clone)]
pub(crate) struct CulpritInfo {
    pub position: usize,
    pub confidence: f64,
    pub commit_id: String,
    pub change_id: String,
    pub description: String,
    pub author_name: String,
    pub author_email: String,
}

/// Snapshot of hunt state passed to the TUI each iteration.
pub(crate) struct HuntSnapshot<'a> {
    pub facf: &'a State,
    pub current_position: Option<usize>,
    pub current_short_id: Option<String>,
    pub num_suspects: usize,
    pub log: &'a [LogEntry],
    pub status: HuntStatus,
    pub command: String,
    pub final_result: Option<SearchResult>,
    pub final_short_id: Option<String>,
    pub culprit_info: Option<CulpritInfo>,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum HuntStatus {
    Running,
    Finished,
}

// -------------------------------------------------------------------------------------------------

pub(crate) struct HuntTui {
    terminal: Terminal<ratatui::backend::CrosstermBackend<Stdout>>,
}

impl HuntTui {
    pub fn new() -> io::Result<Self> {
        enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        let backend = ratatui::backend::CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }

    pub fn draw(&mut self, snap: &HuntSnapshot) -> io::Result<()> {
        self.terminal.draw(|frame| render(frame, snap))?;
        Ok(())
    }

    /// Poll for quit key (q / Esc / Ctrl-C). Returns true if user wants to quit.
    pub fn poll_quit(&self) -> io::Result<bool> {
        if event::poll(std::time::Duration::from_millis(0))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    return Ok(matches!(key.code, KeyCode::Char('q') | KeyCode::Esc));
                }
            }
        }
        Ok(false)
    }

    /// Block waiting for any key press (used at the end).
    pub fn wait_for_key(&self) -> io::Result<()> {
        loop {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    return Ok(());
                }
            }
        }
    }

    pub fn restore(&mut self) -> io::Result<()> {
        disable_raw_mode()?;
        io::stdout().execute(LeaveAlternateScreen)?;
        Ok(())
    }
}

impl Drop for HuntTui {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

// -------------------------------------------------------------------------------------------------

fn render(frame: &mut Frame, snap: &HuntSnapshot) {
    let area = frame.area();

    let has_culprit = snap.status == HuntStatus::Finished && snap.culprit_info.is_some();
    let is_finished = snap.status == HuntStatus::Finished;

    // Header needs more room in the finished state for the result line which can wrap
    let header_height = if is_finished { 6 } else { 5 };

    let chunks = if has_culprit {
        Layout::vertical([
            Constraint::Length(header_height), // header
            Constraint::Length(7),             // culprit details
            Constraint::Length(8),             // distribution
            Constraint::Min(5),                // log
            Constraint::Length(1),             // footer
        ])
        .split(area)
    } else {
        Layout::vertical([
            Constraint::Length(header_height), // header
            Constraint::Length(0),             // culprit details (hidden)
            Constraint::Length(8),             // distribution
            Constraint::Min(5),                // log
            Constraint::Length(1),             // footer
        ])
        .split(area)
    };

    render_header(frame, chunks[0], snap);
    if has_culprit {
        render_culprit(frame, chunks[1], snap);
    }
    render_distribution(frame, chunks[2], snap);
    render_log(frame, chunks[3], snap);
    render_footer(frame, chunks[4], snap);
}

fn render_header(frame: &mut Frame, area: Rect, snap: &HuntSnapshot) {
    let dist = snap.facf.distribution();
    let max_prob = dist.max();
    let argmax = dist.argmax();
    let argmax_label = if argmax == snap.facf.num_suspects() {
        "no-culprit".to_string()
    } else {
        format!("{}", argmax + 1)
    };

    let config = snap.facf.config();
    let mut lines = vec![
        Line::from(vec![
            Span::styled("Suspects: ", Style::default().fg(Color::DarkGray)),
            Span::raw(format!("{}", snap.num_suspects)),
            Span::raw("  "),
            Span::styled("Flake rate: ", Style::default().fg(Color::DarkGray)),
            Span::raw(format!("{:.1}%", config.flake_rate * 100.0)),
            Span::raw("  "),
            Span::styled("Threshold: ", Style::default().fg(Color::DarkGray)),
            Span::raw(format!("{:.0}%", config.threshold * 100.0)),
        ]),
        Line::from(vec![
            Span::styled("Iterations: ", Style::default().fg(Color::DarkGray)),
            Span::raw(format!("{}", snap.facf.iterations())),
            Span::raw("  "),
            Span::styled("Confidence: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{:.1}%", max_prob * 100.0),
                Style::default().fg(if max_prob >= config.threshold {
                    Color::Green
                } else {
                    Color::Yellow
                }),
            ),
            Span::raw(format!(" at position {}", argmax_label)),
        ]),
    ];

    // Current test line or final verdict
    match &snap.status {
        HuntStatus::Running => {
            if let (Some(pos), Some(id)) = (snap.current_position, &snap.current_short_id) {
                lines.push(Line::from(vec![
                    Span::styled("Testing: ", Style::default().fg(Color::DarkGray)),
                    Span::styled(
                        format!("{}/{} ", pos + 1, snap.num_suspects),
                        Style::default().fg(Color::Cyan),
                    ),
                    Span::raw(id.clone()),
                ]));
            }
        }
        HuntStatus::Finished => {
            if let Some(ref result) = snap.final_result {
                let result_line = match result {
                    SearchResult::Culprit {
                        position,
                        confidence,
                    } => {
                        let id = snap.final_short_id.as_deref().unwrap_or("?");
                        Line::from(vec![
                            Span::styled(
                                "FOUND CULPRIT ",
                                Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                            ),
                            Span::raw(format!(
                                "at position {} ({}) -- {:.1}% confidence",
                                position + 1,
                                id,
                                confidence * 100.0
                            )),
                        ])
                    }
                    SearchResult::NoCulprit { confidence } => Line::from(vec![
                        Span::styled(
                            "NO CULPRIT ",
                            Style::default()
                                .fg(Color::Green)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::raw(format!(
                            "-- likely a flake ({:.1}% confidence)",
                            confidence * 100.0
                        )),
                    ]),
                };
                lines.push(result_line);
            }
        }
    }

    let block = Block::default()
        .title(" jj hunt ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_culprit(frame: &mut Frame, area: Rect, snap: &HuntSnapshot) {
    let info = match &snap.culprit_info {
        Some(info) => info,
        None => return,
    };

    let short_commit = &info.commit_id[..12.min(info.commit_id.len())];
    let short_change = &info.change_id[..12.min(info.change_id.len())];
    let first_line = info
        .description
        .lines()
        .next()
        .unwrap_or("(no description)");

    let lines = vec![
        Line::from(vec![
            Span::styled("Change:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                short_change.to_string(),
                Style::default().fg(Color::Magenta),
            ),
            Span::raw("  "),
            Span::styled("Commit: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                short_commit.to_string(),
                Style::default().fg(Color::Magenta),
            ),
        ]),
        Line::from(vec![
            Span::styled("Author:  ", Style::default().fg(Color::DarkGray)),
            Span::raw(format!("{} <{}>", info.author_name, info.author_email)),
        ]),
        Line::from(vec![
            Span::styled("Description: ", Style::default().fg(Color::DarkGray)),
            Span::raw(first_line.to_string()),
        ]),
    ];

    let block = Block::default()
        .title(" Culprit ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_distribution(frame: &mut Frame, area: Rect, snap: &HuntSnapshot) {
    let dist = snap.facf.distribution();
    let probs = dist.probs();
    let n = snap.num_suspects;

    // Bucket the distribution into bins that fit the available width
    let inner_width = area.width.saturating_sub(2) as usize; // account for borders
    let num_bins = inner_width.min(n).max(1);
    let bin_size = (n as f64 / num_bins as f64).ceil() as usize;

    let mut bars: Vec<Bar> = Vec::with_capacity(num_bins);
    for bin in 0..num_bins {
        let start = bin * bin_size;
        let end = ((bin + 1) * bin_size).min(n);
        if start >= n {
            break;
        }
        let sum: f64 = probs[start..end].iter().sum();
        // Scale to 0-100 for bar height
        let value = (sum * 1000.0).round() as u64;
        bars.push(
            Bar::default()
                .value(value)
                .style(Style::default().fg(Color::Cyan)),
        );
    }

    // Add no-culprit bin
    let no_culprit_val = (probs[n] * 1000.0).round() as u64;
    bars.push(
        Bar::default()
            .value(no_culprit_val)
            .label(Line::from("∅"))
            .style(Style::default().fg(Color::DarkGray)),
    );

    let group = BarGroup::default().bars(&bars);

    let chart = BarChart::default()
        .block(
            Block::default()
                .title(" Distribution ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray)),
        )
        .data(group)
        .bar_width(1)
        .bar_gap(0)
        .value_style(Style::default().fg(Color::Black).bg(Color::Black)); // hide value labels

    frame.render_widget(chart, area);
}

fn render_log(frame: &mut Frame, area: Rect, snap: &HuntSnapshot) {
    let inner_height = area.height.saturating_sub(2) as usize;
    let entries = snap.log;
    let start = entries.len().saturating_sub(inner_height);

    let lines: Vec<Line> = entries[start..]
        .iter()
        .map(|e| {
            let (result_str, color) = match e.result {
                TestResult::Pass => ("PASS", Color::Green),
                TestResult::Fail => ("FAIL", Color::Red),
            };
            Line::from(vec![
                Span::styled(
                    format!("#{:<4} ", e.iteration),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    format!("{:>width$}", e.position + 1, width = digits(e.num_suspects)),
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    format!("/{} ", e.num_suspects),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::raw(format!("{} ", e.short_id)),
                Span::styled(result_str, Style::default().fg(color)),
            ])
        })
        .collect();

    let block = Block::default()
        .title(" Results ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

fn render_footer(frame: &mut Frame, area: Rect, snap: &HuntSnapshot) {
    let text = match snap.status {
        HuntStatus::Running => Line::from(vec![
            Span::styled("cmd: ", Style::default().fg(Color::DarkGray)),
            Span::raw(&snap.command),
            Span::raw("  "),
            Span::styled("q=quit", Style::default().fg(Color::DarkGray)),
        ]),
        HuntStatus::Finished => Line::from(Span::styled(
            "Press any key to exit",
            Style::default().fg(Color::DarkGray),
        )),
    };
    frame.render_widget(Paragraph::new(text), area);
}

fn digits(n: usize) -> usize {
    if n == 0 {
        1
    } else {
        ((n as f64).log10().floor() as usize) + 1
    }
}
