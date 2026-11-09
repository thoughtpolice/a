// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Converting between Scheme values and Rust types.
//!
//! A procedure's arguments are [`FromScheme`] and its result [`IntoScheme`]:
//!
//! | Rust | Scheme |
//! | --- | --- |
//! | `i64`, `i32`, `u64`, `u32`, `usize`, `u8` | exact integers |
//! | `f64` | real numbers (flonums, or integers as arguments) |
//! | `bool` | `#t`, `#f` |
//! | `char` | chars |
//! | `String`, `&str` (results) | strings |
//! | [`Symbol`] | symbols |
//! | [`Bytes`] (arguments, borrowed), [`ByteVec`] | bytevectors |
//! | `Vec<T>` | proper lists |
//! | `Option<T>` | `T`, or `#f` for `None` |
//! | `()` | the void object (results) |
//! | `Result<T, E: Display>` (results) | `T`, or an error raised in Scheme |
//! | [`Value`], [`Root`] | anything |
//! | [`crate::Object`], [`crate::Ref`], [`crate::RefMut`] | Rust objects, as handles |

use std::fmt;
use std::ops::Deref;

use crate::value::{Root, Scope, Value};

/// An error, raised in Scheme as an `error` condition with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(msg: impl Into<String>) -> Error {
        Error(msg.into())
    }

    pub(crate) fn expected(what: &str, got: Value<'_>) -> Error {
        Error(format!("expected {what}, got {:?}", got))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(s: String) -> Error {
        Error(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Error {
        Error(s.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error(e.to_string())
    }
}

/// A Rust value from a Scheme one.
pub trait FromScheme<'s>: Sized {
    /// What the Scheme value must be, for error messages ("bytevector").
    const EXPECTS: &'static str;
    fn from_scheme(v: Value<'s>) -> Result<Self>;
}

/// A Scheme value from a Rust one.
pub trait IntoScheme {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>>;
}

// MARK: Numbers

macro_rules! integers {
    ($($t:ty),*) => {$(
        impl<'s> FromScheme<'s> for $t {
            const EXPECTS: &'static str = concat!("an exact integer (", stringify!($t), ")");
            fn from_scheme(v: Value<'s>) -> Result<$t> {
                v.as_i64()
                    .and_then(|n| <$t>::try_from(n).ok())
                    .or_else(|| v.as_u64().and_then(|n| <$t>::try_from(n).ok()))
                    .ok_or_else(|| Error::expected(Self::EXPECTS, v))
            }
        }
        impl IntoScheme for $t {
            fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
                Ok(match i64::try_from(self) {
                    Ok(n) => s.integer(n),
                    Err(_) => s.unsigned(self as u64),
                })
            }
        }
    )*};
}

integers!(i64, i32, i16, i8, u64, u32, u16, u8, usize, isize);

impl<'s> FromScheme<'s> for f64 {
    const EXPECTS: &'static str = "a real number";
    fn from_scheme(v: Value<'s>) -> Result<f64> {
        v.as_f64().ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for f64 {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.flonum(self))
    }
}

// MARK: Booleans, characters, strings, symbols

impl<'s> FromScheme<'s> for bool {
    const EXPECTS: &'static str = "a boolean";
    fn from_scheme(v: Value<'s>) -> Result<bool> {
        v.as_bool().ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for bool {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.boolean(self))
    }
}

impl<'s> FromScheme<'s> for char {
    const EXPECTS: &'static str = "a char";
    fn from_scheme(v: Value<'s>) -> Result<char> {
        v.as_char().ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for char {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.char(self))
    }
}

impl<'s> FromScheme<'s> for String {
    const EXPECTS: &'static str = "a string";
    fn from_scheme(v: Value<'s>) -> Result<String> {
        v.string().ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for String {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.string(&self))
    }
}

impl IntoScheme for &str {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.string(self))
    }
}

/// A symbol, by name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Symbol(pub String);

