// SPDX-FileCopyrightText: 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Runs with an empty PATH under the bootstrap executor's sandbox. Every tool
// comes from the installation, and every generated file stays in this action.
#define _XOPEN_SOURCE 700
#include <elf.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *message) {
    fprintf(stderr, "toolchain check: %s\n", message);
    exit(1);
}

static char *path(const char *directory, const char *name) {
    size_t size = strlen(directory) + strlen(name) + 2;
    char *result = malloc(size);
    if (!result) fail("allocation");
    snprintf(result, size, "%s/%s", directory, name);
    return result;
}

static char *read_file(const char *name, size_t *size) {
    FILE *file = fopen(name, "rb");
    if (!file || fseek(file, 0, SEEK_END)) fail(name);
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET)) fail(name);
    char *data = malloc((size_t)length + 1);
    if (!data || fread(data, 1, length, file) != (size_t)length || fclose(file)) fail(name);
    data[length] = 0;
    *size = (size_t)length;
    return data;
}

static void write_file(const char *name, const char *content) {
    FILE *file = fopen(name, "w");
    if (!file || fputs(content, file) < 0 || fclose(file)) fail(name);
}

// Each command's combined output is retained for diagnostics and driver audits.
static void run(const char *expected, const char *program, ...) {
    char *args[64];
    args[0] = (char *)program;
    va_list ap;
    va_start(ap, program);
    size_t i = 1;
    for (; i < 64; ++i) {
        args[i] = va_arg(ap, char *);
        if (!args[i]) break;
    }
    va_end(ap);
    if (i == 64) fail("too many arguments");
    pid_t child = fork();
    if (child < 0) fail("fork");
    if (!child) {
        FILE *log = fopen("command.log", "w");
        if (!log || dup2(fileno(log), 1) < 0 || dup2(fileno(log), 2) < 0) _exit(126);
        fclose(log);
        execv(program, args);
        perror(program);
        _exit(127);
    }
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail("waitpid");
    size_t length;
    char *output = read_file("command.log", &length);
    if (!WIFEXITED(status) || WEXITSTATUS(status) || (expected && strcmp(output, expected))) {
        for (size_t j = 0; j < i; ++j) fprintf(stderr, "%s ", args[j]);
        fprintf(stderr, "\n%.*s", (int)length, output);
        fail("command failed or output differs");
    }
    free(output);
}

static void version(const char *program, const char *expected) {
    run(NULL, program, "--version", NULL);
    size_t length;
    char *text = read_file("command.log", &length);
    if (!strstr(text, expected)) fail("unexpected compiler/tool version");
    free(text);
}

