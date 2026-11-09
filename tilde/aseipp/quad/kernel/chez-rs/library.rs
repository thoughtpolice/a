// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Libraries of Rust procedures, and the Scheme libraries that bind them.
//!
//! `#[chez::procedure]` makes a Rust function a [`Procedure`]; `library!`
//! gathers some into a [`Library`]. At run time [`Library::register`] makes
//! them known to Chez Scheme; at build time [`Library::scheme_source`]
//! writes the Scheme library that binds them, which a program imports like
//! any other:
//!
//! ```ignore
//! #[chez::procedure]
//! /// The BLAKE3 hash of a bytevector.
//! fn blake3(data: Bytes) -> ByteVec { ... }
//!
//! chez::library! { pub fn native() -> "quad native" { blake3 } }
//! ```
//!
//! gives `(import (quad native))` and `(blake3 #vu8(1 2 3))`.

use std::cell::RefCell;
use std::ffi::{CString, c_void};
use std::fmt::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Once;

use crate::convert::{Error, FromScheme, IntoScheme, Result};
use crate::object;
use crate::sys::{self, Ptr};
use crate::value::{Scope, Value};

/// A Rust procedure, as Scheme sees it.
#[derive(Debug, Clone)]
pub struct Procedure {
    /// Its Scheme name, `blake3` or `ticker-take!`.
    pub name: &'static str,
    /// Its parameters' names, as Scheme writes them.
    pub params: &'static [&'static str],
    /// Its documentation.
    pub doc: &'static str,
    /// Whether it may return Rust objects, which Scheme then guards.
    pub objects: bool,
    /// The C-ABI entry: `extern "C" fn(Ptr, ...) -> Ptr`, one `Ptr` per
    /// parameter.
    pub entry: *const c_void,
}

// The entry is a function pointer: shareable.
unsafe impl Send for Procedure {}
unsafe impl Sync for Procedure {}

/// Implemented by `#[chez::procedure]` for a hidden struct beside the
/// function, which `library!` refers to.
pub trait Export {
    fn procedure() -> Procedure;
}

/// A Scheme library of Rust procedures, named like `"quad native"` for
/// `(quad native)`.
#[derive(Debug, Clone)]
pub struct Library {
    pub name: &'static str,
    pub procedures: Vec<Procedure>,
}

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
    // Running a procedure's body, where a panic becomes a Scheme error.
    static IN_CALL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Keep panics in Rust procedures from printing: Scheme gets their message
/// as an error anyway, and a program drawing on a terminal does not want
/// it written over its screen. Other panics print as before. Process-wide.
pub fn quiet_panics() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !IN_CALL.with(|c| c.get()) {
                previous(info)
            }
        }));
    });
}

/// The symbol a procedure registers as: unique to its library.
fn symbol_name(library: &str, procedure: &str) -> String {
    format!("{library}:{procedure}")
}

fn register_symbol(name: &str, entry: *const c_void) {
    let c = CString::new(name).expect("procedure names hold no NUL");
    // Chez keeps the name: leak it.
    unsafe { sys::Sforeign_symbol(c.into_raw(), entry as *mut c_void) };
}

/// Register the runtime's own entries, which (chez rust) uses.
fn register_runtime() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        register_symbol("chez-rust:last-error", last_error as *const c_void);
        register_symbol("chez-rust:drop", object::drop_handle as *const c_void);
        register_symbol(
            "chez-rust:new-handles",
            object::take_new_handles as *const c_void,
        );
    });
}

unsafe extern "C" fn last_error() -> Ptr {
    let msg = LAST_ERROR.with(|e| std::mem::take(&mut *e.borrow_mut()));
    let s = unsafe { Scope::new() };
    s.string(&msg).raw()
}

impl Library {
    /// Make the procedures callable from Scheme. Call it after the heap is
    /// built (Sbuild_heap), before Scheme calls any of them.
    pub fn register(&self) {
        register_runtime();
        for p in &self.procedures {
            register_symbol(&symbol_name(self.name, p.name), p.entry);
        }
    }

    /// The Scheme library binding these procedures, which imports (chez
    /// rust) for the runtime.
    pub fn scheme_source(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            ";; Generated from Rust by chez::library!: do not edit."
        );
        let _ = writeln!(out, "(library ({})", self.name);
        let _ = writeln!(
            out,
            "  (export {})",
            self.procedures
                .iter()
                .map(|p| p.name)
                .collect::<Vec<_>>()
                .join(" ")
        );
        let _ = writeln!(out, "  (import (chezscheme) (chez rust))");
        for p in &self.procedures {
            let _ = writeln!(out);
            for line in p.doc.lines() {
                let _ = writeln!(
                    out,
                    "  ;;{}{}",
                    if line.is_empty() { "" } else { " " },
                    line.trim_end()
                );
            }
            let _ = writeln!(
                out,
                "  (define-native {} {:?} ({}) {})",
                p.name,
                symbol_name(self.name, p.name),
                p.params.join(" "),
                if p.objects { "#t" } else { "#f" },
            );
        }
        // The last definition closes the library.
        let trimmed = out.trim_end().len();
        out.truncate(trimmed);
        out.push_str(")\n");
        out
    }
}

/// What `#[chez::procedure]` expands to calls; not for direct use.
#[doc(hidden)]
pub mod __private {
    use super::*;

    /// Run a procedure's body in a fresh scope: an error, or a panic,
    /// becomes the last error and the broken-weak-pointer object, which the
    /// Scheme side turns into a raised condition.
    pub fn call(body: impl FnOnce(&Scope) -> Result<Value<'_>>) -> Ptr {
        let scope = unsafe { Scope::new() };
        let outer = IN_CALL.with(|c| c.replace(true));
        let result = catch_unwind(AssertUnwindSafe(|| body(&scope).map(|v| v.raw())));
        IN_CALL.with(|c| c.set(outer));
        match result {
            Ok(Ok(raw)) => raw,
            Ok(Err(e)) => fail(e.0),
            Err(panic) => fail(format!(
                "Rust panicked: {}",
                panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "(no message)".into())
            )),
        }
    }

    fn fail(msg: String) -> Ptr {
        LAST_ERROR.with(|e| *e.borrow_mut() = msg);
        unsafe { sys::chez_bwp() }
    }

    /// Convert argument `index` (from 1), named `name`.
    pub fn arg<'s, T: FromScheme<'s>>(
        scope: &'s Scope,
        raw: Ptr,
        index: usize,
        name: &str,
    ) -> Result<T> {
        let v = unsafe { Value::from_raw(scope, raw) };
        T::from_scheme(v).map_err(|e| Error(format!("argument {index} ({name}): {e}")))
    }

    pub fn ret<T: IntoScheme>(scope: &Scope, x: T) -> Result<Value<'_>> {
        x.into_scheme(scope)
    }
}
