import { useEffect, useRef } from 'react';
import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

export default function LineChart({ labels, datasets, min, max, y2, height = 210 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    chartRef.current = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#16201a',
            titleFont: { family: 'IBM Plex Mono', size: 11 },
            bodyFont: { family: 'IBM Plex Mono', size: 12 },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 6, color: cssVar('--chart-tick'), font: { family: 'IBM Plex Mono', size: 10 } },
            grid: { color: 'transparent' },
          },
          y: {
            min,
            max,
            ticks: { color: cssVar('--chart-tick'), font: { family: 'IBM Plex Mono', size: 10 } },
            grid: { color: cssVar('--chart-grid') },
          },
          ...(y2
            ? {
                y2: {
                  position: 'right',
                  min: y2.min,
                  max: y2.max,
                  ticks: { color: cssVar('--chart-tick'), font: { family: 'IBM Plex Mono', size: 10 } },
                  grid: { drawOnChartArea: false },
                },
              }
            : {}),
        },
      },
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.update('none');
  }, [labels, datasets]);

  return (
    <div className="chart-wrap" style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}