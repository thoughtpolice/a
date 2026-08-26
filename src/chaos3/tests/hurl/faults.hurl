# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# This fixture configures errors before GET and after PUT/DELETE commit.

PUT {{endpoint}}/{{bucket}}/uncertain
`committed despite error`
HTTP 500
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InternalError"

GET {{endpoint}}/{{bucket}}/uncertain
HTTP 503
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SlowDown"

GET {{endpoint}}/{{bucket}}/uncertain
HTTP 503
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SlowDown"

GET {{endpoint}}/{{bucket}}/uncertain
HTTP 200
[Asserts]
body == "committed despite error"

PUT {{endpoint}}/{{bucket}}/uncertain
`retried successfully`
HTTP 200

DELETE {{endpoint}}/{{bucket}}/uncertain
HTTP 503
[Asserts]
xpath "string(//*[local-name()='Code'])" == "ServiceUnavailable"

GET {{endpoint}}/{{bucket}}/uncertain
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"

DELETE {{endpoint}}/{{bucket}}/uncertain
HTTP 204
