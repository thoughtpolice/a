// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Stable, owned identities for operators decoded by `wasmparser`.
//!
//! `wasmparser::Operator` deliberately borrows some immediates from the input
//! binary. Wedge cannot retain that enum in its IR, but reducing an operator to
//! an unchecked string would also throw away useful semantic identity. This
//! module generates a fieldless owned opcode from the same operator inventory
//! as the parser. Immediates and instantiated stack signatures live separately
//! in the IR.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::OnceLock;

use wasmparser::Operator;

/// The proposal bucket under which `wasmparser` decodes an operator.
///
/// This includes proposals that Wedge intentionally rejects. Keeping their
/// names here makes the acceptance boundary explicit and lets the verifier
/// reject an accidentally constructed out-of-profile IR operation.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[non_exhaustive]
pub enum CoreProposal {
    Mvp,
    SignExtension,
    Gc,
    CustomDescriptors,
    SaturatingFloatToInt,
    BulkMemory,
    ReferenceTypes,
    TailCall,
    MemoryControl,
    Threads,
    Simd,
    RelaxedSimd,
    Exceptions,
    LegacyExceptions,
    SharedEverythingThreads,
    FunctionReferences,
    StackSwitching,
    WideArithmetic,
}

impl CoreProposal {
    /// Whether this operator proposal is part of Wedge's Core Wasm 3 profile.
    pub const fn is_standard_wasm3(self) -> bool {
        matches!(
            self,
            Self::Mvp
                | Self::SignExtension
                | Self::Gc
                | Self::SaturatingFloatToInt
                | Self::BulkMemory
                | Self::ReferenceTypes
                | Self::TailCall
                | Self::Simd
                | Self::RelaxedSimd
                | Self::Exceptions
                | Self::FunctionReferences
        )
    }
}

macro_rules! proposal {
    (mvp) => {
        CoreProposal::Mvp
    };
    (sign_extension) => {
        CoreProposal::SignExtension
    };
    (gc) => {
        CoreProposal::Gc
    };
    (custom_descriptors) => {
        CoreProposal::CustomDescriptors
    };
    (saturating_float_to_int) => {
        CoreProposal::SaturatingFloatToInt
    };
    (bulk_memory) => {
        CoreProposal::BulkMemory
    };
    (reference_types) => {
        CoreProposal::ReferenceTypes
    };
    (tail_call) => {
        CoreProposal::TailCall
    };
    (memory_control) => {
        CoreProposal::MemoryControl
    };
    (threads) => {
        CoreProposal::Threads
    };
    (simd) => {
        CoreProposal::Simd
    };
    (relaxed_simd) => {
        CoreProposal::RelaxedSimd
    };
    (exceptions) => {
        CoreProposal::Exceptions
    };
    (legacy_exceptions) => {
        CoreProposal::LegacyExceptions
    };
    (shared_everything_threads) => {
        CoreProposal::SharedEverythingThreads
    };
    (function_references) => {
        CoreProposal::FunctionReferences
    };
    (stack_switching) => {
        CoreProposal::StackSwitching
    };
    (wide_arithmetic) => {
        CoreProposal::WideArithmetic
    };
}

macro_rules! fixed_arity {
    (arity $params:literal -> $results:literal) => {
        Some(($params, $results))
    };
    (arity custom) => {
        None
    };
}

