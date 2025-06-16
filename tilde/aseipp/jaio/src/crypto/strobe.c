// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define __STDC_WANT_LIB_EXT1__ 1 /* for memset_s */

#include <assert.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#include <crypto/gimli.h>
#include <crypto/strobe.h>

/* -------------------------------------------------------------------------- */

#define STROBE_MAJOR 1
#define STROBE_MINOR 0
#define STROBE_PATCH 2

// it's incredibly stupid that this isn't standardized somehow
#define _XSTR(x) _STR(x)
#define _STR(x) #x

#define _STROBE_MAJOR_S _XSTR(STROBE_MAJOR)
#define _STROBE_MINOR_S _XSTR(STROBE_MINOR)
#define _STROBE_PATCH_S _XSTR(STROBE_PATCH)

#define _STROBE_VERSTR _STROBE_MAJOR_S "." _STROBE_MINOR_S "." _STROBE_PATCH_S
#define STROBE_VERSION "STROBEv" _STROBE_VERSTR
#define STROBE_VERLEN 12

#define STROBE_DESCR "moria protocol"

#define GIMLI_NBYTES 48
#define GIMLI_CAPACITY 32
#define GIMLI_RATE 15
#define GIMLI_PAD (GIMLI_NBYTES - (GIMLI_CAPACITY + GIMLI_RATE))

#ifdef __STDC_LIB_EXT1__
#define SECURE_MEMSET(dest, destsz, ch, count) memset_s(dest, destsz, ch, count)
#else
#define SECURE_MEMSET(dest, destsz, ch, count) \
  do {                                         \
    (void)destsz;                              \
    memset(dest, ch, count)                    \
  } while (0)
#endif

#ifdef DEBUG
// #define dprintf(...) do { printf(__VA_ARGS__); } while(0)
#define dprintf(...) do { } while(0)
#else
#define dprintf(...) do { } while(0)
#endif

/* -------------------------------------------------------------------------- */

/*
** strobe_role_t:
**
** The role of an endpoint in a Strobe session, assigned to disambiguate
** the two parties present in a session. These are as follows:
**
**   - `ROLE_INITIATOR`: The party who initiated the connection; i.e. they send
**     a message before receiving any.
**   - `ROLE_RESPONDER`: The party who received a connection from an initiator;
**     i.e. they receive a message from the other party before sending any.
**   - `ROLE_UNDECIDED`: The initial state of both parties; i.e. no messages
**     have been sent or received by either endpoint.
*/
typedef enum {
  ROLE_INITIATOR = 0,
  ROLE_RESPONDER = 1,
  ROLE_UNDECIDED = 2,
} strobe_role_t;

typedef enum {
  FLAG_I = 1 << 0, // Inbound
  FLAG_A = 1 << 1, // Application
  FLAG_C = 1 << 2, // Ciphertext
  FLAG_T = 1 << 3, // Transport
  FLAG_M = 1 << 4, // Metadata
  FLAG_K = 1 << 5, // Keytree
} strobe_flag_t;

typedef enum {
  DUPLEX0_AFTER   = 0,
  DUPLEX0_BEFORE  = 1,
  DUPLEX0_NEITHER = 2,
} strobe_duplex0_mode_t;

typedef struct strobe_p {
  // Internal state, represented as a union of 32-bit words and bytes. This
  // allows clean interop between the Gimli implementation (using words)
  // and the sponge (using bytes)
  union {
    uint32_t w[12];
    uint8_t  b[48];
  } sta;

  // Role of the user in the protocol: an initiator, responder, or undecided.
  strobe_role_t role;

  // Rate position. This is used to track the offset into the sponge state
  // block, in bytes
  uint8_t rpos;
} strobe_t;

/* -------------------------------------------------------------------------- */

#if __COMPCERT__ != 1

// Ensure the version string embedded into the initialized state is of the
// correct length.
_Static_assert(
  strlen(STROBE_VERSION) == STROBE_VERLEN,
  "Bad length for STROBE_VERSION identifier!");

// Ensure padding is legitimate. While STROBE Lite always uses GIMLI_PAD = 1,
// in the future if this code is never extended it'll make sure the math is
// still correct elsewhere (non-lite STROBE uses GIMLI_PAD = 2)
_Static_assert(
  (GIMLI_PAD >= 1) && (GIMLI_PAD <= 2), "Invalid size for GIMLI_PAD!");

