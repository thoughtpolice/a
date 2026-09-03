// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// An independent SDK client, linked with the same allocator, component adapter,
// platform and native HAL as Doom. The host supplies deterministic time and the
// four documented input transitions; no Doom engine code is linked.
#include "console.h"
#include "runtime.h"
#include "stream.h"

static uint64_t start_ms;
static uint64_t last_ms;
static uint32_t frames;
static bool expect_saved;
static bool overlay;
static bool fast;
static bool persistent;

static size_t text_len(const char* text) {
  size_t len = 0;
  while (text[len] != '\0') {
    len++;
  }
  return len;
}

static void require(bool condition, const char* message) {
  if (!condition) {
    console_log(CONSOLE_SDK_LOG_LEVEL_ERROR, message, text_len(message));
    console_process_exit(1);
  }
}

static void pass(const char* message) {
  console_log(CONSOLE_SDK_LOG_LEVEL_INFO, message, text_len(message));
}

static bool text_equals(console_string text, const char* expected) {
  size_t len = text_len(expected);
  if (text.len != len) {
    return false;
  }
  for (size_t i = 0; i < len; i++) {
    if (text.data[i] != expected[i]) {
      return false;
    }
  }
  return true;
}

static bool check_arguments(void) {
  bool invalid_framebuffer = false;
  bool trap = false;
  bool exit_seven = false;
  uint32_t count = console_process_arg_count();
  for (uint32_t i = 0; i < count; i++) {
    console_string arg = console_process_arg(i);
    invalid_framebuffer |= text_equals(arg, "--invalid-framebuffer");
    trap |= text_equals(arg, "--trap");
    exit_seven |= text_equals(arg, "--exit-7");
    expect_saved |= text_equals(arg, "--expect-saved");
    overlay |= text_equals(arg, "--overlay");
    fast |= text_equals(arg, "--fast");
    persistent |= text_equals(arg, "--persistent");
    if (text_equals(arg, "--utf8-test")) {
      require(count - i >= 5, "FAIL sdk UTF-8 argument count");
      const char* expected[] = {"", "", "", "\xe2\x98\x83"};
      for (uint32_t j = 0; j < 4; j++) {
        console_string value = console_process_arg(i + j + 1);
        require(text_equals(value, expected[j]), "FAIL sdk UTF-8 argument contents");
        console_free_string(&value);
      }
    }
    console_free_string(&arg);
    require(arg.data == NULL && arg.len == 0, "FAIL sdk argument release");
  }
  if (trap) {
    __builtin_trap();
  }
  if (exit_seven) {
    console_process_exit(7);
  }
  for (unsigned i = 0; i < 8; i++) {
    console_string arg = console_process_arg(UINT32_MAX);
    require(arg.len == 0, "FAIL sdk missing argument");
    console_free_string(&arg);
  }
  pass("PASS sdk args");
  return invalid_framebuffer;
}

