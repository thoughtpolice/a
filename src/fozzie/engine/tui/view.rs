// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Rendering of the monitor's model into a frame. Nothing here reads the
//! clock or the filesystem, so a frame is a function of the model alone.

use super::format;
use super::model::{Campaign, FindingEntry, Focus, Model, State};
use crate::executor::FindingKind;
use crate::status::{Outcome, Phase};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Cell, Clear, Gauge, List, ListItem, ListState, Paragraph, Row, Sparkline, Table,
    TableState, Wrap,
};

const BOLD: Style = Style::new().add_modifier(Modifier::BOLD);
const DIM: Style = Style::new().add_modifier(Modifier::DIM);
const TITLE: Style = Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD);
const KEY: Style = Style::new().fg(Color::Yellow);
const FOCUSED: Style = Style::new().fg(Color::Yellow);
const SELECTED: Style = Style::new().add_modifier(Modifier::REVERSED);
const ERROR: Style = Style::new().fg(Color::Red);
/// Reproduction commands can run to 32 KiB; the detail pane shows the
/// start and points at the metadata for the rest.
const COMMAND_LIMIT: usize = 2048;
const STDERR_LINES: usize = 20;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Panels {
    pub header: Rect,
    pub table: Rect,
    pub timing: Option<Rect>,
    pub results: Option<Rect>,
    pub throughput: Option<Rect>,
    pub workers: Option<Rect>,
    pub yields: Option<Rect>,
    pub findings: Option<Rect>,
    pub detail: Option<Rect>,
    pub identity: Option<Rect>,
    pub footer: Option<Rect>,
}

/// Splits the screen. Under 100 columns or 30 rows the timing and result
/// boxes merge and the worker and yield tables go; under 40x10 only the
/// campaign table remains between the header and footer.
pub fn layout(area: Rect, model: &Model) -> Panels {
    let mut panels = Panels::default();
    if area.height < 3 {
        panels.table = area;
        return panels;
    }
    let rows = model.campaigns.len().max(1) as u16;
    let table_height = (rows + 3).min(8);
    if area.height < 10 || area.width < 40 {
        let [header, table, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
        ])
        .areas(area);
        panels.header = header;
        panels.table = table;
        panels.footer = Some(footer);
        return panels;
    }
    let compact = area.width < 100 || area.height < 30;
    let detail_height = match (model.finding_open, compact) {
        (false, _) => 0,
        (true, true) => 4,
        (true, false) => 8,
    };
    if compact {
        let [header, table, top, findings, detail, identity, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(table_height),
            Constraint::Length(6),
            Constraint::Min(4),
            Constraint::Length(detail_height),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(area);
        let [timing, throughput] =
            Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(top);
        Panels {
            header,
            table,
            timing: Some(timing),
            results: None,
            throughput: Some(throughput),
            workers: None,
            yields: None,
            findings: Some(findings),
            detail: (detail_height > 0).then_some(detail),
            identity: Some(identity),
            footer: Some(footer),
        }
    } else {
        let [header, table, top, middle, detail, identity, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(table_height),
            Constraint::Length(7),
            Constraint::Min(6),
            Constraint::Length(detail_height),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(area);
        let [timing, results, throughput] = Layout::horizontal([
            Constraint::Percentage(30),
            Constraint::Percentage(35),
            Constraint::Percentage(35),
        ])
        .areas(top);
        let [workers, yields, findings] = Layout::horizontal([
            Constraint::Length(28),
            Constraint::Min(30),
            Constraint::Percentage(40),
        ])
        .areas(middle);
        Panels {
            header,
            table,
            timing: Some(timing),
            results: Some(results),
            throughput: Some(throughput),
            workers: Some(workers),
            yields: Some(yields),
            findings: Some(findings),
            detail: (detail_height > 0).then_some(detail),
            identity: Some(identity),
            footer: Some(footer),
        }
    }
}

pub fn draw(model: &Model, frame: &mut Frame) {
    let area = frame.area();
    if model.campaigns.is_empty() {
        let [header, body, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
        ])
        .areas(area);
        draw_header(model, frame, header);
        draw_empty(model, frame, body);
        draw_footer(model, frame, footer);
    } else {
        let panels = layout(area, model);
        draw_header(model, frame, panels.header);
        draw_campaigns(model, frame, panels.table);
        if let Some(campaign) = model.selected_campaign() {
            if let Some(area) = panels.timing {
                draw_timing(model, campaign, frame, area, panels.results.is_none());
            }
            if let Some(area) = panels.results {
                draw_results(campaign, frame, area);
            }
            if let Some(area) = panels.throughput {
                draw_throughput(campaign, frame, area);
            }
            if let Some(area) = panels.workers {
                draw_workers(campaign, frame, area);
            }
            if let Some(area) = panels.yields {
                draw_yields(campaign, frame, area);
            }
            if let Some(area) = panels.findings {
                draw_findings(model, campaign, frame, area);
            }
            if let Some(area) = panels.detail {
                draw_detail(model, frame, area);
            }
            if let Some(area) = panels.identity {
                draw_identity(campaign, frame, area);
            }
        }
        if let Some(area) = panels.footer {
            draw_footer(model, frame, area);
        }
    }
    if model.help {
        draw_help(frame, area);
    }
}

