import { describe, expect, test } from '@playwright/test';
import { groupFileVersions } from '-/utils/fileVersionGrouper';

/**
 * Helper to create a mock FileSystemEntry
 */
function makeEntry(name, path, lmdt, isFile = true, size = 1024) {
  return {
    name,
    isFile,
    path: path || '/some/dir/' + name,
    extension: name.includes('.')
      ? name.slice(name.lastIndexOf('.') + 1)
      : '',
    size,
    lmdt: lmdt || Date.now(),
    tags: [],
  };
}

// Base names must pass the weighted length gate (>= 12, CJK chars count 2):
// 'quarterly-report' = 16, 'monthly-summary' = 15, '年度财务结算报告' = 16.
const REPORT = 'quarterly-report';
const SUMMARY = 'monthly-summary';
const CJK_REPORT = '年度财务结算报告';

describe('fileVersionGrouper', () => {
  describe('groupFileVersions', () => {
    test('groups files with -vN suffix', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v3.docx`, `/docs/${REPORT}-v3.docx`, 3000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].baseName).toBe(REPORT);
      expect(groups[0].extension).toBe('docx');
      expect(groups[0].files).toHaveLength(3);
    });

    test('keeps latest 2 versions by default', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v3.docx`, `/docs/${REPORT}-v3.docx`, 3000),
        makeEntry(`${REPORT}-v4.docx`, `/docs/${REPORT}-v4.docx`, 4000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].toKeep).toHaveLength(2);
      expect(groups[0].toDelete).toHaveLength(2);
      // toKeep should contain v4 and v3 (latest two)
      expect(groups[0].toKeep[0].name).toBe(`${REPORT}-v4.docx`);
      expect(groups[0].toKeep[1].name).toBe(`${REPORT}-v3.docx`);
      // toDelete should contain v2 and v1
      expect(groups[0].toDelete[0].name).toBe(`${REPORT}-v2.docx`);
      expect(groups[0].toDelete[1].name).toBe(`${REPORT}-v1.docx`);
    });

    test('respects custom keepCount', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v3.docx`, `/docs/${REPORT}-v3.docx`, 3000),
      ];
      const groups = groupFileVersions(entries, 1);
      expect(groups).toHaveLength(1);
      expect(groups[0].toKeep).toHaveLength(1);
      expect(groups[0].toDelete).toHaveLength(2);
    });

    test('groups files with _vN suffix', () => {
      const entries = [
        makeEntry(`${SUMMARY}_v1.pptx`, `/slides/${SUMMARY}_v1.pptx`, 1000),
        makeEntry(`${SUMMARY}_v2.pptx`, `/slides/${SUMMARY}_v2.pptx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].baseName).toBe(SUMMARY);
    });

    test('groups files with space vN suffix', () => {
      const entries = [
        makeEntry(`${REPORT} v1.docx`, `/files/${REPORT} v1.docx`, 1000),
        makeEntry(`${REPORT} v2.docx`, `/files/${REPORT} v2.docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].baseName).toBe(REPORT);
    });

    test('groups files with (vN) suffix', () => {
      const entries = [
        makeEntry(`${SUMMARY}(v1).docx`, `/notes/${SUMMARY}(v1).docx`, 1000),
        makeEntry(`${SUMMARY}(v2).docx`, `/notes/${SUMMARY}(v2).docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].baseName).toBe(SUMMARY);
    });

    test('groups files with bare number suffix (no v prefix)', () => {
      const entries = [
        makeEntry(`${REPORT}-1.docx`, `/docs/${REPORT}-1.docx`, 1000),
        makeEntry(`${REPORT}-2.docx`, `/docs/${REPORT}-2.docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].files).toHaveLength(2);
    });

    test('handles dotted version numbers like -v1.2', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.1.docx`, `/docs/${REPORT}-v1.1.docx`, 1000),
        makeEntry(`${REPORT}-v1.2.docx`, `/docs/${REPORT}-v1.2.docx`, 2000),
        makeEntry(`${REPORT}-v2.0.docx`, `/docs/${REPORT}-v2.0.docx`, 3000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].toKeep[0].name).toBe(`${REPORT}-v2.0.docx`);
      expect(groups[0].toKeep[1].name).toBe(`${REPORT}-v1.2.docx`);
      expect(groups[0].toDelete[0].name).toBe(`${REPORT}-v1.1.docx`);
    });

    test('handles double-digit version numbers', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v10.docx`, `/docs/${REPORT}-v10.docx`, 2000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 3000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      // v10 > v2 > v1
      expect(groups[0].toKeep[0].name).toBe(`${REPORT}-v10.docx`);
      expect(groups[0].toKeep[1].name).toBe(`${REPORT}-v2.docx`);
      expect(groups[0].toDelete[0].name).toBe(`${REPORT}-v1.docx`);
    });

    test('skips files without version pattern', () => {
      const entries = [
        makeEntry(`${REPORT}.docx`, `/docs/${REPORT}.docx`, 1000),
        makeEntry(`${REPORT}-final.docx`, `/docs/${REPORT}-final.docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(0);
    });

    test('skips single-file groups', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${SUMMARY}-v1.pptx`, `/slides/${SUMMARY}-v1.pptx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(0);
    });

    test('separates groups by extension', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v1.pptx`, `/docs/${REPORT}-v1.pptx`, 3000),
        makeEntry(`${REPORT}-v2.pptx`, `/docs/${REPORT}-v2.pptx`, 4000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(2);
    });

    test('separates groups by base name', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${SUMMARY}-v1.docx`, `/docs/${SUMMARY}-v1.docx`, 3000),
        makeEntry(`${SUMMARY}-v2.docx`, `/docs/${SUMMARY}-v2.docx`, 4000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(2);
    });

    test('ignores directories', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v3`, `/docs/${REPORT}-v3`, 3000, false),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].files).toHaveLength(2);
    });

    test('sorts groups by file count descending', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/d/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/d/${REPORT}-v2.docx`, 2000),
        makeEntry(`${SUMMARY}-v1.docx`, `/d/${SUMMARY}-v1.docx`, 1000),
        makeEntry(`${SUMMARY}-v2.docx`, `/d/${SUMMARY}-v2.docx`, 2000),
        makeEntry(`${SUMMARY}-v3.docx`, `/d/${SUMMARY}-v3.docx`, 3000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(2);
      expect(groups[0].files).toHaveLength(3); // summary group first
      expect(groups[1].files).toHaveLength(2); // report group second
    });

    test('handles case-insensitive grouping', () => {
      const entries = [
        makeEntry(`Quarterly-Report-v1.docx`, `/docs/Quarterly-Report-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/${REPORT}-v2.docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
    });

    test('handles files in different directories', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.docx`, `/docs/a/${REPORT}-v1.docx`, 1000),
        makeEntry(`${REPORT}-v2.docx`, `/docs/b/${REPORT}-v2.docx`, 2000),
        makeEntry(`${REPORT}-v3.docx`, `/docs/c/${REPORT}-v3.docx`, 3000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].files).toHaveLength(3);
    });

    test('returns empty array for empty input', () => {
      expect(groupFileVersions([])).toHaveLength(0);
    });

    test('returns empty array when no versioned files found', () => {
      const entries = [
        makeEntry(`readme-notes.md`, `/docs/readme-notes.md`, 1000),
        makeEntry(`meeting-notes.txt`, `/docs/meeting-notes.txt`, 2000),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // False-positive guards
    // ------------------------------------------------------------------

    test('excludes short base names', () => {
      const entries = [
        makeEntry('report-v1.docx', '/docs/report-v1.docx', 1000),
        makeEntry('report-v2.docx', '/docs/report-v2.docx', 2000),
        makeEntry('a-v1.docx', '/docs/a-v1.docx', 1000),
        makeEntry('a-v2.docx', '/docs/a-v2.docx', 2000),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    test('accepts CJK base names via weighted length (6 CJK chars = 12)', () => {
      const entries = [
        makeEntry(`${CJK_REPORT}-v1.docx`, `/docs/${CJK_REPORT}-v1.docx`, 1000),
        makeEntry(`${CJK_REPORT}-v2.docx`, `/docs/${CJK_REPORT}-v2.docx`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].baseName).toBe(CJK_REPORT);
    });

    test('rejects too-short CJK base names', () => {
      const entries = [
        makeEntry('报告-v1.docx', '/docs/报告-v1.docx', 1000),
        makeEntry('报告-v2.docx', '/docs/报告-v2.docx', 2000),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    test('excludes non-office file types (photos, text, pdf)', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.jpg`, `/photos/${REPORT}-v1.jpg`, 1000),
        makeEntry(`${REPORT}-v2.jpg`, `/photos/${REPORT}-v2.jpg`, 2000),
        makeEntry(`${REPORT}-v1.txt`, `/docs/${REPORT}-v1.txt`, 1000),
        makeEntry(`${REPORT}-v2.txt`, `/docs/${REPORT}-v2.txt`, 2000),
        makeEntry(`${REPORT}-v1.pdf`, `/docs/${REPORT}-v1.pdf`, 1000),
        makeEntry(`${REPORT}-v2.pdf`, `/docs/${REPORT}-v2.pdf`, 2000),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    test('includes WPS and OpenDocument types', () => {
      const entries = [
        makeEntry(`${REPORT}-v1.wps`, `/docs/${REPORT}-v1.wps`, 1000),
        makeEntry(`${REPORT}-v2.wps`, `/docs/${REPORT}-v2.wps`, 2000),
        makeEntry(`${SUMMARY}-v1.odt`, `/docs/${SUMMARY}-v1.odt`, 1000),
        makeEntry(`${SUMMARY}-v2.odt`, `/docs/${SUMMARY}-v2.odt`, 2000),
        makeEntry(`${REPORT}-v1.et`, `/docs/${REPORT}-v1.et`, 1000),
        makeEntry(`${REPORT}-v2.et`, `/docs/${REPORT}-v2.et`, 2000),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(3);
    });

    test('excludes leading-zero sequence numbers (IMG_0001 style)', () => {
      const entries = [
        makeEntry(`${REPORT}_0001.docx`, `/docs/${REPORT}_0001.docx`, 1000),
        makeEntry(`${REPORT}_0002.docx`, `/docs/${REPORT}_0002.docx`, 2000),
        makeEntry(`${SUMMARY}_01.docx`, `/docs/${SUMMARY}_01.docx`, 1000),
        makeEntry(`${SUMMARY}_02.docx`, `/docs/${SUMMARY}_02.docx`, 2000),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    test('excludes bare 4-digit year suffixes', () => {
      const entries = [
        makeEntry(
          'annual-financial-report-2024.docx',
          '/docs/annual-financial-report-2024.docx',
          1000,
        ),
        makeEntry(
          'annual-financial-report-2025.docx',
          '/docs/annual-financial-report-2025.docx',
          2000,
        ),
        makeEntry(
          'department-budget (2024).xlsx',
          '/docs/department-budget (2024).xlsx',
          1000,
        ),
        makeEntry(
          'department-budget (2025).xlsx',
          '/docs/department-budget (2025).xlsx',
          2000,
        ),
      ];
      expect(groupFileVersions(entries)).toHaveLength(0);
    });

    test('keeps year numbers when explicitly v-prefixed', () => {
      const entries = [
        makeEntry(
          'annual-financial-report-v2024.docx',
          '/docs/annual-financial-report-v2024.docx',
          1000,
        ),
        makeEntry(
          'annual-financial-report-v2025.docx',
          '/docs/annual-financial-report-v2025.docx',
          2000,
        ),
      ];
      const groups = groupFileVersions(entries);
      expect(groups).toHaveLength(1);
      expect(groups[0].toKeep[0].name).toBe(
        'annual-financial-report-v2025.docx',
      );
    });
  });
});