static void check_allocator(void) {
  require(cabi_realloc(NULL, 0, 1, 0) == NULL, "FAIL sdk empty allocation");
  uint8_t* data = cabi_realloc(NULL, 0, 16, 64);
  require(data != NULL && ((uintptr_t)data & 15) == 0, "FAIL sdk allocation alignment");
  for (unsigned i = 0; i < 64; i++) {
    data[i] = (uint8_t)(i ^ 0x5a);
  }
  data = cabi_realloc(data, 64, 16, 128);
  require(data != NULL && ((uintptr_t)data & 15) == 0, "FAIL sdk realloc alignment");
  for (unsigned i = 0; i < 64; i++) {
    require(data[i] == (uint8_t)(i ^ 0x5a), "FAIL sdk realloc contents");
  }
  require(cabi_realloc(data, 128, 16, 0) == NULL, "FAIL sdk zero-size release");

  console_free(NULL);
  uint8_t* allocations[4];
  const size_t sizes[] = {0, 1, 17, 4097};
  for (unsigned i = 0; i < 4; i++) {
    allocations[i] = console_malloc(sizes[i]);
    require(allocations[i] != NULL && ((uintptr_t)allocations[i] & 15) == 0,
            "FAIL sdk C allocation alignment");
    for (unsigned j = 0; j < i; j++) {
      require(allocations[i] != allocations[j], "FAIL sdk overlapping allocations");
    }
    for (size_t j = 0; j < sizes[i]; j++) {
      allocations[i][j] = (uint8_t)(j + i);
    }
  }
  for (unsigned i = 0; i < 4; i++) {
    for (size_t j = 0; j < sizes[i]; j++) {
      require(allocations[i][j] == (uint8_t)(j + i), "FAIL sdk C allocation contents");
    }
    console_free(allocations[i]);
  }
  size_t steady_pages = 0;
  for (unsigned i = 0; i < 16; i++) {
    data = console_malloc(65537);
    data[0] = 0x5a;
    data[65536] = 0xa5;
    console_free(data);
    size_t pages = __builtin_wasm_memory_size(0);
    if (i == 0) steady_pages = pages;
    else require(pages == steady_pages, "FAIL sdk C allocation leak");
  }
  // Generated ownership helpers and canonical imports must share the C
  // allocator, including size-less free() and realloc().
  for (unsigned i = 0; i < 32; i++) {
    uint8_t* generated = cabi_realloc(NULL, 0, 64, 65537);
    require(((uintptr_t)generated & 63) == 0, "FAIL sdk extended alignment");
    generated[0] = 0x3c;
    generated[65536] = 0xc3;
    generated = console_realloc(generated, 131073);
    require(generated[0] == 0x3c && generated[65536] == 0xc3 &&
            ((uintptr_t)generated & 63) == 0,
            "FAIL sdk generated realloc contents");
    game_list_u8_t list = {generated, 131073};
    game_list_u8_free(&list);
    game_string_t string = {0};
    game_string_dup(&string, "generated ownership");
    require(string.len == 19 && string.ptr[0] == 'g' && string.ptr[18] == 'p',
            "FAIL sdk generated string copy");
    game_string_free(&string);
    console_free(console_malloc(0));
    require(console_realloc(console_malloc(0), 0) == NULL,
            "FAIL sdk zero-size libc release");
    size_t pages = __builtin_wasm_memory_size(0);
    if (i == 0) steady_pages = pages;
    else require(pages == steady_pages, "FAIL sdk generated allocation leak");
  }
  console_bytes empty = {0};
  console_free_bytes(&empty);
  console_key_events events = {0};
  console_input_free_events(&events);
  pass("PASS sdk allocator");
}

