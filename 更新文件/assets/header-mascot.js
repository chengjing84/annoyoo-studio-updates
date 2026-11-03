(() => {
  'use strict';
  const stage = document.getElementById('yoyoPlayground');
  const mascot = document.getElementById('yoyoMascot');
  if (!stage || !mascot) return;
  const sprite = mascot.querySelector('.yoyo-sprite');
  const dreams = stage.querySelector('.yoyo-sleep-marks');
  const dreamDots = dreams.querySelectorAll('i');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const random = (min, max) => min + Math.random() * (max - min);
  let ready = false, visible = true, pinned = false, hovered = false, focused = false;
  let initialized = false, x = 0, target = 0, limit = 0, facing = 1;
  let state = 'sitting', elapsed = 0, stateStarted = 0, restUntil = 0;
  let lastTime = 0, raf = 0, lastFrame = -1;
  let previouslyActive = null;

  function setState(next, duration = 0) {
    state = next; stateStarted = elapsed; restUntil = elapsed + duration;
    stage.dataset.state = next;
  }
  function startRun() {
    if (limit < 12 || reducedMotion.matches || pinned || hovered || focused) {
      setState(pinned ? 'sleeping' : 'sitting', 5000); return;
    }
    // Short trips mixed with longer crossings keep the mascot from pacing on
    // a predictable loop. Stay fully inside the gap, clear of all navigation.
    const distance = Math.min(limit, random(140, 330));
    const direction = x < limit * .22 ? 1 : x > limit * .78 ? -1 : Math.random() < .5 ? -1 : 1;
    target = Math.max(0, Math.min(limit, x + direction * distance));
    facing = target >= x ? 1 : -1;
    setState('running');
  }
  function measure() {
    limit = Math.max(0, stage.clientWidth - mascot.offsetWidth);
    if (!initialized && limit > 0) {
      x = limit * .28; initialized = true;
      startRun();
    } else {
      x = Math.min(limit, x); target = Math.min(limit, target);
    }
    paint();
  }
  function paint() {
    mascot.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
    // The supplied atlas faces left; mirror it when travelling right.
    sprite.style.setProperty('--yoyo-facing', -facing);
    dreams.style.transform = `translate3d(${(x + mascot.offsetWidth * .74).toFixed(2)}px,0,0)`;
    const age = elapsed - stateStarted;
    let frame;
    if (state === 'running') frame = Math.floor(age / 85) % 8;
    else if (state === 'sleeping') frame = 12 + (reducedMotion.matches ? 0 : Math.floor(age / 420) % 4);
    else {
      const blink = Math.floor(age % 4600 / 110);
      frame = reducedMotion.matches ? 8 : blink === 29 || blink === 31 ? 9 : blink === 30 ? 10 : age % 2500 < 1250 ? 8 : 11;
    }
    if (frame !== lastFrame) {
      sprite.style.backgroundPosition = `${(frame % 4) * 100 / 3}% ${Math.floor(frame / 4) * 100 / 3}%`;
      lastFrame = frame;
    }
  }
  function tick(time) {
    raf = 0;
    const delta = lastTime ? Math.min(64, time - lastTime) : 0;
    lastTime = time; elapsed += delta;
    if (state === 'running') {
      const step = delta * .062;
      if (Math.abs(target - x) <= step) {
        x = target;
        const sleep = Math.random() < .3;
        setState(sleep ? 'sleeping' : 'sitting', sleep ? random(8000, 13000) : random(2200, 4600));
      } else x += Math.sign(target - x) * step;
    } else if (!pinned && !hovered && !focused && elapsed >= restUntil) startRun();
    paint(); schedule();
  }
  function schedule() {
    const active = ready && visible && !document.hidden && !reducedMotion.matches;
    if (active !== previouslyActive) {
      stage.classList.toggle('is-paused', !active);
      dreamDots.forEach(dot => { dot.style.animationPlayState = active ? 'running' : 'paused'; });
      previouslyActive = active;
    }
    if (active && !raf) raf = requestAnimationFrame(tick);
    else if (!active) { cancelAnimationFrame(raf); raf = 0; lastTime = 0; }
  }
  mascot.addEventListener('click', () => {
    pinned = !pinned;
    mascot.setAttribute('aria-pressed', String(pinned));
    mascot.setAttribute('aria-label', pinned ? '优优正在休息，点击叫醒它' : '优优，点击让它休息');
    mascot.title = pinned ? '优优睡着啦 · 点一下叫醒它' : '优优 · 点一下让它休息';
    if (pinned) setState('sleeping'); else startRun();
    paint(); schedule();
  });
  mascot.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse' || pinned) return;
    hovered = true; setState('sitting', Infinity); paint();
  });
  mascot.addEventListener('pointerleave', () => {
    if (!hovered) return;
    hovered = false;
    if (!pinned && !focused) { setState('sitting', 1000); paint(); }
  });
  mascot.addEventListener('focus', () => {
    focused = true;
    if (!pinned) { setState('sitting', Infinity); paint(); }
  });
  mascot.addEventListener('blur', () => {
    focused = false;
    if (!pinned && !hovered) { setState('sitting', 1000); paint(); }
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) setState(pinned ? 'sleeping' : 'sitting'); else if (!pinned && !hovered && !focused) startRun();
    paint(); schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  new ResizeObserver(measure).observe(stage);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; schedule(); }).observe(stage);
  const atlas = new Image();
  atlas.onload = () => {
    ready = true; stage.classList.add('is-ready');
    measure(); paint(); schedule();
  };
  atlas.src = new URL('yoyo-sprites.png', document.currentScript.src).href;
})();
