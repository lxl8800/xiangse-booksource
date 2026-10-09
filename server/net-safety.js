import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

// A public installation must never become an HTTP client for its LAN, loopback
// or cloud metadata endpoints. DNS is checked before and during connections.
function publicIp(address) {
  try {
    const addr = ipaddr.parse(address);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      return addr.toIPv4Address().range() === 'unicast';
    }
    return addr.range() === 'unicast';
  } catch { return false; }
}

function normalizeHost(host) { return String(host).replace(/^\[/, '').replace(/\]$/, '').toLowerCase(); }

function validateParsed(url, allowHttp, { allowQuery = false } = {}) {
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP(S) 接口地址');
  if (url.protocol === 'http:' && !allowHttp) throw new Error('共享服务器只支持 HTTPS AI 接口；HTTP 接口请自行部署并显式开启允许选项');
  if (url.username || url.password || url.hash || (!allowQuery && url.search)) throw new Error('接口地址不能包含用户名、密码、查询参数或 #片段');
  const host = normalizeHost(url.hostname);
  if (!host || host.length > 253 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.onion')) {
    throw new Error('接口地址不能指向本机或内网域名');
  }
  if (net.isIP(host) && !publicIp(host)) throw new Error('接口地址不能指向内网或保留 IP');
}

export function parseAiBaseUrl(input, { allowHttp = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 350 || !/^https?:\/\//i.test(raw)) throw new Error('请填写合法的完整 API 地址（如 https://example.com/v1）');
  let url;
  try { url = new URL(raw); } catch { throw new Error('接口地址格式不正确'); }
  validateParsed(url, allowHttp);
  const base = url.href.replace(/\/+$/, '');
  return { url, base };
}

export async function checkPublicDns(parsed) {
  const host = normalizeHost(parsed.hostname);
  if (net.isIP(host)) {
    if (!publicIp(host)) throw new Error('禁止访问非公网 IP 地址');
    return;
  }
  let resolved;
  try { resolved = await dns.promises.lookup(host, { all: true }); }
  catch { throw new Error('AI 接口域名 DNS 解析失败'); }
  if (!resolved.length || resolved.some(x => !publicIp(x.address))) throw new Error('接口域名解析包含内网或保留地址，已拒绝访问');
}

const agent = new Agent({
  connect: {
    lookup(host, opts, callback) {
      dns.lookup(normalizeHost(host), { all: true }, (err, answers) => {
        if (err || !answers?.length || answers.some(x => !publicIp(x.address))) return callback(new Error('Blocked unsafe DNS target'));
        if (opts?.all) return callback(null, answers);
        const chosen = answers.find(x => !opts?.family || x.family === opts.family) || answers[0];
        callback(null, chosen.address, chosen.family);
      });
    }
  },
  headersTimeout: 30_000,
  bodyTimeout: 30_000
});

export function makeSafeFetch(origin, { allowHttp = false, allowRedirectResponse = false } = {}) {
  return async (input, init = {}) => {
    const requested = new URL(typeof input === 'string' ? input : input.url);
    if (requested.origin !== origin) throw new Error('安全策略：不允许接口请求跨域跳转');
    validateParsed(requested, allowHttp || process.env.ALLOW_HTTP_AI_ENDPOINTS === '1', { allowQuery: true });
    // Runtime-level DNS/IP checks remain enforced even if DNS changes after
    // the earlier endpoint check. No redirects into cloud metadata or LAN.
    const response = await undiciFetch(input, { ...init, dispatcher: agent, redirect: 'manual' });
    if (!allowRedirectResponse && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('安全策略：不允许 AI 接口重定向');
    }
    return response;
  };
}

export function assertNativeGeminiDomain(parsed) {
  if (normalizeHost(parsed.hostname) !== 'generativelanguage.googleapis.com' || parsed.protocol !== 'https:') {
    throw new Error('Gemini 原生协议只允许 Google 官方 API 域名；其他兼容接口请选择 OpenAI 兼容协议');
  }
}
