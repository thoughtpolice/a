// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public struct M { public int V; public static implicit operator int(M m) => m.V; public static explicit operator M(int v) => new M { V = v }; }
public static class P { public static int F() { M m = (M)3; int x = m; return x; } }
