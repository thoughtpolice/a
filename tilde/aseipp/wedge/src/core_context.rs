// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Module-contextual schemas for ordinary Core WebAssembly operations.
//!
//! The parser-derived immediate layout lives in `core_schema`; this module
//! checks the semantic facts which depend on the containing module. The
//! frontend records the actual types present on the validated operand stack,
//! so operation parameters may be subtypes of the formal Core operand types.
//! Results, on the other hand, must be canonically equivalent to the result
//! types prescribed by the operation.

use crate::ir::{
    AddressType, CompositeType, DataId, ElementId, FieldType, FunctionId, FunctionType, GlobalId,
    HeapType, Immediate, MemoryArgument, MemoryId, Operation, OperationKind, Program, RefType,
    StorageType, TableId, TypeDefinition, TypeId, ValueType, are_value_types_equivalent,
    is_heap_subtype, is_ref_subtype, is_value_subtype,
};
use crate::opcode::CoreOpcode;

type SchemaResult = Result<(), String>;

/// Validate an ordinary standardized Core operation whose schema belongs to
/// this module.
///
/// `None` means that the operation is synthetic, represented structurally in
/// the CFG, or belongs to the context-free numeric/SIMD schema module. `Some`
/// means that this module owns the opcode family and has either accepted it or
/// produced a diagnostic. Profile filtering belongs to the coordinator so its
/// inventory check can detect an accidental nonstandard match here.
pub(crate) fn validate(module: &Program, operation: &Operation) -> Option<SchemaResult> {
    let OperationKind::Core(opcode) = operation.kind else {
        return None;
    };
    use CoreOpcode::*;
    let result = match opcode {
        Nop => fixed_signature(module, operation, &[], &[]),
        Drop => validate_drop(operation),
        Select => validate_select(module, operation),
        TypedSelect => validate_typed_select(module, operation),

        Call => validate_call(module, operation),
        CallIndirect => validate_call_indirect(module, operation),
        CallRef => validate_call_ref(module, operation),

        GlobalGet => validate_global_get(module, operation),
        GlobalSet => validate_global_set(module, operation),

        I32Load => validate_load(module, operation, ValueType::I32, 2),
        I64Load => validate_load(module, operation, ValueType::I64, 3),
        F32Load => validate_load(module, operation, ValueType::F32, 2),
        F64Load => validate_load(module, operation, ValueType::F64, 3),
        I32Load8S | I32Load8U => validate_load(module, operation, ValueType::I32, 0),
        I32Load16S | I32Load16U => validate_load(module, operation, ValueType::I32, 1),
        I64Load8S | I64Load8U => validate_load(module, operation, ValueType::I64, 0),
        I64Load16S | I64Load16U => validate_load(module, operation, ValueType::I64, 1),
        I64Load32S | I64Load32U => validate_load(module, operation, ValueType::I64, 2),
        I32Store => validate_store(module, operation, ValueType::I32, 2),
        I64Store => validate_store(module, operation, ValueType::I64, 3),
        F32Store => validate_store(module, operation, ValueType::F32, 2),
        F64Store => validate_store(module, operation, ValueType::F64, 3),
        I32Store8 => validate_store(module, operation, ValueType::I32, 0),
        I32Store16 => validate_store(module, operation, ValueType::I32, 1),
        I64Store8 => validate_store(module, operation, ValueType::I64, 0),
        I64Store16 => validate_store(module, operation, ValueType::I64, 1),
        I64Store32 => validate_store(module, operation, ValueType::I64, 2),
        MemorySize => validate_memory_size(module, operation),
        MemoryGrow => validate_memory_grow(module, operation),

        V128Load => validate_load(module, operation, ValueType::V128, 4),
        V128Load8x8S | V128Load8x8U | V128Load16x4S | V128Load16x4U | V128Load32x2S
        | V128Load32x2U => validate_load(module, operation, ValueType::V128, 3),
        V128Load8Splat => validate_load(module, operation, ValueType::V128, 0),
        V128Load16Splat => validate_load(module, operation, ValueType::V128, 1),
        V128Load32Splat | V128Load32Zero => validate_load(module, operation, ValueType::V128, 2),
        V128Load64Splat | V128Load64Zero => validate_load(module, operation, ValueType::V128, 3),
        V128Store => validate_store(module, operation, ValueType::V128, 4),
        V128Load8Lane => validate_lane_memory(module, operation, 0, 16, true),
        V128Load16Lane => validate_lane_memory(module, operation, 1, 8, true),
        V128Load32Lane => validate_lane_memory(module, operation, 2, 4, true),
        V128Load64Lane => validate_lane_memory(module, operation, 3, 2, true),
        V128Store8Lane => validate_lane_memory(module, operation, 0, 16, false),
        V128Store16Lane => validate_lane_memory(module, operation, 1, 8, false),
        V128Store32Lane => validate_lane_memory(module, operation, 2, 4, false),
        V128Store64Lane => validate_lane_memory(module, operation, 3, 2, false),

        MemoryInit => validate_memory_init(module, operation),
        DataDrop => validate_data_drop(module, operation),
        MemoryCopy => validate_memory_copy(module, operation),
        MemoryFill => validate_memory_fill(module, operation),
        TableInit => validate_table_init(module, operation),
        ElemDrop => validate_elem_drop(module, operation),
        TableCopy => validate_table_copy(module, operation),

        RefNull => validate_ref_null(module, operation),
        RefIsNull => validate_ref_is_null(module, operation),
        RefFunc => validate_ref_func(module, operation),
        RefAsNonNull => validate_ref_as_non_null(module, operation),
        RefEq => fixed_signature(
            module,
            operation,
            &[nullable_ref(HeapType::Eq), nullable_ref(HeapType::Eq)],
            &[ValueType::I32],
        ),
        RefI31 => fixed_signature(
            module,
            operation,
            &[ValueType::I32],
            &[non_null_ref(HeapType::I31)],
        ),
        I31GetS | I31GetU => fixed_signature(
            module,
            operation,
            &[nullable_ref(HeapType::I31)],
            &[ValueType::I32],
        ),
        AnyConvertExtern => {
            validate_reference_conversion(module, operation, HeapType::Extern, HeapType::Any)
        }
        ExternConvertAny => {
            validate_reference_conversion(module, operation, HeapType::Any, HeapType::Extern)
        }
        RefTestNonNull => validate_ref_test(module, operation, false),
        RefTestNullable => validate_ref_test(module, operation, true),
        RefCastNonNull => validate_ref_cast(module, operation, false),
        RefCastNullable => validate_ref_cast(module, operation, true),

        TableGet => validate_table_get(module, operation),
        TableSet => validate_table_set(module, operation),
        TableGrow => validate_table_grow(module, operation),
        TableSize => validate_table_size(module, operation),
        TableFill => validate_table_fill(module, operation),

        StructNew => validate_struct_new(module, operation),
        StructNewDefault => validate_struct_new_default(module, operation),
        StructGet => validate_struct_get(module, operation, StructAccess::Unpacked),
        StructGetS | StructGetU => validate_struct_get(module, operation, StructAccess::Packed),
        StructSet => validate_struct_set(module, operation),
        ArrayNew => validate_array_new(module, operation),
        ArrayNewDefault => validate_array_new_default(module, operation),
        ArrayNewFixed => validate_array_new_fixed(module, operation),
        ArrayNewData => validate_array_new_data(module, operation),
        ArrayNewElem => validate_array_new_elem(module, operation),
        ArrayGet => validate_array_get(module, operation, ArrayAccess::Unpacked),
        ArrayGetS | ArrayGetU => validate_array_get(module, operation, ArrayAccess::Packed),
        ArraySet => validate_array_set(module, operation),
        ArrayLen => fixed_signature(
            module,
            operation,
            &[nullable_ref(HeapType::Array)],
            &[ValueType::I32],
        ),
        ArrayFill => validate_array_fill(module, operation),
        ArrayCopy => validate_array_copy(module, operation),
        ArrayInitData => validate_array_init_data(module, operation),
        ArrayInitElem => validate_array_init_elem(module, operation),

        _ => return None,
    };
    Some(result)
}

