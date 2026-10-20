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
import { describe, expect, test } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  SKILL_INSTRUCTION_CAP,
  loadExtraDirs,
  saveExtraDirs,
  scanAll,
  scanSkillsDir,
  transformSkillMarkdown,
} from '../../src/main/skillScanner';




const writeSkill = (base, folder, markdown) => {
  const dir = path.join(base, folder);
  fs.ensureDirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');
  return dir;
};

describe('transformSkillMarkdown', () => {
  test('剥离 frontmatter 并提取 name/description', () => {
    const t = transformSkillMarkdown(
      '---\nname: arkcli-billing\ndescription: 查询账单\n---\n\n# 正文\n用 Bash tool 执行 arkcli billing。',
      'fallback-name',
      '/home/u/.agents/skills/arkcli-billing',
    );
    expect(t.name).toBe('arkcli-billing');
    expect(t.description).toBe('查询账单');
    expect(t.instruction).toContain('# 正文');
    expect(t.instruction).not.toContain('---\nname');
  });

  test('工具引用映射为 TagSpaces 工具名', () => {
    const t = transformSkillMarkdown(
      'Use the Bash tool to run arkcli. Then Read tool the file. Or Bash(arkcli billing).\nWebSearch for docs; WebFetch the page.',
      'x',
      '/d',
    );
    expect(t.instruction).toContain('run_command tool');
    expect(t.instruction).toContain('run_command(arkcli billing)');
    expect(t.instruction).toContain('read_file_text tool');
    expect(t.instruction).toContain('web_search');
    expect(t.instruction).toContain('fetch_web');
    expect(t.instruction).not.toMatch(/\bBash tool\b/);
  });

  test('无 frontmatter：name 用回退值，description 取首行', () => {
    const t = transformSkillMarkdown('第一行说明\n第二行', 'my-fallback', '/d');
    expect(t.name).toBe('my-fallback');
    expect(t.description).toContain('第一行说明');
  });

  test('超长内容截断并保留读取指引', () => {
    const t = transformSkillMarkdown('x'.repeat(20000), 'big', '/d/big');
    expect(t.truncated).toBe(true);
    expect(t.instruction.length).toBeLessThanOrEqual(
      SKILL_INSTRUCTION_CAP + 200,
    );
    expect(t.instruction).toContain('SKILL.md');
  });
});

describe('scanSkillsDir / scanAll', () => {
  test('扫描 depth-1 技能文件夹，忽略无 SKILL.md 的目录', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scan-'));
    writeSkill(base, 'skill-a', '---\nname: a\n---\nbody a');
    writeSkill(base, 'skill-b', 'body b');
    fs.ensureDirSync(path.join(base, 'not-a-skill'));
    const found = scanSkillsDir(base);
    expect(found).toHaveLength(2);
    const names = found.map((s) => s.name).sort();
    expect(names).toEqual(['a', 'skill-b']);
  });

  test('不存在的目录返回空', () => {
    expect(scanSkillsDir('/nonexistent/path/xyz')).toEqual([]);
  });

  test('scanAll：默认目录 + 额外目录持久化（addDir/removeDir）', () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scanstore-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scanhome-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scanextra-'));
    writeSkill(home, '.agents', ''); // 无效，不影响
    // 默认目录之一：home/.agents/skills
    writeSkill(path.join(home, '.agents'), 'skills', ''); // 不是技能目录
    const skillsBase = path.join(home, '.agents', 'skills');
    writeSkill(skillsBase, 'shared-skill', '---\nname: shared\n---\nbody');
    writeSkill(extra, 'custom-skill', '---\nname: custom\n---\nbody');

    const first = scanAll(storage, {
      addDirs: [extra],
      // 覆盖默认目录探测范围：homedir 由内部 os.homedir() 提供，
      // 这里只验证 extra 目录的技能能被扫到
    });
    expect(first.skills.some((s) => s.name === 'custom')).toBe(true);
    expect(first.extraDirs).toContain(extra);

    // 持久化：新实例（重新读 storage）仍含 extra 目录
    expect(loadExtraDirs(storage)).toContain(extra);

    // removeDir 生效
    const after = scanAll(storage, { removeDir: extra });
    expect(after.extraDirs).not.toContain(extra);
    expect(after.skills.some((s) => s.name === 'custom')).toBe(false);
    void home;
  });
});

