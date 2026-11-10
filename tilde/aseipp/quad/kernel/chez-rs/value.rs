// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Scheme values, safely.
//!
//! A [`Value<'s>`] is a Scheme object, valid for the scope `'s` of the call
//! that received or made it. Chez Scheme moves objects when it collects
//! garbage, and it collects only when Scheme code runs: so values are good
//! for as long as Rust holds the [`Scope`] shared, and anything that runs
//! Scheme code ([`Scope::call`]) takes the scope exclusively, which the
//! borrow checker forbids while any value is still in use. A value that has
//! to live longer is rooted ([`Root`]).

use std::fmt;
use std::marker::PhantomData;

use crate::sys::{self, Ptr};

/// The scope of one call from Scheme into Rust (or of a Rust thread's time
/// in Scheme). It is not `Send`: Scheme objects belong to the thread that
/// runs them.
pub struct Scope {
    _not_send: PhantomData<*mut ()>,
}

impl Scope {
    /// # Safety
    ///
    /// The calling thread must be running Scheme (inside a foreign call, or
    /// activated), and only one scope may be live per thread at a time.
    pub unsafe fn new() -> Scope {
        Scope {
            _not_send: PhantomData,
        }
    }
}

/// A Scheme object, valid during the scope `'s`.
#[derive(Copy, Clone)]
pub struct Value<'s> {
    raw: Ptr,
    _scope: PhantomData<&'s Scope>,
}

/// What a value is, for error messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Fixnum,
    Bignum,
    Flonum,
    Boolean,
    Char,
    Null,
    Pair,
    Symbol,
    String,
    Bytevector,
    Vector,
    Procedure,
    Box,
    Record,
    Void,
    Eof,
    Other,
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Kind::Fixnum => "fixnum",
            Kind::Bignum => "bignum",
            Kind::Flonum => "flonum",
            Kind::Boolean => "boolean",
            Kind::Char => "char",
            Kind::Null => "()",
            Kind::Pair => "pair",
            Kind::Symbol => "symbol",
            Kind::String => "string",
            Kind::Bytevector => "bytevector",
            Kind::Vector => "vector",
            Kind::Procedure => "procedure",
            Kind::Box => "box",
            Kind::Record => "record",
            Kind::Void => "void",
            Kind::Eof => "eof object",
            Kind::Other => "object",
        };
        f.write_str(s)
    }
}

macro_rules! preds {
    ($($name:ident => $f:ident),* $(,)?) => {
        $(pub fn $name(self) -> bool { unsafe { sys::$f(self.raw) != 0 } })*
    };
}

impl<'s> Value<'s> {
    /// # Safety
    ///
    /// `raw` must be a live Scheme object for the whole of `'s`.
    pub unsafe fn from_raw(_scope: &'s Scope, raw: Ptr) -> Value<'s> {
        Value {
            raw,
            _scope: PhantomData,
        }
    }

    pub fn raw(self) -> Ptr {
        self.raw
    }

    preds! {
        is_fixnum => chez_fixnump,
        is_char => chez_charp,
        is_null => chez_nullp,
        is_eof => chez_eof_objectp,
        is_boolean => chez_booleanp,
        is_pair => chez_pairp,
        is_symbol => chez_symbolp,
        is_procedure => chez_procedurep,
        is_flonum => chez_flonump,
        is_vector => chez_vectorp,
        is_bytevector => chez_bytevectorp,
        is_string => chez_stringp,
        is_bignum => chez_bignump,
        is_box => chez_boxp,
        is_record => chez_recordp,
        is_false => chez_is_false,
        is_void => chez_is_void,
    }

    /// Anything but #f is true, in Scheme.
    pub fn is_true(self) -> bool {
        !self.is_false()
    }

    pub fn kind(self) -> Kind {
        if self.is_fixnum() {
            Kind::Fixnum
        } else if self.is_pair() {
            Kind::Pair
        } else if self.is_null() {
            Kind::Null
        } else if self.is_boolean() {
            Kind::Boolean
        } else if self.is_string() {
            Kind::String
        } else if self.is_symbol() {
            Kind::Symbol
        } else if self.is_bytevector() {
            Kind::Bytevector
        } else if self.is_vector() {
            Kind::Vector
        } else if self.is_flonum() {
            Kind::Flonum
        } else if self.is_bignum() {
            Kind::Bignum
        } else if self.is_char() {
            Kind::Char
        } else if self.is_procedure() {
            Kind::Procedure
        } else if self.is_box() {
            Kind::Box
        } else if self.is_record() {
            Kind::Record
        } else if self.is_void() {
            Kind::Void
        } else if self.is_eof() {
            Kind::Eof
        } else {
            Kind::Other
        }
    }

    /// An exact integer that fits in an `i64`.
    pub fn as_i64(self) -> Option<i64> {
        if self.is_fixnum() {
            return Some(unsafe { sys::chez_fixnum_value(self.raw) } as i64);
        }
        let mut out = 0i64;
        let ok = unsafe { sys::Stry_integer64_value(self.raw, &mut out, std::ptr::null_mut()) };
        (ok != 0).then_some(out)
    }

    /// An exact non-negative integer that fits in a `u64`.
    pub fn as_u64(self) -> Option<u64> {
        let mut out = 0u64;
        let ok = unsafe { sys::Stry_unsigned64_value(self.raw, &mut out, std::ptr::null_mut()) };
        (ok != 0).then_some(out)
    }

    /// A real number: a flonum, or an exact integer.
    pub fn as_f64(self) -> Option<f64> {
        if self.is_flonum() {
            Some(unsafe { sys::chez_flonum_value(self.raw) })
        } else {
            self.as_i64().map(|n| n as f64)
        }
    }

    /// #t or #f, and nothing else.
    pub fn as_bool(self) -> Option<bool> {
        self.is_boolean().then(|| self.is_true())
    }

    pub fn as_char(self) -> Option<char> {
        if self.is_char() {
            char::from_u32(unsafe { sys::chez_char_value(self.raw) })
        } else {
            None
        }
    }

    pub fn car(self) -> Option<Value<'s>> {
        self.is_pair().then(|| Value {
            raw: unsafe { sys::chez_car(self.raw) },
            _scope: PhantomData,
        })
    }

