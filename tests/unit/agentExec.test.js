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
  EXEC_OUTPUT_CAP,
  EXEC_TIMEOUT_MAX_MS,
  appendExecAudit,
  runCommand,
} from '../../src/main/execRunner';
import {
  ExecAuthorizer,
  commandPrefix,
  hasShellMetachars,
} from '../../src/main/execAuth';
import { createAgentTools } from '-/components/chat/AgentTools';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

let store = {};
beforeAll(() => {
  globalThis.window = {
    electronIO: {
      ipcRenderer: {
        invoke: () => Promise.reject(new Error('ipc not mocked')),
      },
    },
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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ts-execa-'));

describe('runCommand（真实 spawn）', () => {
  test('echo + 退出码', async () => {
    const res = await runCommand({ command: 'echo hello-agent' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello-agent');
  });

  test('非零退出码 + stderr 捕获', async () => {
    const res = await runCommand({
      command: 'node -e "console.error(\'boom\'); process.exit(3)"',
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('boom');
  });

  test('cwd 生效（realpath 对齐 macOS /tmp 符号链接）', async () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ts-exec-')),
    );
    const res = await runCommand({ command: 'pwd', cwd: tmp });
    expect(res.cwd).toBe(tmp);
    expect(res.stdout.trim()).toBe(tmp);
  });

  test('shell 特性可用（管道）', async () => {
    const res = await runCommand({ command: 'echo a b c | wc -w' });
    expect(res.stdout.trim()).toBe('3');
  });

  test('超时杀进程树', async () => {
    const res = await runCommand({ command: 'sleep 30', timeoutMs: 1500 });
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(10000);
  }, 20000);

  test('输出截断保护（cap 200KB）', async () => {
    const res = await runCommand({
      command: 'node -e "console.log(\'x\'.repeat(500000))"',
    });
    expect(res.stdout.length).toBeLessThanOrEqual(EXEC_OUTPUT_CAP + 1);
    expect(res.truncated).toBe(true);
  }, 20000);

  test('env 注入可用', async () => {
    const res = await runCommand({
      command: 'echo $TS_EXEC_TEST',
      env: { TS_EXEC_TEST: 'injected' },
    });
    expect(res.stdout.trim()).toBe('injected');
  });

  test('env PATH/HOME 守卫：覆盖可执行查找路径被拒绝', async () => {
    await expect(
      runCommand({ command: 'echo x', env: { PATH: '/tmp/evil' } }),
    ).rejects.toThrow('not allowed');
    await expect(
      runCommand({ command: 'echo x', env: { Home: '/tmp/evil' } }),
    ).rejects.toThrow('not allowed');
  });

  test('空命令拒绝', async () => {
    await expect(runCommand({ command: '   ' })).rejects.toThrow(
      'command is empty',
    );
  });

  test('审计日志追加', async () => {
    const dir = tmpDir();
    appendExecAudit(dir, { command: 'echo x', origin: 'chat', exitCode: 0 });
    const lines = fs
      .readFileSync(path.join(dir, 'history.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(lines[0]).origin).toBe('chat');
  });
});

describe('ExecAuthorizer（两档授权 + 令牌闸门）', () => {
  test('元字符判定', () => {
    expect(hasShellMetachars('arkcli models list')).toBe(false);
    expect(hasShellMetachars('arkcli && rm -rf x')).toBe(true);
    expect(hasShellMetachars('cat a | grep b')).toBe(true);
    expect(hasShellMetachars('echo $(date)')).toBe(true);
  });

  test('commandPrefix', () => {
    expect(commandPrefix('arkcli models list')).toBe('arkcli');
    expect(commandPrefix('"C:\\Program Files\\x.exe" --help')).toBe(
      'C:\\Program Files\\x.exe',
    );
  });

  test('① 记住前缀后，复合命令仍被拦截（不被前缀授权覆盖）', () => {
    const auth = new ExecAuthorizer(tmpDir());
    // 记住前缀 arkcli（简单行）
    auth.grant('arkcli', true);
    expect(auth.authorize('arkcli models list').status).toBe('granted');
    // 复合行：前缀已记住也必须走确认
    const res = auth.authorize('arkcli && rm -rf x');
    expect(res.status).toBe('needs-confirmation');
    expect(res.rememberKey).toBe('arkcli && rm -rf x'); // 整行记忆，非前缀
  });

  test('② 复合行确认一次后同条静默，③ 换内容再弹', () => {
    const auth = new ExecAuthorizer(tmpDir());
    const line = 'arkcli list | grep x';
    expect(auth.authorize(line).status).toBe('needs-confirmation');
    auth.grant(line, true);
    expect(auth.authorize(line).status).toBe('granted');
    // 同前缀但内容不同 → 再次确认
    expect(auth.authorize('arkcli list | grep y').status).toBe(
      'needs-confirmation',
    );
  });

  test('提权前缀永远弹窗且不可记忆', () => {
    const auth = new ExecAuthorizer(tmpDir());
    const res = auth.authorize('sudo rm x');
    expect(res.status).toBe('needs-confirmation');
    expect(res.canRemember).toBe(false);
    // 即使试图记住也不生效
    auth.grant('sudo', true);
    expect(auth.authorize('sudo rm x').status).toBe('needs-confirmation');
  });

  test('令牌单次有效：execRun 闸门在主进程', () => {
    const auth = new ExecAuthorizer(tmpDir());
    auth.grant('arkcli', true);
    const granted = auth.authorize('arkcli models list');
    expect(granted.token).toBeTruthy();
    expect(auth.consumeToken(granted.token)).toBe(true);
    expect(auth.consumeToken(granted.token)).toBe(false); // 单次
    expect(auth.consumeToken('fake-token')).toBe(false);
  });

  test('授权持久化：重开实例记住前缀/整行', () => {
    const dir = tmpDir();
    const a = new ExecAuthorizer(dir);
    a.grant('arkcli', true);
    a.grant('arkcli list | grep x', true);
    const b = new ExecAuthorizer(dir);
    expect(b.authorize('arkcli models list').status).toBe('granted');
    expect(b.authorize('arkcli list | grep x').status).toBe('granted');
    expect(b.authorize('arkcli list | grep y').status).toBe(
      'needs-confirmation',
    );
  });
});

describe('run_command 工具链（mock deps，双档流）', () => {
  function makeDeps(authorizer, approved) {
    const confirmCalls = [];
    return {
      execAuthorize: async (command) =>
        authorizer.authorize(command),
      execGrant: async (p) => ({
        token: authorizer.grant(p.rememberKey, p.remember),
      }),
      execRun: async (params) => {
        const res = await runCommand(params);
        return res;
      },
      requestExecConfirmation: async (payload) => {
        confirmCalls.push(payload);
        return { approved, remember: approved };
      },
      confirmCalls,
    };
  }

  const realCwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ts-execcwd-')),
  );

  const baseDeps = ({
    agentSearch: async () => [],
    getIndex: () => undefined,
    findEntry: async () => undefined,
    listChildren: async () => [],
    listLocations: () => [{ name: 'Root', path: '/root' }],
    kbList: async () => [],
    kbRead: async () => '',
    kbWrite: async () => ({ id: 'x', path: '' }),
    currentLocationName: 'Root',
    currentLocationPath: realCwd,
    currentDirectoryPath: realCwd,
    selectedEntries: [],
    addTagsToFsEntry: async (e) => e,
    removeTagsFromEntry: async () => '',
    loadTextFile: async () => '',
    readFileBytes: async () => new ArrayBuffer(0),
    moveFile: async () => true,
    moveToPath: async () => true,
    copyFile: async () => true,
    deleteEntries: async () => [],
    requestDeleteConfirmation: async () => true,
    getDescription: async () => '',
    setDescription: async () => true,
    writeTextFile: async () => undefined,
    createLocation: async () => ({}),
  });

  const tool = (deps) =>
    createAgentTools(deps).find((t) => t.name === 'run_command');

  test('新前缀弹确认 → 拒绝则不执行', async () => {
    const authorizer = new ExecAuthorizer(tmpDir());
    const deps = { ...baseDeps, ...makeDeps(authorizer, false) };
    const res = await tool(deps).execute({ command: 'echo denied-test' });
    expect(res.error).toContain('denied');
    expect(deps.confirmCalls).toHaveLength(1);
  });

  test('记住前缀后简单行静默，复合行走整行确认', async () => {
    const authorizer = new ExecAuthorizer(tmpDir());
    authorizer.grant('echo', true);
    const deps = { ...baseDeps, ...makeDeps(authorizer, true) };
    // 简单行：已记住前缀 → 静默
    const ok = await tool(deps).execute({ command: 'echo silent-run' });
    expect(ok.exitCode).toBe(0);
    expect(deps.confirmCalls).toHaveLength(0);
    // 复合行：即使前缀已记住也要确认（确认后按整行记忆）
    const line = 'echo one && echo two';
    const res = await tool(deps).execute({ command: line });
    expect(res.exitCode).toBe(0);
    expect(deps.confirmCalls).toHaveLength(1);
    expect(deps.confirmCalls[0].canRemember).toBe(true);
    // 同条复合行 → 静默
    await tool(deps).execute({ command: line });
    expect(deps.confirmCalls).toHaveLength(1);
    // 换内容 → 再弹
    await tool(deps).execute({ command: 'echo one && echo three' });
    expect(deps.confirmCalls).toHaveLength(2);
  }, 30000);
});
