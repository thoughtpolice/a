# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# usr/include/Makefile's header test. Every exported header compiles alone,
# included twice, against the C library, and never reaches <stdlib.h> or
# <stdbool.h>.
set -euo pipefail
trap 'echo "header test failed at line $LINENO" >&2' ERR
headers=$1
dummy=$2
gcc=$3
tools=$4
compiler_headers=$5
libc=$6
PATH=$7
cc=("$gcc" -B"$tools/" -nostdinc -isystem "$compiler_headers" -isystem "$libc")
# UAPI_CFLAGS with x86_64's -m64.
flags=(-std=c90 -Wall -Werror=implicit-function-declaration -m64 -I "$headers" -I "$dummy" -fsyntax-only -Werror -x c /dev/null)
# no-header-test for x86. The kernel compiles an empty file for these.
excluded=" asm/ucontext.h drm/vmwgfx_drm.h linux/am437x-vpfe.h linux/coda.h
linux/cyclades.h linux/errqueue.h linux/hdlc/ioctl.h linux/ivtv.h
linux/matroxfb.h linux/omap3isp.h linux/omapfb.h linux/patchkey.h
linux/phonet.h linux/sctp.h linux/sysctl.h linux/usb/audio.h
linux/v4l2-mediabus.h linux/v4l2-subdev.h linux/videodev2.h
linux/vm_sockets.h sound/asequencer.h sound/asoc.h sound/asound.h
sound/compress_offload.h sound/emu10k1.h sound/sfnt_info.h xen/evtchn.h
xen/gntdev.h xen/privcmd.h "
excluded=${excluded//$'\n'/ }
list=$(cd "$headers" && find . -name '*.h' | sed 's|^\./||' | sort)
tested=0
for header in $list; do
    case $header in asm-generic/*) continue ;; esac
    case $excluded in *" $header "*) continue ;; esac
    "${cc[@]}" "${flags[@]}" -include "$headers/$header" -include "$headers/$header"
    tested=$((tested + 1))
done
[ "$tested" -gt 0 ]
printf 'passed\n' > passed