static void check_small_files(void) {
  const char path[] = "contract.tmp";
  console_file file;
  require(console_files_open(path, sizeof(path) - 1, true, &file), "FAIL sdk create file");
  const uint8_t original[] = {'a', 'l', 'p', 'h', 'a'};
  const uint8_t patch[] = {'X', 'Y', 'Z'};
  require(console_file_write_at(file, 0, original, sizeof(original)) == 5,
          "FAIL sdk write file");
  require(console_file_write_at(file, 1, patch, sizeof(patch)) == 3,
          "FAIL sdk positional write");
  require(console_file_write_at(file, 0, NULL, 0) == 0, "FAIL sdk empty write");
  require(console_file_size(file) == 5, "FAIL sdk file size");
  console_file_close(file);
  require(console_files_open(path, sizeof(path) - 1, false, &file), "FAIL sdk reopen file");
  console_file_read_result read = console_file_read_at(file, 0, 8);
  require(read.status == 0 && read.data.len == 5, "FAIL sdk short read");
  const uint8_t expected[] = {'a', 'X', 'Y', 'Z', 'a'};
  for (unsigned i = 0; i < sizeof(expected); i++) {
    require(read.data.data[i] == expected[i], "FAIL sdk reopened contents");
  }
  console_free_bytes(&read.data);
  require(read.data.data == NULL && read.data.len == 0, "FAIL sdk read release");
  read = console_file_read_at(file, 5, 8);
  require(read.status == 0 && read.data.len == 0, "FAIL sdk EOF");
  console_free_bytes(&read.data);
  read = console_file_read_at(file, 0, 0);
  require(read.status == 0 && read.data.len == 0, "FAIL sdk empty read");
  console_free_bytes(&read.data);
  console_file_close(file);

  const char missing[] = "contract-missing.tmp";
  require(!console_files_open(missing, sizeof(missing) - 1, false, &file),
          "FAIL sdk missing file");
  const char wad[] = "doom2.wad";
  require(!console_files_open(wad, sizeof(wad) - 1, true, &file),
          "FAIL sdk read-only mount");
  require(console_files_open(wad, sizeof(wad) - 1, false, &file) &&
          console_file_size(file) >= 12,
          "FAIL sdk asset open");
  read = console_file_read_at(file, 0, 4);
  require(read.status == 0 && read.data.len == 4, "FAIL sdk asset header");
  require(read.data.data[0] == 'I' && read.data.data[1] == 'W' &&
          read.data.data[2] == 'A' && read.data.data[3] == 'D',
          "FAIL sdk IWAD contents");
  console_free_bytes(&read.data);
  require(console_file_write_at(file, 0, original, sizeof(original)) == -1,
          "FAIL sdk read-only handle");
  console_file_close(file);

  // Closing a handle is what closes the file, so opening far more files than
  // the host can hold at once works as long as each is closed in turn.
  for (unsigned i = 0; i < 256; i++) {
    require(console_files_open(wad, sizeof(wad) - 1, false, &file),
            "FAIL sdk reopen after close");
    console_file_close(file);
  }
  console_file files[8];
  for (unsigned i = 0; i < 8; i++) {
    require(console_files_open(wad, sizeof(wad) - 1, false, &files[i]),
            "FAIL sdk concurrent open");
    for (unsigned j = 0; j < i; j++) {
      require(files[i].__handle != files[j].__handle, "FAIL sdk distinct handles");
    }
  }
  for (unsigned i = 0; i < 8; i++) {
    require(console_file_size(files[i]) >= 12, "FAIL sdk concurrent size");
    console_file_close(files[i]);
  }
  pass("PASS sdk files");
}

static bool entry_is(const console_file_entry* entry, const char* name, uint64_t size,
                     bool directory) {
  console_string text = {(char*)entry->name.ptr, entry->name.len};
  return text_equals(text, name) && entry->size == size && entry->directory == directory;
}

static bool sorted(const console_file_entries* entries) {
  for (size_t i = 1; i < entries->len; i++) {
    const game_string_t* a = &entries->ptr[i - 1].name;
    const game_string_t* b = &entries->ptr[i].name;
    size_t common = a->len < b->len ? a->len : b->len;
    size_t j = 0;
    while (j < common && a->ptr[j] == b->ptr[j]) j++;
    if (j == common ? a->len >= b->len : a->ptr[j] > b->ptr[j]) return false;
  }
  return true;
}

static bool listing(const char* path, console_file_entries* entries) {
  return console_files_list_directory(path, text_len(path), entries) && sorted(entries);
}

static bool make_directory(const char* path) {
  return console_files_create_directory(path, text_len(path));
}

static bool remove_entry(const char* path) {
  return console_files_remove(path, text_len(path));
}

static bool move_entry(const char* from, const char* to) {
  return console_files_rename(from, text_len(from), to, text_len(to));
}

static void write_file(const char* path, const char* text) {
  console_file file;
  require(console_files_open(path, text_len(path), true, &file), "FAIL sdk create in directory");
  require(console_file_write_at(file, 0, (const uint8_t*)text, text_len(text)) == (int32_t)text_len(text),
          "FAIL sdk write in directory");
  console_file_close(file);
}

