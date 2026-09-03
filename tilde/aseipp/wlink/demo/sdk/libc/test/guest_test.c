// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The libc as a guest sees it: files through the SDK's streams, the standard
// streams through the log, the clock, the process, and a sample of the pure
// routines compiled for wasm32.
#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "runtime.h"

static void require(int condition, const char* what) {
  if (!condition) {
    printf("FAIL libc %s\n", what);
    exit(1);
  }
}

static int compare_ints(const void* left, const void* right) {
  int a = *(const int*)left;
  int b = *(const int*)right;
  return a < b ? -1 : a > b;
}

static void test_files(void) {
  char buffer[128];
  FILE* file = fopen("libc-test.txt", "wb");
  require(file != NULL, "fopen for writing");
  require(fprintf(file, "line %d\n", 1) == 7, "fprintf to file");
  require(fputs("second line\n", file) == 0, "fputs to file");
  require(fwrite("abc", 1, 3, file) == 3, "fwrite to file");
  require(ftell(file) == 22, "ftell after writes");
  require(fclose(file) == 0, "fclose after writing");

  file = fopen("libc-test.txt", "rb");
  require(file != NULL, "fopen for reading");
  require(fgets(buffer, sizeof buffer, file) != NULL && strcmp(buffer, "line 1\n") == 0, "fgets");
  require(fgetc(file) == 's', "fgetc");
  require(ftell(file) == 8, "ftell after buffered reads");
  require(fseek(file, 0, SEEK_END) == 0 && ftell(file) == 22, "fseek to end");
  require(fseek(file, 7, SEEK_SET) == 0, "fseek to offset");
  require(fread(buffer, 1, 12, file) == 12 && memcmp(buffer, "second line\n", 12) == 0, "fread");
  require(!feof(file), "eof not yet set");
  require(fread(buffer, 1, sizeof buffer, file) == 3 && memcmp(buffer, "abc", 3) == 0, "short fread");
  require(feof(file), "eof set after short read");
  require(fseek(file, -3, SEEK_END) == 0 && !feof(file) && fgetc(file) == 'a', "relative seek");
  require(fseek(file, -1, SEEK_CUR) == 0 && fgetc(file) == 'a', "seek relative to buffered position");
  require(fclose(file) == 0, "fclose after reading");

  file = fopen("libc-test.txt", "a");
  require(file != NULL, "fopen for appending");
  require(fputs("tail\n", file) == 0, "fputs when appending");
  require(fclose(file) == 0, "fclose after appending");
  file = fopen("libc-test.txt", "rb");
  require(file != NULL && fseek(file, 0, SEEK_END) == 0 && ftell(file) == 27, "append kept contents");
  rewind(file);
  int count = 0;
  while (fgetc(file) != EOF) count++;
  require(count == 27 && feof(file), "fgetc to end");
  require(fseek(file, 22, SEEK_SET) == 0 && fgets(buffer, sizeof buffer, file) != NULL &&
              strcmp(buffer, "tail\n") == 0,
          "appended line");
  require(fclose(file) == 0, "fclose after append check");

  require(fopen("missing.txt", "rb") == NULL, "fopen of a missing file");
  require(fopen("libc-test.txt", "r+b") == NULL && errno == EINVAL, "unsupported mode");
  require(fgetc(stdin) == EOF && feof(stdin), "stdin is empty");
  require(rename("libc-test.txt", "libc-renamed.txt") == 0, "rename");
  require(fopen("libc-test.txt", "rb") == NULL, "renamed file left its old name");
  file = fopen("libc-renamed.txt", "rb");
  require(file != NULL && fseek(file, 0, SEEK_END) == 0 && ftell(file) == 27,
          "renamed file kept its contents");
  require(fclose(file) == 0, "fclose after rename");
  require(remove("libc-renamed.txt") == 0, "remove");
  require(fopen("libc-renamed.txt", "rb") == NULL, "removed file is gone");
  require(remove("libc-renamed.txt") == -1 && errno == ENOENT, "remove of a missing file");
}

