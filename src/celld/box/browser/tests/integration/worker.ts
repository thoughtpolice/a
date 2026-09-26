// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  BrowserSandbox,
  handleBrowserFixture,
} from "@celld/box/browser/durable";
export { BrowserSandbox };

interface Env {
  BROWSER: DurableObjectNamespace<BrowserSandbox>;
  BROWSER_FIXTURE_TOKEN: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleBrowserFixture(
      request,
      env.BROWSER,
      env.BROWSER_FIXTURE_TOKEN,
    );
  },
};
