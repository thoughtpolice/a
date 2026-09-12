// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class A {} public class B : A {}
public static class P { public static int F() { A a = new B(); return a.GetType() == typeof(B) ? 1 : 0; } }
