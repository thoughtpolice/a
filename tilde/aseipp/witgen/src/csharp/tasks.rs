// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The component model's async functions, through its callback ABI (WASI
//! 0.3's). An async import becomes a wrapper returning a `Task` or
//! `Task<T>`: it lowers the arguments as a synchronous import's glue does
//! (at most four flat values, else a pointer to them), passes an area for
//! the result, which outlives the call, and calls the `[async-lower]`
//! function, whose status says whether the host has already returned; the
//! gameplay CoreLib's `ComponentTasks` makes the task of it and completes
//! it when the subtask's event comes. An async export is a partial method
//! returning a `Task` or `Task<T>`, lifted with a callback: the
//! `[async-lift]` export starts a component task and the method, the
//! `[callback]` export takes the events it waits for, and the method's
//! result goes to the host through `[task-return]`. Async methods and
//! statics of imported resources are the same wrappers, a method's
//! receiver its first argument, and so are those of exported resources,
//! partial members of their class (see `exported_resource`). An async
//! import whose result holds strings
//! or lists has the host allocate them when the subtask returns, outside
//! any call of the module, where the boundary memory's arena would reuse
//! them: while it is pending, the CoreLib holds what the host allocates
//! (`cabi_realloc` puts it below the arena's floor), and in such a world
//! every lift frees what it reads of the host's memory
//! (`ComponentTasks.Consumed`).

use wit_parser::abi::{AbiVariant, WasmType};
use wit_parser::{Function, FunctionKind, Resolve, Type, WorldItem};

use super::memory::{Code, Ty, receiver_pointer, wasm_csharp};
use super::{Generator, names};

const TASKS: &str = "global::Gameplay.Runtime.ComponentTasks";
const CANONICAL: &str = "global::Gameplay.Runtime.Canonical";
const TASK: &str = "global::System.Threading.Tasks.Task";

/// Whether a function is an async one.
pub(crate) fn is_async(function: &Function) -> bool {
    matches!(
        function.kind,
        FunctionKind::AsyncFreestanding
            | FunctionKind::AsyncMethod(_)
            | FunctionKind::AsyncStatic(_)
    )
}

/// Whether lifting a value reads memory the host allocated: strings and
/// lists, wherever they are.
pub(crate) fn has_pointers(ty: &Ty) -> bool {
    match ty {
        Ty::String | Ty::List(_) => true,
        Ty::Record { fields, .. } => fields.iter().any(|(_, field)| has_pointers(field)),
        Ty::Tuple(items) => items.iter().any(has_pointers),
        Ty::Option(payload) => has_pointers(payload),
        Ty::Variant { cases, .. } => cases
            .iter()
            .any(|case| case.payload.as_ref().is_some_and(has_pointers)),
        _ => false,
    }
}

