# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Hurl/libcurl signs real requests with AWS SigV4. mems3 intentionally accepts
# anonymous traffic, but supplied credentials must verify. Both wrong-key and
# wrong-secret failures must leave existing bytes intact and absent keys absent.

PUT {{endpoint}}/{{bucket}}/signed%20%2B%20key
If-None-Match: *
x-amz-meta-purpose: signed transport
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
`signed payload`
HTTP 200
[Captures]
etag: header "ETag"

GET {{endpoint}}/{{bucket}}/signed%20%2B%20key
If-Match: {{etag}}
Range: bytes=0-5
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 206
Content-Range: bytes 0-5/14
x-amz-meta-purpose: signed transport
`signed`

GET {{endpoint}}/{{bucket}}
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
[Query]
list-type: 2
prefix: signed +
encoding-type: url
HTTP 200
[Asserts]
xpath "string(//*[local-name()='Key'])" == "signed%20%2B%20key"
xpath "string(//*[local-name()='KeyCount'])" == "1"

PUT {{endpoint}}/{{bucket}}/signed%20%2B%20key
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: wrong:{{secret_access_key}}
`wrong`
HTTP 403
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NotSignedUp"

PUT {{endpoint}}/{{bucket}}/signed%20%2B%20key
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:wrong
`wrong`
HTTP 403
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SignatureDoesNotMatch"

GET {{endpoint}}/{{bucket}}/signed%20%2B%20key
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 200
ETag: {{etag}}
`signed payload`

PUT {{endpoint}}/{{bucket}}/absent
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:wrong
`wrong`
HTTP 403
[Asserts]
xpath "string(//*[local-name()='Code'])" == "SignatureDoesNotMatch"

HEAD {{endpoint}}/{{bucket}}/absent
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 404

# Multipart captures are also valid inputs to later signed requests.
POST {{endpoint}}/{{bucket}}/multipart?uploads
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 200
[Captures]
upload: xpath "string(//*[local-name()='UploadId'])"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=1
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
`signed part`
HTTP 200
[Captures]
part: header "ETag"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{part}}</ETag></Part></CompleteMultipartUpload>`
HTTP 200

GET {{endpoint}}/{{bucket}}/multipart
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 200
`signed part`

POST {{endpoint}}/{{bucket}}?delete
Content-Type: application/xml
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
`<Delete><Object><Key>signed + key</Key></Object><Object><Key>multipart</Key></Object></Delete>`
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Deleted'])" == 2

GET {{endpoint}}/{{bucket}}?list-type=2
[Options]
aws-sigv4: aws:amz:{{region}}:s3
user: {{access_key_id}}:{{secret_access_key}}
HTTP 200
[Asserts]
xpath "string(//*[local-name()='KeyCount'])" == "0"