pub fn state_style(state: State) -> Style {
    match state {
        State::Running => Style::new().fg(Color::Green),
        State::Stalled => Style::new().fg(Color::Yellow),
        State::Dead | State::Finished(Outcome::Error | Outcome::Finding) => {
            Style::new().fg(Color::Red)
        }
        State::Finished(Outcome::Budget | Outcome::Interrupted) => DIM,
    }
}

pub fn finding_style(confirmed: bool) -> Style {
    if confirmed {
        Style::new().fg(Color::Red).add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(Color::Yellow)
    }
}

fn block(title: &str, focused: bool) -> Block<'_> {
    let block = Block::bordered().title(Span::styled(title, TITLE));
    if focused {
        block.border_style(FOCUSED)
    } else {
        block
    }
}

fn phase_label(phase: Phase) -> &'static str {
    match phase {
        Phase::Setup => "setup",
        Phase::Calibrating => "calibrating",
        Phase::Fuzzing => "fuzzing",
        Phase::Finished { outcome } => State::Finished(outcome).label(),
    }
}

fn kind_label(kind: FindingKind) -> &'static str {
    match kind {
        FindingKind::Crash => "crash",
        FindingKind::Hang => "hang",
        FindingKind::NonzeroHarness => "nonzero",
        FindingKind::Exit => "exit",
    }
}

fn code_label(record: &crate::status::FindingRecord) -> String {
    match (record.kind, record.fingerprint.code) {
        (FindingKind::Crash, Some(signal)) => format!("signal {signal}"),
        (FindingKind::Exit, Some(code)) => format!("exit {code}"),
        (FindingKind::NonzeroHarness, Some(code)) => format!("returned {code}"),
        (FindingKind::Hang, _) => "timeout".into(),
        (_, None) => String::new(),
    }
}

fn draw_header(model: &Model, frame: &mut Frame, area: Rect) {
    let total = model.campaigns.len();
    let (running, done) = model.counts();
    let mut spans = vec![
        Span::styled("fozzie tui", TITLE),
        Span::raw(format!(
            "  {total} campaign{}",
            if total == 1 { "" } else { "s" }
        )),
    ];
    if total > 0 {
        spans.push(Span::raw(format!(" ({running} running, {done} finished)")));
    }
    if let Some(load) = model.load_average {
        spans.push(Span::raw(format!("  load {load:.2}")));
    }
    spans.push(Span::raw(format!("  {}", format::clock(model.now_ms))));
    frame.render_widget(Line::from(spans), area);
    let hints = Line::from(vec![
        Span::styled("?", KEY),
        Span::raw(" help  "),
        Span::styled("q", KEY),
        Span::raw(" quit"),
    ])
    .right_aligned();
    frame.render_widget(hints, area);
}