static void check_directories(void) {
  console_file_entries entries;
  console_file file;
  require(listing("", &entries), "FAIL sdk list root");
  bool asset = false;
  for (size_t i = 0; i < entries.len; i++) {
    asset |= entry_is(&entries.ptr[i], "doom2.wad", entries.ptr[i].size, false) &&
             entries.ptr[i].size >= 12;
  }
  require(asset, "FAIL sdk root lists the asset");
  console_files_free_entries(&entries);
  require(entries.ptr == NULL && entries.len == 0, "FAIL sdk entries release");
  require(listing(".", &entries), "FAIL sdk list root as dot");
  console_files_free_entries(&entries);
  require(!listing("contract-missing", &entries), "FAIL sdk list missing directory");
  require(!listing("doom2.wad", &entries), "FAIL sdk list a file");
  require(make_directory("") && make_directory("."), "FAIL sdk root exists");
  require(!make_directory("doom2.wad") && !make_directory("doom2.wad/below"),
          "FAIL sdk file in the way");

  require(make_directory("contract-dir/sub") && make_directory("contract-dir/sub"),
          "FAIL sdk create directory");
  require(listing("", &entries), "FAIL sdk list root again");
  bool created = false;
  for (size_t i = 0; i < entries.len; i++) created |= entry_is(&entries.ptr[i], "contract-dir", 0, true);
  require(created, "FAIL sdk root lists the directory");
  console_files_free_entries(&entries);
  require(listing("contract-dir", &entries) && entries.len == 1 && entry_is(&entries.ptr[0], "sub", 0, true),
          "FAIL sdk list created directory");
  console_files_free_entries(&entries);
  require(listing("contract-dir/sub", &entries) && entries.len == 0, "FAIL sdk list empty directory");
  console_files_free_entries(&entries);

  write_file("contract-dir/sub/b.txt", "bb");
  write_file("contract-dir/sub/a.txt", "aaa");
  require(listing("contract-dir/sub", &entries) && entries.len == 2 &&
          entry_is(&entries.ptr[0], "a.txt", 3, false) && entry_is(&entries.ptr[1], "b.txt", 2, false),
          "FAIL sdk list files");
  console_files_free_entries(&entries);
  write_file("contract-implicit/deep/file.txt", "x");
  require(listing("contract-implicit", &entries) && entries.len == 1 && entry_is(&entries.ptr[0], "deep", 0, true),
          "FAIL sdk implicit directories");
  console_files_free_entries(&entries);

  require(move_entry("contract-dir/sub/a.txt", "contract-dir/sub/c.txt"), "FAIL sdk rename");
  const char old_name[] = "contract-dir/sub/a.txt";
  require(!console_files_open(old_name, sizeof(old_name) - 1, false, &file), "FAIL sdk renamed file left");
  require(listing("contract-dir/sub", &entries) && entries.len == 2 &&
          entry_is(&entries.ptr[0], "b.txt", 2, false) && entry_is(&entries.ptr[1], "c.txt", 3, false),
          "FAIL sdk list after rename");
  console_files_free_entries(&entries);
  require(move_entry("contract-dir/sub/c.txt", "contract-dir/sub/b.txt"), "FAIL sdk rename over a file");
  require(listing("contract-dir/sub", &entries) && entries.len == 1 && entry_is(&entries.ptr[0], "b.txt", 3, false),
          "FAIL sdk list after replacing rename");
  console_files_free_entries(&entries);
  require(move_entry("contract-implicit", "contract-moved"), "FAIL sdk rename directory");
  require(!listing("contract-implicit", &entries), "FAIL sdk renamed directory left");
  require(listing("contract-moved/deep", &entries) && entries.len == 1 &&
          entry_is(&entries.ptr[0], "file.txt", 1, false),
          "FAIL sdk renamed directory contents");
  console_files_free_entries(&entries);
  require(!move_entry("contract-moved", "contract-moved/deep/inside"), "FAIL sdk rename into itself");
  require(!move_entry("contract-moved", "contract-dir"), "FAIL sdk rename over a directory");

  require(!remove_entry("contract-dir/sub"), "FAIL sdk remove a full directory");
  require(remove_entry("contract-dir/sub/b.txt") && remove_entry("contract-dir/sub") &&
          remove_entry("contract-dir"),
          "FAIL sdk remove");
  require(!listing("contract-dir", &entries), "FAIL sdk removed directory left");
  require(remove_entry("contract-moved/deep/file.txt") && remove_entry("contract-moved/deep") &&
          remove_entry("contract-moved"),
          "FAIL sdk remove renamed directory");
  require(!remove_entry("contract-dir") && !remove_entry("") && !move_entry("", "contract-root"),
          "FAIL sdk remove missing or root");

  require(!remove_entry("doom2.wad") && !move_entry("doom2.wad", "renamed.wad") &&
          !move_entry("contract.tmp", "doom2.wad"),
          "FAIL sdk read-only asset protected");

  // A file removed while open stays readable through its handle and is
  // gone once the handle closes.
  const char open_name[] = "contract-open.tmp";
  require(console_files_open(open_name, sizeof(open_name) - 1, true, &file), "FAIL sdk open for removal");
  require(console_file_write_at(file, 0, (const uint8_t*)"xyz", 3) == 3, "FAIL sdk write before removal");
  require(remove_entry(open_name) && console_file_size(file) == 3, "FAIL sdk remove while open");
  console_file_read_result read = console_file_read_at(file, 0, 3);
  require(read.status == 0 && read.data.len == 3 && read.data.data[2] == 'z', "FAIL sdk read after removal");
  console_free_bytes(&read.data);
  console_file_close(file);
  require(!console_files_open(open_name, sizeof(open_name) - 1, false, &file), "FAIL sdk removed file reopened");
  require(listing("", &entries), "FAIL sdk final root listing");
  for (size_t i = 0; i < entries.len; i++) {
    console_string name = {(char*)entries.ptr[i].name.ptr, entries.ptr[i].name.len};
    require(!text_equals(name, "contract-open.tmp") && !text_equals(name, "contract-dir") &&
            !text_equals(name, "contract-moved"),
            "FAIL sdk removed entry listed");
  }
  console_files_free_entries(&entries);
  pass("PASS sdk directories");
}

