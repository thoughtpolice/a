// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { mount } from "svelte";
import Page from "@fixture/views";

mount(Page, { target: document.body, props: { name: "browser" } });
