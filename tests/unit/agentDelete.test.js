/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
import { describe, expect, test, beforeAll, beforeEach } from '@playwright/test';
import {
  DELETE_BATCH_LIMIT,
  appendDeleteRecord,
  baseDeletionName,
  deletionGuardReason,
  grantDelete,
  isDeleteGranted,
  listDeleteGrants,
  normalizeDeletionPath,
  parentFolderPath,
  readDeleteHistory,
  revokeDelete,
  validateDeletePlan,
} from '-/utils/agentDelete';

let store = {};
beforeAll(() => {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
});
beforeEach(() => {
  store = {};
});

const LOCATIONS = ['/Users/demo/Notes', 'C:/Users/demo/Downloads'];

describe('normalizeDeletionPath / helpers', () => {
  test('统一分隔符并去掉结尾斜杠', () => {
    expect(normalizeDeletionPath('C:\\a\\b\\')).toBe('C:/a/b');
    expect(normalizeDeletionPath('/root/folder/')).toBe('/root/folder');
  });

  test('parentFolderPath / baseDeletionName', () => {
    expect(parentFolderPath('C:/a/b/file.txt')).toBe('C:/a/b');
    expect(baseDeletionName('C:/a/b/file.txt')).toBe('file.txt');
    expect(parentFolderPath('/root')).toBe('/root');
  });
});

describe('deletionGuardReason', () => {
  test('location 外路径拒绝', () => {
    expect(deletionGuardReason('/elsewhere/x.txt', LOCATIONS)).toBe(
      'path is outside all connected locations',
    );
  });

  test('location 根拒绝', () => {
    expect(deletionGuardReason('/Users/demo/Notes', LOCATIONS)).toBe(
      'refusing to delete a location root folder',
    );
    expect(deletionGuardReason('C:\\Users\\demo\\Downloads\\', LOCATIONS)).toBe(
      'refusing to delete a location root folder',
    );
  });

  test('.ts 元数据目录（含嵌套）拒绝', () => {
    expect(deletionGuardReason('/Users/demo/Notes/.ts', LOCATIONS)).toContain(
      '.ts',
    );
    expect(
      deletionGuardReason('/Users/demo/Notes/.ts/tsi.json', LOCATIONS),
    ).toContain('.ts');
  });

  test('隐藏/系统文件拒绝', () => {
    expect(
      deletionGuardReason('/Users/demo/Notes/.DS_Store', LOCATIONS),
    ).toContain('hidden');
    expect(
      deletionGuardReason('C:/Users/demo/Downloads/desktop.ini', LOCATIONS),
    ).toContain('hidden');
  });

  test('普通文件放行', () => {
    expect(
      deletionGuardReason('/Users/demo/Notes/report.docx', LOCATIONS),
    ).toBeUndefined();
  });
});

describe('validateDeletePlan', () => {
  test('delete_files 只收文件，文件夹转 delete_folder', () => {
    const { valid, invalid } = validateDeletePlan(
      [
        { path: '/Users/demo/Notes/a.txt', isFile: true },
        { path: '/Users/demo/Notes/Sub', isFile: false },
      ],
      LOCATIONS,
      true,
    );
    expect(valid.map((v) => v.path)).toEqual(['/Users/demo/Notes/a.txt']);
    expect(invalid[0].reason).toContain('delete_folder');
  });

  test('去重 + 护栏原因归入 invalid', () => {
    const { valid, invalid } = validateDeletePlan(
      [
        { path: '/Users/demo/Notes/a.txt', isFile: true },
        { path: '/Users/demo/Notes/a.txt', isFile: true },
        { path: '/Users/demo/Notes/.secret', isFile: true },
        { path: '/Users/demo/Notes/.ts/x', isFile: true },
      ],
      LOCATIONS,
      true,
    );
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(2);
  });

  test('delete_folder 只收文件夹', () => {
    const { valid, invalid } = validateDeletePlan(
      [{ path: '/Users/demo/Notes/Sub', isFile: false, name: 'Sub' }],
      LOCATIONS,
      false,
    );
    expect(valid).toHaveLength(1);
    expect(valid[0].name).toBe('Sub');
    const filePlan = validateDeletePlan(
      [{ path: '/Users/demo/Notes/a.txt', isFile: true }],
      LOCATIONS,
      false,
    );
    expect(filePlan.valid).toHaveLength(0);
    expect(filePlan.invalid[0].reason).toContain('delete_files');
  });

  test('name 缺省时从路径推导', () => {
    const { valid } = validateDeletePlan(
      [{ path: 'C:/Users/demo/Downloads/old.pdf', isFile: true }],
      LOCATIONS,
      true,
    );
    expect(valid[0].name).toBe('old.pdf');
  });
});

describe('按文件夹授权', () => {
  test('默认未授权 → grant 后可删 → revoke 撤销', () => {
    expect(isDeleteGranted('/Users/demo/Notes')).toBe(false);
    grantDelete('/Users/demo/Notes/');
    expect(isDeleteGranted('/Users/demo/Notes')).toBe(true);
    revokeDelete('/Users/demo/Notes');
    expect(isDeleteGranted('/Users/demo/Notes')).toBe(false);
  });

  test('授权数量超过上限时裁掉最旧', () => {
    for (let i = 0; i < 105; i += 1) {
      grantDelete('/root/f' + i);
    }
    const grants = listDeleteGrants();
    expect(grants.length).toBeLessThanOrEqual(100);
    expect(isDeleteGranted('/root/f0')).toBe(false);
    expect(isDeleteGranted('/root/f104')).toBe(true);
  });
});

describe('删除历史', () => {
  test('appendDeleteRecord 记录并读回', () => {
    appendDeleteRecord({
      id: 'rec1',
      items: [{ path: '/root/a.txt', name: 'a.txt', isFile: true, ok: true }],
    });
    const records = readDeleteHistory();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rec1');
    expect(records[0].date).toBeTruthy();
  });

  test('超过上限只保留最近记录', () => {
    for (let i = 0; i < 25; i += 1) {
      appendDeleteRecord({
        id: 'rec' + i,
        items: [],
      });
    }
    const records = readDeleteHistory();
    expect(records).toHaveLength(20);
    expect(records[0].id).toBe('rec5');
    expect(records[19].id).toBe('rec24');
  });
});

describe('DELETE_BATCH_LIMIT', () => {
  test('单批上限为 50', () => {
    expect(DELETE_BATCH_LIMIT).toBe(50);
  });
});
