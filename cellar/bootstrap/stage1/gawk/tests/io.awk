# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
BEGIN {
    cmd = "printf \"inbound\\n\""
    if ((cmd | getline line) != 1 || close(cmd) != 0) exit 1
    print line
    cmd = "read value; printf \"out:%s\\n\" \"$value\""
    print "outbound" | cmd
    if (close(cmd) != 0) exit 2
    print system("exit 7")
    print "stored" > "record"
    close("record")
    if ((getline line < "record") != 1) exit 3
    close("record"); print line
}
