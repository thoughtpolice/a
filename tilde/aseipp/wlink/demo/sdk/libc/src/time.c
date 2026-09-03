// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The console has no wall clock or time zone: time() counts seconds since
// the application started, and local time is UTC.
#include <stdio.h>
#include <time.h>

#include "console.h"
#include "internal.h"

time_t time(time_t* out) {
  time_t now = (time_t)(console_clock_now_ms() / 1000);
  if (out) *out = now;
  return now;
}

clock_t clock(void) {
  return (clock_t)console_clock_now_ms();
}

double difftime(time_t end, time_t start) {
  return (double)(end - start);
}

static const char* const weekday_names[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char* const month_names[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

static long long floor_divide(long long value, long long divisor) {
  long long quotient = value / divisor;
  if ((value % divisor) < 0) quotient--;
  return quotient;
}

// Days since 1970-01-01 to a civil date, from Howard Hinnant's algorithm.
static void civil_from_days(long long days, int* year, int* month, int* day) {
  days += 719468;
  long long era = floor_divide(days, 146097);
  long long day_of_era = days - era * 146097;
  long long year_of_era =
      (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
  long long day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  long long month_index = (5 * day_of_year + 2) / 153;
  *day = (int)(day_of_year - (153 * month_index + 2) / 5 + 1);
  *month = (int)(month_index < 10 ? month_index + 3 : month_index - 9);
  *year = (int)(year_of_era + era * 400 + (*month <= 2));
}

static long long days_from_civil(long long year, int month, int day) {
  year -= month <= 2;
  long long era = floor_divide(year, 400);
  long long year_of_era = year - era * 400;
  long long day_of_year = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1;
  long long day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  return era * 146097 + day_of_era - 719468;
}

static struct tm* fill(struct tm* out, time_t value) {
  long long days = floor_divide(value, 86400);
  long long seconds = value - days * 86400;
  int year;
  int month;
  int day;
  civil_from_days(days, &year, &month, &day);
  out->tm_sec = (int)(seconds % 60);
  out->tm_min = (int)(seconds / 60 % 60);
  out->tm_hour = (int)(seconds / 3600);
  out->tm_mday = day;
  out->tm_mon = month - 1;
  out->tm_year = year - 1900;
  out->tm_wday = (int)(((days % 7) + 11) % 7);
  out->tm_yday = (int)(days - days_from_civil(year, 1, 1));
  out->tm_isdst = 0;
  return out;
}

struct tm* gmtime(const time_t* value) {
  static struct tm result;
  return fill(&result, *value);
}

struct tm* localtime(const time_t* value) {
  return gmtime(value);
}

struct tm* gmtime_r(const time_t* value, struct tm* out) {
  return fill(out, *value);
}

struct tm* localtime_r(const time_t* value, struct tm* out) {
  return gmtime_r(value, out);
}

time_t mktime(struct tm* value) {
  long long months = (long long)value->tm_year * 12 + value->tm_mon;
  long long year = floor_divide(months, 12) + 1900;
  int month = (int)(months - (year - 1900) * 12) + 1;
  long long days = days_from_civil(year, month, 1) + value->tm_mday - 1;
  time_t result = (time_t)(days * 86400 + value->tm_hour * 3600LL + value->tm_min * 60LL + value->tm_sec);
  fill(value, result);
  return result;
}

static size_t append(char* buffer, size_t size, size_t length, const char* text) {
  while (*text) {
    if (length + 1 >= size) return size;
    buffer[length++] = *text++;
  }
  return length;
}

size_t strftime(char* buffer, size_t size, const char* format, const struct tm* value) {
  size_t length = 0;
  char scratch[16];
  for (; *format; format++) {
    if (*format != '%') {
      length = append(buffer, size, length, (char[]){*format, '\0'});
      if (length >= size) return 0;
      continue;
    }
    format++;
    const char* text = scratch;
    switch (*format) {
      case 'a': text = weekday_names[value->tm_wday % 7]; break;
      case 'b':
      case 'h': text = month_names[value->tm_mon % 12]; break;
      case 'd': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_mday); break;
      case 'e': console_libc_snprintf(scratch, sizeof scratch, "%2d", value->tm_mday); break;
      case 'H': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_hour); break;
      case 'I': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_hour % 12 ? value->tm_hour % 12 : 12); break;
      case 'j': console_libc_snprintf(scratch, sizeof scratch, "%03d", value->tm_yday + 1); break;
      case 'm': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_mon + 1); break;
      case 'M': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_min); break;
      case 'p': text = value->tm_hour < 12 ? "AM" : "PM"; break;
      case 'S': console_libc_snprintf(scratch, sizeof scratch, "%02d", value->tm_sec); break;
      case 'y': console_libc_snprintf(scratch, sizeof scratch, "%02d", (value->tm_year + 1900) % 100); break;
      case 'Y': console_libc_snprintf(scratch, sizeof scratch, "%d", value->tm_year + 1900); break;
      case 'F':
        console_libc_snprintf(scratch, sizeof scratch, "%d-%02d-%02d", value->tm_year + 1900,
                              value->tm_mon + 1, value->tm_mday);
        break;
      case 'T':
        console_libc_snprintf(scratch, sizeof scratch, "%02d:%02d:%02d", value->tm_hour,
                              value->tm_min, value->tm_sec);
        break;
      case '%': text = "%"; break;
      case '\0': return 0;
      default: console_libc_snprintf(scratch, sizeof scratch, "%%%c", *format); break;
    }
    length = append(buffer, size, length, text);
    if (length >= size) return 0;
  }
  if (length >= size) return 0;
  buffer[length] = '\0';
  return length;
}

char* asctime(const struct tm* value) {
  static char buffer[32];
  console_libc_snprintf(buffer, sizeof buffer, "%s %s %2d %02d:%02d:%02d %d\n",
                        weekday_names[value->tm_wday % 7], month_names[value->tm_mon % 12],
                        value->tm_mday, value->tm_hour, value->tm_min, value->tm_sec,
                        value->tm_year + 1900);
  return buffer;
}

char* ctime(const time_t* value) {
  return asctime(gmtime(value));
}