// With --expect-saved the host loaded a directory holding
// preexisting/hello.txt; it is read back and removed.
static void check_saved(void) {
  console_file_entries entries;
  console_file file;
  require(listing("preexisting", &entries) && entries.len == 1 &&
          entry_is(&entries.ptr[0], "hello.txt", 2, false),
          "FAIL sdk saved listing");
  console_files_free_entries(&entries);
  const char path[] = "preexisting/hello.txt";
  require(console_files_open(path, sizeof(path) - 1, false, &file), "FAIL sdk saved open");
  console_file_read_result read = console_file_read_at(file, 0, 8);
  require(read.status == 0 && read.data.len == 2 && read.data.data[0] == 'h' && read.data.data[1] == 'i',
          "FAIL sdk saved contents");
  console_free_bytes(&read.data);
  console_file_close(file);
  require(remove_entry(path) && remove_entry("preexisting"), "FAIL sdk saved removal");
  pass("PASS sdk saved state");
}

static void check_streams(void) {
  const char path[] = "contract-stream.tmp";
  void* stream = console_stream_open(path, "wb");
  require(stream != NULL, "FAIL sdk stream create");
  require(console_stream_write(stream, "alpha", 5) == 5,
          "FAIL sdk stream write");
  require(console_stream_seek(stream, -3, 1) == 0 &&
          console_stream_write(stream, "XYZ", 3) == 3,
          "FAIL sdk stream overwrite");
  console_stream_close(stream);

  stream = console_stream_open(path, "rb");
  require(stream != NULL, "FAIL sdk stream reopen");
  char data[8];
  require(console_stream_read(stream, data, sizeof(data)) == 5 &&
          console_stream_tell(stream) == 5 && console_stream_eof(stream),
          "FAIL sdk stream short read");
  const char expected[] = "alXYZ";
  for (unsigned i = 0; i < 5; i++) {
    require(data[i] == expected[i], "FAIL sdk stream contents");
  }
  require(console_stream_seek(stream, -1, 2) == 0 &&
          !console_stream_eof(stream) &&
          console_stream_read(stream, data, 1) == 1 && data[0] == 'Z',
          "FAIL sdk stream seek after EOF");
  console_stream_close(stream);
  pass("PASS sdk streams");
}

