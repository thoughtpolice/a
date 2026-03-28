// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

mod app;
mod client;
mod event;
mod ui;

use std::io;
use std::panic;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use crossterm::{
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use app::{App, ConnState};
use client::ReapiClient;
use event::{AppEvent, spawn_event_reader};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
    name = "cache-client",
    about = "CLI and TUI client for REAPI v2 cache servers",
    version = option_env!("depot_VERSION").unwrap_or("dev"),
)]
struct Cli {
    /// REAPI server URL (e.g. http://127.0.0.1:8080)
    #[arg(
        short,
        long,
        default_value = "http://127.0.0.1:8080",
        env = "CACHE_CLIENT_SERVER",
        global = true
    )]
    server: String,

    /// Instance name for REAPI requests
    #[arg(
        short,
        long,
        default_value = "",
        env = "CACHE_CLIENT_INSTANCE",
        global = true
    )]
    instance: String,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Upload a file to the CAS (optionally tag as a remote asset)
    Upload {
        /// Path to the file to upload
        file: PathBuf,

        /// URIs to tag the uploaded blob with (enables remote asset push after upload)
        #[arg(short, long, num_args = 1..)]
        uri: Vec<String>,

        /// Qualifiers as key=value pairs for the remote asset tag
        #[arg(short, long, value_name = "KEY=VALUE")]
        qualifier: Vec<String>,
    },

    /// Download a blob from the CAS
    Download {
        /// SHA-256 hash of the blob
        hash: String,

        /// Size of the blob in bytes
        size: u64,

        /// Output file path
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Fetch a blob by remote asset URI and download it
    Fetch {
        /// URI of the remote asset
        #[arg(short, long)]
        uri: String,

        /// Qualifiers as key=value pairs to match the asset
        #[arg(short, long, value_name = "KEY=VALUE")]
        qualifier: Vec<String>,

        /// Output file path
        #[arg(short, long)]
        output: PathBuf,
    },

    /// Tag a CAS blob as a remote asset with URIs and optional qualifiers
    Tag {
        /// SHA-256 hash of the blob (already in CAS)
        hash: String,

        /// Size of the blob in bytes
        size: u64,

        /// URIs to associate with the blob (at least one required)
        #[arg(short, long, required = true, num_args = 1..)]
        uri: Vec<String>,

        /// Qualifiers as key=value pairs (e.g. --qualifier resource_type=application/octet-stream)
        #[arg(short, long, value_name = "KEY=VALUE")]
        qualifier: Vec<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(cmd) => run_command(cli.server, cli.instance, cmd),
        None => run_tui(cli.server, cli.instance),
    }
}

// ── Non-interactive commands ────────────────────────────────────────────

fn run_command(server: String, instance: String, cmd: Command) -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(async {
        let mut client = ReapiClient::connect(&server, &instance)
            .await
            .context("failed to connect to server")?;

        match cmd {
            Command::Upload {
                file,
                uri,
                qualifier,
            } => cmd_upload(&mut client, &file, uri, qualifier).await,
            Command::Download { hash, size, output } => {
                cmd_download(&mut client, &hash, size, &output).await
            }
            Command::Fetch {
                uri,
                qualifier,
                output,
            } => cmd_fetch(&mut client, &uri, qualifier, &output).await,
            Command::Tag {
                hash,
                size,
                uri,
                qualifier,
            } => cmd_tag(&mut client, &hash, size, uri, qualifier).await,
        }
    })
}

async fn cmd_upload(
    client: &mut ReapiClient,
    file: &PathBuf,
    uris: Vec<String>,
    qualifier_args: Vec<String>,
) -> Result<()> {
    let (progress_tx, _progress_rx) = tokio::sync::mpsc::unbounded_channel();

    let result = client
        .upload_file(file, progress_tx)
        .await
        .with_context(|| format!("failed to upload {}", file.display()))?;

    if result.already_present {
        eprintln!("already present in CAS");
    } else {
        eprintln!("uploaded {} ({})", file.display(), fmt_bytes(result.size));
    }
    println!("{} {}", result.hash, result.size);

    if !uris.is_empty() {
        let qualifiers = parse_qualifiers(&qualifier_args)?;
        client
            .push_blob(&result.hash, result.size as i64, uris.clone(), qualifiers)
            .await
            .context("failed to tag uploaded blob as remote asset")?;

        eprintln!("tagged with {} URI(s)", uris.len());
        for u in &uris {
            eprintln!("  {u}");
        }
    }

    Ok(())
}

