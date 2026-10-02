// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

export interface Draft {
  title: string;
  body: string;
  readonly previewTitle: string;
  readonly previewBody: string;
  readonly wordCount: number;
  reset(): void;
}

/** Each mounted notebook owns its draft; nothing is shared between SSR requests. */
export function createDraft(): Draft {
  let title = $state("");
  let body = $state("");
  const previewTitle = $derived(title.trim() || "An untitled thought");
  const previewBody = $derived(body.trim());
  const wordCount = $derived(
    `${title} ${body}`.trim().match(/\S+/g)?.length ?? 0,
  );

  return {
    get title() {
      return title;
    },
    set title(value: string) {
      title = value;
    },
    get body() {
      return body;
    },
    set body(value: string) {
      body = value;
    },
    get previewTitle() {
      return previewTitle;
    },
    get previewBody() {
      return previewBody;
    },
    get wordCount() {
      return wordCount;
    },
    reset() {
      title = "";
      body = "";
    },
  };
}
