import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ImageApiSettings, publicSettings } from './image-api.mjs';
import { normalizeComfyUrl, inspectExistingComfy, normalizeModelDirectoryConfigs } from './local-engine.mjs';
import { isAllowedLocalOrigin } from './local-request.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class StudioError extends Error { constructor(status, message) { super(message); this.status = status; } }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

export function transformStudioIndex(source, mode, apiDialog = '') {
  if (mode === 'api') {
    source = source.replace('assets/local-engine.js', 'assets/api-settings.js').replace('assets/local-engine.css', 'assets/api-settings.css');
    source = source.replace(/(<button\b[^>]*\bid=)"openLocalEngine"([^>]*>)[\s\S]*?<\/button>/, '$1"openApiSettings"$2生图 API 设置</button>');
    source = source.replace(/<span\b[^>]*\bclass="gen-model"[^>]*>[\s\S]*?<\/span>/, '<span class="gen-model" id="generationModelLabel">外接生图 API</span>');
    source = source.replace(/<dialog\b[^>]*\bid="localEngineDialog"[^>]*>[\s\S]*?<\/dialog>/, '');
    source = source.replace('</body>', `${apiDialog.trim()}\n</body>`);
  }
  source = source.replace(/<html\b[^>]*>/, `<html lang="zh-CN" data-edition="${mode === 'api' ? 'api' : 'local'}" data-studio-mode="${mode}">`);
  source = source.replace('</head>', '<link rel="stylesheet" href="assets/studio-mode.css">\n<script defer src="assets/studio-mode.js"></script>\n</head>');
  source = source.replace('<div class="gen-heading-actions">', '<div class="gen-heading-actions"><a class="gen-text-link" id="openStudioSetup" href="/setup">安装与模式</a>');
  return source;
}

