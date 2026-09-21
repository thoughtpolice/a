/* SPDX-FileCopyrightText: © 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void)
{
    int fd = syscall(SYS_memfd_create, "bootstrap-syscall-arguments", 0);
    char *p;
    if (fd < 0) return 1;
    if (ftruncate(fd, 8192) || pwrite(fd, "six", 3, 4096) != 3) return 2;
    p = mmap(0, 4096, PROT_READ, MAP_PRIVATE, fd, 4096);
    if (p == MAP_FAILED) return 3;
    if (p[0] != 's' || p[1] != 'i' || p[2] != 'x') return 4;
    if (munmap(p, 4096) || close(fd)) return 5;
    return 0;
}
