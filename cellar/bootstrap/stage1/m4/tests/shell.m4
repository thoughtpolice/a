dnl SPDX-FileCopyrightText: 2026 Austin Seipp
dnl SPDX-License-Identifier: Apache-2.0
syscmd(`printf "direct\n"')dnl
esyscmd(`printf "captured\n"')dnl
syscmd(`exit 7')dnl
sysval
esyscmd(`read line <<EOF
here document
EOF
printf "%s\n" "$line"')dnl
