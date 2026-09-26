/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include <stddef.h>
#include <sys/ptrace.h>

typedef char info_size[sizeof(struct __ptrace_syscall_info) == 88 ? 1 : -1];
typedef char entry_offset[offsetof(struct __ptrace_syscall_info, entry.nr) == 24 ? 1 : -1];
typedef char args_offset[offsetof(struct __ptrace_syscall_info, entry.args) == 32 ? 1 : -1];
typedef char seccomp_offset[offsetof(struct __ptrace_syscall_info, seccomp.ret_data) == 80 ? 1 : -1];
int main(void)
{
    struct __ptrace_syscall_info info = {0};
    info.entry.nr = 39;
    if (info.seccomp.nr != 39) return 1;
    return 0;
}
