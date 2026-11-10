// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Win32, for what winit does not do on Windows: the clipboard, and whether
//! this process's windows can be seen at all. The clipboard is the windows'
//! thread's, the main thread.

use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
};
use winit::event_loop::EventLoop;

use super::Request;

/// USEROBJECTFLAGS.dwFlags: the window station shows its windows (WinUser.h).
const WSF_VISIBLE: u32 = 1;

/// Whether this process's windows can be seen: whether its window station
/// is the interactive one, as a desktop session's is, and a service's or
/// one started over ssh (OpenSSH's sessions) is not. Where that cannot be
/// told, they can.
pub(super) fn interactive() -> bool {
    let mut flags = USEROBJECTFLAGS::default();
    // SAFETY: this process's window station, which is not closed, and room
    // for the flags asked for.
    let read = unsafe {
        GetProcessWindowStation().and_then(|station| {
            GetUserObjectInformationW(
                HANDLE(station.0),
                UOI_FLAGS,
                Some((&raw mut flags).cast()),
                size_of::<USEROBJECTFLAGS>() as u32,
                None,
            )
        })
    };
    read.is_err() || flags.dwFlags & WSF_VISIBLE != 0
}

/// The system's clipboard, as Unicode text. Windows has no primary
/// selection.
pub(super) struct Clipboard;

/// The clipboard, open, until dropped.
struct Opened;

impl Opened {
    /// Opens the clipboard, which another program may have open for a
    /// moment: tried a few times, a little apart.
    fn new() -> Option<Opened> {
        for _ in 0..10 {
            // SAFETY: no window owns it: the clipboard is this thread's
            // until closed.
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Some(Opened);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        None
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        // SAFETY: opened by this thread (Opened::new).
        let _ = unsafe { CloseClipboard() };
    }
}

impl Clipboard {
    pub(super) fn new(_: &EventLoop<Request>) -> Clipboard {
        Clipboard
    }

    pub(super) fn has_clipboard(&self) -> bool {
        true
    }

    pub(super) fn has_primary(&self) -> bool {
        false
    }

    /// Puts text on the clipboard ("c"), its lines ending as Windows' do;
    /// there is no primary selection ("p") to put it on.
    pub(super) fn store(&self, target: &str, text: String) {
        if target != "c" {
            return;
        }
        let wide: Vec<u16> = crlf(&text)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let Some(_open) = Opened::new() else {
            return;
        };
        // SAFETY: the memory is made here and filled within its size; once
        // the clipboard has it, it is the clipboard's, else it is freed.
        unsafe {
            let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2) else {
                return;
            };
            let at = GlobalLock(memory).cast::<u16>();
            if at.is_null() {
                let _ = GlobalFree(Some(memory));
                return;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), at, wide.len());
            // False once unlocked, which is no error.
            let _ = GlobalUnlock(memory);
            if EmptyClipboard().is_err()
                || SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(memory.0))).is_err()
            {
                let _ = GlobalFree(Some(memory));
            }
        }
    }

    /// What is on the clipboard ("c"), as text, its lines ending in line
    /// feeds alone.
    pub(super) fn load(&self, target: &str) -> Option<String> {
        if target != "c" {
            return None;
        }
        let format = u32::from(CF_UNICODETEXT.0);
        // SAFETY: a question about the clipboard, which needs it unopened.
        unsafe { IsClipboardFormatAvailable(format) }.ok()?;
        let _open = Opened::new()?;
        // SAFETY: the clipboard's memory, which stays its own: read while
        // locked, within its size, and while the clipboard is open.
        let text = unsafe {
            let memory = HGLOBAL(GetClipboardData(format).ok()?.0);
            let at = GlobalLock(memory).cast::<u16>();
            if at.is_null() {
                return None;
            }
            let units = std::slice::from_raw_parts(at, GlobalSize(memory) / 2);
            let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
            let text = String::from_utf16_lossy(&units[..end]);
            let _ = GlobalUnlock(memory);
            text
        };
        Some(text.replace("\r\n", "\n"))
    }
}

/// `text` with each line feed that ends a line preceded by a carriage
/// return, as Windows' programs take text from the clipboard.
fn crlf(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 32);
    let mut previous = '\0';
    for c in text.chars() {
        if c == '\n' && previous != '\r' {
            out.push('\r');
        }
        out.push(c);
        previous = c;
    }
    out
}
