import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";

interface HeatmapChartProps {
  width?: number;
  height?: number;
  onCellClick?: (timeIdx: number, bucketIdx: number) => void;
}

// Heatmap color palette (cold to hot)
const HEATMAP_PALETTE = [
  "#313244",
  "#45475a",
  "#585b70",
  "#6c7086",
  "#7f849c",
  "#f9e2af", // warm
  "#fab387",
  "#f38ba8",
  "#f5c2e7",
  "#cba6f7", // hot
];

function generateMockHeatmapData() {
  const now = Math.floor(Date.now() / 1000);
  const bucketCount = 60; // time buckets
  const yBuckets = 20; // latency buckets (e.g., 0-10ms, 10-20ms, etc.)

  // Generate timestamps (one per minute going back)
  const times: number[] = [];
  for (let i = 0; i < bucketCount; i++) {
    times.push(now - (bucketCount - 1 - i) * 60);
  }

  // Generate counts for each y-bucket at each time
  // Data format: [times, bucket0Counts, bucket1Counts, ...]
  const data: number[][] = [times];

  for (let y = 0; y < yBuckets; y++) {
    const bucketData: number[] = [];
    for (let x = 0; x < bucketCount; x++) {
      // Create realistic latency distribution - most requests are fast
      const baseProb = Math.exp(-y * 0.3); // exponential decay
      const timeFactor = 1 + 0.5 * Math.sin(x * 0.2); // some time variation
      const noise = Math.random() * 0.5;
      const count = Math.max(0, Math.floor(100 * baseProb * timeFactor * (0.5 + noise)));
      bucketData.push(count);
    }
    data.push(bucketData);
  }

  return { data, yBuckets };
}

// Custom heatmap draw hook for uPlot
function heatmapPlugin(yBuckets: number, _yMax: number, palette: string[], maxCount: number) {
  return {
    hooks: {
      drawClear: (u: uPlot) => {
        // Fill background
        const ctx = u.ctx;
        ctx.save();
        ctx.fillStyle = "#1e1e2e";
        ctx.fillRect(0, 0, u.width, u.height);
        ctx.restore();
      },
      draw: (u: uPlot) => {
        const ctx = u.ctx;
        const data = u.data;
        const xData = data[0];

        // Get the plotting area bounds
        const { left, top, width, height } = u.bbox;

        // Calculate cell dimensions
        const cellWidth = width / (xData.length - 1);
        const cellHeight = height / yBuckets;

        ctx.save();

        // Draw each cell
        for (let yi = 0; yi < yBuckets; yi++) {
          const seriesData = data[yi + 1];
          if (!seriesData) continue;

          // Y position: bucket 0 is at bottom, bucket N-1 is at top
          const yPos = top + (yBuckets - 1 - yi) * cellHeight;

          for (let xi = 0; xi < xData.length - 1; xi++) {
            const count = seriesData[xi] as number;
            if (count === 0) continue;

            // Map count to color
            const intensity = Math.min(count / maxCount, 1);
            const colorIdx = Math.min(
              Math.floor(intensity * palette.length),
              palette.length - 1
            );
            ctx.fillStyle = palette[colorIdx];

            // X position based on data index
            const xPos = left + xi * cellWidth;

            ctx.fillRect(
              Math.round(xPos),
              Math.round(yPos),
              Math.ceil(cellWidth) + 1,
              Math.ceil(cellHeight) + 1
            );
          }
        }

        ctx.restore();
      },
    },
  };
}

export default function HeatmapChart({
  width = 900,
  height = 300,
  onCellClick,
}: HeatmapChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const dataRef = useRef<{ data: number[][]; yBuckets: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const { data, yBuckets } = generateMockHeatmapData();
    dataRef.current = { data, yBuckets };

    // Find max count for color scaling
    let maxCount = 0;
    for (let i = 1; i < data.length; i++) {
      for (const val of data[i]) {
        if (val > maxCount) maxCount = val;
      }
    }

    const yMax = yBuckets * 10; // 10ms per bucket

    const opts: uPlot.Options = {
      width,
      height,
      class: "heatmap-chart",
      cursor: {
        show: true,
        x: true,
        y: true,
        points: { show: false },
      },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: {
          range: [0, yMax],
        },
      },
      axes: [
        {
          stroke: "#6c7086",
          grid: { show: false },
          ticks: { stroke: "#45475a", width: 1 },
          font: "11px ui-monospace, monospace",
        },
        {
          stroke: "#6c7086",
          grid: { show: false },
          ticks: { stroke: "#45475a", width: 1 },
          font: "11px ui-monospace, monospace",
          values: (_u, vals) => vals.map((v) => `${v}ms`),
        },
      ],
      series: [
        {}, // x-axis (time)
        {
          paths: () => null, // Don't draw default paths
          points: { show: false },
        },
      ],
      plugins: [heatmapPlugin(yBuckets, yMax, HEATMAP_PALETTE, maxCount)],
    };

    // Only pass first two series to uPlot (time + one dummy series)
    const uplotData = [data[0], data[1]] as uPlot.AlignedData;

    // Store full data for the plugin
    const chart = new uPlot(opts, uplotData, containerRef.current);
    // @ts-ignore - attach full data for plugin access
    chart.data = data;
    chartRef.current = chart;

    // Handle click events
    if (onCellClick && containerRef.current) {
      const container = containerRef.current;
      const handleClick = (e: MouseEvent) => {
        const chart = chartRef.current;
        const d = dataRef.current;
        if (!chart || !d) return;

        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const { left, top, width: bw, height: bh } = chart.bbox;

        // Check if click is in plot area
        if (x < left || x > left + bw || y < top || y > top + bh) return;

        // Calculate bucket indices
        const relX = x - left;
        const relY = y - top;

        const timeIdx = Math.floor((relX / bw) * (d.data[0].length - 1));
        const bucketIdx = d.yBuckets - 1 - Math.floor((relY / bh) * d.yBuckets);

        if (timeIdx >= 0 && bucketIdx >= 0 && bucketIdx < d.yBuckets) {
          onCellClick(timeIdx, bucketIdx);
        }
      };

      container.addEventListener("click", handleClick);

      return () => {
        container.removeEventListener("click", handleClick);
        chartRef.current?.destroy();
        chartRef.current = null;
      };
    }

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [width, height, onCellClick]);

  return (
    <div class="heatmap-container">
      <div ref={containerRef} />
      <div class="flex items-center justify-between mt-3 text-xs text-[var(--text-muted)]">
        <span>Latency distribution (10ms buckets)</span>
        <div class="flex items-center gap-2">
          <span>Less</span>
          <div class="flex">
            {HEATMAP_PALETTE.map((color, i) => (
              <div
                key={i}
                class="w-4 h-3"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
