// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { Span<int> s = stackalloc int[4]; s[1] = x; return s[1] + s.Length; } }
