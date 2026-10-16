// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tokio::sync::mpsc;

use protos::build::bazel::remote::execution::v2 as reapi;

use crate::client::{DownloadResult, FetchResult, ProgressUpdate, ReapiClient, UploadResult};
use crate::event::AppEvent;

// ── Screens ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Home,
    Capabilities,
    Upload,
    Download,
    Fetch,
    Tag,
}

// ── Connection state ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnState {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

// ── Transfer tracking ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
    pub started: Instant,
}

impl TransferProgress {
    pub fn ratio(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            self.transferred as f64 / self.total as f64
        }
    }

    pub fn percent(&self) -> u16 {
        (self.ratio() * 100.0).min(100.0) as u16
    }

    pub fn elapsed_secs(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    pub fn rate_bytes_per_sec(&self) -> f64 {
        let elapsed = self.elapsed_secs();
        if elapsed < 0.001 {
            0.0
        } else {
            self.transferred as f64 / elapsed
        }
    }
}

// ── App state ───────────────────────────────────────────────────────────

pub struct App {
    pub running: bool,
    pub screen: Screen,
    pub conn: ConnState,
    pub server_url: String,
    pub instance_name: String,

    // capabilities
    pub capabilities: Option<reapi::ServerCapabilities>,

    // upload
    pub upload_path: String,
    pub upload_completions: Vec<String>,
    pub upload_completion_selected: Option<usize>,
    pub upload_progress: Option<TransferProgress>,
    pub upload_result: Option<Result<UploadResult, String>>,
    pub upload_busy: bool,

    // download
    pub download_hash: String,
    pub download_size: String,
    pub download_output: String,
    pub download_progress: Option<TransferProgress>,
    pub download_result: Option<Result<DownloadResult, String>>,
    pub download_busy: bool,

    // fetch (remote asset download)
    pub fetch_uri: String,
    pub fetch_qualifier: String,
    pub fetch_output: String,
    pub fetch_progress: Option<TransferProgress>,
    pub fetch_result: Option<Result<FetchResult, String>>,
    pub fetch_busy: bool,

    // tag (remote asset)
    pub tag_hash: String,
    pub tag_size: String,
    pub tag_uri: String,
    pub tag_qualifier: String,
    pub tag_result: Option<Result<(), String>>,
    pub tag_busy: bool,

    // input focus (index within current screen's fields)
    pub focus: usize,

    // event sender for dispatching from async tasks
    pub event_tx: mpsc::UnboundedSender<AppEvent>,
}

impl App {
    pub fn new(
        server_url: String,
        instance_name: String,
        event_tx: mpsc::UnboundedSender<AppEvent>,
    ) -> Self {
        Self {
            running: true,
            screen: Screen::Home,
            conn: ConnState::Disconnected,
            server_url,
            instance_name,
            capabilities: None,
            upload_path: String::new(),
            upload_completions: Vec::new(),
            upload_completion_selected: None,
            upload_progress: None,
            upload_result: None,
            upload_busy: false,
            download_hash: String::new(),
            download_size: String::new(),
            download_output: String::new(),
            download_progress: None,
            download_result: None,
            download_busy: false,
            fetch_uri: String::new(),
            fetch_qualifier: String::new(),
            fetch_output: String::new(),
            fetch_progress: None,
            fetch_result: None,
            fetch_busy: false,
            tag_hash: String::new(),
            tag_size: String::new(),
            tag_uri: String::new(),
            tag_qualifier: String::new(),
            tag_result: None,
            tag_busy: false,
            focus: 0,
            event_tx,
        }
    }

    /// Handle a terminal key event.
    pub fn on_key(&mut self, key: KeyEvent) {
        // Global: Ctrl-C always quits
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.running = false;
            return;
        }

