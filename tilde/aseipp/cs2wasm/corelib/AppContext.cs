// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// AppContext's switches, as the imported framework assemblies read their
// feature switches' defaults: a module has no runtimeconfig.json, so no
// switch is set and no data is there. (The importer folds the switches the
// framework defines where code tests them; see Il.Folding.)

namespace System
{
    public static class AppContext
    {
        public static bool TryGetSwitch(string switchName, out bool isEnabled)
        {
            ArgumentException.ThrowIfNullOrEmpty(switchName);
            isEnabled = false;
            return false;
        }

        public static object? GetData(string name)
        {
            ArgumentNullException.ThrowIfNull(name);
            return null;
        }
    }
}
