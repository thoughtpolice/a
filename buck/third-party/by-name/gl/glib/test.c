/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* The parts of GLib QEMU and libslirp lean on: containers, strings, the
 * main loop and its sources, threads and their primitives, and the
 * monotonic clock. Each check aborts with a message when it fails. */

#include <glib.h>
#include <glib/gstdio.h>
#include <glib-unix.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

static gboolean on_timeout(gpointer data)
{
    GMainLoop *loop = data;
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

static gboolean on_idle(gpointer data)
{
    int *count = data;
    return ++*count < 3 ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

static gpointer worker(gpointer data)
{
    GAsyncQueue *queue = data;
    for (int i = 1; i <= 100; i++) {
        g_async_queue_push(queue, GINT_TO_POINTER(i));
    }
    return GINT_TO_POINTER(42);
}

static void test_containers(void)
{
    GHashTable *table = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    for (int i = 0; i < 1000; i++) {
        g_hash_table_insert(table, g_strdup_printf("key-%d", i), GINT_TO_POINTER(i));
    }
    g_assert_cmpuint(g_hash_table_size(table), ==, 1000);
    g_assert_cmpint(GPOINTER_TO_INT(g_hash_table_lookup(table, "key-777")), ==, 777);
    g_hash_table_unref(table);

    GPtrArray *array = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(array, g_strdup("b"));
    g_ptr_array_add(array, g_strdup("a"));
    g_assert_cmpuint(array->len, ==, 2);
    g_ptr_array_unref(array);

    GQueue queue = G_QUEUE_INIT;
    g_queue_push_tail(&queue, GINT_TO_POINTER(1));
    g_queue_push_head(&queue, GINT_TO_POINTER(2));
    g_assert_cmpint(GPOINTER_TO_INT(g_queue_pop_head(&queue)), ==, 2);
    g_queue_clear(&queue);

    GTree *tree = g_tree_new((GCompareFunc)strcmp);
    g_tree_insert(tree, "x", "1");
    g_tree_insert(tree, "y", "2");
    g_assert_cmpstr(g_tree_lookup(tree, "y"), ==, "2");
    g_tree_destroy(tree);

    GSList *list = g_slist_prepend(NULL, "z");
    list = g_slist_append(list, "w");
    g_assert_cmpuint(g_slist_length(list), ==, 2);
    g_slist_free(list);
}

static void test_strings(void)
{
    g_autoptr(GString) s = g_string_new("hello");
    g_string_append_printf(s, ", %s %" G_GUINT64_FORMAT, "world", (guint64)G_MAXUINT64);
    g_assert_cmpstr(s->str, ==, "hello, world 18446744073709551615");

    g_auto(GStrv) parts = g_strsplit("a,b,,c", ",", -1);
    g_assert_cmpuint(g_strv_length(parts), ==, 4);
    g_autofree char *joined = g_strjoinv("-", parts);
    g_assert_cmpstr(joined, ==, "a-b--c");

    guint64 value = 0;
    g_assert_false(g_ascii_string_to_unsigned("0x10", 10, 0, G_MAXUINT64, &value, NULL));
    g_assert_true(g_ascii_string_to_unsigned("4096", 10, 0, G_MAXUINT64, &value, NULL));
    g_assert_cmpuint(value, ==, 4096);

    g_assert_true(g_utf8_validate("\xc3\xa9t\xc3\xa9", -1, NULL));
    g_autofree char *upper = g_utf8_strup("\xc3\xa9t\xc3\xa9", -1);
    g_assert_cmpstr(upper, ==, "\xc3\x89T\xc3\x89");

    g_autofree char *path = g_build_filename("a", "b", "c.txt", NULL);
    g_assert_cmpstr(path, ==, "a/b/c.txt");

    g_autoptr(GError) error = NULL;
    g_set_error(&error, G_FILE_ERROR, G_FILE_ERROR_NOENT, "missing %s", "file");
    g_assert_error(error, G_FILE_ERROR, G_FILE_ERROR_NOENT);
}

static void test_main_loop(void)
{
    GMainLoop *loop = g_main_loop_new(NULL, FALSE);
    int idles = 0;
    gint64 start = g_get_monotonic_time();

    g_idle_add(on_idle, &idles);
    g_timeout_add(50, on_timeout, loop);
    g_main_loop_run(loop);

    g_assert_cmpint(idles, ==, 3);
    g_assert_cmpint(g_get_monotonic_time() - start, >=, 50 * 1000);
    g_main_loop_unref(loop);

    /* A unix fd source on a pipe, as QEMU's event loop watches its fds. */
    int fds[2];
    g_assert_true(g_unix_open_pipe(fds, O_CLOEXEC, NULL));
    g_assert_cmpint(write(fds[1], "x", 1), ==, 1);
    GPollFD pfd = {.fd = fds[0], .events = G_IO_IN};
    g_assert_cmpint(g_poll(&pfd, 1, 1000), ==, 1);
    g_assert_true(pfd.revents & G_IO_IN);
    close(fds[0]);
    close(fds[1]);
}

static void test_threads(void)
{
    GAsyncQueue *queue = g_async_queue_new();
    GThread *thread = g_thread_new("worker", worker, queue);
    int sum = 0;
    for (int i = 0; i < 100; i++) {
        sum += GPOINTER_TO_INT(g_async_queue_pop(queue));
    }
    g_assert_cmpint(GPOINTER_TO_INT(g_thread_join(thread)), ==, 42);
    g_assert_cmpint(sum, ==, 5050);
    g_async_queue_unref(queue);

    static GMutex mutex;
    static GCond cond;
    g_mutex_lock(&mutex);
    g_assert_false(g_cond_wait_until(&cond, &mutex, g_get_monotonic_time() + 1000));
    g_mutex_unlock(&mutex);

    gint atomic = 0;
    g_atomic_int_inc(&atomic);
    g_assert_true(g_atomic_int_compare_and_exchange(&atomic, 1, 5));
    g_assert_cmpint(g_atomic_int_get(&atomic), ==, 5);
}

static void test_files(void)
{
    g_autoptr(GError) error = NULL;
    g_autofree char *dir = g_dir_make_tmp("glib-test-XXXXXX", &error);
    g_assert_no_error(error);
    g_autofree char *file = g_build_filename(dir, "f", NULL);
    g_assert_true(g_file_set_contents(file, "contents", -1, &error));
    g_autofree char *read = NULL;
    gsize len = 0;
    g_assert_true(g_file_get_contents(file, &read, &len, &error));
    g_assert_cmpstr(read, ==, "contents");
    g_assert_cmpint(g_unlink(file), ==, 0);
    g_assert_cmpint(g_rmdir(dir), ==, 0);
}

int main(int argc, char **argv)
{
    /* A critical from a misused API fails the test too. */
    g_log_set_always_fatal(G_LOG_LEVEL_CRITICAL | G_LOG_LEVEL_WARNING);

    g_assert_cmpuint(glib_major_version, ==, GLIB_MAJOR_VERSION);
    g_assert_cmpuint(glib_minor_version, ==, GLIB_MINOR_VERSION);
    g_assert_null(glib_check_version(2, 66, 0));

    test_containers();
    test_strings();
    test_main_loop();
    test_threads();
    test_files();

    g_print("glib %u.%u.%u ok\n", glib_major_version, glib_minor_version, glib_micro_version);
    return 0;
}
