// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The declarations gameplayc binds gameplay code against. The compiler
// supplies this file itself and never emits these types into a module. Add
// it to an ordinary .NET project to edit gameplay code with IDE support; when
// it is among the sources handed to gameplayc, the compiler uses that copy.
namespace Gameplay
{
    /// <summary>
    /// Declares a typed host capability: the static extern method becomes a
    /// Wasm function import named <c>module</c>/<c>name</c>. Parameters and
    /// the result are scalars (integers of any width, bool, char, enums,
    /// float, double); host objects are passed as integer handles.
    /// </summary>
    [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
    public sealed class WasmImportAttribute : System.Attribute
    {
        public WasmImportAttribute(string module, string name)
        {
            Module = module;
            Name = name;
        }

        public string Module { get; }

        public string Name { get; }
    }

    /// <summary>
    /// Exports a static method with a scalar signature under this name rather
    /// than the default <c>Namespace.Class.Method</c>; WIT worlds name their
    /// exports this way (<c>frame</c>, <c>ns:pkg/iface@1.0.0#run</c>).
    /// </summary>
    [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
    public sealed class WasmExportAttribute : System.Attribute
    {
        public WasmExportAttribute(string name)
        {
            Name = name;
        }

        public string Name { get; }
    }
}
