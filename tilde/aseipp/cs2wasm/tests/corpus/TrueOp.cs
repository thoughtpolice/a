// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public struct B { public bool V; public static bool operator true(B b) => b.V; public static bool operator false(B b) => !b.V; public static B operator &(B a, B b) => new B { V = a.V & b.V }; public static B operator |(B a, B b) => new B { V = a.V | b.V }; }
public static class P { public static int F(int x) { var a = new B { V = x > 0 }; var b = new B { V = x > 1 }; return ((a && b) ? 1 : 0) + ((a || b) ? 2 : 0) + (a ? 4 : 0); } }
