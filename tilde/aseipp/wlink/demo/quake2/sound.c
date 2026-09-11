// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The engine's sound driver over the SDK's audio queue. The mixer paints
// into a ring ahead of the position it believes the hardware has reached;
// here the ring's newly painted frames are handed to the platform after
// each paint, and the position is what the platform has not yet played.
#include <stdint.h>
#include <string.h>

#include "console.h"
#include "runtime.h"

#include "client/client.h"

#include "client/snd_loc.h"

// Sample pairs painted so far, kept by the mixer.
extern int paintedtime;

// Sample pairs handed to the platform so far.
static int submitted;

qboolean SNDDMA_Init(void) {
  console_audio_format format = console_audio_get_format();
  dma.speed = (int)format.sample_rate;
  dma.channels = (int)format.channels;
  dma.samplebits = 16;
  dma.samples = 32768;
  dma.submission_chunk = 1;
  dma.samplepos = 0;
  dma.buffer = console_malloc((size_t)dma.samples * 2);
  memset(dma.buffer, 0, (size_t)dma.samples * 2);
  submitted = 0;
  return true;
}

int SNDDMA_GetDMAPos(void) {
  int played = submitted - (int)console_audio_queued();
  dma.samplepos = (played * dma.channels) & (dma.samples - 1);
  return dma.samplepos;
}

void SNDDMA_BeginPainting(void) {}

void SNDDMA_Submit(void) {
  while (submitted < paintedtime) {
    int pairs = paintedtime - submitted;
    int start = (submitted * dma.channels) & (dma.samples - 1);
    int contiguous = (dma.samples - start) / dma.channels;
    if (pairs > contiguous) pairs = contiguous;
    uint32_t accepted = console_audio_write((const int16_t*)dma.buffer + start, (size_t)pairs * (size_t)dma.channels);
    if (!accepted) break;
    submitted += (int)accepted;
  }
}

void SNDDMA_Shutdown(void) {
  console_free(dma.buffer);
  dma.buffer = NULL;
}
