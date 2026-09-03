// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared allocator and component reactor for C applications using the SDK.

#![no_main]

use std::alloc::{Layout, alloc, dealloc};

unsafe extern "C" {
    fn console_guest_init();
    fn console_guest_frame(dt_ms: u32) -> i32;
}

// The generated C bindings own the canonical init/frame exports.
#[unsafe(no_mangle)]
pub extern "C" fn exports_game_init() {
    unsafe { console_guest_init() }
}

#[unsafe(no_mangle)]
pub extern "C" fn exports_game_frame(dt_ms: u32) -> bool {
    unsafe { console_guest_frame(dt_ms) != 0 }
}

// Every C allocation, including canonical ABI buffers, has the same header.
// That lets generated free() helpers and size-less application frees share it.
const HEADER_SIZE: usize = 16;

#[repr(C)]
#[derive(Clone, Copy)]
struct Allocation {
    size: usize,
    align: usize,
}

unsafe fn allocate(size: usize, align: usize) -> *mut u8 {
    assert!(align.is_power_of_two());
    let align = align.max(HEADER_SIZE);
    let total = size.max(1).checked_add(align).unwrap();
    let layout = Layout::from_size_align(total, align).unwrap();
    let base = unsafe { alloc(layout) };
    if base.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    let result = unsafe { base.add(align) };
    unsafe {
        result
            .sub(HEADER_SIZE)
            .cast::<Allocation>()
            .write(Allocation { size, align });
    }
    result
}

unsafe fn allocation(ptr: *mut u8) -> Allocation {
    unsafe { ptr.sub(HEADER_SIZE).cast::<Allocation>().read() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn console_malloc(size: usize) -> *mut u8 {
    unsafe { allocate(size, HEADER_SIZE) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn console_free(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let Allocation { size, align } = unsafe { allocation(ptr) };
    let total = size.max(1).checked_add(align).unwrap();
    let layout = Layout::from_size_align(total, align).unwrap();
    unsafe { dealloc(ptr.sub(align), layout) };
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn console_realloc(ptr: *mut u8, new_size: usize) -> *mut u8 {
    if ptr.is_null() {
        return unsafe { console_malloc(new_size) };
    }
    let old = unsafe { allocation(ptr) };
    if new_size == 0 {
        unsafe { console_free(ptr) };
        return std::ptr::null_mut();
    }
    let result = unsafe { allocate(new_size, old.align) };
    unsafe {
        std::ptr::copy_nonoverlapping(ptr, result, old.size.min(new_size));
        console_free(ptr);
    }
    result
}

/// The C bindings' canonical allocator and libc helpers use identical storage.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cabi_realloc(
    old: *mut u8,
    old_size: usize,
    align: usize,
    new_size: usize,
) -> *mut u8 {
    if new_size == 0 {
        if old_size != 0 {
            unsafe { console_free(old) };
        }
        return std::ptr::null_mut();
    }
    let result = unsafe { allocate(new_size, align) };
    if !old.is_null() && old_size != 0 {
        let old_allocation = unsafe { allocation(old) };
        assert!(old_size <= old_allocation.size);
        unsafe {
            std::ptr::copy_nonoverlapping(old, result, old_size.min(new_size));
            console_free(old);
        }
    }
    result
}