fn validate_drop(operation: &Operation) -> SchemaResult {
    check_arity(operation, 1, 0)
}

fn validate_select(module: &Program, operation: &Operation) -> SchemaResult {
    check_arity(operation, 3, 1)?;
    let ty = &operation.signature.params[0];
    if !matches!(
        ty,
        ValueType::I32 | ValueType::I64 | ValueType::F32 | ValueType::F64 | ValueType::V128
    ) {
        return schema_error(
            operation,
            "untyped select requires a numeric or vector value type",
        );
    }
    require_equivalent(
        module,
        operation,
        &operation.signature.params[1],
        ty,
        "second select operand",
    )?;
    require_equivalent(
        module,
        operation,
        &operation.signature.params[2],
        &ValueType::I32,
        "select condition",
    )?;
    require_equivalent(
        module,
        operation,
        &operation.signature.results[0],
        ty,
        "select result",
    )
}

fn validate_typed_select(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::ValueType(ty)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "typed select must carry exactly one value-type immediate",
        );
    };
    fixed_signature(
        module,
        operation,
        &[ty.clone(), ty.clone(), ValueType::I32],
        std::slice::from_ref(ty),
    )
}

fn validate_call(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Function(function)] = operation.immediates.as_slice() else {
        return schema_error(operation, "call must carry exactly one function immediate");
    };
    let signature = function_signature(module, *function, operation)?;
    fixed_signature(module, operation, &signature.params, &signature.results)
}

