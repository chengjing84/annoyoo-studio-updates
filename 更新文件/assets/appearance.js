(() => {
  'use strict';
  const storageKey = 'pose-atlas-appearance-v1';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  let preference = 'system';
  try { preference = valid(localStorage.getItem(storageKey)); } catch {}
  let trigger, menu;
  const labels = { light: '日间', dark: '夜间', system: '跟随系统' };
  const paths = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20.8 13A8.8 8.8 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>'
  };
  const icon = value => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[value]}</svg>`;
  function apply() {
    const resolved = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0a0d12' : '#ffffff');
    if (!trigger) return;
    trigger.innerHTML = `${icon(preference)}<span>${preference === 'system' ? '自动' : labels[preference]}</span>`;
    trigger.setAttribute('aria-label', `切换外观，当前${labels[preference]}${preference === 'system' ? `（${labels[resolved]}）` : ''}`);
    trigger.title = `外观：${labels[preference]}`;
    menu.querySelectorAll('[data-appearance]').forEach(button => {
      const selected = button.dataset.appearance === preference;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }
  // This script runs before styles load, so a saved dark theme never flashes white.
  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  addEventListener('storage', event => { if (event.key === storageKey || event.key === null) { preference = valid(event.newValue); apply(); } });
  function initialize() {
    const host = document.getElementById('appearanceControls');
    if (!host) return;
    trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'appearance-trigger'; trigger.id = 'appearanceTrigger';
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', 'appearanceMenu');
    menu = document.createElement('div'); menu.id = 'appearanceMenu'; menu.className = 'appearance-menu';
    menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '外观模式');
    menu.innerHTML = `<p class="appearance-menu-title" aria-hidden="true">外观模式</p>${['light', 'dark', 'system'].map(value => `<button type="button" role="menuitemradio" data-appearance="${value}" aria-checked="false" tabindex="-1">${icon(value)}<span>${labels[value]}</span><svg class="appearance-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>`).join('')}`;
    host.append(trigger); document.body.append(menu);
    const native = typeof menu.showPopover === 'function';
    if (native) trigger.setAttribute('popovertarget', menu.id);
    function position() {
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(innerWidth - 204, rect.right - 196))}px`;
      menu.style.top = `${Math.max(8, Math.min(innerHeight - 196, rect.bottom + 8))}px`;
    }
    function close() {
      if (native) menu.hidePopover(); else menu.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function opened() {
      position(); trigger.setAttribute('aria-expanded', 'true');
      if (!menu.contains(document.activeElement)) menu.querySelector(`[data-appearance="${preference}"]`).focus({ preventScroll: true });
    }
    if (native) menu.addEventListener('toggle', event => { if (event.newState === 'open') opened(); else trigger.setAttribute('aria-expanded', 'false'); });
    else trigger.addEventListener('click', () => { if (menu.classList.contains('is-open')) close(); else { menu.classList.add('is-open'); opened(); } });
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-appearance]'); if (!button) return;
      preference = valid(button.dataset.appearance);
      try { localStorage.setItem(storageKey, preference); } catch {}
      apply(); close(); trigger.focus({ preventScroll: true });
    });
    menu.addEventListener('keydown', event => {
      const buttons = [...menu.querySelectorAll('[data-appearance]')];
      const index = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      } else if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus({ preventScroll: true }); }
    });
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (native) menu.showPopover(); else menu.classList.add('is-open'); opened(); }
    });
    document.addEventListener('pointerdown', event => { if (!native && !menu.contains(event.target) && !trigger.contains(event.target)) close(); });
    addEventListener('resize', position);
    document.addEventListener('scroll', () => { if (trigger.getAttribute('aria-expanded') === 'true') close(); }, { passive: true });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
