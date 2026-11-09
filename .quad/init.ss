;; .quad/init.ss -- quad's configuration for this repository
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
;;
;; quad loads this once you trust it (it asks), for the files under the
;; repository root; see (quad project) in tilde/aseipp/quad/core/project.sls.

;; Language servers: the ones Claude Code's LSP plugin defines, run the same
;; way, so that Buck answers them: clangd with a compilation database from
;; the build, rust-analyzer finding crates and checking saved files through
;; Buck, gopls with Buck as its package driver, and Lean taking each file's
;; imports from Buck (see buck/toolchains/{cxx,rust,golang,lean}/lsp). The
;; smoke tests there keep that file in step with Helix's and OMP's
;; configuration, so quad reads it rather than keeping a copy of its own.
;; Like Helix, quad starts them at the repository root. .quad/files names
;; that file, so trust covers it too.
(lsp-servers-from-json (project-path ".claude/marketplace/lsp/.lsp.json")
                       'root (project-root))

;; Deno for the TypeScript under a deno.json, as src/rtlcc/.helix has it.
(define-lsp-server! 'deno '("deno" "lsp") '("ts" "tsx" "js" "jsx")
  'roots '("deno.json" "deno.jsonc") 'require-root #t
  'languages '(("ts" . "typescript") ("tsx" . "typescriptreact")
               ("js" . "javascript") ("jsx" . "javascriptreact")))

;; As .helix/config.toml has it: no trailing whitespace, and one newline at
;; the end, when saving.
(project-set! 'trim-trailing-whitespace #t)
(project-set! 'trim-final-newlines #t)
