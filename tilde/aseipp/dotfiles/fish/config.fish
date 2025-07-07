# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

function fish_greeting
    echo logged into $hostname on (date +%T)
end

if status is-interactive
    # Commands to run in interactive sessions can go here
    set -gx EDITOR hx

    atuin init fish | source
    zoxide init fish | source
    direnv hook fish | source

    if test -d /mnt/c/Users/jasei
        # WSL2 case: this lets us use 'code .' and launch on the Windows Desktop
        fish_add_path -a "/mnt/c/Users/jasei/AppData/Local/Programs/Microsoft VS Code/bin"
    end

    if test -d ~/bin
        fish_add_path -a ~/bin
    end
end