fn draw_campaigns(model: &Model, frame: &mut Frame, area: Rect) {
    let compact = area.width < 100;
    let mut header = vec![
        "name",
        "state",
        if compact { "up" } else { "uptime" },
        "execs",
        "exec/s",
        "corpus",
    ];
    if !compact {
        header.push("features");
    }
    header.extend(["edges", "findings", "last path"]);
    let rows = model.campaigns.iter().map(|campaign| {
        let (confirmed, flaky) = campaign.finding_counts();
        let coverage = match campaign.map_density() {
            Some(density) => format::percent(density),
            None => format::count_exact(campaign.status.edges as u64),
        };
        let findings = if flaky > 0 {
            format!("{confirmed}+{flaky}")
        } else {
            confirmed.to_string()
        };
        let findings_style = if confirmed > 0 {
            finding_style(true)
        } else if flaky > 0 {
            finding_style(false)
        } else {
            Style::new()
        };
        let mut cells = vec![
            Cell::from(campaign.name.clone()),
            Cell::from(Span::styled(
                campaign.state.label(),
                state_style(campaign.state),
            )),
            Cell::from(format::duration(campaign.uptime_ms(model.now_ms))),
            Cell::from(format::count(campaign.status.executions)),
            Cell::from(format::rate(campaign.display_rate())),
            Cell::from(format::count_exact(campaign.status.corpus_size as u64)),
        ];
        if !compact {
            cells.push(Cell::from(format::count_exact(
                campaign.status.features as u64,
            )));
        }
        cells.push(Cell::from(coverage));
        cells.push(Cell::from(Span::styled(findings, findings_style)));
        cells.push(Cell::from(format::age(
            campaign.last_new_path_age_ms(model.now_ms),
        )));
        Row::new(cells)
    });
    let mut widths = vec![
        Constraint::Min(12),
        Constraint::Length(20),
        Constraint::Length(7),
        Constraint::Length(7),
        Constraint::Length(8),
        Constraint::Length(7),
    ];
    if !compact {
        widths.push(Constraint::Length(8));
    }
    widths.extend([
        Constraint::Length(7),
        Constraint::Length(8),
        Constraint::Length(10),
    ]);
    let table = Table::new(rows, widths)
        .header(Row::new(
            header
                .iter()
                .map(|title| Cell::from(Span::styled(*title, BOLD))),
        ))
        .block(block("campaigns", model.focus == Focus::Campaigns))
        .row_highlight_style(SELECTED)
        .highlight_symbol("> ");
    let mut state = TableState::new().with_selected(model.selected_index());
    frame.render_stateful_widget(table, area, &mut state);
}

fn draw_timing(model: &Model, campaign: &Campaign, frame: &mut Frame, area: Rect, merged: bool) {
    let status = &campaign.status;
    let mut lines = vec![
        labelled(
            "run time",
            format::duration(campaign.uptime_ms(model.now_ms)),
        ),
        labelled(
            "last new path",
            format::age(campaign.last_new_path_age_ms(model.now_ms)),
        ),
        labelled(
            "last finding",
            format::age(campaign.last_finding_age_ms(model.now_ms)),
        ),
        labelled("phase", phase_label(status.phase).to_owned()),
    ];
    let title = if merged {
        lines = vec![
            Line::from(vec![
                Span::styled("run time ", DIM),
                Span::raw(format::duration(campaign.uptime_ms(model.now_ms))),
                Span::styled("  phase ", DIM),
                Span::raw(phase_label(status.phase)),
            ]),
            Line::from(vec![
                Span::styled("new path ", DIM),
                Span::raw(format::age(campaign.last_new_path_age_ms(model.now_ms))),
                Span::styled("  finding ", DIM),
                Span::raw(format::age(campaign.last_finding_age_ms(model.now_ms))),
            ]),
            Line::from(vec![
                Span::styled("execs ", DIM),
                Span::raw(format::count(status.executions)),
                Span::styled("  verify ", DIM),
                Span::raw(status.verification_executions.to_string()),
                Span::styled("  corpus ", DIM),
                Span::raw(format::count_exact(status.corpus_size as u64)),
            ]),
            Line::from(vec![
                Span::styled("features ", DIM),
                Span::raw(format::count_exact(status.features as u64)),
                Span::styled("  edges ", DIM),
                Span::raw(format::count_exact(status.edges as u64)),
                Span::styled("  map ", DIM),
                Span::raw(
                    campaign
                        .map_density()
                        .map_or_else(|| "n/a".to_owned(), format::percent),
                ),
            ]),
        ];
        "timing / results"
    } else {
        "process timing"
    };
    frame.render_widget(Paragraph::new(lines).block(block(title, false)), area);
}

fn labelled(label: &str, value: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(format!("{label:<14}"), DIM),
        Span::raw(value),
    ])
}

fn draw_results(campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let status = &campaign.status;
    let outer = block("overall results", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);
    let [text, gauge] = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(inner);
    let lines = vec![
        Line::from(vec![
            Span::styled(format!("{:<12}", "executions"), DIM),
            Span::raw(format::count(status.executions)),
            Span::styled(format!(" (verify {})", status.verification_executions), DIM),
        ]),
        Line::from(vec![
            Span::styled(format!("{:<12}", "corpus"), DIM),
            Span::raw(format::count_exact(status.corpus_size as u64)),
            Span::styled(format!(" ({} new)", status.interesting_inputs), DIM),
        ]),
        Line::from(vec![
            Span::styled(format!("{:<12}", "features"), DIM),
            Span::raw(format::count_exact(status.features as u64)),
            Span::styled("  edges ", DIM),
            Span::raw(format::count_exact(status.edges as u64)),
        ]),
        Line::from(vec![
            Span::styled(format!("{:<12}", "dictionary"), DIM),
            Span::raw(format::count_exact(status.dictionary_entries as u64)),
        ]),
    ];
    frame.render_widget(Paragraph::new(lines), text);
    match campaign.map_density() {
        Some(density) => {
            let label = format!(
                "map {} of {}",
                format::percent(density),
                format::count(status.counters)
            );
            frame.render_widget(
                Gauge::default()
                    .ratio(density.clamp(0.0, 1.0))
                    .label(label)
                    .gauge_style(Style::new().fg(Color::Blue)),
                gauge,
            );
        }
        None => frame.render_widget(
            Line::from(vec![
                Span::styled(format!("{:<12}", "map"), DIM),
                Span::raw("unknown"),
            ]),
            gauge,
        ),
    }
}

