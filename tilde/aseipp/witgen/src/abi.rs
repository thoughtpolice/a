// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The canonical ABI's layout of WIT values in linear memory on wasm32, from
//! wit-parser's `SizeAlign`, and the join of flat types a variant's payloads
//! share. Every backend that copies values through memory lays them out with
//! these.

use wit_parser::abi::WasmType;
use wit_parser::{ElementInfo, Int, Resolve, SizeAlign, Type, TypeDefKind};

/// The canonical ABI's join of two flat types (wit-parser's `join`).
pub fn join(a: WasmType, b: WasmType) -> WasmType {
    use WasmType::*;
    match (a, b) {
        (I32, I32)
        | (I64, I64)
        | (F32, F32)
        | (F64, F64)
        | (Pointer, Pointer)
        | (PointerOrI64, PointerOrI64)
        | (Length, Length) => a,
        (I32, F32) | (F32, I32) => I32,
        (Length, I32 | F32) | (I32 | F32, Length) => Length,
        (Length, I64 | F64) | (I64 | F64, Length) => I64,
        (Pointer, I32 | F32 | Length) | (I32 | F32 | Length, Pointer) => Pointer,
        (Pointer, I64 | F64) | (I64 | F64, Pointer) => PointerOrI64,
        (PointerOrI64, _) | (_, PointerOrI64) => PointerOrI64,
        (_, I64 | F64) | (I64 | F64, _) => I64,
    }
}

/// A flat type as a core wasm value type: wit-parser's pointers and lengths
/// are `i32` on wasm32, and a joined pointer-or-`i64` is an `i64`.
pub fn core(ty: WasmType) -> WasmType {
    match ty {
        WasmType::Pointer | WasmType::Length => WasmType::I32,
        WasmType::PointerOrI64 => WasmType::I64,
        other => other,
    }
}

/// Sizes, alignments and offsets of a resolve's types on wasm32.
pub struct Sizes<'a> {
    pub resolve: &'a Resolve,
    sizes: SizeAlign,
}

impl<'a> Sizes<'a> {
    pub fn new(resolve: &'a Resolve) -> Self {
        let mut sizes = SizeAlign::default();
        sizes.fill(resolve).expect("the world's types have sizes");
        Sizes { resolve, sizes }
    }

    /// wit-parser's layout itself, for what lays values out through it.
    pub fn size_align(&self) -> &SizeAlign {
        &self.sizes
    }

    pub fn size(&self, ty: &Type) -> usize {
        self.sizes.size(ty).size_wasm32()
    }

    pub fn align(&self, ty: &Type) -> usize {
        self.sizes.align(ty).align_wasm32()
    }

    /// The WIT types of a record's fields or a tuple's items, and of an
    /// option's payload or a list's element.
    pub fn parts(&self, ty: &Type) -> Vec<Type> {
        let Type::Id(id) = ty else {
            return Vec::new();
        };
        match &self.resolve.types[*id].kind {
            TypeDefKind::Type(inner) => self.parts(inner),
            TypeDefKind::Record(record) => record.fields.iter().map(|field| field.ty).collect(),
            TypeDefKind::Tuple(tuple) => tuple.types.clone(),
            TypeDefKind::Option(payload) | TypeDefKind::List(payload) => vec![*payload],
            _ => Vec::new(),
        }
    }

    /// The payload types of a variant's or result's cases.
    pub fn case_types(&self, ty: &Type) -> Vec<Option<Type>> {
        let Type::Id(id) = ty else {
            return Vec::new();
        };
        match &self.resolve.types[*id].kind {
            TypeDefKind::Type(inner) => self.case_types(inner),
            TypeDefKind::Variant(variant) => variant.cases.iter().map(|case| case.ty).collect(),
            TypeDefKind::Result(result) => vec![result.ok, result.err],
            _ => Vec::new(),
        }
    }

    /// Where the payload of a variant whose discriminant takes `size` bytes
    /// starts.
    pub fn variant_payload_offset(&self, cases: &[Option<Type>], size: usize) -> usize {
        let tag = match size {
            1 => Int::U8,
            2 => Int::U16,
            _ => Int::U32,
        };
        self.sizes
            .payload_offset(tag, cases.iter().map(Option::as_ref))
            .size_wasm32()
    }

    /// The size and alignment of a record or tuple of `types`.
    pub fn record<'t>(&self, types: impl Iterator<Item = &'t Type>) -> ElementInfo {
        self.sizes.record(types)
    }

    /// The offsets of the fields of a record or tuple of `types`.
    pub fn offsets(&self, types: &[Type]) -> Vec<usize> {
        self.sizes
            .field_offsets(types.iter())
            .into_iter()
            .map(|(offset, _)| offset.size_wasm32())
            .collect()
    }

    /// Where an option's payload starts.
    pub fn payload_offset(&self, payload: &Type) -> usize {
        self.sizes
            .payload_offset(Int::U8, [Some(payload)])
            .size_wasm32()
    }
}

/// The bytes the discriminant of a variant or enum with `cases` cases takes.
pub fn discriminant_size(cases: usize) -> usize {
    if cases <= 1 << 8 {
        1
    } else if cases <= 1 << 16 {
        2
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts() {
        let mut resolve = Resolve::default();
        let package = resolve
            .push_str(
                "test.wit",
                "package t:l;
                interface i {
                    record r { a: u8, b: u64, c: string, d: bool }
                    variant v { x(u8), y(f64), z }
                    f: func(r: r, v: v, t: tuple<u16, f32>);
                }",
            )
            .unwrap();
        let sizes = Sizes::new(&resolve);
        let interface = resolve.packages[package].interfaces["i"];
        let types = &resolve.interfaces[interface].types;
        let record = Type::Id(types["r"]);
        assert_eq!(sizes.size(&record), 32);
        assert_eq!(sizes.align(&record), 8);
        assert_eq!(sizes.offsets(&sizes.parts(&record)), [0, 8, 16, 24]);
        let variant = Type::Id(types["v"]);
        let cases = sizes.case_types(&variant);
        assert_eq!(cases.len(), 3);
        assert_eq!(sizes.variant_payload_offset(&cases, 1), 8);
        assert_eq!(sizes.size(&variant), 16);
        assert_eq!(discriminant_size(3), 1);
        assert_eq!(discriminant_size(257), 2);
        assert_eq!(join(WasmType::F32, WasmType::I32), WasmType::I32);
        assert_eq!(
            join(WasmType::Pointer, WasmType::I64),
            WasmType::PointerOrI64
        );
        assert_eq!(core(WasmType::Length), WasmType::I32);
    }
}