fn validate_call_indirect(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::Table(table)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "call_indirect must carry a function type and a table immediate",
        );
    };
    let signature = type_signature(module, *ty, operation)?;
    let table = table_type(module, *table, operation)?;
    if !is_heap_subtype(&module.types, &table.element.heap, &HeapType::Func) {
        return schema_error(
            operation,
            format!(
                "call_indirect table element type {} is not a subtype of funcref",
                table.element
            ),
        );
    }
    let mut params = signature.params.clone();
    params.push(table.address_type.value_type());
    fixed_signature(module, operation, &params, &signature.results)
}

fn validate_call_ref(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "call_ref must carry exactly one function type immediate",
        );
    };
    let signature = type_signature(module, *ty, operation)?;
    let mut params = signature.params.clone();
    params.push(nullable_ref(HeapType::Concrete(*ty)));
    fixed_signature(module, operation, &params, &signature.results)
}

fn validate_global_get(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Global(global)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "global.get must carry exactly one global immediate",
        );
    };
    let global = global_type(module, *global, operation)?;
    fixed_signature(module, operation, &[], std::slice::from_ref(&global.value))
}

fn validate_global_set(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Global(global)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "global.set must carry exactly one global immediate",
        );
    };
    let global = global_type(module, *global, operation)?;
    if !global.mutable {
        return schema_error(operation, "global.set cannot target an immutable global");
    }
    fixed_signature(module, operation, std::slice::from_ref(&global.value), &[])
}

fn validate_load(
    module: &Program,
    operation: &Operation,
    result: ValueType,
    natural_alignment_log2: u8,
) -> SchemaResult {
    let address = memory_argument(module, operation, natural_alignment_log2)?.value_type();
    fixed_signature(module, operation, &[address], &[result])
}

fn validate_store(
    module: &Program,
    operation: &Operation,
    value: ValueType,
    natural_alignment_log2: u8,
) -> SchemaResult {
    let address = memory_argument(module, operation, natural_alignment_log2)?.value_type();
    fixed_signature(module, operation, &[address, value], &[])
}

fn validate_lane_memory(
    module: &Program,
    operation: &Operation,
    natural_alignment_log2: u8,
    lane_count: u8,
    is_load: bool,
) -> SchemaResult {
    let [Immediate::MemoryArgument(argument), Immediate::Lane(lane)] =
        operation.immediates.as_slice()
    else {
        return schema_error(
            operation,
            "SIMD lane memory operation must carry a memory argument and lane immediate",
        );
    };
    let address =
        checked_memory_argument(module, operation, argument, natural_alignment_log2)?.value_type();
    if *lane >= lane_count {
        return schema_error(
            operation,
            format!("lane {lane} is out of range for {lane_count} lanes"),
        );
    }
    let results = if is_load {
        std::slice::from_ref(&ValueType::V128)
    } else {
        &[]
    };
    fixed_signature(module, operation, &[address, ValueType::V128], results)
}

fn validate_memory_size(module: &Program, operation: &Operation) -> SchemaResult {
    let memory = sole_memory(module, operation)?;
    fixed_signature(module, operation, &[], &[memory.address_type.value_type()])
}

fn validate_memory_grow(module: &Program, operation: &Operation) -> SchemaResult {
    let memory = sole_memory(module, operation)?;
    let address = memory.address_type.value_type();
    fixed_signature(
        module,
        operation,
        std::slice::from_ref(&address),
        std::slice::from_ref(&address),
    )
}

fn validate_memory_init(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Data(data), Immediate::Memory(memory)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "memory.init must carry a data segment and memory immediate",
        );
    };
    require_data(module, *data, operation)?;
    let address = memory_type(module, *memory, operation)?
        .address_type
        .value_type();
    fixed_signature(
        module,
        operation,
        &[address, ValueType::I32, ValueType::I32],
        &[],
    )
}

fn validate_data_drop(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Data(data)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "data.drop must carry exactly one data segment immediate",
        );
    };
    require_data(module, *data, operation)?;
    fixed_signature(module, operation, &[], &[])
}

fn validate_memory_copy(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Memory(destination), Immediate::Memory(source)] =
        operation.immediates.as_slice()
    else {
        return schema_error(
            operation,
            "memory.copy must carry destination and source memory immediates",
        );
    };
    let destination = memory_type(module, *destination, operation)?.address_type;
    let source = memory_type(module, *source, operation)?.address_type;
    fixed_signature(
        module,
        operation,
        &[
            destination.value_type(),
            source.value_type(),
            minimum_address_type(destination, source).value_type(),
        ],
        &[],
    )
}

fn validate_memory_fill(module: &Program, operation: &Operation) -> SchemaResult {
    let memory = sole_memory(module, operation)?;
    let address = memory.address_type.value_type();
    fixed_signature(
        module,
        operation,
        &[address.clone(), ValueType::I32, address],
        &[],
    )
}

