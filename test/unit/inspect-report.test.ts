import { describe, expect, it } from 'vitest';
import { type InspectionReport, RESULT_CHAR_LIMIT, trimForResult } from '../../src/inspect/report.js';

function report(extra: Partial<InspectionReport> = {}): InspectionReport {
  return {
    inspection_id: 'insp_Q2x8LmN4pR7sTv0a',
    target: 'k',
    status: 'finished',
    interrupted: false,
    progress: 'Finished.',
    site: null,
    checkout_probe: null,
    code: null,
    suggested_scenarios: [],
    warnings: [],
    side_effects: [],
    report_path: '/tmp/runs/inspections/insp_Q2x8LmN4pR7sTv0a.json',
    ...extra,
  };
}

describe('trimForResult', () => {
  it('returns a small report unchanged', () => {
    const r = report();
    expect(trimForResult(r)).toBe(r);
  });

  it('counts the fields that the wrap adds', () => {
    const code = {
      frameworks: [],
      routes: [],
      ui_strings: Array.from({ length: 200 }, (_, i) => ({
        key: `k${i}`,
        text: 'x'.repeat(100),
        file: 'a',
        line: i,
      })),
      test_ids: [],
      payment_hints: [],
      otp_hints: [],
      stats: { files: 1, skipped: 0, truncated: false },
      warnings: [],
    };
    const r = report({ code });
    const pad = 'y'.repeat(RESULT_CHAR_LIMIT - JSON.stringify(r).length + 10);
    // Without the wrap the report fits. With the wrap it does not.
    expect(trimForResult(r)).toBe(r);
    const wrap = (x: InspectionReport) => ({ ...x, pad });
    const out = trimForResult(r, wrap);
    expect(out.code?.ui_strings).toEqual([]);
    expect(JSON.stringify(wrap(out)).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
  });

  it('never writes an empty cut list and keeps the warning inside the limit', () => {
    const pages = Array.from({ length: 400 }, (_, i) => ({
      path_pattern: `/p-${i}`,
      url_path: `/p-${i}`,
      kind: 'other' as const,
      kind_reasons: [],
      title: 't'.repeat(80),
      headings: [],
      landmarks: [],
      elements: [],
      forms: [],
      selects: [],
      iframes: [],
      dialogs: [],
    }));
    const out = trimForResult(report({ site: { pages, api_calls: [], blocked_hosts: [] } }));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const w = out.warnings.at(-1) ?? '';
    expect(w).not.toMatch(/Cut: \./);
    expect(w).toMatch(/with offset 0, then next_offset/);
    expect(w).not.toContain('/tmp/runs');
    expect(w).toContain(`site.pages after the first ${out.site?.pages.length} of 400`);
  });
});
