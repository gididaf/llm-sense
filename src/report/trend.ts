import type { HistoryEntry } from '../types.js';

// Generates an ASCII trend chart from score history.
// Uses simple string manipulation — no charting library needed.
export function formatTrendChart(history: HistoryEntry[]): string {
  if (history.length === 0) return '  No history found. Run llm-sense first.';
  if (history.length === 1) return `  Only 1 data point (score: ${history[0].overallScore}). Run llm-sense again to see a trend.`;

  const lines: string[] = [];
  const scores = history.map(h => h.overallScore);
  const dates = history.map(h => {
    const d = new Date(h.timestamp);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  // Chart dimensions
  const chartHeight = 12;
  const chartWidth = Math.min(Math.max(scores.length * 4, 20), 60);

  // Y-axis range (round to nearest 10)
  const minScore = Math.floor(Math.min(...scores) / 10) * 10;
  const maxScore = Math.ceil(Math.max(...scores) / 10) * 10;
  const range = maxScore - minScore || 10;

  const projectName = history[0].targetPath.split('/').pop() ?? '';
  lines.push('');
  lines.push(`  Score Trend for ${projectName}`);
  lines.push('  ' + '─'.repeat(chartWidth + 8));

  // Build chart grid
  for (let row = chartHeight; row >= 0; row--) {
    const yValue = minScore + (row / chartHeight) * range;
    const yLabel = String(Math.round(yValue)).padStart(4);

    let rowStr = `  ${yLabel} │`;

    // Plot each data point
    for (let i = 0; i < scores.length; i++) {
      const xPos = Math.round((i / (scores.length - 1)) * (chartWidth - 1));
      const yPos = Math.round(((scores[i] - minScore) / range) * chartHeight);

      // Check if this row should have a dot at this x position
      if (yPos === row) {
        // Pad to the correct x position
        while (rowStr.length < xPos + 8) rowStr += ' ';
        rowStr += '●';
      }
    }

    lines.push(rowStr);
  }

  // X-axis
  lines.push('  ' + ' '.repeat(4) + ' └' + '─'.repeat(chartWidth));

  // X-axis labels (show first, last, and a few in between)
  let labelLine = '  ' + ' '.repeat(6);
  const labelCount = Math.min(dates.length, 6);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / (labelCount - 1)) * (dates.length - 1));
    const xPos = Math.round((idx / (scores.length - 1)) * (chartWidth - 1));
    while (labelLine.length < xPos + 6) labelLine += ' ';
    labelLine += dates[idx];
  }
  lines.push(labelLine);

  // Summary stats
  lines.push('');
  const latest = scores[scores.length - 1];
  const first = scores[0];
  const delta = latest - first;
  const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
  lines.push(`  Current: ${latest}/100  |  Start: ${first}/100  |  Change: ${deltaStr}  |  Runs: ${scores.length}`);
  lines.push('');

  return lines.join('\n');
}
