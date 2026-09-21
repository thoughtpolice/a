/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
int weak_only(void);
int take(int value[static const 1]) { return value[0]; }
int main(void) { int value[1] = {19}; return take(value) != 19 || weak_only() != 42; }
