import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export class ImageApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const PROTOCOLS = [
  { id: 'images-multipart', label: 'Images 编辑接口（multipart）' },
  { id: 'qwen-json', label: 'Qwen 兼容接口（JSON）' },
  { id: 'lk-media', label: 'LK tt-image-2.5（异步任务）' }
];

export function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new ImageApiError(400, '接口地址格式不正确');
  if (!value.trim()) return '';
  let url;
  try { url = new URL(value.trim()); } catch { throw new ImageApiError(400, '请输入完整的 http 或 https 接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || ['0.0.0.0', '[::]'].includes(url.hostname)) throw new ImageApiError(400, '接口地址应使用 http 或 https，且不能包含账号、密码、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}

export function resolveRequestEndpoint(settings, hasImages = true) {
  let endpoint = settings.endpoint?.replace(/\/+$/, '');
  if (!endpoint) return '';
  // A bare host is the common shorthand for an Images-compatible /v1 base.
  // Explicit paths (including root-level /images/*) are kept as configured.
  if (new URL(endpoint).pathname === '/') endpoint += '/v1';
  if (settings.protocol === 'lk-media') {
    if (/\/images\/(?:edits|generations)$/i.test(endpoint)) throw new ImageApiError(400, 'LK 异步任务请填写基础地址或完整的 /media/generate 地址');
    return /\/media\/generate$/i.test(endpoint) ? endpoint : endpoint + (/\/media$/i.test(endpoint) ? '/generate' : '/media/generate');
  }
  const suffix = settings.protocol === 'qwen-json' || !hasImages ? 'generations' : 'edits';
  if (/\/images\/(?:edits|generations)$/i.test(endpoint)) {
    if (!endpoint.toLowerCase().endsWith('/images/' + suffix)) throw new ImageApiError(400, `当前协议需要 /images/${suffix}，请修改接口地址或协议类型`);
    return endpoint;
  }
  return endpoint + (/\/images$/i.test(endpoint) ? '/' : '/images/') + suffix;
}

export function publicSettings(settings) {
  const ready = !!(settings.endpoint && settings.apiKey && settings.model);
  let requestEndpoint = '';
  let configurationError = '';
  try { requestEndpoint = resolveRequestEndpoint(settings); } catch (error) { configurationError = error.message; }
  return { endpoint: settings.endpoint, model: settings.model, protocol: settings.protocol, sizeMode: settings.sizeMode, keyConfigured: !!settings.apiKey, ready: ready && !configurationError, requestEndpoint, configurationError, protocols: PROTOCOLS };
}

export class ImageApiSettings {
  static async create(root) {
    const instance = new ImageApiSettings(path.join(root, '.local', 'api-settings.json'));
    try {
      const saved = JSON.parse(await readFile(instance.filename, 'utf8'));
      instance.settings = instance.validate(saved, { apiKey: '' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('API 配置文件无法读取，请检查 .local/api-settings.json');
    }
    return instance;
  }
  constructor(filename) { this.filename = filename; this.settings = { endpoint: '', apiKey: '', model: '', protocol: 'images-multipart', sizeMode: 'auto' }; }
  validate(body, previous = this.settings) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImageApiError(400, '设置格式不正确');
    const endpoint = normalizeEndpoint(body.endpoint ?? previous.endpoint ?? '');
    const model = body.model ?? previous.model ?? '';
    const protocol = body.protocol ?? previous.protocol ?? 'images-multipart';
    const sizeMode = body.sizeMode ?? previous.sizeMode ?? 'auto';
    if (typeof model !== 'string' || model.trim().length > 256 || /[\r\n\x00-\x1f]/.test(model)) throw new ImageApiError(400, '模型名称格式不正确');
    if (!PROTOCOLS.some(item => item.id === protocol)) throw new ImageApiError(400, '请选择有效的接口协议');
    if (protocol === 'lk-media' && model.trim() && !/^tt-image-2\.5(?:-(?:flare|sunburst))?$/i.test(model.trim())) throw new ImageApiError(400, 'LK 异步协议当前支持 tt-image-2.5、tt-image-2.5-flare 与 tt-image-2.5-sunburst');
    if (!['auto', 'selected'].includes(sizeMode)) throw new ImageApiError(400, '图片尺寸模式不正确');
    if (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') throw new ImageApiError(400, '清除密钥参数不正确');
    if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192 || /[\r\n\x00-\x1f]/.test(body.apiKey))) throw new ImageApiError(400, 'API Key 格式不正确');
    const apiKey = body.clearKey ? '' : body.apiKey?.trim() || previous.apiKey || '';
    const settings = { endpoint, model: model.trim(), protocol, sizeMode, apiKey };
    resolveRequestEndpoint(settings);
    return settings;
  }
  public() { return publicSettings(this.settings); }
  async configure(body) {
    const settings = this.validate(body);
    await mkdir(path.dirname(this.filename), { recursive: true });
    await writeFile(this.filename + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(this.filename + '.tmp', this.filename);
    this.settings = settings;
    return this.public();
  }
}

export function imageType(bytes) {
  if (bytes.length < 16) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export function safeProviderMessage(message, key = '') {
  let text = String(message || '服务商没有提供错误详情');
  for (const secret of [key, encodeURIComponent(key)]) if (secret) text = text.split(secret).join('[密钥已隐藏]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [密钥已隐藏]').replace(/sk-[\w-]{8,}/g, '[密钥已隐藏]').replace(/data:image\/[^;,\s]+;base64,[\w+/=]+/gi, '[图片数据]').replace(/https?:\/\/[^\s"'<>]+/gi, value => value.split('?')[0]).slice(0, 800);
}

export async function readLimited(response, limit, label = '接口响应') {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new ImageApiError(502, `${label}过大，无法处理`); }
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new ImageApiError(502, `${label}过大，无法处理`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// One submission only: failed or interrupted billable requests are never retried.
export async function generateImage(settings, { prompt, images, width, height }, { fetchImpl = fetch, timeout = 600000 } = {}) {
  if (!publicSettings(settings).ready) throw new ImageApiError(400, '请先填写接口地址、API Key 和模型名称');
  const endpoint = resolveRequestEndpoint(settings, images.length > 0);
  const headers = { Authorization: 'Bearer ' + settings.apiKey };
  const size = settings.sizeMode === 'selected' ? `${width}x${height}` : 'auto';
  let body;
  for (const image of images) {
    const type = imageType(image.bytes);
    if (!type) throw new ImageApiError(400, '参考图不是有效的 PNG、JPEG 或 WebP 图片');
    if (image.bytes.length > (settings.protocol === 'qwen-json' ? 10 : 20) * 1048576) throw new ImageApiError(400, settings.protocol === 'qwen-json' ? 'Qwen 接口每张参考图不能超过 10 MB，请压缩后重试' : '每张参考图不能超过 20 MB，请压缩后重试');
  }
  if (settings.protocol === 'images-multipart' && images.length) {
    body = new FormData();
    body.set('model', settings.model); body.set('prompt', prompt); body.set('n', '1'); body.set('size', size);
    const field = images.length > 1 ? 'image[]' : 'image';
    images.forEach((image, index) => { const type = imageType(image.bytes); body.append(field, new Blob([image.bytes], { type: type.mime }), `reference-${index + 1}.${type.ext}`); });
  } else {
    headers['Content-Type'] = 'application/json';
    const payload = { model: settings.model, prompt, n: 1, size };
    if (images.length) {
      const dataUrls = images.map(image => `data:${imageType(image.bytes).mime};base64,${image.bytes.toString('base64')}`);
      payload.image = dataUrls.length === 1 ? dataUrls[0] : dataUrls;
    }
    body = JSON.stringify(payload);
  }
  let response;
  try { response = await fetchImpl(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch (error) {
    const code = String(error.cause?.code || error.code || error.name || 'NETWORK_ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
    throw new ImageApiError(502, `生图请求连接中断或超时（${code}）。服务商可能仍在处理，请先查看服务商任务记录，避免重复提交计费。`);
  }
  const pathHint = response.status === 404 ? ` 请在 API 设置中核对完整接口路径与协议（本次路径：${new URL(endpoint).pathname}）。纯域名默认使用 /v1；自定义路径请填写完整地址。` : '';
  let data;
  try { data = JSON.parse((await readLimited(response, 180 * 1048576)).toString('utf8')); }
  catch (error) { if (error instanceof ImageApiError) throw error; throw new ImageApiError(502, `接口返回了无法识别的数据（HTTP ${response.status}），请检查协议和地址。${pathHint}`); }
  if (!response.ok || data.error) {
    const detail = data.error?.message || data.error || data.message || data.code || `HTTP ${response.status}`;
    throw new ImageApiError(502, `生图接口拒绝请求（HTTP ${response.status}）：${safeProviderMessage(typeof detail === 'string' ? detail : JSON.stringify(detail), settings.apiKey)}${pathHint}`);
  }
  if (!Array.isArray(data.data) || !data.data.length || data.data.length > 10) throw new ImageApiError(502, '接口未返回 data 图片列表。请选择同步 Images 协议，异步任务和聊天接口暂不支持。');
  return data.data.map(item => {
    if (typeof item?.b64_json === 'string' && item.b64_json) return { b64_json: item.b64_json };
    if (typeof item?.url === 'string' && item.url) return { url: item.url };
    throw new ImageApiError(502, '接口结果中未找到 url 或 b64_json 图片数据');
  });
}

export async function resultBytes(image, { fetchImpl = fetch, timeout = 120000 } = {}) {
  let bytes;
  if (image.b64_json) {
    const encoded = image.b64_json.replace(/^data:image\/[a-z\d.+-]+;base64,/i, '');
    if (encoded.length > 140 * 1048576 || !/^[A-Za-z\d+/]+={0,2}$/.test(encoded)) throw new ImageApiError(502, '接口返回的 Base64 图片数据无效或过大');
    bytes = Buffer.from(encoded, 'base64');
  } else {
    let url;
    try { url = new URL(image.url); } catch { throw new ImageApiError(502, '接口返回了无效的图片下载地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ImageApiError(502, '结果图片地址必须使用 http 或 https');
    let response;
    // Result URLs are often on an unrelated CDN. Never send the API credential.
    try { response = await fetchImpl(url.href, { signal: AbortSignal.timeout(timeout), redirect: 'follow' }); }
    catch { throw new ImageApiError(502, '图片已生成，但下载结果失败。请检查网络后重新打开此任务，勿重复生图。'); }
    if (!response.ok) throw new ImageApiError(502, `图片已生成，但下载结果失败（HTTP ${response.status}）。请检查网络后重新打开此任务，勿重复生图。`);
    bytes = await readLimited(response, 100 * 1048576, '结果图片');
  }
  if (!imageType(bytes)) throw new ImageApiError(502, '接口返回的结果不是有效的 PNG、JPEG 或 WebP 图片');
  return bytes;
}
