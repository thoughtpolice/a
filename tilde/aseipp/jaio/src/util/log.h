// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef __TESTING__LOG_H__
#define __TESTING__LOG_H__

/* --------------------------------------------------------------- */

#define ENABLE_LOGGING
#define ENABLE_DEBUG

extern int g_log_prio; // FIXME: LOG_ERR

static inline void __attribute__((unused, always_inline, format(printf, 1, 2)))
log_null(const char *format, ...) { (void)format; }

void init_log(char* level);

void __attribute__((format(printf, 5, 6)))
log_stderr(int priority,
           const char *file, int line, const char *fn,
           const char *format, ...);

#define log_cond(prio, arg...) \
    do { \
          if (g_log_prio >= prio) \
            log_stderr(prio, __FILE__, __LINE__, __FUNCTION__, arg); \
        } while (0)

#if defined(ENABLE_LOGGING)
#  if defined(ENABLE_DEBUG)
#    define ldbg(arg...) log_cond(LOG_DEBUG, arg)
#  else
#    define ldbg(arg...) log_null(arg)
#  endif
#  define lnfo(arg...) log_cond(LOG_INFO, arg)
#  define lerr(arg...) log_cond(LOG_ERR, arg)
#else
#  define ldbg(arg...) log_null(arg)
#  define lnfo(arg...) log_null(arg)
#  define lerr(arg...) log_null(arg)
#endif

/* --------------------------------------------------------------- */

#endif /* __TESTING__LOG_H__ */
