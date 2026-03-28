// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Cell, Gauge, Padding, Paragraph, Row, Table, Wrap},
};

use crate::app::{App, ConnState, MAX_VISIBLE_COMPLETIONS, Screen, fmt_bytes};

// ── Colors ──────────────────────────────────────────────────────────────

const ACCENT: Color = Color::Cyan;
const TITLE_BG: Color = Color::DarkGray;
const OK: Color = Color::Green;
const ERR: Color = Color::Red;
const WARN: Color = Color::Yellow;
const DIM: Color = Color::DarkGray;
const GAUGE_FG: Color = Color::Cyan;
const GAUGE_BG: Color = Color::DarkGray;

// ── Main draw ───────────────────────────────────────────────────────────

pub fn draw(app: &App, frame: &mut Frame) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // title
            Constraint::Min(0),    // body
            Constraint::Length(1), // footer
        ])
        .split(frame.area());

    draw_title_bar(app, frame, chunks[0]);

    match app.screen {
        Screen::Home => draw_home(app, frame, chunks[1]),
        Screen::Capabilities => draw_capabilities(app, frame, chunks[1]),
        Screen::Upload => draw_upload(app, frame, chunks[1]),
        Screen::Download => draw_download(app, frame, chunks[1]),
        Screen::Fetch => draw_fetch(app, frame, chunks[1]),
        Screen::Tag => draw_tag(app, frame, chunks[1]),
    }

    draw_footer(app, frame, chunks[2]);
}

// ── Title bar ───────────────────────────────────────────────────────────

fn draw_title_bar(app: &App, frame: &mut Frame, area: Rect) {
    let conn_indicator = match &app.conn {
        ConnState::Connected => Span::styled(" ● Connected ", Style::default().fg(OK).bold()),
        ConnState::Connecting => Span::styled(" ◌ Connecting… ", Style::default().fg(WARN).bold()),
        ConnState::Disconnected => Span::styled(" ○ Disconnected ", Style::default().fg(DIM)),
        ConnState::Error(msg) => {
            Span::styled(format!(" ✗ {msg} "), Style::default().fg(ERR).bold())
        }
    };

    let title = Line::from(vec![
        Span::styled(
            " cache-client ",
            Style::default()
                .fg(ACCENT)
                .bg(TITLE_BG)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  {}  ", app.server_url),
            Style::default().fg(Color::White).bg(TITLE_BG),
        ),
        conn_indicator,
    ]);

    frame.render_widget(
        Paragraph::new(title).style(Style::default().bg(TITLE_BG)),
        area,
    );
}

// ── Footer ──────────────────────────────────────────────────────────────

fn draw_footer(app: &App, frame: &mut Frame, area: Rect) {
    let items: Vec<Span> = match app.screen {
        Screen::Home => vec![
            key_span("1"),
            label_span(" Capabilities  "),
            key_span("2"),
            label_span(" Upload  "),
            key_span("3"),
            label_span(" Download  "),
            key_span("4"),
            label_span(" Fetch  "),
            key_span("5"),
            label_span(" Tag  "),
            Span::raw("  "),
            key_span("q"),
            label_span(" Quit"),
        ],
        Screen::Upload => vec![
            key_span("Tab"),
            label_span(" Complete  "),
            key_span("Enter"),
            label_span(" Upload  "),
            key_span("Esc"),
            label_span(" Back  "),
        ],
        Screen::Download => vec![
            key_span("Tab"),
            label_span(" Next field  "),
            key_span("Enter"),
            label_span(" Download  "),
            key_span("Esc"),
            label_span(" Back  "),
        ],
        Screen::Fetch => vec![
            key_span("Tab"),
            label_span(" Next field  "),
            key_span("Enter"),
            label_span(" Fetch  "),
            key_span("Esc"),
            label_span(" Back  "),
        ],
        Screen::Tag => vec![
            key_span("Tab"),
            label_span(" Next field  "),
            key_span("Enter"),
            label_span(" Tag  "),
            key_span("Esc"),
            label_span(" Back  "),
        ],
        Screen::Capabilities => vec![
            key_span("Esc"),
            label_span(" Back  "),
            key_span("q"),
            label_span(" Back  "),
        ],
    };

    frame.render_widget(
        Paragraph::new(Line::from(items)).style(Style::default().bg(TITLE_BG)),
        area,
    );
}

