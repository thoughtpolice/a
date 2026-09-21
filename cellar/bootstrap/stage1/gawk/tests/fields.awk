# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
BEGIN { FS = "[:,]"; OFS = ":" }
{ totals[$1] += $2; count[$1]++; rows++ }
END { print rows, totals["red"], count["red"], totals["blue"]; printf "%.2f\n", totals["red"] / count["red"] }
