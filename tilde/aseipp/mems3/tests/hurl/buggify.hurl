# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# The fixture enables both BUGGIFY probabilities at 100%.

GET {{endpoint}}/{{bucket}}?list-type=2
HTTP 503
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SlowDown"

PUT {{endpoint}}/{{bucket}}/unwritten
`rejected by buggification`
HTTP 503
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SlowDown"
