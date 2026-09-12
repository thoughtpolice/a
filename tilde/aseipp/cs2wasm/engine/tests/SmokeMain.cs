// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

internal abstract partial class App
{
    public static partial App Create() => new Kiln.Smoke.Smoker();
}
