/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */
/* One integer or pointer argument used to corrupt SValue.type in the seed. */
int integer_arg(int x);
int pointer_arg(char *x);
int probe(void) { return integer_arg(3) + pointer_arg("pointer"); }
