// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust half of quad's kernel: components written in Rust, for Scheme.
//!
//! Each `#[chez::procedure]` is a Scheme procedure in the library
//! `(quad native)`, which the build generates from [`native`] (BUILD's
//! chez.rust_library); arguments and results convert by their Rust types, and
//! errors and panics become Scheme errors. The kernel registers them at boot
//! by calling [`quad_native_register`].
//!
//! Components that run threads of their own -- the network, later -- hand
//! Scheme an object holding a [`Mailbox`], whose file descriptor the editor's
//! event loop polls; the ticker below is the smallest such component.
//!
//! Allocation: there is no `#[global_allocator]`. The executable links
//! mimalloc's malloc override, so Rust's system allocator already allocates
//! from mimalloc, as Chez Scheme and the C kernel do.

use std::time::Duration;

use chez::{ByteVec, Bytes, Mailbox, Object, Ref};

/// The BLAKE3 hash of a bytevector: a 32-byte bytevector.
#[chez::procedure]
fn blake3(data: Bytes) -> ByteVec {
    ByteVec(blake3::hash(&data).as_bytes().to_vec())
}

/// What the Rust half is: "quad-kernel VERSION (rust)".
#[chez::procedure(name = "kernel-rust-version")]
fn version() -> &'static str {
    concat!("quad-kernel ", env!("DEPOT_PACKAGE_VERSION"), " (rust)")
}

/// Ticks from a thread of its own: every interval, the tick's number.
pub struct Ticker {
    ticks: Mailbox<u64>,
}

/// A ticker that ticks `count` times, `interval-ms` apart, then stops. The
/// ticks arrive in Scheme through ticker-take!, once ticker-fd is readable.
#[chez::procedure]
fn make_ticker(interval_ms: u64, count: u64) -> Result<Object<Ticker>, String> {
    let (tx, ticks) = Mailbox::new().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for i in 1..=count {
            std::thread::sleep(Duration::from_millis(interval_ms));
            if tx.send(i).is_err() {
                // Dropped: nobody is listening.
                return;
            }
        }
    });
    Ok(Object(Ticker { ticks }))
}

/// The descriptor that is readable while ticks wait.
#[chez::procedure]
fn ticker_fd(t: Ref<Ticker>) -> i32 {
    t.ticks.fd()
}

/// The ticks waiting, oldest first.
#[chez::procedure(name = "ticker-take!")]
fn ticker_take(t: Ref<Ticker>) -> Vec<u64> {
    t.ticks.take()
}

chez::library! {
    /// `(quad native)`.
    pub fn native() -> "quad native" {
        blake3, version, make_ticker, ticker_fd, ticker_take,
    }
}

/// Register `(quad native)`'s procedures with Chez Scheme: the kernel calls
/// this once the heap is built.
#[unsafe(no_mangle)]
pub extern "C" fn quad_native_register() {
    chez::quiet_panics();
    native().register();
}
