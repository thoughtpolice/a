# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
# ListObjectsV2 counts delimiter groups as entries, never repeats them on later
# pages, echoes opaque tokens, and URL-encodes keys exactly once when requested.

PUT {{endpoint}}/{{bucket}}/a
`a`
HTTP 200
[Captures]
etag: header "ETag"

PUT {{endpoint}}/{{bucket}}/b/second
`bb`
HTTP 200

PUT {{endpoint}}/{{bucket}}/b/first
`b`
HTTP 200

PUT {{endpoint}}/{{bucket}}/c
`ccc`
HTTP 200

PUT {{endpoint}}/{{bucket}}/d/deep/child
`d`
HTTP 200

PUT {{endpoint}}/{{bucket}}/z
`z`
HTTP 200

GET {{endpoint}}/{{bucket}}?list-type=2&delimiter=%2F&max-keys=2
HTTP 200
[Captures]
next: xpath "string(//*[local-name()='NextContinuationToken'])"
[Asserts]
xpath "string(//*[local-name()='Name'])" == {{bucket}}
xpath "string(//*[local-name()='KeyCount'])" == "2"
xpath "string(//*[local-name()='IsTruncated'])" == "true"
xpath "count(//*[local-name()='Contents'])" == 1
xpath "string(//*[local-name()='Key'])" == "a"
xpath "string(//*[local-name()='Size'])" == "1"
xpath "string(//*[local-name()='ETag'])" == {{etag}}
xpath "//*[local-name()='LastModified']" exists
xpath "string(//*[local-name()='CommonPrefixes']/*[local-name()='Prefix'])" == "b/"
xpath "//*[local-name()='NextContinuationToken']" exists

# The continuation token takes precedence over an incompatible start-after.
GET {{endpoint}}/{{bucket}}
[Query]
list-type: 2
delimiter: /
max-keys: 2
continuation-token: {{next}}
start-after: z
HTTP 200
[Captures]
last: xpath "string(//*[local-name()='NextContinuationToken'])"
[Asserts]
xpath "string(//*[local-name()='ContinuationToken'])" == {{next}}
xpath "string(//*[local-name()='KeyCount'])" == "2"
xpath "string(//*[local-name()='IsTruncated'])" == "true"
xpath "count(//*[local-name()='Contents'])" == 1
xpath "string(//*[local-name()='Key'])" == "c"
xpath "string(//*[local-name()='CommonPrefixes']/*[local-name()='Prefix'])" == "d/"

GET {{endpoint}}/{{bucket}}
[Query]
list-type: 2
delimiter: /
max-keys: 2
continuation-token: {{last}}
HTTP 200
[Asserts]
xpath "string(//*[local-name()='ContinuationToken'])" == {{last}}
xpath "string(//*[local-name()='KeyCount'])" == "1"
xpath "string(//*[local-name()='IsTruncated'])" == "false"
xpath "string(//*[local-name()='Key'])" == "z"
xpath "//*[local-name()='CommonPrefixes']" not exists
xpath "//*[local-name()='NextContinuationToken']" not exists

GET {{endpoint}}/{{bucket}}?list-type=2&delimiter=%2F&start-after=b%2Ffirst&max-keys=1
HTTP 200
[Asserts]
xpath "string(//*[local-name()='Key'])" == "c"
xpath "//*[local-name()='CommonPrefixes']" not exists

GET {{endpoint}}/{{bucket}}?list-type=2&max-keys=0
HTTP 200
[Asserts]
xpath "string(//*[local-name()='KeyCount'])" == "0"
xpath "string(//*[local-name()='IsTruncated'])" == "false"
xpath "//*[local-name()='NextContinuationToken']" not exists

GET {{endpoint}}/{{bucket}}?list-type=2&max-keys=-1
HTTP 400
[Asserts]
xpath "string(//*[local-name()='Code'])" == "InvalidArgument"

PUT {{endpoint}}/{{bucket}}/special/a%26%3C
`xml`
HTTP 200

PUT {{endpoint}}/{{bucket}}/special/literal%252Fname
`percent`
HTTP 200

PUT {{endpoint}}/{{bucket}}/special/space%20%2B%20name
`space`
HTTP 200

PUT {{endpoint}}/{{bucket}}/special/caf%C3%A9/%E9%9B%AA
`unicode`
HTTP 200

GET {{endpoint}}/{{bucket}}?list-type=2&prefix=special%2F
HTTP 200
[Asserts]
xpath "count(//*[local-name()='Key'])" == 4
xpath "string((//*[local-name()='Key'])[1])" == "special/a&<"
xpath "string((//*[local-name()='Key'])[2])" == "special/café/雪"
xpath "string((//*[local-name()='Key'])[3])" == "special/literal%2Fname"
xpath "string((//*[local-name()='Key'])[4])" == "special/space + name"
xpath "//*[local-name()='EncodingType']" not exists

GET {{endpoint}}/{{bucket}}?list-type=2&prefix=special%2F&encoding-type=url
HTTP 200
[Asserts]
xpath "string(//*[local-name()='EncodingType'])" == "url"
xpath "string(/*/*[local-name()='Prefix'])" == "special%2F"
xpath "string((//*[local-name()='Key'])[1])" == "special%2Fa%26%3C"
xpath "string((//*[local-name()='Key'])[2])" == "special%2Fcaf%C3%A9%2F%E9%9B%AA"
xpath "string((//*[local-name()='Key'])[3])" == "special%2Fliteral%252Fname"
xpath "string((//*[local-name()='Key'])[4])" == "special%2Fspace%20%2B%20name"

GET {{endpoint}}/{{bucket}}/special/literal%252Fname
HTTP 200
`percent`

GET {{endpoint}}/{{bucket}}/special/literal%2Fname
HTTP 404
[Asserts]
xpath "string(//*[local-name()='Code'])" == "NoSuchKey"
