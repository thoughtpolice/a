# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

{ pkgs }:

pkgs.writeText "watchman-no-telemetry.patch" ''
  diff --git a/CMakeLists.txt b/CMakeLists.txt
  index 61f8a251..e60b194d 100644
  --- a/CMakeLists.txt
  +++ b/CMakeLists.txt
  @@ -481,10 +481,8 @@ target_link_libraries(third_party_deps INTERFACE
     glog::glog
     gflags
     ''${Boost_LIBRARIES}
  -  fb303::fb303
     fmt::fmt
     edencommon::edencommon_utils
  -  edencommon::edencommon_telemetry
   )
   target_include_directories(third_party_deps INTERFACE
     ''${FOLLY_INCLUDE_DIR}
  @@ -713,6 +711,5 @@ watchman/scm/Mercurial.cpp
   watchman/scm/SCM.cpp
   watchman/telemetry/LogEvent.cpp
  -watchman/telemetry/WatchmanStats.cpp
   watchman/telemetry/WatchmanStructuredLogger.cpp
   watchman/thirdparty/getopt/GetOpt.cpp
   watchman/watcher/Watcher.cpp
  diff --git a/watchman/telemetry/LogEvent.h b/watchman/telemetry/LogEvent.h
  index 930aff1c..1d9509eb 100644
  --- a/watchman/telemetry/LogEvent.h
  +++ b/watchman/telemetry/LogEvent.h
  @@ -16,13 +16,23 @@
   #include <optional>
   #include <string>

  -#include "eden/common/telemetry/DynamicEvent.h"
  -#include "eden/common/telemetry/LogEvent.h"
  -
   namespace watchman {

  -using DynamicEvent = facebook::eden::DynamicEvent;
  -using TypedEvent = facebook::eden::TypedEvent;
  +// The public Watchman build does not emit Meta's internal structured
  +// telemetry. Keep the event interface used by the daemon, but make event
  +// population allocation-free and side-effect-free.
  +class DynamicEvent {
  + public:
  +  void addInt(std::string, int64_t) noexcept {}
  +  void addString(std::string, std::string) noexcept {}
  +  void addBool(std::string, bool) noexcept {}
  +};
  +
  +struct TypedEvent {
  +  virtual ~TypedEvent() = default;
  +  virtual void populate(DynamicEvent&) const = 0;
  +  virtual const char* getType() const = 0;
  +};

   struct WatchmanBaseEvent : public TypedEvent {
     // TODO: add system and user time for Unix systems
  diff --git a/watchman/telemetry/WatchmanStructuredLogger.cpp b/watchman/telemetry/WatchmanStructuredLogger.cpp
  index eaa75ef7..b212949c 100644
  --- a/watchman/telemetry/WatchmanStructuredLogger.cpp
  +++ b/watchman/telemetry/WatchmanStructuredLogger.cpp
  @@ -7,58 +7,11 @@

   #include "watchman/telemetry/WatchmanStructuredLogger.h"

  -#include "eden/common/telemetry/StructuredLoggerFactory.h"
  -#include "watchman/WatchmanConfig.h"
  -#include "watchman/telemetry/WatchmanStats.h"
  -
   namespace watchman {

  -using UserInfo = facebook::eden::UserInfo;
  -
  -WatchmanStructuredLogger::WatchmanStructuredLogger(
  -    std::shared_ptr<ScribeLogger> scribeLogger,
  -    SessionInfo sessionInfo)
  -    : ScubaStructuredLogger{std::move(scribeLogger), std::move(sessionInfo)} {}
  -
   std::shared_ptr<StructuredLogger> getLogger() {
  -  static std::shared_ptr<StructuredLogger> logger = facebook::eden::
  -      makeDefaultStructuredLogger<WatchmanStructuredLogger, WatchmanStatsPtr>(
  -          cfg_get_string("scribe-cat", ""),
  -          cfg_get_string("scribe-category", ""),
  -          facebook::eden::makeSessionInfo(
  -              UserInfo::lookup(),
  -              facebook::eden::getHostname(),
  -              PACKAGE_VERSION),
  -          getWatchmanStats());
  +  static auto logger = std::make_shared<StructuredLogger>();
     return logger;
   }

  -DynamicEvent WatchmanStructuredLogger::populateDefaultFields(
  -    std::optional<const char*> type) {
  -  DynamicEvent event = StructuredLogger::populateDefaultFields(type);
  -  event.addString("version", sessionInfo_.appVersion);
  -#ifdef WATCHMAN_BUILD_INFO
  -  event.addString("buildinfo", WATCHMAN_BUILD_INFO);
  -#endif
  -  event.addString("logged_by", "watchman");
  -
  -  const auto& fbInfo = sessionInfo_.fbInfo;
  -  for (const auto& info : fbInfo) {
  -    const auto& key = info.first;
  -    const auto& value = info.second;
  -    std::visit(
  -        [&](const auto& v) {
  -          using T = std::decay_t<decltype(v)>;
  -          if constexpr (std::is_same_v<T, std::string>) {
  -            event.addString(key, v);
  -          } else if constexpr (std::is_same_v<T, uint64_t>) {
  -            event.addInt(key, v);
  -          }
  -        },
  -        value);
  -  }
  -
  -  return event;
  -}
  -
   } // namespace watchman
  diff --git a/watchman/telemetry/WatchmanStructuredLogger.h b/watchman/telemetry/WatchmanStructuredLogger.h
  index 09aa7a79..4a29376e 100644
  --- a/watchman/telemetry/WatchmanStructuredLogger.h
  +++ b/watchman/telemetry/WatchmanStructuredLogger.h
  @@ -7,31 +7,17 @@

   #pragma once

  -#include "eden/common/telemetry/ScribeLogger.h"
  -#include "eden/common/telemetry/ScubaStructuredLogger.h"
  -#include "eden/common/telemetry/SessionInfo.h"
  -#include "eden/common/telemetry/StructuredLogger.h"
  +#include <memory>

  -namespace watchman {
  -
  -using DynamicEvent = facebook::eden::DynamicEvent;
  -using SessionInfo = facebook::eden::SessionInfo;
  -using ScribeLogger = facebook::eden::ScribeLogger;
  -using ScubaStructuredLogger = facebook::eden::ScubaStructuredLogger;
  -using StructuredLogger = facebook::eden::StructuredLogger;
  +#include "watchman/telemetry/LogEvent.h"

  -class WatchmanStructuredLogger : public ScubaStructuredLogger {
  - public:
  -  explicit WatchmanStructuredLogger(
  -      std::shared_ptr<ScribeLogger> scribeLogger,
  -      SessionInfo sessionInfo);
  -  virtual ~WatchmanStructuredLogger() override = default;
  +namespace watchman {

  - protected:
  -  virtual DynamicEvent populateDefaultFields(
  -      std::optional<const char*> type) override;
  +class StructuredLogger {
  + public:
  +  void logEvent(const TypedEvent&) const noexcept {}
   };

   std::shared_ptr<StructuredLogger> getLogger();

   } // namespace watchman
''
