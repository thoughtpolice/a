// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Browser-testing POC. CDP is a privileged test capability, not a public API. */
export { CdpProtocolError, connectCdp } from "./cdp.ts";
export type { CdpConnection, CdpOptions, CdpSendOptions } from "./cdp.ts";
export {
  type BrowserFixture,
  type BrowserFixtureOptions,
  withBrowserFixture,
} from "./fixture.ts";