fn validate_table_init(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Element(element), Immediate::Table(table)] = operation.immediates.as_slice()
    else {
        return schema_error(
            operation,
            "table.init must carry an element segment and table immediate",
        );
    };
    let element = element_type(module, *element, operation)?;
    let table = table_type(module, *table, operation)?;
    if !is_ref_subtype(&module.types, element, &table.element) {
        return schema_error(
            operation,
            format!(
                "element segment type {element} is not a subtype of table element type {}",
                table.element
            ),
        );
    }
    fixed_signature(
        module,
        operation,
        &[
            table.address_type.value_type(),
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
}

fn validate_elem_drop(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Element(element)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "elem.drop must carry exactly one element segment immediate",
        );
    };
    element_type(module, *element, operation)?;
    fixed_signature(module, operation, &[], &[])
}

fn validate_table_copy(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Table(destination), Immediate::Table(source)] = operation.immediates.as_slice()
    else {
        return schema_error(
            operation,
            "table.copy must carry destination and source table immediates",
        );
    };
    let destination = table_type(module, *destination, operation)?;
    let source = table_type(module, *source, operation)?;
    if !is_ref_subtype(&module.types, &source.element, &destination.element) {
        return schema_error(
            operation,
            format!(
                "source table element type {} is not a subtype of destination element type {}",
                source.element, destination.element
            ),
        );
    }
    fixed_signature(
        module,
        operation,
        &[
            destination.address_type.value_type(),
            source.address_type.value_type(),
            minimum_address_type(destination.address_type, source.address_type).value_type(),
        ],
        &[],
    )
}

fn validate_table_get(module: &Program, operation: &Operation) -> SchemaResult {
    let table = sole_table(module, operation)?;
    fixed_signature(
        module,
        operation,
        &[table.address_type.value_type()],
        &[ValueType::Ref(table.element.clone())],
    )
}

fn validate_table_set(module: &Program, operation: &Operation) -> SchemaResult {
    let table = sole_table(module, operation)?;
    fixed_signature(
        module,
        operation,
        &[
            table.address_type.value_type(),
            ValueType::Ref(table.element.clone()),
        ],
        &[],
    )
}

fn validate_table_grow(module: &Program, operation: &Operation) -> SchemaResult {
    let table = sole_table(module, operation)?;
    let address = table.address_type.value_type();
    fixed_signature(
        module,
        operation,
        &[ValueType::Ref(table.element.clone()), address.clone()],
        &[address],
    )
}

fn validate_table_size(module: &Program, operation: &Operation) -> SchemaResult {
    let table = sole_table(module, operation)?;
    fixed_signature(module, operation, &[], &[table.address_type.value_type()])
}

fn validate_table_fill(module: &Program, operation: &Operation) -> SchemaResult {
    let table = sole_table(module, operation)?;
    let address = table.address_type.value_type();
    fixed_signature(
        module,
        operation,
        &[
            address.clone(),
            ValueType::Ref(table.element.clone()),
            address,
        ],
        &[],
    )
}

fn validate_ref_null(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::HeapType(heap)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "ref.null must carry exactly one heap-type immediate",
        );
    };
    fixed_signature(module, operation, &[], &[nullable_ref(heap.clone())])
}

fn validate_ref_is_null(module: &Program, operation: &Operation) -> SchemaResult {
    check_arity(operation, 1, 1)?;
    if !matches!(operation.signature.params[0], ValueType::Ref(_)) {
        return schema_error(operation, "ref.is_null operand must be a reference");
    }
    require_equivalent(
        module,
        operation,
        &operation.signature.results[0],
        &ValueType::I32,
        "result",
    )
}

fn validate_ref_func(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Function(function)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "ref.func must carry exactly one function immediate",
        );
    };
    let definition = module
        .functions
        .get(function.index())
        .ok_or_else(|| operation_error(operation, format!("references missing {function}")))?;
    // Core binary validation additionally requires `function` to have been
    // declared by the source module. `wasmparser` enforces that at ingestion;
    // the owned IR deliberately permits later transforms to materialize a
    // reference to any function which still exists with a function type.
    type_signature(module, definition.ty, operation)?;
    fixed_signature(
        module,
        operation,
        &[],
        &[non_null_ref(HeapType::Concrete(definition.ty))],
    )
}

fn validate_ref_as_non_null(module: &Program, operation: &Operation) -> SchemaResult {
    check_arity(operation, 1, 1)?;
    let ValueType::Ref(input) = &operation.signature.params[0] else {
        return schema_error(operation, "ref.as_non_null operand must be a reference");
    };
    let expected = ValueType::Ref(RefType {
        nullable: false,
        heap: input.heap.clone(),
    });
    require_equivalent(
        module,
        operation,
        &operation.signature.results[0],
        &expected,
        "result",
    )
}

fn validate_reference_conversion(
    module: &Program,
    operation: &Operation,
    input_heap: HeapType,
    output_heap: HeapType,
) -> SchemaResult {
    check_arity(operation, 1, 1)?;
    let ValueType::Ref(input) = &operation.signature.params[0] else {
        return schema_error(
            operation,
            "reference conversion operand must be a reference",
        );
    };
    if !is_heap_subtype(&module.types, &input.heap, &input_heap) {
        return schema_error(
            operation,
            format!(
                "operand heap type {} is not a subtype of {input_heap}",
                input.heap
            ),
        );
    }
    let expected = ValueType::Ref(RefType {
        nullable: input.nullable,
        heap: output_heap,
    });
    require_equivalent(
        module,
        operation,
        &operation.signature.results[0],
        &expected,
        "result",
    )
}