static void test_text(void) {
  char buffer[64];
  require(sprintf(buffer, "%d %.2f %s %x", 42, 3.14159, "x", 255) == 12 &&
              strcmp(buffer, "42 3.14 x ff") == 0,
          "sprintf");
  require(snprintf(buffer, 4, "%d", 123456) == 6 && strcmp(buffer, "123") == 0, "snprintf truncation");
  float a = 0;
  float b = 0;
  float c = 0;
  require(sscanf("1.5 2.5 -3", "%f %f %f", &a, &b, &c) == 3 && a == 1.5f && b == 2.5f && c == -3.0f,
          "sscanf floats");
  int first = 0;
  int second = 0;
  require(sscanf("0x10 17", "%i %d", &first, &second) == 2 && first == 16 && second == 17, "sscanf ints");
  require(strlen("hello") == 5 && strcmp("a", "b") < 0 && strcmp("b", "a") > 0 && strcmp("a", "a") == 0, "strcmp");
  require(strcpy(buffer, "abc") == buffer && strcat(buffer, "def") == buffer && strcmp(buffer, "abcdef") == 0, "strcat");
  require(strstr(buffer, "cde") == buffer + 2 && strchr(buffer, 'e') == buffer + 4 && strrchr(buffer, 'a') == buffer,
          "search");
  require(strncmp("abcx", "abcy", 3) == 0 && strncmp("abcx", "abcy", 4) < 0, "strncmp");
  require(strcasecmp("HeLLo", "hello") == 0 && strcasecmp("a", "B") < 0, "strcasecmp");
  strcpy(buffer, "one two  three");
  require(strcmp(strtok(buffer, " "), "one") == 0 && strcmp(strtok(NULL, " "), "two") == 0 &&
              strcmp(strtok(NULL, " "), "three") == 0 && strtok(NULL, " ") == NULL,
          "strtok");
  char* copy = strdup("dup");
  require(copy != NULL && strcmp(copy, "dup") == 0, "strdup");
  free(copy);
  memcpy(buffer, "0123456789", 11);
  memmove(buffer + 2, buffer, 5);
  require(memcmp(buffer, "0101234789", 10) == 0, "memmove overlap");
  memset(buffer, 'z', 3);
  require(memcmp(buffer, "zzz1234789", 10) == 0 && memchr(buffer, '4', 10) == buffer + 6, "memset and memchr");
  require(isdigit('5') && !isdigit('a') && isalpha('q') && isspace('\n') && !isspace('x'), "ctype classes");
  require(toupper('a') == 'A' && tolower('Z') == 'z' && toupper('1') == '1', "case mapping");
}

static void test_stdlib(void) {
  require(atoi("-123") == -123 && atol("77") == 77, "atoi");
  require(atof("2.5e2") == 250.0 && atof("0.1") == 0.1 && strtod("inf", NULL) == INFINITY, "atof");
  require(strtol("ff", NULL, 16) == 255 && strtoul("0x10", NULL, 0) == 16, "strtol bases");
  errno = 0;
  require(strtol("99999999999999999999", NULL, 10) == LONG_MAX && errno == ERANGE, "strtol overflow");
  require(abs(-5) == 5 && labs(-7L) == 7, "abs");
  srand(1);
  int r1 = rand();
  int r2 = rand();
  srand(1);
  require(rand() == r1 && rand() == r2 && r1 != r2 && r1 >= 0, "rand is deterministic");
  int values[] = {5, 3, 9, 1, 7, 3};
  qsort(values, 6, sizeof values[0], compare_ints);
  require(values[0] == 1 && values[1] == 3 && values[2] == 3 && values[5] == 9, "qsort");
  int key = 7;
  require(bsearch(&key, values, 6, sizeof values[0], compare_ints) == values + 4, "bsearch");
  unsigned char* zeros = calloc(16, 4);
  require(zeros != NULL, "calloc");
  for (int i = 0; i < 64; i++) require(zeros[i] == 0, "calloc zeroes");
  zeros[63] = 42;
  zeros = realloc(zeros, 1024);
  require(zeros != NULL && zeros[63] == 42, "realloc keeps contents");
  free(zeros);
  require(getenv("HOME") == NULL, "getenv");
  require(strcmp(strerror(ENOENT), "No such file or directory") == 0, "strerror");
  assert(1 == 1);
}

// Jumps. The compiler rewrites each of these functions around the tag the
// libc throws, so what is under test is the whole lowering and not a pair of
// library calls: a jump that never happens, one that crosses a frame, one
// that unwinds several at once, and a buffer reused by a later call.
static jmp_buf inner_jump;
static jmp_buf outer_jump;
static int jump_trace;

static void jump_from_here(int value) {
  jump_trace = jump_trace * 10 + 3;
  if (value) longjmp(inner_jump, value);
  jump_trace = jump_trace * 10 + 4;
}

static int catches_the_jump(int value) {
  int code = setjmp(inner_jump);
  if (code != 0) return code;
  jump_trace = jump_trace * 10 + 2;
  jump_from_here(value);
  return 0;
}

static void jump_past_a_frame(void) {
  catches_the_jump(0);
  longjmp(outer_jump, 9);
}

