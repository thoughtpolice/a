# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

set -g __buck2_completion_loaded false

function __check_buck2_availability --on-variable PATH
    # Avoid reloading if already loaded
    if $__buck2_completion_loaded
        return
    end

    # Check if buck2 is now available
    if command -q buck2
        # Generate and load completions
        buck2 completion fish | source
        set -g __buck2_completion_loaded true
    end
end