async fn cmd_download(
    client: &mut ReapiClient,
    hash: &str,
    size: u64,
    output: &PathBuf,
) -> Result<()> {
    let (progress_tx, _progress_rx) = tokio::sync::mpsc::unbounded_channel();

    client
        .download_blob(hash, size, output, progress_tx)
        .await
        .with_context(|| format!("failed to download {hash}/{size}"))?;

    eprintln!(
        "downloaded {} to {} ({})",
        hash,
        output.display(),
        fmt_bytes(size),
    );

    Ok(())
}

async fn cmd_fetch(
    client: &mut ReapiClient,
    uri: &str,
    qualifier_args: Vec<String>,
    output: &PathBuf,
) -> Result<()> {
    let qualifiers = parse_qualifiers(&qualifier_args)?;
    let (progress_tx, _progress_rx) = tokio::sync::mpsc::unbounded_channel();

    let result = client
        .fetch_asset(uri, qualifiers, output, progress_tx)
        .await
        .with_context(|| format!("failed to fetch asset {uri}"))?;

    eprintln!(
        "fetched {} -> {} ({})",
        result.uri,
        result.output_path,
        fmt_bytes(result.size),
    );
    println!("{} {}", result.hash, result.size);

    Ok(())
}

async fn cmd_tag(
    client: &mut ReapiClient,
    hash: &str,
    size: u64,
    uris: Vec<String>,
    qualifier_args: Vec<String>,
) -> Result<()> {
    let qualifiers = parse_qualifiers(&qualifier_args)?;

    client
        .push_blob(hash, size as i64, uris.clone(), qualifiers)
        .await
        .context("failed to tag blob as remote asset")?;

    eprintln!("tagged {hash}/{size} with {} URI(s)", uris.len());
    for u in &uris {
        eprintln!("  {u}");
    }

    Ok(())
}

fn parse_qualifiers(args: &[String]) -> Result<Vec<(String, String)>> {
    args.iter()
        .map(|q| {
            let (key, value) = q
                .split_once('=')
                .with_context(|| format!("invalid qualifier {q:?}: expected KEY=VALUE"))?;
            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

fn fmt_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;

    if bytes >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

// ── TUI mode ────────────────────────────────────────────────────────────

fn run_tui(server: String, instance: String) -> Result<()> {
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        default_hook(info);
    }));

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let result = rt.block_on(run_app(&mut terminal, server, instance));

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    server: String,
    instance: String,
) -> Result<()> {
    let (event_tx, mut app_events) = tokio::sync::mpsc::unbounded_channel::<AppEvent>();
    let mut term_events = spawn_event_reader(Duration::from_millis(100));

    let mut app = App::new(server.clone(), instance.clone(), event_tx.clone());

    app.conn = ConnState::Connecting;
    {
        let url = server;
        let inst = instance;
        let tx = event_tx.clone();
        tokio::spawn(async move {
            match ReapiClient::connect(&url, &inst).await {
                Ok(mut client) => {
                    let _ = tx.send(AppEvent::Connected);
                    match client.get_capabilities().await {
                        Ok(caps) => {
                            let _ = tx.send(AppEvent::Capabilities(Box::new(caps)));
                        }
                        Err(e) => {
                            let _ = tx.send(AppEvent::Error(format!("Capabilities: {e}")));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(AppEvent::Error(format!("Connection failed: {e}")));
                }
            }
        });
    }

    loop {
        terminal.draw(|frame| ui::draw(&app, frame))?;

        tokio::select! {
            Some(ev) = term_events.recv() => {
                app.on_event(ev);
            }
            Some(ev) = app_events.recv() => {
                app.on_event(ev);
            }
        }

        if !app.running {
            break;
        }
    }

    Ok(())
}