static uint8_t large_byte(size_t index) {
  return (uint8_t)(index * 37 + 11);
}

static void check_large_lists(void) {
  const size_t len = 2 * 1024 * 1024 + 17;
  size_t initial_pages = __builtin_wasm_memory_size(0);
  uint8_t* data = cabi_realloc(NULL, 0, 1, len);
  require(data != NULL, "FAIL sdk large allocation");
  for (size_t i = 0; i < len; i++) {
    data[i] = large_byte(i);
  }
  const char path[] = "contract-large.tmp";
  console_file file;
  require(console_files_open(path, sizeof(path) - 1, true, &file), "FAIL sdk large file");
  require(console_file_write_at(file, 0, data, len) == (int32_t)len,
          "FAIL sdk large write");
  console_file_close(file);
  require(console_files_open(path, sizeof(path) - 1, false, &file), "FAIL sdk large reopen");
  size_t steady_pages = 0;
  for (unsigned iteration = 0; iteration < 8; iteration++) {
    console_file_read_result read = console_file_read_at(file, 0, (uint32_t)len);
    require(read.status == 0 && read.data.len == len, "FAIL sdk large read");
    for (size_t i = 0; i < len; i++) {
      require(read.data.data[i] == large_byte(i), "FAIL sdk large list contents");
    }
    console_free_bytes(&read.data);
    size_t pages = __builtin_wasm_memory_size(0);
    if (iteration == 0) {
      steady_pages = pages;
      require(pages > initial_pages, "FAIL sdk list memory growth");
    } else {
      require(pages == steady_pages, "FAIL sdk returned list leak");
    }
  }
  cabi_realloc(data, len, 1, 0);
  console_file_close(file);
  pass("PASS sdk large lists");
}

// With --overlay, a 16 by 16 white frame carries one of every primitive; the
// host checks the pixels each one produced.
static void check_overlay(void) {
  static uint8_t white[16 * 16 * 4];
  for (size_t i = 0; i < sizeof(white); i++) white[i] = 255;
  console_gfx_present(16, 16, white, sizeof(white));
  const console_sdk_gfx_color_t black = {0, 0, 0, 255};
  const console_sdk_gfx_color_t none = {9, 9, 9, 0};
  console_sdk_gfx_rect_t rect = {0, 0, 8, 8};
  console_sdk_gfx_fill_rect(&rect, &black);
  console_sdk_gfx_rect_t skipped = {0, 0, 16, 16};
  console_sdk_gfx_fill_rect(&skipped, &none);
  console_gfx_draw_text(8, 0, "i", 1, black);
  const uint8_t sprite[] = {0, 0, 0, 255, 9, 9, 9, 0, 9, 9, 9, 0, 0, 0, 0, 255};
  game_list_u8_t pixels = {(uint8_t*)sprite, sizeof(sprite)};
  console_sdk_gfx_own_sheet_t sheet = console_sdk_gfx_constructor_sheet(2, 2, &pixels);
  console_sdk_gfx_rect_t source = {0, 0, 2, 2};
  console_sdk_gfx_draw_sprite(console_sdk_gfx_borrow_sheet(sheet), &source, 8, 8, 0);
  console_sdk_gfx_sheet_drop_own(sheet);
  console_sdk_gfx_draw_line(0, 15, 15, 15, &black);
  console_sdk_gfx_fill_circle(12, 4, 1, &black);
  console_sdk_gfx_rect_t clip = {0, 0, 4, 16};
  console_sdk_gfx_set_clip(&clip);
  console_sdk_gfx_rect_t band = {0, 8, 16, 4};
  console_sdk_gfx_fill_rect(&band, &black);
  console_sdk_gfx_set_camera(-8, 0);
  console_sdk_gfx_rect_t moved = {-8, 12, 4, 2};
  console_sdk_gfx_fill_rect(&moved, &black);
  pass("PASS sdk overlay");
}