export async function createStudioServer({ root = process.env.GALLERY_ROOT || path.join(scriptDirectory, '..'), port = Number(process.env.GALLERY_PORT || 8765), runtimeManager } = {}) {
  root = path.resolve(root);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GALLERY_PORT 不正确');
  if (!runtimeManager) { const { RuntimeManager } = await import('./runtime-manager.mjs'); runtimeManager = await RuntimeManager.create(root); }
  const localRoot = path.join(root, '.local');
  await mkdir(localRoot, { recursive: true });
  const settingsPath = path.join(localRoot, 'studio-settings.json');
  let settings = { mode: null, autoStart: true };
  try {
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (['api', 'builtin', 'external'].includes(saved.mode)) settings = { mode: saved.mode, autoStart: saved.autoStart !== false };
  } catch (error) { if (error.code !== 'ENOENT') console.warn('安装模式记录无法读取，请重新选择模式。'); }
  const baseUrl = `http://127.0.0.1:${port}`;
  const origins = new Set([baseUrl, `http://localhost:${port}`, 'null']);
  let backend = null, starting = null, switching = false, stopped = false, proxyRequests = 0, uploading = false;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function readJson(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new StudioError(415, '请使用 JSON 格式提交');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new StudioError(413, '设置内容过大'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new StudioError(400, '设置格式不正确'); }
  }
  async function localSettings() {
    let saved = {};
    try { saved = JSON.parse(await readFile(path.join(localRoot, 'local-settings.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new StudioError(500, '本地引擎设置无法读取'); }
    return { mode: saved.mode || 'external', externalUrl: saved.externalUrl || 'http://127.0.0.1:8188', modelDirectories: saved.modelDirectories || [], comfyDirectory: saved.comfyDirectory || '', pythonExecutable: saved.pythonExecutable || '' };
  }
  async function setupSnapshot() {
    const configuration = await ImageApiSettings.create(root);
    const modelCatalog = JSON.parse(await readFile(path.join(scriptDirectory, '../config/model-catalog.json'), 'utf8'));
    return { ...settings, configured: !!settings.mode, switching, uploading, api: configuration.public(), local: await localSettings(), runtime: await runtimeManager.snapshot(), modelPreparation: { modelRoot: path.join(root, 'models'), quarkUrl: modelCatalog.quarkUrl || '', quarkCode: modelCatalog.quarkCode || '' } };
  }
  async function backendCall(route, body, { target = backend, timeout = 20000 } = {}) {
    if (!target || target.child.exitCode !== null) throw new StudioError(503, '生成服务尚未启动，请重新进入所选模式');
    let response;
    try { response = await fetch(target.url + route, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) }); }
    catch { throw new StudioError(503, '本机生成服务未响应，请稍后重试'); }
    let data;
    try { data = await response.json(); } catch { throw new StudioError(502, '本机生成服务返回无效数据'); }
    if (!response.ok) throw new StudioError(response.status, data.error || '生成服务拒绝了操作');
    return data;
  }
  async function freePort() {
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const found = probe.address().port; await new Promise(resolve => probe.close(resolve)); return found;
  }
  async function startBackend(kind) {
    const childPort = await freePort();
    const entry = kind === 'api' ? 'api-server.mjs' : 'gallery-server.mjs';
    const flags = kind === 'api' && Number(process.versions.node.split('.')[0]) >= 25 ? ['--use-env-proxy', '--use-system-ca'] : [];
    const child = spawn(process.execPath, [...flags, path.join(scriptDirectory, entry)], { cwd: root, windowsHide: true, env: { ...process.env, GALLERY_ROOT: root, GALLERY_PORT: String(childPort), GALLERY_NO_AUTO_START: '1', NO_PROXY: [process.env.NO_PROXY || process.env.no_proxy || '', '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const target = { kind, child, url: `http://127.0.0.1:${childPort}` };
    const log = createWriteStream(path.join(localRoot, `studio-${kind}-service.log`), { flags: 'a' });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once('exit', () => { log.end(); if (backend === target) backend = null; });
    let failed = false; child.once('error', () => { failed = true; });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failed || child.exitCode !== null) break;
      try {
        const health = await backendCall('/api/health', undefined, { target, timeout: 1000 });
        if (health.pid === child.pid && health.projectRoot === root) return target;
      } catch {}
      await pause(100);
    }
    if (child.exitCode === null) child.kill();
    throw new StudioError(503, '所选生成服务无法启动，请检查 .local 中的服务日志');
  }
  async function ensureBackend() {
    if (!settings.mode) throw new StudioError(409, '请先选择安装方式');
    const expected = settings.mode === 'api' ? 'api' : 'local';
    if (backend && backend.kind === expected && backend.child.exitCode === null) return backend;
    if (starting) return starting;
    starting = (async () => {
      if (backend) { await backendCall('/api/idle'); await stopBackend(); }
      backend = await startBackend(expected);
      if (settings.mode !== 'api' && settings.autoStart && (settings.mode === 'external' || (await runtimeManager.snapshot()).available)) {
        try { await backendCall('/api/local-engine/start', {}, { timeout: 30000 }); } catch (error) { console.warn(error.message); }
      }
      return backend;
    })().finally(() => { starting = null; });
    return starting;
  }
  async function checkIdle() {
    if (proxyRequests || starting || uploading) throw new StudioError(409, '存在进行中的请求，请稍后再修改安装方式');
    if (backend) await backendCall('/api/idle');
  }
  function checkRuntimeIdle() { try { runtimeManager.checkIdle(); } catch (error) { throw new StudioError(409, error.message); } }
  async function stopBackend() {
    const target = backend;
    if (!target) return;
    await backendCall('/api/shutdown', {}, { target });
    for (let attempt = 0; attempt < 150 && target.child.exitCode === null; attempt++) await pause(100);
    if (target.child.exitCode === null) throw new StudioError(503, '生成服务仍在退出，请稍后再试');
    if (backend === target) backend = null;
  }
  async function validateLocal(body, mode) {
    const previous = await localSettings();
    const local = { ...previous, ...body, mode };
    if (body.comfyDirectory !== undefined && body.comfyDirectory !== previous.comfyDirectory && body.pythonExecutable === undefined) local.pythonExecutable = '';
    local.externalUrl = normalizeComfyUrl(local.externalUrl);
    if (!Array.isArray(local.modelDirectories) || local.modelDirectories.length > 8) throw new StudioError(400, '模型目录设置不正确');
    const directories = normalizeModelDirectoryConfigs(local.modelDirectories);
    if (directories.length !== local.modelDirectories.length) throw new StudioError(400, '模型目录设置不正确');
    const inherited = new Set(normalizeModelDirectoryConfigs(previous.modelDirectories).map(item => item.path.toLowerCase()));
    local.modelDirectories = [];
    for (const directory of directories) {
      if (!path.isAbsolute(directory.path)) throw new StudioError(400, `模型目录必须是绝对路径：${directory.path}`);
      if (!(await stat(directory.path).catch(() => null))?.isDirectory()) {
        // 安装页没有附加目录输入框；迁移已保存的失效路径，不能将用户锁在这里。
        // 新提交的无效目录仍然报错，防止悄悄忽略输入错误。
        if (inherited.has(directory.path.toLowerCase())) continue;
        throw new StudioError(400, `模型目录不存在：${directory.path}`);
      }
      local.modelDirectories.push(directory);
    }
    for (const key of ['comfyDirectory', 'pythonExecutable']) if (typeof local[key] !== 'string' || local[key] && !path.isAbsolute(local[key])) throw new StudioError(400, '已有环境路径必须是绝对路径');
    if (local.comfyDirectory) Object.assign(local, await inspectExistingComfy(local.comfyDirectory, local.pythonExecutable));
    return local;
  }
  async function configure(body) {
    if (!body || !['api', 'builtin', 'external'].includes(body.mode)) throw new StudioError(400, '请选择 API、内置 WebUI 或已有 ComfyUI');
    if (body.start !== undefined && typeof body.start !== 'boolean') throw new StudioError(400, '启动方式参数不正确');
    await checkIdle(); checkRuntimeIdle();
    let configuration;
    if (body.mode === 'api') {
      const api = await ImageApiSettings.create(root); configuration = api.validate(body.api || {});
      if (!publicSettings(configuration).ready) throw new StudioError(400, '请补全接口地址、API Key 和模型名称');
    } else {
      configuration = await validateLocal(body.local || {}, body.mode === 'builtin' ? 'builtin' : 'external');
      if (body.mode === 'builtin' && !(await runtimeManager.snapshot()).available) throw new StudioError(400, '请先下载或导入内置运行环境，再进入创作台');
    }
    const previous = { settings: { ...settings }, active: !!backend, owned: backend?.kind === 'local' ? !!(await backendCall('/api/local-engine')).engine.owned : false };
    const files = await Promise.all(['local-settings.json', 'api-settings.json', 'studio-settings.json'].map(async name => ({ filename: path.join(localRoot, name), contents: await readFile(path.join(localRoot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) })));
    try {
      const kind = body.mode === 'api' ? 'api' : 'local';
      if (backend?.kind !== kind) await stopBackend();
      if (!backend) backend = await startBackend(kind);
      if (kind === 'api') await backendCall('/api/image-api/configure', configuration);
      else {
        const current = await backendCall('/api/local-engine');
        if (current.engine.owned) await backendCall('/api/local-engine/stop', {});
        await backendCall('/api/local-engine/configure', configuration);
        if (body.mode === 'builtin' || body.start === true) await backendCall('/api/local-engine/start', {}, { timeout: 30000 });
      }
      const next = { mode: body.mode, autoStart: body.mode === 'builtin' || body.start === true };
      await writeFile(settingsPath + '.tmp', JSON.stringify(next, null, 2)); await rename(settingsPath + '.tmp', settingsPath);
      settings = next;
      return { ...await setupSnapshot(), nextUrl: '/' };
    } catch (error) {
      try {
        await stopBackend();
        for (const file of files) {
          if (file.contents === null) await unlink(file.filename).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
          else { await writeFile(file.filename + '.tmp', file.contents); await rename(file.filename + '.tmp', file.filename); }
        }
        settings = previous.settings;
        if (previous.active && previous.settings.mode) {
          backend = await startBackend(previous.settings.mode === 'api' ? 'api' : 'local');
          if (previous.owned) await backendCall('/api/local-engine/start', {}, { timeout: 30000 });
        }
      } catch { console.warn('安装方式恢复未完成，请重新打开安装与模式页面。'); }
      throw error;
    }
  }
  async function prepareRuntime() {
    await checkIdle(); checkRuntimeIdle();
    if (backend?.kind === 'local') {
      const current = await backendCall('/api/local-engine');
      if (current.engine.owned) await backendCall('/api/local-engine/stop', {});
    }
  }
  async function proxy(req, res, url) {
    const target = await ensureBackend();
    proxyRequests++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; proxyRequests--; } };
    const upstream = http.request(target.url + url.pathname + url.search, { method: req.method, headers: { ...req.headers, host: new URL(target.url).host, origin: target.url } }, incoming => {
      const headers = { ...incoming.headers }; delete headers['access-control-allow-origin']; delete headers['access-control-allow-methods']; delete headers['access-control-allow-headers'];
      if (req.headers.origin) headers['access-control-allow-origin'] = req.headers.origin;
      res.writeHead(incoming.statusCode, headers); incoming.pipe(res);
      incoming.once('error', () => { finish(); res.destroy(); });
    });
    upstream.once('error', () => { finish(); if (!res.headersSent) json(res, 503, { error: '本机生成服务连接中断，请稍后重试' }); else res.destroy(); });
    res.once('finish', finish); res.once('close', finish);
    req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    let ownsSwitch = false;
    try {
      if (![new URL(baseUrl).host, `localhost:${port}`].includes(req.headers.host)) throw new StudioError(403, '仅允许从本机访问');
      if (!isAllowedLocalOrigin(req, origins)) throw new StudioError(403, '请从本机创作台使用此功能');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }
      const url = new URL(req.url, baseUrl);
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { projectRoot: root, pid: process.pid, edition: 'studio', mode: settings.mode }); return; }
      if (url.pathname === '/api/setup' && req.method === 'GET') { json(res, 200, await setupSnapshot()); return; }
      if (url.pathname === '/api/runtime' && req.method === 'GET') { json(res, 200, { ...await runtimeManager.snapshot(), uploading }); return; }
      if (url.pathname === '/api/setup/detect' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.directory !== undefined && typeof body.directory !== 'string') throw new StudioError(400, '已有环境目录格式不正确');
        const { detectExistingComfy } = await import('./local-engine.mjs'); json(res, 200, await detectExistingComfy(root, body.directory || '')); return;
      }
      if (switching) throw new StudioError(409, '安装方式正在切换，请稍后重试');
      if (req.method === 'GET' && url.pathname === '/api/idle') {
        await checkIdle(); checkRuntimeIdle(); json(res, 200, { idle: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        switching = true; ownsSwitch = true;
        json(res, 200, await configure(await readJson(req))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        await readJson(req); switching = true; ownsSwitch = true;
        await checkIdle(); checkRuntimeIdle(); await stopBackend();
        json(res, 200, { stopping: true }); setTimeout(shutdown, 100); return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/runtime/')) {
        const action = url.pathname.slice('/api/runtime/'.length);
        if (action === 'cancel') { await readJson(req); json(res, 200, await runtimeManager.cancel()); return; }
        switching = true; ownsSwitch = true; await prepareRuntime();
        if (action === 'download') { await readJson(req); json(res, 202, await runtimeManager.download()); return; }
        if (action === 'import-path') { const body = await readJson(req); json(res, 202, await runtimeManager.importPath(body.source ?? body.path)); return; }
        if (action === 'import-file') {
          const runtime = await runtimeManager.snapshot();
          const maxBytes = runtime.bytes || 16 * 1024 ** 3;
          const length = Number(req.headers['content-length']);
          if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) throw new StudioError(400, '环境包文件大小不正确，请选择完整的离线运行环境 ZIP');
          const upload = path.join(localRoot, `runtime-upload-${randomUUID()}.zip`);
          uploading = true; let received = 0;
          try {
            await pipeline(req, new Transform({ transform(chunk, _, callback) { received += chunk.length; callback(received > maxBytes ? new StudioError(413, '环境包文件过大') : null, chunk); } }), createWriteStream(upload, { flags: 'wx' }));
            if (received !== length) throw new StudioError(400, '环境包上传不完整，请重试');
            const result = await runtimeManager.importFile(upload); json(res, 202, result);
          } catch (error) { await unlink(upload).catch(() => {}); throw error; }
          finally { uploading = false; }
          return;
        }
        throw new StudioError(404, '安装接口不存在');
      }
      if (url.pathname.startsWith('/api/')) {
        if (!settings.mode && url.pathname === '/api/status') { json(res, 200, { connected: false, ready: false, message: '请先选择安装方式', setupRequired: true }); return; }
        if (runtimeManager.active) throw new StudioError(409, '运行环境正在准备，请完成安装后进入创作台');
        await proxy(req, res, url); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new StudioError(405, '不支持此请求方式');
      let relative;
      try { relative = decodeURIComponent(url.pathname); } catch { throw new StudioError(400, '文件路径格式不正确'); }
      if (relative.split(/[\\/]/).includes('..')) throw new StudioError(403, '文件路径不允许访问');
      const needsSetup = !settings.mode || settings.mode === 'builtin' && !(await runtimeManager.snapshot()).available;
      if (relative === '/setup' || relative === '/setup/' || ['/', '/index.html'].includes(relative) && needsSetup) relative = '/assets/setup.html';
      if (['/', '/index.html'].includes(relative)) {
        const source = await readFile(path.join(root, 'index.html'), 'utf8');
        const apiDialog = settings.mode === 'api' ? await readFile(path.join(root, 'assets/api-settings-dialog.html'), 'utf8') : '';
        const html = transformStudioIndex(source, settings.mode, apiDialog);
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? '' : html); return;
      }
      if (!/^\/(?:og-cover\.jpg|robots\.txt|sitemap\.xml|(?:assets|data|thumbs|img)\/[a-z\d_./-]+|costume\/(?:thumbs|img|png)\/[a-z\d_.-]+)$/i.test(relative)) throw new StudioError(404, '文件不存在');
      const filename = path.resolve(root, '.' + relative);
      if (!filename.startsWith(root + path.sep)) throw new StudioError(403, '文件路径不允许访问');
      const file = await stat(filename).catch(() => null);
      if (!file?.isFile()) throw new StudioError(404, '文件不存在');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': file.size, 'Cache-Control': /\/(?:img|thumbs)\//.test(relative) ? 'public, max-age=86400' : 'no-cache' });
      if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 400, { error: error.status || !error.code ? error.message : '安装服务处理失败，请检查本机文件与运行日志' }); else res.end();
      if (!error.status && error.code) console.error('Studio service error:', error.code);
    } finally { if (ownsSwitch) switching = false; }
  });
  server.requestTimeout = 0;
  async function shutdown() {
    if (stopped) return; stopped = true;
    await runtimeManager.close();
    if (backend) { try { await stopBackend(); } catch { backend?.child.kill(); } }
    server.close();
  }
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : '创作台启动失败'); shutdown(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, shutdown, root, port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudioServer();
  console.log(`POSE Atlas Studio: http://127.0.0.1:${studio.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => studio.shutdown().then(() => process.exit(0)));
}
