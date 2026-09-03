
## How it links

1. **Decode** (`component.rs`). Each component becomes its list of
   definitions: core modules and instances, nested components and instances,
   aliases, `canon lift`/`lower`, imports and exports. Types are resolved
   through wasmparser's validator into a small interface-type model
   (`types.rs`).
2. **Plan** (`plan.rs`). The definitions are interpreted with a frame per
   component instantiation, exactly as a runtime would instantiate them, but
   producing a plan instead of running anything: a list of core module
   instances in instantiation order with every import resolved, one adapter
   per `lower` of a `lift`, the lowered imports nothing provides, and the
   package's exports: those of the components nothing draws from, plus the
   bare function exports of the others that no component imports, so a
   platform's own entry points stay reachable from the host. Top-level
   components plug into each other by interface name, so a `wac`
   composition step is not needed, though a composed component links just
   the same.
   Each component instantiation is a frame, the owner of a handle table;
   resource types are created as the frames defining them are instantiated,
   bound through type imports, exports, and aliases, and named by index in
   every function type the plan records.
3. **Adapt** (`adapter.rs`). Each adapter converts between the caller's and
   the callee's canonical ABI by walking the value types: strings and lists
   are copied into the callee's memory through its `realloc`, handles move
   from the caller's table to the callee's, results are converted back
   through the caller's, spilled parameter lists and results go through
   memory as the ABI specifies, and `post-return` is honoured. Functions
   whose values never touch memory or a table bind straight to the callee.
   The same walk wraps host imports and exports that carry handles, so the
   host only ever sees representations: handles in the component's memory
   are rewritten there in place, and a borrow lent to the host that way is
   remembered on a lender chain in the handle table and put back when the
   host returns.
4. **Merge** (`merge.rs`). Every instance's definitions are renumbered into
   the output with `wasm-encoder`'s reencoder, multiple memories included.
   Unsatisfied imports are exported in their lowered (flat) form and reached
   through trampolines, each component's memory is exported as
   `<component>:memory`, and a synthesized start runs every instance's start
   in order. When handles are in play, `handles.rs` contributes one table in
   a memory of its own, its maintenance functions, and the `resource.new`,
   `resource.rep`, and `resource.drop` built-ins.

## How it is tested

`buck2 test tilde//aseipp/wlink/...` runs the structural link tests over the
text fixtures, the behaviour tests that execute every linked set in WABT's
interpreter, the wasm2c host ABI test, and the Hegel properties in
`src/tests/layout_property_tests.rs`, which draw value types and check the
canonical ABI layout functions of `types.rs` for sizes, alignments, flat
types, containment, and signature spilling against the ABI as written.
`:fuzz-seeds` packs every linked set into one text file, the components
separated by `(;wlink-fuzz-split;)`, so a consumer's fuzz harness can start
from packages that link and hold whatever the linker emits to its own
contract.
