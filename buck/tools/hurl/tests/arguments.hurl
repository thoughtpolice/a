# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# This scenario is read, but deliberately not executed, by check_arguments.go.
# Its URL cannot accidentally contact a real service during a plumbing test.
GET http://{{not_a_real_endpoint}}/
HTTP 200
