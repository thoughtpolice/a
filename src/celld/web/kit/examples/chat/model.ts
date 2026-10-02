// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import type {
  ChatMessage,
  Member,
  PageData,
} from "@celld/web/switchboard/contracts";
import type { RoomStatus } from "@celld/web/realtime/client";

/** The per-page state and commands consumed by presentation components. */
export interface ChatModel {
  readonly enhanced: boolean;
  readonly page: PageData;
  readonly messages: readonly ChatMessage[];
  readonly members: readonly Member[];
  readonly status: RoomStatus | "reading";
  readonly navigating: boolean;
  readonly sending: boolean;
  readonly sendError: string;
  readonly formError: string;
  readonly notice: string;
  readonly typingNames: readonly string[];
  readonly unread: Readonly<Record<string, number>>;
  draft: string;
  filter: string;
  mobilePanel: "none" | "channels" | "members";
  start(): () => void;
  navigate(name: string, push?: boolean): Promise<boolean>;
  enter(nickname: string): Promise<boolean>;
  createChannel(name: string, topic: string): Promise<boolean>;
  leave(): Promise<void>;
  send(): Promise<void>;
  typing(): void;
  clearFormError(): void;
  dismissNotice(): void;
}
