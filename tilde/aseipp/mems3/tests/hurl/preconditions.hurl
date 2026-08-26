# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Compare-and-swap writes/deletes, date round trips, and HTTP precondition
# precedence. Every rejected mutation must preserve the previously stored bytes.

PUT {{endpoint}}/{{bucket}}/cas
If-Match: *
`wrong`
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"

PUT {{endpoint}}/{{bucket}}/cas
If-None-Match: *
`original`
HTTP 200
[Captures]
original: header "ETag"

PUT {{endpoint}}/{{bucket}}/cas
If-None-Match: *
`wrong`
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

PUT {{endpoint}}/{{bucket}}/cas
If-Match: "stale"
`wrong`
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

GET {{endpoint}}/{{bucket}}/cas
HTTP 200
ETag: {{original}}
[Captures]
modified: header "Last-Modified"
[Asserts]
body == "original"

GET {{endpoint}}/{{bucket}}/cas
If-Modified-Since: {{modified}}
HTTP 304
[Asserts]
bytes count == 0

HEAD {{endpoint}}/{{bucket}}/cas
If-Unmodified-Since: {{modified}}
HTTP 200
ETag: {{original}}

GET {{endpoint}}/{{bucket}}/cas
If-Unmodified-Since: Sat, 01 Jan 2000 00:00:00 GMT
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

# A successful If-Match takes precedence over the stale date.
GET {{endpoint}}/{{bucket}}/cas
If-Match: {{original}}
If-Unmodified-Since: Sat, 01 Jan 2000 00:00:00 GMT
HTTP 200
`original`

# If-None-Match takes precedence over If-Modified-Since in either direction.
GET {{endpoint}}/{{bucket}}/cas
If-None-Match: "stale"
If-Modified-Since: Fri, 01 Jan 2100 00:00:00 GMT
HTTP 200
`original`

GET {{endpoint}}/{{bucket}}/cas
If-None-Match: {{original}}
If-Modified-Since: Sat, 01 Jan 2000 00:00:00 GMT
Range: bytes=999-
HTTP 304

GET {{endpoint}}/{{bucket}}/cas
If-Match: "stale"
Range: bytes=999-
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

PUT {{endpoint}}/{{bucket}}/cas
If-Match: {{original}}
`updated`
HTTP 200
[Captures]
updated: header "ETag"
[Asserts]
header "ETag" != {{original}}

DELETE {{endpoint}}/{{bucket}}/cas
If-Match: {{original}}
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

GET {{endpoint}}/{{bucket}}/cas
HTTP 200
ETag: {{updated}}
`updated`

DELETE {{endpoint}}/{{bucket}}/cas
If-Match: {{updated}}
HTTP 204

DELETE {{endpoint}}/{{bucket}}/cas
HTTP 204

DELETE {{endpoint}}/{{bucket}}/cas
If-Match: {{updated}}
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"

GET {{endpoint}}/{{bucket}}/cas
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"
