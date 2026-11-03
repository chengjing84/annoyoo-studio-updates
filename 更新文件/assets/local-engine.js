(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : '';
  const dialog = $('localEngineDialog');
  let state = null, runtime = null, loading = false, generationBusy = false, timer = null, reportedDetection = null;
  const activeModel = () => !!state?.queuedModelIds?.length || ['queued', 'downloading', 'retrying', 'importing', 'verifying'].includes(state?.task?.status);
  const activeRuntime = () => !!runtime?.task && !['completed', 'error', 'cancelled'].includes(runtime.task.status);
  const gib = value => `${(Number(value || 0) / 1073741824).toFixed(2)} GiB`;
  const selectedMode = () => dialog.querySelector('[name=localEngineMode]:checked')?.value || 'external';
  function message(text = '', error = false) { $('localEngineFeedback').textContent = text; $('localEngineFeedback').classList.toggle('is-error', error); }
  async function request(route, body, timeout = 30000) {
    const response = await fetch(base + route, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
    return result;
  }
  const api = (action = '', body) => request('/api/local-engine' + (action ? '/' + action : ''), body);
  function sourceHint() {
    $('modelDownloadSourceHint').textContent = $('modelDownloadSource').value === 'mirror'
      ? '国内镜像通常可直连；中断后可续传，完成后自动校验。'
      : '直接连接 Hugging Face，部分国内网络可能需要代理。';
  }
  function badge(id, text, ready = false) { $(id).textContent = text; $(id).dataset.ready = String(ready); }
  function link(id, value) {
    let url; try { url = new URL(value); } catch {}
    const valid = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    $(id).setAttribute('aria-disabled', String(!valid));
    if (valid) $(id).href = url.href; else $(id).removeAttribute('href');
  }
  function modeFields() {
    const builtin = selectedMode() === 'builtin';
    $('enginePreparation').hidden = !builtin;
    $('externalEngineFields').hidden = builtin; $('externalComfyUrl').required = !builtin;
    $('builtinEngineFields').hidden = !builtin;
    $('localEngineTitle').textContent = builtin ? '本地环境与模型' : '连接已有 ComfyUI';
    $('localEngineSubtitle').textContent = builtin ? '准备好下面两项，就可以在本机生成图片。' : '沿用现有环境与模型，无需重复下载。';
    $('stopBuiltinEngine').hidden = !state?.engine?.owned;
  }
  function controls() {
    const busy = loading || activeModel() || activeRuntime(), builtin = selectedMode() === 'builtin';
    dialog.querySelectorAll('form input,form textarea,form button').forEach(control => { control.disabled = busy || generationBusy; });
    for (const id of ['downloadAllModels', 'detectLocalModels', 'modelDownloadSource']) $(id).disabled = busy || generationBusy || !state;
    $('downloadAllModels').disabled ||= !!state && state.models.every(model => model.verified);
    $('engineDownloadRuntime').disabled = busy || generationBusy || !runtime?.downloadConfigured || !!runtime?.available;
    $('engineDetectRuntime').disabled = busy || !state;
    $('copyModelDirectory').disabled = !state;
    dialog.querySelectorAll('[data-reset]').forEach(button => { button.disabled = busy || generationBusy; });
    $('cancelModelTransfer').disabled = loading || !activeModel();
    $('cancelModelTransfer').hidden = !activeModel();
    $('engineCancelRuntime').hidden = !activeRuntime();
    $('engineCancelRuntime').disabled = loading || ['extracting', 'checking', 'installing', 'validating'].includes(runtime?.task?.status);
    $('startBuiltinEngine').hidden = !builtin && !state?.engine?.comfyDirectory;
    $('startBuiltinEngine').textContent = state?.engine?.owned ? '返回创作台' : builtin ? '启动本地生图' : '启动已有 ComfyUI';
    $('startBuiltinEngine').disabled = busy || generationBusy || !state || !state.engine.owned && (builtin ? !runtime?.available || !state.models.every(model => model.verified) : !state.engine.comfyDirectory);
    $('engineReadyHint').textContent = state?.engine?.owned ? '本地引擎已运行。' : builtin ? '完成两项检测后，即可开始生图。' : '保存后，回到创作台检查连接。';
  }
  function renderRuntime() {
    if (!state) return;
    const available = runtime?.available ?? state.engine.builtinAvailable;
    $('engineRuntimeTitle').textContent = runtime?.bundled ? '内置运行环境' : '下载环境配置包';
    $('engineDownloadRuntime').hidden = !!runtime?.bundled;
    $('engineRuntimeManual').hidden = !!runtime?.bundled && available;
    badge('engineRuntimeState', available ? '已就绪' : activeRuntime() ? '准备中' : '待准备', available);
    $('engineRuntimeHint').textContent = runtime?.bundled ? available ? '整合包已附带 Python、PyTorch 和 ComfyUI。' : '整合包环境不完整，请重新下载完整整合包。' : available ? '环境已就绪，无需重复下载。' : runtime?.downloadConfigured || runtime?.manualUrl || runtime?.quarkUrl
      ? '包含 Python 和 ComfyUI，只需准备一次。'
      : '下载地址待发布。已有环境包可放到指定位置后检测。';
    $('engineRuntimeDirectory').textContent = runtime?.runtimeRoot || `${state.engine.projectRoot || state.modelRoot.replace(/[\\/]models$/, '')}/runtime`;
    link('engineRuntimeManual', runtime?.bundled ? runtime.fullPackageUrl : runtime?.manualUrl || runtime?.quarkUrl || runtime?.downloadUrl);
    $('engineRuntimeManual').textContent = /^https:\/\/(?:pan|drive)\.quark\.cn\//.test($('engineRuntimeManual').href || '') ? '夸克网盘 ↗' : '手动下载 ↗';
    const task = runtime?.task;
    $('engineRuntimeTransfer').hidden = !task || ['completed', 'cancelled'].includes(task.status);
    if (task) {
      const labels = { queued: '准备中', downloading: '正在下载环境', verifying: '正在校验环境', extracting: '正在安装环境', checking: '正在检查环境', error: '环境准备未完成' };
      $('engineRuntimeTransferLabel').textContent = labels[task.status] || '正在准备环境';
      if (task.total && task.status === 'downloading') { $('engineRuntimeProgress').max = task.total; $('engineRuntimeProgress').value = task.received || 0; }
      else $('engineRuntimeProgress').removeAttribute('value');
      $('engineRuntimeTransferDetail').textContent = task.error || (task.total ? `${gib(task.received)} / ${gib(task.total)}` : '请保持创作台运行。');
    }
  }
  function renderModels() {
    $('localModelDirectory').textContent = state.modelRoot;
    const ready = state.models.filter(model => model.verified).length, present = state.models.filter(model => model.present).length;
    badge('engineModelsState', ready === state.models.length ? `已就绪 · ${ready}/${state.models.length}` : present === state.models.length ? '已放好，待检测' : `缺少 ${state.models.length - present} 个文件`, ready === state.models.length);
    $('downloadAllModels').textContent = ready === state.models.length ? '已下载' : state.models.some(model => model.downloadedBytes && !model.present) ? '继续下载' : '自动下载';
    const list = $('localModelList'); list.replaceChildren();
    for (const model of state.models) {
      const row = document.createElement('div'); row.className = 'engine-model-row';
      const info = document.createElement('div'), title = document.createElement('h4'), location = document.createElement('code'), status = document.createElement('span');
      title.textContent = model.name; location.textContent = model.file;
      status.className = 'engine-file-state';
      status.textContent = state.task?.kind === 'detection' && state.task.status === 'error' && state.task.modelId === model.id ? '校验未通过' : model.verified ? '已通过检测' : model.wrongSize ? '大小不匹配' : model.present ? '待校验' : model.downloadedBytes ? `已下载 ${gib(model.downloadedBytes)}` : '未找到';
      info.append(title, location);
      const actions = document.createElement('div'); actions.className = 'engine-model-actions'; actions.append(status);
      if (model.downloadedBytes && !model.present) { const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'gen-text-button'; reset.dataset.reset = model.id; reset.textContent = '重置进度'; actions.append(reset); }
      row.append(info, actions); list.append(row);
    }
    link('modelQuarkLink', /^https:\/\/(?:pan|drive)\.quark\.cn\//.test(state.quarkUrl || '') ? state.quarkUrl : '');
    $('modelQuarkHint').textContent = `models 文件夹内请保留以下层级。${state.quarkCode ? `提取码：${state.quarkCode}。` : ''}`;
    const task = state.task;
    $('modelTransfer').hidden = !task || ['completed', 'cancelled'].includes(task.status);
    if (task) {
      const title = state.models.find(model => model.id === task.modelId)?.name || '模型';
      const labels = { queued: '准备中', downloading: '下载中', retrying: '连接中断，正在重试', importing: '导入中', verifying: '正在校验', error: '未完成' };
      $('modelTransferLabel').textContent = task.kind === 'detection' ? `检测模型 · ${labels[task.status] || task.status}` : `${title} · ${labels[task.status] || task.status}`;
      $('modelTransferProgress').max = task.total || 1; $('modelTransferProgress').value = task.received || 0;
      $('modelTransferDetail').textContent = task.error || [task.kind === 'detection' ? title : `${gib(task.received)} / ${gib(task.total)}`, task.sourceName].filter(Boolean).join(' · ');
      if (task.kind === 'detection' && ['completed', 'error'].includes(task.status) && reportedDetection !== task.startedAt) {
        reportedDetection = task.startedAt;
        message(task.status === 'error' ? task.error : task.missingIds?.length ? `检测完成，还缺少 ${task.missingIds.length} 个模型。请按文件位置放好后再检测。` : '三个模型已通过检测，可以开始生图。', task.status === 'error');
      }
    }
  }
  async function refresh(fill = false) {
    const [next, environment] = await Promise.all([api(), request('/api/runtime').catch(() => null)]);
    state = next; runtime = environment || { available: state.engine.builtinAvailable };
    if (fill) {
      let savedSource; try { savedSource = localStorage.getItem('pose-atlas-model-download-source'); } catch {}
      $('modelDownloadSource').value = (state.downloadSources || []).some(item => item.id === savedSource) ? savedSource : state.defaultDownloadSource || 'official';
      dialog.querySelector(`[name=localEngineMode][value=${state.engine.mode}]`).checked = true;
      $('externalComfyUrl').value = state.engine.externalUrl;
      $('extraModelDirectories').value = state.engine.modelDirectories.join('\n');
      $('engineConnectionOptions').open = state.engine.mode === 'external';
    }
    if (activeModel() && state.task?.sourceId) $('modelDownloadSource').value = state.task.sourceId;
    sourceHint(); modeFields(); renderRuntime(); renderModels(); controls();
    if (state.engine.phase === 'error') message(state.engine.error, true);
    clearTimeout(timer);
    if (activeModel() || activeRuntime() || dialog.open && state.engine.phase === 'starting') timer = setTimeout(poll, 1500);
    return state;
  }
  async function poll() {
    try { await refresh(); if (state.engine.phase === 'running') document.dispatchEvent(new CustomEvent('local-engine-ready')); }
    catch (error) { message(error.message, true); if (dialog.open || activeModel() || activeRuntime()) timer = setTimeout(poll, 4000); }
  }
  async function perform(action, body, success) {
    loading = true; controls();
    try { await api(action, body); await refresh(); if (success && !(action === 'detect-models' && ['completed', 'error'].includes(state.task?.status))) message(success); return true; }
    catch (error) { message(error.message, true); return false; }
    finally { loading = false; controls(); }
  }
  const connectionChanged = () => document.dispatchEvent(new CustomEvent('local-engine-changed'));
  $('openLocalEngine').addEventListener('click', async () => {
    dialog.showModal(); document.body.classList.add('engine-open'); loading = true; message(); controls();
    try { await refresh(true); } catch (error) { message('无法读取配置，请从“启动创作台.cmd”打开页面。' + error.message, true); }
    finally { loading = false; controls(); }
    let automatic = false; try { automatic = sessionStorage.getItem('pose-atlas-download-models-once') === '1'; sessionStorage.removeItem('pose-atlas-download-models-once'); } catch {}
    if (automatic && state?.engine?.mode === 'builtin' && !activeModel() && !activeRuntime() && !state.models.every(model => model.verified)) perform('download-all', { source: $('modelDownloadSource').value }, '正在自动下载模型，完成后会放到指定位置并校验。');
  });
  $('closeLocalEngine').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { document.body.classList.remove('engine-open'); clearTimeout(timer); if (activeModel() || activeRuntime()) timer = setTimeout(poll, 1500); });
  dialog.querySelectorAll('[name=localEngineMode]').forEach(input => input.addEventListener('change', () => { modeFields(); controls(); }));
  $('refreshLocalEngine').addEventListener('click', async () => { try { await refresh(true); connectionChanged(); } catch (error) { message(error.message, true); } });
  $('localEngineForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = { mode: selectedMode(), externalUrl: $('externalComfyUrl').value.trim(), modelDirectories: $('extraModelDirectories').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) };
    if (await perform('configure', body, '设置已保存。已有模型目录可直接检测。')) connectionChanged();
  });
  $('startBuiltinEngine').addEventListener('click', async () => {
    if (state?.engine?.owned) { dialog.close(); return; }
    if (await perform('start', {}, '本地引擎正在启动。')) connectionChanged();
  });
  $('stopBuiltinEngine').addEventListener('click', async () => { if (await perform('stop', {}, '本地引擎已停止。')) connectionChanged(); });
  $('downloadAllModels').addEventListener('click', () => perform('download-all', { source: $('modelDownloadSource').value }, '正在自动下载，完成后会放到指定位置并校验。'));
  $('detectLocalModels').addEventListener('click', () => perform('detect-models', {}, '正在检测指定目录中的模型，大文件校验需要一些时间。'));
  $('cancelModelTransfer').addEventListener('click', () => perform('cancel', {}, '任务已取消，已有下载进度保留。'));
  $('localModelList').addEventListener('click', event => { const reset = event.target.closest('[data-reset]'); if (reset) perform('reset-download', { modelId: reset.dataset.reset }, '此模型的临时下载已重置。'); });
  $('modelDownloadSource').addEventListener('change', () => { sourceHint(); try { localStorage.setItem('pose-atlas-model-download-source', $('modelDownloadSource').value); } catch {} });
  $('copyModelDirectory').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.modelRoot); message('模型文件夹路径已复制。'); } catch { message('请选中上方路径并复制。'); } });
  $('modelQuarkLink').addEventListener('click', event => { if ($('modelQuarkLink').getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; } $('modelDownloadOptions').open = true; });
  $('engineRuntimeManual').addEventListener('click', event => { if ($('engineRuntimeManual').getAttribute('aria-disabled') === 'true') event.preventDefault(); else $('engineRuntimeManual').closest('section').querySelector('details').open = true; });
  $('engineDetectRuntime').addEventListener('click', async () => { loading = true; controls(); try { await refresh(); message(runtime.available ? '环境已就绪，可以继续准备 Qwen 模型。' : '还未检测到环境。请将 runtime 文件夹放到创作台根目录后重试。'); } catch (error) { message(error.message, true); } finally { loading = false; controls(); } });
  async function runtimeAction(action) { loading = true; controls(); try { await request('/api/runtime/' + action, {}); await refresh(); message(action === 'cancel' ? '环境下载已取消。' : '正在下载并安装环境，请保持创作台运行。'); } catch (error) { message(error.message, true); } finally { loading = false; controls(); } }
  $('engineDownloadRuntime').addEventListener('click', () => runtimeAction('download'));
  $('engineCancelRuntime').addEventListener('click', () => runtimeAction('cancel'));
  document.addEventListener('generation-busy-changed', event => { generationBusy = event.detail === true; controls(); });
  controls();
})();
