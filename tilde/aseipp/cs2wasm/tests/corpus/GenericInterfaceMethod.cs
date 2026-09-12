// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public interface I { T Pick<T>(T a, T b); }
public class C : I { public T Pick<T>(T a, T b) => b; }
public static class P { public static int F(int x) { I i = new C(); return i.Pick(1, x) + i.Pick("a", "bc").Length; } }
