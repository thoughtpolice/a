# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# mems3 is deliberately an S3 subset. Recognized but unimplemented operations
# return the S3 NotImplemented error, rather than silently claiming success.
# In particular clients must use ListObjectsV2, not the legacy listing API.

PUT {{endpoint}}/{{bucket}}/object
`preserved`
HTTP 200

GET {{endpoint}}/{{bucket}}
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}?versioning
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}?location
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}?uploads
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}/object?tagging
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}/object?acl
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

GET {{endpoint}}/{{bucket}}/object?attributes
x-amz-object-attributes: ETag,ObjectSize
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

# A real in-progress upload is still not listable (ListParts is unsupported).
POST {{endpoint}}/{{bucket}}/object?uploads
HTTP 200
[Captures]
upload: xpath "string(//*[local-name()='UploadId'])"

PUT {{endpoint}}/{{bucket}}/object?uploadId={{upload}}&partNumber=1
`pending`
HTTP 200

GET {{endpoint}}/{{bucket}}/object?uploadId={{upload}}
HTTP 501
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotImplemented"

DELETE {{endpoint}}/{{bucket}}/object?uploadId={{upload}}
HTTP 204

GET {{endpoint}}/{{bucket}}/object
HTTP 200
`preserved`

GET {{endpoint}}/{{bucket}}?list-type=2
HTTP 200
[Asserts]
xpath "string(//*[local-name()='KeyCount'])" == "1"
xpath "string(//*[local-name()='Key'])" == "object"
