# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise the Buck-built binary over a disposable loopback connection."""

import contextlib
import datetime
import hashlib
import hmac
import http.client
import queue
import socket
import subprocess
import sys
import threading
import unittest
import urllib.parse
import xml.etree.ElementTree as ET


def command(*args):
    return [MEMS3_BINARY, *args]


@contextlib.contextmanager
def server(*args, stderr_log=None):
    with subprocess.Popen(
        command("--listen=127.0.0.1:0", *args),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ) as process:
        # A reader thread gives stdout readiness a deadline on every platform.
        ready = queue.Queue()
        reader = threading.Thread(
            target=lambda: ready.put(process.stdout.readline()), daemon=True
        )
        reader.start()
        # Fault traces can exceed a pipe's capacity. Drain them while requests
        # run so instrumentation cannot make the child stall during a test.
        def drain_stderr():
            for line in process.stderr:
                if stderr_log is not None:
                    stderr_log.append(line.rstrip("\n"))

        stderr_reader = threading.Thread(target=drain_stderr, daemon=True)
        stderr_reader.start()
        try:
            banner = ready.get(timeout=10).strip()
            prefix = "mems3 listening on http://"
            if not banner.startswith(prefix):
                raise AssertionError(f"unexpected startup output: {banner!r}")
            yield banner.removeprefix(prefix)
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            reader.join(timeout=5)
            stderr_reader.join(timeout=5)


