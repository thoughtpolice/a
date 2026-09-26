/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "config.h"
#include "system.h"
#include "cpplib.h"

const char *progname = "gcc40-cpp-test";

int main(int argc, char **argv)
{
    struct line_maps lines;
    cpp_reader *reader;
    const cpp_token *token;
    int failed, unicode = 0;
    if (argc != 2) return 2;
    linemap_init(&lines);
    reader = cpp_create_reader(CLK_GNUC99, NULL, &lines);
    cpp_post_options(reader);
    cpp_init_iconv(reader);
    cpp_set_include_chains(reader, NULL, NULL, 0);
    if (!cpp_read_main_file(reader, argv[1])) return 1;
    cpp_init_builtins(reader, 0);
    while ((token = cpp_get_token(reader))->type != CPP_EOF) {
        if (token->type == CPP_PADDING) continue;
        if (token->type == CPP_STRING &&
            !strcmp((const char *)token->val.str.text, "\"\\u03b1\"")) {
            cpp_string decoded;
            if (!cpp_interpret_string(reader, &token->val.str, 1, &decoded, 0)) return 1;
            if (decoded.len != 3 || memcmp(decoded.text, "\xce\xb1", 3)) return 1;
            free((void *)decoded.text);
            unicode = 1;
        }
        puts((const char *)cpp_token_as_text(reader, token));
    }
    failed = cpp_finish(reader, NULL);
    cpp_destroy(reader);
    linemap_free(&lines);
    return failed || !unicode ? 1 : 0;
}
