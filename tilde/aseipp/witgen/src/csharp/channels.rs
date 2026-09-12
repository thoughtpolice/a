// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The component model's futures and streams (WASI 0.3's). A `future<T>`
//! or `stream<T>` crosses the boundary as a handle of its readable end,
//! which C# holds as the CoreLib's `FutureReader<T>` or `StreamReader<T>`;
//! the writable end stays with whoever made the pair. The canonical
//! built-ins that make pairs, copy values between the ends and drop them
//! are imported per type, named after a function whose signature holds the
//! type and the type's index among the futures and streams of that
//! signature (`[stream-read-0]f`); futures and streams are compared by
//! structure, so each payload type gets one ops class (a `ChannelOps<T>`
//! of those built-ins and of how a value of the payload is laid out), over
//! the built-ins of the first function that names it, and a `NewStreamT`
//! or `NewFutureT` in the world class that makes a pair. Reads, writes and
//! cancels are async-lowered: they return BLOCKED and finish at an event
//! (cancels are among Wasmtime's further async built-ins, 🚝).

use std::collections::HashMap;

use wit_parser::{Function, Type, TypeDefKind, TypeId, WorldItem};

use super::Generator;
use super::memory::{Code, Ty};
use super::tasks::has_pointers;

/// The ops class of one payload type, and the built-ins it imports.
#[derive(Clone, Debug)]
pub(crate) struct Channel {
    pub(crate) class: String,
    pub(crate) stream: bool,
    pub(crate) payload: Ty,
    payload_wit: Type,
    /// The module and name of the function whose built-ins these are, and
    /// the type's index among its futures and streams.
    module: String,
    function: String,
    index: usize,
}

/// A name for a payload type, for the ops class and the `New` method.
fn mangle(ty: &Ty, world: &str) -> String {
    let last = |path: &str| {
        path.split('<')
            .next()
            .unwrap_or(path)
            .rsplit('.')
            .next()
            .unwrap_or(path)
            .to_string()
    };
    match ty {
        Ty::Bool => "Bool".into(),
        Ty::U8 => "U8".into(),
        Ty::S8 => "S8".into(),
        Ty::U16 => "U16".into(),
        Ty::S16 => "S16".into(),
        Ty::U32 => "U32".into(),
        Ty::S32 => "S32".into(),
        Ty::U64 => "U64".into(),
        Ty::S64 => "S64".into(),
        Ty::F32 => "F32".into(),
        Ty::F64 => "F64".into(),
        Ty::Char => "Char".into(),
        Ty::String => "String".into(),
        Ty::Enum { path, .. } | Ty::Record { path, .. } => last(path),
        Ty::Handle { class, .. } => last(class),
        Ty::Tuple(items) => format!(
            "Tuple{}",
            items
                .iter()
                .map(|item| mangle(item, world))
                .collect::<String>()
        ),
        Ty::List(element) => format!("ListOf{}", mangle(element, world)),
        Ty::Option(payload) => format!("OptionOf{}", mangle(payload, world)),
        Ty::Channel {
            stream, payload, ..
        } => format!(
            "{}Of{}",
            if *stream { "Stream" } else { "Future" },
            mangle(payload, world)
        ),
        Ty::Variant { path, cases, .. } if path.starts_with(&format!("{world}.Result<")) => {
            let side = |index: usize| {
                cases[index]
                    .payload
                    .as_ref()
                    .map(|payload| mangle(payload, world))
                    .unwrap_or_else(|| "Unit".to_string())
            };
            format!("ResultOf{}And{}", side(0), side(1))
        }
        Ty::Variant { path, .. } => last(path),
    }
}

