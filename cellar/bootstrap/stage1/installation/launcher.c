/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE 1
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Package names, paths, arguments and environment policy are BUILD data. */
struct profile {
    const char *name;
    const char *program;
    const char *argv0;
    int compiler;
    int cxx;
    const char *const *arguments;
    const char *const *environment;
};
#include "launch-config.h"

static void die(const char *message)
{
    fprintf(stderr, "bootstrap launcher: %s: %s\n", message, strerror(errno));
    exit(127);
}
static void *allocate(size_t size)
{
    void *p = malloc(size);
    if (!p) die("allocation");
    return p;
}
static char *expand(const char *text, const char *root)
{
    const char *p = text;
    size_t count = 0, rootlen = strlen(root), length = strlen(text);
    char *out, *q;
    while ((p = strstr(p, "{root}"))) { ++count; p += 6; }
    out = allocate(length + count * rootlen + 1);
    q = out;
    while (*text) {
        if (!strncmp(text, "{root}", 6)) {
            memcpy(q, root, rootlen); q += rootlen; text += 6;
        } else *q++ = *text++;
    }
    *q = 0;
    return out;
}
static int option(int argc, char **argv, const char *flag)
{
    int i;
    for (i = 1; i < argc; ++i) if (!strcmp(argv[i], flag)) return 1;
    return 0;
}
static void append(char **args, size_t *n, const char *const *values,
                   const char *root)
{
    while (*values) args[(*n)++] = expand(*values++, root);
}
/* NAME=VALUE replaces a setting; NAME?=VALUE only fills in an unset one. */
static void configure(const char *const *settings, const char *root)
{
    for (; *settings; ++settings) {
        char *setting = expand(*settings, root), *value = strchr(setting, '=');
        int overwrite = 1;
        if (!value) { errno = EINVAL; die("environment configuration"); }
        *value++ = 0;
        if (*setting && setting[strlen(setting)-1] == '?') {
            setting[strlen(setting)-1] = 0; overwrite = 0;
        }
        if (setenv(setting, value, overwrite)) die(setting);
        free(setting);
    }
}
int main(int argc, char **argv)
{
    size_t capacity = 256, n = 0, i;
    ssize_t length;
    char *self, *name, *slash, *program, **args, *path, *oldpath;
    const struct profile *selected = NULL;
    /* Linux is the explicit native target. Resolve the actual installed copy,
       so both PATH lookup and symlinks work after moving the whole tree. */
    for (;;) {
        self = allocate(capacity);
        length = readlink("/proc/self/exe", self, capacity - 1);
        if (length < 0) die("/proc/self/exe");
        if ((size_t)length < capacity - 1) break;
        free(self); capacity *= 2;
    }
    self[length] = 0;
    slash = strrchr(self, '/');
    if (!slash) { errno = EINVAL; die("installation path"); }
    name = strdup(slash + 1);
    if (!name) die("allocation");
    *slash = 0;
    slash = strrchr(self, '/');
    if (!slash || strcmp(slash + 1, "bin")) {
        errno = EINVAL; die("launcher must be installed in bin");
    }
    *slash = 0;
    for (i = 0; i < sizeof(profiles) / sizeof(profiles[0]); ++i)
        if (!strcmp(profiles[i].name, name)) { selected = profiles + i; break; }
    if (!selected) { errno = ENOENT; die(name); }

    path = expand("{root}/bin", self);
    oldpath = getenv("PATH");
    if (oldpath && *oldpath &&
        (strncmp(oldpath, path, strlen(path)) ||
         (oldpath[strlen(path)] && oldpath[strlen(path)] != ':'))) {
        char *combined = allocate(strlen(path) + strlen(oldpath) + 2);
        sprintf(combined, "%s:%s", path, oldpath);
        free(path); path = combined;
    } else if (oldpath && *oldpath) {
        free(path); path = strdup(oldpath);
        if (!path) die("allocation");
    }
    if (setenv("PATH", path, 1)) die("PATH");
    configure(environment, self);
    configure(selected->environment, self);
    if (selected->compiler)
        for (i = 0; compiler_unset[i]; ++i)
            if (unsetenv(compiler_unset[i])) die(compiler_unset[i]);

    args = allocate(((size_t)argc + 128) * sizeof(*args));
    args[n++] = selected->argv0 ? expand(selected->argv0, self) : argv[0];
    append(args, &n, selected->arguments, self);
    if (selected->compiler) {
        append(args, &n, compiler_arguments, self);
        if (!option(argc, argv, "-nostdinc")) {
            if (selected->cxx && !option(argc, argv, "-nostdinc++"))
                append(args, &n, cxx_includes, self);
            append(args, &n, c_includes, self);
        }
    }
    for (i = 1; i < (size_t)argc; ++i) args[n++] = argv[i];
    args[n] = NULL;
    program = expand(selected->program, self);
    execv(program, args);
    die(program);
    return 127;
}
