;; c.sls -- C and its many relatives: C++, Rust, Go, JavaScript, Java, Zig...
;;
;; SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
;; SPDX-License-Identifier: Apache-2.0
(library (quad ext c)
  (export c-syntax c-mode)
  (import (chezscheme) (quad util) (quad text) (quad syntax) (quad buffer)
          (quad editor) (quad commands))

  (define c-syntax
    (make-syntax
     'c #f '("//") '(("/*" . "*/")) '(#\" #\') default-word-char?
     (keyword-table
      '(keyword "if" "else" "for" "while" "do" "switch" "case" "default" "break"
                "continue" "return" "goto" "sizeof" "typedef" "struct" "union" "enum"
                "static" "extern" "const" "volatile" "inline" "register" "restrict"
                "auto" "_Alignof" "_Static_assert" "fn" "let" "mut" "pub" "impl" "use"
                "mod" "match" "loop" "in" "where" "trait" "type" "func" "package"
                "import" "var" "class" "namespace" "template" "public" "private")
      '(keyword.special "#include" "#define" "#if" "#ifdef" "#ifndef" "#endif" "#else"
                        "#elif" "#pragma" "#undef" "#error")
      '(type "int" "char" "void" "long" "short" "unsigned" "signed" "float" "double"
             "bool" "size_t" "ssize_t" "uint8_t" "uint16_t" "uint32_t" "uint64_t"
             "int8_t" "int16_t" "int32_t" "int64_t" "uintptr_t" "intptr_t" "u8" "u16"
             "u32" "u64" "i8" "i16" "i32" "i64" "usize" "isize" "str" "String" "Self")
      '(constant.builtin "NULL" "true" "false" "nullptr" "None" "Some" "Ok" "Err"))
     '() #f "// " "    "))

  (define c-mode (define-major-mode! 'c c-syntax))

  (at-load
   (add-auto-mode! '("c" "h" "cc" "cpp" "hpp" "cxx" "rs" "go" "js" "ts" "tsx" "jsx" "java" "zig" "swift" "kt" "cs" "proto") 'c)))
