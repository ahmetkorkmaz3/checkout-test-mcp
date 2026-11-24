import { describe, expect, it } from 'vitest';
import {
  type InspectionReport,
  REPORT_SECTIONS,
  RESULT_CHAR_LIMIT,
  sliceForResult,
  trimForResult,
} from '../../src/inspect/report.js';
import { PRODUCTION_WARNING } from '../../src/safety/production.js';

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

describe('trimForResult without site', () => {
  it('trims a report with site null that is still over the cap', () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({
      action: `fill field ${i} ${'x'.repeat(150)}`,
      page_kind: 'checkout' as const,
      url_path: '/checkout',
      result: 'done' as const,
    }));
    const r = report({
      checkout_probe: {
        reached: 'checkout',
        stopped_reason: 'form_not_understood',
        steps,
        dialogs: [],
        guest_option: false,
        payment: null,
        side_effects: [],
      },
    });
    expect(JSON.stringify(r).length).toBeGreaterThan(RESULT_CHAR_LIMIT);
    const out = trimForResult(r);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    expect(out.warnings.at(-1)).toContain('checkout_probe.steps');
  });
});

describe('sliceForResult', () => {
  const wrap = (r: InspectionReport, slice: unknown) => ({ ...r, slice });

  it('has an otp_hints section', () => {
    expect(REPORT_SECTIONS).toContain('otp_hints');
    const r = report({
      code: {
        frameworks: [],
        routes: [],
        ui_strings: [],
        test_ids: [],
        payment_hints: [],
        otp_hints: [{ text: 'sendOtp', file: 'a.ts', line: 1 }],
        stats: { files: 1, skipped: 0, truncated: false },
        warnings: [],
      },
    });
    expect(sliceForResult(r, 'otp_hints', 0, wrap).slice.items).toEqual([
      { text: 'sendOtp', file: 'a.ts', line: 1 },
    ]);
  });

  it('cuts the lists of one item that alone is larger than the cap and says so', () => {
    const big = {
      path_pattern: '/big',
      url_path: '/big',
      kind: 'other' as const,
      kind_reasons: [],
      title: 'Big',
      headings: [],
      landmarks: [],
      elements: Array.from({ length: 400 }, (_, i) => ({
        role: 'button',
        name: `${i} ${'n'.repeat(190)}`,
        visible: true,
      })),
      forms: [],
      selects: [],
      iframes: [],
      dialogs: [],
    };
    const r = report({ site: { pages: [big], api_calls: [], blocked_hosts: [] } });
    const out = sliceForResult(r, 'pages', 0, wrap);
    expect(JSON.stringify(wrap(out.report, out.slice)).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const item = out.slice.items[0] as typeof big;
    expect(item.path_pattern).toBe('/big');
    expect(item.elements.length).toBeGreaterThan(0);
    expect(item.elements.length).toBeLessThan(400);
    expect(out.report.warnings.join(' ')).toMatch(/item 0 of "pages" is larger than the cap/);
    // The stored report keeps the full item.
    expect(r.site?.pages[0]?.elements).toHaveLength(400);
  });
  it('keeps the production warning first in a slice and counts it in the size', () => {
    const pages = Array.from({ length: 60 }, (_, i) => ({
      path_pattern: `/p${i}`,
      url_path: `/p${i}`,
      kind: 'other' as const,
      kind_reasons: [],
      title: 'x'.repeat(1000),
      headings: [],
      landmarks: [],
      elements: [],
      forms: [],
      selects: [],
      iframes: [],
      dialogs: [],
    }));
    const r = report({
      warnings: [PRODUCTION_WARNING, 'Another warning.'],
      site: { pages, api_calls: [], blocked_hosts: [] },
    });
    const out = sliceForResult(r, 'pages', 0, wrap);
    expect(out.report.warnings[0]).toBe(PRODUCTION_WARNING);
    expect(out.report.warnings).not.toContain('Another warning.');
    expect(out.slice.next_offset).not.toBeNull();
    expect(JSON.stringify(wrap(out.report, out.slice)).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const next = sliceForResult(r, 'pages', out.slice.next_offset ?? 0, wrap);
    expect(next.report.warnings[0]).toBe(PRODUCTION_WARNING);
  });

  it('has no production warning in a slice of a test target report', () => {
    const out = sliceForResult(report({ warnings: ['Another warning.'] }), 'pages', 0, wrap);
    expect(out.report.warnings).not.toContain(PRODUCTION_WARNING);
  });
});
