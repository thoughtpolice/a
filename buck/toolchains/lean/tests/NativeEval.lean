-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import Native
-- Runs mulAdd, implemented in C, at elaboration time. That takes :native's
-- shared object, loaded because :native is precompiled.
meta import Native

#guard mulAdd 6 7 0 == 42
#guard mulAdd 2 3 4 == 10
#guard answerTimes 2 == 84
