/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Regenerate libcpp/generated_cpp_wcwidth.h from GCC's pinned Unicode data.
 * This follows contrib/unicode/gen_wcwidth.py and the glibc utf8_gen.py width
 * rules it runs, including their range condensation and output layout.
 *
 *   wcwidth VERSION UnicodeData.txt EastAsianWidth.txt PropList.txt
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CODE_POINTS 0x110000

/* -1 marks code points outside glibc's width table, which keep width 1. */
static signed char table[CODE_POINTS];
static unsigned char widths[CODE_POINTS];
/* Code points UnicodeData.txt assigns, as unicode_utils.fill_attributes
   records them: First/Last ranges expanded and surrogates left out. */
static unsigned char assigned[CODE_POINTS];
static char line[4096];

static void fail(const char *message, const char *detail)
{
    fprintf(stderr, "wcwidth: %s%s%s\n", message, detail ? ": " : "", detail ? detail : "");
    exit(1);
}

static FILE *open_input(const char *path)
{
    FILE *file = fopen(path, "r");
    if (!file) fail("cannot open", path);
    return file;
}

static unsigned long code_point(const char *text, char **end)
{
    unsigned long value = strtoul(text, end, 16);
    if (*end == text || value >= CODE_POINTS) fail("bad code point", text);
    return value;
}

/* Parse "XXXX" or "XXXX..YYYY" before the first ';'. */
static void code_range(const char *field, unsigned long *first, unsigned long *last)
{
    char *end;
    *first = code_point(field, &end);
    *last = *first;
    if (end[0] == '.' && end[1] == '.') *last = code_point(end + 2, &end);
}

/* glibc skips "<reserved-X>..<reserved-Y>" comment ranges. */
static int reserved_range(const char *text)
{
    const char *start = strstr(text, "<reserved-");
    const char *middle;
    if (!start) return 0;
    middle = strstr(start + 11, ">..<reserved-");
    return middle && strchr(middle + 14, '>') != NULL;
}

static void read_east_asian_width(const char *path)
{
    FILE *file = open_input(path);
    while (fgets(line, sizeof line, file)) {
        char *semicolon = strchr(line, ';');
        unsigned long first, last, cp;
        if (reserved_range(line)) continue;
        if (!semicolon || (semicolon[1] != 'W' && semicolon[1] != 'F')) continue;
        code_range(line, &first, &last);
        for (cp = first; cp <= last; cp++) table[cp] = 2;
    }
    if (ferror(file) || fclose(file)) fail("cannot read", path);
}

static int ends_with(const char *text, const char *suffix)
{
    size_t length = strlen(text), suffix_length = strlen(suffix);
    return length >= suffix_length && !strcmp(text + length - suffix_length, suffix);
}

/* Field 1 is the name, field 2 the general category and field 4 the
   bidirectional class. */
static void read_unicode_data(const char *path)
{
    FILE *file = open_input(path);
    unsigned long range_start = CODE_POINTS;
    while (fgets(line, sizeof line, file)) {
        char *fields[5];
        char *cursor = line;
        unsigned long cp, first;
        char *end;
        int i;
        for (i = 0; i < 5; i++) {
            fields[i] = cursor;
            cursor = strchr(cursor, ';');
            if (!cursor) fail("short UnicodeData line", line);
            *cursor++ = 0;
        }
        cp = code_point(fields[0], &end);
        first = cp;
        if (!strcmp(fields[2], "Cs")) {
            range_start = CODE_POINTS;
        } else if (ends_with(fields[1], ", First>")) {
            range_start = cp;
        } else {
            if (ends_with(fields[1], ", Last>")) {
                if (range_start == CODE_POINTS) fail("range without a start", fields[1]);
                first = range_start;
                range_start = CODE_POINTS;
            }
            for (; first <= cp; first++) assigned[first] = 1;
        }
        if (!strcmp(fields[4], "NSM") || !strcmp(fields[2], "Cf") ||
            !strcmp(fields[2], "Me") || !strcmp(fields[2], "Mn"))
            table[cp] = 0;
    }
    if (ferror(file) || fclose(file)) fail("cannot read", path);
}

/* Prepended concatenation marks return to the default width. */
static void read_prop_list(const char *path)
{
    FILE *file = open_input(path);
    while (fgets(line, sizeof line, file)) {
        char *semicolon = strchr(line, ';');
        char *property;
        unsigned long first, last, cp;
        if (!semicolon || line[0] == '#') continue;
        property = semicolon + 1;
        while (*property == ' ' || *property == '\t') property++;
        if (strncmp(property, "Prepended_Concatenation_Mark", 28)) continue;
        code_range(line, &first, &last);
        for (cp = first; cp <= last; cp++) {
            if (table[cp] < 0) fail("prepended mark without a width", line);
            table[cp] = -1;
        }
    }
    if (ferror(file) || fclose(file)) fail("cannot read", path);
}

static void set_range(unsigned long first, unsigned long last, int width)
{
    unsigned long cp;
    for (cp = first; cp <= last; cp++) table[cp] = width;
}

int main(int argc, char **argv)
{
    unsigned long cp, count = 0, i;
    unsigned long *ends;
    unsigned char *range_widths;
    unsigned long current_end;
    int current_width;
    if (argc != 5) fail("usage: wcwidth VERSION UnicodeData.txt EastAsianWidth.txt PropList.txt", NULL);

    memset(table, -1, sizeof table);
    read_east_asian_width(argv[3]);
    read_unicode_data(argv[2]);
    read_prop_list(argv[4]);
    table[0xad] = -1;
    /* Only assigned Hangul jungseong and jongseong are zero width. */
    for (cp = 0x1160; cp < 0x1200; cp++) if (assigned[cp]) table[cp] = 0;
    for (cp = 0xd7b0; cp < 0xd800; cp++) if (assigned[cp]) table[cp] = 0;
    set_range(0x3248, 0x324f, 2);
    set_range(0x4dc0, 0x4dff, 2);

    for (cp = 0; cp < CODE_POINTS; cp++) widths[cp] = table[cp] < 0 ? 1 : table[cp];
    /* gen_wcwidth.py assigns widths[0:255], leaving U+00FF from the table. */
    for (cp = 0; cp < 255; cp++) widths[cp] = 1;

    ends = malloc(CODE_POINTS * sizeof *ends);
    range_widths = malloc(CODE_POINTS);
    if (!ends || !range_widths) fail("out of memory", NULL);
    /* The script starts from [-1, 1] and never appends its final range. */
    current_end = (unsigned long)-1;
    current_width = 1;
    for (cp = 0; cp < CODE_POINTS; cp++) {
        if (widths[cp] == current_width) {
            current_end = cp;
        } else {
            ends[count] = current_end;
            range_widths[count] = current_width;
            count++;
            current_end = cp;
            current_width = widths[cp];
        }
    }

    printf("/*  Generated by contrib/unicode/gen_wcwidth.py, with the help of glibc's\n");
    printf("    utf8_gen.py, using version %s of the Unicode standard.  */\n", argv[1]);
    printf("\nstatic const cppchar_t wcwidth_range_ends[] = {");
    for (i = 0; i < count; i++) {
        fputs(i % 8 ? " " : "\n  ", stdout);
        printf("0x%lx,", ends[i]);
    }
    printf("\n};\n\n");
    printf("static const unsigned char wcwidth_widths[] = {");
    for (i = 0; i < count; i++) {
        fputs(i % 24 ? " " : "\n  ", stdout);
        printf("%d,", range_widths[i]);
    }
    printf("\n};\n");
    if (fflush(stdout) || ferror(stdout)) fail("cannot write output", NULL);
    return 0;
}
