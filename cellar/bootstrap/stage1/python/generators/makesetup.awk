# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Writes Modules/config.c from config.c.in as Modules/makesetup does: each
# built-in module's init function is declared before MARKER 1 and listed in
# the table before MARKER 2. modules names them, separated by spaces.

BEGIN {
    count = split(modules, module, " ")
}

/MARKER 1/ {
    for (i = 1; i <= count; i++)
        print "extern PyObject* PyInit_" module[i] "(void);"
}

/MARKER 2/ {
    for (i = 1; i <= count; i++)
        print "    {\"" module[i] "\", PyInit_" module[i] "},"
}

{
    print
}
