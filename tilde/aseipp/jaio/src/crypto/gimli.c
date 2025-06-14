// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdint.h>

#include <crypto/gimli.h>

/* rotatel32(x, bits): Rotate ${x} left by ${bits} bits, safely. */
static uint32_t
rotatel32(uint32_t x, int bits)
{
  if (bits == 0) return x;
  return (x << bits) | (x >> (32 - bits));
}

/*
** gimli_pi(state):
**
** Perform the Gimli permutation on a given block of bytes ${state},
** representing the sponge state of the permutation.
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
gimli_pi(uint32_t *state)
{
  int      round;
  int      column;
  uint32_t x, y, z;

  for (round = 24; round > 0; --round) {
    for (column = 0; column < 4; ++column) {
      // clang-format off
      x = rotatel32(state[    column], 24);
      y = rotatel32(state[4 + column], 9);
      z =           state[8 + column];

      state[8 + column] = x ^ (z << 1) ^ ((y & z) << 2);
      state[4 + column] = y ^ x        ^ ((x | z) << 1);
      state[column]     = z ^ y        ^ ((x & y) << 3);
      // clang-format on
    }

    if ((round & 3) == 0) {  // small swap: pattern s...s...s... etc.
      x        = state[0];
      state[0] = state[1];
      state[1] = x;
      x        = state[2];
      state[2] = state[3];
      state[3] = x;
    }
    if ((round & 3) == 2) {  // big swap: pattern ..S...S...S. etc.
      x        = state[0];
      state[0] = state[2];
      state[2] = x;
      x        = state[1];
      state[1] = state[3];
      state[3] = x;
    }

    if ((round & 3) == 0) {  // add constant: pattern c...c...c... etc.
      state[0] ^= (0x9e377900 | round);
    }
  }
}
