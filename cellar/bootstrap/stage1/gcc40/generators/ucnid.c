/* SPDX-FileCopyrightText: 2003 Free Software Foundation, Inc.
 * SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * C translation of GCC 4.0.4 libcpp/ucnid.pl.  Retains the input template,
 * standard order, language boundaries and exact upstream table formatting.
 * See the upstream COPYING file for the license.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

static char tags[65536][32];
static char *names[65536];
static char template[65536];
static unsigned line_number;

static void fail(const char *message)
{
  fprintf(stderr, "ucnid:%u: %s\n", line_number, message);
  exit(1);
}

static unsigned hex4(const char *p)
{
  unsigned i, n = 0;
  for (i = 0; i < 4; ++i) {
    unsigned c = (unsigned char)p[i];
    if (c >= '0' && c <= '9') c -= '0';
    else if (c >= 'a' && c <= 'f') c = c - 'a' + 10;
    else fail("expected four lowercase hexadecimal digits");
    n = n * 16 + c;
  }
  return n;
}

static void print_table(void)
{
  unsigned lo = 0, hi;
  const char *previous = "";
  while (lo < 65536) {
    const char *name = names[lo] ? names[lo] : "";
    char tag[40];
    for (hi = lo + 1; hi < 65536; ++hi)
      if (strcmp(tags[hi], tags[lo]) ||
          strcmp(names[hi] ? names[hi] : "", name)) break;
    if (tags[lo][0]) {
      sprintf(tag, "%s%s", strncmp(tags[lo], "C99", 3) ? "" : "    ", tags[lo]);
      printf("  { 0x%04x, 0x%04x, %-11s },", lo, hi - 1, tag);
      if (strcmp(previous, name)) printf("  /* %s */", name);
      putchar('\n');
      previous = name;
    }
    lo = hi;
  }
}

int main(int argc, char **argv)
{
  FILE *in;
  char line[4096], standard[16] = "", *language = NULL;
  char *p, *token;
  size_t used = 0, length;
  int separator = 0;
  if (argc != 2) fail("usage: ucnid input.tab");
  in = fopen(argv[1], "r");
  if (!in) fail("cannot open input");
  while (fgets(line, sizeof line, in)) {
    ++line_number;
    length = strlen(line);
    if (!length || line[length - 1] != '\n') fail("unterminated or oversized line");
    line[--length] = 0;
    if (!strcmp(line, "%%")) { separator = 1; break; }
    if (used + length + 2 > sizeof template) fail("oversized template");
    memcpy(template + used, line, length);
    used += length;
    template[used++] = '\n';
  }
  if (!separator) fail("missing template separator");
  while (fgets(line, sizeof line, in)) {
    ++line_number;
    length = strlen(line);
    if (!length || line[length - 1] != '\n') fail("unterminated or oversized line");
    line[--length] = 0;
    p = line;
    while (isspace((unsigned char)*p)) ++p;
    if (!*p || *p == '#') continue;
    if (*p == '[') {
      if (length < 3 || line[length - 1] != ']' || length - 2 >= sizeof standard)
        fail("invalid standard");
      line[length - 1] = 0;
      if (strcmp(line + 1, "C99") && strcmp(line + 1, "CXX") && strcmp(line + 1, "C99|DIG"))
        fail("unknown standard");
      strcpy(standard, line + 1);
      continue;
    }
    if (p[0] == ';' && p[1] == ' ') {
      if (!p[2]) fail("empty language");
      language = malloc(strlen(p + 2) + 1);
      if (!language) fail("out of memory");
      strcpy(language, p + 2);
      continue;
    }
    if (!*standard || !language) fail("range before standard or language");
    for (token = strtok(p, " \t\r"); token; token = strtok(NULL, " \t\r")) {
      unsigned lo, hi, i;
      char tag[32];
      length = strlen(token);
      if (length != 4 && (length != 9 || token[4] != '-')) fail("malformed range");
      lo = hex4(token);
      hi = length == 4 ? lo : hex4(token + 5);
      /* Upstream's Thai section contains 0e4f-0e49.  Its Perl loop treats
         a reversed interval as empty; retain that published behavior. */
      for (i = lo; i <= hi; ++i) {
        if (strlen(tags[i]) + strlen(standard) + 2 > sizeof tag) fail("too many standards");
        sprintf(tag, "%s%s%s", standard, tags[i][0] ? "|" : "", tags[i]);
        strcpy(tags[i], tag);
        if (names[i] && strcmp(names[i], language)) fail("overlapping language ranges");
        names[i] = language;
      }
    }
  }
  if (ferror(in) || fclose(in)) fail("input error");
  p = template;
  while (*p) {
    char *end = strchr(p, '\n');
    *end = 0;
    if (!strcmp(p, "[dne]")) puts("/* Automatically generated from cppucnid.tab, do not edit */");
    else if (!strcmp(p, "[table]")) print_table();
    else puts(p);
    p = end + 1;
  }
  if (fflush(stdout) || ferror(stdout)) fail("output error");
  return 0;
}
