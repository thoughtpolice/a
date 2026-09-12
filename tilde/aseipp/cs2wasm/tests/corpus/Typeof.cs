// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class A {} public class B : A {}
public static class P { public static int F(int x) { A a = x > 0 ? new B() : new A(); return (a.GetType() == typeof(B) ? 1 : 0) + (typeof(int) == typeof(int) ? 2 : 0) + a.GetType().Name.Length * 10 + typeof(List<int>).Name.Length * 100; } }