fn validate_ref_test(module: &Program, operation: &Operation, nullable: bool) -> SchemaResult {
    let target = cast_target(operation, nullable)?;
    let top = hierarchy_top(module, &target.heap, operation)?;
    fixed_signature(module, operation, &[nullable_ref(top)], &[ValueType::I32])
}

fn validate_ref_cast(module: &Program, operation: &Operation, nullable: bool) -> SchemaResult {
    let target = cast_target(operation, nullable)?;
    let top = hierarchy_top(module, &target.heap, operation)?;
    fixed_signature(
        module,
        operation,
        &[nullable_ref(top)],
        &[ValueType::Ref(target)],
    )
}

fn cast_target(operation: &Operation, nullable: bool) -> Result<RefType, String> {
    let [Immediate::HeapType(heap)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "reference cast/test must carry exactly one heap-type immediate",
        ));
    };
    Ok(RefType {
        nullable,
        heap: heap.clone(),
    })
}

fn hierarchy_top(
    module: &Program,
    heap: &HeapType,
    operation: &Operation,
) -> Result<HeapType, String> {
    Ok(match heap {
        HeapType::Any
        | HeapType::Eq
        | HeapType::I31
        | HeapType::Struct
        | HeapType::Array
        | HeapType::None => HeapType::Any,
        HeapType::Func | HeapType::NoFunc => HeapType::Func,
        HeapType::Extern | HeapType::NoExtern => HeapType::Extern,
        HeapType::Exn | HeapType::NoExn => HeapType::Exn,
        HeapType::Concrete(ty) => match type_definition(module, *ty, operation)?.composite {
            CompositeType::Function(_) => HeapType::Func,
            CompositeType::Struct(_) | CompositeType::Array(_) => HeapType::Any,
        },
    })
}

fn validate_struct_new(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let fields = struct_type(module, ty, operation)?;
    let params = fields
        .iter()
        .map(|field| field.storage.stack_type())
        .collect::<Vec<_>>();
    fixed_signature(
        module,
        operation,
        &params,
        &[non_null_ref(HeapType::Concrete(ty))],
    )
}

fn validate_struct_new_default(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let fields = struct_type(module, ty, operation)?;
    if fields.iter().any(|field| !field.storage.is_defaultable()) {
        return schema_error(
            operation,
            "struct.new_default type has a non-defaultable field",
        );
    }
    fixed_signature(
        module,
        operation,
        &[],
        &[non_null_ref(HeapType::Concrete(ty))],
    )
}

#[derive(Clone, Copy)]
enum StructAccess {
    Unpacked,
    Packed,
}

fn validate_struct_get(
    module: &Program,
    operation: &Operation,
    access: StructAccess,
) -> SchemaResult {
    let (ty, field) = struct_field(module, operation)?;
    let result = match (access, &field.storage) {
        (StructAccess::Unpacked, StorageType::Value(ty)) => ty.clone(),
        (StructAccess::Packed, StorageType::I8 | StorageType::I16) => ValueType::I32,
        (StructAccess::Unpacked, StorageType::I8 | StorageType::I16) => {
            return schema_error(operation, "plain struct.get cannot read a packed field");
        }
        (StructAccess::Packed, StorageType::Value(_)) => {
            return schema_error(
                operation,
                "signed/unsigned struct.get requires a packed field",
            );
        }
    };
    fixed_signature(
        module,
        operation,
        &[nullable_ref(HeapType::Concrete(ty))],
        &[result],
    )
}

fn validate_struct_set(module: &Program, operation: &Operation) -> SchemaResult {
    let (ty, field) = struct_field(module, operation)?;
    if !field.mutable {
        return schema_error(operation, "struct.set cannot modify an immutable field");
    }
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(ty)),
            field.storage.stack_type(),
        ],
        &[],
    )
}

fn validate_array_new(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let field = array_type(module, ty, operation)?;
    fixed_signature(
        module,
        operation,
        &[field.storage.stack_type(), ValueType::I32],
        &[non_null_ref(HeapType::Concrete(ty))],
    )
}

fn validate_array_new_default(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let field = array_type(module, ty, operation)?;
    if !field.storage.is_defaultable() {
        return schema_error(
            operation,
            "array.new_default type has a non-defaultable element",
        );
    }
    fixed_signature(
        module,
        operation,
        &[ValueType::I32],
        &[non_null_ref(HeapType::Concrete(ty))],
    )
}

