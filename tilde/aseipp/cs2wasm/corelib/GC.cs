// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The GC members the imported framework assemblies call: allocation of
// arrays whose elements the caller writes before reading (every array here
// starts zeroed; nothing is pinned) and KeepAlive, which the Wasm
// engine's collector makes nothing to do. The rest of .NET's GC stays out
// of the surface (corelib/surface.txt).

namespace System
{
    public static class GC
    {
        public static T[] AllocateUninitializedArray<T>(int length, bool pinned = false) => new T[length];

        public static T[] AllocateArray<T>(int length, bool pinned = false) => new T[length];

        public static void KeepAlive(object? obj)
        {
        }
    }
}
