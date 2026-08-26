# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Server-side copies preserve bytes and optionally replace metadata. Failed
# copies preserve their destination; batch delete understands XML-escaped keys
# and reports missing keys as deleted unless Quiet suppresses success entries.

PUT {{endpoint}}/{{bucket}}/source%26key
Content-Type: text/plain
x-amz-meta-team: orchestra
`payload`
HTTP 200
[Captures]
etag: header "ETag"

PUT {{endpoint}}/backup
HTTP 200

PUT {{endpoint}}/backup/copy
x-amz-copy-source: /{{bucket}}/source%26key
x-amz-copy-source-if-match: {{etag}}
HTTP 200
[Asserts]
xpath "string(//*[local-name()='ETag'])" == {{etag}}
xpath "//*[local-name()='LastModified']" exists

GET {{endpoint}}/backup/copy
HTTP 200
ETag: {{etag}}
Content-Type: text/plain
x-amz-meta-team: orchestra
`payload`

PUT {{endpoint}}/backup/copy
x-amz-copy-source: /{{bucket}}/source%26key
x-amz-metadata-directive: REPLACE
Content-Type: application/octet-stream
x-amz-meta-purpose: replaced
HTTP 200

HEAD {{endpoint}}/backup/copy
HTTP 200
ETag: {{etag}}
Content-Type: application/octet-stream
x-amz-meta-purpose: replaced
[Asserts]
header "x-amz-meta-team" not exists

PUT {{endpoint}}/backup/copy
x-amz-copy-source: /{{bucket}}/source%26key
x-amz-copy-source-if-match: "wrong"
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

PUT {{endpoint}}/backup/copy
x-amz-copy-source: /{{bucket}}/missing
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"

GET {{endpoint}}/backup/copy
HTTP 200
x-amz-meta-purpose: replaced
`payload`

PUT {{endpoint}}/{{bucket}}/source%26key
x-amz-copy-source: /{{bucket}}/source%26key
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidRequest"

PUT {{endpoint}}/{{bucket}}/keep
`preserved`
HTTP 200

POST {{endpoint}}/{{bucket}}?delete
Content-Type: application/xml
`<Delete><Object><Key>source&amp;key</Key></Object><Object><Key>missing</Key></Object></Delete>`
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Deleted'])" == 2
xpath "string((//*[local-name()='Key'])[1])" == "source&key"
xpath "string((//*[local-name()='Key'])[2])" == "missing"
xpath "//*[local-name()='Error']" not exists

HEAD {{endpoint}}/{{bucket}}/source%26key
HTTP 404

GET {{endpoint}}/{{bucket}}/keep
HTTP 200
`preserved`

POST {{endpoint}}/{{bucket}}?delete
Content-Type: application/xml
`<Delete><Quiet>true</Quiet><Object><Key>keep</Key></Object><Object><Key>missing</Key></Object></Delete>`
HTTP 200
[Asserts]
xpath "//*[local-name()='Deleted']" not exists
xpath "//*[local-name()='Error']" not exists

GET {{endpoint}}/{{bucket}}?list-type=2
HTTP 200
[Asserts]
xpath "string(//*[local-name()='KeyCount'])" == "0"

# Deleting the source bucket's objects does not touch the cross-bucket copy.
GET {{endpoint}}/backup/copy
HTTP 200
`payload`
