// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
public static class P { public static int F(int x) { try { throw new ArgumentException("bad", "x"); } catch (ArgumentException e) { return e.Message.Length; } } }
