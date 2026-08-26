# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Inclusive, open-ended, suffix, clamped, and unsatisfiable byte ranges. An
# unsuccessful range cannot damage the object; empty objects are still valid.

PUT {{endpoint}}/{{bucket}}/range
`0123456789`
HTTP 200

GET {{endpoint}}/{{bucket}}/range
Range: bytes=0-0
HTTP 206
Content-Range: bytes 0-0/10
Content-Length: 1
`0`

GET {{endpoint}}/{{bucket}}/range
Range: bytes=3-6
HTTP 206
Content-Range: bytes 3-6/10
Content-Length: 4
`3456`

GET {{endpoint}}/{{bucket}}/range
Range: bytes=7-
HTTP 206
Content-Range: bytes 7-9/10
`789`

GET {{endpoint}}/{{bucket}}/range
Range: bytes=7-999
HTTP 206
Content-Range: bytes 7-9/10
`789`

GET {{endpoint}}/{{bucket}}/range
Range: bytes=-3
HTTP 206
Content-Range: bytes 7-9/10
`789`

GET {{endpoint}}/{{bucket}}/range
Range: bytes=-100
HTTP 206
Content-Range: bytes 0-9/10
`0123456789`

# Unlike GET, S3 HeadObject returns 200 with the selected range's length.
# https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
HEAD {{endpoint}}/{{bucket}}/range
Range: bytes=3-6
HTTP 200
Content-Range: bytes 3-6/10
Content-Length: 4
[Asserts]
bytes count == 0

GET {{endpoint}}/{{bucket}}/range
Range: bytes=10-
HTTP 416
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidRange"

GET {{endpoint}}/{{bucket}}/range
Range: bytes=-0
HTTP 416
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidRange"

GET {{endpoint}}/{{bucket}}/range
HTTP 200
[Asserts]
header "Content-Range" not exists
body == "0123456789"

PUT {{endpoint}}/{{bucket}}/empty
file,empty.bin;
HTTP 200
ETag: "d41d8cd98f00b204e9800998ecf8427e"

GET {{endpoint}}/{{bucket}}/empty
HTTP 200
Content-Length: 0
ETag: "d41d8cd98f00b204e9800998ecf8427e"
[Asserts]
bytes count == 0

GET {{endpoint}}/{{bucket}}/empty
Range: bytes=0-
HTTP 416
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidRange"

HEAD {{endpoint}}/{{bucket}}/empty
Range: bytes=-1
HTTP 416
[Asserts]
bytes count == 0
