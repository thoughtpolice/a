// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public struct S { public int N; public IEnumerable<int> Gen() { for (int i = 0; i < N; i++) yield return i; } }
public static class P { public static int F(int x) { int s = 0; foreach (var v in new S { N = x }.Gen()) s += v; return s; } }