macro_rules! define_core_opcodes {
    ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*) )*) => {
        /// An owned identity for every Core operator understood by the pinned
        /// `wasmparser` version.
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        #[non_exhaustive]
        pub enum CoreOpcode {
            $( $op, )*
        }

        impl CoreOpcode {
            /// Every Core operator understood by the pinned `wasmparser`
            /// version, in parser-inventory order.
            pub const ALL: &'static [Self] = &[
                $( Self::$op, )*
            ];

            /// Obtain an owned identity without retaining borrowed immediates.
            pub fn from_operator(operator: &Operator<'_>) -> Option<Self> {
                Some(match operator {
                    $( Operator::$op $({ $($arg: _,)* })? => Self::$op, )*
                    _ => return None,
                })
            }

            /// The context-independent operand and result counts recorded in
            /// `wasmparser`'s operator inventory.
            ///
            /// Context-dependent operators such as branches, calls, and
            /// aggregate construction return `None`; their instantiated IR
            /// signatures must be derived while validating and lowering.
            pub const fn fixed_arity(self) -> Option<(usize, usize)> {
                match self {
                    $( Self::$op => fixed_arity!($($ann)*), )*
                }
            }

            /// The ordered parser field names which encode this opcode's
            /// immediate operands.
            ///
            /// Wedge uses these names to derive the corresponding strongly
            /// typed IR immediate layout from the same inventory as decoding.
            pub const fn immediate_fields(self) -> &'static [&'static str] {
                match self {
                    $( Self::$op => &[ $( $( stringify!($arg), )* )? ], )*
                }
            }

            /// Recover an opcode from the canonical mnemonic returned by
            /// [`Self::mnemonic`].
            ///
            /// This deliberately accepts exact canonical spellings only. An
            /// unknown name belongs to Wedge's compiler/synthetic operation
            /// namespace rather than being silently treated as Core Wasm.
            /// Text mnemonics are not a bijection: typed and untyped `select`
            /// operators share `select`, and the nullable and non-null forms
            /// of `ref.test` and `ref.cast` share their respective mnemonics.
            /// For these cases this returns the first opcode in parser-
            /// inventory order.
            pub fn from_mnemonic(mnemonic: &str) -> Option<Self> {
                static OPCODES: OnceLock<BTreeMap<&'static str, CoreOpcode>> = OnceLock::new();
                OPCODES
                    .get_or_init(|| {
                        let mut opcodes = BTreeMap::new();
                        for &opcode in Self::ALL {
                            opcodes.entry(opcode.mnemonic()).or_insert(opcode);
                        }
                        opcodes
                    })
                    .get(mnemonic)
                    .copied()
            }

            /// The parser proposal bucket associated with this operator.
            pub const fn proposal(self) -> CoreProposal {
                match self {
                    $( Self::$op => proposal!($proposal), )*
                }
            }

            /// Whether this exact opcode is part of Wedge's Core Wasm 3
            /// profile.
            ///
            /// `TypedSelectMulti` is retained in `wasmparser`'s reference-
            /// types inventory so it can be parsed and printed, but Core Wasm
            /// validation deliberately rejects multi-result `select`.
            pub const fn is_standard_wasm3(self) -> bool {
                self.proposal().is_standard_wasm3()
                    && !matches!(self, Self::TypedSelectMulti)
            }

            /// Whether this opcode may occur in a standard Core Wasm 3
            /// constant expression.
            pub const fn is_const_expression(self) -> bool {
                matches!(
                    self,
                    Self::I32Const
                        | Self::I64Const
                        | Self::F32Const
                        | Self::F64Const
                        | Self::V128Const
                        | Self::RefNull
                        | Self::RefFunc
                        | Self::GlobalGet
                        | Self::I32Add
                        | Self::I32Sub
                        | Self::I32Mul
                        | Self::I64Add
                        | Self::I64Sub
                        | Self::I64Mul
                        | Self::StructNew
                        | Self::StructNewDefault
                        | Self::ArrayNew
                        | Self::ArrayNewDefault
                        | Self::ArrayNewFixed
                        | Self::RefI31
                        | Self::ExternConvertAny
                        | Self::AnyConvertExtern
                )
            }

            /// The Rust variant name used by `wasmparser`.
            pub const fn parser_name(self) -> &'static str {
                match self {
                    $( Self::$op => stringify!($op), )*
                }
            }

            /// The visitor method name used by `wasmparser`.
            ///
            /// Unlike the Rust variant name, this preserves text-format word
            /// boundaries for compounds such as `extadd`, `q15mulr`, and
            /// `pmin`.
            pub const fn visitor_name(self) -> &'static str {
                match self {
                    $( Self::$op => stringify!($visit), )*
                }
            }

            /// The canonical text-format mnemonic.
            ///
            /// The table is built once over the whole inventory; `ALL` lists
            /// the variants in declaration order, so a variant's discriminant
            /// indexes it.
            pub fn mnemonic(self) -> &'static str {
                static MNEMONICS: OnceLock<Vec<String>> = OnceLock::new();
                MNEMONICS
                    .get_or_init(|| {
                        Self::ALL
                            .iter()
                            .map(|opcode| match opcode {
                                Self::TypedSelect | Self::TypedSelectMulti => "select".to_owned(),
                                Self::RefTestNonNull | Self::RefTestNullable => {
                                    "ref.test".to_owned()
                                }
                                Self::RefCastNonNull | Self::RefCastNullable => {
                                    "ref.cast".to_owned()
                                }
                                _ => canonical_mnemonic(opcode.visitor_name()),
                            })
                            .collect()
                    })[self as usize]
                    .as_str()
            }
        }
    };
}

wasmparser::for_each_operator!(define_core_opcodes);

impl fmt::Display for CoreOpcode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.mnemonic())
    }
}

/// The text-format mnemonic derived from a `wasmparser` visitor name: the
/// `visit_` prefix dropped and the namespace separator restored.
fn canonical_mnemonic(visitor_name: &str) -> String {
    let mut mnemonic = visitor_name
        .strip_prefix("visit_")
        .expect("wasmparser operator visitor names start with `visit_`")
        .to_owned();

    const NAMESPACES: &[&str] = &[
        "i8x16", "i16x8", "i32x4", "i64x2", "f32x4", "f64x2", "i32", "i64", "f32", "f64", "v128",
        "local", "global", "memory", "table", "ref", "struct", "array", "i31", "any", "extern",
        "data", "elem",
    ];
    for namespace in NAMESPACES {
        let separator = namespace.len();
        if mnemonic.starts_with(namespace) && mnemonic.as_bytes().get(separator) == Some(&b'_') {
            mnemonic.replace_range(separator..=separator, ".");
            break;
        }
    }
    mnemonic
}
