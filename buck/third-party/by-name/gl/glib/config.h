/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-FileCopyrightText: GLib contributors
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/* The config.h meson.build's configure_file() writes from glib_conf, for
 * Linux and glibc with clang on an LP64 host (x86_64 and arm64 agree on
 * every value here). It has no template: each define below comes from the
 * check of the same name in the top-level meson.build, answered for the
 * toolchain's glibc. A check that fails, or a feature this build leaves out
 * (libmount, SELinux, sysprof, dtrace), is #undef, as meson writes it. */

#ifndef GLIB_BUCK_CONFIG_H
#define GLIB_BUCK_CONFIG_H

#define GLIB_MAJOR_VERSION 2
#define GLIB_MINOR_VERSION 90
#define GLIB_MICRO_VERSION 1
#define GLIB_INTERFACE_AGE 1
#define GLIB_BINARY_AGE 9001

#define GETTEXT_PACKAGE "glib20"
#define PACKAGE_BUGREPORT "https://gitlab.gnome.org/GNOME/glib/issues/new"
#define PACKAGE_NAME "glib"
#define PACKAGE_STRING "glib 2.90.1"
#define PACKAGE_TARNAME "glib"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.90.1"

/* Nothing installs glib20.mo next to a Buck build, so the catalogs are
 * looked up where a distribution would put them. */
#define ENABLE_NLS 1
#define HAVE_BIND_TEXTDOMAIN_CODESET 1
#define HAVE_DCGETTEXT 1
#define HAVE_GETTEXT 1
#define GLIB_LOCALE_DIR "/usr/share/locale"
#define GLIB_LOCALSTATEDIR "/var"
#define GLIB_RUNSTATEDIR "/run"

#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif

#define EXEEXT

/* Headers. */
#define HAVE_ALLOCA_H 1
#define HAVE_DIRENT_H 1
#define HAVE_FLOAT_H 1
#define HAVE_FSTAB_H 1
#define HAVE_FTW_H 1
#define HAVE_GRP_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LINUX_NETLINK_H 1
#define HAVE_LOCALE_H 1
#define HAVE_MALLOC_H 1
#define HAVE_MEMORY_H 1
#define HAVE_MNTENT_H 1
#define HAVE_NETLINK 1
#define HAVE_POLL_H 1
#define HAVE_PWD_H 1
#define HAVE_SCHED_H 1
#define HAVE_SPAWN_H 1
#define HAVE_STDATOMIC_H 1
#define HAVE_STDCKDINT_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYSLOG_H 1
#define HAVE_SYS_AUXV_H 1
#define HAVE_SYS_INOTIFY_H 1
#define HAVE_SYS_MOUNT_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_PRCTL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_SELECT_H 1
#define HAVE_SYS_STATFS_H 1
#define HAVE_SYS_STATVFS_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIMES_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UIO_H 1
#define HAVE_SYS_VFS_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_SYS_XATTR_H 1
#define HAVE_TERMIOS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_VALUES_H 1
#define HAVE_WCHAR_H 1

/* Structure members. */
#define HAVE_STRUCT_DIRENT_D_TYPE 1
#define HAVE_STRUCT_STATFS_F_BAVAIL 1
#define HAVE_STRUCT_STATVFS_F_TYPE 1
#define HAVE_STRUCT_STAT_ST_ATIM_TV_NSEC 1
#define HAVE_STRUCT_STAT_ST_BLKSIZE 1
#define HAVE_STRUCT_STAT_ST_BLOCKS 1
#define HAVE_STRUCT_STAT_ST_CTIM_TV_NSEC 1
#define HAVE_STRUCT_STAT_ST_MTIM_TV_NSEC 1
#define HAVE_STRUCT_TM_TM_GMTOFF 1

/* Functions. glibc has free_sized() from 2.43 on; the toolchain's 2.42 does
 * not, and the define also decides G_HAVE_FREE_SIZED in glibconfig.h. */
