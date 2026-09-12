// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln
{
    using System.Collections.Generic;
    using System.Numerics;
    using Sdk = global::Console.Sdk;

    /// <summary>
    /// The console's input, read once a frame: keys (with their presses and
    /// releases since the last tick, so a tap shorter than a frame still
    /// counts), the buttons, the mouse and typed text.
    /// </summary>
    internal sealed class Controls
    {
        private const int Keys = 128;
        private readonly bool[] down = new bool[Keys];
        private readonly bool[] pressed = new bool[Keys];
        private readonly bool[] released = new bool[Keys];
        private readonly List<int> touched = new List<int>();
        private Sdk.Input.Buttons buttons;
        private Sdk.Input.Buttons pressedButtons;
        private Sdk.Input.MouseButtons mouseButtons;
        private Sdk.Input.MouseButtons pressedMouse;

        /// <summary>The pointer over the frame, in its pixels.</summary>
        public Vector2 Pointer { get; private set; }

        /// <summary>Whether the pointer moved this tick.</summary>
        public bool PointerMoved { get; private set; }

        /// <summary>The text typed since the last tick.</summary>
        public string Text { get; private set; } = "";

        /// <summary>Whether anything at all was pressed this tick.</summary>
        public bool AnyPressed { get; private set; }

        public bool Down(Sdk.Input.Key key) => down[(int)key];

        public bool Pressed(Sdk.Input.Key key) => pressed[(int)key];

        public bool Released(Sdk.Input.Key key) => released[(int)key];

        public bool Down(Sdk.Input.Buttons button) => (buttons & button) != 0;

        public bool Pressed(Sdk.Input.Buttons button) => (pressedButtons & button) != 0;

        public bool Down(Sdk.Input.MouseButtons button) => (mouseButtons & button) != 0;

        public bool Pressed(Sdk.Input.MouseButtons button) => (pressedMouse & button) != 0;

        internal void Poll()
        {
            foreach (var change in Sdk.Input.ReadEvents())
            {
                int key = (int)change.Key;
                if (key >= Keys)
                {
                    continue;
                }

                if (change.Pressed && !down[key])
                {
                    pressed[key] = true;
                    AnyPressed = true;
                }
                else if (!change.Pressed && down[key])
                {
                    released[key] = true;
                }

                down[key] = change.Pressed;
                touched.Add(key);
            }

            var now = Sdk.Input.Poll();
            pressedButtons |= now & ~buttons;
            AnyPressed |= (now & ~buttons) != 0;
            buttons = now;
            var mouse = Sdk.Input.Mouse();
            var pointer = new Vector2(mouse.X, mouse.Y);
            PointerMoved |= pointer != Pointer;
            Pointer = pointer;
            pressedMouse |= mouse.Buttons & ~mouseButtons;
            AnyPressed |= (mouse.Buttons & ~mouseButtons) != 0;
            mouseButtons = mouse.Buttons;
            Text += Sdk.Input.ReadText();
        }

        internal void EndTick()
        {
            foreach (int key in touched)
            {
                pressed[key] = false;
                released[key] = false;
            }

            touched.Clear();
            pressedButtons = 0;
            pressedMouse = 0;
            PointerMoved = false;
            AnyPressed = false;
            Text = "";
        }
    }

    /// <summary>
    /// A game's actions, each bound to keys, buttons and mouse buttons, so
    /// the game asks "is Fire held" rather than which key.
    /// </summary>
    internal sealed class InputMap<TAction>
        where TAction : struct
    {
        private readonly Controls controls;
        private readonly Dictionary<TAction, Binding> bindings = new Dictionary<TAction, Binding>();

        public InputMap(Controls controls)
        {
            this.controls = controls;
        }

        public InputMap<TAction> Bind(TAction action, Sdk.Input.Key[] keys, Sdk.Input.Buttons buttons = 0, Sdk.Input.MouseButtons mouse = 0)
        {
            bindings[action] = new Binding(keys, buttons, mouse);
            return this;
        }

        public bool Held(TAction action)
        {
            if (!bindings.TryGetValue(action, out var binding))
            {
                return false;
            }

            foreach (var key in binding.Keys)
            {
                if (controls.Down(key))
                {
                    return true;
                }
            }

            return (binding.Buttons != 0 && controls.Down(binding.Buttons)) || (binding.Mouse != 0 && controls.Down(binding.Mouse));
        }

        public bool Pressed(TAction action)
        {
            if (!bindings.TryGetValue(action, out var binding))
            {
                return false;
            }

            foreach (var key in binding.Keys)
            {
                if (controls.Pressed(key))
                {
                    return true;
                }
            }

            return (binding.Buttons != 0 && controls.Pressed(binding.Buttons)) || (binding.Mouse != 0 && controls.Pressed(binding.Mouse));
        }

        /// <summary>A direction from four actions, of length at most one.</summary>
        public Vector2 Axis(TAction left, TAction right, TAction up, TAction down)
        {
            var axis = new Vector2((Held(right) ? 1 : 0) - (Held(left) ? 1 : 0), (Held(down) ? 1 : 0) - (Held(up) ? 1 : 0));
            return axis == Vector2.Zero ? axis : Vector2.Normalize(axis);
        }

        private sealed record Binding(Sdk.Input.Key[] Keys, Sdk.Input.Buttons Buttons, Sdk.Input.MouseButtons Mouse);
    }
}
