// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The mutable state of an instance.

use crate::ir::{AddressType, TagId, TypeId};

use super::{Ref, Value};

pub const PAGE_SIZE: u64 = 65536;

/// A linear memory.
#[derive(Clone, Debug)]
pub struct Memory {
    pub bytes: Vec<u8>,
    /// The declared maximum in pages.
    pub max_pages: Option<u64>,
    pub address_type: AddressType,
}

impl Memory {
    pub fn pages(&self) -> u64 {
        self.bytes.len() as u64 / PAGE_SIZE
    }

    /// The bytes at `address`, or `None` past the end.
    pub fn slice(&self, address: u64, len: usize) -> Option<&[u8]> {
        let end = address.checked_add(len as u64)?;
        if end > self.bytes.len() as u64 {
            return None;
        }
        Some(&self.bytes[address as usize..end as usize])
    }

    pub fn slice_mut(&mut self, address: u64, len: usize) -> Option<&mut [u8]> {
        let end = address.checked_add(len as u64)?;
        if end > self.bytes.len() as u64 {
            return None;
        }
        Some(&mut self.bytes[address as usize..end as usize])
    }

    /// Grows by `delta` pages within the declared maximum and `limit_bytes`,
    /// returning the old size in pages, or `None` when it cannot.
    pub fn grow(&mut self, delta: u64, limit_bytes: u64) -> Option<u64> {
        let old = self.pages();
        let new = old.checked_add(delta)?;
        let hard_limit = match self.address_type {
            AddressType::I32 => 1 << 16,
            AddressType::I64 => 1 << 48,
        };
        if new > self.max_pages.unwrap_or(hard_limit).min(hard_limit) {
            return None;
        }
        let new_bytes = new.checked_mul(PAGE_SIZE)?;
        if new_bytes > limit_bytes {
            return None;
        }
        self.bytes.resize(new_bytes as usize, 0);
        Some(old)
    }
}

/// A table of references.
#[derive(Clone, Debug)]
pub struct Table {
    pub elements: Vec<Ref>,
    pub max: Option<u64>,
    pub address_type: AddressType,
}

impl Table {
    /// Grows by `delta` elements filled with `init`, returning the old size,
    /// or `None` when the declared maximum or `limit` forbids it.
    pub fn grow(&mut self, delta: u64, init: Ref, limit: u64) -> Option<u64> {
        let old = self.elements.len() as u64;
        let new = old.checked_add(delta)?;
        let hard_limit = match self.address_type {
            AddressType::I32 => u64::from(u32::MAX),
            AddressType::I64 => u64::MAX,
        };
        if new > self.max.unwrap_or(hard_limit).min(hard_limit) || new > limit {
            return None;
        }
        self.elements.resize(new as usize, init);
        Some(old)
    }
}

/// The identity of a managed struct or array.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ObjectId(pub u32);

/// A managed struct or array: its concrete type and its fields or elements.
/// Packed fields hold their value zero-extended in an `i32`.
#[derive(Clone, Debug)]
pub struct Object {
    pub ty: TypeId,
    pub fields: Vec<Value>,
}

/// The identity of an internal reference converted to an external one.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ExternalizedId(pub u32);

/// The identity of a thrown exception.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ExceptionId(pub u32);

/// A thrown exception: its tag and payload.
#[derive(Clone, Debug)]
pub struct Exception {
    pub tag: TagId,
    pub payload: Vec<Value>,
}

/// Everything a program can read or write: memories, tables, globals, the
/// live state of its segments, its managed objects, the references it has
/// externalized, and its exceptions. None of the last three are ever
/// collected; the interpreter is not meant to run long enough for that to
/// matter.
#[derive(Clone, Debug, Default)]
pub struct Store {
    pub memories: Vec<Memory>,
    pub tables: Vec<Table>,
    pub globals: Vec<Value>,
    pub dropped_data: Vec<bool>,
    pub dropped_elements: Vec<bool>,
    pub objects: Vec<Object>,
    pub externalized: Vec<Ref>,
    pub exceptions: Vec<Exception>,
}

impl Store {
    pub fn object(&self, id: ObjectId) -> Option<&Object> {
        self.objects.get(id.0 as usize)
    }

    pub fn object_mut(&mut self, id: ObjectId) -> Option<&mut Object> {
        self.objects.get_mut(id.0 as usize)
    }

    pub fn allocate_object(&mut self, ty: TypeId, fields: Vec<Value>) -> ObjectId {
        let id = ObjectId(self.objects.len() as u32);
        self.objects.push(Object { ty, fields });
        id
    }

    /// The reference behind an externalized one.
    pub fn externalized(&self, id: ExternalizedId) -> Option<Ref> {
        self.externalized.get(id.0 as usize).copied()
    }

    pub fn externalize(&mut self, inner: Ref) -> ExternalizedId {
        let id = ExternalizedId(self.externalized.len() as u32);
        self.externalized.push(inner);
        id
    }

    pub fn exception(&self, id: ExceptionId) -> Option<&Exception> {
        self.exceptions.get(id.0 as usize)
    }

    pub fn allocate_exception(&mut self, tag: TagId, payload: Vec<Value>) -> ExceptionId {
        let id = ExceptionId(self.exceptions.len() as u32);
        self.exceptions.push(Exception { tag, payload });
        id
    }
}
