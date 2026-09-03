// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io;
use std::sync::atomic::{AtomicI32, Ordering};

static SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn receive(signal: libc::c_int) {
    // AtomicI32 is lock-free on the supported Linux targets. A signal handler
    // must not allocate, acquire a lock, or perform campaign cleanup itself.
    let _ = SIGNAL.compare_exchange(0, signal, Ordering::Relaxed, Ordering::Relaxed);
}

pub fn signal() -> Option<i32> {
    match SIGNAL.load(Ordering::Relaxed) {
        0 => None,
        signal => Some(signal),
    }
}

pub fn check() -> io::Result<()> {
    if signal().is_some() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "campaign interrupted",
        ))
    } else {
        Ok(())
    }
}

pub struct Handler {
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl Handler {
    // The CLI runs one campaign at a time; the guard restores the embedding
    // process's signal dispositions when that campaign finishes.
    pub fn install() -> io::Result<Self> {
        SIGNAL.store(0, Ordering::Relaxed);
        let mut handler = Self {
            previous: Vec::new(),
        };
        for signal in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: zero initializes all sigaction flags and padding; the
            // mask is initialized by sigemptyset before sigaction uses it.
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = receive as *const () as libc::sighandler_t;
            // SAFETY: both pointers refer to initialized, live sigaction
            // records, and receive has the required C signal-handler ABI.
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, &mut previous) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            handler.previous.push((signal, previous));
        }
        Ok(handler)
    }
}

impl Drop for Handler {
    fn drop(&mut self) {
        for (signal, previous) in self.previous.iter().rev() {
            // SAFETY: these dispositions were returned by sigaction when
            // this guard was installed and remain valid until restoration.
            unsafe { libc::sigaction(*signal, previous, std::ptr::null_mut()) };
        }
        SIGNAL.store(0, Ordering::Relaxed);
    }
}
