import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_TYPES, listApiModels, suggestAiRepair, testAiConnection } from './ai.js';
import { inspectSourceWeb } from './site-evidence.js';
import { runAutoRepair } from './auto-repair.js';
import { inspectDomainBatch } from './domain-migration.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(root, '../docs');
const {version}=JSON.parse(fs.readFileSync(path.resolve(root,'../package.json'),'utf8'));
const requests = new Map();
let activeAi = 0;

function publicErrorMessage(error) {
  const msg = String(error?.message || '');
  if (/^请|^接口|^不支持|^禁止|^仅支持|^共享服务器|^AI |^Gemini |^Key |^模型|^最多输出|^没有|^找不到|^整合包|^需要|^此书源|^高级参数|^temperature |^parserID |^整体验证|^安全策略|^模型列表|^书源|^该书源|^原始|^拒绝|^搜索|^端口|^网站|^内容/.test(msg)) return msg.slice(0, 300);
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 401 || status === 403) return 'AI 服务拒绝鉴权，请检查 API Key 和接口地址';
  if (status === 404) return 'AI 接口返回 404，请确认 API 地址、协议类型和模型名称';
  if (status === 429) return 'AI 服务限流或额度不足，请稍后重试';
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'AI 请求超时，请重试';
  return 'AI 接口调用失败，请检查 API 地址、模型、网络和密钥权限';
}

export function createApp({ listModels = listApiModels, testConnection = testAiConnection, suggestRepair = suggestAiRepair, checkWebsite = inspectSourceWeb, autoRepair = runAutoRepair, inspectDomains = inspectDomainBatch } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.get('/api/health', (_, res) => res.json({ ok: true, service: 'booksource-workbench', api: true, version }));
  app.get('/api/ai/types', (_, res) => res.json({ types: API_TYPES, localOnly: true, persistedOnServer: false }));
  app.use('/api', express.json({ limit: '150kb', strict: true }));
  const withLimit = (handler) => async (req, res) => {
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    if (requests.size > 3000) for (const [k, v] of requests) if (now - v.started > 600_000) requests.delete(k);
    const bucket = requests.get(key) || { started: now, count: 0 };
    if (now - bucket.started > 600_000) { bucket.started = now; bucket.count = 0; }
    if (bucket.count >= 20 || activeAi >= 4) return res.status(429).json({ ok: false, error: '请求过于频繁，请稍后重试' });
    bucket.count++;
    requests.set(key, bucket);
    activeAi++;
    try { res.json({ ok: true, ...(await handler(req.body || {})) }); }
    catch (error) { res.status(400).json({ ok: false, error: publicErrorMessage(error) }); }
    finally { activeAi--; }
  };
  app.post('/api/ai/models', withLimit(async ({ config }) => ({ models: await listModels(config) })));
  app.post('/api/ai/test', withLimit(async ({ config }) => await testConnection(config)));
  app.post('/api/source/check', withLimit(async ({source,sourceName,legado,keyword}) => ({ evidence: await checkWebsite({source,sourceName,legado,keyword}) })));
  app.post('/api/source/domains', withLimit(async ({sources}) => await inspectDomains({sources})));
  app.post('/api/source/auto-repair', withLimit(async ({source,sourceName,legado,keyword}) => await autoRepair({source,sourceName,legado,keyword})));
  app.post('/api/ai/repair', withLimit(async ({ config, source, sourceName, problem, legado, keyword }) => await suggestRepair(config, { source, sourceName, problem, legado, keyword })));
  app.use('/api', (_, res) => res.status(404).json({ ok: false, error: 'API 不存在' }));
  app.use(express.static(docs, { index: 'index.html', etag: false, lastModified: false, dotfiles: 'deny', setHeaders(res, file) { if (file.endsWith('.zip') || file.endsWith('.xbs')) res.setHeader('Content-Disposition', 'attachment'); } }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err?.status === 413 ? 413 : 400).json({ ok: false, error: err?.status === 413 ? '请求内容过大' : '请求 JSON 无效' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 4397);
  createApp().listen(port, host, () => console.log(`Booksource Workbench HTTP ready at ${host}:${port}`));
}
