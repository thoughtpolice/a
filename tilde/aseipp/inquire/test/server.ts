import { metrics, trace } from "npm:@opentelemetry/api@1";

// Create a tracer and meter for our application
const tracer = trace.getTracer("my-server", "1.0.0");
const meter = metrics.getMeter("my-server", "1.0.0");

// Create some metrics
const requestCounter = meter.createCounter("http_requests_total", {
  description: "Total number of HTTP requests",
});

const requestDuration = meter.createHistogram("http_request_duration_ms", {
  description: "HTTP request duration in milliseconds",
  unit: "ms",
});

// Start the server
Deno.serve({ port: 8000 }, (req) => {
  // Record the start time for measuring request duration
  const startTime = performance.now();

  // Create a span for this request
  return tracer.startActiveSpan("handle_request", async (span) => {
    try {
      // Extract the path from the URL
      const url = new URL(req.url);
      const path = url.pathname;

      // Add attributes to the span
      span.setAttribute("http.route", path);
      span.setAttribute("http.method", req.method);
      span.updateName(`${req.method} ${path}`);

      // Add an event to the span
      span.addEvent("request_started", {
        timestamp: startTime,
        request_path: path,
      });

      // Simulate some processing time
      const waitTime = Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, waitTime));

      // Add another event to the span
      span.addEvent("processing_completed");

      // Create the response
      const response = new Response(`Hello from ${path}!`, {
        headers: { "Content-Type": "text/plain" },
      });

      // Record metrics
      requestCounter.add(1, {
        method: req.method,
        path,
        status: 200,
      });

      const duration = performance.now() - startTime;
      requestDuration.record(duration, {
        method: req.method,
        path,
      });

      span.setAttribute("request.duration_ms", duration);

      return response;
    } catch (error) {
      // Record error in span
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({
          code: trace.SpanStatusCode.ERROR,
          message: error.message,
        });
      }

      return new Response("Internal Server Error", { status: 500 });
    } finally {
      // Always end the span
      span.end();
    }
  });
});
