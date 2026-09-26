#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "M2libc/bootstrappable.h"

/*
SPDX-FileCopyrightText: 2023 Richard Masters <grick23@gmail.com>
SPDX-License-Identifier: MIT

Simple Patch program.

This program is written in a subset of C called M2, which is from the
stage0-posix bootstrap project.

Example usage:
./simple-patch input patch output

Cellar changes: immutable output, exact single match, checked I/O, and a
single unified hunk describing the before and after byte strings. Hunk
coordinates refer to these strings, not lines in the input file. Matching
is exact even when the strings begin or end in the middle of a source line.
This is not a general-purpose or fuzzy unified-diff implementation.
Source: live-bootstrap dd8ac27bf959344b9bcf5e876bdd7716879bbc70.
SPDX-FileCopyrightText: 2026 Austin Seipp

*/

// function prototypes
void read_file_or_die(char *file_name, char **buffer, int *file_size);
void read_patch_or_die(char *file_name, char **before, int *before_size,
                       char **after, int *after_size);
void patch_buffer_or_die(char *patch_file_before_buffer, int patch_file_before_size,
                 char *before_pattern_buffer, int before_pattern_size,
                 char *after_pattern_buffer, int after_pattern_size,
                 char *patch_file_after_buffer);
void writestr_fd(int fd, char *str);
int memsame(char *search_buffer, int search_size,
            char *pattern_buffer, int pattern_size);


int main(int argc, char **argv) {
    char *patch_file_before_buffer;
    int patch_file_before_size;

    char *before_pattern_buffer;
    int before_pattern_size;

    char *after_pattern_buffer;
    int after_pattern_size;

    int patch_file_after_size;
    char *patch_file_after_buffer;

    int patch_file_fd;

    require(argc == 4, "Usage: simple-patch input patch output\n");
    require(!match(argv[1], argv[3]), "simple-patch: output must differ from input\n");
    require(!match(argv[2], argv[3]), "simple-patch: output must differ from patch\n");

    read_file_or_die(argv[1], &patch_file_before_buffer, &patch_file_before_size);
    read_patch_or_die(argv[2], &before_pattern_buffer, &before_pattern_size,
                     &after_pattern_buffer, &after_pattern_size);

    require(before_pattern_size > 0, "simple-patch: empty pattern\n");
    require(before_pattern_size <= patch_file_before_size, "simple-patch: pattern exceeds input\n");

    patch_file_after_size = patch_file_before_size - before_pattern_size + after_pattern_size;
    patch_file_after_buffer = calloc(patch_file_after_size + 1, sizeof(char));

    require(patch_file_after_buffer != NULL, "simple-patch: allocation failed\n");

    patch_buffer_or_die(patch_file_before_buffer, patch_file_before_size,
                 before_pattern_buffer, before_pattern_size,
                 after_pattern_buffer, after_pattern_size,
                 patch_file_after_buffer);

    patch_file_fd = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    require(patch_file_fd >= 0, "simple-patch: cannot open output\n");
    require(write(patch_file_fd, patch_file_after_buffer, patch_file_after_size) == patch_file_after_size,
            "simple-patch: cannot write output\n");
    require(close(patch_file_fd) == 0, "simple-patch: cannot close output\n");

    return EXIT_SUCCESS;
}

/* Parse a deliberately small unified-diff subset. Every line is bounded by
   the file size; malformed patches fail before any output is opened. */
int patch_literal(char *buffer, int size, int pos, char *literal) {
    int len = strlen(literal);
    require(memsame(buffer + pos, size - pos, literal, len),
            "simple-patch: malformed patch header or newline marker\n");
    return pos + len;
}

int patch_line_end(char *buffer, int size, int pos) {
    while (pos < size && buffer[pos] != '\n') pos = pos + 1;
    require(pos < size, "simple-patch: unterminated patch line\n");
    return pos + 1;
}

int patch_number(char *buffer, int size, int *pos) {
    int value = 0;
    int start = *pos;
    while (*pos < size && buffer[*pos] >= '0' && buffer[*pos] <= '9') {
        /* A line count cannot exceed the patch's byte size. Check before
           multiplying so even an unreasonably long integer cannot overflow. */
        require(value <= (size - (buffer[*pos] - '0')) / 10,
                "simple-patch: invalid hunk count\n");
        value = value * 10 + buffer[*pos] - '0';
        *pos = *pos + 1;
    }
    require(*pos > start, "simple-patch: missing hunk count\n");
    return value;
}

int patch_range(char *buffer, int size, int *pos) {
    int start = patch_number(buffer, size, pos);
    int count = 1;
    if (*pos < size && buffer[*pos] == ',') {
        *pos = *pos + 1;
        count = patch_number(buffer, size, pos);
    }
    require((count == 0 && start == 0) || (count > 0 && start == 1),
            "simple-patch: hunk must describe a complete block\n");
    return count;
}