def request(address, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection(address, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def signed_request(
    address, method, path, body=b"", headers=None, access_key="mems3", secret="mems3"
):
    """Sign ordinary S3 requests independently of the server's s3s adapter.

    https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    """
    timestamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    date = timestamp[:8]
    digest = hashlib.sha256(body).hexdigest()
    headers = dict(headers or {})
    headers.update(
        {"host": address, "x-amz-date": timestamp, "x-amz-content-sha256": digest}
    )
    names = sorted(headers)
    signed_headers = ";".join(names)
    canonical_headers = "".join(f"{name}:{headers[name].strip()}\n" for name in names)
    url = urllib.parse.urlsplit(path)
    query = urllib.parse.urlencode(
        sorted(urllib.parse.parse_qsl(url.query, keep_blank_values=True)),
        quote_via=urllib.parse.quote,
        safe="-_.~",
    )
    canonical = f"{method}\n{url.path}\n{query}\n{canonical_headers}\n{signed_headers}\n{digest}"
    scope = f"{date}/us-east-1/s3/aws4_request"
    canonical_digest = hashlib.sha256(canonical.encode()).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{canonical_digest}"
    key = f"AWS4{secret}".encode()
    for value in [date, "us-east-1", "s3", "aws4_request"]:
        key = hmac.digest(key, value.encode(), "sha256")
    signature = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return request(address, method, path, body, headers)


def xml_values(body, name):
    return [element.text or "" for element in ET.fromstring(body).findall(f".//{{*}}{name}")]


def completion(parts):
    root = ET.Element("CompleteMultipartUpload")
    for number, etag in parts:
        part = ET.SubElement(root, "Part")
        ET.SubElement(part, "PartNumber").text = str(number)
        ET.SubElement(part, "ETag").text = etag
    return ET.tostring(root)


def buckets(address):
    status, _, body = request(address, "GET", "/")
    if status != 200:
        raise AssertionError(f"ListBuckets returned {status}: {body!r}")
    return xml_values(body, "Name")


class CliTests(unittest.TestCase):
    def test_auto_buggify_replays_a_bounded_campaign_across_processes(self):
        runs = []
        for _ in range(2):
            logs = []
            with server(
                "--fault-seed=42", "--auto-buggify", "--chaos-trace",
                "--chaos-warmup-requests=4", "--chaos-requests=32",
                stderr_log=logs,
            ) as address:
                responses = [request(address, "GET", "/celld/missing") for _ in range(40)]
                statuses = [response[0] for response in responses]
                self.assertEqual(statuses[:4], [404] * 4)
                self.assertEqual(set(statuses[4:36]), {404, 503})
                self.assertEqual(statuses[36:], [404] * 4)
                for status, _, body in responses:
                    self.assertEqual(xml_values(body, "Code"), ["SlowDown" if status == 503 else "NoSuchKey"])
                self.assertEqual(request(address, "PUT", "/celld/recovered", b"healthy")[0], 200)
                self.assertEqual(request(address, "GET", "/celld/recovered")[2], b"healthy")
            self.assertTrue(any("42" in line for line in logs), logs)
            traces = [line for line in logs if line.startswith("mems3 chaos trace:")]
            self.assertEqual(len(traces), 43, logs)
            runs.append((statuses, traces))
        self.assertEqual(runs[0], runs[1])

    def test_buggify_decisions_replay_across_server_processes(self):
        results = []
        for _ in range(2):
            with server(
                "--fault-seed=42", "--buggify",
                "--buggify-activation=100", "--buggify-firing=50",
            ) as address:
                responses = [request(address, "GET", "/celld/missing") for _ in range(20)]
                results.append([response[0] for response in responses])
                for status, _, body in responses:
                    self.assertEqual(xml_values(body, "Code"), ["SlowDown" if status == 503 else "NoSuchKey"])
        self.assertEqual(set(results[0]), {404, 503})
        self.assertEqual(results[0], results[1])

    def test_default_bucket_is_ready_on_the_announced_port(self):
        with server() as address:
            self.assertNotEqual(address.rsplit(":", 1)[1], "0")
            self.assertEqual(buckets(address), ["celld"])
            self.assertEqual(request(address, "HEAD", "/celld")[0], 200)

    def test_explicit_repeated_buckets_replace_the_default(self):
        with server("--bucket", "first", "--bucket=second", "--bucket=first") as address:
            self.assertEqual(buckets(address), ["first", "second"])
            self.assertEqual(request(address, "HEAD", "/celld")[0], 404)
            for bucket in ["first", "second"]:
                self.assertEqual(request(address, "HEAD", f"/{bucket}")[0], 200)

    def test_occupied_port_fails_without_announcing_readiness(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            result = subprocess.run(
                command("--listen", f"127.0.0.1:{port}"),
                capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("mems3 listening", result.stdout)

    def test_http_transport_round_trips_data_and_date_validators(self):
        with server() as address:
            payload = b"\x00\xffhello\r\n"
            self.assertEqual(request(address, "PUT", "/celld/data", payload)[0], 200)
            status, headers, body = request(address, "GET", "/celld/data")
            self.assertEqual((status, body), (200, payload))
            self.assertEqual(int(headers["content-length"]), len(payload))
            self.assertEqual(request(address, "HEAD", "/celld/data")[2], b"")
            self.assertEqual(
                request(address, "GET", "/celld/data", headers={"if-modified-since": headers["last-modified"]})[0],
                304,
            )
            self.assertEqual(
                request(address, "GET", "/celld/data", headers={"if-unmodified-since": headers["last-modified"]})[0],
                200,
            )

    def test_state_is_discarded_when_the_process_exits(self):
        with server() as address:
            self.assertEqual(request(address, "PUT", "/celld/ephemeral", b"data")[0], 200)
        with server() as address:
            self.assertEqual(request(address, "HEAD", "/celld/ephemeral")[0], 404)

    def test_signed_conditional_writes_ranges_dates_and_deletes(self):
        with server() as address:
            path = "/celld/epochs/0001/state.json"
            status, headers, body = signed_request(address, "PUT", path, b"first value", {"if-none-match": "*"})
            self.assertEqual(status, 200, body)
            etag = headers["etag"]
            self.assertEqual(signed_request(address, "PUT", path, b"wrong", {"if-none-match": "*"})[0], 412)
            status, headers, body = signed_request(address, "HEAD", path)
            self.assertEqual(status, 200, body)
            self.assertEqual(headers["etag"], etag)
            self.assertEqual(headers["content-length"], "11")
            self.assertEqual(signed_request(address, "GET", path, headers={"range": "bytes=1-5"})[2], b"irst ")
            self.assertEqual(signed_request(address, "GET", path, headers={"if-modified-since": headers["last-modified"]})[0], 304)
            self.assertEqual(signed_request(address, "GET", path, headers={"if-unmodified-since": headers["last-modified"]})[0], 200)
            self.assertEqual(signed_request(address, "PUT", path, b"updated", {"if-match": etag})[0], 200)
            self.assertEqual(signed_request(address, "PUT", path, b"wrong", {"if-match": etag})[0], 412)
            self.assertEqual(signed_request(address, "GET", path)[2], b"updated")
            self.assertEqual(signed_request(address, "DELETE", path)[0], 204)
            self.assertEqual(signed_request(address, "HEAD", path)[0], 404)

    def test_signed_listings_preserve_special_keys_and_support_batch_delete(self):
        with server() as address:
            keys = ["a%2Fb", "café/雪", "space + name", "xml<&>"]
            for key in keys:
                path = "/celld/" + urllib.parse.quote(key)
                status, _, body = signed_request(address, "PUT", path, key.encode())
                self.assertEqual(status, 200, body)
            status, _, body = signed_request(address, "GET", "/celld?list-type=2&encoding-type=url")
            self.assertEqual(status, 200, body)
            listed = [urllib.parse.unquote(key) for key in xml_values(body, "Key")]
            self.assertEqual(listed, keys)
            for key in listed:
                path = "/celld/" + urllib.parse.quote(key)
                self.assertEqual(signed_request(address, "GET", path)[2], key.encode())
            status, _, body = signed_request(address, "GET", "/celld?list-type=2&delimiter=%2F&encoding-type=url")
            self.assertEqual(status, 200, body)
            self.assertEqual([urllib.parse.unquote(value) for value in xml_values(body, "Prefix")], ["café/"])
            self.assertEqual(len(xml_values(body, "Key")), 3)
            delete = ET.Element("Delete")
            for key in keys:
                ET.SubElement(ET.SubElement(delete, "Object"), "Key").text = key
            status, _, body = signed_request(address, "POST", "/celld?delete", ET.tostring(delete))
            self.assertEqual(status, 200, body)
            self.assertEqual(xml_values(body, "Key"), keys)
            self.assertEqual(xml_values(signed_request(address, "GET", "/celld?list-type=2")[2], "Key"), [])

    def test_signed_multipart_uploads_complete_and_abort(self):
        with server() as address:
            path = "/celld/bundles/large.bin"
            status, _, body = signed_request(address, "POST", path + "?uploads")
            self.assertEqual(status, 200, body)
            upload_id = xml_values(body, "UploadId")[0]
            first = b"a" * (5 * 1024 * 1024)
            parts = []
            for number, data in enumerate([first, b"tail"], 1):
                status, headers, body = signed_request(address, "PUT", f"{path}?partNumber={number}&uploadId={upload_id}", data)
                self.assertEqual(status, 200, body)
                parts.append((number, headers["etag"]))
            status, _, body = signed_request(address, "POST", f"{path}?uploadId={upload_id}", completion(parts))
            self.assertEqual(status, 200, body)
            self.assertEqual(signed_request(address, "HEAD", path)[1]["etag"], xml_values(body, "ETag")[0])
            self.assertEqual(signed_request(address, "GET", path)[2], first + b"tail")

            path = "/celld/aborted"
            status, _, body = signed_request(address, "POST", path + "?uploads")
            self.assertEqual(status, 200, body)
            upload_id = xml_values(body, "UploadId")[0]
            status, headers, body = signed_request(address, "PUT", f"{path}?partNumber=1&uploadId={upload_id}", b"unpublished")
            self.assertEqual(status, 200, body)
            self.assertEqual(signed_request(address, "DELETE", f"{path}?uploadId={upload_id}")[0], 204)
            self.assertEqual(signed_request(address, "HEAD", path)[0], 404)
            status, _, body = signed_request(address, "POST", f"{path}?uploadId={upload_id}", completion([(1, headers["etag"])]))
            self.assertEqual(status, 404, body)
            self.assertEqual(xml_values(body, "Code"), ["NoSuchUpload"])

    def test_wrong_signed_credentials_are_rejected_without_writing(self):
        with server() as address:
            for access_key, secret, code in [
                ("wrong", "mems3", "NotSignedUp"),
                ("mems3", "wrong", "SignatureDoesNotMatch"),
            ]:
                with self.subTest(access_key=access_key, secret=secret):
                    status, _, body = signed_request(
                        address, "PUT", "/celld/protected", b"wrong",
                        access_key=access_key, secret=secret,
                    )
                    self.assertEqual(status, 403, body)
                    self.assertEqual(xml_values(body, "Code"), [code])
            self.assertEqual(signed_request(address, "HEAD", "/celld/protected")[0], 404)


if __name__ == "__main__":
    MEMS3_BINARY = sys.argv.pop(1)
    unittest.main()
