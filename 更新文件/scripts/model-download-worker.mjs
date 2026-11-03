// This process handles public model downloads only. Proxy settings must not
// affect the parent process's direct connections to local/LAN ComfyUI engines.
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const controller = new AbortController();
let timeout = setTimeout(() => controller.abort(new Error('连接下载源超时，请稍后续传或切换下载来源')), 30000);
const resetIdleTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(new Error('下载长时间无响应，进度已保留，请续传或切换下载来源')), 45000); };
try {
  const [url, start] = process.argv.slice(2);
  const offset = Number(start);
  const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal });
  clearTimeout(timeout);
  if (!response.ok) throw Object.assign(new Error(`下载源返回 HTTP ${response.status}，可切换来源或使用夸克下载后导入`), { retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
  process.send({ status: response.status, contentRange: response.headers.get('content-range') });
  resetIdleTimeout();
  const activity = new Transform({ transform(chunk, _, done) { resetIdleTimeout(); done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), activity, process.stdout);
} catch (error) {
  process.send?.({ error: error.message === 'fetch failed' ? '无法连接所选下载源，已保留进度；可切换来源或使用夸克下载后导入' : error.message, retryable: error.retryable ?? true });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (process.connected) process.disconnect();
}
