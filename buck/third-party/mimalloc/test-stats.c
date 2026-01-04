// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <stdio.h>
#include <string.h>

#include "mimalloc.h"
#include "mimalloc-stats.h"

int
main(void) {
  // Allocate some memory to generate stats
  int* i = mi_malloc(sizeof(int) * 100);
  *i = 42;

  // Test mi_stats_get
  mi_stats_t stats;
  memset(&stats, 0, sizeof(stats));
  mi_stats_get(sizeof(stats), &stats);
  printf("mi_stats_get succeeded, version = %d\n", stats.version);
  printf("sizeof(mi_stats_t) = %zu\n", sizeof(mi_stats_t));
  printf("sizeof(mi_stat_count_t) = %zu\n", sizeof(mi_stat_count_t));
  printf("sizeof(mi_stat_counter_t) = %zu\n", sizeof(mi_stat_counter_t));

  // Test mi_stats_get_json
  char* json = mi_stats_get_json(0, NULL);
  if (json != NULL) {
    printf("JSON stats length: %zu\n", strlen(json));
    mi_free(json);
  }

  // Test mi_stats_get_bin_size
  size_t bin0 = mi_stats_get_bin_size(0);
  printf("Bin 0 size: %zu\n", bin0);

  mi_free(i);
  return 0;
}
