(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('apiSettingsDialog');
  if (!dialog) return;
  let loading = false, generationBusy = !$('generationJobOverlay').hidden, keyConfigured = false, loaded = false;
  const base = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : '';
  function feedback(text, error = false) {
    $('imageApiFeedback').textContent = text;
    $('imageApiFeedback').classList.toggle('is-error', error);
  }
  function controls() {
    dialog.querySelectorAll('form input,form select,form button').forEach(field => { field.disabled = loading || generationBusy || !loaded; });
    $('imageApiKey').required = !keyConfigured && !$('imageApiClearKey').checked;
    $('imageApiKey').disabled = loading || generationBusy || !loaded || $('imageApiClearKey').checked;
  }
  function protocolHint() {
    const qwen = $('imageApiProtocol').value === 'qwen-json';
    const media = $('imageApiProtocol').value === 'lk-media';
    $('imageApiProtocolHint').textContent = media
      ? '适用于 LK 的 tt-image-2.5 系列。先提交任务，再查询原任务的图片；查询中断或重启程序后可继续取回结果。默认标准版，增强版请填 tt-image-2.5-sunburst。每张参考图最多 10 MB，合计最多 30 MB。'
      : qwen
      ? '适用于 Qwen 兼容图片接口；多张参考图通过 JSON 的 image 数组提交。'
      : '适用于支持 /images/edits 的服务；多张参考图按顺序通过 image[] 提交。';
    const suffix = qwen ? 'generations' : 'edits';
    let hint = `只填域名默认使用 /v1/${media ? 'media/generate' : 'images/' + suffix}；自定义前缀请填写基础地址或完整接口路径。`;
    try {
      const url = new URL($('imageApiEndpoint').value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid endpoint');
      let endpoint = url.href.replace(/\/+$/, '');
      if (url.pathname === '/') endpoint += '/v1';
      if (media) {
        if (/\/images\/(?:edits|generations)$/i.test(endpoint)) throw new Error('请改用基础地址或 /media/generate');
        if (!/\/media\/generate$/i.test(endpoint)) endpoint += /\/media$/i.test(endpoint) ? '/generate' : '/media/generate';
      } else if (!/\/images\/(?:edits|generations)$/i.test(endpoint)) endpoint += /\/images$/i.test(endpoint) ? '/' + suffix : '/images/' + suffix;
      hint += ` 本次请求地址：${endpoint}`;
    } catch {}
    $('imageApiEndpointHint').textContent = hint;
  }
  async function api(payload) {
    const response = await fetch(base + '/api/image-api/configure', {
      ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '配置保存失败，请重试。');
    return result;
  }
  function render(state) {
    $('imageApiEndpoint').value = state.endpoint || '';
    $('imageApiModel').value = state.model || '';
    $('imageApiProtocol').value = state.protocol || 'images-multipart';
    $('imageApiSizeMode').value = state.sizeMode || 'auto';
    $('imageApiKey').value = '';
    $('imageApiClearKey').checked = false;
    keyConfigured = !!state.keyConfigured;
    $('imageApiKeyState').textContent = keyConfigured ? '已保存在本机' : '尚未配置';
    $('imageApiKey').placeholder = keyConfigured ? '留空保留原 Key，填写则替换' : '粘贴 API Key';
    $('imageApiClearKeyField').hidden = !keyConfigured;
    protocolHint();
  }
  async function open() {
    if (dialog.open) return;
    dialog.showModal(); dialog.scrollTop = 0; document.body.classList.add('api-settings-open');
    loading = true; loaded = false; controls(); feedback('正在读取配置…');
    try { render(await api()); loaded = true; feedback(generationBusy ? '生成期间暂时无法修改配置，任务完成后可编辑。' : '配置保存在本机。保存配置不会发送生图请求。'); }
    catch (error) { feedback(error.name === 'TimeoutError' ? '读取配置超时，请关闭窗口后重新打开。' : error.message, true); }
    finally { loading = false; controls(); }
  }
  $('openApiSettings').addEventListener('click', open);
  $('closeApiSettings').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { document.body.classList.remove('api-settings-open'); $('imageApiKey').value = ''; });
  $('imageApiProtocol').addEventListener('change', protocolHint);
  $('imageApiEndpoint').addEventListener('input', protocolHint);
  $('imageApiClearKey').addEventListener('change', () => { if ($('imageApiClearKey').checked) $('imageApiKey').value = ''; controls(); });
  document.addEventListener('generation-busy-changed', event => { generationBusy = !!event.detail; controls(); });
  $('apiSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (loading || generationBusy || !loaded) return;
    const payload = { endpoint: $('imageApiEndpoint').value.trim(), model: $('imageApiModel').value.trim(),
      protocol: $('imageApiProtocol').value, sizeMode: $('imageApiSizeMode').value,
      apiKey: $('imageApiKey').value.trim(), clearKey: $('imageApiClearKey').checked };
    loading = true; controls(); feedback('正在保存…');
    try {
      const state = await api(payload); render(state);
      feedback(state.ready ? '已保存。关闭设置后即可生成，接口可用性以实际生成结果为准。' : '已保存。请补全接口地址、模型名称与 API Key 后生成。');
      document.dispatchEvent(new CustomEvent('image-api-changed'));
    } catch (error) { feedback(error.name === 'TimeoutError' ? '保存超时，请重新打开设置确认配置是否已保存。' : error.message, true); }
    finally { loading = false; controls(); }
  });
})();