fn key_span(key: &str) -> Span<'_> {
    Span::styled(
        format!(" {key} "),
        Style::default().fg(Color::Black).bg(ACCENT).bold(),
    )
}

fn label_span(label: &str) -> Span<'_> {
    Span::styled(label, Style::default().fg(Color::White).bg(TITLE_BG))
}

// ── Home screen ─────────────────────────────────────────────────────────

fn draw_home(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(2, 2, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let logo = vec![
        Line::from(""),
        Line::from(Span::styled(
            "┌─────────────────────────────┐",
            Style::default().fg(ACCENT),
        )),
        Line::from(Span::styled(
            "│    REAPI Cache Client       │",
            Style::default().fg(ACCENT).bold(),
        )),
        Line::from(Span::styled(
            "└─────────────────────────────┘",
            Style::default().fg(ACCENT),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("  Server:  ", Style::default().fg(DIM)),
            Span::styled(&app.server_url, Style::default().fg(Color::White)),
        ]),
        Line::from(vec![
            Span::styled("  Instance:", Style::default().fg(DIM)),
            Span::styled(
                if app.instance_name.is_empty() {
                    " (default)"
                } else {
                    &app.instance_name
                },
                Style::default().fg(Color::White),
            ),
        ]),
        Line::from(""),
        Line::from(Span::styled(
            "  Navigate with number keys shown below",
            Style::default().fg(DIM),
        )),
    ];

    frame.render_widget(Paragraph::new(logo).alignment(Alignment::Left), inner);
}

// ── Capabilities screen ─────────────────────────────────────────────────

fn draw_capabilities(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(" Capabilities ")
        .title_style(Style::default().fg(ACCENT).bold())
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(1, 1, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(ref caps) = app.capabilities else {
        let msg = match &app.conn {
            ConnState::Connected => "Fetching capabilities…",
            ConnState::Connecting => "Connecting…",
            ConnState::Disconnected => "Not connected",
            ConnState::Error(e) => e.as_str(),
        };
        frame.render_widget(Paragraph::new(msg).style(Style::default().fg(WARN)), inner);
        return;
    };

    let mut rows: Vec<Row<'static>> = Vec::new();

    // Cache capabilities
    if let Some(ref cc) = caps.cache_capabilities {
        let digest_fns: Vec<&str> = cc
            .digest_functions
            .iter()
            .map(|d| digest_fn_name(*d))
            .collect();
        rows.push(cap_row("Digest functions", digest_fns.join(", ")));

        rows.push(cap_row(
            "AC update",
            match cc.action_cache_update_capabilities.as_ref() {
                Some(u) if u.update_enabled => "enabled",
                _ => "disabled",
            }
            .to_string(),
        ));

        rows.push(cap_row(
            "Max batch size",
            fmt_bytes(cc.max_batch_total_size_bytes as u64),
        ));

        let compressors: Vec<&str> = cc
            .supported_compressors
            .iter()
            .map(|c| compressor_name(*c))
            .collect();
        if !compressors.is_empty() {
            rows.push(cap_row("Compressors", compressors.join(", ")));
        }

        rows.push(cap_row(
            "Symlink absolute",
            symlink_name(cc.symlink_absolute_path_strategy).to_string(),
        ));
    }

    // Execution capabilities
    if let Some(ref ec) = caps.execution_capabilities {
        rows.push(cap_row(
            "Execution",
            if ec.exec_enabled {
                "enabled"
            } else {
                "disabled"
            }
            .to_string(),
        ));
    }

    // API version
    if let Some(ref lo) = caps.low_api_version {
        rows.push(cap_row(
            "API version (low)",
            format!("{}.{}.{}", lo.major, lo.minor, lo.patch),
        ));
    }
    if let Some(ref hi) = caps.high_api_version {
        rows.push(cap_row(
            "API version (high)",
            format!("{}.{}.{}", hi.major, hi.minor, hi.patch),
        ));
    }

    let table = Table::new(rows, [Constraint::Length(22), Constraint::Min(30)])
        .column_spacing(2)
        .header(
            Row::new(vec![
                Cell::from("Property").style(Style::default().fg(ACCENT).bold()),
                Cell::from("Value").style(Style::default().fg(ACCENT).bold()),
            ])
            .bottom_margin(1),
        );

    frame.render_widget(table, inner);
}

fn cap_row(key: &str, value: String) -> Row<'static> {
    Row::new(vec![
        Cell::from(key.to_string()).style(Style::default().fg(Color::White)),
        Cell::from(value).style(Style::default().fg(Color::Yellow)),
    ])
}

fn digest_fn_name(v: i32) -> &'static str {
    match v {
        0 => "UNKNOWN",
        1 => "SHA-256",
        2 => "SHA-1",
        3 => "MD5",
        4 => "VSO",
        5 => "SHA-384",
        6 => "SHA-512",
        7 => "MURMUR3",
        8 => "SHA-256/TREE",
        9 => "BLAKE3",
        _ => "OTHER",
    }
}

