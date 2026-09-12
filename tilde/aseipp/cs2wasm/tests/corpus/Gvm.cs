// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class A { public virtual T Id<T>(T x) => x; }
public class B : A { public override T Id<T>(T x) => x; }
public static class P { public static int F(int x) { A a = x > 0 ? new B() : new A(); return a.Id(x) + a.Id("ab").Length; } }
