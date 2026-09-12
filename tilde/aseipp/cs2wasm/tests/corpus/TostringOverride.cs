// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public class C { public override string ToString() => "c"; }
public static class P { public static int F() => $"{new C()}".Length; }
