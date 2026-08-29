// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Modules drawn from bytes with wasm-smith, in the language Wedge accepts.

use arbitrary::Unstructured;
use wasm_smith::{Config, Module};

/// wasm-smith's configuration for the standard Core 3.0 profile Wedge
/// accepts: every proposal in [`wedge::STANDARD_WASM_3_FEATURES`] on, every
/// later proposal off, several memories and tables so multi-memory code
/// appears, custom sections so the name section decoder sees input, and
/// bodies long enough to nest control flow.
pub fn config() -> Config {
    let mut config = Config::default();
    config.threads_enabled = false;
    config.shared_everything_threads_enabled = false;
    config.custom_descriptors_enabled = false;
    config.wide_arithmetic_enabled = false;
    config.custom_page_sizes_enabled = false;
    config.compact_imports_enabled = false;
    config.max_memories = 4;
    config.max_tables = 4;
    config.max_instructions = 500;
    config.generate_custom_sections = true;
    config
}

/// The module `data` encodes under [`config`], or `None` when wasm-smith
/// cannot draw one from it.
pub fn module(data: &[u8]) -> Option<Vec<u8>> {
    draw(config(), data)
}

/// [`config`] narrowed to modules whose execution can be compared with
/// WABT's interpreter: no imports, every function exported, NaNs
/// canonicalized so float results are reproducible, no relaxed SIMD (the
/// results are implementation-defined), no garbage collection or typed
/// function references (WABT does not implement them), and memories and
/// tables with small declared maxima so growth fails identically. A few
/// functions are always present, since wasm-smith otherwise leaves most
/// byte strings with nothing to run.
pub fn executable_config() -> Config {
    let mut config = config();
    config.max_imports = 0;
    config.min_imports = 0;
    config.min_types = 2;
    config.min_funcs = 4;
    config.export_everything = true;
    config.canonicalize_nans = true;
    config.relaxed_simd_enabled = false;
    config.gc_enabled = false;
    config.memory_max_size_required = true;
    config.max_memory32_bytes = 1 << 20;
    config.max_memory64_bytes = 1 << 20;
    config.table_max_size_required = true;
    config.max_table_elements = 1024;
    config
}

/// The module `data` encodes under [`executable_config`].
pub fn executable_module(data: &[u8]) -> Option<Vec<u8>> {
    draw(executable_config(), data)
}

/// `module` as WebAssembly text, for a diagnostic.
pub fn text(module: &[u8]) -> String {
    wasmprinter::print_bytes(module)
        .unwrap_or_else(|error| format!("<module does not print: {error}>"))
}

fn draw(config: Config, data: &[u8]) -> Option<Vec<u8>> {
    let mut unstructured = Unstructured::new(data);
    Module::new(config, &mut unstructured)
        .ok()
        .map(|module| module.to_bytes())
}