describe('工具 / MCP 配置发现', () => {
  const {
    extractToolServers,
    scanToolConfigs,
  } = require('../../src/main/skillScanner');

  test('extractToolServers：识别 mcpServers 的 stdio/http 条目', () => {
    const servers = extractToolServers(
      {
        mcpServers: {
          'fs-server': { command: 'npx', args: ['-y', '@mcp/fs'] },
          web: { url: 'https://mcp.example.com/sse' },
          api: { url: 'https://api.example.com/mcp' },
        },
      },
      '/home/u/.qwenpaw/mcp.json',
    );
    expect(servers).toHaveLength(3);
    const byName = new Map(servers.map((s) => [s.name, s]));
    expect(byName.get('fs-server').transport).toBe('stdio');
    expect(byName.get('fs-server').detail).toBe('npx -y @mcp/fs');
    expect(byName.get('web').transport).toBe('sse');
    expect(byName.get('api').transport).toBe('http');
    expect(byName.get('api').sourceFile).toBe('/home/u/.qwenpaw/mcp.json');
  });

  test('extractToolServers：一层嵌套（mcp_servers 键）+ 非配置 JSON 返回空', () => {
    const nested = extractToolServers(
      { qwenpaw: { mcp_servers: { tool1: { command: 'tool1' } } } },
      '/f',
    );
    expect(nested).toHaveLength(1);
    expect(nested[0].name).toBe('tool1');
    expect(extractToolServers({ foo: 'bar' }, '/f')).toEqual([]);
  });

  test('scanToolConfigs：目录内 *.json + 去重', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-toolcfg-'));
    fs.writeJsonSync(path.join(dir, 'mcp.json'), {
      mcpServers: { alpha: { command: 'alpha-cmd' } },
    });
    fs.writeJsonSync(path.join(dir, 'other.json'), { notTools: true });
    const found = scanToolConfigs([dir]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('alpha');
    // 同一文件重复扫描不去重出重复项
    const again = scanToolConfigs([dir, dir]);
    expect(again).toHaveLength(1);
  });

  test('scanAll 返回 toolServers', () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scanstore2-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scanhome2-'));
    fs.writeJsonSync(path.join(cfgDir, 'cfg.json'), {
      mcpServers: { beta: { url: 'https://x/mcp' } },
    });
    const res = scanAll(storage, { addDirs: [cfgDir] });
    expect(res.toolServers.some((t) => t.name === 'beta')).toBe(true);
  });
});

describe('prepareSkillImport（整目录复制）', () => {
  const { prepareSkillImport } = require('../../src/main/skillScanner');

  test('SKILL.md 之外的文件跟随复制，指令附 destDir 注记', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impsrc-'));
    fs.writeFileSync(
      path.join(src, 'SKILL.md'),
      '---\nname: deploy\n---\nRun scripts/deploy.sh first.',
    );
    fs.ensureDirSync(path.join(src, 'scripts'));
    fs.writeFileSync(path.join(src, 'scripts', 'deploy.sh'), '#!/bin/sh');
    const importedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impdst-'));
    const res = prepareSkillImport(src, importedRoot);
    expect(res.name).toBe('deploy');
    // 整目录复制：scripts/ 跟着走
    expect(
      fs.existsSync(path.join(res.destDir, 'scripts', 'deploy.sh')),
    ).toBe(true);
    // SKILL.md 本身不复制（已转为指令）
    expect(fs.existsSync(path.join(res.destDir, 'SKILL.md'))).toBe(false);
    // 指令带 destDir 注记
    expect(res.instruction).toContain('Run scripts/deploy.sh first.');
    expect(res.instruction).toContain(`copied to: \`${res.destDir}\``);
  });

  test('重导（同名技能）覆盖旧副本，不产生新目录', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impsrc2-'));
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: same\n---\nv1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impdst2-'));
    const first = prepareSkillImport(src, root);
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: same\n---\nv2');
    const second = prepareSkillImport(src, root);
    expect(second.destDir).toBe(first.destDir);
    expect(second.instruction).toContain('v2');
  });

  test('无 SKILL.md 的目录报错', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impempty-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-impdst3-'));
    expect(() => prepareSkillImport(empty, root)).toThrow('SKILL.md');
  });
});

