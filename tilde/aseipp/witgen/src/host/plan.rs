// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The lift and lower plan every host backend renders: wit-bindgen-core's
//! instruction stream for a function a host provides to a guest (an import
//! of the guest, whose arguments are lifted and whose results are lowered).
//! wit-bindgen-core decides what is read and written where, in what order;
//! a backend only says how each instruction reads in its language, through
//! [`Render`], and this module keeps the statements, temporaries and nested
//! blocks (a list's element is lifted or lowered in one) they make up.

use wit_bindgen_core::abi::{self, AbiVariant, Bindgen, Instruction, LiftLower};
use wit_parser::{Alignment, ArchitectureSize, Function, Resolve, SizeAlign, Type};

/// The statements of a function body, a block at a time.
pub(crate) struct Body {
    /// The statements of the blocks being written, innermost last.
    open: Vec<Vec<String>>,
    /// Blocks written and not yet taken by the instruction that uses them,
    /// with the operands each leaves.
    finished: Vec<(Vec<String>, Vec<String>)>,
    temps: usize,
}

impl Body {
    fn new() -> Self {
        Body {
            open: vec![Vec::new()],
            finished: Vec::new(),
            temps: 0,
        }
    }

    /// A fresh name for a temporary: `t0`, `t1`...
    pub fn temp(&mut self) -> String {
        let name = format!("t{}", self.temps);
        self.temps += 1;
        name
    }

    /// Appends a statement to the block being written.
    pub fn line(&mut self, text: impl Into<String>) {
        self.open
            .last_mut()
            .expect("a block is open")
            .push(text.into());
    }

    /// Appends a block's statements, indented by `indent`.
    pub fn lines(&mut self, lines: &[String], indent: &str) {
        for line in lines {
            if line.is_empty() {
                self.line("");
            } else {
                self.line(format!("{indent}{line}"));
            }
        }
    }

    /// How deep the block being written is: 0 for the function's own.
    pub fn depth(&self) -> usize {
        self.open.len() - 1
    }

    /// The block an instruction finished before it, with its operands.
    pub fn take(&mut self) -> (Vec<String>, Vec<String>) {
        self.finished
            .pop()
            .expect("the instruction's block was finished")
    }
}

/// How one language reads the instructions of the plan.
pub(crate) trait Render {
    /// The canonical ABI's layout.
    fn sizes(&self) -> &SizeAlign;

    /// Whether the language reads and writes a list of `element` whole, as
    /// a typed view or a copy of its bytes, rather than element by element.
    fn whole(&self, resolve: &Resolve, element: &Type) -> bool;

    /// Renders one instruction: its statements into `body`, and the operands
    /// it leaves, which later instructions use.
    fn render(
        &mut self,
        body: &mut Body,
        resolve: &Resolve,
        instruction: &Instruction<'_>,
        operands: &[String],
    ) -> Vec<String>;
}

struct Adapter<'r, R> {
    render: &'r mut R,
    body: Body,
}

impl<R: Render> Bindgen for Adapter<'_, R> {
    type Operand = String;

    fn emit(
        &mut self,
        resolve: &Resolve,
        instruction: &Instruction<'_>,
        operands: &mut Vec<String>,
        results: &mut Vec<String>,
    ) {
        let rendered = self
            .render
            .render(&mut self.body, resolve, instruction, operands);
        results.extend(rendered);
    }

    fn return_pointer(&mut self, _size: ArchitectureSize, _align: Alignment) -> String {
        unreachable!("a host's import is given its return pointer")
    }

    fn push_block(&mut self) {
        self.body.open.push(Vec::new());
    }

    fn finish_block(&mut self, operands: &mut Vec<String>) {
        let lines = self.body.open.pop().expect("a block is open");
        self.body.finished.push((lines, std::mem::take(operands)));
    }

    fn sizes(&self) -> &SizeAlign {
        self.render.sizes()
    }

    fn is_list_canonical(&self, resolve: &Resolve, element: &Type) -> bool {
        self.render.whole(resolve, element)
    }
}

/// The statements of a host's implementation of the import `function`.
pub(crate) fn body<R: Render>(
    resolve: &Resolve,
    function: &Function,
    render: &mut R,
) -> Vec<String> {
    let mut adapter = Adapter {
        render,
        body: Body::new(),
    };
    abi::call(
        resolve,
        AbiVariant::GuestImport,
        LiftLower::LiftArgsLowerResults,
        function,
        &mut adapter,
        false,
    );
    assert!(adapter.body.finished.is_empty(), "every block was used");
    adapter.body.open.pop().expect("the function's block")
}

/// `base + offset`, or `base` at offset zero.
pub(crate) fn at(base: &str, offset: ArchitectureSize) -> String {
    match offset.size_wasm32() {
        0 => base.to_string(),
        offset => format!("{base} + {offset}"),
    }
}

/// Whether an expression needs parentheses to be an operand: anything but
/// a name, a number, or a call or member of one.
pub(crate) fn needs_parens(expression: &str) -> bool {
    let mut depth = 0i32;
    for c in expression.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ' ' if depth == 0 => return true,
            _ => {}
        }
    }
    false
}

/// An expression as an operand of an operator.
pub(crate) fn operand(expression: &str) -> String {
    if needs_parens(expression) {
        format!("({expression})")
    } else {
        expression.to_string()
    }
}
