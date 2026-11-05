(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const apiEdition = document.documentElement.dataset.edition === 'api';
  if (apiEdition) $('copyPromptRecord').hidden = true;
  const base = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : '';
  const storageKey = apiEdition ? 'pose-atlas-api-generation-v1' : 'pose-atlas-generation-v1';
  const poseKey = 'pose-atlas-selected-pose-v1';
  const costumeKey = 'pose-atlas-selected-costume-v1';
  let pose = null;
  let costume = null;
  const references = [0, 1].map(() => ({ file: null, objectUrl: '', id: '' }));
  const refElement = (name, index) => $(name + (index ? '2' : ''));
  let serviceReady = false;
  let busy = false;
  let job = null;
  let pollTimer = null;
  let pollFailures = 0;
  let resultUrl = '';
  let connectionChecking = false;
  let loraCatalog = null;
  let loraLoading = false;
  const loraSelection = [];
  const numberWheelControls = new WeakSet();
  let engineRevision = 0;
  let promptRecord = null;
  let promptRecordKey = '';
  let previewLoading = false;
  let retrySaveId = '';
  let retryQuery = false;
  let retrySaveButton = null;

  if (apiEdition) {
    $('loraSettings').hidden = true;
    $('generationSteps').parentElement.hidden = true;
    $('generationSeed').parentElement.hidden = true;
    const sizes = [['1024x1536', '竖图 · 2:3'], ['1536x1024', '横图 · 3:2'], ['1024x1024', '方图 · 1:1']];
    $('generationSize').replaceChildren(...sizes.map(([value, label]) => new Option(label, value)));
    const hint = document.createElement('p');
    hint.className = 'gen-field-hint'; hint.id = 'apiSizeHint';
    hint.textContent = '实际尺寸由 API 的模型和尺寸设置决定。';
    $('generationSize').parentElement.append(hint);
    retrySaveButton = document.createElement('button');
    retrySaveButton.type = 'button'; retrySaveButton.className = 'gen-secondary';
    retrySaveButton.id = 'retryApiSave'; retrySaveButton.textContent = '重试保存图片'; retrySaveButton.hidden = true;
    $('generationJobStatus').after(retrySaveButton);
    retrySaveButton.addEventListener('click', async () => {
      if (!retrySaveId || busy) return;
      setBusy(true);
      retrySaveButton.disabled = true;
      try {
        const data = await api(`/api/jobs/${encodeURIComponent(retrySaveId)}?${retryQuery ? 'retry-query' : 'retry-save'}=1`);
        job = { promptId: retrySaveId, createdAt: Date.now() }; saveStorage(storageKey, job);
        retrySaveButton.hidden = true; setBusy(true);
        if (data.status === 'completed') finishJob(data); else pollJob();
      } catch (error) { setBusy(false); $('generationJobStatus').textContent = errorMessage(error); }
      finally { retrySaveButton.disabled = false; }
    });
  }

  function promptSelectionKey() {
    return JSON.stringify([pose, costume?.id, references.map(ref => !!ref.file), $('referenceMode').value, $('generationPrompt').value, $('generationSize').value, $('copyCamera').checked, $('keepBackground').checked]);
  }

  function showPromptRecord(record, key, message) {
    promptRecord = record;
    promptRecordKey = key;
    $('promptPreviewText').textContent = apiEdition ? record.rewritten_prompt : JSON.stringify(record, null, 2);
    $('promptPreviewText').hidden = false;
    $('promptPreviewStatus').textContent = message;
    $('copyFinalPrompt').disabled = false;
    $('copyPromptRecord').disabled = false;
    $('copyFinalPrompt').textContent = '复制提示词';
    $('copyPromptRecord').textContent = '复制 JSON';
  }

  function invalidatePromptRecord() {
    if (!promptRecord || promptRecordKey === promptSelectionKey()) return;
    promptRecord = null;
    $('promptPreviewText').hidden = true;
    $('promptPreviewStatus').textContent = '设置已变化，请重新预览当前提示词。';
    $('copyFinalPrompt').disabled = true;
    $('copyPromptRecord').disabled = true;
  }

  function readGenerationPayload(preview = false) {
    const referenceMode = references[1].file ? $('referenceMode').value : 'single-character';
    if (references[1].file && referenceMode !== 'scene' && !references[0].file) throw new Error('请先上传人物参考1，再添加第二位人物或同人补充图。');
    if (!references[0].file && !$('generationPrompt').value.trim()) throw new Error('请上传人物参考1，或填写人物描述；环境图不提供人物身份。');
    if (!pose && !costume && !(references[0].file && references[1].file && referenceMode === 'scene')) throw new Error('请选择姿势或服装，或上传人物参考1与环境场景图。');
    const referenceRoles = references.flatMap((ref, index) => ref.file ? [index === 0 ? 'person1' : referenceMode === 'scene' ? 'scene' : referenceMode === 'same-character' ? 'supplement' : 'person2'] : []);
    const [width, height] = $('generationSize').value.split('x').map(Number);
    const steps = Number($('generationSteps').value);
    const seed = Number($('generationSeed').value);
    if (!Number.isInteger(steps) || steps < 20 || steps > 50 || !Number.isInteger(seed) || seed < -1 || seed > 4294967295) throw new Error('请检查生成设置：步数为 20–50 的整数，种子为 -1 或 0–4294967295。');
    return { poseId: pose?.id || null, costumeId: costume?.id || null, prompt: $('generationPrompt').value.trim(), width, height, steps, seed,
      loras: preview || apiEdition ? [] : readLoras(), copyCamera: !!pose && $('copyCamera').checked, referenceMode, referenceRoles,
      referenceIds: references.flatMap((ref, index) => ref.file ? [ref.id || `preview-${index}`] : []),
      keepBackground: !!references[0].file && referenceMode !== 'scene' && $('keepBackground').checked };
  }

  $('previewPrompt').addEventListener('click', async () => {
    if (previewLoading || busy) return;
    let payload;
    try { payload = readGenerationPayload(true); }
    catch (error) { $('promptPreviewStatus').textContent = errorMessage(error); return; }
    const key = promptSelectionKey();
    previewLoading = true;
    $('previewPrompt').disabled = true;
    $('promptPreviewStatus').textContent = '正在整理提示词…';
    try {
      const record = await api('/api/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (typeof record.rewritten_prompt !== 'string') throw new Error('提示词响应无效，请重启画廊服务。');
      if (key === promptSelectionKey()) showPromptRecord(record, key, apiEdition ? '这是将提交给生图 API 的通用描述，已包含参考图用途与画面比例。' : '这是当前设置将提交的提示词，画面比例单独传递。');
      else $('promptPreviewStatus').textContent = '设置已变化，请重新预览当前提示词。';
    } catch (error) { $('promptPreviewStatus').textContent = error.status === 404 ? '请重启画廊服务以启用提示词预览。' : errorMessage(error); }
    finally { previewLoading = false; $('previewPrompt').disabled = busy; }
  });

  for (const [id, json] of [['copyFinalPrompt', false], ['copyPromptRecord', true]]) {
    $(id).addEventListener('click', async () => {
      if (!promptRecord) return;
      const text = json ? JSON.stringify(promptRecord, null, 2) : promptRecord.rewritten_prompt;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const field = document.createElement('textarea'); field.value = text;
          field.style.cssText = 'position:fixed;left:0;top:0;opacity:0'; document.body.append(field);
          try { field.select(); if (!document.execCommand('copy')) throw new Error('复制不可用'); }
          finally { field.remove(); }
        }
        $(id).textContent = '已复制';
      } catch { $(id).textContent = '请手动选择文字复制'; }
    });
  }

  function bindNumberWheel(input) {
    if (numberWheelControls.has(input)) return;
    numberWheelControls.add(input);
    input.addEventListener('wheel', event => {
      if (document.activeElement !== input || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
      const distance = event.deltaY * (event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? innerHeight : 1);
      window.scrollBy({ top: distance, behavior: 'instant' });
    }, { passive: false });
  }

  function captureLoras() {
    document.querySelectorAll('.gen-lora-row').forEach((row, index) => {
      loraSelection[index] = { name: row.querySelector('select').value, strength: row.querySelector('input').value };
    });
  }

  function syncLoraControls() {
    $('loraCount').disabled = busy;
    $('refreshLoras').disabled = busy || loraLoading;
    document.querySelectorAll('.gen-lora-row select,.gen-lora-row input').forEach(control => { control.disabled = busy || loraLoading; });
  }

  function renderLoras() {
    const count = Number($('loraCount').value);
    $('loraSummary').textContent = count ? `${count} 个` : '默认不使用';
    $('loraRows').replaceChildren();
    for (let index = 0; index < count; index++) {
      const selected = loraSelection[index] || { name: '', strength: 1 };
      const row = document.createElement('div'); row.className = 'gen-lora-row';
      const modelLabel = document.createElement('label'); modelLabel.textContent = `LoRA ${index + 1}`;
      const select = document.createElement('select'); select.id = `loraModel${index}`;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择本机 LoRA'; select.append(placeholder);
      for (const name of loraCatalog?.names || []) {
        const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option);
      }
      // Keep unavailable selections visible so a refresh cannot silently clear them.
      if (selected.name && !loraCatalog?.names.includes(selected.name)) {
        const unavailable = document.createElement('option'); unavailable.value = selected.name; unavailable.textContent = selected.name + '（当前未找到）'; select.append(unavailable);
      }
      select.value = selected.name; modelLabel.htmlFor = select.id; modelLabel.append(select);
      const weightLabel = document.createElement('label'); weightLabel.textContent = '权重';
      const weight = document.createElement('input'); weight.id = `loraStrength${index}`; weight.type = 'number'; weight.min = '-100'; weight.max = '100'; weight.step = '0.01'; weight.value = selected.strength;
      bindNumberWheel(weight);
      weightLabel.htmlFor = weight.id; weightLabel.append(weight);
      select.addEventListener('change', () => { captureLoras(); formError(); });
      weight.addEventListener('input', () => { captureLoras(); formError(); });
      row.append(modelLabel, weightLabel); $('loraRows').append(row);
    }
    syncLoraControls();
  }

  async function loadLoras(refresh = false) {
    if (loraLoading || (loraCatalog && !refresh)) return;
    captureLoras(); loraLoading = true; syncLoraControls();
    const revision = engineRevision;
    $('loraMessage').textContent = '正在读取本机 LoRA 列表…';
    try {
      const catalog = await api('/api/loras' + (refresh ? '?refresh=1' : ''), {}, 30000);
      if (revision !== engineRevision) return;
      if (!Array.isArray(catalog.names)) throw new Error('LoRA 列表格式不正确，请重新运行启动创作台.cmd。');
      loraCatalog = catalog;
      $('loraMessage').textContent = !catalog.available ? '本机缺少 LoRA 加载节点，数量设为 0 可正常生成。' : catalog.names.length ? `已读取 ${catalog.names.length} 个本机 LoRA，可按需选择。` : '尚未找到 LoRA。将文件放入 ComfyUI 的 models/loras 后刷新列表。';
    } catch (error) { if (revision === engineRevision) $('loraMessage').textContent = errorMessage(error) + ' 数量设为 0 可继续使用原有生成流程。'; }
    finally { loraLoading = false; renderLoras(); }
  }

  function readLoras() {
    captureLoras();
    const count = Number($('loraCount').value);
    if (!count) return [];
    if (loraLoading || !loraCatalog?.available) throw new Error('请先读取可用的 LoRA 列表，或将接入数量设为 0。');
    const chosen = loraSelection.slice(0, count).map((item, index) => {
      if (!item?.name || !loraCatalog.names.includes(item.name)) throw new Error(`请选择第 ${index + 1} 个 LoRA，或减少接入数量。`);
      const strength = Number(item.strength);
      if (item.strength === '' || !Number.isFinite(strength) || strength < -100 || strength > 100) throw new Error(`第 ${index + 1} 个 LoRA 权重应为 -100 至 100。`);
      return { name: item.name, strength };
    });
    if (new Set(chosen.map(item => item.name)).size !== chosen.length) throw new Error('同一 LoRA 请只选择一次。');
    return chosen;
  }

  $('loraSettings').addEventListener('toggle', () => { if ($('loraSettings').open) loadLoras(); });
  $('loraCount').addEventListener('change', () => { captureLoras(); renderLoras(); formError(); if (Number($('loraCount').value)) loadLoras(); });
  $('refreshLoras').addEventListener('click', () => loadLoras(true));

  function readStorage(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function saveStorage(key, value) { try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* Private file mode can disable persistence. */ } }
  function errorMessage(error) { return error && error.message ? error.message : '操作未完成，请重试。'; }
  function imageUrl(url) { return new URL(url, base || location.href).href; }
  function formError(message = '') { $('generationFormError').textContent = message; $('generationFormError').hidden = !message; }

  async function api(route, options = {}, timeout = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(base + route, { ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new Error('生成服务返回了无效响应，请确认已通过“启动创作台.cmd”打开网页。'); }
      if (!response.ok) {
        const error = new Error(typeof data.error === 'string' ? data.error : data.message || `请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(apiEdition ? '连接创作台超时，请检查本机服务是否正在运行。' : '连接超时，请检查本机生成服务后重试。');
      if (error instanceof TypeError) throw new Error('无法连接本机生成服务。请运行“启动创作台.cmd”，再重新检查。');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function updateSubmit() {
    const mode = $('referenceMode').value;
    const hasPeople = !!references[0].file;
    const hasSecond = !!references[1].file;
    const sceneActive = hasSecond && mode === 'scene';
    const missingPrimary = hasSecond && mode !== 'scene' && !hasPeople;
    const hasSource = !!pose || !!costume || (sceneActive && hasPeople);
    const pairPose = /^pair/i.test(pose?.id || '');
    $('referenceRoleLabel2').textContent = mode === 'scene' ? '环境场景参考' : mode === 'same-character' ? '同一人物补充' : '第二位人物 · B';
    $('referenceUploadTitle2').textContent = mode === 'scene' ? '上传环境或场景' : mode === 'same-character' ? '上传同一人物的另一视角' : '上传第二位人物';
    if (!hasSecond) $('referenceName2').textContent = mode === 'scene' ? '只提供空间、背景、透视与光照' : mode === 'same-character' ? '补充人物1的外貌，不作为第二个角色' : '双人姿势中人物 B 的独立身份参考';
    $('referenceModeHint').textContent = mode === 'scene'
      ? '第二张只提供环境，不提供人物身份，也不增加角色。使用后自动采用场景图的空间与光照。'
      : mode === 'same-character'
        ? `第二张只补充人物1的外貌。${pairPose ? '当前是双人姿势；如需指定人物B，请选“第二位人物”。' : '不会作为另一个角色。'}`
        : pairPose ? '人物1绑定动作描述中的A，人物2绑定B；身份和穿着分别保留，不互换、不混合。' : '两张图分别对应两位人物；单人姿势应用于人物A，人物B自然加入同一场景。';
    $('promptHint').textContent = sceneActive
      ? `已采用环境参考模式：第二张只控制场景${hasPeople ? '，人物身份来自人物1' : '；请描述要生成的人物，或上传人物1'}${pose ? '，动作来自所选姿势' : ''}。场景图中的人物不作为第二位角色。`
      : pose && hasPeople
      ? `已采用角色动作模式：人物图锁定身份，姿势图控制动作${costume ? '，服装图提供穿搭' : ''}。多视图设定表只作为身份参考，不复制并排立绘。`
      : !pose && costume && hasPeople
      ? '已采用人物换装模式：以人物图为主体，服装图提供穿搭。未指定动作和机位时保留人物原有姿态；可在这里提出新的动作、场景或画风要求。'
      : '至少选择姿势或服装之一。所选参考与描述自动带入，在这里补充场景、画风或两位人物的安排。有可用人物图时可留空。';
    if (pose?.体系 === '上半身单人' || /^upper80v2_/i.test(pose?.id || '')) $('promptHint').textContent = '上半身取景已锁定：完整头部至腰部，保留手势，不为展示鞋袜或全套服装拉远镜头。' + $('promptHint').textContent;
    $('generateButton').disabled = busy || !serviceReady || !hasSource || missingPrimary || (!hasPeople && !$('generationPrompt').value.trim());
    $('generateButton').querySelector('span').textContent = busy ? '正在生成…' : '开始生成';
    $('generationSubmitHint').textContent = busy ? '生成时可继续浏览图库' : !hasSource ? '选择姿势或服装，也可上传人物1与环境图' : missingPrimary ? '先上传人物参考1，再接入第二位人物或补充图' : !hasPeople && !$('generationPrompt').value.trim() ? '上传人物参考1，或填写人物描述' : !serviceReady ? (apiEdition ? '配置生图 API 后即可开始' : '连接本机生成服务后即可开始') : `${!pose && !costume ? '人物' : ''}${pose ? '姿势' : ''}${pose && costume ? ' + ' : ''}${costume ? '服装' : ''}${sceneActive ? ' + 场景' : ''} · 图片保存到 output/`;
    $('keepBackground').disabled = busy || !hasPeople || sceneActive;
    $('keepBackgroundLabel').hidden = sceneActive;
    if (!hasPeople || sceneActive) $('keepBackground').checked = false;
    $('copyCamera').disabled = busy || !pose;
    for (const id of ['referenceName', 'referenceName2', 'selectedPoseName', 'selectedCostumeName', 'referenceModeHint', 'promptHint', 'generationSubmitHint']) $(id).title = $(id).textContent;
    $('referenceMode').title = $('referenceModeHint').textContent;
    $('previewPrompt').disabled = busy || previewLoading;
    invalidatePromptRecord();
  }

  function selectPose(item, scroll = true) {
    if (busy) { formError('请等待当前任务完成后再更换姿势。'); return; }
    if (!item || typeof item.id !== 'string' || !item.缩略图) return;
    pose = { id: item.id, 体系: item.体系, 姿势名称: item.姿势名称, 角度: item.角度, 缩略图: item.缩略图, 原图: item.原图, 姿势词条: window.POSE_DESCRIPTIONS ? window.POSE_DESCRIPTIONS.items?.[item.id] || null : item.姿势词条 || null };
    $('selectedPoseImage').src = pose.缩略图;
    $('selectedPoseImage').dataset.poseId = pose.id;
    $('selectedPoseImage').alt = `${pose.姿势名称} · ${pose.角度}`;
    $('selectedPoseImage').hidden = false;
    $('selectedPoseEmpty').hidden = true;
    $('selectedPoseName').textContent = `${pose.姿势名称} · ${pose.角度}`;
    $('removePose').hidden = false;
    renderSelectedPoseDescription();
    saveStorage(poseKey, pose);
    document.dispatchEvent(new CustomEvent('pose-selection-changed', { detail: pose }));
    formError();
    updateSubmit();
    if (scroll) {
      $('generationForm').scrollTo({ top: 0, behavior: 'instant' });
      $('generator').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      $('generatorTitle').focus({ preventScroll: true });
    }
  }

  $('removePose').addEventListener('click', () => {
    if (busy) return;
    pose = null;
    saveStorage(poseKey, null);
    $('selectedPoseImage').hidden = true;
    $('selectedPoseImage').removeAttribute('src');
    delete $('selectedPoseImage').dataset.poseId;
    $('selectedPoseEmpty').hidden = false;
    $('selectedPoseName').textContent = '在姿势卡片点击“选用此姿势”';
    $('removePose').hidden = true;
    renderSelectedPoseDescription();
    document.dispatchEvent(new CustomEvent('pose-selection-changed', { detail: null }));
    formError(); updateSubmit();
  });

  const loadCostumes = () => window.ReferenceLibraryData.costumes();

  function selectCostume(item) {
    costume = item;
    $('selectedCostumeImage').hidden = !item;
    $('selectedCostumeEmpty').hidden = !!item;
    $('removeCostume').hidden = !item;
    $('selectedCostumeOriginal').hidden = !item;
    $('selectedCostumeName').textContent = item ? item.中文描述 || item.服装名称 : '款式、颜色与配饰自动带入';
    if (item) {
      $('selectedCostumeImage').src = item.预览图;
      $('selectedCostumeImage').alt = item.服装名称;
      $('selectedCostumeOriginal').href = item.原图;
    } else {
      $('selectedCostumeImage').removeAttribute('src');
      $('selectedCostumeOriginal').removeAttribute('href');
    }
    saveStorage(costumeKey, item ? { id: item.id } : null);
    document.dispatchEvent(new CustomEvent('costume-selection-changed', { detail: item }));
    formError(); updateSubmit();
  }

  function openCostumeLibrary() {
    if (busy) return;
    document.dispatchEvent(new CustomEvent('library-open', { detail: 'costumes' }));
    $('galleryFilters').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
  $('chooseCostume').addEventListener('click', openCostumeLibrary);
  $('selectedCostumePreview').addEventListener('click', openCostumeLibrary);
  $('removeCostume').addEventListener('click', () => { if (!busy) selectCostume(null); });
  document.addEventListener('costume-selected', event => {
    if (busy) { formError('请等待当前任务完成后再更换服装。'); return; }
    selectCostume(event.detail);
    $('generator').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    $('generatorTitle').focus({ preventScroll: true });
  });

  function renderSelectedPoseDescription() {
    const entry = pose?.姿势词条;
    $('selectedPoseDescription').hidden = !pose;
    $('selectedPoseDescriptionText').textContent = entry?.动作描述 || '这张图片的姿势描述尚未生成，仍可使用原图生成。';
    $('selectedPoseDescriptionView').textContent = entry?.视角描述 ? `视角：${entry.视角描述}` : '';
    $('selectedPoseDescriptionView').hidden = !entry?.视角描述;
    $('selectedPoseAutoHint').textContent = entry?.动作描述
      ? `动作描述会自动加入生图提示词，无需复制。${$('copyCamera').checked ? '视角描述也会一并带入。' : '已关闭拍摄视角，机位按你的画面要求生成。'}`
      : '生成时自动使用姿势原图和动作短名。';
    if (pose?.体系 === '上半身单人' || /^upper80v2_/i.test(pose?.id || '')) $('selectedPoseAutoHint').textContent += ' 上半身取景固定；关闭拍摄视角只改变机位，不生成全身。';
    $('copySelectedPoseDescription').disabled = !entry?.动作描述;
    $('copySelectedPoseDescription').textContent = '复制描述';
  }

  $('copySelectedPoseDescription').addEventListener('click', async () => {
    const entry = pose?.姿势词条;
    if (!entry?.动作描述) return;
    const text = [entry.动作描述, entry.视角描述 ? `视角：${entry.视角描述}` : '', Array.isArray(entry.关键词) && entry.关键词.length ? `关键词：${entry.关键词.join('、')}` : ''].filter(Boolean).join('\n');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text;
        field.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('复制不可用');
      }
      $('copySelectedPoseDescription').textContent = '已复制';
    } catch { $('copySelectedPoseDescription').textContent = '请手动选择文字复制'; }
  });

  document.addEventListener('pose-descriptions-ready', event => {
    if (!pose) return;
    pose.姿势词条 = event.detail?.items?.[pose.id] || null;
    renderSelectedPoseDescription();
    saveStorage(poseKey, pose);
  });

  function setReference(file, index = 0) {
    if (busy) { formError('请等待当前生成完成，再更换参考图。'); return; }
    if (file && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { formError('请选择 PNG、JPG 或 WebP 图片。'); return; }
    if (file && file.size > 20 * 1024 * 1024) { formError('图片超过 20 MB，请缩小后上传。'); return; }
    const ref = references[index];
    if (ref.objectUrl) URL.revokeObjectURL(ref.objectUrl);
    ref.file = file; ref.id = ''; ref.objectUrl = file ? URL.createObjectURL(file) : '';
    refElement('referencePreview', index).hidden = !file;
    refElement('referencePlaceholder', index).hidden = !!file;
    refElement('removeReference', index).hidden = !file;
    refElement('referenceName', index).textContent = file ? file.name : index ? '上传第二位人物或环境参考' : '主要人物的面容与发型';
    if (file) refElement('referencePreview', index).src = ref.objectUrl;
    else { refElement('referencePreview', index).removeAttribute('src'); refElement('referenceFile', index).value = ''; }
    formError();
    updateSubmit();
  }

  async function checkConnection() {
    if (connectionChecking) return;
    connectionChecking = true;
    const revision = engineRevision;
    $('recheckConnection').disabled = true;
    $('connectionMessage').textContent = apiEdition ? '正在读取 API 配置…' : '正在连接本机生成服务…';
    $('generationConnection').classList.remove('is-ready', 'is-error');
    try {
      const status = await api('/api/status?refresh=1');
      if (revision !== engineRevision) return;
      serviceReady = !!status.connected && !!status.ready;
      $('generationConnection').classList.add(serviceReady ? 'is-ready' : 'is-error');
      $('connectionMessage').textContent = apiEdition
        ? status.message || (serviceReady ? 'API 配置已就绪，可以提交生成。' : '请先填写生图 API 设置。')
        : serviceReady ? '本机已连接 · Qwen-Image 2.1 标准版就绪' : status.message || (status.connected ? '模型尚未就绪，请检查本机配置。' : 'ComfyUI 未连接，请先启动 ComfyUI。');
      if (apiEdition) {
        $('generationStartHelp').hidden = serviceReady;
        $('generationStartHelp').textContent = '点击右上方“生图 API 设置”，填写接口地址、API Key 和模型名称。';
        const model = typeof status.model === 'string' ? status.model : status.model?.name;
        $('generationModelLabel').textContent = model || '外接生图 API';
        $('generationModelLabel').title = model || '外接生图 API';
        $('apiSizeHint').textContent = status.sizeMode === 'selected' ? '请求尺寸：竖图 1024 × 1536，横图 1536 × 1024，方图 1024 × 1024。模型需支持所选尺寸。' : '比例作为画面要求写入提示词；输出尺寸由服务商自动决定。';
        return;
      }
      $('generationStartHelp').hidden = !!status.connected;
      if (status.missing && status.missing.length) $('generationStartHelp').textContent = `缺少：${status.missing.join('、')}。请补齐模型后重新检查。`;
      else $('generationStartHelp').textContent = '请双击项目目录中的“启动创作台.cmd”，再点击重新检查。';
      if (status.missing && status.missing.length) $('generationStartHelp').hidden = false;
    } catch (error) {
      if (revision !== engineRevision) return;
      serviceReady = false;
      $('generationConnection').classList.add('is-error');
      $('connectionMessage').textContent = errorMessage(error);
      $('generationStartHelp').textContent = apiEdition ? '请双击整合包中的“启动创作台.cmd”，再点击重新检查。' : '请双击项目目录中的“启动创作台.cmd”，再点击重新检查。';
      $('generationStartHelp').hidden = false;
    } finally {
      connectionChecking = false;
      $('recheckConnection').disabled = false;
      updateSubmit();
      if (revision !== engineRevision) checkConnection();
    }
  }

  function setBusy(value) {
    busy = value;
    if (retrySaveButton) retrySaveButton.disabled = value;
    for (const id of ['referenceFile', 'referenceFile2', 'referenceMode', 'generationPrompt', 'copyCamera', 'generationSize', 'generationSteps', 'generationSeed', 'removeReference', 'removeReference2', 'removePose', 'chooseCostume', 'selectedCostumePreview', 'removeCostume']) $(id).disabled = value;
    $('generationJobOverlay').hidden = !value;
    syncLoraControls();
    updateSubmit();
    document.dispatchEvent(new CustomEvent('generation-busy-changed', { detail: value }));
  }

  function showJob(title, detail, progress) {
    $('generationJobTitle').textContent = title;
    $('generationJobDetail').textContent = detail;
    const bar = $('generationProgress');
    if (progress && Number(progress.max) > 0) { bar.max = Number(progress.max); bar.value = Math.min(Number(progress.value) || 0, bar.max); }
    else bar.removeAttribute('value');
    $('generationJobStatus').classList.remove('is-error');
    $('generationJobStatus').textContent = `${title} · ${detail}`;
  }

  function finishJob(data) {
    clearTimeout(pollTimer);
    const image = data.images && data.images[0];
    if (!image || !image.url) { failJob(apiEdition ? '任务已结束，但没有返回图片。请检查 API 的响应格式。' : '任务已结束，但没有返回图片。请检查 ComfyUI 中的任务记录。'); return; }
    resultUrl = imageUrl(image.url);
    $('generationResultImage').src = resultUrl;
    $('generationResultImage').hidden = false;
    $('generationResultEmpty').hidden = true;
    $('generationResultActions').hidden = false;
    $('downloadGenerated').href = resultUrl + (resultUrl.includes('?') ? '&' : '?') + 'download=1';
    $('downloadGenerated').download = image.filename || 'pose-atlas-qwen-image.png';
    $('openGenerated').href = resultUrl;
    $('generationResultMeta').textContent = apiEdition ? 'API 生成' : `种子 ${data.seed ?? job?.seed ?? '—'}`;
    $('generationJobStatus').classList.remove('is-error');
    $('generationJobStatus').textContent = image.savedTo ? `生成完成，已保存到 ${image.savedTo}。可下载或用作人物参考。` : '生成完成。可下载图片，或把结果用作下一次的人物参考。';
    saveStorage(storageKey, null);
    job = null;
    setBusy(false);
  }

  function failJob(message, data = null) {
    clearTimeout(pollTimer);
    $('generationJobStatus').classList.add('is-error');
    $('generationJobStatus').textContent = message;
    retryQuery = !!data?.retryQuery;
    retrySaveId = data?.retrySave || retryQuery ? data.promptId || job?.promptId || '' : '';
    if (retrySaveButton) { retrySaveButton.hidden = !retrySaveId; retrySaveButton.textContent = retryQuery ? '重新查询生成结果' : '重试保存图片'; }
    saveStorage(storageKey, retrySaveId ? { promptId: retrySaveId, createdAt: Date.now() } : null);
    job = null;
    setBusy(false);
  }

  async function pollJob() {
    if (!job) return;
    const currentId = job.promptId;
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(currentId)}`);
      if (job?.promptId !== currentId) return;
      pollFailures = 0;
      if (data.status === 'completed') { finishJob(data); return; }
      if (data.status === 'error') { failJob(typeof data.error === 'string' ? data.error : apiEdition ? '生成失败，请检查 API 设置后重试。' : '生成失败，请检查 ComfyUI 状态后重试。', data); return; }
      if (data.status === 'queued') showJob('任务排队中', Number(data.queuePosition) > 0 ? `前方还有 ${data.queuePosition} 个任务，轮到后会自动开始。` : apiEdition ? '正在等待 API 开始处理。' : '正在等待本机开始生成。', null);
      else showJob('正在生成', apiEdition && data.providerTaskId
        ? `服务商任务 ${data.providerTaskId} · ${data.error ? '查询暂未连通，正在继续查询原任务，无需重新生成。' : '正在查询生成结果，完成后自动保存。'}`
        : data.progress && Number(data.progress.max) > 0 ? `采样进度 ${data.progress.value} / ${data.progress.max}` : apiEdition ? 'API 正在处理图片，返回结果后会自动保存。' : '首次加载模型可能需要几分钟，请保持本机 ComfyUI 运行。', data.progress);
      pollTimer = setTimeout(pollJob, 1800);
    } catch (error) {
      if (job?.promptId !== currentId) return;
      if (error.status === 404 || error.status === 410) { failJob(errorMessage(error)); return; }
      pollFailures++;
      showJob('正在重新连接', apiEdition ? '正在恢复任务状态，连接恢复后会自动显示结果。' : '任务可能仍在本机运行，恢复连接后会自动显示结果。', null);
      $('generationJobStatus').textContent = `${errorMessage(error)} 正在自动重试，无需重复提交。`;
      pollTimer = setTimeout(pollJob, Math.min(10000, 2000 + pollFailures * 1000));
    }
  }

  $('generationForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const selectedReferences = references.filter(ref => ref.file);
    if (!serviceReady) { formError(apiEdition ? '请先配置生图 API。' : '请先连接本机生成服务。'); checkConnection(); return; }
    let payload;
    try { payload = readGenerationPayload(); }
    catch (error) { formError(errorMessage(error)); if (/LoRA/.test(errorMessage(error))) $('loraSettings').open = true; return; }
    const key = promptSelectionKey();
    formError();
    if (retrySaveButton) retrySaveButton.hidden = true;
    retrySaveId = '';
    setBusy(true);
    showJob('正在提交', selectedReferences.length ? `上传 ${selectedReferences.length} 张参考图，准备所选参考。` : '准备所选参考图和画面描述。', null);
    try {
      for (const ref of selectedReferences) {
        if (ref.id) continue;
        const uploaded = await api('/api/reference', { method: 'POST', headers: { 'Content-Type': ref.file.type }, body: ref.file }, 60000);
        ref.id = uploaded.referenceId;
      }
      payload.referenceIds = selectedReferences.map(ref => ref.id);
      const created = await api('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 60000);
      if (!created.promptId) throw new Error(apiEdition ? '生成服务没有返回任务编号，请检查本机服务日志后重试。' : '生成服务没有返回任务编号，请检查 ComfyUI 后重试。');
      if (created.promptRecord && key === promptSelectionKey()) showPromptRecord(created.promptRecord, key, '这是本次生成实际提交的提示词。');
      job = { promptId: created.promptId, seed: created.seed, createdAt: Date.now() };
      pollFailures = 0;
      saveStorage(storageKey, job);
      pollJob();
    } catch (error) {
      setBusy(false);
      formError(errorMessage(error));
      $('generationJobStatus').textContent = '任务未提交成功，请按提示检查后重试。';
      $('generationJobStatus').classList.add('is-error');
    }
  });

  document.addEventListener('pose-selected', event => selectPose(event.detail));
  references.forEach((ref, index) => {
    refElement('referenceFile', index).addEventListener('change', event => setReference(event.target.files[0] || null, index));
    refElement('removeReference', index).addEventListener('click', () => setReference(null, index));
    const drop = refElement('referenceDrop', index);
    ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); if (!busy) drop.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-dragging'); }));
    drop.addEventListener('drop', event => { if (event.dataTransfer.files[0]) setReference(event.dataTransfer.files[0], index); });
  });
  document.querySelectorAll('#generationForm input[type=number]').forEach(bindNumberWheel);
  $('generationPrompt').addEventListener('input', () => { formError(); updateSubmit(); });
  $('referenceMode').addEventListener('change', () => { formError(); updateSubmit(); });
  $('copyCamera').addEventListener('change', renderSelectedPoseDescription);
  $('generationForm').addEventListener('input', invalidatePromptRecord);
  $('generationForm').addEventListener('change', invalidatePromptRecord);
  $('recheckConnection').addEventListener('click', checkConnection);
  function connectionSettingsChanged() {
    engineRevision++;
    serviceReady = false;
    references.forEach(reference => { reference.id = ''; });
    loraCatalog = null; loraSelection.length = 0; $('loraCount').value = '0'; renderLoras();
    updateSubmit();
    checkConnection();
  }
  document.addEventListener('local-engine-changed', connectionSettingsChanged);
  document.addEventListener('image-api-changed', connectionSettingsChanged);
  document.addEventListener('local-engine-ready', checkConnection);
  $('reuseGenerated').addEventListener('click', async () => {
    if (!resultUrl || busy) return;
    $('reuseGenerated').disabled = true;
    try {
      const response = await fetch(resultUrl);
      if (!response.ok) throw new Error('无法读取结果图片，请下载后手动上传。');
      const blob = await response.blob();
      const mime = blob.type.split(';')[0] || 'image/png';
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
      setReference(new File([blob], `生成结果.${ext}`, { type: mime }));
      $('referenceDrop').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) { formError(errorMessage(error)); }
    finally { $('reuseGenerated').disabled = false; }
  });
  $('generationResultImage').addEventListener('error', () => {
    $('generationJobStatus').textContent = '图片预览未能加载，可点击“查看原图”重试。';
    $('generationJobStatus').classList.add('is-error');
  });
  const storedPose = readStorage(poseKey);
  if (storedPose) selectPose(storedPose, false);
  const storedCostume = readStorage(costumeKey);
  if (storedCostume?.id) loadCostumes().then(items => selectCostume(items.find(item => item.id === storedCostume.id) || null)).catch(() => {});
  const storedJob = readStorage(storageKey);
  if (storedJob && /^[a-zA-Z0-9-]+$/.test(storedJob.promptId || '')) {
    job = storedJob;
    setBusy(true);
    showJob('恢复生成任务', '正在查询上次提交的任务。', null);
    pollJob();
  }
  checkConnection();
  updateSubmit();
})();
