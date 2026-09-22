/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#ifndef BOOTSTRAP_EXCEPTION_H
#define BOOTSTRAP_EXCEPTION_H
struct Left { virtual ~Left() {} int left; };
struct Right { virtual ~Right() {} int right; };
struct Derived : Left, Right { int value; Derived() : value(42) {} };
void throw_separately(int *cleaned);
#endif