// Insurance in case we ever replace the uint_* types with something else.
_Static_assert(
  12 * sizeof(uint32_t) == 48 * sizeof(uint8_t),
  "Invalid union size for strobe state; ghosts must be haunting you");

#endif

/* -------------------------------------------------------------------------- */

#define DUPLEX_APP 0
#define DUPLEX_TRANSPORT 1
#define DUPLEX_MAC 2
#define DUPLEX_MAC_FAIL 3
#define DUPLEX_META 4

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
static void
strobe_f(strobe_t *st, uint8_t mark)
{
  st->sta.b[st->rpos] ^= mark;
  st->rpos = 0;
  gimli_pi(st->sta.w);
}

/*
** strobe_mark(st, flags): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
static void
strobe_mark(strobe_t *st, uint32_t flags)
{
  if (flags & FLAG_T) {
    if (st->role == ROLE_UNDECIDED) st->role = (flags & FLAG_I);
    flags ^= st->role;
  }

  st->sta.b[st->rpos++] ^= flags;
  strobe_f(st, 0x03);
}

/*
** strobe_duplex0(st, in, len, mode): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
static int
strobe_duplex0(
  strobe_t *st, uint8_t *in, uint8_t* out, ssize_t len, strobe_duplex0_mode_t mode, uint32_t flags)
{
#define FLAG_CHECK(x, y) ((flags & (x)) == (y))

  // Determine the output mode of the sponge, i.e. the actual results to
  // produce, as requested by the given operation.
  bool app_out       = FLAG_CHECK(FLAG_I | FLAG_A, FLAG_I | FLAG_A);
  bool transport_out = FLAG_CHECK(FLAG_I | FLAG_T, FLAG_T);
  bool mac_out       = FLAG_CHECK(FLAG_I | FLAG_A | FLAG_T, FLAG_I | FLAG_T);

  uint8_t mac_result = 0;
  if (out == NULL) {
    dprintf("c: ");
    for (ssize_t i = 0; i < len; i++) {
      uint8_t tmp = in[i];
      dprintf("%02x/", tmp);

      if (mode == DUPLEX0_BEFORE) tmp ^= st->sta.b[st->rpos];
      dprintf("%02x/", tmp);
      dprintf("%02x/", st->sta.b[st->rpos]);
      st->sta.b[st->rpos]             ^= tmp;
      dprintf("%02x/", st->sta.b[st->rpos]);
      if (mode == DUPLEX0_AFTER) tmp   = st->sta.b[st->rpos];
      dprintf("%02x/", tmp);

      mac_result |= in[i] ^ st->sta.b[st->rpos];
      dprintf("%02x ", mac_result);
      if (++st->rpos == GIMLI_RATE) strobe_f(st, 0x02);
    }
    dprintf("\n");

    goto end;
  }

  if (in == NULL) memset(out, 0, len);
  else memmove(out, in, len);

  for (ssize_t i = 0; i < len; i++) {
    if (mode == DUPLEX0_BEFORE) out[i] ^= st->sta.b[st->rpos];
    st->sta.b[st->rpos]                ^= out[i];
    if (mode == DUPLEX0_AFTER) out[i]   = st->sta.b[st->rpos];

    if (++st->rpos == GIMLI_RATE) strobe_f(st, 0x02);
  }

 end:

  // If we're returning the data to the application, then finish.
  if (app_out) return DUPLEX_APP;

  // If we're sending data on the transport, then finish.
  if (transport_out) return DUPLEX_TRANSPORT;

  // If we were asked to check a MAC, make sure the results are empty (e.g.
  // we got the same state, and thus XORing them together will result in a
  // full set of zeros).
  if (mac_out) return (mac_result == 0) ? DUPLEX_MAC : DUPLEX_MAC_FAIL;

  // Otherwise, return metadata, if none of the above were asked for.
  return DUPLEX_META;
#undef FLAG_CHECK
}

/*
** strobe_duplex(st, flags, bin, bout, len): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
static int
strobe_duplex(strobe_t *st, uint32_t flags, uint8_t *bin, uint8_t* bout, ssize_t len)
{
#define FLAG_CHECK(x, y) ((flags & (x)) == (y))
#define FLAG_ISSET(x)    ((flags & (x)) == (x))

  // Check if there's no input
  bool no_input = FLAG_CHECK(FLAG_I | FLAG_A, 0) || FLAG_CHECK(FLAG_I | FLAG_T, FLAG_I);
  assert( ((!(bin == NULL)) || no_input)
    && "Internal error: NULL input buffer, but _not_ a non-input duplex action!");
  (void)no_input; // for NDEBUG case where assert doesn't exist

  // There must always be at least an output *and* an input
  assert( !((bin == NULL) && (bout == NULL)) && "Internal error: bin and bout are both NULL!");

  // Check what duplex mode to use
  bool after  = FLAG_CHECK(FLAG_C | FLAG_I | FLAG_T, FLAG_C | FLAG_T);
  bool before = FLAG_ISSET(FLAG_C) && !after;
  assert((!(before && after)) && "Internal error: before and after are set!");

  // Mark position, by ingesting flags into the state block.
  strobe_mark(st, flags);

  // Process the input via duplex mechanism. The mode tells us which mechanism
  // to use: incorporating the state data into the input buffer, before or after
  // updating the state with the input. Or neither may happen (simply updating
  // the sponge state).

  // clang-format off
  strobe_duplex0_mode_t mode;
  if (before)     mode = DUPLEX0_BEFORE;
  else if (after) mode = DUPLEX0_AFTER;
  else            mode = DUPLEX0_NEITHER;
  // clang-format on

#ifdef DEBUG
  // printf("mode: %s\n", before ? "DECRYPT" : (after ? "ENCRYPT" : "NEITHER"));
#endif
  return strobe_duplex0(st, bin, bout, len, mode, flags);

#undef FLAG_ISSET
#undef FLAG_CHECK
}

/* -------------------------------------------------------------------------- */

