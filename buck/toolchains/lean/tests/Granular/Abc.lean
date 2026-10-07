-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

import Granular.Xyz

/-! A module of `:granular-lib`, which imports one of the two modules of
`:granular-other`. -/

namespace Granular

def doubled : Nat := 2 * answer

example : doubled = 84 := rfl

end Granular
