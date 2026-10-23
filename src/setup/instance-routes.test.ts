/**
 * 实例管理路由 — 单测
 *
 * 锁住多机器人的管理入口：列表 / 新增 / 删除 / 启停，
 * 以及「只由默认实例提供一份」的路径约定。
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerInstanceRoutes, type WebRoute } from './bind-routes.ts';

function fakeReq(method: string, headers: Record<string, string | undefined> = {}, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { headers: Record<string, string | undefined> }).headers = headers;
  Object.assign(req, {
    resume: vi.fn(),
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
      let index = 0;
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index++] as Buffer }
          : { done: true as const, value: undefined }),
      };
    },
  });
  return req;
}

function fakeRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) { res.statusCode = status; res.headers = headers; },
    end(payload?: string) { if (payload !== undefined) res.body += payload; },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

function json(res: { body: string }): any {
  return JSON.parse(res.body);
}

async function invoke(route: WebRoute | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (route === undefined) throw new Error('route not registered');
  await route.handler(req, res);
}

const SAME_ORIGIN = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };

describe('实例管理路由', () => {
  it('注册四条固定路径（不按实例分）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      const routes = harness(dir);
      expect(routes.has('/qqbot/im-qqbot/instances')).toBe(true);
      expect(routes.has('/qqbot/im-qqbot/instances/add')).toBe(true);
      expect(routes.has('/qqbot/im-qqbot/instances/remove')).toBe(true);
      expect(routes.has('/qqbot/im-qqbot/instances/toggle')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET 列表返回实例数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), `- id: im-qqbot\n  config:\n    appId: '1905526094'\n`, 'utf8');
      const routes = harness(dir);
      const res = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances'), fakeReq('GET', SAME_ORIGIN), res);
      expect(res.statusCode).toBe(200);
      expect(json(res).instances).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非 GET 访问列表 → 405；跨站 → 403', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      const routes = harness(dir);
      const res405 = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances'), fakeReq('POST', SAME_ORIGIN), res405);
      expect(res405.statusCode).toBe(405);

      const res403 = fakeRes();
      await invoke(
        routes.get('/qqbot/im-qqbot/instances'),
        fakeReq('GET', { host: '127.0.0.1:3080', origin: 'http://evil.example' }),
        res403,
      );
      expect(res403.statusCode).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST add 新增实例并返回 id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), `- id: im-qqbot\n  config:\n    appId: '1'\n`, 'utf8');
      const routes = harness(dir);
      const res = fakeRes();
      await invoke(
        routes.get('/qqbot/im-qqbot/instances/add'),
        fakeReq('POST', SAME_ORIGIN, JSON.stringify({ botName: '工作号' })),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(json(res).id).toBe('im-qqbot-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST remove 默认实例被拒，非默认可删', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), `- id: im-qqbot\n  config:\n    appId: '1'\n- id: im-qqbot-2\n  config:\n    enabled: true\n`, 'utf8');
      const routes = harness(dir);

      const resDefault = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances/remove'), fakeReq('POST', SAME_ORIGIN, '{"settingsNs":"im-qqbot"}'), resDefault);
      expect(resDefault.statusCode).toBe(409);

      const resOk = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances/remove'), fakeReq('POST', SAME_ORIGIN, '{"settingsNs":"im-qqbot-2"}'), resOk);
      expect(resOk.statusCode).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST toggle 启停实例；缺参数 → 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'instroutes-'));
    try {
      writeFileSync(join(dir, 'cordis.patch.yml'), `- id: im-qqbot-2\n  config:\n    enabled: true\n`, 'utf8');
      const routes = harness(dir);

      const resBad = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances/toggle'), fakeReq('POST', SAME_ORIGIN, '{}'), resBad);
      expect(resBad.statusCode).toBe(400);

      const resOk = fakeRes();
      await invoke(routes.get('/qqbot/im-qqbot/instances/toggle'), fakeReq('POST', SAME_ORIGIN, '{"settingsNs":"im-qqbot-2","enabled":false}'), resOk);
      expect(resOk.statusCode).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无 profile 目录时返回 500（不抛）', async () => {
    const routes = harness(undefined);
    const res = fakeRes();
    await invoke(routes.get('/qqbot/im-qqbot/instances'), fakeReq('GET', SAME_ORIGIN), res);
    expect(res.statusCode).toBe(500);
  });
});

function harness(profileDir: string | undefined): Map<string, WebRoute> {
  const routes = new Map<string, WebRoute>();
  const webServer = {
    register: (route: WebRoute): (() => void) => {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  registerInstanceRoutes(webServer, logger, { profileDir });
  return routes;
}
