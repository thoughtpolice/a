# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# Multipart completion is atomic: bad order, absent parts, and an undersized
# nonfinal part must leave the upload repairable and old object readable. S3
# multipart uses ordinary PUTs and XML completion, not multipart/form-data.

PUT {{endpoint}}/{{bucket}}/multipart
`original`
HTTP 200
[Captures]
original: header "ETag"

POST {{endpoint}}/{{bucket}}/multipart?uploads
Content-Type: application/octet-stream
Cache-Control: no-cache
x-amz-meta-purpose: multipart
HTTP 200
[Captures]
upload: xpath "string(//*[local-name()='UploadId'])"
[Asserts]
xpath "string(//*[local-name()='Bucket'])" == {{bucket}}
xpath "string(//*[local-name()='Key'])" == "multipart"
xpath "string(//*[local-name()='UploadId'])" not isEmpty

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=0
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidArgument"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=10001
`wrong`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidArgument"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=1
`too small`
HTTP 200
[Captures]
first: header "ETag"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=2
# Make the first selected part large enough that order is the only violated
# condition in the reversed completion below, not also its minimum part size.
file,large-part.bin;
HTTP 200
[Captures]
last: header "ETag"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>{{last}}</ETag></Part><Part><PartNumber>1</PartNumber><ETag>{{first}}</ETag></Part></CompleteMultipartUpload>`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidPartOrder"

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=2
`z`
HTTP 200
[Captures]
last: header "ETag"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>3</PartNumber><ETag>{{last}}</ETag></Part></CompleteMultipartUpload>`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidPart"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{first}}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>{{last}}</ETag></Part></CompleteMultipartUpload>`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "EntityTooSmall"

GET {{endpoint}}/{{bucket}}/multipart
HTTP 200
ETag: {{original}}
`original`

# Replace only the undersized part with exactly the 5 MiB minimum.
PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}&partNumber=1
file,large-part.bin;
HTTP 200
ETag: "79b281060d337b9b2b84ccf390adcf74"
[Captures]
repaired: header "ETag"

# Replacing a part invalidates its old ETag without consuming the upload.
POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{first}}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>{{last}}</ETag></Part></CompleteMultipartUpload>`
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidPart"

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
If-None-Match: *
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{repaired}}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>{{last}}</ETag></Part></CompleteMultipartUpload>`
HTTP 412
[Asserts]
xpath "string(//*[local-name()='Code'])" == "PreconditionFailed"

GET {{endpoint}}/{{bucket}}/multipart
HTTP 200
ETag: {{original}}
`original`

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
If-Match: {{original}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{repaired}}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>{{last}}</ETag></Part></CompleteMultipartUpload>`
HTTP 200
[Captures]
completed: xpath "string(//*[local-name()='ETag'])"
[Asserts]
xpath "string(//*[local-name()='Bucket'])" == {{bucket}}
xpath "string(//*[local-name()='Key'])" == "multipart"
# Independently computed MD5(MD5(5 MiB of 'a') || MD5('z')) + '-2'.
xpath "string(//*[local-name()='ETag'])" == "\"8563290c5210e22ffe276e2320dc9d21-2\""

HEAD {{endpoint}}/{{bucket}}/multipart
HTTP 200
Content-Length: 5242881
Content-Type: application/octet-stream
Cache-Control: no-cache
x-amz-meta-purpose: multipart
ETag: {{completed}}

GET {{endpoint}}/{{bucket}}/multipart
Range: bytes=0-5242879
HTTP 206
Content-Range: bytes 0-5242879/5242881
file,large-part.bin;

GET {{endpoint}}/{{bucket}}/multipart
Range: bytes=5242879-
HTTP 206
Content-Range: bytes 5242879-5242880/5242881
`az`

GET {{endpoint}}/{{bucket}}/multipart
If-None-Match: {{completed}}
HTTP 304

POST {{endpoint}}/{{bucket}}/multipart?uploadId={{upload}}
`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{{repaired}}</ETag></Part></CompleteMultipartUpload>`
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchUpload"

# A second upload is independently abortable; abort must not remove the object.
POST {{endpoint}}/{{bucket}}/multipart?uploads
HTTP 200
[Captures]
abort: xpath "string(//*[local-name()='UploadId'])"
[Asserts]
xpath "string(//*[local-name()='UploadId'])" != {{upload}}

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{abort}}&partNumber=1
`discarded`
HTTP 200

PUT {{endpoint}}/{{bucket}}/wrong-key?uploadId={{abort}}&partNumber=1
`wrong`
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchUpload"

DELETE {{endpoint}}/{{bucket}}/multipart?uploadId={{abort}}
HTTP 204

PUT {{endpoint}}/{{bucket}}/multipart?uploadId={{abort}}&partNumber=1
`wrong`
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchUpload"

HEAD {{endpoint}}/{{bucket}}/multipart
HTTP 200
Content-Length: 5242881
ETag: {{completed}}
