// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { int[] a = new int[4]; public int this[int i] { get => a[i]; set => a[i] = value; } }
public static class P { public static int F() { var c = new C(); c[2] = 3; return c[2]; } }
