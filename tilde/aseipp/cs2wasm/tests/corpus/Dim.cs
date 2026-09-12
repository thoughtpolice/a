// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public interface I { int X => 3; int Y(); int Z() => Y() * 2; }
public class C : I { public int Y() => 5; }
public class D : I { public int Y() => 1; public int Z() => 100; }
public static class P { public static int F(int x) { I i = x > 0 ? new C() : new D(); return i.X + i.Z(); } }