        match self.screen {
            Screen::Home => self.on_key_home(key),
            Screen::Capabilities => self.on_key_capabilities(key),
            Screen::Upload => self.on_key_upload(key),
            Screen::Download => self.on_key_download(key),
            Screen::Fetch => self.on_key_fetch(key),
            Screen::Tag => self.on_key_tag(key),
        }
    }

    fn on_key_home(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.running = false,
            KeyCode::Char('1') => self.screen = Screen::Capabilities,
            KeyCode::Char('2') => {
                self.screen = Screen::Upload;
                self.focus = 0;
            }
            KeyCode::Char('3') => {
                self.screen = Screen::Download;
                self.focus = 0;
            }
            KeyCode::Char('4') => {
                self.screen = Screen::Fetch;
                self.focus = 0;
            }
            KeyCode::Char('5') => {
                self.screen = Screen::Tag;
                self.focus = 0;
                // Pre-fill hash/size from last successful upload
                if let Some(Ok(ref r)) = self.upload_result {
                    if self.tag_hash.is_empty() {
                        self.tag_hash = r.hash.clone();
                        self.tag_size = r.size.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    fn on_key_capabilities(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.screen = Screen::Home,
            _ => {}
        }
    }

    fn on_key_upload(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                if !self.upload_completions.is_empty() {
                    self.clear_upload_completions();
                } else if !self.upload_busy {
                    self.screen = Screen::Home;
                }
            }
            KeyCode::Tab if !self.upload_busy => {
                if self.upload_completions.is_empty() {
                    let completions = compute_completions(&self.upload_path);
                    match completions.len() {
                        0 => {}
                        1 => {
                            self.upload_path = completions[0].clone();
                        }
                        _ => {
                            let prefix = common_prefix(&completions);
                            if prefix.len() > self.upload_path.len() {
                                self.upload_path = prefix;
                            }
                            self.upload_completions = completions;
                            self.upload_completion_selected = None;
                        }
                    }
                } else {
                    let idx = match self.upload_completion_selected {
                        None => 0,
                        Some(i) => (i + 1) % self.upload_completions.len(),
                    };
                    self.upload_path = self.upload_completions[idx].clone();
                    self.upload_completion_selected = Some(idx);
                }
            }
            KeyCode::BackTab if !self.upload_busy && !self.upload_completions.is_empty() => {
                let idx = match self.upload_completion_selected {
                    None | Some(0) => self.upload_completions.len() - 1,
                    Some(i) => i - 1,
                };
                self.upload_path = self.upload_completions[idx].clone();
                self.upload_completion_selected = Some(idx);
            }
            KeyCode::Enter => {
                if !self.upload_busy && !self.upload_path.is_empty() {
                    self.clear_upload_completions();
                    self.start_upload();
                }
            }
            KeyCode::Char(c) => {
                self.upload_path.push(c);
                self.clear_upload_completions();
            }
            KeyCode::Backspace => {
                self.upload_path.pop();
                self.clear_upload_completions();
            }
            _ => {}
        }
    }

    fn clear_upload_completions(&mut self) {
        self.upload_completions.clear();
        self.upload_completion_selected = None;
    }

    fn on_key_download(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                if !self.download_busy {
                    self.screen = Screen::Home;
                }
            }
            KeyCode::Tab => {
                self.focus = (self.focus + 1) % 3;
            }
            KeyCode::BackTab => {
                self.focus = if self.focus == 0 { 2 } else { self.focus - 1 };
            }
            KeyCode::Enter => {
                if !self.download_busy
                    && !self.download_hash.is_empty()
                    && !self.download_size.is_empty()
                    && !self.download_output.is_empty()
                {
                    self.start_download();
                }
            }
            KeyCode::Char(c) => {
                self.active_download_field().push(c);
            }
            KeyCode::Backspace => {
                self.active_download_field().pop();
            }
            _ => {}
        }
    }

    fn active_download_field(&mut self) -> &mut String {
        match self.focus {
            0 => &mut self.download_hash,
            1 => &mut self.download_size,
            _ => &mut self.download_output,
        }
    }

    fn on_key_fetch(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                if !self.fetch_busy {
                    self.screen = Screen::Home;
                }
            }
            KeyCode::Tab => {
                self.focus = (self.focus + 1) % 3;
            }
            KeyCode::BackTab => {
                self.focus = if self.focus == 0 { 2 } else { self.focus - 1 };
            }
            KeyCode::Enter => {
                if !self.fetch_busy && !self.fetch_uri.is_empty() && !self.fetch_output.is_empty() {
                    self.start_fetch();
                }
            }
            KeyCode::Char(c) => {
                self.active_fetch_field().push(c);
            }
            KeyCode::Backspace => {
                self.active_fetch_field().pop();
            }
            _ => {}
        }
    }

    fn active_fetch_field(&mut self) -> &mut String {
        match self.focus {
            0 => &mut self.fetch_uri,
            1 => &mut self.fetch_qualifier,
            _ => &mut self.fetch_output,
        }
    }

    fn on_key_tag(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                if !self.tag_busy {
                    self.screen = Screen::Home;
                }
            }
            KeyCode::Tab => {
                self.focus = (self.focus + 1) % 4;
            }
            KeyCode::BackTab => {
                self.focus = if self.focus == 0 { 3 } else { self.focus - 1 };
            }
            KeyCode::Enter => {
                if !self.tag_busy
                    && !self.tag_hash.is_empty()
                    && !self.tag_size.is_empty()
                    && !self.tag_uri.is_empty()
                {
                    self.start_tag();
                }
            }
            KeyCode::Char(c) => {
                self.active_tag_field().push(c);
            }
            KeyCode::Backspace => {
                self.active_tag_field().pop();
            }
            _ => {}
        }
    }

    fn active_tag_field(&mut self) -> &mut String {
        match self.focus {
            0 => &mut self.tag_hash,
            1 => &mut self.tag_size,
            2 => &mut self.tag_uri,
            _ => &mut self.tag_qualifier,
        }
    }

    // ── Async operations ────────────────────────────────────────────────

    fn start_upload(&mut self) {
        self.upload_busy = true;
        self.upload_result = None;
        self.upload_progress = Some(TransferProgress {
            transferred: 0,
            total: 0,
            started: Instant::now(),
        });

        let path = self.upload_path.clone();
        let url = self.server_url.clone();
        let instance = self.instance_name.clone();
        let event_tx = self.event_tx.clone();

        tokio::spawn(async move {
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();

            // Forward progress updates
            let event_tx2 = event_tx.clone();
            tokio::spawn(async move {
                while let Some(p) = progress_rx.recv().await {
                    let _ = event_tx2.send(AppEvent::Progress(p));
                }
            });

            let result = async {
                let mut client = ReapiClient::connect(&url, &instance).await?;
                client
                    .upload_file(std::path::Path::new(&path), progress_tx)
                    .await
            }
            .await;

            match result {
                Ok(r) => {
                    let _ = event_tx.send(AppEvent::UploadComplete(r));
                }
                Err(e) => {
                    let _ = event_tx.send(AppEvent::Error(format!("Upload failed: {e}")));
                }
            }
        });
    }

    fn start_download(&mut self) {
        let size: u64 = match self.download_size.parse() {
            Ok(s) => s,
            Err(_) => {
                self.download_result = Some(Err("invalid size (must be a number)".into()));
                return;
            }
        };

        self.download_busy = true;
        self.download_result = None;
        self.download_progress = Some(TransferProgress {
            transferred: 0,
            total: size,
            started: Instant::now(),
        });

        let hash = self.download_hash.clone();
        let output = self.download_output.clone();
        let url = self.server_url.clone();
        let instance = self.instance_name.clone();
        let event_tx = self.event_tx.clone();

        tokio::spawn(async move {
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();

            let event_tx2 = event_tx.clone();
            tokio::spawn(async move {
                while let Some(p) = progress_rx.recv().await {
                    let _ = event_tx2.send(AppEvent::Progress(p));
                }
            });

            let result = async {
                let mut client = ReapiClient::connect(&url, &instance).await?;
                client
                    .download_blob(&hash, size, std::path::Path::new(&output), progress_tx)
                    .await
            }
            .await;

            match result {
                Ok(r) => {
                    let _ = event_tx.send(AppEvent::DownloadComplete(r));
                }
                Err(e) => {
                    let _ = event_tx.send(AppEvent::Error(format!("Download failed: {e}")));
                }
            }
        });
    }

    fn start_fetch(&mut self) {
        self.fetch_busy = true;
        self.fetch_result = None;
        self.fetch_progress = Some(TransferProgress {
            transferred: 0,
            total: 0,
            started: Instant::now(),
        });

        let uri = self.fetch_uri.clone();
        let qualifier_str = self.fetch_qualifier.clone();
        let output = self.fetch_output.clone();
        let url = self.server_url.clone();
        let instance = self.instance_name.clone();
        let event_tx = self.event_tx.clone();

        tokio::spawn(async move {
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();

            let event_tx2 = event_tx.clone();
            tokio::spawn(async move {
                while let Some(p) = progress_rx.recv().await {
                    let _ = event_tx2.send(AppEvent::Progress(p));
                }
            });

            let result = async {
                let mut client = ReapiClient::connect(&url, &instance).await?;

                let qualifiers = if qualifier_str.is_empty() {
                    Vec::new()
                } else {
                    qualifier_str
                        .split(',')
                        .map(|q| {
                            let q = q.trim();
                            let (k, v) = q.split_once('=').ok_or_else(|| {
                                anyhow::anyhow!("invalid qualifier {q:?}: expected KEY=VALUE")
                            })?;
                            Ok((k.to_string(), v.to_string()))
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?
                };

                client
                    .fetch_asset(&uri, qualifiers, std::path::Path::new(&output), progress_tx)
                    .await
            }
            .await;

            match result {
                Ok(r) => {
                    let _ = event_tx.send(AppEvent::FetchComplete(r));
                }
                Err(e) => {
                    let _ = event_tx.send(AppEvent::Error(format!("Fetch failed: {e}")));
                }
            }
        });
    }

    fn start_tag(&mut self) {
        let size: i64 = match self.tag_size.parse() {
            Ok(s) => s,
            Err(_) => {
                self.tag_result = Some(Err("invalid size (must be a number)".into()));
                return;
            }
        };

        self.tag_busy = true;
        self.tag_result = None;

        let hash = self.tag_hash.clone();
        let uri = self.tag_uri.clone();
        let qualifier_str = self.tag_qualifier.clone();
        let url = self.server_url.clone();
        let instance = self.instance_name.clone();
        let event_tx = self.event_tx.clone();

        tokio::spawn(async move {
            let result = async {
                let mut client = ReapiClient::connect(&url, &instance).await?;

                let uris = vec![uri];
                let qualifiers = if qualifier_str.is_empty() {
                    Vec::new()
                } else {
                    qualifier_str
                        .split(',')
                        .map(|q| {
                            let q = q.trim();
                            let (k, v) = q.split_once('=').ok_or_else(|| {
                                anyhow::anyhow!("invalid qualifier {q:?}: expected KEY=VALUE")
                            })?;
                            Ok((k.to_string(), v.to_string()))
                        })
                        .collect::<anyhow::Result<Vec<_>>>()?
                };

                client.push_blob(&hash, size, uris, qualifiers).await
            }
            .await;

            match result {
                Ok(()) => {
                    let _ = event_tx.send(AppEvent::TagComplete);
                }
                Err(e) => {
                    let _ = event_tx.send(AppEvent::Error(format!("Tag failed: {e}")));
                }
            }
        });
    }

    /// Handle an application-level event.
    pub fn on_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::Key(key) => self.on_key(key),
            AppEvent::Connected => self.conn = ConnState::Connected,
            AppEvent::Error(msg) => {
                if self.upload_busy {
                    self.upload_busy = false;
                    self.upload_result = Some(Err(msg.clone()));
                }
                if self.download_busy {
                    self.download_busy = false;
                    self.download_result = Some(Err(msg.clone()));
                }
                if self.fetch_busy {
                    self.fetch_busy = false;
                    self.fetch_result = Some(Err(msg.clone()));
                }
                if self.tag_busy {
                    self.tag_busy = false;
                    self.tag_result = Some(Err(msg.clone()));
                }
                if self.conn == ConnState::Connecting {
                    self.conn = ConnState::Error(msg);
                }
            }
            AppEvent::Capabilities(caps) => {
                self.capabilities = Some(*caps);
            }
            AppEvent::Progress(p) => {
                if self.upload_busy {
                    if let Some(ref mut prog) = self.upload_progress {
                        prog.transferred = p.transferred;
                        prog.total = p.total;
                    } else {
                        self.upload_progress = Some(TransferProgress {
                            transferred: p.transferred,
                            total: p.total,
                            started: Instant::now(),
                        });
                    }
                }
                if self.download_busy {
                    if let Some(ref mut prog) = self.download_progress {
                        prog.transferred = p.transferred;
                        prog.total = p.total;
                    } else {
                        self.download_progress = Some(TransferProgress {
                            transferred: p.transferred,
                            total: p.total,
                            started: Instant::now(),
                        });
                    }
                }
                if self.fetch_busy {
                    if let Some(ref mut prog) = self.fetch_progress {
                        prog.transferred = p.transferred;
                        prog.total = p.total;
                    } else {
                        self.fetch_progress = Some(TransferProgress {
                            transferred: p.transferred,
                            total: p.total,
                            started: Instant::now(),
                        });
                    }
                }
            }
            AppEvent::UploadComplete(result) => {
                self.upload_busy = false;
                self.upload_result = Some(Ok(result));
            }
            AppEvent::DownloadComplete(result) => {
                self.download_busy = false;
                self.download_result = Some(Ok(result));
            }
            AppEvent::FetchComplete(result) => {
                self.fetch_busy = false;
                self.fetch_result = Some(Ok(result));
            }
            AppEvent::TagComplete => {
                self.tag_busy = false;
                self.tag_result = Some(Ok(()));
            }
            AppEvent::Tick | AppEvent::Resize(_, _) => {}
        }
    }
}

