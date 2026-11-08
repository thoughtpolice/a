# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

import sys

from pkg.helper import NAME

print("{}: {} {}".format(NAME, __name__, sys.argv[1:]))
