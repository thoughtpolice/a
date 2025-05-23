load(
    ":defs.bzl",
    "write_file",
    "download_file",
    "ungz",
    "untar",
    "M2_Planet",
    "blood_elf",
    "M1",
    "hex2",
    "mes_bins",
)

VERSION = "0.27"  # XXX FIXME: f-strings
CPU_0 = "amd64"  # XXX FIXME: linux-aarch64
MES_CPU = "x86_64"  # XXX FIXME: linux-aarch64

download_file(
    name="mes-{}.tar.gz".format(VERSION),
    hash="b40fe944ef69cf752331a3778c1c15e9198333b7bc90dcdd78662e712f27314b",
    urls=[
        "https://git.savannah.gnu.org/cgit/mes.git/snapshot/mes-{}.tar.gz".format(
            VERSION
        ),
    ],
)

ungz(
    name="mes-{}.tar".format(VERSION),
    input=":mes-{}.tar.gz".format(VERSION),
    ungz="cellar//bootstrap/stage0-posix/mescc-tools-extra:ungz",
)

untar(
    name="mes-{}".format(VERSION),
    input=":mes-{}.tar".format(VERSION),
    chdirexec="cellar//bootstrap/stage0-posix/mescc-tools-extra:chdirexec",
    untar="cellar//bootstrap/stage0-posix/mescc-tools-extra:untar",
    tarxf="tarxf",
    files=map(
        lambda x: "{}".format(x),
        [
            "include/mes/lib-mini.h",
            "include/mes/lib.h",
            f"lib/linux/{MES_CPU}-mes-m2/crt1.c",
            "lib/mes/__init_io.c",
            f"lib/linux/{MES_CPU}-mes-m2/_exit.c",
            f"lib/linux/{MES_CPU}-mes-m2/_write.c",
            "lib/mes/globals.c",
            "lib/m2/cast.c",
            "lib/stdlib/exit.c",
            "lib/mes/write.c",
            f"include/linux/{MES_CPU}/syscall.h",
            f"lib/linux/{MES_CPU}-mes-m2/syscall.c",
            "lib/stub/__raise.c",
            "lib/linux/brk.c",
            "lib/linux/malloc.c",
            "lib/string/memset.c",
            "lib/linux/read.c",
            "lib/mes/fdgetc.c",
            "lib/stdio/getchar.c",
            "lib/stdio/putchar.c",
            "lib/stub/__buffered_read.c",
            "include/errno.h",
            "include/fcntl.h",
            "lib/linux/_open3.c",
            "lib/linux/open.c",
            "lib/mes/mes_open.c",
            "lib/string/strlen.c",
            "lib/mes/eputs.c",
            "lib/mes/fdputc.c",
            "lib/mes/eputc.c",
            "include/time.h",
            "include/sys/time.h",
            "include/m2/types.h",
            "include/sys/types.h",
            "include/sys/utsname.h",
            "include/mes/mes.h",
            "include/mes/builtins.h",
            "include/mes/constants.h",
            "include/mes/symbols.h",
            "lib/mes/__assert_fail.c",
            "lib/mes/assert_msg.c",
            "lib/mes/fdputc.c",
            "lib/string/strncmp.c",
            "lib/posix/getenv.c",
            "lib/mes/fdputs.c",
            "lib/mes/ntoab.c",
            "lib/ctype/isdigit.c",
            "lib/ctype/isxdigit.c",
            "lib/ctype/isspace.c",
            "lib/ctype/isnumber.c",
            "lib/mes/abtol.c",
            "lib/stdlib/atoi.c",
            "lib/string/memcpy.c",
            "lib/stdlib/free.c",
            "lib/stdlib/realloc.c",
            "lib/string/strcpy.c",
            "lib/mes/itoa.c",
            "lib/mes/ltoa.c",
            "lib/mes/fdungetc.c",
            "lib/posix/setenv.c",
            "lib/linux/access.c",
            "include/linux/m2/kernel-stat.h",
            "include/sys/stat.h",
            "lib/linux/chmod.c",
            "lib/linux/ioctl3.c",
            "include/sys/ioctl.h",
            "lib/m2/isatty.c",
            "include/signal.h",
            "lib/linux/fork.c",
            "lib/m2/execve.c",
            "lib/m2/execv.c",
            "include/sys/resource.h",
            "lib/linux/wait4.c",
            "lib/linux/waitpid.c",
            "lib/linux/gettimeofday.c",
            "lib/linux/clock_gettime.c",
            "lib/m2/time.c",
            "lib/linux/_getcwd.c",
            "include/limits.h",
            "lib/m2/getcwd.c",
            "lib/linux/dup.c",
            "lib/linux/dup2.c",
            "lib/string/strcmp.c",
            "lib/string/memcmp.c",
            "lib/linux/uname.c",
            "lib/linux/unlink.c",
            "include/fcntl.h",
            "src/builtins.c",
            "src/core.c",
            "src/display.c",
            "src/eval-apply.c",
            "src/gc.c",
            "src/hash.c",
            "src/lib.c",
            "src/m2.c",
            "src/math.c",
            "src/mes.c",
            "src/module.c",
            "include/signal.h",
            "src/posix.c",
            "src/reader.c",
            "src/stack.c",
            "src/string.c",
            "src/struct.c",
            "src/symbol.c",
            "src/variable.c",
            "src/vector.c",
            # needed for later steps of the build:
            "lib/m2/x86_64/x86_64_defs.M1",
            "lib/x86_64-mes/x86_64.M1",
            "lib/linux/x86_64-mes-m2/crt1.M1",
            # GUILE_LOAD_PATH files
            "mes/module/ice-9/rdelim.scm",
            "mes/module/ice-9/ftw.scm",
            "mes/module/ice-9/match.scm",
            "mes/module/ice-9/popen.scm",
            "mes/module/ice-9/i18n.scm",
            "mes/module/ice-9/optargs.scm",
            "mes/module/ice-9/regex.scm",
            "mes/module/ice-9/pregexp.upstream.scm",
            "mes/module/ice-9/receive.scm",
            "mes/module/ice-9/pretty-print.scm",
            "mes/module/ice-9/getopt-long.scm",
            "mes/module/rnrs/io/ports.scm",
            "mes/module/rnrs/arithmetic/bitwise.scm",
            "mes/module/rnrs/bytevectors.scm",
            "mes/module/sxml/xpath.scm",
            "mes/module/sxml/fold.scm",
            "mes/module/mes/fluids.mes",
            "mes/module/mes/test.mes",
            "mes/module/mes/guile.scm",
            "mes/module/mes/lalr.scm",
            "mes/module/mes/repl.scm",
            "mes/module/mes/psyntax.pp.header",
            "mes/module/mes/guile-module.mes",
            "mes/module/mes/catch.mes",
            "mes/module/mes/syntax.scm",
            "mes/module/mes/type-0.mes",
            "mes/module/mes/main.scm",
            "mes/module/mes/module.mes",
            "mes/module/mes/match.scm",
            "mes/module/mes/quasiquote.mes",
            "mes/module/mes/base.mes",
            "mes/module/mes/syntax.mes",
            "mes/module/mes/boot-5.scm",
            "mes/module/mes/scm.mes",
            "mes/module/mes/psyntax.pp",
            "mes/module/mes/boot-03.scm",
            "mes/module/mes/boot-0.scm",
            "mes/module/mes/quasisyntax.scm",
            "mes/module/mes/display.mes",
            "mes/module/mes/posix.mes",
            "mes/module/mes/let.mes",
            "mes/module/mes/mes-0.scm",
            "mes/module/mes/boot-01.scm",
            "mes/module/mes/simple-format.mes",
            "mes/module/mes/psyntax.ss",
            "mes/module/mes/guile.mes",
            "mes/module/mes/boot-00.scm",
            "mes/module/mes/boot-02.scm",
            "mes/module/system/base/lalr.scm",
            "mes/module/system/base/pmatch.scm",
            "mes/module/srfi/srfi-16.mes",
            "mes/module/srfi/srfi-13.mes",
            "mes/module/srfi/srfi-11.scm",
            "mes/module/srfi/srfi-39.scm",
            "mes/module/srfi/srfi-26.scm",
            "mes/module/srfi/srfi-43.scm",
            "mes/module/srfi/srfi-8.scm",
            "mes/module/srfi/srfi-1.scm",
            "mes/module/srfi/srfi-1-guile.scm",
            "mes/module/srfi/srfi-37.scm",
            "mes/module/srfi/srfi-1.mes",
            "mes/module/srfi/srfi-14.scm",
            "mes/module/srfi/srfi-2.scm",
            "mes/module/srfi/srfi-9-vector.mes",
            "mes/module/srfi/srfi-9/gnu.scm",
            "mes/module/srfi/srfi-9/gnu-vector.mes",
            "mes/module/srfi/srfi-9/gnu-struct.mes",
            "mes/module/srfi/srfi-16.scm",
            "mes/module/srfi/srfi-132.scm",
            "mes/module/srfi/srfi-14.mes",
            "mes/module/srfi/srfi-9.scm",
            "mes/module/srfi/srfi-9-struct.mes",
            "mes/module/nyacc/compat18.scm",
            "mes/module/nyacc/lang/c99/pprint.scm",
            "module/mescc.scm",
            "module/mescc/mescc.scm",
            "module/mescc/armv4/info.scm",
            "module/mescc/armv4/as.scm",
            "module/mescc/x86_64/info.scm",
            "module/mescc/x86_64/as.scm",
            "module/mescc/riscv64/info.scm",
            "module/mescc/riscv64/as.scm",
            "module/mescc/info.scm",
            "module/mescc/as.scm",
            "module/mescc/compile.scm",
            "module/mescc/preprocess.scm",
            "module/mescc/M1.scm",
            "module/mescc/i386/info.scm",
            "module/mescc/i386/as.scm",
            "module/mes/guile.scm",
            "module/mes/test.scm",
            "module/mes/misc.scm",
            "module/mes/mes-0.scm",
            "module/mes/getopt-long.scm",
        ],
    ),
)

