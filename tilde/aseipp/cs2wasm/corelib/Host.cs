// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The host services the CoreLib imports, only where code uses them (see
// docs/IMPORTER.md): the wall clock (DateTime.UtcNow and Now), a monotonic
// clock (Stopwatch) and randomness (Guid.NewGuid). A module that imports one
// is instantiated with the `gameplay` module's functions of these names.

namespace Gameplay.Runtime
{
    // The CoreLib's WasmImport: the importer treats it as the SDK's.
    [System.AttributeUsage(System.AttributeTargets.Method, AllowMultiple = false)]
    internal sealed class HostImportAttribute : System.Attribute
    {
        public HostImportAttribute(string module, string name)
        {
            Module = module;
            Name = name;
        }

        public string Module { get; }

        public string Name { get; }
    }

    internal static class Host
    {
        // Microseconds since 1970-01-01T00:00:00Z.
        [HostImport("gameplay", "clock-utc")]
        public static extern long ClockUtc();

        // Nanoseconds since an origin of the host's.
        [HostImport("gameplay", "clock-monotonic")]
        public static extern long ClockMonotonic();

        // 64 random bits.
        [HostImport("gameplay", "random")]
        public static extern long Random();
    }
}
