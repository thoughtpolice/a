// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::cell::RefCell;

use clap::Parser;

use starlark::{
    any::AnyLifetime,
    environment::{FrozenModule, Globals, GlobalsBuilder, LibraryExtension, Module},
    eval::{Evaluator, ReturnFileLoader},
    starlark_module,
    syntax::{AstModule, Dialect},
    values::{none::NoneType, Value},
};
use starlark_derive::ProvidesStaticType;

// ---------------------------------------------------------------------------------------------------------------------
// MARK: Entry point

#[derive(clap::Parser, Clone, Debug)]
#[command(name = "qlark", about = "TODO FIXME")]
pub(crate) struct Cli {
    /// The Starlark `.star` file to execute.
    #[arg(long)]
    file: Option<String>,
}

fn main() {
    let cli = Cli::parse();

    let (filename, code) = if let Some(file) = cli.file {
        (file.clone(), std::fs::read_to_string(&file).unwrap())
    } else {
        ("<example>".to_owned(), r#"print("hello world")"#.to_owned())
    };

    let get_source_fn = |file: String| match file {
        x if x == filename => Ok(code.clone()),
        x => Err(anyhow::anyhow!("unknown file: {}", x)),
    };

    let store = Store::default();
    let star = Slark::new(store);
    let globals = star.globals().with(install_globals).build();
    star.eval_module_recursive(&globals, &filename, &get_source_fn)
        .unwrap();
    let res = star.store();
    println!("{:?}", res);
}

// ---------------------------------------------------------------------------------------------------------------------
// MARK: Starlark API

#[derive(ProvidesStaticType, Clone, Debug, Default)]
struct Store(RefCell<Vec<String>>);

impl Store {
    fn add(&self, x: String) {
        self.0.borrow_mut().push(x)
    }
}

/// Install custom functions into the Starlark environment.
#[starlark_module]
fn install_globals(builder: &mut GlobalsBuilder) {
    fn emit_json(x: Value, eval: &mut Evaluator) -> anyhow::Result<NoneType> {
        // We modify extra (which we know is a Store) and add the JSON of the
        // value the user gave.
        eval.extra
            .unwrap()
            .downcast_ref::<Store>()
            .unwrap()
            .add(x.to_json()?);
        Ok(NoneType)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// MARK: Starlark API Wrapper

/// A convenient wrapper around the [`starlark`] API. This largely handles
/// dialect settings consistency and module loading. Parameterized by a store
/// type, which is used to track side-effects.
struct Slark<S> {
    dialect: Dialect,
    store: S,
}

impl<S: for<'a> AnyLifetime<'a>> Slark<S> {
    /// Create a new instance of the Starlark interpreter. This comes loaded
    /// with several extensions to the default dialect, and whatever store you
    /// want to use that is exposed to your functions.
    fn new(store: S) -> Self {
        let dialect = Dialect {
            enable_f_strings: true,
            ..Dialect::Extended
        };

        Slark { dialect, store }
    }

    /// Create a new [`GlobalsBuilder`] with our own customizations, and all the
    /// standard Starlark library extensions pre-installed.
    fn globals(&self) -> GlobalsBuilder {
        // NOTE: duplicate of private version in [`LibraryExtensions`]. goto def ->
        // copy/paste if needed.
        fn all_starlark_library_extensions() -> &'static [LibraryExtension] {
            use LibraryExtension::*;
            &[
                StructType, RecordType, EnumType, Map, Filter, Partial, Debug, Print, Pprint,
                Breakpoint, Json, Typing, Internal, CallStack,
            ]
        }
        GlobalsBuilder::extended_by(all_starlark_library_extensions())
    }

    /// Acquire a reference to the store. This is mostly useful after evaluating
    /// some root module, and you want to inspect the side-effects of the
    /// Starlark code.
    fn store(&self) -> &S {
        &self.store
    }

    /// Evaluate a module recursively, loading all dependencies specified by
    /// `load()` statements as needed.
    fn eval_module_recursive(
        &self,
        globals: &Globals,
        file: &str,
        get_source: &dyn Fn(String) -> anyhow::Result<String>,
    ) -> anyhow::Result<FrozenModule> {
        let src = get_source(file.to_owned())?;
        let ast = AstModule::parse(file, src.to_owned(), &self.dialect).unwrap();

        // We can get the loaded modules from `ast.loads`.
        // And ultimately produce a `loader` capable of giving those modules to Starlark.
        let mut loads = Vec::new();
        for load in ast.loads() {
            loads.push((
                load.module_id.to_owned(),
                self.eval_module_recursive(globals, load.module_id, get_source)?,
            ));
        }
        let modules = loads.iter().map(|(a, b)| (a.as_str(), b)).collect();
        let loader = ReturnFileLoader { modules: &modules };

        let module = Module::new();
        {
            let mut eval = Evaluator::new(&module);
            eval.extra = Some(&self.store);
            eval.set_loader(&loader);
            eval.eval_module(ast, globals).unwrap();
        }

        // After creating a module we freeze it, preventing further mutation.
        // It can now be used as the input for other Starlark modules.
        Ok(module.freeze()?)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// MARK: Tests

#[cfg(test)]
mod tests {
    use crate::Slark;

    #[test]
    fn test_emit_json() {
        let get_source_fn = |file: String| match file.as_str() {
            "<example>" => Ok(r#"
emit_json(1)
emit_json(["test"])
emit_json({"x": "y"})
        "#
            .to_owned()),
            x => Err(anyhow::anyhow!("unknown file: {}", x)),
        };

        let store = crate::Store::default();
        let star = Slark::new(store);
        let globals = star.globals().with(crate::install_globals).build();

        star.eval_module_recursive(&globals, "<example>", &get_source_fn)
            .unwrap();
        let res = star.store();
        insta::assert_snapshot!(format!("{:?}", res), @r###"Store(RefCell { value: ["1", "[\"test\"]", "{\"x\":\"y\"}"] })"###);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
