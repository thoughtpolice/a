# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Binary bodies and object metadata survive the real HTTP transport. Replacing
# an object replaces its metadata too; absent buckets and keys stay distinct.

PUT {{endpoint}}/{{bucket}}/binary
Content-Type: application/octet-stream
Cache-Control: max-age=60
Content-Disposition: attachment; filename=data.bin
Content-Encoding: identity
Content-Language: en
Expires: Fri, 01 Jan 2100 00:00:00 GMT
x-amz-meta-purpose: transport test
x-amz-meta-other: second
file,smallbinary.bin;
HTTP 200
[Captures]
etag: header "ETag"

GET {{endpoint}}/{{bucket}}/binary
HTTP 200
Content-Type: application/octet-stream
Content-Length: 4
Accept-Ranges: bytes
ETag: {{etag}}
Cache-Control: max-age=60
Content-Disposition: attachment; filename=data.bin
Content-Encoding: identity
Content-Language: en
x-amz-meta-purpose: transport test
x-amz-meta-other: second
[Captures]
expires: header "Expires"
[Asserts]
header "Expires" exists
header "Last-Modified" exists
bytes == hex,000102ff;

HEAD {{endpoint}}/{{bucket}}/binary
HTTP 200
Content-Length: 4
Content-Type: application/octet-stream
ETag: {{etag}}
Expires: {{expires}}
x-amz-meta-purpose: transport test
[Asserts]
bytes count == 0

PUT {{endpoint}}/{{bucket}}/binary
`replacement`
HTTP 200
[Asserts]
header "ETag" != {{etag}}

GET {{endpoint}}/{{bucket}}/binary
HTTP 200
[Asserts]
header "x-amz-meta-purpose" not exists
header "x-amz-meta-other" not exists
header "Cache-Control" not exists
header "Expires" not exists
body == "replacement"

GET {{endpoint}}/{{bucket}}/absent
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"

HEAD {{endpoint}}/{{bucket}}/absent
HTTP 404
[Asserts]
bytes count == 0

GET {{endpoint}}/absent-bucket/key
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchBucket"

PUT {{endpoint}}/absent-bucket/key
`not published`
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchBucket"

DELETE {{endpoint}}/absent-bucket/key
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchBucket"
