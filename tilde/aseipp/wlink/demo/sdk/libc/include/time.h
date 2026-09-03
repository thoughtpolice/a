// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef CONSOLE_LIBC_TIME_H
#define CONSOLE_LIBC_TIME_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long long time_t;
typedef long clock_t;

#define CLOCKS_PER_SEC 1000L

struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
};

time_t time(time_t* out);
clock_t clock(void);
double difftime(time_t end, time_t start);
struct tm* gmtime(const time_t* time);
struct tm* localtime(const time_t* time);
// The reentrant forms, which fill a caller's struct rather than a shared one.
struct tm* gmtime_r(const time_t* time, struct tm* out);
struct tm* localtime_r(const time_t* time, struct tm* out);
time_t mktime(struct tm* time);
size_t strftime(char* buffer, size_t size, const char* format, const struct tm* time);
char* asctime(const struct tm* time);
char* ctime(const time_t* time);

#ifdef __cplusplus
}
#endif

#endif