describe('DeepSeek 复审修复项', () => {
  const {
    deleteImportedCopy,
    extractToolServers,
    prepareSkillImport,
    redactSecrets,
  } = require('../../src/main/skillScanner');

  test('MCP detail 密钥脱敏：内联 token/api-key 不出现明文', () => {
    const servers = extractToolServers(
      {
        mcpServers: {
          a: {
            command: 'npx',
            args: ['-y', 'srv', '--token', 'sk-abc123456789xyz'],
          },
          b: { command: 'srv2', args: ['--api-key=verysecret123'] },
          c: { url: 'https://mcp.example.com/mcp?api_key=hunter2secret' },
        },
      },
      '/f',
    );
    const all = JSON.stringify(servers);
    expect(all).not.toContain('sk-abc123456789xyz');
    expect(all).not.toContain('verysecret123');
    expect(all).not.toContain('hunter2secret');
    expect(all).toContain('<redacted>');
    // 非 secrets 内容保留
    expect(servers[0].detail).toContain('npx -y srv');
  });

  test('redactSecrets：裸 token 形态（sk-/ghp-）也被打码', () => {
    const out = redactSecrets('use sk-live-abcdef1234567890 here');
    expect(out).not.toContain('sk-live-abcdef1234567890');
    expect(out).toContain('<redacted>');
  });

  test('detail 超长截断带标记', () => {
    const servers = extractToolServers(
      { servers: { big: { command: 'cmd', args: ['y'.repeat(500)] } } },
      '/f',
    );
    expect(servers[0].detail.endsWith('…(truncated)')).toBe(true);
  });

  test('同名不同源技能：id/destDir 互不碰撞', () => {
    const { importedSkillId } = require('-/components/chat/agentCapabilities');
    globalThis.window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    };
    const idA = importedSkillId('pdf', '/home/u/.claude/skills/pdf');
    const idB = importedSkillId('pdf', '/home/u/.agents/skills/pdf');
    expect(idA).not.toBe(idB);
    // 同源重导 → 同 id
    expect(importedSkillId('pdf', '/home/u/.claude/skills/pdf')).toBe(idA);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-collide-'));
    const srcA = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-srcA-'));
    const srcB = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-srcB-'));
    fs.writeFileSync(path.join(srcA, 'SKILL.md'), '---\nname: pdf\n---\nA');
    fs.writeFileSync(path.join(srcB, 'SKILL.md'), '---\nname: pdf\n---\nB');
    const ra = prepareSkillImport(srcA, root);
    const rb = prepareSkillImport(srcB, root);
    expect(ra.destDir).not.toBe(rb.destDir);
    // 两个副本都完整存在
    expect(fs.existsSync(ra.destDir)).toBe(true);
    expect(fs.existsSync(rb.destDir)).toBe(true);
  });

  test('deleteImportedCopy 只清理对应副本且不出 importedRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-delcopy-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-delsrc-'));
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: kill\n---\nx');
    const res = prepareSkillImport(src, root);
    expect(fs.existsSync(res.destDir)).toBe(true);
    expect(deleteImportedCopy('kill', src, root)).toBe(true);
    expect(fs.existsSync(res.destDir)).toBe(false);
    // 越界路径拒绝
    expect(deleteImportedCopy('kill', src, root)).toBe(false);
    expect(
      deleteImportedCopy('../../evil', src, root),
    ).toBe(false);
  });
});