// ── File path completion ─────────────────────────────────────────────────

/// Maximum number of completions to display in the TUI.
pub const MAX_VISIBLE_COMPLETIONS: usize = 8;

fn compute_completions(input: &str) -> Vec<String> {
    let (dir, prefix) = if input.is_empty() {
        (std::path::PathBuf::from("."), String::new())
    } else if input.ends_with('/') {
        (std::path::PathBuf::from(input), String::new())
    } else {
        let p = std::path::Path::new(input);
        let dir = p
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .to_path_buf();
        let prefix = p
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir = if dir.as_os_str().is_empty() {
            std::path::PathBuf::from(".")
        } else {
            dir
        };
        (dir, prefix)
    };

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let show_hidden = prefix.starts_with('.');
    let strip_dot_slash = dir == std::path::Path::new(".") && !input.starts_with("./");

    let mut matches: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !show_hidden && name.starts_with('.') {
                return None;
            }
            if !name.starts_with(&prefix) {
                return None;
            }
            let is_dir = e.file_type().ok()?.is_dir();
            let mut display = if strip_dot_slash {
                name
            } else {
                dir.join(&e.file_name()).to_string_lossy().to_string()
            };
            if is_dir && !display.ends_with('/') {
                display.push('/');
            }
            Some(display)
        })
        .collect();

    matches.sort();
    matches
}

fn common_prefix(strings: &[String]) -> String {
    if strings.is_empty() {
        return String::new();
    }
    let mut prefix = strings[0].clone();
    for s in &strings[1..] {
        while !s.starts_with(&prefix) {
            prefix.pop();
            if prefix.is_empty() {
                return prefix;
            }
        }
    }
    prefix
}

/// Format bytes into a human-readable string.
pub fn fmt_bytes(bytes: u64) -> String {
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
