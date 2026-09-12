// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class A { public virtual A Me() => this; public virtual int K => 1; }
public class B : A { public int X = 4; public override B Me() => this; public override int K => 2; }
public static class P { public static int F(int x) { A a = x > 0 ? new B() : new A(); return new B().Me().X + a.Me().K; } }
