/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include "libiberty.h"
#include "demangle.h"
#include "md5.h"
#include "sha1.h"
#include "hashtab.h"
#include "obstack.h"
#include "xregex.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "check failed at %d\n", __LINE__); return 1; } } while (0)
#define obstack_chunk_alloc malloc
#define obstack_chunk_free free
static int string_equal(const void *a, const void *b) {
    return !strcmp(a,b);
}
int main(int argc, char **argv) {
    char *s; unsigned char digest[20]; char **words; struct obstack stack;
    regex_t re; regmatch_t matches[2]; htab_t table; void **slot;
    if (argc > 1 && !strcmp(argv[1], "child")) return 17;
    if (argc > 1) {
        FILE *f;
        s = make_temp_file(".test");
        /* Without the TMPDIR patch, libiberty falls back to a system
           directory instead of exiting 1, so that has its own status. */
        if (!s || strncmp(s,"./",2)) {
            fprintf(stderr, "temporary file outside TMPDIR: %s\n", s ? s : "(none)");
            if (s) unlink(s);
            return 2;
        }
        f = fopen(s,"w+"); CHECK(f);
        CHECK(fputs("temporary",f)>=0 && fseek(f,0,SEEK_SET)==0);
        CHECK(fgetc(f)=='t' && fclose(f)==0 && unlink(s)==0); free(s);
        f = fopen("passed","w"); CHECK(f);
        CHECK(fputs("passed\n",f)>=0 && fclose(f)==0); return 0;
    }
    s = cplus_demangle("_ZN3Foo3barEi", DMGL_PARAMS | DMGL_ANSI);
    CHECK(s && strcmp(s,"Foo::bar(int)")==0); free(s);
    md5_buffer("abc",3,digest);
    CHECK(memcmp(digest,"\x90\x01\x50\x98\x3c\xd2\x4f\xb0\xd6\x96\x3f\x7d\x28\xe1\x7f\x72",16)==0);
    sha1_buffer("abc", 3, digest);
    CHECK(memcmp(digest, "\xa9\x99\x3e\x36\x47\x06\x81\x6a\xba\x3e\x25\x71\x78\x50\xc2\x6c\x9c\xd0\xd8\x9d", 20)==0);
    CHECK(xcrc32((const unsigned char *)"123456789", 9, 0xffffffff) == 0x0376e6e7);
    words=buildargv("one 'two three' four\\ five");
    CHECK(words && !strcmp(words[0],"one") && !strcmp(words[1],"two three") && !strcmp(words[2],"four five") && !words[3]); freeargv(words);
    obstack_init(&stack); obstack_grow(&stack,"abc",3); obstack_1grow(&stack,0);
    s=obstack_finish(&stack); CHECK(!strcmp(s,"abc")); obstack_free(&stack,0);
    table=htab_create(7,htab_hash_string,string_equal,free);
    CHECK(table); slot=htab_find_slot(table,"key",INSERT); CHECK(slot); *slot=xstrdup("key");
    CHECK(!strcmp(htab_find(table,"key"),"key")); htab_delete(table);
    CHECK(regcomp(&re,"([a-z]+)[0-9]+",REG_EXTENDED)==0);
    CHECK(regexec(&re,"!abc123",2,matches,0)==0 && matches[1].rm_so==1 && matches[1].rm_eo==4);
    regfree(&re);
    {
        char *error_format, *error_argument;
        char *args[] = {argv[0], "child", NULL};
        int status, pid = pexecute(argv[0], args, "test", NULL,
                                  &error_format, &error_argument,
                                  PEXECUTE_FIRST | PEXECUTE_LAST);
        CHECK(pid > 0 && pwait(pid, &status, 0) == pid);
        CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 17);
    }
    return 0;
}