fn validate_array_new_fixed(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::U32(length)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "array.new_fixed must carry an array type and element-count immediate",
        );
    };
    let field = array_type(module, *ty, operation)?;
    if operation.signature.params.len() != *length as usize {
        return schema_error(
            operation,
            format!(
                "has {} parameters, but its element-count immediate is {length}",
                operation.signature.params.len()
            ),
        );
    }
    let element = field.storage.stack_type();
    for (index, actual) in operation.signature.params.iter().enumerate() {
        require_subtype(
            module,
            operation,
            actual,
            &element,
            &format!("parameter {index}"),
        )?;
    }
    check_results(module, operation, &[non_null_ref(HeapType::Concrete(*ty))])
}

fn validate_array_new_data(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::Data(data)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "array.new_data must carry an array type and data segment immediate",
        );
    };
    let field = array_type(module, *ty, operation)?;
    if !field.storage.is_numeric_or_vector() {
        return schema_error(
            operation,
            "array.new_data requires a numeric or vector element type",
        );
    }
    require_data(module, *data, operation)?;
    fixed_signature(
        module,
        operation,
        &[ValueType::I32, ValueType::I32],
        &[non_null_ref(HeapType::Concrete(*ty))],
    )
}

fn validate_array_new_elem(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::Element(element)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "array.new_elem must carry an array type and element segment immediate",
        );
    };
    let field = array_type(module, *ty, operation)?;
    let StorageType::Value(ValueType::Ref(array_element)) = &field.storage else {
        return schema_error(
            operation,
            "array.new_elem requires a reference element type",
        );
    };
    let segment_element = element_type(module, *element, operation)?;
    if !is_ref_subtype(&module.types, segment_element, array_element) {
        return schema_error(
            operation,
            format!(
                "element segment type {segment_element} is not a subtype of array element type {array_element}"
            ),
        );
    }
    fixed_signature(
        module,
        operation,
        &[ValueType::I32, ValueType::I32],
        &[non_null_ref(HeapType::Concrete(*ty))],
    )
}

#[derive(Clone, Copy)]
enum ArrayAccess {
    Unpacked,
    Packed,
}

fn validate_array_get(
    module: &Program,
    operation: &Operation,
    access: ArrayAccess,
) -> SchemaResult {
    let ty = sole_type(operation)?;
    let field = array_type(module, ty, operation)?;
    let result = match (access, &field.storage) {
        (ArrayAccess::Unpacked, StorageType::Value(ty)) => ty.clone(),
        (ArrayAccess::Packed, StorageType::I8 | StorageType::I16) => ValueType::I32,
        (ArrayAccess::Unpacked, StorageType::I8 | StorageType::I16) => {
            return schema_error(operation, "plain array.get cannot read a packed element");
        }
        (ArrayAccess::Packed, StorageType::Value(_)) => {
            return schema_error(
                operation,
                "signed/unsigned array.get requires packed elements",
            );
        }
    };
    fixed_signature(
        module,
        operation,
        &[nullable_ref(HeapType::Concrete(ty)), ValueType::I32],
        &[result],
    )
}

fn validate_array_set(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let field = array_type(module, ty, operation)?;
    if !field.mutable {
        return schema_error(operation, "array.set cannot modify immutable elements");
    }
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(ty)),
            ValueType::I32,
            field.storage.stack_type(),
        ],
        &[],
    )
}

fn validate_array_fill(module: &Program, operation: &Operation) -> SchemaResult {
    let ty = sole_type(operation)?;
    let field = array_type(module, ty, operation)?;
    if !field.mutable {
        return schema_error(operation, "array.fill cannot modify immutable elements");
    }
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(ty)),
            ValueType::I32,
            field.storage.stack_type(),
            ValueType::I32,
        ],
        &[],
    )
}

fn validate_array_copy(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(destination), Immediate::Type(source)] = operation.immediates.as_slice()
    else {
        return schema_error(
            operation,
            "array.copy must carry destination and source array type immediates",
        );
    };
    let destination_field = array_type(module, *destination, operation)?;
    let source_field = array_type(module, *source, operation)?;
    if !destination_field.mutable {
        return schema_error(operation, "array.copy destination elements are immutable");
    }
    if !source_field
        .storage
        .is_subtype_of(&module.types, &destination_field.storage)
    {
        return schema_error(
            operation,
            "array.copy source element type is not compatible with its destination element type",
        );
    }
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(*destination)),
            ValueType::I32,
            nullable_ref(HeapType::Concrete(*source)),
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
}

fn validate_array_init_data(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::Data(data)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "array.init_data must carry an array type and data segment immediate",
        );
    };
    let field = array_type(module, *ty, operation)?;
    if !field.mutable {
        return schema_error(
            operation,
            "array.init_data cannot modify immutable elements",
        );
    }
    if !field.storage.is_numeric_or_vector() {
        return schema_error(
            operation,
            "array.init_data requires a numeric or vector element type",
        );
    }
    require_data(module, *data, operation)?;
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(*ty)),
            ValueType::I32,
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
}

