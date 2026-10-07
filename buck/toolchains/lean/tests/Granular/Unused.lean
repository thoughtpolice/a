-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

/-! The module of `:granular-other` that nothing in `:granular-lib` imports.
Building `Granular.Abc` must never ask for it. -/

namespace Granular

def unused : Nat := 7

end Granular