// With --fast the game asks for 70 Hz and a 64 by 48 display before its
// first frame and draws on the blank frame; the host checks the frame's
// size and the clock's period.
static void check_mode(void) {
  require(console_clock_set_frame_rate(70) == 70 && console_gfx_info().refresh_hz == 70,
          "FAIL sdk frame rate");
  require(console_clock_set_frame_rate(0) == 70 && console_clock_set_frame_rate(2000) == 70,
          "FAIL sdk frame rate bounds");
  require(console_sdk_gfx_set_mode(64, 48) && !console_sdk_gfx_set_mode(0, 48) &&
          !console_sdk_gfx_set_mode(64, 5000),
          "FAIL sdk display mode");
  console_sdk_gfx_display_info_t info = console_gfx_info();
  require(info.width == 64 && info.height == 48, "FAIL sdk display mode info");
  const console_sdk_gfx_color_t white = {255, 255, 255, 255};
  console_sdk_gfx_rect_t rect = {0, 0, 64, 48};
  console_sdk_gfx_fill_rect(&rect, &white);
  pass("PASS sdk mode");
}

// The host's identity: what a headless run reports, and the seed and clock
// its options set.
static void check_system(void) {
  console_string name = console_system_host_name();
  require(text_equals(name, "headless"), "FAIL sdk host name");
  console_free_string(&name);
  require(console_clock_frame() == 0, "FAIL sdk frame count at init");
  require(console_clock_unix_seconds() == 1234567 && console_system_random_seed() == 42,
          "FAIL sdk seed and clock options");
  uint32_t expected = persistent ? CONSOLE_SDK_SYSTEM_FEATURES_PERSISTENT_STORAGE : 0;
  require(console_system_features() == expected, "FAIL sdk persistent storage feature");
  console_system_set_title("contract", 8);
  pass("PASS sdk system");
}

// The 2 by 2 frame goes through the palette: red, green, blue, white.
static void check_framebuffer(bool invalid_framebuffer) {
  const uint8_t rgba[] = {
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  };
  const uint8_t indexed[] = {0, 1, 2, 3};
  check_system();
  if (fast) {
    check_mode();
    return;
  }
  console_sdk_gfx_display_info_t info = console_gfx_info();
  require(info.width == 320 && info.height == 240 && info.refresh_hz == 35, "FAIL sdk display info");
  pass("PASS sdk display info");
  if (overlay) {
    check_overlay();
    return;
  }
  if (invalid_framebuffer) {
    console_gfx_present(0, 2, rgba, sizeof(rgba));
    console_gfx_present(2, 2, rgba, sizeof(rgba) - 1);
    console_gfx_present(UINT32_MAX, UINT32_MAX, rgba, sizeof(rgba));
    console_gfx_present_indexed(2, 2, indexed, 3);
    console_gfx_present_indexed(0, 0, indexed, 0);
  }
  // The host verifies this exact pattern and that only one frame arrived,
  // proving invalid frames were rejected before reaching the HAL.
  console_gfx_set_palette(0, rgba, 4);
  console_gfx_present_indexed(2, 2, indexed, sizeof(indexed));
  pass(invalid_framebuffer ? "PASS sdk invalid framebuffer" : "PASS sdk framebuffer");
}

// The queue takes a second of frames and the host plays a frame period's
// worth after every frame: at this host's 35 Hz, 1260 of them.
static void check_audio(void) {
  console_audio_format format = console_audio_get_format();
  require(format.sample_rate == 44100 && format.channels == 2, "FAIL sdk audio format");
  require(console_audio_queued() == 0, "FAIL sdk audio starts empty");
  static int16_t samples[2 * 44100];
  for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) samples[i] = (int16_t)(i * 7919);
  require(console_audio_write(samples, 200) == 100 && console_audio_queued() == 100,
          "FAIL sdk audio write");
  require(console_audio_write(samples, 201) == 100 && console_audio_queued() == 200,
          "FAIL sdk audio unpaired sample");
  require(console_audio_write(samples, 2 * 44100) == 44100 - 200 && console_audio_queued() == 44100,
          "FAIL sdk audio fills the queue");
  require(console_audio_write(samples, 2) == 0 && console_audio_write(samples, 0) == 0,
          "FAIL sdk audio full queue");
  pass("PASS sdk audio");
}

