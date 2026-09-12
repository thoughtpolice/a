// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { static int C<T>(params T[] xs) => xs.Length; public static int F() => C(1, 2, 3); }