static void elf(const char *name, int machine, int executable, int stripped) {
    size_t size;
    char *data = read_file(name, &size);
    if (size < sizeof(Elf64_Ehdr)) fail("short ELF header");
    Elf64_Ehdr header;
    memcpy(&header, data, sizeof header);
    if (memcmp(header.e_ident, "\177ELF\2\1", 6) || header.e_machine != machine ||
        header.e_type != (executable ? ET_EXEC : ET_REL)) fail("wrong ELF architecture or type");
    if (executable) {
        int stack = 0;
        for (unsigned i = 0; i < header.e_phnum; ++i) {
            size_t offset = header.e_phoff + i * header.e_phentsize;
            if (offset > size || size - offset < sizeof(Elf64_Phdr)) fail("invalid program header");
            Elf64_Phdr ph;
            memcpy(&ph, data + offset, sizeof ph);
            if (ph.p_type == PT_INTERP || ph.p_type == PT_DYNAMIC) fail("dynamic ELF dependency");
            if (ph.p_type == PT_GNU_STACK && ph.p_memsz == 8388608) stack = 1;
        }
        if (stripped && !stack) fail("missing LLVM thread stack size");
    }
    if (stripped) {
        for (unsigned i = 0; i < header.e_shnum; ++i) {
            size_t offset = header.e_shoff + i * header.e_shentsize;
            if (offset > size || size - offset < sizeof(Elf64_Shdr)) fail("invalid section header");
            Elf64_Shdr sh;
            memcpy(&sh, data + offset, sizeof sh);
            if (sh.sh_type == SHT_SYMTAB) fail("unstripped LLVM program");
        }
    }
    for (size_t i = 0; i + 10 <= size; ++i)
        if (!memcmp(data + i, "GCC: (GNU)", 10)) fail("GCC-compiled code in LLVM installation");
    free(data);
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    char *tree = realpath(argv[1], NULL);
    if (!tree) fail("installation path");
    char *clang = path(tree, "bin/clang"), *cxx = path(tree, "bin/clang++");
    char *lld = path(tree, "bin/ld.lld"), *ar = path(tree, "bin/llvm-ar");
    char *ranlib = path(tree, "bin/llvm-ranlib");
    version(clang, "Target: aarch64-unknown-linux-musl");
    version(lld, "LLD 23.1.0");
    version(ar, "LLVM version 23.1.0");
    version(ranlib, "LLVM version 23.1.0");

    run(NULL, clang, "-O2", "-c", path(argv[2], "helper.c"), "-o", "helper.o", NULL);
    run(NULL, clang, "-O2", "-pthread", path(argv[2], "native.c"), "helper.o", "-o", "native-c", NULL);
    run(NULL, cxx, "-O2", "-pthread", path(argv[2], "native.cc"), "helper.o", "-o", "native-cxx", NULL);
    run(NULL, cxx, "-O2", "-std=c++23", argv[3], "-o", "runtimes", NULL);
    run("native C 4294967325\n", "./native-c", NULL);
    run("native C++ 4294967299\n", "./native-cxx", NULL);
    run("runtimes a/c 555555555 1.5e+300\n", "./runtimes", NULL);

    write_file("seven.c", "int seven(void) { return 7; }\n");
    write_file("main.c", "int seven(void); int main(void) { return seven() - 7; }\n");
    run(NULL, clang, "-O2", "-c", "seven.c", "-o", "seven.o", NULL);
    run(NULL, ar, "rc", "libseven.a", "seven.o", NULL);
    run(NULL, ranlib, "libseven.a", NULL);
    run(NULL, clang, "main.c", "-L.", "-lseven", "-o", "seven", NULL);
    run("", "./seven", NULL);

    write_file("walk.c", "#define UNW_LOCAL_ONLY\n#include <libunwind.h>\n#include <unwind.h>\n"
        "__attribute__((noinline)) int walk(void) { unw_context_t context; unw_cursor_t cursor; "
        "if (unw_getcontext(&context) || unw_init_local(&cursor, &context)) return 1; "
        "return unw_step(&cursor) > 0 ? 0 : 1; }\n"
        "int main(void) { volatile int result = walk(); return result || sizeof(_Unwind_Ptr) != sizeof(void *); }\n");
    run(NULL, clang, "-O2", "walk.c", "-o", "walk", NULL);
    run("", "./walk", NULL);

    run(NULL, clang, "--target=x86_64-unknown-linux-musl", "-ffreestanding", "-nostdlibinc", "-O2", "-c", "seven.c", "-o", "x86.o", NULL);
    elf("x86.o", EM_X86_64, 0, 0);
    elf("seven.o", EM_AARCH64, 0, 0);
    elf(clang, EM_AARCH64, 1, 1);
    elf(lld, EM_AARCH64, 1, 1);
    elf(ar, EM_AARCH64, 1, 1);
    elf(cxx, EM_AARCH64, 1, 0);
    elf(ranlib, EM_AARCH64, 1, 0);
    elf("native-c", EM_AARCH64, 1, 0);
    elf("native-cxx", EM_AARCH64, 1, 0);
    elf("runtimes", EM_AARCH64, 1, 0);

    run(NULL, cxx, "-###", "-x", "c++", "-", "-o", "program", NULL);
    size_t length;
    char *commands = read_file("command.log", &length);
    for (char *word = strtok(commands, " \t\r\n\""); word; word = strtok(NULL, " \t\r\n\"")) {
        if (!strncmp(word, "-fdebug-compilation-dir=", 24) || !strncmp(word, "-fcoverage-compilation-dir=", 27)) continue;
        char *equal = strchr(word, '=');
        if (equal) word = equal + 1;
        if (*word == '/' && (strncmp(word, tree, strlen(tree)) || word[strlen(tree)] != '/'))
            fail("driver searches outside its installation");
    }
    free(commands);
    write_file("passed", "passed\n");
    return 0;
}
