// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Render CommonMark to HTML, and walk the parsed tree.

#include <cmark-gfm.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    const char *md = "# Title\n\nSome *emphasis* and `code` &amp; [a link](https://x.org).\n";
    char *html = cmark_markdown_to_html(md, strlen(md), CMARK_OPT_DEFAULT);
    const char *expect =
        "<h1>Title</h1>\n"
        "<p>Some <em>emphasis</em> and <code>code</code> &amp; <a href=\"https://x.org\">a link</a>.</p>\n";
    if (strcmp(html, expect)) return fprintf(stderr, "got:\n%s", html), 1;
    free(html);

    cmark_node *doc = cmark_parse_document(md, strlen(md), CMARK_OPT_SOURCEPOS);
    cmark_node *heading = cmark_node_first_child(doc);
    if (cmark_node_get_type(heading) != CMARK_NODE_HEADING || cmark_node_get_heading_level(heading) != 1 ||
        cmark_node_get_start_line(cmark_node_next(heading)) != 3)
        return fprintf(stderr, "unexpected tree\n"), 1;
    cmark_node_free(doc);
    return 0;
}
