import { describe, expect, test } from '@playwright/test';
import {
  findNeighborTab,
  MAX_OPENED_FILE_TABS,
  removeOpenedFileTab,
  tabKey,
  upsertOpenedFileTab,
} from '-/utils/openedFileTabs';

function makeEntry(name, path, locationID = 'loc1', lmdt = 1) {
  return {
    name,
    isFile: true,
    path: path || '/dir/' + name,
    extension: 'md',
    locationID,
    lmdt,
  };
}

describe('openedFileTabs', () => {
  describe('tabKey', () => {
    test('distinguishes same path in different locations', () => {
      expect(tabKey({ path: '/a', locationID: 'l1' })).toBe('l1|/a');
      expect(tabKey({ path: '/a', locationID: 'l2' })).not.toBe(
        tabKey({ path: '/a', locationID: 'l1' }),
      );
    });
  });

  describe('upsertOpenedFileTab', () => {
    test('appends new files in open order', () => {
      let tabs = [];
      tabs = upsertOpenedFileTab(tabs, makeEntry('a.md', '/a.md'));
      tabs = upsertOpenedFileTab(tabs, makeEntry('b.md', '/b.md'));
      expect(tabs.map((t) => t.path)).toEqual(['/a.md', '/b.md']);
    });

    test('updates an existing tab in place instead of duplicating it', () => {
      let tabs = upsertOpenedFileTab([], makeEntry('a.md', '/a.md', 'loc1', 1));
      tabs = upsertOpenedFileTab(tabs, makeEntry('a.md', '/a.md', 'loc1', 2));
      expect(tabs).toHaveLength(1);
      expect(tabs[0].lmdt).toBe(2);
    });

    test('keeps same-path files from different locations as separate tabs', () => {
      let tabs = upsertOpenedFileTab([], makeEntry('doc.md', '/docs', 'loc1'));
      tabs = upsertOpenedFileTab(tabs, makeEntry('doc.md', '/docs', 'loc2'));
      expect(tabs).toHaveLength(2);
    });

    test('drops the oldest tab beyond the cap', () => {
      let tabs = [];
      for (let i = 0; i < MAX_OPENED_FILE_TABS + 2; i++) {
        tabs = upsertOpenedFileTab(tabs, makeEntry('f' + i + '.md', '/' + i));
      }
      expect(tabs).toHaveLength(MAX_OPENED_FILE_TABS);
      expect(tabs[0].path).toBe('/2');
      expect(tabs[tabs.length - 1].path).toBe('/11');
    });

    test('ignores folders and path-less entries', () => {
      const folder = { ...makeEntry('folder'), isFile: false };
      expect(upsertOpenedFileTab([], folder)).toEqual([]);
      expect(upsertOpenedFileTab([], { name: 'x' })).toEqual([]);
    });
  });

  describe('removeOpenedFileTab', () => {
    test('removes only the given tab key', () => {
      let tabs = upsertOpenedFileTab([], makeEntry('a.md', '/a.md'));
      tabs = upsertOpenedFileTab(tabs, makeEntry('b.md', '/b.md'));
      expect(
        removeOpenedFileTab(tabs, tabKey({ path: '/a.md', locationID: 'loc1' })),
      ).toHaveLength(1);
      expect(
        removeOpenedFileTab(tabs, tabKey({ path: '/a.md', locationID: 'other' })),
      ).toHaveLength(2);
    });
  });

  describe('findNeighborTab', () => {
    const tabs = [
      { path: '/a', locationID: 'l1' },
      { path: '/b', locationID: 'l1' },
      { path: '/c', locationID: 'l1' },
    ];

    test('activates the next tab when closing a middle one', () => {
      expect(findNeighborTab(tabs, 'l1|/b').path).toBe('/c');
    });

    test('activates the previous tab when closing the last one', () => {
      expect(findNeighborTab(tabs, 'l1|/c').path).toBe('/b');
    });

    test('returns undefined when nothing remains or key is unknown', () => {
      expect(findNeighborTab(tabs, 'l1|/nope')).toBeUndefined();
      expect(findNeighborTab([{ path: '/a', locationID: 'l1' }], 'l1|/a')).toBeUndefined();
    });
  });
});
