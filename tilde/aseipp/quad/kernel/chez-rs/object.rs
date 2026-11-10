// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Rust objects in Scheme.
//!
//! A procedure returning [`Object<T>`] hands Scheme a handle to a boxed `T`:
//! the pair `(type-name . address)`. Procedures taking [`Ref<T>`] or
//! [`RefMut<T>`] check the handle is a `T` that is still alive, and borrow
//! it as a `RefCell` would, so a `RefMut` and another borrow of the same
//! object in one call is an error, not undefined behavior.
//!
//! The Scheme side, (chez rust), registers each new handle with a guardian,
//! so the `T` is dropped once Scheme no longer references it, or at once
//! with `(native-drop! handle)`. A dropped handle's address is 0.

use std::any::type_name;
use std::cell::{self, RefCell};
use std::collections::HashSet;
use std::ops::{Deref, DerefMut};
use std::sync::{LazyLock, Mutex};

use crate::convert::{Error, FromScheme, IntoScheme, Result};
use crate::sys::{self, Ptr};
use crate::value::{Root, Scope, Value};

const MAGIC: u64 = 0x6368_657a_6f62_6a31; // "chezobj1"

#[repr(C)]
struct Header {
    magic: u64,
    type_name: &'static str,
    drop: unsafe fn(*mut Header),
}

#[repr(C)]
struct Boxed<T> {
    header: Header,
    value: RefCell<T>,
}

unsafe fn drop_boxed<T>(p: *mut Header) {
    drop(unsafe { Box::from_raw(p.cast::<Boxed<T>>()) });
}

// The addresses of the objects alive: a handle's address is only followed
// once it is found here, so a pair made to look like a handle is harmless.
static LIVE: LazyLock<Mutex<HashSet<usize>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn is_live(addr: usize) -> bool {
    LIVE.lock().unwrap().contains(&addr)
}

/// A Rust value to hand to Scheme as an object.
pub struct Object<T: 'static>(pub T);

thread_local! {
    // Handles made since Scheme last took them, for its guardian.
    static NEW: RefCell<Vec<Root>> = const { RefCell::new(Vec::new()) };
}

impl<T: 'static> IntoScheme for Object<T> {
    fn into_scheme(self, s: &Scope) -> Result<Value<'_>> {
        let boxed = Box::new(Boxed {
            header: Header {
                magic: MAGIC,
                type_name: type_name::<T>(),
                drop: drop_boxed::<T>,
            },
            value: RefCell::new(self.0),
        });
        let addr = Box::into_raw(boxed) as usize;
        LIVE.lock().unwrap().insert(addr);
        let addr = addr as u64;
        let tag = s
            .symbol(type_name::<T>())
            .ok_or_else(|| Error::new("bad type name"))?;
        let handle = s.cons(tag, s.unsigned(addr));
        NEW.with(|n| n.borrow_mut().push(Root::new(handle)));
        Ok(handle)
    }
}

/// The boxed `T` behind a handle, checking it is one.
fn boxed<'s, T: 'static>(v: Value<'s>) -> Result<&'s Boxed<T>> {
    let expected = || Error::expected(&format!("a {} object", type_name::<T>()), v);
    // The tag (the type's name, as a symbol) is for people reading the
    // handle; the box's own header, checked below, says what it is.
    let addr = v.cdr().and_then(|a| a.as_u64()).ok_or_else(expected)?;
    if addr == 0 {
        return Err(Error::new(format!(
            "this {} has been dropped",
            type_name::<T>()
        )));
    }
    if !is_live(addr as usize) {
        return Err(expected());
    }
    let header = addr as usize as *const Header;
    // SAFETY: the address is a live box's, which Object::into_scheme made,
    // and which only drop_handle frees; its type is checked before use.
    unsafe {
        if (*header).magic != MAGIC || (*header).type_name != type_name::<T>() {
            return Err(expected());
        }
        Ok(&*(header as *const Boxed<T>))
    }
}

/// A shared borrow of a Rust object, for the call.
pub struct Ref<'s, T: 'static>(cell::Ref<'s, T>);

impl<T> Deref for Ref<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<'s, T: 'static> FromScheme<'s> for Ref<'s, T> {
    const EXPECTS: &'static str = "a Rust object";
    fn from_scheme(v: Value<'s>) -> Result<Ref<'s, T>> {
        let b = boxed::<T>(v)?;
        b.value
            .try_borrow()
            .map(Ref)
            .map_err(|_| Error::new(format!("this {} is borrowed mutably", type_name::<T>())))
    }
}

/// An exclusive borrow of a Rust object, for the call.
pub struct RefMut<'s, T: 'static>(cell::RefMut<'s, T>);

impl<T> Deref for RefMut<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> DerefMut for RefMut<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

impl<'s, T: 'static> FromScheme<'s> for RefMut<'s, T> {
    const EXPECTS: &'static str = "a Rust object";
    fn from_scheme(v: Value<'s>) -> Result<RefMut<'s, T>> {
        let b = boxed::<T>(v)?;
        b.value
            .try_borrow_mut()
            .map(RefMut)
            .map_err(|_| Error::new(format!("this {} is already borrowed", type_name::<T>())))
    }
}

// MARK: The runtime's side: (chez rust) calls these

/// Drop the object behind a handle now, zeroing its address. Dropping one
/// already dropped does nothing.
pub(crate) unsafe extern "C" fn drop_handle(handle: Ptr) -> Ptr {
    unsafe {
        if sys::chez_pairp(handle) != 0 {
            let s = Scope::new();
            let v = Value::from_raw(&s, handle);
            if let Some(addr) = v.cdr().and_then(|a| a.as_u64()).filter(|a| *a != 0) {
                let header = addr as usize as *mut Header;
                if LIVE.lock().unwrap().remove(&(addr as usize)) && (*header).magic == MAGIC {
                    sys::Sset_cdr(handle, sys::chez_fixnum(0));
                    (*header).magic = 0;
                    ((*header).drop)(header);
                }
            }
        }
        sys::chez_void()
    }
}

/// The handles made since the last call, as a list, for the guardian.
pub(crate) unsafe extern "C" fn take_new_handles() -> Ptr {
    let roots = NEW.with(|n| std::mem::take(&mut *n.borrow_mut()));
    let s = unsafe { Scope::new() };
    s.list(roots.iter().map(|r| r.get(&s))).raw()
}
