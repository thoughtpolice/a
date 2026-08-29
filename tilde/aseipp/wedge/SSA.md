# Wedge SSA construction

Wedge lowers validated WebAssembly directly into a typed SSA control-flow
graph. It does not first materialize a mutable-local or stack-machine IR. This
graph is the target-neutral representation of WebAssembly semantics; it is not
an EDGE instruction graph or a conventional target's machine IR.

The design follows Braun et al., *Simple and Efficient Construction of Static
Single Assignment Form*:
<https://c9x.me/compile/bib/braun13cc.pdf>. The accompanying Cornell CS 6120
review is useful additional context:
<https://www.cs.cornell.edu/courses/cs6120/2025sp/blog/efficient-ssa/>.

## Semantic contract

- CFG edges and block parameters, including invoke continuations and
  exceptional edges, are the authoritative control- and data-flow
  representation. Structured regions retain source structure and EH
  scope; they do not duplicate CFG semantics. Entry-rooted topology and
  dominance include ordinary and in-function exceptional edges; a future
  normal-edge view for layout is a separate analysis policy.
- Function parameters are parameters of the entry block. Defaultable
  non-parameter locals receive their typed zero or null definition at entry.
  Non-defaultable reference locals remain undefined until `wasmparser`'s
  definite-initialization validation proves a `local.set` or `local.tee` has
  established a definition on every path that reaches a read.
- `local.get`, `local.set`, and `local.tee` are frontend operations only. They
  read or update the current SSA definition and never survive as IR
  instructions.
- WebAssembly label arguments become explicit edge arguments. The matching
  destination block parameters represent operand-stack merges.
- A block parameter has one incoming argument on every predecessor edge, in
  the same position and with a compatible type.
- Predecessors and successors are edge occurrences, not just pairs of block
  identifiers. Conditional arms and switch cases that share a destination
  remain distinct because their arguments and path refinements may differ.
- Every IR value has one definition. Every use is dominated by its definition,
  except that a block parameter is defined at the start of its block.

## Backend boundary

The semantic CFG is the shared analysis seam for future EDGE, RISC-V, and MLIR
LLVM-dialect backends. Its block-argument form maps naturally to MLIR successor
operands and block arguments, and it retains the parallel edges needed when two
successors reach the same block with different values. RISC-V lowering can
translate the same block parameters into its later phi, copy, register, and
calling-convention machinery, while EDGE lowering can retain them as explicit
dataflow inputs.

Target selection does not change the meaning or topology of this frontend IR.
Target triples and data layouts, native pointer widths, ABI decisions, runtime
representations, target-legal scalar and vector types, and instruction costs
belong outside the semantic CFG. WebAssembly memory and table address types in
particular remain `i32` or `i64` index semantics and must not be inferred from a
RISC-V XLEN or an LLVM pointer width.

Before target emission, legalization must make WebAssembly's traps, exceptional
control, reference and GC operations, multi-value calls and returns, memories,
and tables explicit in the form required by that backend and its runtime. EDGE
block sizing, if-conversion, scheduling, and placement are also target-specific
passes. No target backend or target legalization pipeline is part of milestone
one.

## Sealed-block algorithm

For every `(local, block)` pair, the builder records the current definition.
Reading an unknown definition resolves it through predecessors with an
explicit worklist rather than recursion, so neither a long chain of
single-predecessor blocks nor a deep nest of merges can exhaust the stack:

1. In an unsealed block, create a block parameter and extend every already
   known predecessor edge with its incoming value.
2. In a sealed block with one predecessor, read the value in that predecessor.
3. In a sealed block with multiple predecessors, create the block parameter
   before reading its incoming values. This breaks cycles at loop headers.