/*
** strobe_init(st): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
strobe_init(strobe_t *st)
{
  const uint8_t proto[6] = {
    1, GIMLI_RATE + 1,    // Total length of rate + padding
    1, 0,                 // Empty NIST personality string
    1, STROBE_VERLEN * 8, // STROBE_VERLEN = strlen("STROBEvX.Y.Z")
  };

  // Initialize: zero-ized sponge stage, with an UNDECIDED role
  st->rpos = 0;
  st->role = ROLE_UNDECIDED;
  memset(st->sta.b, 0, sizeof(*st));

  // Format state with initial contents: protocol metadata, and version
  memcpy(st->sta.b, proto, sizeof(proto));                          // Protocol
  memcpy(st->sta.b + sizeof(proto), STROBE_VERSION, STROBE_VERLEN); // Version

  // Finally: perform mandatory initial domain separation, by running
  // the first permutation and duplexing with domain metadata to separate.
  gimli_pi(st->sta.w);
  strobe_duplex(
    st,
    FLAG_A | FLAG_M, // "Application metadata"
    (uint8_t *)STROBE_DESCR,
    NULL,
    strlen(STROBE_DESCR)
  );
}

/* -------------------------------------------------------------------------- */

/*
** STATE MACHINE:
**
**      OPERATION       |  APP      |    STROBE    |    TRANSPORT
**      ----------------------------------------------------------
**      AD      (A)     |  SEND >------> ABSORB
**      KEY     (AC)    |  SEND >------>  ROLL
**      PRF     (IAC)   |  RECV <------<  XOR   <------< ZERO
**                      |
**      SENDCLR (AT)    |  SEND >------> ABSORB >------> RECV
**      RECVCLR (IAT)   |  RECV <------< ABSORB <------< SEND
**                      |
**      SENDENC (ACT)   |  SEND >------>  XOR   >------> RECV
**      RECVENC (IACT)  |  RECV <------<  XOR   <------< SEND
**                      |
**      SENDMAC (CT)    |  ZERO >------>  XOR   >------> RECV
**      RECVMAC (ICT)   |  ZERO <------<  XOR   <------< SEND
*/