    pub fn cdr(self) -> Option<Value<'s>> {
        self.is_pair().then(|| Value {
            raw: unsafe { sys::chez_cdr(self.raw) },
            _scope: PhantomData,
        })
    }

    /// The elements of a proper list, or None.
    pub fn list(self) -> Option<Vec<Value<'s>>> {
        let mut out = Vec::new();
        let mut v = self;
        loop {
            if v.is_null() {
                return Some(out);
            }
            out.push(v.car()?);
            v = v.cdr()?;
        }
    }

    pub fn vector(self) -> Option<Vec<Value<'s>>> {
        self.is_vector().then(|| {
            let n = unsafe { sys::chez_vector_length(self.raw) };
            (0..n)
                .map(|i| Value {
                    raw: unsafe { sys::chez_vector_ref(self.raw, i) },
                    _scope: PhantomData,
                })
                .collect()
        })
    }

    /// A bytevector's bytes, borrowed for the scope: Chez Scheme does not
    /// move objects while Rust holds the scope shared.
    pub fn bytes(self) -> Option<&'s [u8]> {
        self.is_bytevector().then(|| unsafe {
            let n = sys::chez_bytevector_length(self.raw) as usize;
            if n == 0 {
                &[][..]
            } else {
                std::slice::from_raw_parts(sys::chez_bytevector_data(self.raw), n)
            }
        })
    }

    /// A string's characters, as UTF-8.
    pub fn string(self) -> Option<String> {
        self.is_string().then(|| {
            let n = unsafe { sys::chez_string_length(self.raw) } as usize;
            let mut chars = vec![0u32; n];
            // SAFETY: a string of `n` characters, and room for them.
            unsafe { sys::chez_string_chars(self.raw, chars.as_mut_ptr()) };
            chars
                .into_iter()
                .map(|c| char::from_u32(c).unwrap_or('\u{fffd}'))
                .collect()
        })
    }

    /// A symbol's name.
    pub fn symbol_name(self) -> Option<String> {
        if !self.is_symbol() {
            return None;
        }
        let s = unsafe { sys::Ssymbol_to_string(self.raw) };
        Value::<'s> {
            raw: s,
            _scope: PhantomData,
        }
        .string()
    }

    /// `eq?`
    pub fn eq(self, other: Value<'_>) -> bool {
        self.raw == other.raw
    }
}

impl fmt::Debug for Value<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind() {
            Kind::Fixnum | Kind::Bignum => write!(
                f,
                "{}",
                self.as_i64().map_or("<bignum>".into(), |n| n.to_string())
            ),
            Kind::Flonum => write!(f, "{}", self.as_f64().unwrap_or(f64::NAN)),
            Kind::Boolean => f.write_str(if self.is_true() { "#t" } else { "#f" }),
            Kind::String => write!(f, "{:?}", self.string().unwrap_or_default()),
            Kind::Symbol => f.write_str(&self.symbol_name().unwrap_or_default()),
            Kind::Char => write!(f, "#\\{}", self.as_char().unwrap_or('?')),
            Kind::Null => f.write_str("()"),
            k => write!(f, "#<{k}>"),
        }
    }
}

