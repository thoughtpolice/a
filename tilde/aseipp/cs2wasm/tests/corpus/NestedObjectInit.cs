// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class Pt { public int X, Y; }
public class C { public Pt P = new Pt(); }
public static class P { public static int F(int x) { var c = new C { P = { X = x, Y = 2 } }; return c.P.X + c.P.Y; } }