impl Generator<'_> {
    /// The functions of the world, with the module their built-ins are
    /// imported from.
    fn world_functions(&self) -> Vec<(String, Function)> {
        let resolve = self.resolve;
        let world = &resolve.worlds[self.world];
        let mut functions = Vec::new();
        for (export, items) in [(false, &world.imports), (true, &world.exports)] {
            for (key, item) in items {
                match item {
                    WorldItem::Function(function) => {
                        let module = if export { "[export]$root" } else { "$root" };
                        functions.push((module.to_string(), function.clone()));
                    }
                    WorldItem::Interface { id, .. } => {
                        let name = resolve.name_world_key(key);
                        let module = if export {
                            format!("[export]{name}")
                        } else {
                            name
                        };
                        for function in resolve.interfaces[*id].functions.values() {
                            functions.push((module.clone(), function.clone()));
                        }
                    }
                    WorldItem::Type { .. } => {}
                }
            }
        }
        functions
    }

    /// The ops class of every future and stream type the world's functions
    /// name, one per payload type.
    pub(crate) fn find_channels(&mut self) {
        let mut by_payload: HashMap<String, Channel> = HashMap::new();
        let mut order = Vec::new();
        for (module, function) in self.world_functions() {
            let found: Vec<TypeId> = function.find_futures_and_streams(self.resolve);
            for (index, id) in found.into_iter().enumerate() {
                let (stream, payload_wit) = match &self.resolve.types[id].kind {
                    TypeDefKind::Future(Some(payload)) => (false, *payload),
                    TypeDefKind::Stream(Some(payload)) => (true, *payload),
                    _ => continue,
                };
                // Inner futures and streams come first, so they have theirs.
                let Some(payload) = self.ty(&payload_wit) else {
                    continue;
                };
                let key = format!(
                    "{}<{}>",
                    if stream { "stream" } else { "future" },
                    payload.csharp(&self.world_class)
                );
                if let Some(channel) = by_payload.get(&key) {
                    self.channels.insert(id, channel.clone());
                    continue;
                }
                let kind = if stream { "Stream" } else { "Future" };
                // Payload types of one name in two interfaces get numbers.
                let base = format!("{kind}{}", mangle(&payload, &self.world_class));
                let mut name = base.clone();
                let mut number = 1;
                while order
                    .iter()
                    .any(|channel: &Channel| channel.class == format!("{name}Ops"))
                {
                    number += 1;
                    name = format!("{base}{number}");
                }
                let class = format!("{name}Ops");
                let channel = Channel {
                    class,
                    stream,
                    payload,
                    payload_wit,
                    module: module.clone(),
                    function: function.name.clone(),
                    index,
                };
                by_payload.insert(key, channel.clone());
                order.push(channel.clone());
                self.channels.insert(id, channel);
            }
        }
        self.channel_order = order;
    }

    /// Whether a future or stream of the world carries strings or lists,
    /// which the host allocates.
    pub(crate) fn channels_hold_host_memory(&self) -> bool {
        self.channel_order
            .iter()
            .any(|channel| has_pointers(&channel.payload))
    }

    /// The ops classes and `New` methods; whether there were any.
    pub(crate) fn channel_classes(&mut self) -> bool {
        let channels = self.channel_order.clone();
        let mut first = true;
        for channel in &channels {
            for ty in [&channel.payload] {
                self.need_helpers(ty);
            }
            if !first {
                self.line("");
            }
            first = false;
            self.channel_class(channel);
        }
        !first
    }

    fn channel_class(&mut self, channel: &Channel) {
        let world = self.world_class.clone();
        let payload = channel.payload.csharp(&world);
        let kind = if channel.stream { "Stream" } else { "Future" };
        let intrinsic = if channel.stream { "stream" } else { "future" };
        let class = &channel.class;
        let name = class.strip_suffix("Ops").unwrap_or(class);
        let layout = self.layout();
        let size = layout.size(&channel.payload_wit);
        let align = layout.align(&channel.payload_wit);
        let mut load = Code::default();
        let value = layout.load("address", &channel.payload_wit, &channel.payload, &mut load);
        let mut store = Code::default();
        layout.store(
            "value",
            "address",
            &channel.payload_wit,
            &channel.payload,
            &mut store,
        );
        drop(layout);

        self.line(&format!(
            "/// <summary>A new WIT <c>{intrinsic}&lt;{}&gt;</c>: both its ends.</summary>",
            payload.replace('<', "&lt;").replace('>', "&gt;")
        ));
        self.line(&format!(
            "internal static (global::Gameplay.Runtime.{kind}Reader<{payload}> Reader, global::Gameplay.Runtime.{kind}Writer<{payload}> Writer) New{name}() => global::Gameplay.Runtime.ComponentTasks.New{kind}({class}.Instance);"
        ));
        self.line("");
        self.line(&format!(
            "/// <summary>The canonical built-ins of <c>{intrinsic}</c>s of this payload, and its layout.</summary>"
        ));
        self.line("[global::Gameplay.CanonicalAbi]");
        self.open(&format!(
            "internal sealed class {class} : global::Gameplay.Runtime.ChannelOps<{payload}>"
        ));
        self.line(&format!(
            "internal static readonly {class} Instance = new {class}();"
        ));
        self.line("");
        let count = if channel.stream { ", count" } else { "" };
        self.line("public override long New() => Imports.New();");
        self.line(&format!(
            "public override int Read(int handle, int buffer, int count) => Imports.Read(handle, buffer{count});"
        ));
        self.line(&format!(
            "public override int Write(int handle, int buffer, int count) => Imports.Write(handle, buffer{count});"
        ));
        self.line("public override int CancelRead(int handle) => Imports.CancelRead(handle);");
        self.line("public override int CancelWrite(int handle) => Imports.CancelWrite(handle);");
        self.line("public override void DropReadable(int handle) => Imports.DropReadable(handle);");
        self.line("public override void DropWritable(int handle) => Imports.DropWritable(handle);");
        self.line(&format!("public override int ElementSize() => {size};"));
        self.line(&format!(
            "public override int ElementAlignment() => {align};"
        ));
        self.line(&format!(
            "public override bool HostMemory() => {};",
            has_pointers(&channel.payload)
        ));
        self.line("");
        self.open(&format!("public override {payload} Load(int address)"));
        for line in &load.lines {
            self.line(line);
        }
        self.line(&format!("return {value};"));
        self.close();
        self.line("");
        self.open(&format!(
            "public override void Store(int address, {payload} value)"
        ));
        for line in &store.lines {
            self.line(line);
        }
        self.close();
        self.line("");
        self.open("private static class Imports");
        let module = &channel.module;
        let suffix = format!("{}]{}", channel.index, channel.function);
        let buffer = if channel.stream {
            "int handle, int buffer, int count"
        } else {
            "int handle, int buffer"
        };
        for (import, declaration) in [
            (
                format!("[{intrinsic}-new-{suffix}"),
                "long New()".to_string(),
            ),
            (
                format!("[async-lower][{intrinsic}-read-{suffix}"),
                format!("int Read({buffer})"),
            ),
            (
                format!("[async-lower][{intrinsic}-write-{suffix}"),
                format!("int Write({buffer})"),
            ),
            (
                format!("[async-lower][{intrinsic}-cancel-read-{suffix}"),
                "int CancelRead(int handle)".to_string(),
            ),
            (
                format!("[async-lower][{intrinsic}-cancel-write-{suffix}"),
                "int CancelWrite(int handle)".to_string(),
            ),
            (
                format!("[{intrinsic}-drop-readable-{suffix}"),
                "void DropReadable(int handle)".to_string(),
            ),
            (
                format!("[{intrinsic}-drop-writable-{suffix}"),
                "void DropWritable(int handle)".to_string(),
            ),
        ] {
            self.line(&format!(
                "[global::Gameplay.WasmImport(\"{module}\", \"{import}\")]"
            ));
            self.line(&format!("internal static extern {declaration};"));
        }
        self.close();
        self.close();
    }
}
