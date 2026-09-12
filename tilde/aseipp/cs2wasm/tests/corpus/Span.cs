// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { int[] a = {1,2,3}; Span<int> s = a; s[0] = x; ReadOnlySpan<int> r = a.AsSpan(1); return a[0] + s.Length + r[0]; } }
