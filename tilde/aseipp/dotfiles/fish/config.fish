# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

function fish_greeting
    echo logged into $hostname on (date +%T)
end

if status is-interactive
    # Commands to run in interactive sessions can go here
    direnv hook fish | source
end
