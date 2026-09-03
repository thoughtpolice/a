// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Allocation support for generated Rust bindings. These raw allocations
//! share Rust's allocator so the bindings can take ownership as Vec/String.

use std::alloc::{Layout, alloc, dealloc, handle_alloc_error, realloc};
use std::ptr::NonNull;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn cabi_realloc(
    old: *mut u8,
    old_size: usize,
    align: usize,
    new_size: usize,
) -> *mut u8 {
    if new_size == 0 {
        if !old.is_null() && old_size != 0 {
            let layout = Layout::from_size_align(old_size, align).unwrap();
            unsafe { dealloc(old, layout) };
        }
        // Generated bindings construct empty Vec/String values from these
        // pointers, so canonical zero-length allocations must be non-null.
        return align as *mut u8;
    }
    let layout = Layout::from_size_align(new_size, align).unwrap();
    let result = if old.is_null() || old_size == 0 {
        unsafe { alloc(layout) }
    } else {
        let old_layout = Layout::from_size_align(old_size, align).unwrap();
        unsafe { realloc(old, old_layout, new_size) }
    };
    if result.is_null() {
        handle_alloc_error(layout);
    }
    result
}

// Generated list lowering transfers ownership only after every element has
// been lowered. Until then this guard releases the allocation on unwinding.
#[allow(dead_code)]
pub struct Cleanup {
    ptr: NonNull<u8>,
    layout: Layout,
}

#[allow(dead_code)]
impl Cleanup {
    pub fn new(layout: Layout) -> (*mut u8, Option<Self>) {
        if layout.size() == 0 {
            return (std::ptr::null_mut(), None);
        }
        let ptr =
            NonNull::new(unsafe { alloc(layout) }).unwrap_or_else(|| handle_alloc_error(layout));
        (ptr.as_ptr(), Some(Self { ptr, layout }))
    }

    pub fn forget(self) {
        std::mem::forget(self);
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        unsafe { dealloc(self.ptr.as_ptr(), self.layout) };
    }
}

/// An exported resource, as the generated bindings ask of their runtime: its
/// value lives in memory as `Rep`, which here is always `Option<Self>`, so an
/// implementation of a resource's trait needs nothing more than the type.
#[allow(dead_code)]
pub trait Resource: Sized + 'static {
    type Rep: ResourceRep<Self>;
}

impl<T: 'static> Resource for T {
    type Rep = Option<T>;
}

/// Access to a resource's value through its representation.
///
/// # Safety
///
/// The pointers passed are ones the bindings got from placing a value
/// `rep_new` made, and `rep_take` is called at most once for each.
#[allow(dead_code)]
pub unsafe trait ResourceRep<T> {
    fn rep_new(val: T) -> Self;

    /// # Safety
    ///
    /// `ptr` points to a live representation.
    unsafe fn rep_as_ref<'a>(ptr: *const Self) -> &'a T;

    /// # Safety
    ///
    /// `ptr` points to a live representation nothing else borrows.
    unsafe fn rep_as_mut<'a>(ptr: *mut Self) -> &'a mut T;

    /// # Safety
    ///
    /// `ptr` points to a live representation, whose value moves out; its
    /// destructor will not run it again.
    unsafe fn rep_take(ptr: *mut Self) -> T;
}

unsafe impl<T> ResourceRep<T> for Option<T> {
    fn rep_new(val: T) -> Self {
        Some(val)
    }

    unsafe fn rep_as_ref<'a>(ptr: *const Self) -> &'a T {
        unsafe { (*ptr).as_ref().unwrap() }
    }

    unsafe fn rep_as_mut<'a>(ptr: *mut Self) -> &'a mut T {
        unsafe { (*ptr).as_mut().unwrap() }
    }

    unsafe fn rep_take(ptr: *mut Self) -> T {
        unsafe { (*ptr).take().unwrap() }
    }
}
