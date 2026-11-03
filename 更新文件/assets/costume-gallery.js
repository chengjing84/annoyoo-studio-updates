(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const format = value => Number(value).toLocaleString('zh-CN');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const state = { category: '', query: '', view: 'detail', shown: 60 };
  let items = [];
  let filtered = [];
  let selectedId = '';
  let loaded = false;
  let library = 'poses';
  let viewerIndex = 0;
  let imageToken = 0;
  let returnFocus;
  const inertElements = new Map();
  const viewer = $('costumeViewer');

  function switchLibrary(kind, scroll = false) {
    if (!['poses', 'costumes'].includes(kind)) return;
    library = kind;
    const clothing = kind === 'costumes';
    for (const id of ['lineTabs', 'poseFilterControls', 'poseGalleryPanel']) $(id).hidden = clothing;
    for (const id of ['costumeTabs', 'costumeFilterControls', 'costumeGalleryPanel']) $(id).hidden = !clothing;
    for (const button of document.querySelectorAll('.library-tab')) {
      const active = button.dataset.library === kind;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    try { localStorage.setItem('reference-library-kind-v1', kind); } catch {}
    if (clothing && !loaded) load();
    if (scroll) window.scrollTo({ top: Math.max(0, document.querySelector('main').offsetTop - $('galleryFilters').offsetHeight), behavior: 'instant' });
  }

  document.querySelectorAll('.library-tab').forEach(button => {
    button.addEventListener('click', () => switchLibrary(button.dataset.library, true));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const kind = event.key === 'Home' ? 'poses' : event.key === 'End' ? 'costumes' : library === 'poses' ? 'costumes' : 'poses';
      switchLibrary(kind, true);
      $(kind === 'poses' ? 'libraryPoses' : 'libraryCostumes').focus();
    });
  });
  document.querySelectorAll('[data-open-library]').forEach(link => link.addEventListener('click', () => switchLibrary(link.dataset.openLibrary)));
  document.addEventListener('library-open', event => switchLibrary(event.detail));

  function renderCategories() {
    const categories = [...new Set(items.map(item => item.分类))];
    $('costumeTabs').innerHTML = ['', ...categories].map(category => {
      const count = category ? items.filter(item => item.分类 === category).length : items.length;
      return `<button class="line-tab" type="button" data-category="${escape(category)}" aria-pressed="${state.category === category}" aria-selected="${state.category === category}"><span class="tab-name">${category || '全部服装'}</span><span class="tab-count">${format(count)} 套</span></button>`;
    }).join('');
    $('costumeCategory').innerHTML = '<option value="">全部分类</option>' + categories.map(category => `<option value="${escape(category)}">${escape(category)}</option>`).join('');
  }

  function card(item, index) {
    return `<article class="wardrobe-card${selectedId === item.id ? ' is-selected' : ''}" data-id="${escape(item.id)}"><button class="wardrobe-preview" type="button" data-open="${index}" aria-label="查看${escape(item.服装名称)}大图"><img src="${escape(item.缩略图)}" alt="${escape(item.服装名称)}" loading="lazy" decoding="async"><span class="image-top"><span class="pose-no">${escape(item.id)}</span><span class="angle-tag">${escape(item.分类)}</span></span><span class="zoom-hint">↗</span></button><div class="wardrobe-body"><button type="button" class="wardrobe-title" data-open="${index}">${escape(item.服装名称)}</button><p class="wardrobe-description">${escape(item.中文描述)}</p><p class="wardrobe-meta"><span>${escape(item.分类)}</span><span>PNG 原图</span></p></div><button class="wardrobe-select" type="button" data-select="${index}" aria-pressed="${selectedId === item.id}">${selectedId === item.id ? '已选为服装参考' : '选用这套服装'}</button></article>`;
  }

  function render(append = false) {
    const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = items.filter(item => (!state.category || item.分类 === state.category) && terms.every(term => item._search.includes(term)));
    const grid = $('costumeGrid');
    const start = append ? grid.querySelectorAll('.wardrobe-card').length : 0;
    if (!append) grid.replaceChildren();
    grid.insertAdjacentHTML('beforeend', filtered.slice(start, state.shown).map((item, index) => card(item, start + index)).join(''));
    grid.classList.toggle('is-compact', state.view === 'compact');
    grid.setAttribute('aria-busy', 'false');
    $('costumeCount').textContent = `${format(filtered.length)} 套服装`;
    $('costumeVisibleCount').textContent = `已显示 ${format(Math.min(state.shown, filtered.length))} / ${format(filtered.length)} 套`;
    $('costumeMore').hidden = state.shown >= filtered.length;
    $('costumeMore').textContent = `加载更多服装（剩余 ${format(Math.max(0, filtered.length - state.shown))} 套）`;
    $('costumeSearchClear').hidden = !state.query;
    $('costumeCategory').value = state.category;
    $('costumeFilterBadge').textContent = Number(!!state.category) + Number(state.view === 'compact') || '';
    document.querySelectorAll('#costumeTabs button').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.category === state.category));
      button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    });
    document.querySelectorAll('#costumeViewFilter button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
    $('costumeActiveFilters').innerHTML = [state.category && ['category', `分类：${state.category}`], state.query && ['query', `搜索：${state.query}`]].filter(Boolean).map(([key, label]) => `<button type="button" class="filter-chip" data-clear="${key}">${escape(label)}</button>`).join('');
    if (!filtered.length) grid.innerHTML = '<div class="empty"><h3>没有找到匹配的服装</h3><p>试试其他关键词，或减少筛选条件。</p><button type="button" data-reset>清除全部筛选</button></div>';
  }

  let loading;
  async function load() {
    if (loaded || loading) return loading;
    loading = window.ReferenceLibraryData.costumes().then(data => {
      items = data.map(item => ({ ...item, _search: `${item.检索} ${item.服装名称} ${item.中文描述} ${item.英文关键词} ${item.id}`.toLowerCase() }));
      loaded = true;
      renderCategories(); render();
    }).catch(() => {
      $('costumeCount').textContent = '服装库读取失败';
      $('costumeGrid').setAttribute('aria-busy', 'false');
      $('costumeGrid').innerHTML = '<div class="empty"><h3>无法读取服装数据</h3><p>请确认 data 与 costume 文件夹完整，再重新加载。</p><button type="button" data-retry>重新加载</button></div>';
    }).finally(() => { loading = null; });
    return loading;
  }

  function reset() {
    state.category = ''; state.query = ''; state.view = 'detail'; state.shown = 60;
    $('costumeSearch').value = '';
    render();
  }
  function choose(item) {
    document.dispatchEvent(new CustomEvent('costume-selected', { detail: item }));
  }
  $('costumeTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-category]'); if (!button) return;
    state.category = button.dataset.category; state.shown = 60; render();
  });
  $('costumeCategory').addEventListener('change', event => { state.category = event.target.value; state.shown = 60; render(); });
  $('costumeSearch').addEventListener('input', event => { state.query = event.target.value.trim(); state.shown = 60; render(); });
  $('costumeSearchClear').addEventListener('click', () => { state.query = ''; $('costumeSearch').value = ''; state.shown = 60; render(); $('costumeSearch').focus(); });
  $('costumeViewFilter').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) { state.view = button.dataset.view; render(); } });
  $('costumeReset').addEventListener('click', reset);
  $('costumeMore').addEventListener('click', () => { state.shown += 60; render(true); });
  $('costumeFilterToggle').addEventListener('click', () => { const open = $('costumeFilterPanel').classList.toggle('open'); $('costumeFilterToggle').setAttribute('aria-expanded', String(open)); });
  $('costumeActiveFilters').addEventListener('click', event => {
    const button = event.target.closest('[data-clear]'); if (!button) return;
    state[button.dataset.clear] = ''; $('costumeSearch').value = state.query; state.shown = 60; render();
  });
  $('costumeGrid').addEventListener('click', event => {
    if (event.target.closest('[data-retry]')) { load(); return; }
    if (event.target.closest('[data-reset]')) { reset(); return; }
    const preview = event.target.closest('[data-open]');
    if (preview) { openViewer(Number(preview.dataset.open)); return; }
    const select = event.target.closest('[data-select]');
    if (select) choose(filtered[Number(select.dataset.select)]);
  });
  document.addEventListener('costume-selection-changed', event => {
    selectedId = event.detail?.id || '';
    document.querySelectorAll('.wardrobe-card').forEach(card => {
      const selected = card.dataset.id === selectedId;
      card.classList.toggle('is-selected', selected);
      const button = card.querySelector('.wardrobe-select');
      button.setAttribute('aria-pressed', String(selected));
      button.textContent = selected ? '已选为服装参考' : '选用这套服装';
    });
  });

  function openViewer(index) {
    if (!filtered[index]) return;
    viewerIndex = index; returnFocus = document.activeElement;
    viewer.hidden = false; document.body.classList.add('viewer-open');
    for (const element of document.body.children) {
      if (element !== viewer && element.tagName !== 'SCRIPT') { inertElements.set(element, element.inert); element.inert = true; }
    }
    showViewer(); $('costumeViewerClose').focus({ preventScroll: true });
  }
  function closeViewer() {
    if (viewer.hidden) return;
    imageToken++; viewer.hidden = true; document.body.classList.remove('viewer-open');
    for (const [element, wasInert] of inertElements) element.inert = wasInert;
    inertElements.clear();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function showViewer() {
    const item = filtered[viewerIndex];
    const token = ++imageToken;
    const image = $('costumeViewerImage');
    image.src = item.缩略图; image.alt = item.服装名称;
    $('costumeViewerTitle').textContent = item.服装名称;
    $('costumeViewerCategory').textContent = item.分类;
    $('costumeViewerPosition').textContent = `${viewerIndex + 1} / ${filtered.length}`;
    $('costumeViewerId').textContent = item.id;
    $('costumeViewerDescription').textContent = item.中文描述;
    $('costumeViewerEnglish').textContent = item.英文关键词;
    $('costumeViewerKeywords').innerHTML = (item.关键词 || []).map(word => `<span>${escape(word)}</span>`).join('');
    $('costumeViewerMeta').innerHTML = `<dt>服装分类</dt><dd>${escape(item.分类)}</dd><dt>图片规格</dt><dd id="costumeImageDimensions">正在读取原图…</dd>`;
    $('copyCostumeId').textContent = '复制 ID'; $('copyCostumeDescription').textContent = '复制描述';
    $('downloadCostume').href = item.原图; $('downloadCostume').download = item.id + '.png';
    $('openCostumeOriginal').href = item.原图;
    $('costumePrev').disabled = viewerIndex === 0;
    $('costumeNext').disabled = viewerIndex === filtered.length - 1;
    $('costumeImageStatus').hidden = false; $('costumeImageStatus').textContent = '正在加载原图…';
    let fullLoaded = false;
    const preview = new Image();
    preview.onload = () => { if (token === imageToken && !fullLoaded) image.src = item.预览图; };
    preview.src = item.预览图;
    const full = new Image();
    full.onload = () => {
      if (token !== imageToken) return;
      fullLoaded = true; image.src = item.原图; $('costumeImageStatus').hidden = true;
      $('costumeImageDimensions').textContent = `${full.naturalWidth} × ${full.naturalHeight} PNG`;
    };
    full.onerror = () => { if (token === imageToken) { $('costumeImageStatus').textContent = '原图读取失败，可在新窗口重试'; $('costumeImageDimensions').textContent = 'PNG 原图暂不可用'; } };
    full.src = item.原图;
  }
  function step(direction) {
    const next = viewerIndex + direction;
    if (next < 0 || next >= filtered.length) return;
    viewerIndex = next; showViewer();
  }
  $('costumePrev').addEventListener('click', () => step(-1));
  $('costumeNext').addEventListener('click', () => step(1));
  $('costumeViewerClose').addEventListener('click', closeViewer);
  viewer.addEventListener('click', event => { if (event.target === viewer) closeViewer(); });
  $('useCostumeForGeneration').addEventListener('click', () => { const item = filtered[viewerIndex]; closeViewer(); choose(item); });
  async function copy(text, button) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea'); field.value = text;
        field.style.cssText = 'position:fixed;opacity:0'; viewer.append(field); field.select();
        const success = document.execCommand('copy'); field.remove();
        if (!success) throw new Error('copy failed');
      }
      button.textContent = '已复制';
    } catch { button.textContent = '请手动选择文字复制'; }
  }
  $('copyCostumeId').addEventListener('click', event => copy(filtered[viewerIndex].id, event.currentTarget));
  $('copyCostumeDescription').addEventListener('click', event => copy(filtered[viewerIndex].中文描述, event.currentTarget));
  let touch;
  $('costumeViewerStage').addEventListener('touchstart', event => { touch = event.touches.length === 1 ? event.touches[0] : null; }, { passive: true });
  $('costumeViewerStage').addEventListener('touchend', event => {
    if (!touch || event.target.closest('button')) return;
    const end = event.changedTouches[0]; const dx = end.clientX - touch.clientX; const dy = end.clientY - touch.clientY;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    touch = null;
  }, { passive: true });
  document.addEventListener('keydown', event => {
    if (!viewer.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); step(['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1); }
      if (event.key === 'Tab') {
        const elements = [...viewer.querySelectorAll('button:not(:disabled),a[href]')]; const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }
    if (library === 'costumes' && event.key === '/' && !event.target.closest('input,textarea,select,[contenteditable=true]') && !document.querySelector('dialog[open]')) { event.preventDefault(); $('costumeSearch').focus(); }
  });
  try {
    selectedId = JSON.parse(localStorage.getItem('pose-atlas-selected-costume-v1') || 'null')?.id || '';
    switchLibrary(location.hash === '#costumes' ? 'costumes' : location.hash === '#poses' ? 'poses' : localStorage.getItem('reference-library-kind-v1') || 'poses');
  } catch { switchLibrary('poses'); }
  load();
})();
