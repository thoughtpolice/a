// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! SlateDB's metrics, exported through OpenTelemetry.
//!
//! SlateDB registers each metric (`slatedb.db.write_ops`,
//! `slatedb.db_cache.access_count{entry_kind,result}`,
//! `slatedb.object_store.request_duration_seconds`, ...) once with a
//! [`MetricsRecorder`] and updates it through the handle it gets back.
//! [`OtelMetricsRecorder`] makes each one an OpenTelemetry instrument
//! carrying its labels as attributes.

use std::sync::Arc;

use opentelemetry::KeyValue;
use opentelemetry::metrics::{Counter, Gauge, Histogram, Meter, UpDownCounter};
use slatedb_common::metrics::{CounterFn, GaugeFn, HistogramFn, MetricsRecorder, UpDownCounterFn};

/// A SlateDB [`MetricsRecorder`] registering OpenTelemetry instruments.
///
/// Instruments are created on the meter provider in place when SlateDB
/// registers them (as a database or compactor is built), so create the
/// recorder after [`init_metrics`](crate::init_metrics) has installed the
/// global provider; instruments created before it stay no-ops.
pub struct OtelMetricsRecorder {
    meter: Meter,
}

impl OtelMetricsRecorder {
    /// A recorder on the global meter provider.
    pub fn new() -> Arc<Self> {
        Self::with_meter(opentelemetry::global::meter("slatedb"))
    }

    /// A recorder on `meter`.
    pub fn with_meter(meter: Meter) -> Arc<Self> {
        Arc::new(Self { meter })
    }
}

/// An instrument and the attributes SlateDB registered it with.
struct Labeled<I> {
    instrument: I,
    attributes: Vec<KeyValue>,
}

impl<I> Labeled<I> {
    fn new(instrument: I, labels: &[(&str, &str)]) -> Arc<Self> {
        let attributes = labels
            .iter()
            .map(|(key, value)| KeyValue::new(key.to_string(), value.to_string()))
            .collect();
        Arc::new(Self {
            instrument,
            attributes,
        })
    }
}

impl CounterFn for Labeled<Counter<u64>> {
    fn increment(&self, value: u64) {
        self.instrument.add(value, &self.attributes);
    }
}

impl GaugeFn for Labeled<Gauge<i64>> {
    fn set(&self, value: i64) {
        self.instrument.record(value, &self.attributes);
    }
}

impl UpDownCounterFn for Labeled<UpDownCounter<i64>> {
    fn increment(&self, value: i64) {
        self.instrument.add(value, &self.attributes);
    }
}

impl HistogramFn for Labeled<Histogram<f64>> {
    fn record(&self, value: f64) {
        self.instrument.record(value, &self.attributes);
    }
}

impl MetricsRecorder for OtelMetricsRecorder {
    fn register_counter(
        &self,
        name: &str,
        description: &str,
        labels: &[(&str, &str)],
    ) -> Arc<dyn CounterFn> {
        let counter = self
            .meter
            .u64_counter(name.to_string())
            .with_description(description.to_string())
            .build();
        Labeled::new(counter, labels)
    }

    fn register_gauge(
        &self,
        name: &str,
        description: &str,
        labels: &[(&str, &str)],
    ) -> Arc<dyn GaugeFn> {
        let gauge = self
            .meter
            .i64_gauge(name.to_string())
            .with_description(description.to_string())
            .build();
        Labeled::new(gauge, labels)
    }

    fn register_up_down_counter(
        &self,
        name: &str,
        description: &str,
        labels: &[(&str, &str)],
    ) -> Arc<dyn UpDownCounterFn> {
        let counter = self
            .meter
            .i64_up_down_counter(name.to_string())
            .with_description(description.to_string())
            .build();
        Labeled::new(counter, labels)
    }

    fn register_histogram(
        &self,
        name: &str,
        description: &str,
        labels: &[(&str, &str)],
        boundaries: &[f64],
    ) -> Arc<dyn HistogramFn> {
        let histogram = self
            .meter
            .f64_histogram(name.to_string())
            .with_description(description.to_string())
            .with_boundaries(boundaries.to_vec())
            .build();
        Labeled::new(histogram, labels)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};
    use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
    use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider, Temporality};

    use super::*;

    /// What an export carried: each metric's name, and the `op`-labelled
    /// points of `slatedb.db.request_count`.
    #[derive(Debug, Default)]
    struct Captured {
        names: std::collections::BTreeSet<String>,
        request_counts: Vec<(String, u64)>,
    }

    #[derive(Clone, Debug, Default)]
    struct Capture(Arc<Mutex<Captured>>);

    impl PushMetricExporter for Capture {
        async fn export(&self, metrics: &ResourceMetrics) -> OTelSdkResult {
            let mut captured = self.0.lock().unwrap();
            for metric in metrics.scope_metrics().flat_map(|scope| scope.metrics()) {
                captured.names.insert(metric.name().to_string());
                if metric.name() != "slatedb.db.request_count" {
                    continue;
                }
                let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() else {
                    panic!("request_count is not a u64 sum: {:?}", metric.data());
                };
                for point in sum.data_points() {
                    let op = point
                        .attributes()
                        .find(|kv| kv.key.as_str() == "op")
                        .map(|kv| kv.value.to_string())
                        .unwrap_or_default();
                    captured.request_counts.push((op, point.value()));
                }
            }
            Ok(())
        }
        fn force_flush(&self) -> OTelSdkResult {
            Ok(())
        }
        fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
            Ok(())
        }
        fn temporality(&self) -> Temporality {
            Temporality::Cumulative
        }
    }

    #[test]
    fn slatedb_metrics_become_labeled_instruments() {
        let capture = Capture::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(capture.clone()).build())
            .build();
        let recorder = OtelMetricsRecorder::with_meter(provider.meter("slatedb"));

        let gets = recorder.register_counter("slatedb.db.request_count", "", &[("op", "get")]);
        let scans = recorder.register_counter("slatedb.db.request_count", "", &[("op", "scan")]);
        gets.increment(3);
        scans.increment(1);
        recorder
            .register_gauge("slatedb.db.l0_sst_count", "", &[])
            .set(7);
        recorder
            .register_up_down_counter("slatedb.db.total_mem_size_bytes", "", &[])
            .increment(-2);
        recorder
            .register_histogram(
                "slatedb.object_store.request_duration_seconds",
                "",
                &[],
                &[0.1, 1.0],
            )
            .record(0.5);

        provider.force_flush().expect("flush");
        let captured = capture.0.lock().unwrap();
        assert_eq!(
            captured
                .names
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "slatedb.db.l0_sst_count",
                "slatedb.db.request_count",
                "slatedb.db.total_mem_size_bytes",
                "slatedb.object_store.request_duration_seconds",
            ]
        );
        let mut by_op = captured.request_counts.clone();
        by_op.sort();
        assert_eq!(by_op, [("get".to_string(), 3), ("scan".to_string(), 1)]);
    }
}
