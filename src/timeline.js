/**
 * Graphical subtitle timeline (NLE-style): ruler, playhead, draggable / resizable cues.
 * Inspired by CapCut / Premiere / DaVinci / FCP / PowerDirector / Filmora.
 */

/**
 * @typedef {{ timestamp: [number, number], text: string }} SubChunk
 */

/**
 * @param {HTMLElement} root
 * @param {{
 *   getChunks: () => SubChunk[] | null,
 *   getDuration: () => number,
 *   getVideo: () => HTMLVideoElement | null,
 *   onChange: (chunks: SubChunk[]) => void,
 *   onSeek?: (sec: number) => void,
 *   formatTime?: (sec: number) => string,
 * }} opts
 */
export function createSubtitleTimeline(root, opts) {
  if (!root) throw new Error('timeline root required');

  let pxPerSec = 48;
  let selectedIdx = -1;
  let snapEnabled = true;
  const SNAP = 0.05;
  const MIN_CUE = 0.2;
  const LABEL_W = 56;

  /** @type {null | { mode: 'move'|'start'|'end', idx: number, startX: number, origS: number, origE: number, pointerId: number }} */
  let drag = null;

  root.classList.add('tl-editor');
  root.innerHTML = `
    <div class="tl-toolbar">
      <div class="tl-toolbar-left">
        <span class="tl-toolbar-title">字幕時間軸</span>
        <span class="tl-toolbar-hint">拖曳片段移動 · 左右手柄改起迄 · 點時間尺跳播</span>
      </div>
      <div class="tl-toolbar-right">
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-out" title="縮小">−</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-in" title="放大">+</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="fit" title="符合時長">適合</button>
        <label class="tl-snap-label" title="拖曳時吸附 0.05s">
          <input type="checkbox" data-tl="snap" checked />
          <span>吸附</span>
        </label>
      </div>
    </div>
    <div class="tl-scroll" data-tl="scroll" tabindex="0" role="region" aria-label="字幕時間軸">
      <div class="tl-canvas" data-tl="canvas">
        <div class="tl-ruler" data-tl="ruler"></div>
        <div class="tl-lanes">
          <div class="tl-lane-label" aria-hidden="true">字幕</div>
          <div class="tl-track" data-tl="track"></div>
        </div>
        <div class="tl-playhead" data-tl="playhead" aria-hidden="true">
          <div class="tl-playhead-head"></div>
          <div class="tl-playhead-line"></div>
        </div>
      </div>
    </div>
    <div class="tl-inspector" data-tl="inspector" hidden>
      <div class="tl-inspector-row">
        <span class="tl-inspector-badge" data-tl="sel-idx">—</span>
        <label class="field field-inline">
          <span class="field-label">開始</span>
          <input type="number" class="field-select" data-tl="sel-start" step="0.05" min="0" />
        </label>
        <label class="field field-inline">
          <span class="field-label">結束</span>
          <input type="number" class="field-select" data-tl="sel-end" step="0.05" min="0" />
        </label>
        <span class="tl-inspector-dur" data-tl="sel-dur"></span>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="sel-apply">套用</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="sel-seek">跳到此句</button>
      </div>
      <label class="tl-inspector-text-label">
        <span class="field-label">字幕文字</span>
        <input type="text" class="tl-inspector-text" data-tl="sel-text" />
      </label>
    </div>
  `;

  const el = {
    scroll: root.querySelector('[data-tl="scroll"]'),
    canvas: root.querySelector('[data-tl="canvas"]'),
    ruler: root.querySelector('[data-tl="ruler"]'),
    track: root.querySelector('[data-tl="track"]'),
    playhead: root.querySelector('[data-tl="playhead"]'),
    inspector: root.querySelector('[data-tl="inspector"]'),
    selIdx: root.querySelector('[data-tl="sel-idx"]'),
    selStart: root.querySelector('[data-tl="sel-start"]'),
    selEnd: root.querySelector('[data-tl="sel-end"]'),
    selDur: root.querySelector('[data-tl="sel-dur"]'),
    selText: root.querySelector('[data-tl="sel-text"]'),
  };

  function formatTime(sec) {
    if (opts.formatTime) return opts.formatTime(sec);
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }

  function duration() {
    const d = Number(opts.getDuration()) || 0;
    const video = opts.getVideo?.();
    const vd = video && Number.isFinite(video.duration) ? video.duration : 0;
    return Math.max(d, vd, 1);
  }

  function snap(t) {
    if (!snapEnabled) return t;
    return Math.round(t / SNAP) * SNAP;
  }

  function clampCue(s, e, maxDur) {
    let start = Math.max(0, s);
    let end = Math.max(start + MIN_CUE, e);
    if (Number.isFinite(maxDur) && maxDur > 0) {
      end = Math.min(end, maxDur);
      if (end - start < MIN_CUE) start = Math.max(0, end - MIN_CUE);
    }
    return [start, end];
  }

  function setPlayhead(sec) {
    const x = LABEL_W + Math.max(0, sec) * pxPerSec;
    el.playhead.style.transform = `translateX(${x}px)`;
  }

  function tickStep() {
    // Aim ~80px between major ticks
    const target = 80 / pxPerSec;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    for (const s of steps) {
      if (s >= target) return s;
    }
    return 120;
  }

  function renderRuler(dur) {
    const w = LABEL_W + dur * pxPerSec + 40;
    el.canvas.style.width = `${w}px`;
    const step = tickStep();
    const minor = step / 2;
    let html = `<div class="tl-ruler-gutter" style="width:${LABEL_W}px"></div><div class="tl-ruler-marks">`;
    for (let t = 0; t <= dur + 0.001; t += minor) {
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const left = t * pxPerSec;
      if (isMajor) {
        html += `<div class="tl-tick is-major" style="left:${left}px"><span>${formatTime(t)}</span></div>`;
      } else {
        html += `<div class="tl-tick" style="left:${left}px"></div>`;
      }
    }
    html += '</div>';
    el.ruler.innerHTML = html;
    el.ruler.style.width = `${w}px`;
  }

  function renderClips() {
    const chunks = opts.getChunks() || [];
    const dur = duration();
    el.track.style.width = `${dur * pxPerSec}px`;
    el.track.innerHTML = '';

    chunks.forEach((c, i) => {
      const s = Number(c.timestamp?.[0]) || 0;
      const e = Number(c.timestamp?.[1]) || s + MIN_CUE;
      const left = s * pxPerSec;
      const width = Math.max(6, (e - s) * pxPerSec);
      const clip = document.createElement('div');
      clip.className = 'tl-clip' + (i === selectedIdx ? ' is-selected' : '');
      clip.style.left = `${left}px`;
      clip.style.width = `${width}px`;
      clip.dataset.idx = String(i);
      clip.title = `#${i + 1}  ${formatTime(s)} – ${formatTime(e)}\n${c.text || ''}`;
      clip.innerHTML = `
        <div class="tl-handle tl-handle-start" data-handle="start" title="調整開始"></div>
        <div class="tl-clip-body">
          <span class="tl-clip-num">${i + 1}</span>
          <span class="tl-clip-text">${escapeHtml(c.text || '')}</span>
        </div>
        <div class="tl-handle tl-handle-end" data-handle="end" title="調整結束"></div>
      `;
      el.track.appendChild(clip);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateInspector() {
    const chunks = opts.getChunks() || [];
    if (selectedIdx < 0 || selectedIdx >= chunks.length) {
      el.inspector.hidden = true;
      return;
    }
    const c = chunks[selectedIdx];
    const s = Number(c.timestamp[0]) || 0;
    const e = Number(c.timestamp[1]) || 0;
    el.inspector.hidden = false;
    el.selIdx.textContent = `#${selectedIdx + 1}`;
    if (document.activeElement !== el.selStart) el.selStart.value = String(round2(s));
    if (document.activeElement !== el.selEnd) el.selEnd.value = String(round2(e));
    if (document.activeElement !== el.selText) el.selText.value = c.text || '';
    el.selDur.textContent = `長度 ${(e - s).toFixed(2)}s`;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function commitChunks(next) {
    opts.onChange(next.map((c) => ({
      timestamp: [c.timestamp[0], c.timestamp[1]],
      text: c.text,
    })));
    render();
  }

  function select(idx) {
    selectedIdx = idx;
    renderClips();
    updateInspector();
  }

  function render() {
    const dur = duration();
    renderRuler(dur);
    renderClips();
    updateInspector();
    const video = opts.getVideo?.();
    setPlayhead(video?.currentTime || 0);
  }

  function fit() {
    const scrollW = el.scroll.clientWidth - LABEL_W - 24;
    const dur = duration();
    if (scrollW > 40 && dur > 0) {
      pxPerSec = Math.min(200, Math.max(8, scrollW / dur));
      render();
    }
  }

  function timeFromClientX(clientX) {
    const trackRect = el.track.getBoundingClientRect();
    const localX = clientX - trackRect.left;
    return Math.max(0, localX / pxPerSec);
  }

  function seekFromEvent(e) {
    const t = snap(timeFromClientX(e.clientX));
    const video = opts.getVideo?.();
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(video.duration, Math.max(0, t));
    }
    opts.onSeek?.(t);
    setPlayhead(t);
  }

  // —— Toolbar ——
  root.querySelector('[data-tl="zoom-in"]')?.addEventListener('click', () => {
    pxPerSec = Math.min(240, pxPerSec * 1.35);
    render();
  });
  root.querySelector('[data-tl="zoom-out"]')?.addEventListener('click', () => {
    pxPerSec = Math.max(6, pxPerSec / 1.35);
    render();
  });
  root.querySelector('[data-tl="fit"]')?.addEventListener('click', () => fit());
  root.querySelector('[data-tl="snap"]')?.addEventListener('change', (e) => {
    snapEnabled = Boolean(e.target.checked);
  });

  // —— Scroll wheel zoom (Ctrl / Meta) ——
  el.scroll.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const prev = pxPerSec;
      pxPerSec = Math.min(240, Math.max(6, pxPerSec * factor));
      // Keep pointer time under cursor roughly stable
      const t = timeFromClientX(e.clientX);
      render();
      const newX = LABEL_W + t * pxPerSec;
      const oldX = LABEL_W + t * prev;
      el.scroll.scrollLeft += newX - oldX;
    },
    { passive: false },
  );

  // —— Click ruler / empty track to seek ——
  el.ruler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    seekFromEvent(e);
  });
  el.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tl-clip')) return;
    seekFromEvent(e);
    select(-1);
  });

  // —— Clip interaction ——
  el.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-handle]');
    const clip = e.target.closest('.tl-clip');
    if (!clip) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(clip.dataset.idx);
    const chunks = opts.getChunks() || [];
    if (!Number.isFinite(idx) || !chunks[idx]) return;
    select(idx);
    const mode = handle?.getAttribute('data-handle') === 'start'
      ? 'start'
      : handle?.getAttribute('data-handle') === 'end'
        ? 'end'
        : 'move';
    const c = chunks[idx];
    drag = {
      mode,
      idx,
      startX: e.clientX,
      origS: Number(c.timestamp[0]) || 0,
      origE: Number(c.timestamp[1]) || 0,
      pointerId: e.pointerId,
    };
    clip.setPointerCapture?.(e.pointerId);
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const chunks = opts.getChunks();
    if (!chunks?.length) return;
    const dx = (e.clientX - drag.startX) / pxPerSec;
    const maxDur = duration();
    const next = chunks.map((c) => ({
      timestamp: [c.timestamp[0], c.timestamp[1]],
      text: c.text,
    }));
    let s = drag.origS;
    let end = drag.origE;
    if (drag.mode === 'move') {
      const len = drag.origE - drag.origS;
      s = snap(drag.origS + dx);
      end = s + len;
      if (end > maxDur) {
        end = maxDur;
        s = Math.max(0, end - len);
      }
      if (s < 0) {
        s = 0;
        end = len;
      }
    } else if (drag.mode === 'start') {
      s = snap(drag.origS + dx);
      s = Math.min(s, drag.origE - MIN_CUE);
      s = Math.max(0, s);
      end = drag.origE;
    } else {
      end = snap(drag.origE + dx);
      end = Math.max(end, drag.origS + MIN_CUE);
      end = Math.min(end, maxDur);
      s = drag.origS;
    }
    [s, end] = clampCue(s, end, maxDur);
    next[drag.idx] = { timestamp: [s, end], text: next[drag.idx].text };
    // Live visual without full onChange until pointerup (avoid thrashing track reattach)
    livePaint(next);
    if (selectedIdx === drag.idx) {
      el.selStart.value = String(round2(s));
      el.selEnd.value = String(round2(end));
      el.selDur.textContent = `長度 ${(end - s).toFixed(2)}s`;
    }
    drag._live = next;
  });

  function livePaint(chunks) {
    const nodes = el.track.querySelectorAll('.tl-clip');
    chunks.forEach((c, i) => {
      const node = nodes[i];
      if (!node) return;
      const s = Number(c.timestamp[0]) || 0;
      const e = Number(c.timestamp[1]) || s + MIN_CUE;
      node.style.left = `${s * pxPerSec}px`;
      node.style.width = `${Math.max(6, (e - s) * pxPerSec)}px`;
    });
  }

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag._live) {
      commitChunks(drag._live);
    }
    drag = null;
  });
  window.addEventListener('pointercancel', () => {
    drag = null;
    render();
  });

  // Double-click clip → seek to start
  el.track.addEventListener('dblclick', (e) => {
    const clip = e.target.closest('.tl-clip');
    if (!clip) return;
    const idx = Number(clip.dataset.idx);
    const chunks = opts.getChunks() || [];
    const c = chunks[idx];
    if (!c) return;
    const t = Number(c.timestamp[0]) || 0;
    const video = opts.getVideo?.();
    if (video) video.currentTime = t;
    opts.onSeek?.(t);
    setPlayhead(t);
  });

  // Inspector apply
  root.querySelector('[data-tl="sel-apply"]')?.addEventListener('click', () => {
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    const maxDur = duration();
    let s = Number(el.selStart.value);
    let end = Number(el.selEnd.value);
    if (!Number.isFinite(s) || !Number.isFinite(end)) return;
    [s, end] = clampCue(snap(s), snap(end), maxDur);
    const next = chunks.map((c, i) =>
      i === selectedIdx
        ? { timestamp: [s, end], text: el.selText.value }
        : { timestamp: [c.timestamp[0], c.timestamp[1]], text: c.text },
    );
    commitChunks(next);
  });

  root.querySelector('[data-tl="sel-seek"]')?.addEventListener('click', () => {
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    const t = Number(chunks[selectedIdx].timestamp[0]) || 0;
    const video = opts.getVideo?.();
    if (video) video.currentTime = t;
    opts.onSeek?.(t);
    setPlayhead(t);
  });

  // Keyboard nudge when timeline focused
  el.scroll.addEventListener('keydown', (e) => {
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    const step = e.shiftKey ? 0.5 : 0.05;
    let ds = 0;
    if (e.key === 'ArrowLeft') ds = -step;
    else if (e.key === 'ArrowRight') ds = step;
    else return;
    e.preventDefault();
    const maxDur = duration();
    const next = chunks.map((c) => ({
      timestamp: [c.timestamp[0], c.timestamp[1]],
      text: c.text,
    }));
    const c = next[selectedIdx];
    const len = c.timestamp[1] - c.timestamp[0];
    let s = snap(c.timestamp[0] + ds);
    let end = s + len;
    if (s < 0) {
      s = 0;
      end = len;
    }
    if (end > maxDur) {
      end = maxDur;
      s = Math.max(0, end - len);
    }
    next[selectedIdx] = { timestamp: [s, end], text: c.text };
    commitChunks(next);
  });

  // Video playhead sync
  let raf = 0;
  /** @type {WeakSet<HTMLVideoElement>} */
  const boundVideos = new WeakSet();
  function bindVideo() {
    const video = opts.getVideo?.();
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);
    const tick = () => {
      if (!video.paused && !video.ended) {
        setPlayhead(video.currentTime || 0);
        raf = requestAnimationFrame(tick);
      }
    };
    video.addEventListener('timeupdate', () => setPlayhead(video.currentTime || 0));
    video.addEventListener('play', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    });
    video.addEventListener('pause', () => cancelAnimationFrame(raf));
    video.addEventListener('seeked', () => setPlayhead(video.currentTime || 0));
    video.addEventListener('loadedmetadata', () => render());
  }

  // Resize observer for fit on first show
  const ro = new ResizeObserver(() => {
    // keep current zoom; only ensure playhead visible area updates
  });
  ro.observe(el.scroll);

  return {
    render,
    fit,
    select,
    bindVideo,
    getSelectedIndex: () => selectedIdx,
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}
