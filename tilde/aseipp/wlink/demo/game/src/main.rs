// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A game against the generated console SDK: a square that drifts with the
//! d-pad and reports what it is doing.

#![no_main]

mod bindings;
mod runtime;

use bindings::console::sdk::{gfx, input, log};
use std::sync::Mutex;

struct Game;

struct State {
    x: i32,
    y: i32,
    frames: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
    x: 100,
    y: 80,
    frames: 0,
});

impl bindings::Guest for Game {
    fn init() {
        log::log(log::Level::Info, "init");
    }

    fn frame(dt_ms: u32) -> bool {
        let mut state = STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let buttons = input::poll();
        let speed = (dt_ms / 4) as i32;
        if buttons.contains(input::Buttons::LEFT) {
            state.x -= speed;
        }
        if buttons.contains(input::Buttons::RIGHT) {
            state.x += speed;
        }
        if buttons.contains(input::Buttons::UP) {
            state.y -= speed;
        }
        if buttons.contains(input::Buttons::DOWN) {
            state.y += speed;
        }
        state.frames += 1;

        gfx::clear(gfx::Color {
            r: 16,
            g: 16,
            b: 32,
            a: 255,
        });
        gfx::fill_rect(
            gfx::Rect {
                x: state.x,
                y: state.y,
                w: 16,
                h: 16,
            },
            gfx::Color {
                r: 240,
                g: 80,
                b: 40,
                a: 255,
            },
        );
        let caption = format!("frame {} at ({}, {})", state.frames, state.x, state.y);
        gfx::draw_text(
            8,
            8,
            &caption,
            gfx::Color {
                r: 255,
                g: 255,
                b: 255,
                a: 255,
            },
        );
        log::log(log::Level::Info, &caption);

        !buttons.contains(input::Buttons::START)
    }
}

bindings::export!(Game with_types_in bindings);