static void test_jumps(void) {
  jump_trace = 1;
  require(catches_the_jump(0) == 0, "setjmp returns zero when it is filled");
  require(catches_the_jump(7) == 7, "longjmp returns its value from setjmp");
  require(catches_the_jump(0) == 0, "a buffer is usable again after a jump");
  require(jump_trace == 123423234, "each frame ran as far as its jump");

  // A jump with zero arrives as one, and a jump from two frames down lands
  // in the frame that set the buffer rather than the one in between.
  int code = setjmp(outer_jump);
  if (code == 0) {
    jump_past_a_frame();
    require(0, "the jump did not leave the frame it was thrown from");
  }
  require(code == 9, "a jump crosses the frames between it and its buffer");

  int zero_code = setjmp(outer_jump);
  if (zero_code == 0) longjmp(outer_jump, 0);
  require(zero_code == 1, "a jump with zero arrives as one");

  // A buffer can be jumped to as often as it is filled. `rounds` is volatile
  // because C leaves a local written between setjmp and longjmp indeterminate
  // when it is not, and this lowering is no kinder about it than any other.
  volatile int rounds = 0;
  int again = setjmp(outer_jump);
  if (again < 3) {
    rounds += 1;
    longjmp(outer_jump, again + 1);
  }
  require(again == 3 && rounds == 3, "a buffer can be jumped to repeatedly");
  printf("PASS libc jumps\n");
}

static int close_to(double actual, double expected, double tolerance) {
  return fabs(actual - expected) <= tolerance;
}

static void test_math(void) {
  require(sqrt(16.0) == 4.0 && floor(-1.5) == -2.0 && ceil(1.2) == 2.0 && fabs(-3.0) == 3.0, "builtins");
  require(sin(0.0) == 0.0 && cos(0.0) == 1.0 && exp(0.0) == 1.0 && log(1.0) == 0.0, "exact values");
  require(pow(2.0, 10.0) == 1024.0 && fmod(7.5, 2.0) == 1.5 && log2(8.0) == 3.0, "pow fmod log2");
  require(close_to(sin(1.0), 0.8414709848078965, 1e-15), "sin");
  require(close_to(cos(1.0), 0.5403023058681398, 1e-15), "cos");
  require(close_to(tan(1.0), 1.5574077246549023, 1e-15), "tan");
  require(close_to(atan2(1.0, 1.0), M_PI_4, 1e-15) && close_to(atan(1.0), M_PI_4, 1e-15), "atan");
  require(close_to(acos(0.5), 1.0471975511965979, 1e-15) && close_to(asin(0.5), 0.5235987755982989, 1e-15), "acos asin");
  require(close_to(log10(1000.0), 3.0, 1e-15) && close_to(exp(1.0), M_E, 1e-15), "log10 exp");
  require(close_to(sin(1e6), -0.34999350217129294, 1e-15), "sin of a large argument");
  require(close_to(cbrt(27.0), 3.0, 1e-15) && close_to(hypot(3.0, 4.0), 5.0, 1e-15), "cbrt hypot");
  int exponent = 0;
  require(frexp(8.0, &exponent) == 0.5 && exponent == 4 && ldexp(0.5, 4) == 8.0, "frexp ldexp");
  double integral = 0;
  require(modf(2.75, &integral) == 0.75 && integral == 2.0 && round(2.5) == 3.0, "modf round");
  require(isnan(sqrt(-1.0)) && isinf(exp(1000.0)) && !isnan(1.0), "classification");
}

static void test_time(void) {
  char buffer[64];
  time_t now = time(NULL);
  require(now >= 0 && clock() >= 0, "time and clock");
  time_t epoch = 0;
  struct tm* tm = localtime(&epoch);
  require(tm->tm_year == 70 && tm->tm_mon == 0 && tm->tm_mday == 1 && tm->tm_wday == 4 && tm->tm_yday == 0,
          "epoch fields");
  require(strftime(buffer, sizeof buffer, "%Y-%m-%d %H:%M:%S %a %b", tm) == 27 &&
              strcmp(buffer, "1970-01-01 00:00:00 Thu Jan") == 0,
          "strftime");
  require(strcmp(asctime(tm), "Thu Jan  1 00:00:00 1970\n") == 0, "asctime");
  struct tm later = {.tm_year = 126, .tm_mon = 8, .tm_mday = 11, .tm_hour = 12, .tm_min = 34, .tm_sec = 56};
  time_t stamp = mktime(&later);
  require(stamp == 1789130096 && later.tm_wday == 5 && later.tm_yday == 253, "mktime");
  struct tm* back = gmtime(&stamp);
  require(back->tm_year == 126 && back->tm_mon == 8 && back->tm_mday == 11 && back->tm_hour == 12 &&
              back->tm_min == 34 && back->tm_sec == 56,
          "gmtime round trip");
}

void console_guest_init(void) {
  printf("PASS libc %s\n", "stdout");
  fprintf(stderr, "PASS libc stderr\n");
  test_files();
  test_text();
  test_stdlib();
  test_jumps();
  test_math();
  test_time();
  puts("PASS libc all");
  printf("PASS libc flush");
  exit(0);
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  return 0;
}
