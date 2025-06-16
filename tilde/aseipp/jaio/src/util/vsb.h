// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __UTIL__VSB_H__
#define __UTIL__VSB_H__

/* --------------------------------------------------------------- */

struct vsb {
  int error;
  int flags;

  uint8_t* buf;
  off_t    len;
  size_t   size;
};

#define VSB_F_FIXED    0x00000000
#define VSB_F_AUTOSIZE 0x00000001

#define VSB_F_FINISHED 0x00010000
#define VSB_F_DYNBUF   0x00020000
#define VSB_F_DYNVAR   0x00080000

/* --------------------------------------------------------------- */

#define vsb_autonew() \
  vsb_new(NULL, NULL, 0, VSB_F_AUTOSIZE)

struct vsb* vsb_new(struct vsb*, uint8_t*, size_t, int);
int         vsb_error(struct vsb*);
void        vsb_delete(struct vsb*);
void        vsb_destroy(struct vsb**);
int         vsb_finish(struct vsb*);

size_t vsb_len(const struct vsb*);
void   vsb_clear(struct vsb*);

const uint8_t* vsb_data(const struct vsb*);
const char*    vsb_string(const struct vsb*);

int vsb_cat(struct vsb*, const char*);
int vsb_bcat(struct vsb*, const uint8_t*, size_t);

int vsb_vprintf(struct vsb* v, const char* fmt, va_list ap);
int vsb_printf(struct vsb* v, const char* fmt, ...);

/* --------------------------------------------------------------- */

#endif /* __UTIL__VSB_H__ */
