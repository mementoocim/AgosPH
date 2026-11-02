import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  LegendComponent,
  CanvasRenderer,
]);
export interface Series {
  name: string;
  values: (number | null)[];
  color: string;
  type?: 'line' | 'bar';
  area?: boolean;
}
export function Chart({
  labels,
  series,
  height = 180,
  unit = '',
  thresholds = [],
  cursor,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  unit?: string;
  thresholds?: { value: number; name: string }[];
  cursor?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chart.setOption({
      animationDuration: 250,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'Segoe UI, sans-serif', fontSize: 10 },
      grid: { left: 38, right: 12, top: 22, bottom: 26 },
      legend: {
        show: series.length > 1,
        textStyle: { color: '#91a4b4', fontSize: 10 },
        top: 0,
        itemWidth: 12,
        itemHeight: 4,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#111d29',
        borderColor: '#294455',
        textStyle: { color: '#d3e5ef', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: series.some((s) => s.type === 'bar'),
        axisLabel: { color: '#758b9b', fontSize: 10 },
        axisLine: { lineStyle: { color: '#243440' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: unit,
        nameTextStyle: { color: '#91a4b4', fontSize: 10 },
        splitLine: { lineStyle: { color: '#20303b', type: 'dashed' } },
        axisLabel: { color: '#758b9b', fontSize: 10 },
      },
      series: series.map((s, i) => ({
        name: s.name,
        type: s.type ?? 'line',
        data: s.values,
        symbol: 'none',
        smooth: false,
        lineStyle: { color: s.color, width: 2 },
        itemStyle: { color: s.color },
        areaStyle: s.area
          ? {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: s.color + '45' },
                { offset: 1, color: s.color + '00' },
              ]),
            }
          : undefined,
        markLine:
          i === 0
            ? {
                silent: true,
                symbol: 'none',
                label: { fontSize: 9, color: '#d3a270', position: 'insideEndTop' },
                lineStyle: { type: 'dashed', color: '#bd8d5a' },
                data: [
                  ...thresholds.map((t) => ({
                    yAxis: t.value,
                    name: t.name,
                    label: { formatter: t.name },
                  })),
                  ...(cursor != null && labels[cursor]
                    ? [
                        {
                          xAxis: labels[cursor],
                          label: { show: false },
                          lineStyle: { color: '#e7eef2' },
                        },
                      ]
                    : []),
                ],
              }
            : undefined,
      })),
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [labels, series, unit, thresholds, cursor]);
  return (
    <div
      ref={ref}
      style={{ height, width: '100%' }}
      role="img"
      aria-label={`${series.map((s) => s.name).join(' and ')} chart in ${unit}`}
    />
  );
}