// The host script pressed and released a, pause, and page-up, put the
// pointer at (5, 6) with the left button held, and typed "hi" and a snowman.
static void check_input(void) {
  require(console_input_capabilities() ==
              (CONSOLE_SDK_INPUT_CAPABILITY_KEY_RELEASES | CONSOLE_SDK_INPUT_CAPABILITY_TEXT |
               CONSOLE_SDK_INPUT_CAPABILITY_MOUSE),
          "FAIL sdk headless capabilities");
  console_mouse mouse = console_input_mouse();
  require(mouse.x == 5 && mouse.y == 6 && mouse.dx == 0 && mouse.dy == 0 &&
          mouse.buttons == CONSOLE_SDK_INPUT_MOUSE_BUTTONS_LEFT && mouse.wheel == 0,
          "FAIL sdk scripted mouse");
  mouse = console_input_mouse();
  require(mouse.x == 5 && mouse.y == 6 && mouse.buttons == CONSOLE_SDK_INPUT_MOUSE_BUTTONS_LEFT,
          "FAIL sdk mouse state persists");
  require(!console_input_capture_pointer(true) && !console_input_capture_pointer(false),
          "FAIL sdk pointer capture refused");
  console_string text = console_input_read_text();
  require(text_equals(text, "hi\xe2\x98\x83"), "FAIL sdk scripted text");
  console_free_string(&text);
  text = console_input_read_text();
  require(text.len == 0, "FAIL sdk text drained");
  console_free_string(&text);
  console_key_events events = console_input_read_events();
  require(events.len == 6, "FAIL sdk event count");
  const uint32_t keys[] = {
    CONSOLE_SDK_INPUT_KEY_A, CONSOLE_SDK_INPUT_KEY_A, CONSOLE_SDK_INPUT_KEY_PAUSE, CONSOLE_SDK_INPUT_KEY_PAUSE,
    CONSOLE_SDK_INPUT_KEY_PAGE_UP, CONSOLE_SDK_INPUT_KEY_PAGE_UP,
  };
  for (unsigned i = 0; i < 6; i++) {
    require(events.data[i].key == keys[i] &&
            events.data[i].pressed == (uint8_t)((i & 1) == 0),
            "FAIL sdk event contents");
  }
  console_input_free_events(&events);
  require(events.data == NULL && events.len == 0, "FAIL sdk event release");
  events = console_input_read_events();
  require(events.len == 0, "FAIL sdk event drain");
  console_input_free_events(&events);
  pass("PASS sdk input");
}

void console_guest_init(void) {
  bool invalid_framebuffer = check_arguments();
  check_allocator();
  check_small_files();
  check_directories();
  if (expect_saved) check_saved();
  check_streams();
  check_large_lists();
  check_framebuffer(invalid_framebuffer);
  check_audio();
  check_input();
  start_ms = last_ms = console_clock_now_ms();
}

int32_t console_guest_frame(uint32_t dt_ms) {
  (void)dt_ms;
  uint64_t now = console_clock_now_ms();
  require(now >= last_ms, "FAIL sdk monotonic clock");
  last_ms = now;
  require(console_clock_frame() == frames, "FAIL sdk frame count");
  if (fast) {
    require(now == (frames + 1) * 1000 / 70 + ((frames + 1) * 1000 % 70 != 0), "FAIL sdk fast clock");
    if (frames == 9) {
      pass("PASS sdk fast");
      console_process_exit(0);
    }
    frames++;
    return 1;
  }
  if (frames == 1) require(console_audio_queued() == 44100 - 1260, "FAIL sdk audio plays a frame");
  if (frames == 40) {
    require(console_audio_queued() == 0, "FAIL sdk audio drained");
    pass("PASS sdk audio playback");
  }
  if (now - start_ms >= 2100) {
    pass("PASS sdk clock");
    pass("PASS sdk contract");
    console_process_exit(0);
  }
  require(++frames < 10000, "FAIL sdk clock did not advance");
  return 1;
}