fn draw_throughput(campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let status = &campaign.status;
    let outer = block("throughput", false);
    let inner = outer.inner(area);
    frame.render_widget(outer, area);
    let [rates, history, workers, feedback] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .areas(inner);
    frame.render_widget(
        Line::from(vec![
            Span::styled("exec/s now ", DIM),
            Span::raw(format::rate(campaign.display_rate())),
            Span::styled("   avg ", DIM),
            Span::raw(format::rate(campaign.average_rate())),
        ]),
        rates,
    );
    let data: Vec<u64> = campaign.rates().collect();
    let window = data.len().saturating_sub(history.width as usize);
    frame.render_widget(
        Sparkline::default()
            .data(&data[window..])
            .style(Style::new().fg(Color::Green)),
        history,
    );
    frame.render_widget(
        Line::from(vec![
            Span::styled("jobs ", DIM),
            Span::raw(status.jobs.to_string()),
            Span::styled("  restarts ", DIM),
            Span::raw(status.worker_restarts.to_string()),
            Span::styled("  unstable ", DIM),
            Span::raw(status.unstable_seeds.to_string()),
        ]),
        workers,
    );
    frame.render_widget(
        Line::from(vec![
            Span::styled("truncated ", DIM),
            Span::raw(status.truncated_observations.to_string()),
            Span::styled("  flaky ", DIM),
            Span::raw(status.flaky_findings.to_string()),
        ]),
        feedback,
    );
}

