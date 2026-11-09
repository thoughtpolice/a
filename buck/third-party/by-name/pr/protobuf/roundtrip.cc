// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Takes a message through the text format, the wire format and reflection,
// the parts of the full runtime that generated code alone does not reach.

#include <cstdio>
#include <string>

#include "google/protobuf/descriptor.h"
#include "google/protobuf/text_format.h"
#include "test.pb.h"

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::fprintf(stderr, "%s:%d: failed: %s\n", __FILE__,      \
                   __LINE__, #cond);                             \
      return 1;                                                  \
    }                                                            \
  } while (0)

using depot::protobuf_test::Report;

int main() {
  Report report;
  CHECK(google::protobuf::TextFormat::ParseFromString(
      R"pb(
        file: "a.out"
        sections { name: ".text" size: 4096 }
        sections { name: ".data" size: 512 }
        totals { key: "vm" value: 4608 }
      )pb",
      &report));
  CHECK(report.sections_size() == 2);
  CHECK(report.sections(1).name() == ".data");
  CHECK(report.totals().at("vm") == 4608);

  std::string wire;
  CHECK(report.SerializeToString(&wire));
  Report decoded;
  CHECK(decoded.ParseFromString(wire));
  CHECK(decoded.file() == "a.out");
  CHECK(decoded.sections(0).size() == 4096);

  const google::protobuf::Descriptor* descriptor = Report::descriptor();
  CHECK(descriptor->full_name() == "depot.protobuf_test.Report");
  CHECK(descriptor->FindFieldByName("sections")->is_repeated());

  Report bad;
  CHECK(!google::protobuf::TextFormat::ParseFromString("file: 42 nope", &bad));

  std::string text;
  CHECK(google::protobuf::TextFormat::PrintToString(decoded, &text));
  std::fputs(text.c_str(), stdout);
  return 0;
}