fn compressor_name(v: i32) -> &'static str {
    match v {
        0 => "IDENTITY",
        1 => "ZSTD",
        2 => "DEFLATE",
        3 => "BROTLI",
        _ => "OTHER",
    }
}

fn symlink_name(v: i32) -> &'static str {
    match v {
        0 => "UNKNOWN",
        1 => "DISALLOWED",
        2 => "ALLOWED",
        _ => "OTHER",
    }
}

// ── Upload screen ───────────────────────────────────────────────────────

fn draw_upload(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(" Upload to CAS ")
        .title_style(Style::default().fg(ACCENT).bold())
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(2, 2, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let has_completions = !app.upload_completions.is_empty();
    let visible_count = app.upload_completions.len().min(MAX_VISIBLE_COMPLETIONS);
    let has_overflow = app.upload_completions.len() > MAX_VISIBLE_COMPLETIONS;
    // borders + items + optional overflow line
    let completion_height = if has_completions {
        (visible_count + if has_overflow { 1 } else { 0 } + 2) as u16
    } else {
        0
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),                 // input [0]
            Constraint::Length(completion_height), // completions [1]
            Constraint::Length(1),                 // spacer [2]
            Constraint::Length(3),                 // progress [3]
            Constraint::Length(1),                 // spacer [4]
            Constraint::Min(4),                    // result [5]
        ])
        .split(inner);

    // File path input
    let input_style = if app.upload_busy {
        Style::default().fg(DIM)
    } else {
        Style::default().fg(Color::White)
    };
    let hint = if has_completions {
        ""
    } else {
        " (Tab to complete) "
    };
    let input_block = Block::default()
        .title(format!(" File path{hint}"))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACCENT));
    let cursor_suffix = if !app.upload_busy { "▌" } else { "" };
    let input_text = format!("{}{}", app.upload_path, cursor_suffix);
    frame.render_widget(
        Paragraph::new(input_text)
            .style(input_style)
            .block(input_block),
        chunks[0],
    );

    // Completions list
    if has_completions {
        let mut lines: Vec<Line<'_>> = Vec::new();
        for (i, path) in app
            .upload_completions
            .iter()
            .take(MAX_VISIBLE_COMPLETIONS)
            .enumerate()
        {
            let is_selected = app.upload_completion_selected == Some(i);
            let (style, marker) = if is_selected {
                (Style::default().fg(Color::Black).bg(ACCENT), "▸ ")
            } else {
                (Style::default().fg(Color::White), "  ")
            };
            lines.push(Line::from(Span::styled(format!("{marker}{path}"), style)));
        }
        if has_overflow {
            lines.push(Line::from(Span::styled(
                format!(
                    "  … and {} more",
                    app.upload_completions.len() - MAX_VISIBLE_COMPLETIONS,
                ),
                Style::default().fg(DIM),
            )));
        }
        let title = format!(" {} matches ", app.upload_completions.len());
        let comp_block = Block::default()
            .title(title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(DIM));
        frame.render_widget(Paragraph::new(lines).block(comp_block), chunks[1]);
    }

    // Progress bar
    if let Some(ref prog) = app.upload_progress {
        let label = format!(
            "{}% — {} / {}",
            prog.percent(),
            fmt_bytes(prog.transferred),
            fmt_bytes(prog.total)
        );
        let gauge = Gauge::default()
            .block(
                Block::default()
                    .title(" Progress ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(DIM)),
            )
            .gauge_style(Style::default().fg(GAUGE_FG).bg(GAUGE_BG))
            .percent(prog.percent())
            .label(label);
        frame.render_widget(gauge, chunks[3]);
    }

    // Result
    if let Some(ref result) = app.upload_result {
        let text = match result {
            Ok(r) => {
                let status = if r.already_present {
                    "Already present in CAS"
                } else {
                    "Uploaded successfully"
                };
                Text::from(vec![
                    Line::from(Span::styled(
                        format!("  ✓ {status}"),
                        Style::default().fg(OK).bold(),
                    )),
                    Line::from(""),
                    Line::from(vec![
                        Span::styled("  Hash: ", Style::default().fg(DIM)),
                        Span::styled(&r.hash, Style::default().fg(Color::White)),
                    ]),
                    Line::from(vec![
                        Span::styled("  Size: ", Style::default().fg(DIM)),
                        Span::styled(
                            format!("{} ({})", r.size, fmt_bytes(r.size)),
                            Style::default().fg(Color::White),
                        ),
                    ]),
                ])
            }
            Err(msg) => Text::from(Line::from(Span::styled(
                format!("  ✗ {msg}"),
                Style::default().fg(ERR).bold(),
            ))),
        };

        let result_block = Block::default()
            .title(" Result ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(DIM));
        frame.render_widget(
            Paragraph::new(text)
                .block(result_block)
                .wrap(Wrap { trim: false }),
            chunks[5],
        );
    }
}

// ── Download screen ─────────────────────────────────────────────────────

fn draw_download(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(" Download from CAS ")
        .title_style(Style::default().fg(ACCENT).bold())
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(2, 2, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // hash input
            Constraint::Length(3), // size input
            Constraint::Length(3), // output path input
            Constraint::Length(1), // spacer
            Constraint::Length(3), // progress
            Constraint::Length(1), // spacer
            Constraint::Min(4),    // result
        ])
        .split(inner);

    let fields: [(&str, &str, usize); 3] = [
        (" Hash (SHA-256) ", &app.download_hash, 0),
        (" Size (bytes) ", &app.download_size, 1),
        (" Output path ", &app.download_output, 2),
    ];

    for (i, (title, value, _idx)) in fields.iter().enumerate() {
        let is_focused = app.focus == i && !app.download_busy;
        let border_color = if is_focused { ACCENT } else { DIM };
        let input_block = Block::default()
            .title(*title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color));

        let cursor = if is_focused { "▌" } else { "" };
        let text = format!("{}{}", value, cursor);
        let style = if app.download_busy {
            Style::default().fg(DIM)
        } else {
            Style::default().fg(Color::White)
        };

        frame.render_widget(
            Paragraph::new(text).style(style).block(input_block),
            chunks[i],
        );
    }

    // Progress bar
    if let Some(ref prog) = app.download_progress {
        let label = format!(
            "{}% — {} / {}",
            prog.percent(),
            fmt_bytes(prog.transferred),
            fmt_bytes(prog.total)
        );
        let gauge = Gauge::default()
            .block(
                Block::default()
                    .title(" Progress ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(DIM)),
            )
            .gauge_style(Style::default().fg(GAUGE_FG).bg(GAUGE_BG))
            .percent(prog.percent())
            .label(label);
        frame.render_widget(gauge, chunks[4]);
    }

    // Result
    if let Some(ref result) = app.download_result {
        let text = match result {
            Ok(r) => Text::from(vec![
                Line::from(Span::styled(
                    "  ✓ Downloaded successfully",
                    Style::default().fg(OK).bold(),
                )),
                Line::from(""),
                Line::from(vec![
                    Span::styled("  Hash:   ", Style::default().fg(DIM)),
                    Span::styled(&r.hash, Style::default().fg(Color::White)),
                ]),
                Line::from(vec![
                    Span::styled("  Size:   ", Style::default().fg(DIM)),
                    Span::styled(
                        format!("{} ({})", r.size, fmt_bytes(r.size)),
                        Style::default().fg(Color::White),
                    ),
                ]),
                Line::from(vec![
                    Span::styled("  Output: ", Style::default().fg(DIM)),
                    Span::styled(&r.output_path, Style::default().fg(Color::White)),
                ]),
            ]),
            Err(msg) => Text::from(Line::from(Span::styled(
                format!("  ✗ {msg}"),
                Style::default().fg(ERR).bold(),
            ))),
        };

        let result_block = Block::default()
            .title(" Result ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(DIM));
        frame.render_widget(
            Paragraph::new(text)
                .block(result_block)
                .wrap(Wrap { trim: false }),
            chunks[6],
        );
    }
}

// ── Fetch screen ────────────────────────────────────────────────────────

fn draw_fetch(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(" Fetch Remote Asset ")
        .title_style(Style::default().fg(ACCENT).bold())
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(2, 2, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // URI input
            Constraint::Length(3), // qualifier input
            Constraint::Length(3), // output path input
            Constraint::Length(1), // spacer
            Constraint::Length(3), // progress
            Constraint::Length(1), // spacer
            Constraint::Min(4),    // result
        ])
        .split(inner);

    let fields: [(&str, &str, usize); 3] = [
        (" URI ", &app.fetch_uri, 0),
        (" Qualifier (key=value, optional) ", &app.fetch_qualifier, 1),
        (" Output path ", &app.fetch_output, 2),
    ];

    for (i, (title, value, _idx)) in fields.iter().enumerate() {
        let is_focused = app.focus == i && !app.fetch_busy;
        let border_color = if is_focused { ACCENT } else { DIM };
        let input_block = Block::default()
            .title(*title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color));

        let cursor = if is_focused { "▌" } else { "" };
        let text = format!("{}{}", value, cursor);
        let style = if app.fetch_busy {
            Style::default().fg(DIM)
        } else {
            Style::default().fg(Color::White)
        };

        frame.render_widget(
            Paragraph::new(text).style(style).block(input_block),
            chunks[i],
        );
    }

    // Progress bar
    if let Some(ref prog) = app.fetch_progress {
        let label = format!(
            "{}% — {} / {}",
            prog.percent(),
            fmt_bytes(prog.transferred),
            fmt_bytes(prog.total)
        );
        let gauge = Gauge::default()
            .block(
                Block::default()
                    .title(" Progress ")
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(DIM)),
            )
            .gauge_style(Style::default().fg(GAUGE_FG).bg(GAUGE_BG))
            .percent(prog.percent())
            .label(label);
        frame.render_widget(gauge, chunks[4]);
    }

    // Result
    if let Some(ref result) = app.fetch_result {
        let text = match result {
            Ok(r) => Text::from(vec![
                Line::from(Span::styled(
                    "  ✓ Fetched successfully",
                    Style::default().fg(OK).bold(),
                )),
                Line::from(""),
                Line::from(vec![
                    Span::styled("  URI:    ", Style::default().fg(DIM)),
                    Span::styled(&r.uri, Style::default().fg(Color::White)),
                ]),
                Line::from(vec![
                    Span::styled("  Hash:   ", Style::default().fg(DIM)),
                    Span::styled(&r.hash, Style::default().fg(Color::White)),
                ]),
                Line::from(vec![
                    Span::styled("  Size:   ", Style::default().fg(DIM)),
                    Span::styled(
                        format!("{} ({})", r.size, fmt_bytes(r.size)),
                        Style::default().fg(Color::White),
                    ),
                ]),
                Line::from(vec![
                    Span::styled("  Output: ", Style::default().fg(DIM)),
                    Span::styled(&r.output_path, Style::default().fg(Color::White)),
                ]),
            ]),
            Err(msg) => Text::from(Line::from(Span::styled(
                format!("  ✗ {msg}"),
                Style::default().fg(ERR).bold(),
            ))),
        };

        let result_block = Block::default()
            .title(" Result ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(DIM));
        frame.render_widget(
            Paragraph::new(text)
                .block(result_block)
                .wrap(Wrap { trim: false }),
            chunks[6],
        );
    }
}

