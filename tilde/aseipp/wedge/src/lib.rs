// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A WebAssembly frontend and target-neutral compiler framework.
//!
//! The compiler validates a Core WebAssembly 3.0 module and lowers it with
//! `wasmparser` into an owned, typed SSA control-flow graph. That IR is the
//! intended seam for shared analysis and future EDGE, RISC-V, and MLIR LLVM
//! dialect backends. Target legalization, scheduling, register placement, and
//! encoding remain later stages.

pub mod cfg;
mod core_context;
mod core_numeric;
mod core_schema;
pub mod dump;
pub mod edit;
mod frontend;
pub mod interp;
pub mod ir;
pub mod opcode;
pub mod semantics;
pub mod simplify;

use ir::Program;
use wasmparser::{BinaryReaderError, Parser, Validator, WasmFeatures};

/// The standardized WebAssembly Core 3.0 language accepted by Wedge.
///
/// `wasmparser` 0.258 predates the final Core 3.0 publication. Its draft
/// `WASM3` constant includes threads, while its general default additionally
/// enables proposals such as wide arithmetic and the Component Model. Keep
/// this as an explicit allowlist so adding support for a proposal is always a
/// deliberate decision.
pub const STANDARD_WASM_3_FEATURES: WasmFeatures = WasmFeatures::WASM2
    .union(WasmFeatures::GC)
    .union(WasmFeatures::TAIL_CALL)
    .union(WasmFeatures::EXTENDED_CONST)
    .union(WasmFeatures::FUNCTION_REFERENCES)
    .union(WasmFeatures::MULTI_MEMORY)
    .union(WasmFeatures::RELAXED_SIMD)
    .union(WasmFeatures::EXCEPTIONS)
    .union(WasmFeatures::MEMORY64);

/// Entry point for the Wedge compiler pipeline.
///
/// There is intentionally no public feature toggle. Wedge accepts the final
/// standardized Core 3.0 language and rejects experimental proposals.
#[derive(Clone, Copy, Debug, Default)]
pub struct Compiler;

impl Compiler {
    pub const fn new() -> Self {
        Self
    }

    /// Validate one binary against the standard Core WebAssembly 3.0 profile.
    ///
    /// Successful validation means the module is well-formed and uses only
    /// standardized features. [`Self::compile`] performs the same validation
    /// while lowering the module into owned IR.
    pub fn validate(&self, wasm: &[u8]) -> Result<(), CompileError> {
        if Parser::is_component(wasm) {
            return Err(CompileError::UnsupportedEncoding);
        }

        Validator::new_with_features(STANDARD_WASM_3_FEATURES).validate_all(wasm)?;
        Ok(())
    }

    /// Validate and lower one core WebAssembly binary.
    pub fn compile(&self, wasm: &[u8]) -> Result<Program, CompileError> {
        if Parser::is_component(wasm) {
            return Err(CompileError::UnsupportedEncoding);
        }

        // The frontend interleaves wasmparser's validator with translation so
        // it can reuse the validator's exact, instantiated stack types. Avoid
        // validating every function twice on the compilation path.
        frontend::lower_module(wasm).map_err(|error| match error {
            frontend::FrontendError::InvalidWasm { message, offset } => {
                CompileError::InvalidWasm { message, offset }
            }
            error => CompileError::Frontend {
                message: error.to_string(),
            },
        })
    }
}

/// A diagnostic produced before target code emission.
#[non_exhaustive]
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CompileError {
    #[error("invalid WebAssembly at byte {offset}: {message}")]
    InvalidWasm { message: String, offset: u64 },
    #[error("WebAssembly components are not supported")]
    UnsupportedEncoding,
    #[error("{message}")]
    Frontend { message: String },
}

impl From<BinaryReaderError> for CompileError {
    fn from(error: BinaryReaderError) -> Self {
        Self::InvalidWasm {
            message: error.message().to_owned(),
            offset: error.offset(),
        }
    }
}
