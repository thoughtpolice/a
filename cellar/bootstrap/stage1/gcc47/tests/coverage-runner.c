/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
static void run(char **args) {
    int status = 0;
    pid_t pid = fork();
    if (pid < 0) exit(10);
    if (!pid) { execv(args[0], args); perror(args[0]); _exit(11); }
    if (waitpid(pid, &status, 0) != pid || status) {
        fprintf(stderr, "coverage child failed: %s (%d)\n", args[0], status); exit(12);
    }
}
int main(int argc, char **argv) {
    char *compile[] = {0, "-B", 0, "-B", 0, "-nostdinc", "-isystem", 0, "-isystem", 0,
        "-frandom-seed=bootstrap", "-g0", "-O0", "-fprofile-arcs", "-ftest-coverage", "-fprofile-dir=.", "-c", 0, "-o", "profile.o", 0};
    char *link[] = {0, "-B", 0, "-B", 0, "profile.o", "-lgcov", "-o", "profile", 0};
    char *execute[] = {"./profile", 0};
    char *gcov[] = {0, "-o", "profile.gcno", 0, 0};
    struct stat st;
    FILE *f;
    char line[1024];
    int count = 0;
    if (argc != 8) return 1;
    compile[0] = link[0] = argv[1]; compile[2] = link[2] = argv[2];
    compile[4] = link[4] = argv[3]; compile[7] = argv[4]; compile[9] = argv[5];
    compile[17] = argv[6]; gcov[0] = argv[7]; gcov[3] = argv[6];
    run(compile); run(link); run(execute);
    if (stat("profile.gcda", &st) || st.st_size < 32) return 2;
    run(gcov);
    f = fopen("coverage.c.gcov", "r");
    if (!f) return 3;
    while (fgets(line, sizeof(line), f)) {
        long hits;
        int source_line;
        if (strstr(line, "#####")) return 4;
        if (sscanf(line, "%ld:%d:", &hits, &source_line) == 2) {
            if (strstr(line, "if (i & 1)") && hits == 10) count |= 1;
            if (strstr(line, "else sum +=") && hits == 5) count |= 2;
        }
    }
    if (ferror(f) || fclose(f) || count != 3) return 5;
    f = fopen("passed", "w");
    if (!f || fputs("passed\n", f) < 0 || fclose(f)) return 6;
    return 0;
}