write_file(
    name="config.h",
    content="""
#undef SYSTEM_LIBC
#define MES_VERSION "{}"
""".format(VERSION),
)

M2_Planet(
    name="mes.M1",
    tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    arch_stage0=CPU_0,
    arch_mes=MES_CPU,
    defines=[
        "__{}__=1".format(MES_CPU),
        "__linux__=1",
    ],
    srcs=[":config.h"]
    + map(
        lambda x: ":mes-{}[{}]".format(VERSION, x),
        [
            "include/mes/lib-mini.h",
            "include/mes/lib.h",
            f"lib/linux/{MES_CPU}-mes-m2/crt1.c",
            "lib/mes/__init_io.c",
            f"lib/linux/{MES_CPU}-mes-m2/_exit.c",
            f"lib/linux/{MES_CPU}-mes-m2/_write.c",
            "lib/mes/globals.c",
            "lib/m2/cast.c",
            "lib/stdlib/exit.c",
            "lib/mes/write.c",
            f"include/linux/{MES_CPU}/syscall.h",
            f"lib/linux/{MES_CPU}-mes-m2/syscall.c",
            "lib/stub/__raise.c",
            "lib/linux/brk.c",
            "lib/linux/malloc.c",
            "lib/string/memset.c",
            "lib/linux/read.c",
            "lib/mes/fdgetc.c",
            "lib/stdio/getchar.c",
            "lib/stdio/putchar.c",
            "lib/stub/__buffered_read.c",
            "include/errno.h",
            "include/fcntl.h",
            "lib/linux/_open3.c",
            "lib/linux/open.c",
            "lib/mes/mes_open.c",
            "lib/string/strlen.c",
            "lib/mes/eputs.c",
            "lib/mes/fdputc.c",
            "lib/mes/eputc.c",
            "include/time.h",
            "include/sys/time.h",
            "include/m2/types.h",
            "include/sys/types.h",
            "include/sys/utsname.h",
            "include/mes/mes.h",
            "include/mes/builtins.h",
            "include/mes/constants.h",
            "include/mes/symbols.h",
            "lib/mes/__assert_fail.c",
            "lib/mes/assert_msg.c",
            "lib/mes/fdputc.c",
            "lib/string/strncmp.c",
            "lib/posix/getenv.c",
            "lib/mes/fdputs.c",
            "lib/mes/ntoab.c",
            "lib/ctype/isdigit.c",
            "lib/ctype/isxdigit.c",
            "lib/ctype/isspace.c",
            "lib/ctype/isnumber.c",
            "lib/mes/abtol.c",
            "lib/stdlib/atoi.c",
            "lib/string/memcpy.c",
            "lib/stdlib/free.c",
            "lib/stdlib/realloc.c",
            "lib/string/strcpy.c",
            "lib/mes/itoa.c",
            "lib/mes/ltoa.c",
            "lib/mes/fdungetc.c",
            "lib/posix/setenv.c",
            "lib/linux/access.c",
            "include/linux/m2/kernel-stat.h",
            "include/sys/stat.h",
            "lib/linux/chmod.c",
            "lib/linux/ioctl3.c",
            "include/sys/ioctl.h",
            "lib/m2/isatty.c",
            "include/signal.h",
            "lib/linux/fork.c",
            "lib/m2/execve.c",
            "lib/m2/execv.c",
            "include/sys/resource.h",
            "lib/linux/wait4.c",
            "lib/linux/waitpid.c",
            "lib/linux/gettimeofday.c",
            "lib/linux/clock_gettime.c",
            "lib/m2/time.c",
            "lib/linux/_getcwd.c",
            "include/limits.h",
            "lib/m2/getcwd.c",
            "lib/linux/dup.c",
            "lib/linux/dup2.c",
            "lib/string/strcmp.c",
            "lib/string/memcmp.c",
            "lib/linux/uname.c",
            "lib/linux/unlink.c",
            "include/fcntl.h",
            "src/builtins.c",
            "src/core.c",
            "src/display.c",
            "src/eval-apply.c",
            "src/gc.c",
            "src/hash.c",
            "src/lib.c",
            "src/m2.c",
            "src/math.c",
            "src/mes.c",
            "src/module.c",
            "include/signal.h",
            "src/posix.c",
            "src/reader.c",
            "src/stack.c",
            "src/string.c",
            "src/struct.c",
            "src/symbol.c",
            "src/variable.c",
            "src/vector.c",
        ],
    ),
)

blood_elf(
    name="mes.blood-elf-M1",
    args=["--64", "--little-endian"],
    tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    srcs=[":mes.M1"],
)

M1(
    name="mes.hex2",
    tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    args=[
        "--architecture",
        CPU_0,
        "--little-endian",
    ],
    srcs=[
        f"cellar//bootstrap/stage0-posix/m2-libc:{CPU_0}/{CPU_0}_defs.M1",
    ]
    + map(
        lambda x: f":mes-{VERSION}[{x}]",
        [
            f"lib/{MES_CPU}-mes/{MES_CPU}.M1",
            f"lib/linux/{MES_CPU}-mes-m2/crt1.M1",
        ],
    )
    + [
        ":mes.M1",
        ":mes.blood-elf-M1",
    ],
)

hex2(
    name="mes.bin",
    tools="cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
    args=[
        "--architecture",
        CPU_0,
        "--little-endian",
        "--base-address",
        "0x1000000",
    ],
    srcs=[
        f"cellar//bootstrap/stage0-posix/m2-libc:{CPU_0}/ELF-{CPU_0}.hex2",
        ":mes.hex2",
    ],
)

mes_bins()