fn validate_array_init_elem(module: &Program, operation: &Operation) -> SchemaResult {
    let [Immediate::Type(ty), Immediate::Element(element)] = operation.immediates.as_slice() else {
        return schema_error(
            operation,
            "array.init_elem must carry an array type and element segment immediate",
        );
    };
    let field = array_type(module, *ty, operation)?;
    if !field.mutable {
        return schema_error(
            operation,
            "array.init_elem cannot modify immutable elements",
        );
    }
    let StorageType::Value(ValueType::Ref(array_element)) = &field.storage else {
        return schema_error(
            operation,
            "array.init_elem requires a reference element type",
        );
    };
    let segment_element = element_type(module, *element, operation)?;
    if !is_ref_subtype(&module.types, segment_element, array_element) {
        return schema_error(
            operation,
            format!(
                "element segment type {segment_element} is not a subtype of array element type {array_element}"
            ),
        );
    }
    fixed_signature(
        module,
        operation,
        &[
            nullable_ref(HeapType::Concrete(*ty)),
            ValueType::I32,
            ValueType::I32,
            ValueType::I32,
        ],
        &[],
    )
}

fn fixed_signature(
    module: &Program,
    operation: &Operation,
    params: &[ValueType],
    results: &[ValueType],
) -> SchemaResult {
    check_arity(operation, params.len(), results.len())?;
    for (index, (actual, expected)) in operation.signature.params.iter().zip(params).enumerate() {
        require_subtype(
            module,
            operation,
            actual,
            expected,
            &format!("parameter {index}"),
        )?;
    }
    check_results(module, operation, results)
}

fn check_results(module: &Program, operation: &Operation, expected: &[ValueType]) -> SchemaResult {
    if operation.signature.results.len() != expected.len() {
        return schema_error(
            operation,
            format!(
                "has {} results, expected {}",
                operation.signature.results.len(),
                expected.len()
            ),
        );
    }
    for (index, (actual, expected)) in operation.signature.results.iter().zip(expected).enumerate()
    {
        require_equivalent(
            module,
            operation,
            actual,
            expected,
            &format!("result {index}"),
        )?;
    }
    Ok(())
}

fn check_arity(operation: &Operation, params: usize, results: usize) -> SchemaResult {
    let actual = (
        operation.signature.params.len(),
        operation.signature.results.len(),
    );
    if actual != (params, results) {
        return schema_error(
            operation,
            format!(
                "has signature arity {} -> {}, expected {params} -> {results}",
                actual.0, actual.1
            ),
        );
    }
    Ok(())
}

fn require_subtype(
    module: &Program,
    operation: &Operation,
    actual: &ValueType,
    expected: &ValueType,
    subject: &str,
) -> SchemaResult {
    if !is_value_subtype(&module.types, actual, expected) {
        return schema_error(
            operation,
            format!("{subject} has type {actual}, expected a subtype of {expected}"),
        );
    }
    Ok(())
}

fn require_equivalent(
    module: &Program,
    operation: &Operation,
    actual: &ValueType,
    expected: &ValueType,
    subject: &str,
) -> SchemaResult {
    if !are_value_types_equivalent(&module.types, actual, expected) {
        return schema_error(
            operation,
            format!("{subject} has type {actual}, expected {expected}"),
        );
    }
    Ok(())
}

fn memory_argument(
    module: &Program,
    operation: &Operation,
    natural_alignment_log2: u8,
) -> Result<AddressType, String> {
    let [Immediate::MemoryArgument(argument)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "memory operation must carry exactly one memory argument",
        ));
    };
    checked_memory_argument(module, operation, argument, natural_alignment_log2)
}

fn checked_memory_argument(
    module: &Program,
    operation: &Operation,
    argument: &MemoryArgument,
    natural_alignment_log2: u8,
) -> Result<AddressType, String> {
    let memory = memory_type(module, argument.memory, operation)?;
    if argument.alignment_log2 > natural_alignment_log2 {
        return Err(operation_error(
            operation,
            format!(
                "alignment 2^{} exceeds natural alignment 2^{natural_alignment_log2}",
                argument.alignment_log2
            ),
        ));
    }
    if memory.address_type == AddressType::I32 && argument.offset > u64::from(u32::MAX) {
        return Err(operation_error(
            operation,
            format!(
                "offset {} does not fit the referenced 32-bit memory",
                argument.offset
            ),
        ));
    }
    Ok(memory.address_type)
}

fn sole_memory<'a>(
    module: &'a Program,
    operation: &Operation,
) -> Result<&'a crate::ir::MemoryType, String> {
    let [Immediate::Memory(memory)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "operation must carry exactly one memory immediate",
        ));
    };
    memory_type(module, *memory, operation)
}

fn memory_type<'a>(
    module: &'a Program,
    memory: MemoryId,
    operation: &Operation,
) -> Result<&'a crate::ir::MemoryType, String> {
    module
        .memories
        .get(memory.index())
        .map(|definition| &definition.ty)
        .ok_or_else(|| operation_error(operation, format!("references missing {memory}")))
}