/// Making values.
impl Scope {
    fn wrap(&self, raw: Ptr) -> Value<'_> {
        Value {
            raw,
            _scope: PhantomData,
        }
    }

    pub fn integer(&self, n: i64) -> Value<'_> {
        self.wrap(unsafe { sys::Sinteger64(n) })
    }
    pub fn unsigned(&self, n: u64) -> Value<'_> {
        self.wrap(unsafe { sys::Sunsigned64(n) })
    }
    pub fn flonum(&self, x: f64) -> Value<'_> {
        self.wrap(unsafe { sys::Sflonum(x) })
    }
    pub fn boolean(&self, b: bool) -> Value<'_> {
        self.wrap(unsafe {
            if b {
                sys::chez_true()
            } else {
                sys::chez_false()
            }
        })
    }
    pub fn char(&self, c: char) -> Value<'_> {
        self.wrap(unsafe { sys::chez_char(c as u32) })
    }
    pub fn nil(&self) -> Value<'_> {
        self.wrap(unsafe { sys::chez_nil() })
    }
    pub fn void(&self) -> Value<'_> {
        self.wrap(unsafe { sys::chez_void() })
    }
    pub fn eof(&self) -> Value<'_> {
        self.wrap(unsafe { sys::chez_eof() })
    }
    pub fn string(&self, s: &str) -> Value<'_> {
        self.wrap(unsafe { sys::Sstring_utf8(s.as_ptr().cast(), s.len() as isize) })
    }
    /// A symbol; None if the name holds a NUL.
    pub fn symbol(&self, name: &str) -> Option<Value<'_>> {
        let c = std::ffi::CString::new(name).ok()?;
        Some(self.wrap(unsafe { sys::Sstring_to_symbol(c.as_ptr()) }))
    }
    pub fn cons<'a>(&'a self, car: Value<'a>, cdr: Value<'a>) -> Value<'a> {
        self.wrap(unsafe { sys::Scons(car.raw, cdr.raw) })
    }
    pub fn list<'a, I>(&'a self, items: I) -> Value<'a>
    where
        I: IntoIterator<Item = Value<'a>>,
        I::IntoIter: DoubleEndedIterator,
    {
        items
            .into_iter()
            .rev()
            .fold(self.nil(), |tail, x| self.cons(x, tail))
    }
    pub fn vector<'a>(&'a self, items: impl IntoIterator<Item = Value<'a>>) -> Value<'a> {
        let items: Vec<_> = items.into_iter().collect();
        let v = unsafe { sys::Smake_vector(items.len() as isize, sys::chez_false()) };
        for (i, x) in items.iter().enumerate() {
            unsafe { sys::Svector_set(v, i as isize, x.raw) };
        }
        self.wrap(v)
    }
    pub fn bytevector(&self, bytes: &[u8]) -> Value<'_> {
        unsafe {
            let v = sys::Smake_bytevector(bytes.len() as isize, 0);
            if !bytes.is_empty() {
                std::ptr::copy_nonoverlapping(
                    bytes.as_ptr(),
                    sys::chez_bytevector_data(v),
                    bytes.len(),
                );
            }
            self.wrap(v)
        }
    }

    /// The value of a top-level variable (in the interaction environment).
    pub fn top_level(&self, name: &str) -> Option<Value<'_>> {
        let sym = self.symbol(name)?;
        Some(self.wrap(unsafe { sys::Stop_level_value(sym.raw) }))
    }

    /// Call a Scheme procedure. Scheme code runs, and may collect garbage
    /// and move objects, so the scope is taken exclusively: arguments and
    /// result are [`Root`]s, which stay valid across it.
    pub fn call(&mut self, procedure: &Root, args: &[&Root]) -> Root {
        unsafe {
            sys::Sinitframe(args.len() as isize);
            for (i, a) in args.iter().enumerate() {
                sys::Sput_arg(i as isize + 1, a.raw);
            }
            Root::new_raw(sys::Scall(procedure.raw, args.len() as isize))
        }
    }
}

/// A Scheme object kept alive, and in place, until dropped: for holding
/// values across calls, or across Scheme code running. Not `Send`.
pub struct Root {
    raw: Ptr,
    _not_send: PhantomData<*mut ()>,
}

impl Root {
    pub fn new(v: Value<'_>) -> Root {
        unsafe { Root::new_raw(v.raw) }
    }

    unsafe fn new_raw(raw: Ptr) -> Root {
        unsafe { sys::Slock_object(raw) };
        Root {
            raw,
            _not_send: PhantomData,
        }
    }

    pub fn get<'s>(&self, scope: &'s Scope) -> Value<'s> {
        scope.wrap(self.raw)
    }
}

impl Clone for Root {
    fn clone(&self) -> Root {
        unsafe { Root::new_raw(self.raw) }
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        unsafe { sys::Sunlock_object(self.raw) }
    }
}
