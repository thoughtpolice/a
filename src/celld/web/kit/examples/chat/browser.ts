// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import Page from "@celld/web/switchboard/views";
import { PageSchema } from "@celld/web/switchboard/contracts";
import { hydratePage } from "@celld/web/kit/browser";

hydratePage(Page, { parseProps: (value) => PageSchema.parse(value) });
