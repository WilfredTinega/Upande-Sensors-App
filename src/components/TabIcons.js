import React from 'react';
import Svg, { Line } from 'react-native-svg';

/**
 * The Readings tab glyph: three plain horizontal bars, drawn by hand.
 *
 * Ionicons has two three-bar glyphs and neither sits well beside the others.
 * `reorder-three` runs bar-to-bar across the full box with a heavy stroke, so
 * it reads as a bigger, bolder icon than its neighbours; `menu` is drawn narrow
 * and thin, so at the same nominal size it reads as a small one. Scaling
 * either only trades one mismatch for the other, because the problem is the
 * shape inside the box, not the box.
 *
 * So the bars are drawn to match how the Ionicons outline set is drawn: on a
 * 512 grid with a 32-unit stroke and round caps, occupying roughly the middle
 * three quarters of the box — the same footprint `home-outline` and
 * `bar-chart-outline` fill. Every tab then carries the same stroke weight and
 * the same visual extent, and this one stops standing out.
 */
export function ReadingsTabIcon({ size = 24, color }) {
  // Ionicons outline glyphs: 32/512 stroke. Same ratio here, so the bars
  // weigh what the house and the chart weigh at any size.
  const stroke = (32 / 512) * size;
  // Bar extent and spacing on the same 512 grid: from 96 to 416 across, at
  // 160 / 256 / 352 down — the footprint the neighbouring glyphs occupy.
  const x1 = (96 / 512) * size;
  const x2 = (416 / 512) * size;
  const rows = [160, 256, 352].map((y) => (y / 512) * size);

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {rows.map((y) => (
        <Line
          key={y}
          x1={x1}
          y1={y}
          x2={x2}
          y2={y}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}