// Define every STROBE operation as an X-Macro. Each mode is defined in terms of
// the flags it uses for the duplex mechanism. Note that RATCHET is handled
// separately below, as it does not behave the same in STROBE Lite.
#define _STROBE_OPS(_)                          \
  _(AD, FLAG_A)                                 \
  _(KEY, FLAG_A | FLAG_C)                       \
  _(PRF, FLAG_I | FLAG_A | FLAG_C)              \
                                                \
  _(SENDCLR, FLAG_A | FLAG_T)                   \
  _(RECVCLR, FLAG_I | FLAG_A | FLAG_T)          \
                                                \
  _(SENDENC, FLAG_A | FLAG_C | FLAG_T)          \
  _(RECVENC, FLAG_I | FLAG_A | FLAG_C | FLAG_T) \
                                                \
  _(SENDMAC, FLAG_C | FLAG_T)                   \
  _(RECVMAC, FLAG_I | FLAG_C | FLAG_T)

// Combine the _STROBE_OPS X-Macro with a macro `K`, which generates
// functions for performing each strobe operation in an easy way.
#define K(name, flags)                                                  \
  static int strobe_op_##name(strobe_t *st, uint8_t *bin, uint8_t* bout, ssize_t len) \
  {                                                                     \
    return strobe_duplex(st, (flags), bin, bout, len);                  \
  }
_STROBE_OPS(K)
#undef K

/* -------------------------------------------------------------------------- */
/* -- Public API ------------------------------------------------------------ */

/*
** strobe_meta(st, bin, len): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
strobe_meta(strobe_t* st, uint8_t* bin, ssize_t len)
{
  int r = strobe_op_AD(st, bin, NULL, len);
  assert(r == DUPLEX_META);
  (void)r; // suppress warning
}

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
strobe_rekey(strobe_t* st, uint8_t* bin, ssize_t len)
{
  int r = strobe_op_KEY(st, bin, NULL, len);
  assert(r == DUPLEX_META);
  (void)r; // suppress warning
}

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
void
strobe_sendclr(strobe_t* st, uint8_t* bin, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_SENDCLR(st, bin, bout, len);
  assert(r == DUPLEX_TRANSPORT);
  (void)r; // suppress warning
}

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
void
strobe_recvclr(strobe_t* st, uint8_t* bin, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_RECVCLR(st, bin, bout, len);
  assert(r == DUPLEX_APP);
  (void)r; // suppress warning
}

/*
** strobe_sendenc(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
void
strobe_sendenc(strobe_t* st, uint8_t* bin, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_SENDENC(st, bin, bout, len);
  assert(r == DUPLEX_TRANSPORT);
  (void)r; // suppress warning
}

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
void
strobe_recvenc(strobe_t* st, uint8_t* bin, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_RECVENC(st, bin, bout, len);
  assert(r == DUPLEX_APP);
  (void)r; // suppress warning
}

/*
** strobe_f(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
void
strobe_sendmac(strobe_t* st, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_SENDMAC(st, NULL, bout, len);
  assert(r == DUPLEX_TRANSPORT);
  (void)r; // suppress warning
}

/*
** strobe_recvmac(st, mark): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - ...
*/
int __attribute__((warn_unused_result))
strobe_recvmac(strobe_t* st, uint8_t* bin, ssize_t len)
{
  return strobe_op_RECVMAC(st, bin, NULL, len);
}

/*
** strobe_prf(st, bout, len): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
strobe_prf(strobe_t* st, uint8_t* bout, ssize_t len)
{
  int r = strobe_op_PRF(st, NULL, bout, len);
  assert(r == DUPLEX_APP);
  (void)r; // suppress warning
}

/*
** strobe_ratchet(st): Lorem ipsum...
**
** Lorem ipsum...
**
** Returns:
**   - Nothing.
**   - Does not fail.
*/
void
strobe_ratchet(strobe_t* st)
{
  /*
  ** Ratchet is special for STROBE Lite with Gimli: a security level of 128
  ** implies a 32byte capacity `c`, with a rate `r` of 16 for pi = Gimli (48
  ** byte state). We then split `r` into `rprime` which is `r/8-1` and the
  ** resulting padding, leaving `rprime = 15` bytes for user data, and 1 byte
  ** for padding. As `rprime < c`, RATCHET on its own is not effective to
  ** prevent rollback. Instead, we read `c` bytes out of PRF, and then re-KEY.
  */
  uint8_t buf[GIMLI_CAPACITY];
  strobe_prf(st, buf, sizeof(buf));
  strobe_rekey(st, buf, sizeof(buf));
}