impl<'s> FromScheme<'s> for Symbol {
    const EXPECTS: &'static str = "a symbol";
    fn from_scheme(v: Value<'s>) -> Result<Symbol> {
        v.symbol_name()
            .map(Symbol)
            .ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for Symbol {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        s.symbol(&self.0)
            .ok_or_else(|| Error::new("a symbol name cannot hold NUL"))
    }
}

// MARK: Bytevectors

/// A bytevector's bytes, borrowed for the call: no copy.
#[derive(Debug, Clone, Copy)]
pub struct Bytes<'s>(pub &'s [u8]);

impl Deref for Bytes<'_> {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.0
    }
}

impl<'s> FromScheme<'s> for Bytes<'s> {
    const EXPECTS: &'static str = "a bytevector";
    fn from_scheme(v: Value<'s>) -> Result<Bytes<'s>> {
        v.bytes()
            .map(Bytes)
            .ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

/// An owned bytevector.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ByteVec(pub Vec<u8>);

impl Deref for ByteVec {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for ByteVec {
    fn from(v: Vec<u8>) -> ByteVec {
        ByteVec(v)
    }
}

impl<'s> FromScheme<'s> for ByteVec {
    const EXPECTS: &'static str = "a bytevector";
    fn from_scheme(v: Value<'s>) -> Result<ByteVec> {
        v.bytes()
            .map(|b| ByteVec(b.to_vec()))
            .ok_or_else(|| Error::expected(Self::EXPECTS, v))
    }
}

impl IntoScheme for ByteVec {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.bytevector(&self.0))
    }
}

impl IntoScheme for &[u8] {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.bytevector(self))
    }
}

// MARK: Containers

impl<'s, T: FromScheme<'s>> FromScheme<'s> for Vec<T> {
    const EXPECTS: &'static str = "a list";
    fn from_scheme(v: Value<'s>) -> Result<Vec<T>> {
        let items = v.list().ok_or_else(|| Error::expected(Self::EXPECTS, v))?;
        items
            .into_iter()
            .enumerate()
            .map(|(i, x)| T::from_scheme(x).map_err(|e| Error(format!("element {i}: {e}"))))
            .collect()
    }
}

impl<T: IntoScheme> IntoScheme for Vec<T> {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        let items = self
            .into_iter()
            .map(|x| x.into_scheme(s))
            .collect::<Result<Vec<_>>>()?;
        Ok(s.list(items))
    }
}

impl<'s, T: FromScheme<'s>> FromScheme<'s> for Option<T> {
    const EXPECTS: &'static str = T::EXPECTS;
    fn from_scheme(v: Value<'s>) -> Result<Option<T>> {
        if v.is_false() {
            Ok(None)
        } else {
            T::from_scheme(v).map(Some)
        }
    }
}

impl<T: IntoScheme> IntoScheme for Option<T> {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        match self {
            Some(x) => x.into_scheme(s),
            None => Ok(s.boolean(false)),
        }
    }
}

impl IntoScheme for () {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(s.void())
    }
}

impl<T: IntoScheme, E: fmt::Display> IntoScheme for std::result::Result<T, E> {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        match self {
            Ok(x) => x.into_scheme(s),
            Err(e) => Err(Error(e.to_string())),
        }
    }
}

// MARK: Values

impl<'s> FromScheme<'s> for Value<'s> {
    const EXPECTS: &'static str = "any value";
    fn from_scheme(v: Value<'s>) -> Result<Value<'s>> {
        Ok(v)
    }
}

impl IntoScheme for Value<'_> {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        // There is one scope per call: a value made in it is valid for all
        // of it, whichever borrow of the scope made it.
        Ok(unsafe { Value::from_raw(s, self.raw()) })
    }
}

impl<'s> FromScheme<'s> for Root {
    const EXPECTS: &'static str = "any value";
    fn from_scheme(v: Value<'s>) -> Result<Root> {
        Ok(Root::new(v))
    }
}

impl IntoScheme for Root {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(self.get(s))
    }
}

impl IntoScheme for &Root {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        Ok(self.get(s))
    }
}
