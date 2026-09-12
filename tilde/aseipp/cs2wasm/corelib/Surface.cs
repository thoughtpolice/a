// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Runtime
{
    // Marks a type of the framework surface (corelib/generator): .NET's
    // declaration of it, with extern members the importer implements, as
    // opposed to a type CoreLib's sources define. A partial declaration in
    // the sources that gives some of its static members bodies marks it
    // itself, where it stays .NET's (the module layer's primitive types).
    [System.AttributeUsage(
        System.AttributeTargets.Class | System.AttributeTargets.Struct | System.AttributeTargets.Interface
            | System.AttributeTargets.Enum | System.AttributeTargets.Delegate,
        Inherited = false)]
    internal sealed class SurfaceAttribute : System.Attribute
    {
    }
}