fn draw_workers(campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let rows = campaign.status.workers.iter().map(|worker| {
        Row::new([
            Cell::from(worker.id.to_string()),
            Cell::from(format::count(worker.executions)),
            Cell::from(worker.restarts.to_string()),
            Cell::from(format::count(worker.last_input_len as u64)),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(3),
            Constraint::Length(7),
            Constraint::Length(4),
            Constraint::Length(7),
        ],
    )
    .header(Row::new(
        ["id", "execs", "rst", "last"]
            .into_iter()
            .map(|title| Cell::from(Span::styled(title, BOLD))),
    ))
    .block(block("workers", false));
    frame.render_widget(table, area);
}

fn draw_yields(campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let rows = campaign.status.mutators.iter().map(|mutator| {
        let share = if mutator.applied == 0 {
            "-".to_owned()
        } else {
            let share = mutator.useful as f64 * 100.0 / mutator.applied as f64;
            if mutator.useful > 0 && share < 0.01 {
                "<0.01%".to_owned()
            } else {
                format!("{share:.2}%")
            }
        };
        Row::new([
            Cell::from(mutator.name.clone()),
            Cell::from(format::count(mutator.applied)),
            Cell::from(format::count(mutator.useful)),
            Cell::from(share),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Min(12),
            Constraint::Length(8),
            Constraint::Length(8),
            Constraint::Length(7),
        ],
    )
    .header(Row::new(
        ["mutator", "applied", "useful", "yield"]
            .into_iter()
            .map(|title| Cell::from(Span::styled(title, BOLD))),
    ))
    .block(block("strategy yields", false));
    frame.render_widget(table, area);
}

fn finding_line(entry: &FindingEntry, now_ms: u64, width: usize) -> Line<'static> {
    let record = &entry.record;
    let age = if entry.modified_ms == 0 {
        String::new()
    } else {
        format::age(Some(now_ms.saturating_sub(entry.modified_ms)))
    };
    let mut spans = vec![
        Span::styled(
            format!("{:<8}", kind_label(record.kind)),
            finding_style(record.confirmed),
        ),
        Span::raw(format!(
            "{:<10}",
            if record.confirmed {
                "confirmed"
            } else {
                "flaky"
            }
        )),
        Span::raw(format!("{}  ", code_label(record))),
    ];
    if let Some(sanitizer) = record.fingerprint.sanitizer.as_deref() {
        spans.push(Span::raw(format!("{sanitizer}  ")));
    }
    let used: usize = spans.iter().map(|span| span.width()).sum();
    let room = width.saturating_sub(used + age.len() + 1);
    spans.push(Span::styled(
        format::truncate(&record.detail, room).into_owned(),
        DIM,
    ));
    if !age.is_empty() {
        spans.push(Span::styled(format!("  {age}"), DIM));
    }
    Line::from(spans)
}

fn draw_findings(model: &Model, campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let title = format!("findings ({})", campaign.findings.len());
    let outer = block(&title, model.focus == Focus::Findings);
    let width = outer.inner(area).width.saturating_sub(2) as usize;
    let items = campaign
        .findings
        .iter()
        .map(|entry| ListItem::new(finding_line(entry, model.now_ms, width)));
    let list = List::new(items)
        .block(outer)
        .highlight_symbol("> ")
        .highlight_style(if model.focus == Focus::Findings {
            SELECTED
        } else {
            BOLD
        });
    let mut state = ListState::default();
    if !campaign.findings.is_empty() {
        state.select(Some(model.selected_finding));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn draw_detail(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(entry) = model.selected_finding() else {
        return;
    };
    let record = &entry.record;
    let mut title = format!(
        "finding: {} ({}) {}",
        kind_label(record.kind),
        if record.confirmed {
            "confirmed"
        } else {
            "flaky"
        },
        code_label(record),
    );
    if let Some(sanitizer) = record.fingerprint.sanitizer.as_deref() {
        title.push(' ');
        title.push_str(sanitizer);
    }
    title.push_str(&format!(
        "  input {} B  execution #{}",
        record.input_size, record.execution
    ));
    let mut lines = vec![
        command_line("repro", &record.repro),
        command_line("minimize", &record.minimize),
    ];
    if !record.stderr.trim().is_empty() {
        lines.push(Line::from(Span::styled(
            format!("stderr (last {STDERR_LINES} lines):"),
            DIM,
        )));
        for line in format::tail(&record.stderr, STDERR_LINES) {
            lines.push(Line::from(line.to_owned()));
        }
    }
    let paragraph = Paragraph::new(Text::from(lines))
        .block(block(&title, model.focus == Focus::Detail))
        .wrap(Wrap { trim: false })
        .scroll((model.detail_scroll, 0));
    frame.render_widget(paragraph, area);
}

fn command_line(label: &str, command: &str) -> Line<'static> {
    let mut spans = vec![Span::styled(format!("{label}: "), DIM)];
    if command.len() > COMMAND_LIMIT {
        let cut = (0..=COMMAND_LIMIT)
            .rev()
            .find(|index| command.is_char_boundary(*index))
            .unwrap_or(0);
        spans.push(Span::raw(command[..cut].to_owned()));
        spans.push(Span::styled(
            format!("… ({} bytes; see metadata)", command.len()),
            DIM,
        ));
    } else {
        spans.push(Span::raw(command.to_owned()));
    }
    Line::from(spans)
}

fn draw_identity(campaign: &Campaign, frame: &mut Frame, area: Rect) {
    let status = &campaign.status;
    let target = status
        .target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    // The path comes last so that a long one is what gets clipped.
    let mut spans = vec![
        Span::styled("target ", DIM),
        Span::raw(target),
        Span::styled("  seed ", DIM),
        Span::raw(status.seed.to_string()),
        Span::styled("  pid ", DIM),
        Span::raw(status.pid.to_string()),
        Span::styled("  sanitizer ", DIM),
        Span::raw(status.sanitizer.clone()),
        Span::styled("  timeout ", DIM),
        Span::raw(format!("{}ms", status.timeout_ms)),
    ];
    if let Some(error) = &status.infrastructure_error {
        spans.push(Span::styled(format!("  error: {error}"), ERROR));
    }
    if let Some(error) = &campaign.read_error {
        spans.push(Span::styled(format!("  {error}"), ERROR));
    }
    spans.push(Span::styled("  workdir ", DIM));
    spans.push(Span::raw(status.workdir.display().to_string()));
    frame.render_widget(Line::from(spans), area);
}

fn draw_footer(model: &Model, frame: &mut Frame, area: Rect) {
    let mut spans = Vec::new();
    let mut hint = |key: &str, what: &str| {
        spans.push(Span::styled(key.to_owned(), KEY));
        spans.push(Span::raw(format!(" {what}  ")));
    };
    hint("j/k", "select");
    hint("Tab", "focus");
    hint("Enter", "finding");
    hint("PgUp/PgDn", "scroll");
    hint("r", "refresh");
    hint("?", "help");
    hint("q", "quit");
    if model.refresh_requested {
        spans.push(Span::styled("refreshing…", DIM));
    }
    frame.render_widget(Line::from(spans), area);
}

fn draw_empty(model: &Model, frame: &mut Frame, area: Rect) {
    let lines = vec![
        Line::from(Span::styled("no campaigns", BOLD)),
        Line::from(model.registry_note.clone()),
        Line::from(""),
        Line::from("pass --workdir DIR, or start a campaign with"),
        Line::from("buck2 run <fuzz target> -- --workdir DIR"),
    ];
    let height = lines.len() as u16;
    let top = area.y + area.height.saturating_sub(height) / 2;
    let centered = Rect::new(area.x, top, area.width, height.min(area.height));
    frame.render_widget(
        Paragraph::new(lines).centered().wrap(Wrap { trim: true }),
        centered,
    );
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let lines: Vec<Line> = [
        (
            "j/k, arrows",
            "select a campaign, a finding, or scroll the detail",
        ),
        (
            "Tab, Shift-Tab",
            "move between the campaigns, findings, and detail",
        ),
        (
            "Enter",
            "open the selected campaign's findings, or a finding",
        ),
        ("PgUp/PgDn", "move ten rows, or scroll five lines"),
        ("Home/End, g/G", "first or last row"),
        ("r", "refresh now"),
        ("?", "toggle this help"),
        ("Esc", "close help, close the detail, then quit"),
        ("q, Ctrl-C", "quit"),
    ]
    .into_iter()
    .map(|(key, what)| {
        Line::from(vec![
            Span::styled(format!("{key:<16}"), KEY),
            Span::raw(what),
        ])
    })
    .collect();
    let width = 70.min(area.width);
    let height = (lines.len() as u16 + 2).min(area.height);
    let popup = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(Paragraph::new(lines).block(block("keys", true)), popup);
}

#[cfg(test)]
mod tests {
    use super::super::model::Snapshot;
    use super::*;
    use crate::executor::FindingFingerprint;
    use crate::status::{FindingRecord, MutatorYield, Status, WorkerStatus};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use std::path::PathBuf;

    fn status(pid: u32, phase: Phase, label: &str) -> Status {
        Status {
            version: crate::status::STATUS_VERSION,
            pid,
            workdir: PathBuf::from(format!("/var/tmp/{label}")),
            target: PathBuf::from("/opt/parser-fuzz"),
            target_label: Some(format!("//demo:{label}")),
            sanitizer: "address".into(),
            seed: 15_737_374,
            jobs: 2,
            timeout_ms: 1000,
            max_input: 65_536,
            started_at_ms: 1_000_000,
            updated_at_ms: 1_060_000,
            phase,
            elapsed_ms: 60_000,
            executions: 246_000,
            verification_executions: 3,
            corpus_size: 1_204,
            features: 8_931,
            edges: 1_102,
            counters: 8_888,
            interesting_inputs: 812,
            last_interesting_ms: Some(48_000),
            last_finding_ms: Some(59_000),
            worker_restarts: 0,
            unstable_seeds: 1,
            truncated_observations: 0,
            flaky_findings: 1,
            dictionary_entries: 511,
            workers: (0..2)
                .map(|id| WorkerStatus {
                    id,
                    executions: 123_000,
                    restarts: 0,
                    last_input_len: 312,
                })
                .collect(),
            mutators: crate::mutate::MUTATOR_NAMES
                .iter()
                .map(|name| MutatorYield {
                    name: (*name).to_owned(),
                    applied: 120_000,
                    useful: 812,
                })
                .collect(),
            finding: None,
            infrastructure_error: None,
            interrupted_signal: None,
        }
    }

    fn finding(kind: FindingKind, confirmed: bool, repro: String, stderr: String) -> FindingEntry {
        let name = format!("{}-abc-0123", kind_label(kind));
        FindingEntry {
            path: PathBuf::from(format!(
                "/var/tmp/parser-fuzz/artifacts/{name}.{}.json",
                if confirmed { "confirmed" } else { "pending" }
            )),
            modified_ms: 1_059_000,
            record: FindingRecord {
                kind,
                fingerprint: FindingFingerprint {
                    kind,
                    code: Some(6),
                    sanitizer: Some("address:heap-buffer-overflow".into()),
                },
                confirmed,
                detail: "target terminated by signal 6".into(),
                input_digest: "abc".into(),
                input_size: 312,
                execution: 4021,
                target_label: None,
                sanitizer: "address".into(),
                repro,
                minimize: "buck2 run root//src/fozzie/engine:fozzie -- minimize".into(),
                stderr,
            },
        }
    }

    fn model() -> Model {
        let mut model = Model::new(1000);
        let findings = vec![
            finding(
                FindingKind::Crash,
                true,
                "buck2 run root//src/fozzie/engine:fozzie -- replay --base64 'YmFk'".into(),
                "==1==ERROR: AddressSanitizer: heap-buffer-overflow\nREAD of size 1\n".into(),
            ),
            finding(FindingKind::Hang, false, String::new(), String::new()),
        ];
        let mut finished = status(
            2,
            Phase::Finished {
                outcome: Outcome::Budget,
            },
            "wedge-smith",
        );
        finished.target_label = None;
        model.apply(
            vec![
                Snapshot {
                    key: PathBuf::from("/var/tmp/parser-fuzz"),
                    status: Some(status(1, Phase::Fuzzing, "parser-fuzz")),
                    read_error: None,
                    pid_alive: true,
                    findings,
                },
                Snapshot {
                    key: PathBuf::from("/var/tmp/wedge-smith"),
                    status: Some(finished),
                    read_error: None,
                    pid_alive: false,
                    findings: Vec::new(),
                },
            ],
            1_060_500,
        );
        model.load_average = Some(3.21);
        model
    }

    fn render(model: &Model, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(model, frame)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn row(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .map(|x| buffer.cell((x, y)).map_or(" ", |cell| cell.symbol()))
            .collect()
    }

    fn rows(buffer: &Buffer) -> Vec<String> {
        (0..buffer.area.height).map(|y| row(buffer, y)).collect()
    }

    /// The column where `text` starts in row `y`, comparing cell by cell
    /// because the box-drawing characters make byte offsets useless.
    fn find_in_row(buffer: &Buffer, y: u16, text: &str) -> Option<u16> {
        let symbols: Vec<&str> = (0..buffer.area.width)
            .map(|x| buffer.cell((x, y)).map_or(" ", |cell| cell.symbol()))
            .collect();
        let wanted: Vec<String> = text.chars().map(|c| c.to_string()).collect();
        (0..symbols.len().saturating_sub(wanted.len() - 1))
            .find(|&x| {
                symbols[x..x + wanted.len()]
                    .iter()
                    .zip(&wanted)
                    .all(|(symbol, wanted)| *symbol == wanted)
            })
            .map(|x| x as u16)
    }

    fn find_below(buffer: &Buffer, first_row: u16, text: &str) -> Option<(u16, u16)> {
        (first_row..buffer.area.height).find_map(|y| find_in_row(buffer, y, text).map(|x| (x, y)))
    }

    #[test]
    fn renders_two_campaigns_with_findings_at_full_size() {
        let model = model();
        let buffer = render(&model, 120, 40);
        let lines = rows(&buffer);
        assert!(
            lines[0].starts_with(
                "fozzie tui  2 campaigns (1 running, 1 finished)  load 3.21  00:17:40Z"
            ),
            "{}",
            lines[0]
        );
        assert!(
            lines[0].trim_end().ends_with("? help  q quit"),
            "{}",
            lines[0]
        );
        assert!(
            lines[3].contains("> //demo:parser-fuzz") && lines[3].contains("running"),
            "{}",
            lines[3]
        );
        assert!(
            lines[3].contains("246k") && lines[3].contains("4.1k/s") && lines[3].contains("1,204"),
            "{}",
            lines[3]
        );
        assert!(
            lines[3].contains("12.4%") && lines[3].contains("1+1") && lines[3].contains("12s ago"),
            "{}",
            lines[3]
        );
        assert!(
            lines[4].contains("wedge-smith") && lines[4].contains("finished:budget"),
            "{}",
            lines[4]
        );
        let (x, y) = find_below(&buffer, 2, "running").unwrap();
        assert_eq!(buffer.cell((x, y)).unwrap().fg, Color::Green);
        let (x, y) = find_below(&buffer, 2, "1+1").unwrap();
        let cell = buffer.cell((x, y)).unwrap();
        assert_eq!(cell.fg, Color::Red);
        assert!(cell.modifier.contains(Modifier::BOLD));
        let text = lines.join("\n");
        for expected in [
            "process timing",
            "overall results",
            "throughput",
            "workers",
            "strategy yields",
            "findings (2)",
            "last new path 12s ago",
            "last finding  1s ago",
            "phase         fuzzing",
            "map 12.4% of 8.9k",
            "exec/s now 4.1k/s",
            "flip_bit",
            "> crash   confirmed signal 6",
            "hang    flaky",
            "workdir /var/tmp/parser-fuzz",
            "seed 15737374",
            "0.68%",
            "j/k select",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(!text.contains("finding: crash"));
    }

    #[test]
    fn the_detail_pane_shows_repro_and_the_stderr_tail() {
        let mut model = model();
        model.handle(super::super::model::Action::Activate);
        let text = rows(&render(&model, 120, 40)).join("\n");
        assert!(text.contains("finding: crash (confirmed) signal 6 address:heap-buffer-overflow  input 312 B  execution #4021"), "{text}");
        assert!(
            text.contains(
                "repro: buck2 run root//src/fozzie/engine:fozzie -- replay --base64 'YmFk'"
            ),
            "{text}"
        );
        assert!(text.contains("stderr (last 20 lines):"), "{text}");
        assert!(text.contains("READ of size 1"), "{text}");

        // A huge command and a long stderr wrap past the pane; scrolling
        // reaches the truncation note and the tail, never the cut lines.
        let long = "x".repeat(40_000);
        let stderr = (0..200).map(|i| format!("line {i}\n")).collect::<String>();
        model.campaigns[0].findings[0] = finding(FindingKind::Crash, true, long, stderr);
        model.focus = Focus::Detail;
        let mut seen = String::new();
        for scroll in 0..60 {
            model.detail_scroll = scroll;
            seen.push_str(&rows(&render(&model, 120, 40)).join("\n"));
        }
        assert!(seen.contains("(40000 bytes; see metadata)"), "{seen}");
        assert!(seen.contains("line 199"), "{seen}");
        assert!(!seen.contains("line 179"), "{seen}");
    }

    #[test]
    fn compact_and_tiny_layouts_render_without_overlap() {
        let mut model = model();
        model.handle(super::super::model::Action::Activate);
        let buffer = render(&model, 80, 24);
        let lines = rows(&buffer);
        assert!(
            lines[2].contains("name") && lines[2].contains("up") && !lines[2].contains("features"),
            "{}",
            lines[2]
        );
        let text = lines.join("\n");
        assert!(text.contains("timing / results"), "{text}");
        assert!(text.contains("findings (2)"), "{text}");
        assert!(text.contains("finding: crash"), "{text}");
        assert!(!text.contains("strategy yields"), "{text}");

        for (width, height) in [(1, 1), (20, 5), (40, 10), (80, 24), (120, 40), (200, 60)] {
            let area = Rect::new(0, 0, width, height);
            let panels = layout(area, &model);
            let mut rects: Vec<Rect> = vec![panels.header, panels.table];
            rects.extend(
                [
                    panels.timing,
                    panels.results,
                    panels.throughput,
                    panels.workers,
                    panels.yields,
                    panels.findings,
                    panels.detail,
                    panels.identity,
                    panels.footer,
                ]
                .into_iter()
                .flatten(),
            );
            for (i, a) in rects.iter().enumerate() {
                for b in &rects[i + 1..] {
                    assert!(
                        a.intersection(*b).is_empty(),
                        "{a:?} overlaps {b:?} at {width}x{height}"
                    );
                }
            }
            render(&model, width, height);
        }
    }

    #[test]
    fn empty_model_and_help_overlay() {
        let mut empty = Model::new(1000);
        empty.registry_note = "registry /home/me/.local/state/fozzie".into();
        let text = rows(&render(&empty, 80, 24)).join("\n");
        assert!(text.contains("no campaigns"), "{text}");
        assert!(
            text.contains("registry /home/me/.local/state/fozzie"),
            "{text}"
        );
        assert!(text.contains("pass --workdir DIR"), "{text}");
        assert!(text.contains("0 campaigns"), "{text}");

        let mut model = model();
        model.help = true;
        let text = rows(&render(&model, 120, 40)).join("\n");
        assert!(text.contains("keys"), "{text}");
        assert!(text.contains("toggle this help"), "{text}");
        render(&model, 30, 8);
    }

    #[test]
    fn styles_follow_state_and_confirmation() {
        assert_eq!(state_style(State::Running).fg, Some(Color::Green));
        assert_eq!(state_style(State::Stalled).fg, Some(Color::Yellow));
        assert_eq!(state_style(State::Dead).fg, Some(Color::Red));
        assert_eq!(
            state_style(State::Finished(Outcome::Finding)).fg,
            Some(Color::Red)
        );
        assert_eq!(state_style(State::Finished(Outcome::Budget)).fg, None);
        assert!(finding_style(true).add_modifier.contains(Modifier::BOLD));
        assert_eq!(finding_style(false).fg, Some(Color::Yellow));
        assert_eq!(phase_label(Phase::Calibrating), "calibrating");
    }
}
