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

  /** Pixels per second — higher = more zoomed in (ms detail) */
  let pxPerSec = 48;
  /** Allow zooming out past "fit" so the whole show is smaller than the viewport */
  const ZOOM_MIN = 0.35;
  /** High zoom for ms edits; zoom-out uses large steps so you can return quickly */
  const ZOOM_MAX = 4000;
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
  /** Snap grid in seconds (1 ms) for millisecond-accurate edits */
  const SNAP = 0.001;
  const MIN_CUE = 0.2;
  const CHAIN_GAP = 0.06;
  /** Left label column width (px) — room for # + text */
  const LABEL_W = 260;
  /** Taller rows so clips / text are easier to grab and read */
  const ROW_H = 52;

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

  /** Active view window preset in seconds; null = free zoom; 0 = full duration */
  let viewWindowSec = 0; // 0 = 全長

  root.classList.add('tl-editor');
  if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
  root.innerHTML = `
    <div class="tl-toolbar">
      <div class="tl-toolbar-left">
        <span class="tl-toolbar-title">字幕時間軸</span>
        <span class="tl-toolbar-hint" data-tl="count-hint">預設全長顯示 · 可縮放為 10 秒／30 秒視窗</span>
      </div>
      <div class="tl-toolbar-right">
        <button type="button" class="btn btn-ghost btn-sm" data-tl="undo" title="復原 (Ctrl+Z)" disabled>復原</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="redo" title="重做 (Ctrl+Y)" disabled>重做</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="restore-base" title="還原至產生預覽時的時間軸" disabled>還原產生時</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-out" title="縮小（看見更長時間）">−</button>
        <span class="tl-zoom-readout" data-tl="zoom-readout" title="目前縮放">—</span>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="zoom-in" title="放大（看見更短時間，例如只顯示 10 秒）">+</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tl="fit" title="顯示完整時長（例如 2:50）">全長</button>
        <label class="tl-snap-label" title="拖曳時吸附到 1 毫秒 (0.001s)">
          <input type="checkbox" data-tl="snap" checked />
          <span>吸附 1ms</span>
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
    <div class="tl-viewbar" data-tl="viewbar">
      <span class="tl-viewbar-label">顯示範圍</span>
      <div class="tl-view-presets" role="group" aria-label="時間軸顯示範圍">
        <button type="button" class="btn btn-ghost btn-sm tl-view-preset is-active" data-window="0" title="顯示完整影片時長">全長</button>
        <button type="button" class="btn btn-ghost btn-sm tl-view-preset" data-window="30" title="畫面約顯示 30 秒">30秒</button>
        <button type="button" class="btn btn-ghost btn-sm tl-view-preset" data-window="10" title="畫面約顯示 10 秒">10秒</button>
        <button type="button" class="btn btn-ghost btn-sm tl-view-preset" data-window="5" title="畫面約顯示 5 秒">5秒</button>
        <button type="button" class="btn btn-ghost btn-sm tl-view-preset" data-window="1" title="畫面約顯示 1 秒">1秒</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-tl="page-prev" title="上一段視窗（例如 10–20 秒 → 0–10 秒）">◀ 上一段</button>
      <button type="button" class="btn btn-ghost btn-sm" data-tl="page-next" title="下一段視窗（例如 0–10 秒 → 10–20 秒）">下一段 ▶</button>
      <span class="tl-range-readout" data-tl="range-readout" title="目前畫面顯示的時間區間">顯示 — ／ 總長 —</span>
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
        <span>開始 (ms)</span>
        <span>結束 (ms)</span>
        <span>字幕文字（一列一句）</span>
      </div>
      <div class="tl-cue-list" data-tl="cue-list" role="list"></div>
    </div>
    <div class="tl-inspector" data-tl="inspector" hidden>
      <div class="tl-inspector-row">
        <span class="tl-inspector-badge" data-tl="sel-idx">—</span>
        <label class="field field-inline">
          <span class="field-label">開始（秒.毫秒）</span>
          <input type="number" class="field-select" data-tl="sel-start" step="0.001" min="0" />
        </label>
        <label class="field field-inline">
          <span class="field-label">結束（秒.毫秒）</span>
          <input type="number" class="field-select" data-tl="sel-end" step="0.001" min="0" />
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
    // Fallback: m:ss.mmm
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const totalMs = Math.round(sec * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
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

  function visibleTrackWidth() {
    return Math.max(80, (el.scroll?.clientWidth || 640) - LABEL_W - 12);
  }

  /** @returns {{ start: number, end: number, span: number, total: number }} */
  function getVisibleRange() {
    const total = duration();
    const w = visibleTrackWidth();
    const start = Math.max(0, (el.scroll?.scrollLeft || 0) / Math.max(pxPerSec, 1e-6));
    const span = w / Math.max(pxPerSec, 1e-6);
    const end = Math.min(total, start + span);
    return { start, end, span, total };
  }

  function updateZoomReadout() {
    const elRead = root.querySelector('[data-tl="zoom-readout"]');
    const rangeEl = root.querySelector('[data-tl="range-readout"]');
    const { start, end, span, total } = getVisibleRange();

    if (elRead) {
      // Prefer human window length over raw px/s
      if (viewWindowSec === 0 && Math.abs(span - total) / Math.max(total, 0.1) < 0.08) {
        elRead.textContent = '全長';
      } else if (span >= 60) {
        elRead.textContent = `視窗 ${(span / 60).toFixed(1)} 分`;
      } else if (span >= 1) {
        elRead.textContent = `視窗 ${span.toFixed(span < 10 ? 2 : 1)} 秒`;
      } else {
        elRead.textContent = `視窗 ${Math.round(span * 1000)} ms`;
      }
    }

    if (rangeEl) {
      rangeEl.textContent = `顯示 ${formatTime(start)} – ${formatTime(end)} ／ 總長 ${formatTime(total)}`;
    }

    // Highlight matching preset if close
    root.querySelectorAll('.tl-view-preset').forEach((btn) => {
      const w = Number(btn.getAttribute('data-window'));
      let on = false;
      if (w === 0) {
        on = viewWindowSec === 0 || Math.abs(span - total) / Math.max(total, 0.1) < 0.08;
      } else {
        on = Math.abs(span - w) / w < 0.12;
      }
      btn.classList.toggle('is-active', on);
    });

    const btnIn = root.querySelector('[data-tl="zoom-in"]');
    const btnOut = root.querySelector('[data-tl="zoom-out"]');
    if (btnIn instanceof HTMLButtonElement) {
      btnIn.disabled = pxPerSec >= ZOOM_MAX * 0.999;
    }
    if (btnOut instanceof HTMLButtonElement) {
      btnOut.disabled = pxPerSec <= ZOOM_MIN * 1.001;
    }
  }

  /**
   * Zoom so that roughly `windowSec` of timeline fits the track viewport.
   * windowSec <= 0 → full duration (default for 2:50 etc).
   * @param {number} windowSec
   * @param {number} [windowStartSec] left edge of the window (default: keep/playhead)
   */
  function setViewWindow(windowSec, windowStartSec) {
    const total = Math.max(0.5, duration());
    const trackW = visibleTrackWidth();
    let win = Number(windowSec);

    if (!Number.isFinite(win) || win <= 0 || win >= total * 0.98) {
      viewWindowSec = 0;
      fit();
      return;
    }

    win = Math.min(win, total);
    viewWindowSec = win;
    const pps = trackW / win;

    let start = Number(windowStartSec);
    if (!Number.isFinite(start)) {
      // Prefer keep current left edge; else place playhead near left 15%
      const cur = getVisibleRange().start;
      const video = opts.getVideo?.();
      const t = video && Number.isFinite(video.currentTime) ? video.currentTime : cur;
      start = Math.max(0, t - win * 0.15);
    }
    start = Math.min(Math.max(0, start), Math.max(0, total - win));

    pxPerSec = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pps));
    render();
    if (el.scroll) {
      el.scroll.scrollLeft = Math.max(0, start * pxPerSec);
    }
    updateZoomReadout();
  }

  /** Page the visible window left/right by one window width (0–10 → 10–20). */
  function pageViewWindow(dir) {
    const { start, span, total } = getVisibleRange();
    const win = viewWindowSec > 0 ? viewWindowSec : span;
    let nextStart = start + (dir < 0 ? -win : win);
    nextStart = Math.min(Math.max(0, nextStart), Math.max(0, total - win * 0.5));
    if (viewWindowSec > 0) {
      setViewWindow(viewWindowSec, nextStart);
    } else {
      if (el.scroll) el.scroll.scrollLeft = Math.max(0, nextStart * pxPerSec);
      updateZoomReadout();
    }
  }

  /**
   * Set zoom level, keeping anchorSec at a stable screen position.
   * @param {number} nextPxPerSec
   * @param {number} [anchorSec] time under cursor / playhead
   * @param {number} [anchorClientX] screen x of anchor (optional)
   */
  function setZoom(nextPxPerSec, anchorSec, anchorClientX) {
    const prev = pxPerSec;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(nextPxPerSec) || prev));
    if (!(next > 0) || !Number.isFinite(next)) {
      updateZoomReadout();
      return;
    }
    // Relative epsilon: at high zoom, absolute 1e-6 is meaningless; at low zoom, need real change
    if (Math.abs(next - prev) / Math.max(prev, next, 1) < 0.001) {
      updateZoomReadout();
      return;
    }

    // Prefer explicit anchor, else playhead, else viewport center time
    let anchor = Number(anchorSec);
    if (!Number.isFinite(anchor)) {
      const video = opts.getVideo?.();
      if (video && Number.isFinite(video.currentTime)) {
        anchor = video.currentTime;
      } else {
        const scroll = el.scroll;
        const midX =
          (scroll?.scrollLeft || 0) +
          Math.max(0, (scroll?.clientWidth || 0) / 2 - LABEL_W);
        anchor = Math.max(0, midX / Math.max(prev, 1e-6));
      }
    }

    // Free zoom → leave preset mode
    viewWindowSec = -1;
    pxPerSec = next;
    render();

    // Restore scroll so anchor stays put
    if (el.scroll && Number.isFinite(anchor)) {
      let targetScroll;
      if (Number.isFinite(anchorClientX) && el.scroll.getBoundingClientRect) {
        const rect = el.scroll.getBoundingClientRect();
        // Track area starts after sticky label; map clientX → time offset in view
        const offsetInView = Math.max(0, anchorClientX - rect.left - LABEL_W);
        targetScroll = anchor * pxPerSec - offsetInView;
      } else {
        const viewW = visibleTrackWidth();
        targetScroll = anchor * pxPerSec - viewW * 0.35;
      }
      el.scroll.scrollLeft = Math.max(0, targetScroll);
    }
    updateZoomReadout();
  }

  /**
   * Adaptive step: zoom out must drop quickly from high zoom (ms view → overview),
   * otherwise many clicks appear to "do nothing".
   * @param {'in' | 'out'} dir
   */
  function zoomStepFactor(dir) {
    if (dir === 'in') {
      if (pxPerSec < 20) return 1.6;
      if (pxPerSec < 100) return 1.5;
      if (pxPerSec < 500) return 1.45;
      return 1.4;
    }
    // out
    if (pxPerSec > 1500) return 1 / 3;
    if (pxPerSec > 600) return 1 / 2.5;
    if (pxPerSec > 150) return 1 / 2;
    if (pxPerSec > 40) return 1 / 1.7;
    return 1 / 1.5;
  }

  function zoomBy(factor, anchorSec, anchorClientX) {
    setZoom(pxPerSec * factor, anchorSec, anchorClientX);
  }

  function zoomIn(anchorSec, anchorClientX) {
    zoomBy(zoomStepFactor('in'), anchorSec, anchorClientX);
  }

  function zoomOut(anchorSec, anchorClientX) {
    zoomBy(zoomStepFactor('out'), anchorSec, anchorClientX);
  }

  function tickStep() {
    // Prefer finer ticks when zoomed in — but never so fine we spawn thousands of nodes
    const target = 80 / pxPerSec;
    const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) {
      if (s >= target) return s;
    }
    return 600;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Round to whole milliseconds */
  function roundMs(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  function renderRuler(dur) {
    const w = LABEL_W + dur * pxPerSec + 40;
    el.canvas.style.width = `${Math.max(w, el.scroll?.clientWidth || 0)}px`;
    let step = tickStep();
    let minor = step / 2;
    // Hard cap tick count — dense ticks at high zoom previously froze the UI
    // so zoom-out clicks appeared broken (page hung mid-render).
    const MAX_TICKS = 240;
    const est = dur / Math.max(minor, 1e-6);
    if (est > MAX_TICKS) {
      minor = dur / MAX_TICKS;
      step = minor * 2;
    }
    let html = `<div class="tl-ruler-gutter" style="width:${LABEL_W}px"></div><div class="tl-ruler-marks">`;
    for (let t = 0; t <= dur + 1e-9; t += minor) {
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
    el.ruler.style.width = `${Math.max(w, el.scroll?.clientWidth || 0)}px`;
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
    if (document.activeElement !== el.selStart) el.selStart.value = String(roundMs(s));
    if (document.activeElement !== el.selEnd) el.selEnd.value = String(roundMs(e));
    if (document.activeElement !== el.selText) el.selText.value = c.text || '';
    el.selDur.textContent = `長度 ${formatTime(e - s)} (${Math.round((e - s) * 1000)} ms)`;
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
    updateZoomReadout();
  }

  function fit() {
    viewWindowSec = 0;
    const scrollW = visibleTrackWidth();
    const dur = Math.max(0.5, duration());
    // Default: entire media (e.g. 2:50) visible at once
    const fitted = scrollW / dur;
    // Bypass setZoom free-zoom flag: write directly
    const prev = pxPerSec;
    pxPerSec = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fitted));
    if (Math.abs(pxPerSec - prev) / Math.max(prev, 1) > 0.001 || true) {
      render();
    }
    if (el.scroll) el.scroll.scrollLeft = 0;
    updateZoomReadout();
  }

  /** Zoom out until the whole timeline is clearly smaller than the viewport */
  function zoomOverview() {
    viewWindowSec = -1;
    const scrollW = visibleTrackWidth();
    const dur = Math.max(0.5, duration());
    const overview = (scrollW / dur) * 0.6;
    pxPerSec = Math.max(ZOOM_MIN, overview);
    render();
    if (el.scroll) el.scroll.scrollLeft = 0;
    updateZoomReadout();
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

  root.querySelector('[data-tl="zoom-in"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Prefer stepping through presets when one is active: 全長→30→10→5→1
    const presets = [0, 30, 10, 5, 1];
    if (viewWindowSec >= 0) {
      const i = presets.indexOf(viewWindowSec);
      if (i >= 0 && i < presets.length - 1) {
        setViewWindow(presets[i + 1], getVisibleRange().start);
        return;
      }
      if (viewWindowSec === 0) {
        setViewWindow(30, 0);
        return;
      }
    }
    const video = opts.getVideo?.();
    const anchor =
      video && Number.isFinite(video.currentTime) ? video.currentTime : undefined;
    zoomIn(anchor);
  });
  root.querySelector('[data-tl="zoom-out"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const presets = [0, 30, 10, 5, 1];
    if (viewWindowSec > 0) {
      const i = presets.indexOf(viewWindowSec);
      if (i > 0) {
        setViewWindow(presets[i - 1], getVisibleRange().start);
        return;
      }
    }
    // From free zoom or 1s window → step toward full
    const { span, start } = getVisibleRange();
    const total = duration();
    if (span < total * 0.95) {
      // Jump to next coarser preset by span
      if (span <= 1.5) setViewWindow(5, start);
      else if (span <= 7) setViewWindow(10, start);
      else if (span <= 20) setViewWindow(30, start);
      else fit();
      return;
    }
    zoomOverview();
  });
  root.querySelector('[data-tl="fit"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fit();
  });
  root.querySelector('[data-tl="page-prev"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    pageViewWindow(-1);
  });
  root.querySelector('[data-tl="page-next"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    pageViewWindow(1);
  });
  root.querySelectorAll('.tl-view-preset').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const w = Number(btn.getAttribute('data-window'));
      if (w === 0) fit();
      else setViewWindow(w, getVisibleRange().start);
    });
  });
  root.querySelector('[data-tl="snap"]')?.addEventListener('change', (e) => {
    snapEnabled = Boolean(/** @type {HTMLInputElement} */ (e.target).checked);
  });

  el.scroll?.addEventListener(
    'scroll',
    () => {
      updateZoomReadout();
    },
    { passive: true },
  );
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

  // Zoom: Ctrl/Meta/Alt + wheel (Alt avoids browser page-zoom on some systems)
  el.scroll.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const track = el.rows?.querySelector('.tl-row-track');
      let anchorSec = 0;
      if (track) {
        const rect = track.getBoundingClientRect();
        anchorSec = Math.max(0, (e.clientX - rect.left) / Math.max(pxPerSec, 1e-6));
      } else {
        const video = opts.getVideo?.();
        anchorSec = video?.currentTime || 0;
      }
      if (e.deltaY > 0) zoomOut(anchorSec, e.clientX);
      else zoomIn(anchorSec, e.clientX);
    },
    { passive: false },
  );

  // Double-click ruler → zoom in at that time
  el.ruler.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const track = el.rows?.querySelector('.tl-row-track');
    let anchorSec = 0;
    if (track) {
      const rect = track.getBoundingClientRect();
      anchorSec = Math.max(0, (e.clientX - rect.left) / Math.max(pxPerSec, 1e-6));
    }
    zoomIn(anchorSec, e.clientX);
    zoomIn(anchorSec, e.clientX);
  });

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
        el.selStart.value = String(roundMs(s));
        el.selEnd.value = String(roundMs(end));
        el.selDur.textContent = `長度 ${formatTime(end - s)} (${Math.round((end - s) * 1000)} ms)`;
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
      el.selStart.value = String(roundMs(s));
      el.selEnd.value = String(roundMs(end));
      el.selDur.textContent = `長度 ${formatTime(end - s)} (${Math.round((end - s) * 1000)} ms)`;
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

  // Undo/redo + zoom keys when focus is in timeline panel
  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod) {
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        opts.onUndo?.();
        return;
      }
      if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        opts.onRedo?.();
        return;
      }
      // Ctrl+= / Ctrl+- zoom (and numpad)
      if (key === '=' || key === '+' || e.key === 'Add') {
        e.preventDefault();
        zoomIn(opts.getVideo?.()?.currentTime);
        return;
      }
      if (key === '-' || key === '_' || e.key === 'Subtract') {
        e.preventDefault();
        zoomOut(opts.getVideo?.()?.currentTime);
        return;
      }
      if (key === '0') {
        e.preventDefault();
        fit();
        return;
      }
      return;
    }
    // = / - without modifier when timeline focused
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn(opts.getVideo?.()?.currentTime);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut(opts.getVideo?.()?.currentTime);
    }
  });

  el.scroll.addEventListener('keydown', (e) => {
    // Ctrl+Z / Y handled on root
    if (e.ctrlKey || e.metaKey) return;
    const chunks = opts.getChunks();
    if (!chunks?.length || selectedIdx < 0) return;
    // Arrow: 1ms ; Shift+Arrow: 10ms
    const step = e.shiftKey ? 0.01 : 0.001;
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
