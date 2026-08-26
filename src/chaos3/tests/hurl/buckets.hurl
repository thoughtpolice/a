# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Bucket creation is idempotent in us-east-1, deletion rejects nonempty buckets,
# and lexically sorted bucket pages terminate without spurious continuation.
# The test gets its own server, so exact ListBuckets assertions are safe.

GET {{endpoint}}/
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Bucket'])" == 1
xpath "string(//*[local-name()='Bucket']/*[local-name()='Name'])" == {{bucket}}

PUT {{endpoint}}/page-c
HTTP 200
Location: /page-c

PUT {{endpoint}}/page-a
HTTP 200

PUT {{endpoint}}/page-b
HTTP 200

HEAD {{endpoint}}/page-a
HTTP 200
x-amz-bucket-region: us-east-1

PUT {{endpoint}}/page-a/key
`preserved`
HTTP 200

PUT {{endpoint}}/page-a
HTTP 200
Location: /page-a

GET {{endpoint}}/page-a/key
HTTP 200
`preserved`

GET {{endpoint}}/
[Query]
prefix: page-
max-buckets: 2
HTTP 200
[Captures]
next: xpath "string(//*[local-name()='ContinuationToken'])"
[Asserts]
xpath "count(//*[local-name()='Bucket'])" == 2
xpath "string((//*[local-name()='Bucket'])[1]/*[local-name()='Name'])" == "page-a"
xpath "string((//*[local-name()='Bucket'])[2]/*[local-name()='Name'])" == "page-b"
xpath "string(//*[local-name()='Prefix'])" == "page-"
xpath "//*[local-name()='ContinuationToken']" exists

GET {{endpoint}}/
[Query]
prefix: page-
max-buckets: 2
continuation-token: {{next}}
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Bucket'])" == 1
xpath "string(//*[local-name()='Bucket']/*[local-name()='Name'])" == "page-c"
xpath "//*[local-name()='ContinuationToken']" not exists

GET {{endpoint}}/?prefix=page-&max-buckets=3
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Bucket'])" == 3
xpath "//*[local-name()='ContinuationToken']" not exists

GET {{endpoint}}/?prefix=absent
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Bucket'])" == 0
xpath "//*[local-name()='ContinuationToken']" not exists

GET {{endpoint}}/?max-buckets=0
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidArgument"

GET {{endpoint}}/?max-buckets=10001
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidArgument"

DELETE {{endpoint}}/page-a
HTTP 409
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BucketNotEmpty"

GET {{endpoint}}/page-a/key
HTTP 200
`preserved`

DELETE {{endpoint}}/page-a/key
HTTP 204

DELETE {{endpoint}}/page-a
HTTP 204

HEAD {{endpoint}}/page-a
HTTP 404

DELETE {{endpoint}}/page-a
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchBucket"
