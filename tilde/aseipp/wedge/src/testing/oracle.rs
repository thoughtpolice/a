// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The contract the compiler keeps on every byte string.

use std::fmt;

use wedge::dump::CfgDump;
use wedge::ir::{Program, VerifyErrors};
use wedge::{CompileError, Compiler};

/// A way the compiler contradicted itself on one input.
///
/// Each variant has a stable code so a fuzzing campaign keeps the failures
/// apart and a replay can insist on one of them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Failure {
    /// Validation accepts the module but lowering rejects it.
    RejectedValid(CompileError),
    /// Lowering produces a program from a module validation rejects.
    AcceptedInvalid(CompileError),
    /// The lowered program fails its own verifier.
    VerifyFailed(VerifyErrors),
}

impl Failure {
    /// The harness result that identifies this failure to Fozzie.
    pub fn code(&self) -> i32 {
        match self {
            Failure::RejectedValid(_) => 1,
            Failure::AcceptedInvalid(_) => 2,
            Failure::VerifyFailed(_) => 3,
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::RejectedValid(error) => {
                write!(
                    f,
                    "validation accepts the module but compilation rejects it: {error}"
                )
            }
            Failure::AcceptedInvalid(error) => {
                write!(
                    f,
                    "compilation accepts a module validation rejects: {error}"
                )
            }
            Failure::VerifyFailed(errors) => {
                write!(f, "the lowered program fails verification: {errors}")
            }
        }
    }
}

impl std::error::Error for Failure {}

/// Checks the compiler's contract on `wasm`: validation and compilation agree
/// on whether it is a standard Core 3.0 module, a compiled program verifies,
/// and both textual dumps render. Returns the program when there is one.
pub fn check_module(wasm: &[u8]) -> Result<Option<Program>, Failure> {
    let compiler = Compiler::new();
    let program = match (compiler.validate(wasm), compiler.compile(wasm)) {
        (Ok(()), Ok(program)) => program,
        (Err(_), Err(_)) => return Ok(None),
        (Ok(()), Err(error)) => return Err(Failure::RejectedValid(error)),
        (Err(error), Ok(_)) => return Err(Failure::AcceptedInvalid(error)),
    };
    program.verify().map_err(Failure::VerifyFailed)?;
    let _ = program.to_string();
    let _ = CfgDump::new(&program).to_string();
    Ok(Some(program))
}
