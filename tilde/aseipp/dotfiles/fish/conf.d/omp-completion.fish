# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -g __omp_completion_loaded false

function __check_omp_availability --on-variable PATH
    # Avoid reloading if already loaded
    if $__omp_completion_loaded
        return
    end

    # Check if omp is now available
    if command -q omp
        # Generate and load completions
        omp completions fish | source
        set -g __omp_completion_loaded true
    end
end