A block is sealed only after all of its predecessors are known. Before a
terminator or an exceptional routing is installed, the builder appends
arguments for every local parameter of each of its targets, and repeats the
round while those reads add parameters to a still-unsealed target of the same
transfer (a `br_table` arm or a catch clause naming an enclosing loop header).
Consequently every installed edge is complete, and sealing only closes the
predecessor set; there is no seal-time completion step. After CFG
construction, trivial parameters whose incoming arguments are all the same
value (ignoring self references) are replaced and removed from their block and
predecessor edges by a use-list worklist in the manner of Braun et al., so the
cleanup is linear in the number of edge arguments.

Exceptional transfers participate in the same predecessor and sealing rules.
An operation whose exception can reach an in-function catch is lowered as an
`invoke` terminator. It ends its block at the precise throw point, which
freezes the local-state snapshot, and its results are the leading parameters
of its normal successor. Its ordered exceptional edges name their target
blocks directly and carry ordinary SSA values for locals plus explicit
dispatch-produced provenance for caught tag fields and exception references,
so a catch target has one complete argument list per matching throw site
without inventing definitions on the normal path. Because the results are
defined by the successor, no exceptional route, handler, or source-block use
can observe a value that does not exist when the operation throws; ordinary
dominance suffices, and the normal successor may have other predecessors,
which must supply the result parameters themselves. An operation whose
exception can only escape remains an ordinary instruction. `try_table`
regions are retained as source structure: the verifier cross-checks every
exceptional edge against the lexically visible clause, but the edges are the
control-flow authority.

Path-dependent reference types are also edge facts. `br_on_null`,
`br_on_non_null`, `br_on_cast`, and `br_on_cast_fail` pass the original SSA
reference on the applicable branch edge and record its argument slot together
with the type proven on that path in `Edge::refinements`. The destination
block parameter is the new SSA definition with that type. The fact is
self-describing, so consumers read the proven type instead of re-deriving it,
and there is deliberately no path-independent `wedge.refine_*` instruction
whose result could escape onto the wrong edge.

The verifier accepts a refined slot only on a conditional branch whose
condition is defined by a `ref.is_null` or `ref.test` of the same incoming SSA
value in any block that dominates the branch, so a predicate hoisted by a
later pass still justifies the fact. A false `ref.is_null` edge proves
non-nullness. The true and false edges of `ref.test` prove its target
reference type and the WebAssembly reference-type difference, respectively.
The predicate must have the exact Core signature and immediates, the stored
type must be implied by the predicate's outcome, and it must be a subtype of
the destination parameter. Thus a label with several predecessors can merge
independently proven references without adding trampoline blocks or
shortening the blocks exposed to later scheduling and packing passes.

Wasm's structured control flow is reducible, so trivial-parameter elimination
is sufficient for source lowering. Natural-loop analysis therefore
uses entry-reachable dominance backedges; irreducible cycles are reported as
strongly connected components rather than mislabeled as natural loops. If
later CFG transforms create irreducible control flow, a post-pass may
additionally collapse redundant strongly connected components of block
parameters.

## Operand stacks and unreachable code

The abstract operand stack is maintained per active structured control frame.
Block, loop, `if`, and `try_table` signatures determine the stack prefix at the
construct boundary and the values transferred on each edge. Polymorphic stack
behavior after a terminating operation is represented in the frontend only;
dead operators are consumed for structural matching but do not create IR.

The builder keeps all target blocks until structural parsing is complete, even
when they have no predecessors. A later reachability cleanup may discard such
blocks, but correctness must not depend on that cleanup.

The verifier deliberately gives no entry-rooted dominance relation to an
unreachable component. Values crossing a block boundary in such a component
therefore still travel through explicit edge arguments and block parameters;
one unreachable block may not directly use another block's definition.

## Scope of milestone one

SSA construction performs only the canonical cleanup needed to avoid redundant
block parameters. The general cleanup of the lowered program, constant
folding, branch resolution, jump threading, unreachable-block removal,
parameter simplification, block merging, and dead-instruction removal, is
the separate `wedge::simplify` pass over the verified IR, built on the
editing operations of `wedge::edit` and checked against the reference
interpreter. If-conversion, hyperblock formation, scheduling, and
target-specific block packing remain subsequent milestones.
