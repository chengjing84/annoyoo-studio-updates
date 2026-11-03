import { ImageApiError, imageType, readLimited, resolveRequestEndpoint, safeProviderMessage } from './image-api.mjs';

export function mediaStatusEndpoint(settings) {
  return resolveRequestEndpoint({ ...settings, protocol: 'lk-media' }).replace(/\/media\/generate$/i, '/skills/task-status');
}

function taskId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,24}$/.test(String(value)) || typeof value === 'number' && !Number.isSafeInteger(value)) throw new ImageApiError(502, '接口未返回有效的 task_id，请先查看服务商任务记录，勿重复生图');
  return String(value);
}

async function mediaRequest(settings, url, options, fetchImpl, timeout) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + settings.apiKey }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    const data = JSON.parse((await readLimited(response, 2 * 1048576)).toString('utf8'));
    if (!response.ok) throw new ImageApiError(response.status === 401 || response.status === 403 ? response.status : 502, `任务接口返回 HTTP ${response.status}：${safeProviderMessage(data.error?.message || data.message || data.msg, settings.apiKey)}`);
    return data;
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    const code = String(error.cause?.code || error.code || error.name || 'NETWORK_ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
    throw new ImageApiError(502, `任务接口连接中断或返回异常（${code}）`);
  }
}

// Only the initial submission can incur a generation charge. Never retry it.
export async function submitMediaTask(settings, { prompt, images, width, height }, { fetchImpl = fetch, timeout = 120000 } = {}) {
  if (!/^tt-image-2\.5(?:-(?:flare|sunburst))?$/i.test(settings.model)) throw new ImageApiError(400, 'LK 异步协议当前仅支持 tt-image-2.5 系列');
  let total = 0;
  const references = images.map(image => {
    const type = imageType(image.bytes);
    if (!type) throw new ImageApiError(400, '参考图不是有效的 PNG、JPEG 或 WebP 图片');
    if (image.bytes.length > 10 * 1048576) throw new ImageApiError(400, 'LK 异步接口每张参考图不能超过 10 MB，请压缩后重试');
    total += image.bytes.length;
    return `data:${type.mime};base64,${image.bytes.toString('base64')}`;
  });
  if (total > 30 * 1048576) throw new ImageApiError(400, 'LK 异步接口参考图合计不能超过 30 MB，请压缩后重试');
  const body = JSON.stringify({ model: settings.model, prompt, params: {
    version: /-sunburst$/i.test(settings.model) ? 'sunburst' : 'flare',
    size: settings.sizeMode === 'selected' ? `${width}x${height}` : 'auto',
    ...(references.length ? { images: references } : {})
  } });
  if (Buffer.byteLength(body) > 50 * 1048576) throw new ImageApiError(400, 'LK 异步请求不能超过 50 MB，请压缩参考图后重试');
  let data;
  try { data = await mediaRequest(settings, resolveRequestEndpoint(settings), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, fetchImpl, timeout); }
  catch (error) { throw new ImageApiError(error.status, error.message + '。提交可能已被受理，请先查看服务商任务记录，勿重复提交计费。'); }
  if (data.code !== 200) throw new ImageApiError(502, `服务商未接受任务：${safeProviderMessage(data.msg || data.message || data.error?.message, settings.apiKey)}`);
  return { id: taskId(data.data?.task_id), statusEndpoint: mediaStatusEndpoint(settings) };
}

// GET queries can be repeated safely; they never submit another generation.
export async function queryMediaTask(settings, providerTask, { fetchImpl = fetch, timeout = 30000 } = {}) {
  const endpoint = mediaStatusEndpoint(settings);
  if (providerTask.statusEndpoint !== endpoint) throw new ImageApiError(409, '当前接口地址与任务提交时不同，请恢复原 API 配置后重新查询');
  const url = new URL(endpoint); url.searchParams.set('task_id', taskId(providerTask.id));
  const data = await mediaRequest(settings, url.href, { method: 'GET' }, fetchImpl, timeout);
  const modelFamily = model => model.replace(/-(?:flare|sunburst)$/i, '').toLowerCase();
  if (data.model && (typeof data.model !== 'string' || modelFamily(data.model) !== modelFamily(settings.model))) throw new ImageApiError(409, '服务商任务的模型与本地记录不一致，请检查 API 配置');
  const progress = Number(String(data.progress ?? 0).replace(/%$/, ''));
  const base = { progress: Number.isFinite(progress) ? { value: Math.max(0, Math.min(100, progress)), max: 100 } : null };
  if (data.is_final === true && data.state === 'failed') return { ...base, status: 'error', error: safeProviderMessage(data.error || '服务商生成失败，请检查服务商任务记录', settings.apiKey) };
  if (data.is_final === true && data.state === 'success') {
    const urls = Array.isArray(data.result_urls) && data.result_urls.length ? data.result_urls : data.result_url ? [data.result_url] : [];
    if (!urls.length || urls.length > 10 || urls.some(url => typeof url !== 'string' || !url)) throw new ImageApiError(502, '任务已完成，但尚未取得有效的图片结果地址，将继续查询原任务');
    return { ...base, status: 'completed', images: urls.map(url => ({ url })) };
  }
  if (data.is_final === true) return { ...base, status: 'error', error: '服务商任务已结束，但未返回成功状态，请检查任务记录' };
  if (!['pending', 'running', 'success'].includes(data.state)) throw new ImageApiError(502, '任务查询返回未知状态，将继续查询原任务');
  return { ...base, status: data.state === 'pending' ? 'queued' : 'running' };
}
