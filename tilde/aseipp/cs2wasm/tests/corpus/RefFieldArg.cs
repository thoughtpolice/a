// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public int V; public static int S; }
public static class P { static void Inc(ref int v) => v++; public static int F(int x) { var c = new C(); Inc(ref c.V); Inc(ref C.S); int[] a = new int[2]; Inc(ref a[1]); return c.V + C.S + a[1]; } }