void read_patch_or_die(char *file_name, char **before, int *before_size,
                       char **after, int *after_size) {
    char *buffer;
    int size;
    int pos;
    int end;
    int len;
    int old_lines;
    int new_lines;
    int old_end = 0;
    int new_end = 0;
    int previous = 0;
    int kind;

    read_file_or_die(file_name, &buffer, &size);
    pos = patch_literal(buffer, size, 0, "--- ");
    pos = patch_line_end(buffer, size, pos);
    pos = patch_literal(buffer, size, pos, "+++ ");
    pos = patch_line_end(buffer, size, pos);
    pos = patch_literal(buffer, size, pos, "@@ -");
    old_lines = patch_range(buffer, size, &pos);
    pos = patch_literal(buffer, size, pos, " +");
    new_lines = patch_range(buffer, size, &pos);
    pos = patch_literal(buffer, size, pos, " @@\n");

    *before = calloc(size + 1, sizeof(char));
    *after = calloc(size + 1, sizeof(char));
    require(*before != NULL && *after != NULL, "simple-patch: allocation failed\n");
    *before_size = 0;
    *after_size = 0;
    while (pos < size) {
        kind = buffer[pos];
        if (kind == '\\') {
            require(previous != 0, "simple-patch: misplaced newline marker\n");
            pos = patch_literal(buffer, size, pos, "\\ No newline at end of file\n");
            if (previous == '-' || previous == ' ') {
                *before_size = *before_size - 1;
                old_end = 1;
            }
            if (previous == '+' || previous == ' ') {
                *after_size = *after_size - 1;
                new_end = 1;
            }
            previous = 0;
        } else {
            require(kind == '-' || kind == '+' || kind == ' ',
                    "simple-patch: expected one unified hunk\n");
            end = patch_line_end(buffer, size, pos);
            len = end - pos - 1;
            if (kind == '-' || kind == ' ') {
                require(!old_end && old_lines > 0, "simple-patch: invalid old block length\n");
                memcpy(*before + *before_size, buffer + pos + 1, len);
                *before_size = *before_size + len;
                old_lines = old_lines - 1;
            }
            if (kind == '+' || kind == ' ') {
                require(!new_end && new_lines > 0, "simple-patch: invalid new block length\n");
                memcpy(*after + *after_size, buffer + pos + 1, len);
                *after_size = *after_size + len;
                new_lines = new_lines - 1;
            }
            previous = kind;
            pos = end;
        }
    }
    require(old_lines == 0 && new_lines == 0, "simple-patch: truncated hunk\n");
}


void read_file_or_die(char *file_name, char **buffer, int *file_size) {
    int file_fd;
    int num_bytes_read;

    file_fd = open(file_name, O_RDONLY, 0);
    if (file_fd == -1) {
        writestr_fd(2, "Could not open file: ");
        writestr_fd(2, file_name);
        writestr_fd(2, "\n");
        exit(1);
    }
    // determine file size
    *file_size = lseek(file_fd, 0, SEEK_END);
    require(*file_size >= 0, "simple-patch: cannot determine file size\n");
    // go back to beginning of file
    lseek(file_fd, 0, SEEK_SET);
    // alloc a buffer to read the entire file
    *buffer = calloc(*file_size + 1, sizeof(char));

    require(*buffer != NULL, "simple-patch: allocation failed\n");

    // read the entire patch file
    num_bytes_read = read(file_fd, *buffer, *file_size);
    if (num_bytes_read != *file_size) {
        writestr_fd(2, "Could not read file: ");
        writestr_fd(2, file_name);
        writestr_fd(2, "\n");
        exit(1);
    }
    close(file_fd);
}

void patch_buffer_or_die(char *patch_file_before_buffer, int patch_file_before_size,
                 char *before_pattern_buffer, int before_pattern_size,
                 char *after_pattern_buffer, int after_pattern_size,
                 char *patch_file_after_buffer) {

    char *pos = patch_file_before_buffer;
    int prefix_len = 0;

    int matches = 0;
    while (prefix_len <= patch_file_before_size - before_pattern_size) {
        if (memsame(patch_file_before_buffer + prefix_len,
                    patch_file_before_size - prefix_len,
                    before_pattern_buffer, before_pattern_size)) {
            matches = matches + 1;
        }
        prefix_len = prefix_len + 1;
    }
    require(matches == 1, "simple-patch: expected exactly one match\n");
    prefix_len = 0;

    // look for the pattern at every offset
    while (prefix_len < patch_file_before_size) {
        // if we find the pattern, replace it and return
        if (memsame(pos, patch_file_before_size - prefix_len, before_pattern_buffer, before_pattern_size)) {
           memcpy(patch_file_after_buffer, patch_file_before_buffer, prefix_len);
           memcpy(patch_file_after_buffer + prefix_len, after_pattern_buffer, after_pattern_size);
           memcpy(patch_file_after_buffer + prefix_len + after_pattern_size,
                  patch_file_before_buffer + prefix_len + before_pattern_size,
                  patch_file_before_size - (prefix_len + before_pattern_size));
           return;
        }
        pos = pos + 1;
        prefix_len = prefix_len + 1;
    }

    /* if we don't find the pattern, something is wrong, so exit with error */
    exit(1);
}

/*
    Write the string to the given file descriptor.
*/
void writestr_fd(int fd, char *str) {
    write(fd, str, strlen(str));
}

/*
    Is the pattern located at the start of the search buffer
    (and not exceeding the length of the search buffer)?
*/

int memsame(char *search_buffer, int search_size,
            char *pattern_buffer, int pattern_size) {
    int check_offset = 0;

    if (pattern_size > search_size) {
        return FALSE;
    }
    while (check_offset < pattern_size) {
        if (search_buffer[check_offset] != pattern_buffer[check_offset]) {
             return FALSE;
        }
        check_offset = check_offset + 1;
    }
    return TRUE;
}