fn sole_table<'a>(
    module: &'a Program,
    operation: &Operation,
) -> Result<&'a crate::ir::TableType, String> {
    let [Immediate::Table(table)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "operation must carry exactly one table immediate",
        ));
    };
    table_type(module, *table, operation)
}

fn table_type<'a>(
    module: &'a Program,
    table: TableId,
    operation: &Operation,
) -> Result<&'a crate::ir::TableType, String> {
    module
        .tables
        .get(table.index())
        .map(|definition| &definition.ty)
        .ok_or_else(|| operation_error(operation, format!("references missing {table}")))
}

fn global_type<'a>(
    module: &'a Program,
    global: GlobalId,
    operation: &Operation,
) -> Result<&'a crate::ir::GlobalType, String> {
    module
        .globals
        .get(global.index())
        .map(|definition| &definition.ty)
        .ok_or_else(|| operation_error(operation, format!("references missing {global}")))
}

fn function_signature<'a>(
    module: &'a Program,
    function: FunctionId,
    operation: &Operation,
) -> Result<&'a FunctionType, String> {
    let definition = module
        .functions
        .get(function.index())
        .ok_or_else(|| operation_error(operation, format!("references missing {function}")))?;
    type_signature(module, definition.ty, operation)
}

fn type_signature<'a>(
    module: &'a Program,
    ty: TypeId,
    operation: &Operation,
) -> Result<&'a FunctionType, String> {
    match &type_definition(module, ty, operation)?.composite {
        CompositeType::Function(signature) => Ok(signature),
        _ => Err(operation_error(
            operation,
            format!("requires {ty} to be a function type"),
        )),
    }
}

fn type_definition<'a>(
    module: &'a Program,
    ty: TypeId,
    operation: &Operation,
) -> Result<&'a TypeDefinition, String> {
    module
        .types
        .get(ty.index())
        .ok_or_else(|| operation_error(operation, format!("references missing {ty}")))
}

fn struct_type<'a>(
    module: &'a Program,
    ty: TypeId,
    operation: &Operation,
) -> Result<&'a [FieldType], String> {
    match &type_definition(module, ty, operation)?.composite {
        CompositeType::Struct(fields) => Ok(fields),
        _ => Err(operation_error(
            operation,
            format!("requires {ty} to be a struct type"),
        )),
    }
}

fn array_type<'a>(
    module: &'a Program,
    ty: TypeId,
    operation: &Operation,
) -> Result<&'a FieldType, String> {
    match &type_definition(module, ty, operation)?.composite {
        CompositeType::Array(field) => Ok(field),
        _ => Err(operation_error(
            operation,
            format!("requires {ty} to be an array type"),
        )),
    }
}

fn sole_type(operation: &Operation) -> Result<TypeId, String> {
    let [Immediate::Type(ty)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "operation must carry exactly one type immediate",
        ));
    };
    Ok(*ty)
}

fn struct_field<'a>(
    module: &'a Program,
    operation: &Operation,
) -> Result<(TypeId, &'a FieldType), String> {
    let [Immediate::Type(ty), Immediate::U32(field)] = operation.immediates.as_slice() else {
        return Err(operation_error(
            operation,
            "struct access must carry a struct type and field-index immediate",
        ));
    };
    let field_type = struct_type(module, *ty, operation)?
        .get(*field as usize)
        .ok_or_else(|| {
            operation_error(
                operation,
                format!("field index {field} is out of range for {ty}"),
            )
        })?;
    Ok((*ty, field_type))
}

fn element_type<'a>(
    module: &'a Program,
    element: ElementId,
    operation: &Operation,
) -> Result<&'a RefType, String> {
    module
        .elements
        .get(element.index())
        .map(|definition| &definition.ty)
        .ok_or_else(|| operation_error(operation, format!("references missing {element}")))
}

fn require_data(module: &Program, data: DataId, operation: &Operation) -> SchemaResult {
    if module.data.get(data.index()).is_none() {
        return schema_error(operation, format!("references missing {data}"));
    }
    Ok(())
}

fn minimum_address_type(left: AddressType, right: AddressType) -> AddressType {
    if left == AddressType::I32 || right == AddressType::I32 {
        AddressType::I32
    } else {
        AddressType::I64
    }
}

fn nullable_ref(heap: HeapType) -> ValueType {
    ValueType::Ref(RefType {
        nullable: true,
        heap,
    })
}

fn non_null_ref(heap: HeapType) -> ValueType {
    ValueType::Ref(RefType {
        nullable: false,
        heap,
    })
}

fn operation_error(operation: &Operation, detail: impl Into<String>) -> String {
    let mnemonic = match operation.kind {
        OperationKind::Core(opcode) => opcode.mnemonic().to_owned(),
        OperationKind::Synthetic => operation.mnemonic.to_string(),
    };
    format!("Core operator {mnemonic} {}", detail.into())
}

fn schema_error<T>(operation: &Operation, detail: impl Into<String>) -> Result<T, String> {
    Err(operation_error(operation, detail))
}
