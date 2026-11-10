// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Rust for Chez Scheme: components written in Rust, called from Scheme as
//! ordinary procedures, with types checked at the boundary.
//!
//! ```ignore
//! use chez::{Bytes, ByteVec, Object, Ref, RefMut};
//!
//! /// The BLAKE3 hash of a bytevector.
//! #[chez::procedure]
//! fn blake3(data: Bytes) -> ByteVec { blake3::hash(&data).as_bytes().to_vec().into() }
//!
//! struct Counter(u64);
//!
//! #[chez::procedure]
//! fn make_counter() -> Object<Counter> { Object(Counter(0)) }
//!
//! /// Count, returning the count so far.
//! #[chez::procedure(name = "counter-bump!")]
//! fn counter_bump(mut c: RefMut<Counter>) -> u64 { c.0 += 1; c.0 }
//!
//! chez::library! { pub fn library() -> "my native" { blake3, make_counter, counter_bump } }
//! ```
//!
//! At run time, the program embedding Chez Scheme calls
//! `library().register()` once its heap is built; at build time,
//! `library().scheme_source()` is the Scheme library `(my native)`, which
//! binds them (Buck: `chez.rust_library`, toolchains//chez:defs.bzl, does
//! this). Scheme
//! then calls `(blake3 #vu8(1 2 3))`, `(counter-bump! c)`, and a wrong
//! argument is a Scheme error naming it.
//!
//! The layers: [`sys`] is Chez Scheme's C interface, raw; [`Value`] and
//! [`Scope`] are values with lifetimes that keep them from outliving what
//! makes them valid; [`FromScheme`] and [`IntoScheme`] convert; [`Object`]
//! hands Rust values to Scheme; [`Mailbox`] brings values from other
//! threads to Scheme's event loop.

// What #[chez::procedure] expands to names ::chez, here too.
extern crate self as chez;

pub mod sys;

mod convert;
mod library;
mod mailbox;
mod object;
mod value;

pub use chez_macros::{library, procedure};
pub use convert::{ByteVec, Bytes, Error, FromScheme, IntoScheme, Result, Symbol};
pub use library::{__private, Export, Library, Procedure, quiet_panics};
pub use mailbox::{Mailbox, Sender};
pub use object::{Object, Ref, RefMut};
pub use value::{Kind, Root, Scope, Value};

#[cfg(test)]
#[path = "tests/bridge.rs"]
mod bridge_tests;

/// Running Chez Scheme inside a Rust process, for tests: boot it, and
/// evaluate Scheme source.
pub mod testing {
    use std::ffi::CString;

    use crate::{Root, Scope, sys};

    /// Boot Chez Scheme from the given boot files (petite.boot first). Once
    /// per process, on the thread that will run Scheme.
    pub fn boot(boot_files: &[&str]) {
        unsafe {
            sys::Sscheme_init(None);
            for f in boot_files {
                // A relative path would be searched for, as a name.
                let path =
                    std::fs::canonicalize(f).unwrap_or_else(|e| panic!("boot file {f}: {e}"));
                let c = CString::new(path.to_string_lossy().as_bytes()).unwrap();
                sys::Sregister_boot_file(c.as_ptr());
            }
            let name = CString::new("chez-rust-test").unwrap();
            sys::Sbuild_heap(name.as_ptr(), None);
        }
    }

    /// Evaluate every form in `source` at top level, returning the last
    /// value.
    pub fn eval(source: &str) -> Root {
        let mut s = unsafe { Scope::new() };
        let call = |s: &mut Scope, name: &str, args: &[&Root]| {
            let f = Root::new(s.top_level(name).expect("a top-level procedure"));
            s.call(&f, args)
        };
        let src = Root::new(s.string(source));
        let port = call(&mut s, "open-input-string", &[&src]);
        let mut last = Root::new(s.void());
        loop {
            let form = call(&mut s, "read", &[&port]);
            if form.get(&s).is_eof() {
                return last;
            }
            last = call(&mut s, "eval", &[&form]);
        }
    }

    /// Evaluate an expression, and write its value as Scheme would.
    pub fn eval_to_string(expression: &str) -> String {
        let r = eval(&format!(
            "(with-output-to-string (lambda () (write {expression})))"
        ));
        let s = unsafe { Scope::new() };
        r.get(&s).string().expect("a string")
    }
}
