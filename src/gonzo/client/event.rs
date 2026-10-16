// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use crossterm::event::{self, Event as CtEvent, KeyEvent};
use tokio::sync::mpsc;

use crate::client::{DownloadResult, FetchResult, ProgressUpdate, UploadResult};

/// Events flowing through the application.
pub enum AppEvent {
    /// A key press from the terminal.
    Key(KeyEvent),
    /// Terminal resize.
    Resize(u16, u16),
    /// Periodic tick for UI refresh.
    Tick,
    /// Connection established successfully.
    Connected,
    /// Connection or operation error.
    Error(String),
    /// Server capabilities received.
    Capabilities(Box<protos::build::bazel::remote::execution::v2::ServerCapabilities>),
    /// Transfer progress update.
    Progress(ProgressUpdate),
    /// Upload completed.
    UploadComplete(UploadResult),
    /// Download completed.
    DownloadComplete(DownloadResult),
    /// Remote asset fetch + download completed.
    FetchComplete(FetchResult),
    /// Remote asset tag completed.
    TagComplete,
}

/// Spawns a background task that polls crossterm for terminal events and
/// sends them (plus periodic ticks) through the returned channel.
pub fn spawn_event_reader(tick_rate: Duration) -> mpsc::UnboundedReceiver<AppEvent> {
    let (tx, rx) = mpsc::unbounded_channel();

    std::thread::spawn(move || {
        loop {
            if event::poll(tick_rate).unwrap_or(false) {
                match event::read() {
                    Ok(CtEvent::Key(key)) => {
                        if tx.send(AppEvent::Key(key)).is_err() {
                            break;
                        }
                    }
                    Ok(CtEvent::Resize(w, h)) => {
                        if tx.send(AppEvent::Resize(w, h)).is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            } else {
                // Tick on poll timeout
                if tx.send(AppEvent::Tick).is_err() {
                    break;
                }
            }
        }
    });

    rx
}

/// Returns the sender half for injecting app-level events (from async tasks).
pub fn event_channel() -> (
    mpsc::UnboundedSender<AppEvent>,
    mpsc::UnboundedReceiver<AppEvent>,
) {
    mpsc::unbounded_channel()
}