impl Generator<'_> {
    /// The glue's view of an async function, or None when it cannot be
    /// generated (see the module's documentation).
    fn async_types(&self, function: &Function, import: bool) -> Option<(Vec<Ty>, Option<Ty>)> {
        match function.kind {
            FunctionKind::AsyncFreestanding => {}
            // Of a resource: the class the wrapper or partial member is a
            // member of, an imported resource's for an import, an exported
            // one's for an export.
            FunctionKind::AsyncMethod(resource) | FunctionKind::AsyncStatic(resource) => {
                match self.resolve.types[self.dealias(resource)].owner {
                    wit_parser::TypeOwner::Interface(owner)
                        if self.exported.contains(&owner) != import => {}
                    _ => return None,
                }
            }
            _ => return None,
        }
        let mut params = Vec::new();
        for param in &function.params {
            params.push(self.ty(&param.ty)?);
        }
        let result = match &function.result {
            Some(ty) => Some(self.ty(ty)?),
            None => None,
        };
        let mut arities = Vec::new();
        for ty in params.iter().chain(&result) {
            ty.tuple_arities(&mut arities);
        }
        if arities.iter().any(|arity| *arity > 8) {
            return None;
        }
        if import && params.iter().chain(&result).any(Ty::has_exported_handle) {
            return None;
        }
        Some((params, result))
    }

    /// Whether an async function gets generated, as an import or export.
    pub(crate) fn has_async(&self, function: &Function, import: bool) -> bool {
        self.async_types(function, import).is_some()
    }

    /// Whether the host may allocate what the glue lifts while the CoreLib
    /// holds it: an async import whose result holds strings or lists.
    pub(crate) fn holds_host_memory(&self) -> bool {
        let world = &self.resolve.worlds[self.world];
        let mut functions: Vec<&Function> = Vec::new();
        for item in world.imports.values() {
            match item {
                WorldItem::Function(function) => functions.push(function),
                WorldItem::Interface { id, .. } if !self.exported.contains(id) => {
                    functions.extend(self.resolve.interfaces[*id].functions.values());
                }
                _ => {}
            }
        }
        functions.into_iter().any(|function| {
            is_async(function)
                && self
                    .async_types(function, true)
                    .is_some_and(|(_, result)| result.as_ref().is_some_and(has_pointers))
        })
    }

    fn task_type(&self, result: Option<&Ty>) -> String {
        match result {
            Some(ty) => format!("{TASK}<{}>", ty.csharp(&self.world_class)),
            None => TASK.to_string(),
        }
    }

    fn typed_params(&self, function: &Function, params: &[Ty], skip: usize) -> String {
        function
            .params
            .iter()
            .zip(params)
            .skip(skip)
            .map(|(param, ty)| {
                format!(
                    "{} {}",
                    ty.csharp(&self.world_class),
                    names::camel(&param.name)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The flat parameters an async function's core signature takes, as
    /// the glue lowers them: the pointer to them all when they do not fit.
    fn check_async_signature(
        &self,
        function: &Function,
        params: &[Ty],
        variant: AbiVariant,
    ) -> wit_parser::abi::WasmSignature {
        let signature = self.resolve.wasm_signature(variant, function);
        let mut expected = if signature.indirect_params {
            vec![WasmType::Pointer]
        } else {
            let mut flat = Vec::new();
            for param in params {
                param.flat(&mut flat);
            }
            receiver_pointer(
                function,
                matches!(variant, AbiVariant::GuestImportAsync),
                &mut flat,
            );
            flat
        };
        if matches!(variant, AbiVariant::GuestImportAsync) && function.result.is_some() {
            expected.push(WasmType::Pointer);
        }
        if expected != signature.params || signature.results != [WasmType::I32] {
            panic!(
                "witgen lowered async {} as {:?} -> i32, but the canonical ABI says {:?} -> {:?}",
                function.name, expected, signature.params, signature.results
            );
        }
        signature
    }

    /// The `[async-lower]` extern of an async import; whether there is one.
    pub(crate) fn async_extern(&mut self, module: &str, function: &Function) -> bool {
        let Some((params, _)) = self.async_types(function, true) else {
            return false;
        };
        let signature = self.check_async_signature(function, &params, AbiVariant::GuestImportAsync);
        let parameters: Vec<String> = signature
            .params
            .iter()
            .enumerate()
            .map(|(index, ty)| format!("{} in_{index}", wasm_csharp(*ty)))
            .collect();
        self.line(&format!(
            "[global::Gameplay.WasmImport(\"{module}\", \"[async-lower]{}\")]",
            function.name
        ));
        self.line(&format!(
            "internal static extern int {}({});",
            self.extern_name(function),
            parameters.join(", ")
        ));
        true
    }

    /// An async import's wrapper, and the function that reads its result
    /// from the result's area; whether they were generated.
    pub(crate) fn import_async(&mut self, function: &Function) -> bool {
        let Some((params, result)) = self.async_types(function, true) else {
            return false;
        };
        for ty in params.iter().chain(&result) {
            self.need_helpers(ty);
        }
        let signature = self.check_async_signature(function, &params, AbiVariant::GuestImportAsync);
        let layout = self.layout();
        let name = self.member_name(function);
        let mut code = Code::default();

        // The result's area first: it outlives the arguments, which the
        // arena frees once the subtask has started.
        let wit_result = function.result;
        let area = wit_result.map(|wit| {
            let area = code.temp("result");
            code.line(format!(
                "int {area} = {TASKS}.ResultArea({}, {});",
                layout.size(&wit),
                layout.align(&wit)
            ));
            area
        });
        let mark = code.temp("mark");
        code.line(format!("int {mark} = {CANONICAL}.Mark();"));
        let mut arguments = Vec::new();
        // A method's receiver is the object it is called on.
        let method = matches!(function.kind, FunctionKind::AsyncMethod(_));
        if signature.indirect_params {
            let types: Vec<Type> = function.params.iter().map(|param| param.ty).collect();
            let info = layout.sizes.record(types.iter());
            let block = code.temp("params");
            code.line(format!(
                "int {block} = {CANONICAL}.Allocate({}, {});",
                info.size.size_wasm32(),
                info.align.align_wasm32()
            ));
            for (index, ((param, ty), offset)) in function
                .params
                .iter()
                .zip(&params)
                .zip(layout.offsets(&types))
                .enumerate()
            {
                let expression = if index == 0 && method {
                    "this".to_string()
                } else {
                    names::camel(&param.name)
                };
                layout.store(
                    &expression,
                    &format!("{block} + {offset}"),
                    &param.ty,
                    ty,
                    &mut code,
                );
            }
            arguments.push(block);
        } else {
            for (index, (param, ty)) in function.params.iter().zip(&params).enumerate() {
                let expression = if index == 0 && method {
                    "this".to_string()
                } else {
                    names::camel(&param.name)
                };
                layout.lower_flat(&expression, &param.ty, ty, &mut code, &mut arguments);
            }
        }
        arguments.extend(area.clone());
        let status = code.temp("status");
        code.line(format!(
            "int {status} = {};",
            self.extern_call(function, &arguments)
        ));
        let lift = format!("{name}Result_");
        match (&result, &area) {
            (Some(ty), Some(area)) if has_pointers(ty) => code.line(format!(
                "return {TASKS}.Lowered<{}>({status}, {mark}, {area}, {lift}, true);",
                ty.csharp(&self.world_class)
            )),
            (Some(ty), Some(area)) => code.line(format!(
                "return {TASKS}.Lowered<{}>({status}, {mark}, {area}, {lift});",
                ty.csharp(&self.world_class)
            )),
            _ => code.line(format!("return {TASKS}.Lowered({status}, {mark});")),
        }

        // The result, read from its area once the subtask has returned.
        let lifted = match (&result, wit_result) {
            (Some(ty), Some(wit)) => {
                let mut code = Code::default();
                let value = layout.load("area", &wit, ty, &mut code);
                Some((code.lines, value))
            }
            _ => None,
        };
        drop(layout);

        self.docs(&function.docs);
        self.line("[global::Gameplay.CanonicalAbi]");
        // Static wrappers are internal, as synchronous ones are.
        let (modifier, skip) = if method {
            ("public", 1)
        } else {
            ("internal static", 0)
        };
        self.open(&format!(
            "{modifier} {} {name}({})",
            self.task_type(result.as_ref()),
            self.typed_params(function, &params, skip)
        ));
        for line in &code.lines {
            self.line(line);
        }
        self.close();

        if let (Some(ty), Some((lines, value))) = (&result, lifted) {
            self.line("");
            self.line("[global::Gameplay.CanonicalAbi]");
            self.open(&format!(
                "private static {} {lift}(int area)",
                ty.csharp(&self.world_class)
            ));
            for line in &lines {
                self.line(line);
            }
            self.line(&format!("return {value};"));
            self.close();
        }
        true
    }

    /// An async export: the partial method the module implements, the
    /// `[async-lift]` export that starts it, its `[callback]`, and the
    /// `[task-return]` import its result goes to the host through; whether
    /// they were generated.
    pub(crate) fn export_async(&mut self, module: Option<&str>, function: &Function) -> bool {
        let Some((params, result)) = self.async_types(function, false) else {
            return false;
        };
        for ty in params.iter().chain(&result) {
            self.need_helpers(ty);
        }
        let signature = self.check_async_signature(function, &params, AbiVariant::GuestExportAsync);
        let layout = self.layout();
        let world = self.world_class.clone();
        let name = self.glue_name(function);
        let export_name = match module {
            Some(module) => format!("{module}#{}", function.name),
            None => function.name.clone(),
        };
        let return_module = format!("[export]{}", module.unwrap_or("$root"));

        // The export: the arguments, lifted as a synchronous export's are,
        // then the method's task, which the component task runs.
        let mut code = Code::default();
        code.line(format!("{TASKS}.Begin();"));
        let mut arguments = Vec::new();
        if signature.indirect_params {
            let types: Vec<Type> = function.params.iter().map(|param| param.ty).collect();
            for ((param, ty), offset) in function
                .params
                .iter()
                .zip(&params)
                .zip(layout.offsets(&types))
            {
                let value = layout.load(&format!("in_0 + {offset}"), &param.ty, ty, &mut code);
                let local = code.temp("argument");
                code.line(format!("{} {local} = {value};", ty.csharp(&world)));
                arguments.push(local);
            }
            layout.consume_parameters(&mut code);
        } else {
            let mut values = (0..signature.params.len()).map(|index| format!("in_{index}"));
            for (param, ty) in function.params.iter().zip(&params) {
                let value = layout.lift_flat(&mut values, &param.ty, ty, &mut code);
                let local = code.temp("argument");
                code.line(format!("{} {local} = {value};", ty.csharp(&world)));
                arguments.push(local);
            }
        }
        let returner = format!("{name}Return_");
        let started = match &result {
            Some(ty) => format!("Started<{}>", ty.csharp(&world)),
            None => "Started".to_string(),
        };
        code.line(format!(
            "return {TASKS}.{started}({}, {returner});",
            self.implementation_call(function, &arguments)
        ));
        let flat: Vec<String> = signature
            .params
            .iter()
            .enumerate()
            .map(|(index, ty)| format!("{} in_{index}", wasm_csharp(*ty)))
            .collect();

        // task.return takes the result as parameters: flat, or a pointer
        // to it past sixteen of them.
        let mut returned = Code::default();
        let mut return_arguments = Vec::new();
        let mut return_params = Vec::new();
        if let (Some(ty), Some(wit)) = (&result, function.result) {
            let mut flat_result = Vec::new();
            ty.flat(&mut flat_result);
            if flat_result.len() > Resolve::MAX_FLAT_PARAMS {
                let block = returned.temp("result");
                returned.line(format!(
                    "int {block} = {CANONICAL}.Allocate({}, {});",
                    layout.size(&wit),
                    layout.align(&wit)
                ));
                layout.store("value", &block, &wit, ty, &mut returned);
                return_arguments.push(block);
                return_params.push("int in_0".to_string());
            } else {
                layout.lower_flat("value", &wit, ty, &mut returned, &mut return_arguments);
                return_params.extend(
                    flat_result
                        .iter()
                        .enumerate()
                        .map(|(index, ty)| format!("{} in_{index}", wasm_csharp(*ty))),
                );
            }
        }
        let task_return = format!("{name}TaskReturn_");
        returned.line(format!("{task_return}({});", return_arguments.join(", ")));

        self.docs(&function.docs);
        let typed: Vec<String> = function
            .params
            .iter()
            .zip(&params)
            .map(|(param, ty)| format!("{} {}", ty.csharp(&world), names::camel(&param.name)))
            .collect();
        self.line(&self.implementation(function, &self.task_type(result.as_ref()), &typed));
        self.line("");
        self.line(&format!(
            "[global::Gameplay.WasmExport(\"[async-lift]{export_name}\")]"
        ));
        self.line("[global::Gameplay.CanonicalAbi]");
        self.open(&format!(
            "public static int {name}Lift_({})",
            flat.join(", ")
        ));
        for line in &code.lines {
            self.line(line);
        }
        self.close();
        self.line("");
        self.line(&format!(
            "[global::Gameplay.WasmExport(\"[callback][async-lift]{export_name}\")]"
        ));
        self.line(&format!(
            "public static int {name}Callback_(int event_, int waitable_, int code_) => {TASKS}.Callback(event_, waitable_, code_);"
        ));
        self.line("");
        self.line("[global::Gameplay.CanonicalAbi]");
        let value_param = result
            .as_ref()
            .map(|ty| format!("{} value", ty.csharp(&world)))
            .unwrap_or_default();
        self.open(&format!("private static void {returner}({value_param})"));
        for line in &returned.lines {
            self.line(line);
        }
        self.close();
        self.line("");
        self.line(&format!(
            "[global::Gameplay.WasmImport(\"{return_module}\", \"[task-return]{}\")]",
            function.name
        ));
        self.line(&format!(
            "private static extern void {task_return}({});",
            return_params.join(", ")
        ));
        true
    }
}
