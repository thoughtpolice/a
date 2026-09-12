// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What delegates converted by variance need (see
// Frontend.DelegateVariance): combining or removing delegates of two types
// throws, as the CLR's Delegate.Combine and Remove do.

namespace Gameplay.Runtime
{
    internal static class DelegateChecks
    {
        internal static void TypeMismatch() => throw new System.ArgumentException(System.SR.Arg_DlgtTypeMis);
    }
}
