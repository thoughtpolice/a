# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Fixed, independent checksums of the nine ASCII bytes '123456789'. MD5/SHA
# values come from Python hashlib, CRC32 from zlib; CRC32C and CRC64/NVME are
# the standard 'check' vectors (https://reveng.sourceforge.io/crc-catalogue/).
# S3 uses base64 of digest bytes, with CRC values in big-endian byte order.
# These expectations deliberately do not use chaos3/s3s checksum helpers.

PUT {{endpoint}}/{{bucket}}/checksum
Content-MD5: JfnnlDI7RTiF9RgfG2JNCw==
x-amz-checksum-crc32: y/Q5Jg==
x-amz-checksum-crc32c: 4waSgw==
x-amz-checksum-crc64nvme: rosUhgp5mIg=
x-amz-checksum-sha1: 98O8HYCOBHMq32eZZczDTKeuNEE=
x-amz-checksum-sha256: FeKw08M4keuw8e9gnsQZQgwg4yDOlMZfvIwzEkSOsiU=
x-amz-checksum-sha512: 2eZ2LdHI6vbWGzxhkvxAjU1tXxF20MKRabwk5xw/J0rSf81YEbMT1oH35V7ALXPUmclUVba1u1A6z1dPuo/+hQ==
x-amz-checksum-md5: JfnnlDI7RTiF9RgfG2JNCw==
`123456789`
HTTP 200
ETag: "25f9e794323b453885f5181f1b624d0b"

GET {{endpoint}}/{{bucket}}/checksum
HTTP 200
[Asserts]
sha256 == hex,15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225;
body == "123456789"

# Each digest independently gates publication. The digest headers are valid
# base64, but deliberately describe bytes other than the supplied body.
PUT {{endpoint}}/{{bucket}}/bad-md5
Content-MD5: JfnnlDI7RTiF9RgfG2JNCw==
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

HEAD {{endpoint}}/{{bucket}}/bad-md5
HTTP 404

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-crc32: y/Q5Jg==
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-crc32c: 4waSgw==
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-crc64nvme: rosUhgp5mIg=
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-sha1: 98O8HYCOBHMq32eZZczDTKeuNEE=
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-sha256: FeKw08M4keuw8e9gnsQZQgwg4yDOlMZfvIwzEkSOsiU=
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

PUT {{endpoint}}/{{bucket}}/checksum
x-amz-checksum-sha512: 2eZ2LdHI6vbWGzxhkvxAjU1tXxF20MKRabwk5xw/J0rSf81YEbMT1oH35V7ALXPUmclUVba1u1A6z1dPuo/+hQ==
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

GET {{endpoint}}/{{bucket}}/checksum
HTTP 200
ETag: "25f9e794323b453885f5181f1b624d0b"
`123456789`

# A rejected replacement must not evict a previously accepted multipart part.
POST {{endpoint}}/{{bucket}}/multipart?uploads
HTTP 200
[Captures]
upload: xpath "string(//*[local-name()='UploadId'])"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=1
Content-MD5: JfnnlDI7RTiF9RgfG2JNCw==
`123456789`
HTTP 200
ETag: "25f9e794323b453885f5181f1b624d0b"
[Captures]
part: header "ETag"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=1
x-amz-checksum-sha256: FeKw08M4keuw8e9gnsQZQgwg4yDOlMZfvIwzEkSOsiU=
`invalid replacement`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "BadDigest"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{part}}</ETag></Part></CompleteMultipartUpload>`
HTTP 200
[Asserts]
xpath "string(//*[local-name()='ETag'])" == "\"5927c5d64d94a5786f90003aa26d0159-1\""

GET {{endpoint}}/{{bucket}}/multipart
HTTP 200
`123456789`
