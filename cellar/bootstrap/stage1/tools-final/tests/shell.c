/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE 1
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
int bootstrap_system(const char *);
FILE *bootstrap_popen(const char *, const char *);
static void handler(int signal) { (void)signal; }
int main(int argc, char **argv)
{
    FILE *stream;
    char line[32];
    struct sigaction before = {0}, after;
    sigset_t block, saved, current;
    int status;
    (void)argv;
    if (argc > 1) {
        errno = 0;
        if (bootstrap_system("exit 0") != -1 || errno != ENOENT) return 1;
        errno = 0;
        if (bootstrap_popen("printf forbidden", "r") || errno != ENOENT) return 2;
        return 0;
    }
    before.sa_handler = handler;
    sigemptyset(&before.sa_mask);
    if (sigaction(SIGINT, &before, 0)) return 3;
    sigemptyset(&block); sigaddset(&block, SIGUSR1);
    if (sigprocmask(SIG_BLOCK, &block, &saved)) return 4;
    status = bootstrap_system("exit 7");
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 7) return 5;
    if (sigaction(SIGINT, 0, &after) || after.sa_handler != handler) return 6;
    if (sigprocmask(SIG_BLOCK, 0, &current) || !sigismember(&current, SIGUSR1)) return 7;
    if (sigprocmask(SIG_SETMASK, &saved, 0)) return 8;
    stream = bootstrap_popen("printf 'input\n'", "r");
    if (!stream || !fgets(line, sizeof line, stream) || strcmp(line, "input\n")) return 9;
    if (pclose(stream)) return 10;
    stream = bootstrap_popen("read value; test \"$value\" = output", "w");
    if (!stream || fputs("output\n", stream) < 0 || pclose(stream)) return 11;
    status = bootstrap_system("kill -TERM $$");
    if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM) return 12;
    return 0;
}