#define HAVE_ACCEPT4 1
#define HAVE_ALIGNED_ALLOC 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_CLOCK_NANOSLEEP 1
#define HAVE_CLOSE_RANGE 1
#define HAVE_COPY_FILE_RANGE 1
#define HAVE_ENDMNTENT 1
#define HAVE_ENDSERVENT 1
#define HAVE_EPOLL_CREATE1 1
#define HAVE_EVENTFD 1
#define HAVE_FACCESSAT 1
#define HAVE_FALLOCATE 1
#define HAVE_FCHMOD 1
#define HAVE_FCHOWN 1
#define HAVE_FSYNC 1
#define HAVE_FTRUNCATE64 1
#define HAVE_FUTEX 1
#define HAVE_GETAUXVAL 1
#define HAVE_GETC_UNLOCKED 1
#define HAVE_GETFSENT 1
#define HAVE_GETGRGID_R 1
#define HAVE_GETIFADDRS 1
#define HAVE_GETMNTENT_R 1
#define HAVE_GETPWNAM_R 1
#define HAVE_GETPWUID_R 1
#define HAVE_GETRESUID 1
#define HAVE_GETSERVBYNAME_R 1
#define HAVE_GMTIME_R 1
#define HAVE_HASMNTOPT 1
#define HAVE_IF_INDEXTONAME 1
#define HAVE_IF_NAMETOINDEX 1
#define HAVE_INOTIFY_INIT1 1
#define HAVE_LCHMOD 1
#define HAVE_LCHOWN 1
#define HAVE_LINK 1
#define HAVE_LOCALTIME_R 1
#define HAVE_LSTAT 1
#define HAVE_MBRTOWC 1
#define HAVE_MEMALIGN 1
#define HAVE_MEMMEM 1
#define HAVE_MKOSTEMP 1
#define HAVE_MMAP 1
#define HAVE_NEWLOCALE 1
#define HAVE_PIDFD 1
#define HAVE_PIPE2 1
#define HAVE_POLL 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_POSIX_SPAWN 1
#define HAVE_PPOLL 1
#define HAVE_PRCTL 1
#define HAVE_PRLIMIT 1
#define HAVE_READLINK 1
#define HAVE_RECVMMSG 1
#define HAVE_SENDMMSG 1
#define HAVE_SETENV 1
#define HAVE_SETMNTENT 1
#define HAVE_SNPRINTF 1
#define HAVE_SPLICE 1
#define HAVE_STATFS 1
#define HAVE_STATVFS 1
#define HAVE_STATX 1
#define HAVE_STPCPY 1
#define HAVE_STRCASECMP 1
#define HAVE_STRERROR_R 1
#define HAVE_STRNCASECMP 1
#define HAVE_STRNLEN 1
#define HAVE_STRSIGNAL 1
#define HAVE_STRTOD_L 1
#define HAVE_STRTOLL_L 1
#define HAVE_STRTOULL_L 1
#define HAVE_SYMLINK 1
#define HAVE_SYSINFO 1
#define HAVE_TIMEGM 1
#define HAVE_UNSETENV 1
#define HAVE_UNSHARE 1
#define HAVE_USELOCALE 1
#define HAVE_UTIMENSAT 1
#define HAVE_UTIMES 1
#define HAVE_VALLOC 1
#define HAVE_VASPRINTF 1
#define HAVE_VSNPRINTF 1
#define HAVE_WCRTOMB 1
#define HAVE_WCSLEN 1
#define HAVE_WCSNLEN 1
#undef HAVE_FREE_SIZED
#undef HAVE_FREE_ALIGNED_SIZED
#undef HAVE_FUTEX_TIME64

/* meson's strlcpy() check runs a program that calls strlcat() with only
 * <stdlib.h> included, which clang rejects as an implicit declaration, so
 * glib uses its own g_strlcpy() even on a glibc that has strlcpy(). */
#undef HAVE_STRLCPY

#define STRERROR_R_CHAR_P 1
#define MAJOR_IN_SYSMACROS 1
#define HAVE_RTLD_GLOBAL 1
#define HAVE_RTLD_LAZY 1
#define HAVE_RTLD_NEXT 1
#define HAVE_RTLD_NOW 1
#define HAVE_LOFF_T 1
#define HAVE_OPEN_O_DIRECTORY 1
#define HAVE_PTRACE_O_EXITKILL 1
#define HAVE_UINT128_T 1
#define HAVE_LC_MESSAGES 1
#define HAVE_PROC_SELF_CMDLINE 1

/* Linux's statfs() is the system call, so meson prefers it to statvfs(). */
#define USE_STATFS 1
#define STATFS_ARGS 2

/* glibc's printf family passes every C99 and Unix98 check, so glib wraps it
 * rather than building its gnulib copy. */
#define HAVE_C99_SNPRINTF 1
#define HAVE_C99_VSNPRINTF 1
#define HAVE_UNIX98_PRINTF 1
#define USE_SYSTEM_PRINTF 1
#define gl_unused
#define gl_extern_inline

#define HAVE_CODESET 1
#define HAVE_LANGINFO_ABALTMON 1
#define HAVE_LANGINFO_ALTMON 1
#define HAVE_LANGINFO_CODESET 1
#define HAVE_LANGINFO_ERA 1
#define HAVE_LANGINFO_OUTDIGIT 1
#define HAVE_LANGINFO_TIME 1
#define HAVE_LANGINFO_TIME_CODESET 1

#define HAVE_PTRDIFF_T 1
#define HAVE_SIG_ATOMIC_T 1
#define HAVE_LONG_LONG 1
#define HAVE_LONG_DOUBLE 1
#define HAVE_WCHAR_T 1
#define HAVE_WINT_T 1
#define HAVE_INTTYPES_H_WITH_UINTMAX 1
#define HAVE_STDINT_H_WITH_UINTMAX 1
#define HAVE_INTMAX_T 1

#define SIZEOF_CHAR 1
#define SIZEOF_SHORT 2
#define SIZEOF_INT 4
#define SIZEOF_LONG 8
#define SIZEOF_LONG_LONG 8
#define SIZEOF_SIZE_T 8
#define SIZEOF_SSIZE_T 8
#define SIZEOF_VOID_P 8
#define SIZEOF_WCHAR_T 4

#define HAVE_IPV6 1
#define _GLIB_GCC_HAVE_SYNC_SWAP 1

#define THREADS_POSIX 1
#define HAVE_PTHREAD_ATTR_SETINHERITSCHED 1
#define HAVE_PTHREAD_ATTR_SETSTACKSIZE 1
#define HAVE_PTHREAD_CONDATTR_SETCLOCK 1
#define HAVE_PTHREAD_GETAFFINITY_NP 1
#define HAVE_PTHREAD_GETNAME_NP 1
#define HAVE_PTHREAD_SETNAME_NP_WITH_TID 1

#define HAVE_XATTR 1

#undef HAVE_LIBMOUNT
#undef HAVE_SELINUX
#undef HAVE_SYSPROF

#endif /* GLIB_BUCK_CONFIG_H */
