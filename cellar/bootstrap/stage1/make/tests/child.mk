# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: MIT
.RECIPEPREFIX = >
.ONESHELL:
.PHONY: child
child:
>@value=42
>test "$$value" -eq 42
>test "$(MAKELEVEL)" -eq 1
>case '$(MAKEFLAGS)' in *--jobserver-auth=*) ;; *) exit 1;; esac
>printf 'recursive jobserver\n' > recursive.txt
