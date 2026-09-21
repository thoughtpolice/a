/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
int weak_answer(void) __attribute__((weak));
int weak_answer(void) { return 7; }
