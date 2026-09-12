// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { int[] a = {1,2}; public ref int At(int i) => ref a[i]; public int Get(int i) => a[i]; }
public static class P { public static int F(int x) { var c = new C(); c.At(1) = x; c.At(0)++; return c.Get(1) + c.Get(0); } }