// ── Tag screen ──────────────────────────────────────────────────────────

fn draw_tag(app: &App, frame: &mut Frame, area: Rect) {
    let block = Block::default()
        .title(" Tag Remote Asset ")
        .title_style(Style::default().fg(ACCENT).bold())
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .padding(Padding::new(2, 2, 1, 1));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // hash input
            Constraint::Length(3), // size input
            Constraint::Length(3), // uri input
            Constraint::Length(3), // qualifier input
            Constraint::Length(1), // spacer
            Constraint::Min(4),    // result
        ])
        .split(inner);

    let fields: [(&str, &str, usize); 4] = [
        (" Hash (SHA-256) ", &app.tag_hash, 0),
        (" Size (bytes) ", &app.tag_size, 1),
        (" URI ", &app.tag_uri, 2),
        (" Qualifier (key=value, optional) ", &app.tag_qualifier, 3),
    ];

    for (i, (title, value, _idx)) in fields.iter().enumerate() {
        let is_focused = app.focus == i && !app.tag_busy;
        let border_color = if is_focused { ACCENT } else { DIM };
        let input_block = Block::default()
            .title(*title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color));

        let cursor = if is_focused { "▌" } else { "" };
        let text = format!("{}{}", value, cursor);
        let style = if app.tag_busy {
            Style::default().fg(DIM)
        } else {
            Style::default().fg(Color::White)
        };

        frame.render_widget(
            Paragraph::new(text).style(style).block(input_block),
            chunks[i],
        );
    }

    // Result
    if let Some(ref result) = app.tag_result {
        let text = match result {
            Ok(()) => Text::from(vec![
                Line::from(Span::styled(
                    "  ✓ Tagged successfully",
                    Style::default().fg(OK).bold(),
                )),
                Line::from(""),
                Line::from(vec![
                    Span::styled("  Hash: ", Style::default().fg(DIM)),
                    Span::styled(&app.tag_hash, Style::default().fg(Color::White)),
                ]),
                Line::from(vec![
                    Span::styled("  URI:  ", Style::default().fg(DIM)),
                    Span::styled(&app.tag_uri, Style::default().fg(Color::White)),
                ]),
            ]),
            Err(msg) => Text::from(Line::from(Span::styled(
                format!("  ✗ {msg}"),
                Style::default().fg(ERR).bold(),
            ))),
        };

        let result_block = Block::default()
            .title(" Result ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(DIM));
        frame.render_widget(
            Paragraph::new(text)
                .block(result_block)
                .wrap(Wrap { trim: false }),
            chunks[5],
        );
    }
}
