/**
 * Graphical subtitle timeline (NLE-style): one row per cue.
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
 *   onUndo?: () => void,
 *   onRedo?: () => void,
 *   onRestoreBaseline?: () => void,
 *   onSeek?: (sec: number) => void,
 *   formatTime?: (sec: number) => string,
 * }} opts
 */
export function createSubtitleTimeline(root, opts) {
  if (!root) throw new Error('timeline root required');

  let pxPerSec = 48;
  let selectedIdx = -1;
  let snapEnabled = true;
  /**
   * Auto-move mode for later cues:
   * - off: only the edited cue moves
   * - shift: later cues translate by the same delta
   * - chain: later cues pack end-to-end (2nd after 1st, 3rd after 2nd, …)
   * @type {'off' | 'shift' | 'chain'}
   */
  let followMode = 'chain';
  try {
    const saved = localStorage.getItem('videomerge.followMode');
    if (saved === 'off' || saved === 'shift' || saved === 'chain') followMode = saved;
  } catch {
    /* ignore */
  }
  const SNAP = 0.05;
  const MIN_CUE = 0.2;
  const CHAIN_GAP = 0.06;
  /** Left label column width (px) — room for # + text */
  const LABEL_W = 200;
  const ROW_H = 36;

  /**
   * @typedef {{
   *   mode: 'move'|'start'|'end',
   *   idx: number,
   *   startX: number,
   *   origS: number,
   *   origE: number,
   *   pointerId: number,
   *   origAll: { s: number, e: number, text: string }[],
   *   _live?: SubChunk[],
   * }} DragState
   */
  /** @type {DragState | null} */
  let drag = null;

  root.classList.add('tl-editor');
  root.innerHTML = `
    <div class="tl-toolbar">
      <div class="tl-toolbar-left">
        <span class="tl-toolbar-title">字幕時間軸</span>
        <span class="tl-toolbar-hint" data-tl="count-hint">每句一列 · 拖曳色塊移動 · 後句可自動跟隨</span>
      </div>
      <div class="tl-toolbar-right">
        <button type="button" class="btn btn-ghost btn-sm" data-tl="undo" title="復原 (Ctrl+Z)" disabled>復原</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="redo" title="重做 (Ctrl+Y)" disabled>重做</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="restore-base" title="還原至產生預覽時的時間軸" disabled>還原產生時</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-out" title="縮小">−</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-in" title="放大">+</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="fit" title="符合時長">適合</button>
        <label class="tl-snap-label" title="拖曳時吸附 0.05s">
          <input type="checkbox" data-tl="snap" checked />
          <span>吸附</span>
        </label>
        <label class="tl-follow-mode" title="調整某句後，後續句子如何自動移動">
          <span class="tl-follow-mode-label">後句自動</span>
          <select class="field-select tl-follow-select" data-tl="follow-mode" aria-label="後句自動移動方式">
            <option value="off">關閉</option>
            <option value="shift">同秒平移</option>
            <option value="chain" selected>自動銜接</option>
          </select>
        </label>
      </div>
    </div>
    <div class="tl-scroll" data-tl="scroll" tabindex="0" role="region" aria-label="字幕時間軸（每句一列）">
      <div class="tl-canvas" data-tl="canvas">
        <div class="tl-ruler" data-tl="ruler"></div>
        <div class="tl-rows" data-tl="rows"></div>
        <div class="tl-playhead" data-tl="playhead" aria-hidden="true">
          <div class="tl-playhead-head"></div>
          <div class="tl-playhead-line"></div>
        </div>
      </div>
    </div>
    <div class="tl-cue-list-wrap">
      <div class="tl-cue-list-head">
        <span>句序</span>
        <span>開始</span>
        <span>結束</span>
        <span>字幕文字（一列一句）</span>
      </div>
      <div class="tl-cue-list" data-tl="cue-list" role="list"></div>
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
    rows: root.querySelector('[data-tl="rows"]'),
    cueList: root.querySelector('[data-tl="cue-list"]'),
    countHint: root.querySelector('[data-tl="count-hint"]'),
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

  function contentEndSec() {
    const chunks = opts.getChunks() || [];
    let end = 0;
    for (const c of chunks) {
      const e = Number(c.timestamp?.[1]);
      if (Number.isFinite(e) && e > end) end = e;
    }
    return end;
  }

  /**
   * Timeline length for layout / clamping.
   * Never use a tiny fallback (e.g. 1s) when cues already extend further —
   * that previously locked all drag moves to delta≈0.
   */
  function duration() {
    const d = Number(opts.getDuration()) || 0;
    const video = opts.getVideo?.();
    const vd =
      video && Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : 0;
    const content = contentEndSec();
    // room to drag past last cue; floor 30s so short clips still scrubbable
    return Math.max(d, vd, content + 30, 30);
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

  /**
   * Shift cues from fromIdx (inclusive) by delta seconds (start+end).
   * @param {{ s: number, e: number, text: string }[]} origAll
   * @param {number} fromIdx
   * @param {number} delta
   * @param {number} maxDur
   * @param {boolean} followAll  if false, only fromIdx is shifted
   * @returns {{ chunks: SubChunk[], delta: number }}
   */
  function shiftCuesFrom(origAll, fromIdx, delta, maxDur, followAll) {
    const last = followAll ? origAll.length - 1 : fromIdx;
    let d = Number(delta) || 0;
    if (!Number.isFinite(d) || fromIdx < 0 || fromIdx >= origAll.length) {
      return {
        chunks: origAll.map((o) => ({ timestamp: [o.s, o.e], text: o.text })),
        delta: 0,
      };
    }

    let minD = -Infinity;
    let maxD = Infinity;
    for (let i = fromIdx; i <= last; i++) {
      const o = origAll[i];
      minD = Math.max(minD, -o.s);
      if (Number.isFinite(maxDur) && maxDur > 0) {
        maxD = Math.min(maxD, maxDur - o.e);
      }
    }
    if (Number.isFinite(minD) && Number.isFinite(maxD) && minD > maxD) {
      d = minD;
    } else {
      if (Number.isFinite(minD)) d = Math.max(minD, d);
      if (Number.isFinite(maxD)) d = Math.min(maxD, d);
    }
    d = snap(d);

    const chunks = origAll.map((o, i) => {
      if (i < fromIdx || i > last) {
        return { timestamp: [o.s, o.e], text: o.text };
      }
      return { timestamp: [o.s + d, o.e + d], text: o.text };
    });
    return { chunks, delta: d };
  }

  /**
   * Pack cues so each later line starts right after the previous ends.
   * Cue 0..anchorIdx keep times; from anchorIdx+1 onward are chained.
   * Each cue keeps its own duration.
   * @param {SubChunk[]} chunks
   * @param {number} anchorIdx  last cue that was manually set
   * @param {number} maxDur
   * @param {number} [gapSec]
   * @returns {SubChunk[]}
   */
  function rechainAfter(chunks, anchorIdx, maxDur, gapSec = CHAIN_GAP) {
    if (!chunks?.length) return chunks;
    const next = chunks.map((c) => ({
      timestamp: [Number(c.timestamp[0]) || 0, Number(c.timestamp[1]) || 0],
      text: c.text,
    }));
    const startAt = Math.max(0, Math.floor(anchorIdx));
    for (let i = startAt + 1; i < next.length; i++) {
      const prevEnd = next[i - 1].timestamp[1];
      const dur = Math.max(
        MIN_CUE,
        next[i].timestamp[1] - next[i].timestamp[0],
      );
      let s = snap(prevEnd + gapSec);
      let e = s + dur;
      if (Number.isFinite(maxDur) && maxDur > 0 && e > maxDur) {
        e = maxDur;
        s = Math.max(0, e - dur);
        if (s < prevEnd) {
          // overflow: still place after previous as much as possible
          s = Math.min(prevEnd + gapSec, Math.max(0, maxDur - MIN_CUE));
          e = Math.min(maxDur, s + dur);
        }
      }
      if (e <= s) e = s + MIN_CUE;
      next[i] = { timestamp: [s, e], text: next[i].text };
    }
    return next;
  }

  function setPlayhead(sec) {
    const x = LABEL_W + Math.max(0, sec) * pxPerSec;
    el.playhead.style.transform = `translateX(${x}px)`;
  }

  function tickStep() {
    const target = 80 / pxPerSec;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    for (const s of steps) {
      if (s >= target) return s;
    }
    return 120;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
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

  function renderRows() {
    const chunks = opts.getChunks() || [];
    const dur = duration();
    const trackW = dur * pxPerSec;

    if (el.countHint) {
      const modeLabel =
        followMode === 'chain'
          ? '自動銜接（2接1、3接2…）'
          : followMode === 'shift'
            ? '同秒平移'
            : '後句不自動動';
      el.countHint.textContent = chunks.length
        ? `共 ${chunks.length} 句 · 每句一列 · ${modeLabel}`
        : `每句一列 · ${modeLabel}`;
    }

    el.rows.innerHTML = '';
    el.rows.style.minHeight = `${Math.max(ROW_H, chunks.length * ROW_H)}px`;

    chunks.forEach((c, i) => {
      const s = Number(c.timestamp?.[0]) || 0;
      const e = Number(c.timestamp?.[1]) || s + MIN_CUE;
      const left = s * pxPerSec;
      const width = Math.max(8, (e - s) * pxPerSec);

      const row = document.createElement('div');
      row.className = 'tl-row' + (i === selectedIdx ? ' is-selected' : '');
      row.dataset.idx = String(i);
      row.style.height = `${ROW_H}px`;

      const label = document.createElement('div');
      label.className = 'tl-row-label';
      label.style.width = `${LABEL_W}px`;
      label.innerHTML = `
        <span class="tl-row-num">${i + 1}</span>
        <span class="tl-row-text" title="${escapeHtml(c.text || '')}">${escapeHtml(c.text || '')}</span>
      `;
      label.title = `#${i + 1}  ${formatTime(s)} – ${formatTime(e)}`;

      const track = document.createElement('div');
      track.className = 'tl-row-track';
      track.style.width = `${trackW}px`;

      const clip = document.createElement('div');
      clip.className = 'tl-clip' + (i === selectedIdx ? ' is-selected' : '');
      clip.style.left = `${left}px`;
      clip.style.width = `${width}px`;
      clip.dataset.idx = String(i);
      clip.title = `#${i + 1}  ${formatTime(s)} – ${formatTime(e)}\n${c.text || ''}`;
      clip.innerHTML = `
        <div class="tl-handle tl-handle-start" data-handle="start" title="調整開始"></div>
        <div class="tl-clip-body">
          <span class="tl-clip-range">${formatTime(s)}–${formatTime(e)}</span>
        </div>
        <div class="tl-handle tl-handle-end" data-handle="end" title="調整結束"></div>
      `;
      track.appendChild(clip);

      row.appendChild(label);
      row.appendChild(track);
      el.rows.appendChild(row);
    });

    // Cue list table — one DOM row per subtitle
    if (el.cueList) {
      el.cueList.innerHTML = '';
      chunks.forEach((c, i) => {
        const s = Number(c.timestamp?.[0]) || 0;
        const e = Number(c.timestamp?.[1]) || s + MIN_CUE;
        const item = document.createElement('div');
        item.className = 'tl-cue-row' + (i === selectedIdx ? ' is-selected' : '');
        item.dataset.idx = String(i);
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
          <span class="tl-cue-num">${i + 1}</span>
          <span class="tl-cue-time">${formatTime(s)}</span>
          <span class="tl-cue-time">${formatTime(e)}</span>
          <span class="tl-cue-text">${escapeHtml(c.text || '')}</span>
        `;
        el.cueList.appendChild(item);
      });
    }
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

  function commitChunks(next) {
    opts.onChange(
      next.map((c) => ({
        timestamp: [c.timestamp[0], c.timestamp[1]],
        text: c.text,
      })),
    );
    // Full re-render only after commit (not during drag)
    render();
  }

  /** Update selected styles without rebuilding DOM (critical for drag). */
  function highlightSelection(idx) {
    selectedIdx = idx;
    el.rows?.querySelectorAll('.tl-row').forEach((row) => {
      const i = Number(row.dataset.idx);
      const on = i === idx;
      row.classList.toggle('is-selected', on);
      row.querySelector('.tl-clip')?.classList.toggle('is-selected', on);
    });
    el.cueList?.querySelectorAll('.tl-cue-row').forEach((row) => {
      row.classList.toggle('is-selected', Number(row.dataset.idx) === idx);
    });
    updateInspector();
  }

  /**
   * @param {number} idx
   * @param {{ soft?: boolean, scroll?: boolean }} [opts]
   */
  function select(idx, opts = {}) {
    const soft = Boolean(opts.soft);
    const doScroll = opts.scroll !== false && !soft;
    selectedIdx = idx;
    if (soft) {
      highlightSelection(idx);
      return;
    }
    renderRows();
    updateInspector();
    if (doScroll) {
      const listRow = el.cueList?.querySelector(`.tl-cue-row[data-idx="${idx}"]`);
      listRow?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const tlRow = el.rows?.querySelector(`.tl-row[data-idx="${idx}"]`);
      tlRow?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function render() {
    const dur = duration();
    renderRuler(dur);
    renderRows();
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

  function timeFromClientX(clientX, trackEl) {
    const track = trackEl || el.rows?.querySelector('.tl-row-track');
    if (!track) return 0;
    const trackRect = track.getBoundingClientRect();
    const localX = clientX - trackRect.left;
    return Math.max(0, localX / pxPerSec);
  }

  function seekFromEvent(e, trackEl) {
    const t = snap(timeFromClientX(e.clientX, trackEl));
    const video = opts.getVideo?.();
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(video.duration, Math.max(0, t));
    }
    opts.onSeek?.(t);
    setPlayhead(t);
  }

  // —— Toolbar ——
  const btnUndo = /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-tl="undo"]'));
  const btnRedo = /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-tl="redo"]'));
  const btnRestoreBase = /** @type {HTMLButtonElement|null} */ (
    root.querySelector('[data-tl="restore-base"]')
  );
  btnUndo?.addEventListener('click', () => opts.onUndo?.());
  btnRedo?.addEventListener('click', () => opts.onRedo?.());
  btnRestoreBase?.addEventListener('click', () => opts.onRestoreBaseline?.());

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
    snapEnabled = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
  });
  const followSelect = /** @type {HTMLSelectElement|null} */ (
    root.querySelector('[data-tl="follow-mode"]')
  );
  if (followSelect) {
    followSelect.value = followMode;
    followSelect.addEventListener('change', () => {
      const v = followSelect.value;
      followMode = v === 'shift' || v === 'chain' || v === 'off' ? v : 'chain';
      try {
        localStorage.setItem('videomerge.followMode', followMode);
      } catch {
        /* ignore */
      }
      // Optionally re-pack entire list when switching to chain
      if (followMode === 'chain') {
        const chunks = opts.getChunks();
        if (chunks?.length) {
          const maxDur = duration();
          const packed = rechainAfter(chunks, 0, maxDur, CHAIN_GAP);
          // Keep cue 0 where it is: rechainAfter from 0 only moves 1..n
          commitChunks(packed);
          return;
        }
      }
      render();
    });
  }

  el.scroll.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const prev = pxPerSec;
      pxPerSec = Math.min(240, Math.max(6, pxPerSec * factor));
      const t = timeFromClientX(e.clientX);
      render();
      const newX = LABEL_W + t * pxPerSec;
      const oldX = LABEL_W + t * prev;
      el.scroll.scrollLeft += newX - oldX;
    },
    { passive: false },
  );

  el.ruler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    seekFromEvent(e);
  });

  // Row / clip / list interactions (delegated)
  el.rows.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = /** @type {HTMLElement|null} */ (e.target.closest?.('[data-handle]'));
    const clip = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-clip'));
    const row = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-row'));
    const track = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-row-track'));

    if (clip) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(clip.dataset.idx);
      const chunks = opts.getChunks() || [];
      if (!Number.isFinite(idx) || !chunks[idx]) return;
      // Soft select: do NOT rebuild DOM or scroll — that aborted drag before
      select(idx, { soft: true, scroll: false });
      const mode =
        handle?.getAttribute('data-handle') === 'start'
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
        origAll: chunks.map((ch) => ({
          s: Number(ch.timestamp[0]) || 0,
          e: Number(ch.timestamp[1]) || 0,
          text: ch.text,
        })),
      };
      try {
        clip.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers reject if already released */
      }
      el.scroll?.classList.add('is-dragging');
      return;
    }

    if (row && track) {
      const idx = Number(row.dataset.idx);
      if (Number.isFinite(idx)) select(idx, { soft: true });
      seekFromEvent(e, track);
    }
  });

  el.rows.addEventListener('dblclick', (e) => {
    const clip = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-clip'));
    const row = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-row'));
    const idx = Number(clip?.dataset.idx ?? row?.dataset.idx);
    const chunks = opts.getChunks() || [];
    const c = chunks[idx];
    if (!c) return;
    const t = Number(c.timestamp[0]) || 0;
    const video = opts.getVideo?.();
    if (video) video.currentTime = t;
    opts.onSeek?.(t);
    setPlayhead(t);
  });

  el.cueList?.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement|null} */ (e.target.closest?.('.tl-cue-row'));
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (!Number.isFinite(idx)) return;
    select(idx);
    const chunks = opts.getChunks() || [];
    const t = Number(chunks[idx]?.timestamp?.[0]) || 0;
    const video = opts.getVideo?.();
    if (video) video.currentTime = t;
    opts.onSeek?.(t);
    setPlayhead(t);
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const chunks = opts.getChunks();
    if (!chunks?.length || !drag.origAll?.length) return;
    const dx = (e.clientX - drag.startX) / pxPerSec;
    const maxDur = duration();
    /** @type {SubChunk[]} */
    let next;

    if (drag.mode === 'move') {
      const wantDelta = snap(drag.origS + dx) - drag.origS;
      if (followMode === 'shift') {
        const shifted = shiftCuesFrom(
          drag.origAll,
          drag.idx,
          wantDelta,
          maxDur,
          true,
        );
        next = shifted.chunks;
      } else {
        // off or chain: move only this cue first; chain packs others after
        const shifted = shiftCuesFrom(
          drag.origAll,
          drag.idx,
          wantDelta,
          maxDur,
          false,
        );
        next = shifted.chunks;
        if (followMode === 'chain') {
          next = rechainAfter(next, drag.idx, maxDur, CHAIN_GAP);
        }
      }
      const s = next[drag.idx].timestamp[0];
      const end = next[drag.idx].timestamp[1];
      livePaint(next);
      if (selectedIdx === drag.idx) {
        el.selStart.value = String(round2(s));
        el.selEnd.value = String(round2(end));
        el.selDur.textContent = `長度 ${(end - s).toFixed(2)}s`;
      }
      drag._live = next;
      return;
    }

    // Resize handles: edit this cue, then optionally rechain later lines
    next = drag.origAll.map((o) => ({
      timestamp: [o.s, o.e],
      text: o.text,
    }));
    let s = drag.origS;
    let end = drag.origE;
    if (drag.mode === 'start') {
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
    if (followMode === 'chain') {
      next = rechainAfter(next, drag.idx, maxDur, CHAIN_GAP);
    }
    livePaint(next);
    if (selectedIdx === drag.idx) {
      el.selStart.value = String(round2(s));
      el.selEnd.value = String(round2(end));
      el.selDur.textContent = `長度 ${(end - s).toFixed(2)}s`;
    }
    drag._live = next;
  });

  function livePaint(chunks) {
    chunks.forEach((c, i) => {
      const clip = el.rows.querySelector(`.tl-clip[data-idx="${i}"]`);
      const s = Number(c.timestamp[0]) || 0;
      const e = Number(c.timestamp[1]) || s + MIN_CUE;
      if (clip) {
        /** @type {HTMLElement} */ (clip).style.left = `${s * pxPerSec}px`;
        /** @type {HTMLElement} */ (clip).style.width =
          `${Math.max(8, (e - s) * pxPerSec)}px`;
        const range = clip.querySelector('.tl-clip-range');
        if (range) range.textContent = `${formatTime(s)}–${formatTime(e)}`;
      }
      const listRow = el.cueList?.querySelector(`.tl-cue-row[data-idx="${i}"]`);
      if (listRow) {
        const times = listRow.querySelectorAll('.tl-cue-time');
        if (times[0]) times[0].textContent = formatTime(s);
        if (times[1]) times[1].textContent = formatTime(e);
      }
    });
  }

  function endDrag(commit) {
    el.scroll?.classList.remove('is-dragging');
    if (!drag) return;
    const live = drag._live;
    drag = null;
    if (commit && live) commitChunks(live);
  }

  window.addEventListener('pointerup', () => endDrag(true));
  window.addEventListener('pointercancel', () => {
    endDrag(false);
    render();
  });

  root.querySelector('[data-tl="sel-apply"]')?.addEventListener('click', () => {
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    const maxDur = duration();
    let s = Number(el.selStart.value);
    let end = Number(el.selEnd.value);
    if (!Number.isFinite(s) || !Number.isFinite(end)) return;
    [s, end] = clampCue(snap(s), snap(end), maxDur);

    const origS = Number(chunks[selectedIdx].timestamp[0]) || 0;
    const origE = Number(chunks[selectedIdx].timestamp[1]) || 0;
    const origLen = origE - origS;
    const newLen = end - s;
    const delta = s - origS;
    const isTranslate =
      Math.abs(newLen - origLen) < 0.02 && Math.abs(end - (origE + delta)) < 0.05;

    let next;
    if (followMode === 'shift' && isTranslate && Math.abs(delta) >= 0.001) {
      const origAll = chunks.map((c) => ({
        s: Number(c.timestamp[0]) || 0,
        e: Number(c.timestamp[1]) || 0,
        text: c.text,
      }));
      const shifted = shiftCuesFrom(origAll, selectedIdx, delta, maxDur, true);
      next = shifted.chunks;
      next[selectedIdx] = {
        timestamp: [...next[selectedIdx].timestamp],
        text: el.selText.value,
      };
    } else {
      next = chunks.map((c, i) =>
        i === selectedIdx
          ? { timestamp: [s, end], text: el.selText.value }
          : { timestamp: [c.timestamp[0], c.timestamp[1]], text: c.text },
      );
      if (followMode === 'chain') {
        next = rechainAfter(next, selectedIdx, maxDur, CHAIN_GAP);
      }
    }
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

  // Global undo/redo when focus is in timeline panel
  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      opts.onUndo?.();
      return;
    }
    if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      opts.onRedo?.();
    }
  });

  el.scroll.addEventListener('keydown', (e) => {
    // Ctrl+Z / Y handled on root
    if (e.ctrlKey || e.metaKey) return;
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    const step = e.shiftKey ? 0.5 : 0.05;
    let ds = 0;
    if (e.key === 'ArrowLeft') ds = -step;
    else if (e.key === 'ArrowRight') ds = step;
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(Math.max(0, selectedIdx - 1));
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(Math.min(chunks.length - 1, selectedIdx + 1));
      return;
    } else return;
    e.preventDefault();
    const maxDur = duration();
    const origAll = chunks.map((c) => ({
      s: Number(c.timestamp[0]) || 0,
      e: Number(c.timestamp[1]) || 0,
      text: c.text,
    }));
    let next;
    if (followMode === 'shift') {
      next = shiftCuesFrom(origAll, selectedIdx, ds, maxDur, true).chunks;
    } else {
      next = shiftCuesFrom(origAll, selectedIdx, ds, maxDur, false).chunks;
      if (followMode === 'chain') {
        next = rechainAfter(next, selectedIdx, maxDur, CHAIN_GAP);
      }
    }
    commitChunks(next);
  });

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

  const ro = new ResizeObserver(() => {});
  ro.observe(el.scroll);

  return {
    render,
    fit,
    select,
    bindVideo,
    getSelectedIndex: () => selectedIdx,
    getFollowMode: () => followMode,
    /**
     * @param {{ canUndo?: boolean, canRedo?: boolean, canRestoreBaseline?: boolean }} state
     */
    setUndoRedoState(state) {
      if (btnUndo) btnUndo.disabled = !state.canUndo;
      if (btnRedo) btnRedo.disabled = !state.canRedo;
      if (btnRestoreBase) btnRestoreBase.disabled = !state.canRestoreBaseline;
    },
    /**
     * Re-pack all cues after index 0 (or given anchor) so each follows the previous end.
     * @param {number} [anchorIdx]
     */
    rechainAll(anchorIdx = 0) {
      const chunks = opts.getChunks();
      if (!chunks?.length) return;
      commitChunks(rechainAfter(chunks, anchorIdx, duration(), CHAIN_GAP));
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.innerHTML = '';
    },
  };
}

/**
 * Shared helper for main.js — pack cues so line N+1 starts after line N ends.
 * @param {{ timestamp: [number, number], text: string }[]} chunks
 * @param {number} anchorIdx
 * @param {number} maxDur
 * @param {number} [gapSec]
 */
export function rechainSubtitleChunks(chunks, anchorIdx, maxDur, gapSec = 0.06) {
  const MIN = 0.2;
  if (!chunks?.length) return chunks || [];
  const next = chunks.map((c) => ({
    timestamp: [Number(c.timestamp[0]) || 0, Number(c.timestamp[1]) || 0],
    text: c.text,
  }));
  const startAt = Math.max(0, Math.floor(anchorIdx));
  for (let i = startAt + 1; i < next.length; i++) {
    const prevEnd = next[i - 1].timestamp[1];
    const dur = Math.max(MIN, next[i].timestamp[1] - next[i].timestamp[0]);
    let s = prevEnd + gapSec;
    let e = s + dur;
    if (Number.isFinite(maxDur) && maxDur > 0 && e > maxDur) {
      e = maxDur;
      s = Math.max(0, e - dur);
    }
    if (e <= s) e = s + MIN;
    next[i] = { timestamp: [s, e], text: next[i].text };
  }
  return next;
}
