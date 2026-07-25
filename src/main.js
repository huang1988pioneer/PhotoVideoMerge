import './style.css';
import { extractFrames, formatBytes, formatDuration } from './frames.js';
import { LOOP_LIMITS, mergeVideos, embedSubtitlesIntoVideo } from './merge.js';
import {
  saveClips,
  loadClips,
  clearClips,
  saveAudio,
  loadAudio,
  clearStoredAudio,
  savePreview,
  loadPreview,
  clearStoredPreview,
} from './clipStore.js';
import {
  getMediaDuration,
  tileChunksToDuration,
  chunksToSrt,
  chunksToVtt,
  transcribeAudioToSubtitles,
  scriptToSubtitles,
  resolveSubtitleTimeline,
  shiftChunks,
  shiftChunksFrom,
} from './subtitle.js';
import { createSubtitleTimeline, rechainSubtitleChunks } from './timeline.js';

/** @typedef {{
 *   id: string,
 *   file: File,
 *   name: string,
 *   size: number,
 *   firstFrame: string | null,
 *   lastFrame: string | null,
 *   duration: number | null,
 *   width: number | null,
 *   height: number | null,
 *   status: 'loading' | 'ready' | 'error',
 *   error: string | null,
 * }} Clip */

/** @type {Clip[]} */
let clips = [];
let merging = false;
/** True while embedding adjusted subtitles into the final export */
let exporting = false;
/** @type {string | null} */
let resultUrl = null;
/** Preview video blob kept for final subtitle mux (no re-merge of clips) */
/** @type {Blob | null} */
let previewBlob = null;
/** @type {string | null} */
let finalUrl = null;
/** Preview has soft captions; formal file not yet exported */
let isSubtitlePreviewMode = false;
/** Formal export finished for current preview */
let hasFinalExport = false;
/** @type {File | null} */
let audioFile = null;
/** @type {string | null} */
let lastSrtUrl = null;
/** @type {string | null} */
let lastVttUrl = null;
/** @type {string | null} */
let lastSrtText = null;
/** @type {string | null} */
let lastSrtFilename = null;
/** @type {{ timestamp: [number, number], text: string }[] | null} */
let lastChunks = null;       // working chunks (may have preview offsets applied)
let savedBaseChunks = null;  // pristine base — never modified, used to recompute from scratch
/** @type {number} */
let lastCycleDur = 0;
/** @type {number} */
let lastTotalDur = 0;
/** Total global offset currently applied to all chunks in the preview (s) */
let previewExtraOffset = 0;
/** Partial-offset state: applied to chunks[previewPartialFrom:] on top of global offset */
let previewPartialFrom = 0;   // 0-based chunk index where the partial shift begins
let previewPartialDelta = 0;  // total partial delta currently baked into lastChunks
/** Script text that produced current subtitle chunks (for reuse until manual clear) */
let lastScriptSource = null;

/** Undo/redo stack for subtitle timeline (free edits + offsets) */
/** @type {{ timestamp: [number, number], text: string }[][]} */
let subHistory = [];
/** Index into subHistory; -1 = empty */
let subHistoryIndex = -1;
const SUB_HISTORY_MAX = 60;
/** Snapshot at last「產生預覽」— one-click restore */
/** @type {{ timestamp: [number, number], text: string }[] | null} */
let subHistoryBaseline = null;

const SCRIPT_STORE_KEY = 'videomerge.scriptText';
const SCRIPT_OPT_KEY = 'videomerge.optScriptSubs';
const SUB_SESSION_KEY = 'videomerge.subSession';
const LOOP_STORE_KEY = 'videomerge.loopOptions';

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="site-header">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M4 6h7v12H4V6zm9 0h7v12h-7V6z"/>
          <path d="M11 10.5l3.5 1.5-3.5 1.5v-3z" fill="oklch(0.12 0 0)"/>
        </svg>
      </div>
      <div class="brand-text">
        <h1>VideoMerge</h1>
        <p>首尾幀預覽 · 多段合併</p>
      </div>
    </div>
    <div class="header-meta" id="header-meta">本機處理 · 不上傳伺服器</div>
  </header>

  <main class="main">
    <section class="panel" aria-labelledby="upload-title">
      <div class="panel-head">
        <h2 id="upload-title">加入影片</h2>
        <p class="hint">支援 MP4、WebM、MOV 等瀏覽器可播放格式</p>
      </div>

      <label class="dropzone" id="dropzone" for="file-input">
        <input
          id="file-input"
          type="file"
          accept="video/*"
          multiple
          aria-label="選擇影片檔案"
        />
        <div class="dropzone-inner">
          <div class="dropzone-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 16V4M12 4l-4 4M12 4l4 4"/>
              <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>
            </svg>
          </div>
          <strong>拖曳影片到這裡，或點擊選擇</strong>
          <span>可一次加入多個檔案；清單會保留到按「清除全部」為止（重新整理也不會消失）</span>
        </div>
      </label>

      <div class="toolbar">
        <button type="button" class="btn btn-ghost" id="btn-add-more">再加入影片</button>
        <button type="button" class="btn btn-danger" id="btn-clear" disabled>清除全部</button>
        <label class="opt-check" for="opt-no-audio" title="合併時移除所有音軌">
          <input type="checkbox" id="opt-no-audio" />
          <span>不要聲音</span>
        </label>
      </div>

      <div class="extend-panel" aria-labelledby="extend-title">
        <div class="extend-head">
          <h3 id="extend-title">延長 / 循環</h3>
          <p class="hint" id="extend-estimate">可依次數或目標時長自動重複並裁切（設定會保留到按「清除全部」）</p>
        </div>

        <div class="extend-modes" role="radiogroup" aria-label="延長方式">
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="once" checked />
            <span>播一次</span>
          </label>
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="count" />
            <span>重複次數</span>
          </label>
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="duration" />
            <span>目標時長</span>
          </label>
        </div>

        <div class="extend-fields" id="extend-fields-count" hidden>
          <label class="field" for="loop-count">
            <span class="field-label">重複幾次（整段序列）</span>
            <input
              type="number"
              id="loop-count"
              min="1"
              max="${LOOP_LIMITS.maxCount}"
              value="2"
              step="1"
              inputmode="numeric"
            />
          </label>
          <p class="field-hint">例如 3 = 依序播完整段合併結果共 3 遍</p>
        </div>

        <div class="extend-fields" id="extend-fields-duration" hidden>
          <div class="field-row">
            <label class="field" for="loop-hours">
              <span class="field-label">時</span>
              <input type="number" id="loop-hours" min="0" max="2" value="0" step="1" inputmode="numeric" />
            </label>
            <label class="field" for="loop-mins">
              <span class="field-label">分</span>
              <input type="number" id="loop-mins" min="0" max="59" value="1" step="1" inputmode="numeric" />
            </label>
            <label class="field" for="loop-secs">
              <span class="field-label">秒</span>
              <input type="number" id="loop-secs" min="0" max="59" value="0" step="1" inputmode="numeric" />
            </label>
          </div>
          <p class="field-hint">
            會自動循環整段內容，再裁切到目標時長（上限 ${LOOP_LIMITS.maxDurationSec / 3600} 小時）。時長設定會保留到按「清除全部」。
          </p>
        </div>
      </div>

      <div class="audio-panel" aria-labelledby="audio-title">
        <div class="extend-head">
          <h3 id="audio-title">自訂音軌</h3>
          <p class="hint" id="audio-hint">可選 MP3 當作影片聲音（取代原音；會保留到按「清除」或「清除全部」）</p>
        </div>
        <div class="audio-row">
          <input
            type="file"
            id="audio-input"
            accept="audio/mpeg,audio/mp3,audio/wav,audio/x-m4a,audio/mp4,audio/aac,audio/*"
            hidden
          />
          <button type="button" class="btn btn-ghost" id="btn-pick-audio">選擇 MP3</button>
          <button type="button" class="btn btn-danger btn-sm" id="btn-clear-audio" disabled>清除</button>
          <span class="audio-name" id="audio-name">未選擇音訊</span>
        </div>
        <div class="audio-sub-row">
          <label class="opt-check" for="opt-auto-subs" title="依 MP3 語音自動產生字幕（需網路下載模型，較慢）">
            <input type="checkbox" id="opt-auto-subs" />
            <span>依音軌自動辨識字幕</span>
          </label>
          <label class="field field-inline" for="sub-lang">
            <span class="field-label">辨識語言</span>
            <select id="sub-lang" class="field-select">
              <option value="chinese" selected>中文</option>
              <option value="english">英文</option>
              <option value="auto">自動偵測</option>
            </select>
          </label>
        </div>
        <p class="field-hint">
          勾選「不要聲音」時會忽略此音軌。音訊比影片短會循環，比影片長則裁到影片長度。
          「依音軌自動辨識」需下載 Whisper 模型，較慢；有現成講稿時建議用下方語音稿。
        </p>
      </div>

      <div class="script-panel" aria-labelledby="script-title">
        <div class="extend-head">
          <h3 id="script-title">語音稿字幕</h3>
          <p class="hint" id="script-hint">貼上講稿後，依影片時長自動切句上字幕（免下載模型）</p>
        </div>
        <div class="script-toolbar">
          <label class="opt-check" for="opt-script-subs" title="使用下方語音稿產生字幕">
            <input type="checkbox" id="opt-script-subs" />
            <span>使用語音稿上字幕</span>
          </label>
          <input type="file" id="script-file" accept=".txt,.srt,.vtt,text/plain" hidden />
          <button type="button" class="btn btn-ghost btn-sm" id="btn-load-script">上傳稿件</button>
          <button type="button" class="btn btn-danger btn-sm" id="btn-clear-script" disabled>清除稿件</button>
        </div>
        <textarea
          id="script-text"
          class="script-textarea"
          rows="6"
          placeholder="在此貼上語音稿（純文字）。也支援已有時間軸的 SRT / VTT，或 [00:01-00:03] 字幕 格式。&#10;&#10;範例：&#10;大家好，歡迎收看本期節目。&#10;今天我們來介紹影片合併功能。"
        ></textarea>
        <div class="script-sync-row">
          <label class="field field-inline" for="sub-offset" title="正數：字幕延後；負數：字幕提前">
            <span class="field-label">初始偏移（秒）</span>
            <input
              type="number"
              id="sub-offset"
              class="field-select"
              value="0"
              step="0.1"
              min="-30"
              max="30"
              inputmode="decimal"
            />
          </label>
          <span class="field-hint script-sync-hint" id="offset-hint">
            產生預覽時套用；之後可在預覽區用「第一句開始／整體偏移」再細調。
          </span>
        </div>
        <p class="field-hint">
          純文字依標點／換行切句，並依語速比例對齊音軌。有時間軸的 SRT 最準。語音稿與字幕（含時間軸調整）會保留到你按「清除稿件」為止，重新整理或清除影片也不會消失。
        </p>
      </div>
    </section>

    <section class="panel" aria-labelledby="clips-title">
      <div class="panel-head">
        <h2 id="clips-title">片段與首尾幀</h2>
        <p class="hint" id="clips-count">尚未加入影片</p>
      </div>
      <div id="clips-root">
        <div class="empty-state">
          <p>加入影片後，這裡會顯示每段的<strong>首幀</strong>與<strong>尾幀</strong>預覽。</p>
        </div>
      </div>

      <div class="merge-action" id="merge-action">
        <div class="merge-action-text">
          <strong>準備就緒後產生預覽</strong>
          <span class="field-hint" id="merge-action-hint">先設定延長、音軌與字幕，再按下方按鈕（尚未正式輸出）</span>
        </div>
        <button type="button" class="btn btn-primary btn-merge-cta" id="btn-merge" disabled>
          產生預覽
        </button>
      </div>

      <div class="progress-block" id="progress-block" aria-live="polite">
        <div class="progress-label">
          <strong id="progress-status">準備中…</strong>
          <span id="progress-pct">0%</span>
        </div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
        <pre class="log-box" id="log-box" hidden></pre>
      </div>

      <div class="result-block" id="result-block">
        <div class="result-collapsed" id="result-collapsed" hidden>
          <div class="result-collapsed-text">
            <strong id="collapsed-title">上次預覽已保留</strong>
            <span id="collapsed-sub">可重新開啟預覽；調整字幕後再正式輸出</span>
          </div>
          <div class="result-collapsed-actions">
            <button type="button" class="btn btn-primary btn-sm" id="btn-show-result">顯示預覽</button>
            <a class="btn btn-ghost btn-sm" id="btn-download-collapsed" download="merged.mp4" hidden>下載影片</a>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-download-srt-collapsed" hidden>
              下載 SRT
            </button>
            <button type="button" class="btn btn-danger btn-sm" id="btn-clear-preview-collapsed" hidden>
              清除預覽
            </button>
          </div>
        </div>
        <div class="result-body" id="result-body">
          <div class="workflow-steps" id="workflow-steps" hidden aria-label="輸出流程">
            <div class="workflow-step is-done" data-step="1"><span class="workflow-num">1</span> 產生預覽</div>
            <div class="workflow-step is-active" data-step="2"><span class="workflow-num">2</span> 調整字幕軸</div>
            <div class="workflow-step" data-step="3"><span class="workflow-num">3</span> 正式輸出</div>
          </div>
          <h3 id="result-title">預覽影片</h3>
          <p class="field-hint" id="result-phase-hint">
            這是<strong>預覽</strong>（會保留到你重新「產生預覽」或按「清除預覽」）。可播放、對字幕後再正式輸出。
          </p>
          <div class="result-video-shell">
            <video class="result-video" id="result-video" controls playsinline crossorigin="anonymous">
              <track id="result-track" kind="subtitles" srclang="zh" label="預覽字幕" default hidden />
            </video>
            <div class="result-timecode" id="result-timecode" aria-live="off" title="目前時間 / 總長（毫秒）">
              <span class="result-timecode-cur" id="result-timecode-cur">0:00.000</span>
              <span class="result-timecode-sep">/</span>
              <span class="result-timecode-dur" id="result-timecode-dur">0:00.000</span>
            </div>
          </div>
          <p class="field-hint" id="subs-result-hint" hidden></p>
          <div class="subs-preview" id="subs-preview" hidden>
            <div class="subs-preview-head">字幕軸手動調整（剪輯軟體風格時間軸 · 即時套到上方預覽）</div>
            <div id="subs-timeline" class="subs-timeline" aria-label="圖像化字幕時間軸"></div>
            <details class="subs-numeric-panel">
              <summary>數值微調（可選）</summary>
              <div class="subs-adjust-row" id="subs-first-row">
                <label class="field field-inline" for="subs-first-start">
                  <span class="field-label">第一句開始（秒）</span>
                  <input
                    type="number"
                    id="subs-first-start"
                    class="field-select"
                    value="0"
                    step="0.001"
                    min="0"
                    max="999"
                    inputmode="decimal"
                  />
                </label>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-subs-first">套用第一句時間</button>
                <span class="field-hint" id="subs-first-hint">例如填 6.350（支援毫秒）；後句依「後句自動」銜接或平移</span>
              </div>
              <div class="subs-adjust-row" id="subs-adjust-row">
                <label class="field field-inline" for="subs-adjust-offset">
                  <span class="field-label">整體偏移（秒）</span>
                  <input
                    type="number"
                    id="subs-adjust-offset"
                    class="field-select"
                    value="0"
                    step="0.001"
                    min="-999"
                    max="999"
                    inputmode="decimal"
                  />
                </label>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-subs-adjust">套用全體偏移</button>
                <span class="field-hint subs-adjust-hint" id="subs-adjust-hint">正數＝字幕延後；負數＝字幕提前（可至毫秒）</span>
              </div>
              <div class="subs-adjust-row" id="subs-partial-row">
                <span class="field-label" style="white-space:nowrap">從第</span>
                <input
                  type="number"
                  id="subs-partial-from"
                  class="field-select"
                  value="1"
                  min="1"
                  step="1"
                  style="width:4.5rem"
                  inputmode="numeric"
                />
                <span class="field-label" style="white-space:nowrap">句起，再偏移</span>
                <input
                  type="number"
                  id="subs-partial-offset"
                  class="field-select"
                  value="0"
                  step="0.001"
                  min="-999"
                  max="999"
                  style="width:5.5rem"
                  inputmode="decimal"
                />
                <span class="field-label">秒</span>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-subs-partial">套用區段偏移</button>
                <span class="field-hint" id="subs-partial-hint">可在全體偏移之上，對後半段再細調</span>
              </div>
            </details>
            <details class="subs-srt-raw">
              <summary>原始 SRT 文字（除錯用）</summary>
              <pre class="subs-preview-body" id="subs-preview-body"></pre>
            </details>
          </div>
          <div class="result-actions" id="result-actions">
            <button type="button" class="btn btn-primary" id="btn-export-final" hidden>
              正式輸出影片
            </button>
            <a class="btn btn-primary" id="btn-download" download="merged.mp4" hidden>下載正式影片</a>
            <a class="btn btn-ghost" id="btn-download-preview" download="preview.mp4" hidden>下載預覽影片（無嵌入字幕）</a>
            <button type="button" class="btn btn-ghost" id="btn-download-srt" hidden>
              下載 SRT 字幕
            </button>
            <button type="button" class="btn btn-danger" id="btn-clear-preview" hidden>
              清除預覽
            </button>
            <button type="button" class="btn btn-ghost" id="btn-dismiss-result">收合預覽</button>
          </div>
          <p class="field-hint" id="export-status-hint" hidden></p>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <p>使用瀏覽器內 FFmpeg 處理 · 畫面幀以 Canvas 擷取 · 資料不離開你的裝置</p>
  </footer>

  <div class="toast-region" id="toast-region" aria-live="assertive"></div>
`;

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  btnAddMore: document.getElementById('btn-add-more'),
  btnClear: document.getElementById('btn-clear'),
  btnMerge: document.getElementById('btn-merge'),
  mergeActionHint: document.getElementById('merge-action-hint'),
  optNoAudio: document.getElementById('opt-no-audio'),
  loopCount: document.getElementById('loop-count'),
  loopHours: document.getElementById('loop-hours'),
  loopMins: document.getElementById('loop-mins'),
  loopSecs: document.getElementById('loop-secs'),
  extendFieldsCount: document.getElementById('extend-fields-count'),
  extendFieldsDuration: document.getElementById('extend-fields-duration'),
  extendEstimate: document.getElementById('extend-estimate'),
  audioInput: document.getElementById('audio-input'),
  btnPickAudio: document.getElementById('btn-pick-audio'),
  btnClearAudio: document.getElementById('btn-clear-audio'),
  audioName: document.getElementById('audio-name'),
  audioHint: document.getElementById('audio-hint'),
  optAutoSubs: document.getElementById('opt-auto-subs'),
  subLang: document.getElementById('sub-lang'),
  optScriptSubs: document.getElementById('opt-script-subs'),
  scriptText: document.getElementById('script-text'),
  scriptFile: document.getElementById('script-file'),
  btnLoadScript: document.getElementById('btn-load-script'),
  btnClearScript: document.getElementById('btn-clear-script'),
  scriptHint: document.getElementById('script-hint'),
  subOffset: document.getElementById('sub-offset'),
  offsetHint: document.getElementById('offset-hint'),
  resultTrack: document.getElementById('result-track'),
  btnDownloadSrt: document.getElementById('btn-download-srt'),
  subsResultHint: document.getElementById('subs-result-hint'),
  subsPreview: document.getElementById('subs-preview'),
  subsPreviewBody: document.getElementById('subs-preview-body'),
  subsAdjustRow: document.getElementById('subs-adjust-row'),
  subsAdjustOffset: document.getElementById('subs-adjust-offset'),
  btnSubsAdjust: document.getElementById('btn-subs-adjust'),
  subsAdjustHint: document.getElementById('subs-adjust-hint'),
  subsPartialRow: document.getElementById('subs-partial-row'),
  subsPartialFrom: document.getElementById('subs-partial-from'),
  subsPartialOffset: document.getElementById('subs-partial-offset'),
  btnSubsPartial: document.getElementById('btn-subs-partial'),
  subsPartialHint: document.getElementById('subs-partial-hint'),
  subsFirstStart: document.getElementById('subs-first-start'),
  btnSubsFirst: document.getElementById('btn-subs-first'),
  subsFirstHint: document.getElementById('subs-first-hint'),
  subsTimeline: document.getElementById('subs-timeline'),
  clipsRoot: document.getElementById('clips-root'),
  clipsCount: document.getElementById('clips-count'),
  progressBlock: document.getElementById('progress-block'),
  progressStatus: document.getElementById('progress-status'),
  progressPct: document.getElementById('progress-pct'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  logBox: document.getElementById('log-box'),
  resultBlock: document.getElementById('result-block'),
  resultBody: document.getElementById('result-body'),
  resultCollapsed: document.getElementById('result-collapsed'),
  resultVideo: document.getElementById('result-video'),
  resultTimecode: document.getElementById('result-timecode'),
  resultTimecodeCur: document.getElementById('result-timecode-cur'),
  resultTimecodeDur: document.getElementById('result-timecode-dur'),
  resultTitle: document.getElementById('result-title'),
  resultPhaseHint: document.getElementById('result-phase-hint'),
  workflowSteps: document.getElementById('workflow-steps'),
  btnExportFinal: document.getElementById('btn-export-final'),
  btnDownloadPreview: document.getElementById('btn-download-preview'),
  exportStatusHint: document.getElementById('export-status-hint'),
  collapsedTitle: document.getElementById('collapsed-title'),
  collapsedSub: document.getElementById('collapsed-sub'),
  btnDownload: document.getElementById('btn-download'),
  btnDownloadCollapsed: document.getElementById('btn-download-collapsed'),
  btnDownloadSrtCollapsed: document.getElementById('btn-download-srt-collapsed'),
  btnShowResult: document.getElementById('btn-show-result'),
  btnDismissResult: document.getElementById('btn-dismiss-result'),
  btnClearPreview: document.getElementById('btn-clear-preview'),
  btnClearPreviewCollapsed: document.getElementById('btn-clear-preview-collapsed'),
  toastRegion: document.getElementById('toast-region'),
  headerMeta: document.getElementById('header-meta'),
};

/** @type {ReturnType<typeof createSubtitleTimeline> | null} */
let subtitleTimeline = null;

function ensureSubtitleTimeline() {
  if (subtitleTimeline || !els.subsTimeline) return subtitleTimeline;
  subtitleTimeline = createSubtitleTimeline(els.subsTimeline, {
    getChunks: () => lastChunks,
    getDuration: () => {
      const v = els.resultVideo;
      if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
      return lastTotalDur || lastCycleDur || 0;
    },
    getVideo: () => els.resultVideo,
    onChange: (chunks) => commitFreeTimelineChunks(chunks),
    onUndo: () => undoTimeline(),
    onRedo: () => redoTimeline(),
    onRestoreBaseline: () => restoreTimelineBaseline(),
    onSeek: (sec) => {
      if (els.resultVideo && Number.isFinite(sec)) {
        try {
          els.resultVideo.currentTime = sec;
        } catch {
          /* ignore */
        }
      }
    },
    formatTime: (sec) => formatTimecodeMs(sec),
  });
  syncTimelineUndoUI();
  return subtitleTimeline;
}

/**
 * Display time with millisecond precision: m:ss.mmm or h:mm:ss.mmm
 * @param {number} sec
 * @returns {string}
 */
function formatTimecodeMs(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
  }
  return `${m}:${pad2(s)}.${pad3(ms)}`;
}

/** Keep preview player clock at millisecond resolution. */
function bindResultTimecode() {
  const video = els.resultVideo;
  if (!video || video._tcBound) return;
  video._tcBound = true;

  const tick = () => {
    if (els.resultTimecodeCur) {
      els.resultTimecodeCur.textContent = formatTimecodeMs(video.currentTime || 0);
    }
    if (els.resultTimecodeDur) {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      els.resultTimecodeDur.textContent = formatTimecodeMs(d);
    }
  };

  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', tick);
  video.addEventListener('loadedmetadata', tick);
  video.addEventListener('durationchange', tick);
  video.addEventListener('play', () => {
    // denser updates while playing (timeupdate is ~4Hz; rAF for smoother ms feel)
    const loop = () => {
      if (video.paused || video.ended) return;
      tick();
      video._tcRaf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(video._tcRaf || 0);
    video._tcRaf = requestAnimationFrame(loop);
  });
  video.addEventListener('pause', () => {
    cancelAnimationFrame(video._tcRaf || 0);
    tick();
  });
  tick();
}

/**
 * @param {{ timestamp: [number, number], text: string }[] | null | undefined} chunks
 */
function cloneChunks(chunks) {
  if (!chunks?.length) return [];
  return chunks.map((c) => ({
    timestamp: [Number(c.timestamp?.[0]) || 0, Number(c.timestamp?.[1]) || 0],
    text: String(c.text ?? ''),
  }));
}

function canUndoTimeline() {
  return subHistoryIndex > 0;
}

function canRedoTimeline() {
  return subHistoryIndex >= 0 && subHistoryIndex < subHistory.length - 1;
}

function syncTimelineUndoUI() {
  const tl = subtitleTimeline;
  tl?.setUndoRedoState?.({
    canUndo: canUndoTimeline(),
    canRedo: canRedoTimeline(),
    canRestoreBaseline: Boolean(subHistoryBaseline?.length),
  });
}

/**
 * Seed or reset undo stack (e.g. after generate preview / restore session).
 * @param {{ timestamp: [number, number], text: string }[]} chunks
 * @param {{ asBaseline?: boolean }} [opts]
 */
function resetSubHistory(chunks, opts = {}) {
  const snap = cloneChunks(chunks);
  subHistory = snap.length ? [snap] : [];
  subHistoryIndex = snap.length ? 0 : -1;
  if (opts.asBaseline !== false && snap.length) {
    subHistoryBaseline = cloneChunks(snap);
  }
  syncTimelineUndoUI();
}

/**
 * Push current lastChunks onto history after a successful edit.
 * Call only after lastChunks has been updated.
 */
function pushSubHistoryFromCurrent() {
  if (!lastChunks?.length) return;
  const snap = cloneChunks(lastChunks);
  // Drop redo branch
  if (subHistoryIndex < subHistory.length - 1) {
    subHistory = subHistory.slice(0, subHistoryIndex + 1);
  }
  // Skip if identical to current tip
  const tip = subHistory[subHistoryIndex];
  if (tip && chunksEqual(tip, snap)) {
    syncTimelineUndoUI();
    return;
  }
  // Ensure we have a "before" state
  if (subHistoryIndex < 0) {
    subHistory = [snap];
    subHistoryIndex = 0;
  } else {
    subHistory.push(snap);
    subHistoryIndex = subHistory.length - 1;
  }
  while (subHistory.length > SUB_HISTORY_MAX) {
    subHistory.shift();
    subHistoryIndex = Math.max(0, subHistoryIndex - 1);
  }
  syncTimelineUndoUI();
}

/**
 * @param {{ timestamp: [number, number], text: string }[]} a
 * @param {{ timestamp: [number, number], text: string }[]} b
 */
function chunksEqual(a, b) {
  if (a === b) return true;
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text) return false;
    if (Math.abs(a[i].timestamp[0] - b[i].timestamp[0]) > 1e-4) return false;
    if (Math.abs(a[i].timestamp[1] - b[i].timestamp[1]) > 1e-4) return false;
  }
  return true;
}

/**
 * Apply chunks without recording history (undo/redo).
 * @param {{ timestamp: [number, number], text: string }[]} chunks
 */
function applyChunksNoHistory(chunks) {
  if (!chunks?.length) return;
  lastChunks = cloneChunks(chunks);
  savedBaseChunks = cloneChunks(chunks);
  previewExtraOffset = 0;
  previewPartialFrom = 0;
  previewPartialDelta = 0;
  if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
  if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
  if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
  publishSubtitleOutputs({ fromTimeline: true, silentInvalidate: true });
  ensureSubtitleTimeline()?.render();
  syncTimelineUndoUI();
}

function undoTimeline() {
  if (!canUndoTimeline()) {
    toast('沒有可復原的步驟', 'info');
    return;
  }
  subHistoryIndex -= 1;
  applyChunksNoHistory(subHistory[subHistoryIndex]);
  toast(`已復原時間軸（${subHistoryIndex + 1}/${subHistory.length}）`, 'success');
}

function redoTimeline() {
  if (!canRedoTimeline()) {
    toast('沒有可重做的步驟', 'info');
    return;
  }
  subHistoryIndex += 1;
  applyChunksNoHistory(subHistory[subHistoryIndex]);
  toast(`已重做時間軸（${subHistoryIndex + 1}/${subHistory.length}）`, 'success');
}

/** Restore to state right after last「產生預覽」subtitle build */
function restoreTimelineBaseline() {
  if (!subHistoryBaseline?.length) {
    toast('沒有產生預覽時的時間軸可還原', 'error');
    return;
  }
  // Record current then jump to baseline as a new history step
  if (lastChunks?.length && !chunksEqual(lastChunks, subHistoryBaseline)) {
    // ensure current is on stack tip before applying baseline as new edit
    if (subHistoryIndex < 0 || !chunksEqual(subHistory[subHistoryIndex], lastChunks)) {
      pushSubHistoryFromCurrent();
    }
  }
  lastChunks = cloneChunks(subHistoryBaseline);
  savedBaseChunks = cloneChunks(subHistoryBaseline);
  previewExtraOffset = 0;
  previewPartialFrom = 0;
  previewPartialDelta = 0;
  if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
  if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
  if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
  publishSubtitleOutputs({ fromTimeline: true });
  pushSubHistoryFromCurrent();
  ensureSubtitleTimeline()?.render();
  toast('已還原至產生預覽時的時間軸', 'success');
}

/**
 * Free-form NLE edit: lastChunks becomes the new base (offsets reset).
 * @param {{ timestamp: [number, number], text: string }[]} chunks
 * @param {{ recordHistory?: boolean }} [opts]
 */
function commitFreeTimelineChunks(chunks, opts = {}) {
  if (!chunks?.length) return;
  const record = opts.recordHistory !== false;

  // Seed history with state before this edit
  if (record && lastChunks?.length) {
    if (subHistoryIndex < 0) {
      subHistory = [cloneChunks(lastChunks)];
      subHistoryIndex = 0;
    } else if (!chunksEqual(subHistory[subHistoryIndex], lastChunks)) {
      // tip out of sync — push current first
      pushSubHistoryFromCurrent();
    }
  }

  lastChunks = chunks.map((c) => ({
    timestamp: [Number(c.timestamp[0]) || 0, Number(c.timestamp[1]) || 0],
    text: String(c.text ?? ''),
  }));
  savedBaseChunks = lastChunks.map((c) => ({
    timestamp: [...c.timestamp],
    text: c.text,
  }));
  previewExtraOffset = 0;
  previewPartialFrom = 0;
  previewPartialDelta = 0;
  if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
  if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
  if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
  publishSubtitleOutputs({ fromTimeline: true });
  if (record) pushSubHistoryFromCurrent();
  else syncTimelineUndoUI();
}

/**
 * Push lastChunks → SRT/VTT track + text preview + invalidate final if needed.
 * @param {{ fromTimeline?: boolean, silentInvalidate?: boolean }} [opts]
 */
function publishSubtitleOutputs(opts = {}) {
  if (!lastChunks?.length) return;

  let displayChunks = lastChunks;
  if (lastTotalDur > lastCycleDur + 0.25 && lastCycleDur > 0.2) {
    displayChunks = tileChunksToDuration(lastChunks, lastCycleDur, lastTotalDur);
  }

  const newSrt = chunksToSrt(displayChunks);
  const newVtt = chunksToVtt(displayChunks);
  lastSrtText = newSrt;

  if (lastSrtUrl) {
    URL.revokeObjectURL(lastSrtUrl);
    lastSrtUrl = null;
  }
  if (lastVttUrl) {
    URL.revokeObjectURL(lastVttUrl);
    lastVttUrl = null;
  }

  lastSrtUrl = URL.createObjectURL(
    new Blob(['\uFEFF' + newSrt], { type: 'application/x-subrip;charset=utf-8' }),
  );
  lastVttUrl = URL.createObjectURL(
    new Blob([newVtt], { type: 'text/vtt;charset=utf-8' }),
  );

  if (els.resultTrack && lastVttUrl) {
    els.resultTrack.src = '';
    setTimeout(() => {
      els.resultTrack.src = lastVttUrl;
      enableSubtitleTrack();
    }, 50);
  }

  if (els.subsPreviewBody) {
    const preview = newSrt.split('\n').slice(0, 60).join('\n');
    els.subsPreviewBody.textContent =
      preview + (newSrt.split('\n').length > 60 ? '\n…' : '');
  }

  if (els.subsFirstStart && lastChunks[0] && document.activeElement !== els.subsFirstStart) {
    els.subsFirstStart.value = String(
      Math.round(Number(lastChunks[0].timestamp[0]) * 1000) / 1000,
    );
  }

  if (hasFinalExport) {
    hasFinalExport = false;
    if (finalUrl) {
      URL.revokeObjectURL(finalUrl);
      finalUrl = null;
    }
    if (!opts.silentInvalidate) {
      toast('字幕已變更，請重新「正式輸出影片」', 'info');
    }
  }
  syncResultPhaseUI();
  // Re-render timeline after numeric tweaks (timeline's own commit already renders)
  if (!opts.fromTimeline) {
    ensureSubtitleTimeline()?.render();
  }
  persistScriptAndSubtitles();
}

function persistScriptAndSubtitles() {
  try {
    const script = els.scriptText?.value ?? '';
    localStorage.setItem(SCRIPT_STORE_KEY, script);
    localStorage.setItem(
      SCRIPT_OPT_KEY,
      els.optScriptSubs?.checked ? '1' : '0',
    );
    if (savedBaseChunks?.length && lastChunks?.length) {
      localStorage.setItem(
        SUB_SESSION_KEY,
        JSON.stringify({
          scriptSource: lastScriptSource ?? script.trim(),
          savedBaseChunks,
          lastChunks,
          lastCycleDur,
          lastTotalDur,
          previewExtraOffset,
          previewPartialFrom,
          previewPartialDelta,
          lastSrtFilename,
        }),
      );
    }
  } catch {
    /* private mode / quota */
  }
}

function restoreScriptAndSubtitles() {
  try {
    const script = localStorage.getItem(SCRIPT_STORE_KEY);
    if (script != null && els.scriptText) {
      els.scriptText.value = script;
    }
    const opt = localStorage.getItem(SCRIPT_OPT_KEY);
    if (els.optScriptSubs && opt != null) {
      els.optScriptSubs.checked = opt === '1';
    } else if (els.optScriptSubs && script?.trim()) {
      els.optScriptSubs.checked = true;
    }

    const raw = localStorage.getItem(SUB_SESSION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.lastChunks) || !data.lastChunks.length) return;
    if (!Array.isArray(data?.savedBaseChunks) || !data.savedBaseChunks.length) return;

    lastScriptSource =
      typeof data.scriptSource === 'string' ? data.scriptSource : null;
    savedBaseChunks = data.savedBaseChunks.map((c) => ({
      timestamp: [Number(c.timestamp?.[0]) || 0, Number(c.timestamp?.[1]) || 0],
      text: String(c.text ?? ''),
    }));
    lastChunks = data.lastChunks.map((c) => ({
      timestamp: [Number(c.timestamp?.[0]) || 0, Number(c.timestamp?.[1]) || 0],
      text: String(c.text ?? ''),
    }));
    lastCycleDur = Number(data.lastCycleDur) || 0;
    lastTotalDur = Number(data.lastTotalDur) || 0;
    previewExtraOffset = Number(data.previewExtraOffset) || 0;
    previewPartialFrom = Math.max(0, Math.floor(Number(data.previewPartialFrom) || 0));
    previewPartialDelta = Number(data.previewPartialDelta) || 0;
    lastSrtFilename =
      typeof data.lastSrtFilename === 'string'
        ? data.lastSrtFilename
        : 'subtitles-restored.srt';
    lastSrtText = chunksToSrt(lastChunks);

    if (els.subsAdjustOffset) {
      els.subsAdjustOffset.value = String(previewExtraOffset);
    }
    if (els.subsPartialFrom) {
      els.subsPartialFrom.value = String(previewPartialFrom + 1);
    }
    if (els.subsPartialOffset) {
      els.subsPartialOffset.value = String(previewPartialDelta);
    }
    // Restore session: seed undo at current state (baseline = restored)
    resetSubHistory(lastChunks, { asBaseline: true });
  } catch {
    /* ignore corrupt storage */
  }
}

/** Wipe script + subtitle session (only via 清除稿件). */
function clearScriptAndSubtitles() {
  lastScriptSource = null;
  lastSrtText = null;
  lastSrtFilename = null;
  lastChunks = null;
  savedBaseChunks = null;
  lastCycleDur = 0;
  lastTotalDur = 0;
  previewExtraOffset = 0;
  previewPartialFrom = 0;
  previewPartialDelta = 0;
  isSubtitlePreviewMode = false;
  subHistory = [];
  subHistoryIndex = -1;
  subHistoryBaseline = null;

  if (lastSrtUrl) {
    URL.revokeObjectURL(lastSrtUrl);
    lastSrtUrl = null;
  }
  if (lastVttUrl) {
    URL.revokeObjectURL(lastVttUrl);
    lastVttUrl = null;
  }
  if (els.resultTrack) {
    els.resultTrack.removeAttribute('src');
    els.resultTrack.default = false;
    els.resultTrack.hidden = true;
  }
  if (els.scriptText) els.scriptText.value = '';
  if (els.optScriptSubs) els.optScriptSubs.checked = false;
  if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
  if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
  if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
  if (els.subsFirstStart) els.subsFirstStart.value = '0';
  if (els.subsPreview) els.subsPreview.hidden = true;
  if (els.subsPreviewBody) els.subsPreviewBody.textContent = '';
  if (els.subsResultHint) {
    els.subsResultHint.hidden = true;
    els.subsResultHint.textContent = '';
  }
  setSrtDownloadVisible(false);

  try {
    localStorage.removeItem(SCRIPT_STORE_KEY);
    localStorage.removeItem(SCRIPT_OPT_KEY);
    localStorage.removeItem(SUB_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Trigger a file download reliably (blob + temporary <a>).
 * @param {string} filename
 * @param {BlobPart} data
 * @param {string} [mime]
 */
function downloadBlob(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoke so the browser can start the download
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadSrt() {
  if (!lastSrtText) {
    toast('目前沒有可下載的字幕', 'error');
    return;
  }
  const name = lastSrtFilename || 'subtitles.srt';
  // UTF-8 BOM helps Windows Notepad / some players recognize Chinese SRT
  const bom = '\uFEFF';
  downloadBlob(name, bom + lastSrtText, 'application/x-subrip;charset=utf-8');
  toast(`已開始下載 ${name}`, 'success');
}

function setSrtDownloadVisible(visible) {
  if (els.btnDownloadSrt) els.btnDownloadSrt.hidden = !visible;
  if (els.btnDownloadSrtCollapsed) els.btnDownloadSrtCollapsed.hidden = !visible;
}

function getLoopMode() {
  const el = document.querySelector('input[name="loop-mode"]:checked');
  return el?.value || 'once';
}

function getTargetSecondsFromFields() {
  const h = Math.max(0, Math.floor(Number(els.loopHours.value) || 0));
  const m = Math.max(0, Math.floor(Number(els.loopMins.value) || 0));
  const s = Math.max(0, Math.floor(Number(els.loopSecs.value) || 0));
  return h * 3600 + m * 60 + s;
}

/** Defaults used after manual clear */
const LOOP_DEFAULTS = {
  mode: 'once',
  count: 2,
  hours: 0,
  mins: 1,
  secs: 0,
};

function persistLoopOptions() {
  try {
    const payload = {
      mode: getLoopMode(),
      count: Math.max(1, Math.floor(Number(els.loopCount?.value) || LOOP_DEFAULTS.count)),
      hours: Math.max(0, Math.floor(Number(els.loopHours?.value) || 0)),
      mins: Math.max(0, Math.floor(Number(els.loopMins?.value) || 0)),
      secs: Math.max(0, Math.floor(Number(els.loopSecs?.value) || 0)),
    };
    localStorage.setItem(LOOP_STORE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode */
  }
}

function restoreLoopOptions() {
  try {
    const raw = localStorage.getItem(LOOP_STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const mode = ['once', 'count', 'duration'].includes(data?.mode)
      ? data.mode
      : LOOP_DEFAULTS.mode;
    const radio = document.querySelector(`input[name="loop-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;

    if (els.loopCount) {
      const c = Math.floor(Number(data.count));
      els.loopCount.value = String(
        Number.isFinite(c) && c >= 1
          ? Math.min(LOOP_LIMITS.maxCount, c)
          : LOOP_DEFAULTS.count,
      );
    }
    if (els.loopHours) {
      const h = Math.floor(Number(data.hours));
      els.loopHours.value = String(
        Number.isFinite(h) && h >= 0 ? Math.min(2, h) : LOOP_DEFAULTS.hours,
      );
    }
    if (els.loopMins) {
      const m = Math.floor(Number(data.mins));
      els.loopMins.value = String(
        Number.isFinite(m) && m >= 0 ? Math.min(59, m) : LOOP_DEFAULTS.mins,
      );
    }
    if (els.loopSecs) {
      const s = Math.floor(Number(data.secs));
      els.loopSecs.value = String(
        Number.isFinite(s) && s >= 0 ? Math.min(59, s) : LOOP_DEFAULTS.secs,
      );
    }
    return true;
  } catch {
    return false;
  }
}

function clearLoopOptions() {
  try {
    localStorage.removeItem(LOOP_STORE_KEY);
  } catch {
    /* ignore */
  }
  const radio = document.querySelector(
    `input[name="loop-mode"][value="${LOOP_DEFAULTS.mode}"]`,
  );
  if (radio) radio.checked = true;
  if (els.loopCount) els.loopCount.value = String(LOOP_DEFAULTS.count);
  if (els.loopHours) els.loopHours.value = String(LOOP_DEFAULTS.hours);
  if (els.loopMins) els.loopMins.value = String(LOOP_DEFAULTS.mins);
  if (els.loopSecs) els.loopSecs.value = String(LOOP_DEFAULTS.secs);
}

function baseSequenceDuration() {
  return clips
    .filter((c) => c.status === 'ready')
    .reduce((sum, c) => sum + (c.duration || 0), 0);
}

/** @returns {{ mode: 'once' | 'count' | 'duration', count?: number, targetSeconds?: number, baseDurationSec?: number }} */
function getLoopOptions() {
  const mode = getLoopMode();
  const baseDurationSec = baseSequenceDuration();
  if (mode === 'count') {
    const count = Math.floor(Number(els.loopCount.value) || 1);
    return { mode: 'count', count, baseDurationSec };
  }
  if (mode === 'duration') {
    return {
      mode: 'duration',
      targetSeconds: getTargetSecondsFromFields(),
      baseDurationSec,
    };
  }
  return { mode: 'once', baseDurationSec };
}

function syncExtendUI() {
  const mode = getLoopMode();
  els.extendFieldsCount.hidden = mode !== 'count';
  els.extendFieldsDuration.hidden = mode !== 'duration';

  const base = baseSequenceDuration();
  const baseLabel = base > 0 ? formatDuration(base) : '—';

  if (mode === 'once') {
    els.extendEstimate.textContent =
      base > 0 ? `輸出約 ${baseLabel}` : '選擇重複次數或目標時長可自動延長';
  } else if (mode === 'count') {
    const count = Math.max(1, Math.floor(Number(els.loopCount.value) || 1));
    const out = base > 0 ? base * count : 0;
    els.extendEstimate.textContent =
      base > 0
        ? `基底 ${baseLabel} × ${count} 次 ≈ ${formatDuration(out)}`
        : `將重複整段序列 ${count} 次`;
  } else {
    const target = getTargetSecondsFromFields();
    if (target <= 0) {
      els.extendEstimate.textContent = '請設定目標時長（時 / 分 / 秒）';
    } else if (base > 0) {
      const loops = Math.ceil(target / base);
      els.extendEstimate.textContent = `基底 ${baseLabel} → 循環約 ${loops} 次，裁切至 ${formatDuration(target)}`;
    } else {
      els.extendEstimate.textContent = `目標時長 ${formatDuration(target)}（加入影片後可預估循環次數）`;
    }
  }

  syncAudioUI();
}

function syncAudioUI() {
  const muted = Boolean(els.optNoAudio.checked);
  const busy = merging || exporting;
  if (audioFile) {
    els.audioName.textContent = audioFile.name;
    els.audioName.title = audioFile.name;
    els.btnClearAudio.disabled = busy;
    els.audioHint.textContent = muted
      ? '已選音軌，但「不要聲音」開啟中，輸出將無聲'
      : `已選：${audioFile.name}（將取代原影片聲音）`;
  } else {
    els.audioName.textContent = '未選擇音訊';
    els.audioName.title = '';
    els.btnClearAudio.disabled = true;
    els.audioHint.textContent = muted
      ? '「不要聲音」已開啟'
      : '可選 MP3 當作影片聲音（取代原音）';
  }

  els.btnPickAudio.disabled = busy || muted;
  els.audioInput.disabled = busy || muted;

  const canSubs = Boolean(audioFile) && !muted;
  els.optAutoSubs.disabled = busy || !canSubs;
  els.subLang.disabled = busy || !canSubs || !els.optAutoSubs.checked;

  const hasScript = Boolean(els.scriptText?.value?.trim());
  if (els.optScriptSubs) els.optScriptSubs.disabled = busy;
  if (els.scriptText) els.scriptText.disabled = busy;
  if (els.btnLoadScript) els.btnLoadScript.disabled = busy;
  if (els.btnClearScript) els.btnClearScript.disabled = busy || !hasScript;
  if (els.subOffset) {
    els.subOffset.disabled = busy;
  }
  if (els.offsetHint) {
    els.offsetHint.textContent =
      '產生預覽時套用；之後可在預覽區用「第一句開始／整體偏移」再細調。';
  }
  if (els.scriptHint) {
    if (hasScript) {
      const n = els.scriptText.value.trim().length;
      els.scriptHint.textContent = els.optScriptSubs?.checked
        ? `將使用語音稿上字幕（${n} 字）`
        : `已輸入稿件 ${n} 字 — 勾選「使用語音稿上字幕」即可套用`;
    } else {
      els.scriptHint.textContent =
        '貼上講稿後，依影片時長自動切句上字幕（免下載模型）';
    }
  }
}

function getScriptText() {
  return (els.scriptText?.value || '').trim();
}

function getManualOffsetSec() {
  const v = Number(els.subOffset?.value);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Apply initial manual offset from the script panel (no auto speech-onset).
 * @param {{ timestamp: [number, number], text: string }[]} chunks
 * @param {File | null} _bgm
 * @param {number} totalDur
 * @param {(msg: string) => void} [log]
 */
function applySubtitleOffset(chunks, _bgm, totalDur, log) {
  const offset = getManualOffsetSec();
  if (Math.abs(offset) < 0.001) return chunks;
  log?.(`初始字幕偏移：${offset > 0 ? '+' : ''}${offset}s`);
  return shiftChunks(chunks, offset, totalDur);
}

function setAudioFile(file, opts = {}) {
  const { silent = false, skipPersist = false } = opts;
  if (!file) {
    audioFile = null;
    if (!skipPersist) {
      clearStoredAudio().catch(() => {});
    }
    syncAudioUI();
    return;
  }
  const okType =
    file.type.startsWith('audio/') ||
    /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
  if (!okType) {
    if (!silent) toast('請選擇音訊檔（建議 MP3）', 'error');
    return;
  }
  audioFile = file;
  if (els.optNoAudio.checked) {
    els.optNoAudio.checked = false;
    if (!silent) toast('已關閉「不要聲音」，以套用自訂音軌');
  }
  if (!skipPersist) {
    saveAudio(file).catch((err) => console.warn('無法保存音軌', err));
  }
  syncAudioUI();
  if (!silent) toast(`已選擇音軌：${file.name}（將保留到手動清除）`, 'success');
}

function clearAudioFile(silent = false) {
  audioFile = null;
  if (els.audioInput) els.audioInput.value = '';
  clearStoredAudio().catch(() => {});
  syncAudioUI();
  if (!silent) toast('已手動清除自訂音軌', 'success');
}

async function restoreAudioFromStore() {
  try {
    const file = await loadAudio();
    if (!file) return;
    setAudioFile(file, { silent: true, skipPersist: true });
    toast(`已還原上次自訂音軌：${file.name}`, 'info');
  } catch (err) {
    console.warn('還原音軌失敗', err);
  }
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  el.textContent = message;
  els.toastRegion.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

/**
 * Sync step badges / titles / which download buttons show.
 */
function syncResultPhaseUI() {
  const hasPreview = Boolean(resultUrl);
  const hasSubs = Boolean(lastSrtText?.trim()) && isSubtitlePreviewMode;

  if (els.workflowSteps) {
    els.workflowSteps.hidden = !hasSubs && !hasFinalExport;
    const steps = els.workflowSteps.querySelectorAll('.workflow-step');
    steps.forEach((el) => {
      el.classList.remove('is-active', 'is-done');
      const n = Number(el.getAttribute('data-step'));
      if (hasFinalExport) {
        el.classList.add('is-done');
      } else if (hasSubs) {
        if (n === 1) el.classList.add('is-done');
        if (n === 2) el.classList.add('is-active');
        if (n === 3) { /* waiting */ }
      }
    });
    if (hasFinalExport) {
      steps.forEach((el) => el.classList.add('is-done'));
      steps.forEach((el) => el.classList.remove('is-active'));
    }
  }

  if (els.resultTitle) {
    if (hasFinalExport) els.resultTitle.textContent = '正式輸出完成';
    else if (hasSubs) els.resultTitle.textContent = '預覽影片（請先調字幕軸）';
    else els.resultTitle.textContent = '合併完成';
  }

  if (els.resultPhaseHint) {
    if (hasFinalExport) {
      els.resultPhaseHint.hidden = false;
      els.resultPhaseHint.innerHTML =
        '字幕軸已寫入<strong>正式影片</strong>，可下載。若再改字幕，請重新按「正式輸出影片」。';
    } else if (hasSubs) {
      els.resultPhaseHint.hidden = false;
      els.resultPhaseHint.innerHTML =
        '這是<strong>預覽</strong>：字幕只掛在瀏覽器播放器上，方便你對時間軸。調好後再按「正式輸出影片」。';
    } else {
      els.resultPhaseHint.hidden = true;
      els.resultPhaseHint.textContent = '';
    }
  }

  if (els.btnExportFinal) {
    els.btnExportFinal.hidden = !hasSubs || !previewBlob;
    els.btnExportFinal.disabled = exporting || merging;
    els.btnExportFinal.textContent = exporting
      ? '正式輸出中…'
      : hasFinalExport
        ? '重新正式輸出（套用目前字幕）'
        : '正式輸出影片';
  }

  if (els.btnDownload) {
    // Formal download only after export (or when no-subs simple merge)
    if (hasSubs) {
      els.btnDownload.hidden = !hasFinalExport || !finalUrl;
      if (finalUrl) {
        els.btnDownload.href = finalUrl;
        els.btnDownload.classList.add('btn-primary');
        els.btnDownload.classList.remove('btn-ghost');
        els.btnDownload.textContent = '下載正式影片';
      }
    } else if (hasPreview) {
      els.btnDownload.hidden = false;
      els.btnDownload.href = resultUrl;
      els.btnDownload.textContent = '下載合併影片';
    } else {
      els.btnDownload.hidden = true;
    }
  }

  if (els.btnDownloadPreview) {
    // Always offer preview download when preview video exists
    els.btnDownloadPreview.hidden = !resultUrl;
    if (resultUrl) {
      els.btnDownloadPreview.href = resultUrl;
      els.btnDownloadPreview.download = `preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
      els.btnDownloadPreview.textContent = hasSubs
        ? '下載預覽影片（無嵌入字幕）'
        : '下載預覽影片';
    }
  }

  if (els.btnDownloadCollapsed) {
    const url = hasFinalExport && finalUrl ? finalUrl : !hasSubs ? resultUrl : null;
    if (url) {
      els.btnDownloadCollapsed.hidden = false;
      els.btnDownloadCollapsed.href = url;
      els.btnDownloadCollapsed.download =
        els.btnDownload?.download || (hasFinalExport ? 'final.mp4' : 'merged.mp4');
      els.btnDownloadCollapsed.textContent = hasFinalExport ? '下載正式影片' : '下載影片';
    } else {
      els.btnDownloadCollapsed.hidden = true;
    }
  }

  if (els.collapsedTitle) {
    els.collapsedTitle.textContent = hasFinalExport
      ? '正式輸出已保留'
      : hasSubs
        ? '預覽已保留（尚未正式輸出）'
        : '上次合併結果已保留';
  }
  if (els.collapsedSub) {
    els.collapsedSub.textContent = hasFinalExport
      ? '可重新開啟或下載正式影片'
      : hasSubs
        ? '可繼續調字幕軸，確認後再正式輸出'
        : '可重新開啟預覽或直接下載';
  }

  if (els.exportStatusHint) {
    if (hasFinalExport) {
      els.exportStatusHint.hidden = false;
      els.exportStatusHint.textContent = '正式檔已就緒。播放器仍顯示預覽＋目前字幕軸；下載請用「下載正式影片」。';
    } else if (hasSubs) {
      els.exportStatusHint.hidden = false;
      els.exportStatusHint.textContent =
        '提示：上方播放器字幕會隨調整即時更新；未按「正式輸出」前下載的只有預覽片（未嵌入字幕）。';
    } else {
      els.exportStatusHint.hidden = true;
    }
  }

  // Keep first-start field in sync with current first cue
  if (els.subsFirstStart && lastChunks?.[0]) {
    const t0 = Number(lastChunks[0].timestamp?.[0]);
    if (Number.isFinite(t0) && document.activeElement !== els.subsFirstStart) {
      els.subsFirstStart.value = String(Math.round(t0 * 1000) / 1000);
    }
  }

  const showClearPreview = Boolean(resultUrl || previewBlob);
  if (els.btnClearPreview) els.btnClearPreview.hidden = !showClearPreview;
  if (els.btnClearPreviewCollapsed) els.btnClearPreviewCollapsed.hidden = !showClearPreview;
}

/** Collapse preview UI but keep blob URLs so user can restore. */
function hideResultPreview() {
  if (!resultUrl && !finalUrl) return;
  try {
    els.resultVideo.pause();
  } catch {
    /* ignore */
  }
  els.resultBlock.classList.add('is-visible', 'is-collapsed');
  if (els.resultCollapsed) els.resultCollapsed.hidden = false;
  if (els.resultBody) els.resultBody.hidden = true;
  setSrtDownloadVisible(Boolean(lastSrtText));
  syncResultPhaseUI();
}

/** Expand preview again from last merge result. */
function showResultPreview() {
  if (!resultUrl) return;
  els.resultBlock.classList.add('is-visible');
  els.resultBlock.classList.remove('is-collapsed');
  if (els.resultCollapsed) els.resultCollapsed.hidden = true;
  if (els.resultBody) els.resultBody.hidden = false;
  // Ensure video still points at last result
  if (els.resultVideo.src !== resultUrl) {
    els.resultVideo.src = resultUrl;
  }
  if (lastVttUrl && els.resultTrack) {
    els.resultTrack.hidden = false;
    els.resultTrack.src = lastVttUrl;
    els.resultTrack.default = true;
    enableSubtitleTrack();
  }
  if (isSubtitlePreviewMode && lastChunks?.length) {
    const tl = ensureSubtitleTimeline();
    tl?.bindVideo();
    tl?.render();
  }
  syncResultPhaseUI();
  els.resultBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Force HTML5 text track to actually show captions. */
function enableSubtitleTrack() {
  const video = els.resultVideo;
  if (!video) return;
  bindResultTimecode();
  const apply = () => {
    try {
      const tracks = video.textTracks;
      if (!tracks?.length) return;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].mode = i === 0 ? 'showing' : 'disabled';
      }
    } catch {
      /* ignore */
    }
  };
  apply();
  video.addEventListener('loadeddata', apply, { once: true });
  // Some browsers populate TextTrack after a tick
  setTimeout(apply, 200);
  setTimeout(apply, 800);
}

/**
 * Discard preview / formal video.
 * @param {{ clearStorage?: boolean, keepSubtitleData?: boolean }} [opts]
 *  - clearStorage: also remove IndexedDB preview (manual 清除預覽 / 清除全部)
 *  - keepSubtitleData: keep lastChunks/SRT (default true except full wipe)
 */
function revokeResult(opts = {}) {
  const clearStorage = Boolean(opts.clearStorage);
  const keepSubtitleData = opts.keepSubtitleData !== false;

  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  if (finalUrl) {
    URL.revokeObjectURL(finalUrl);
    finalUrl = null;
  }
  previewBlob = null;
  hasFinalExport = false;

  if (lastVttUrl) {
    URL.revokeObjectURL(lastVttUrl);
    lastVttUrl = null;
  }
  // Keep lastSrtText for download when keepSubtitleData; only drop blob URL of SRT file
  if (lastSrtUrl) {
    URL.revokeObjectURL(lastSrtUrl);
    lastSrtUrl = null;
  }

  els.resultVideo.removeAttribute('src');
  if (els.resultTrack) {
    els.resultTrack.removeAttribute('src');
    els.resultTrack.default = false;
    els.resultTrack.hidden = true;
  }
  if (els.btnDownloadCollapsed) {
    els.btnDownloadCollapsed.removeAttribute('href');
    els.btnDownloadCollapsed.hidden = true;
  }
  if (els.btnExportFinal) els.btnExportFinal.hidden = true;
  if (els.btnDownloadPreview) {
    els.btnDownloadPreview.hidden = true;
    els.btnDownloadPreview.removeAttribute('href');
  }
  if (els.btnDownload) {
    els.btnDownload.hidden = true;
    els.btnDownload.removeAttribute('href');
  }
  if (els.btnClearPreview) els.btnClearPreview.hidden = true;
  if (els.btnClearPreviewCollapsed) els.btnClearPreviewCollapsed.hidden = true;
  if (els.workflowSteps) els.workflowSteps.hidden = true;
  if (els.exportStatusHint) {
    els.exportStatusHint.hidden = true;
    els.exportStatusHint.textContent = '';
  }

  if (!keepSubtitleData) {
    // only when explicitly clearing preview session with subtitles? usually keep script subs
  }

  setSrtDownloadVisible(Boolean(lastSrtText?.trim()) && keepSubtitleData);
  if (els.subsPreview && lastChunks?.length && keepSubtitleData) {
    els.subsPreview.hidden = false;
  } else if (els.subsPreview && !keepSubtitleData) {
    els.subsPreview.hidden = true;
  }
  if (els.subsResultHint && lastChunks?.length && keepSubtitleData) {
    els.subsResultHint.hidden = false;
    els.subsResultHint.textContent =
      `字幕時間軸仍保留（${lastChunks.length} 句）。重新「產生預覽」可套回影片，或按「清除預覽」一併清掉畫面。`;
  }

  els.resultVideo.load();
  els.resultBlock.classList.remove('is-visible', 'is-collapsed');
  if (els.resultCollapsed) els.resultCollapsed.hidden = true;
  if (els.resultBody) els.resultBody.hidden = false;
  isSubtitlePreviewMode = Boolean(keepSubtitleData && lastChunks?.length);

  if (clearStorage) {
    clearStoredPreview().catch(() => {});
  }

  syncResultPhaseUI();
}

/** User clicked 清除預覽 — drop video + hide result; script/subtitle data stays. */
function clearPreviewManually() {
  if (merging || exporting) return;
  try {
    els.resultVideo.pause();
  } catch {
    /* ignore */
  }
  revokeResult({ clearStorage: true, keepSubtitleData: true });
  toast('已清除預覽影片（字幕稿與時間軸仍保留，可再產生預覽）', 'success');
}

/**
 * Persist current preview blob for reload.
 */
function persistPreviewBlob(blob, hasSubtitles) {
  if (!(blob instanceof Blob) || !blob.size) return;
  savePreview(blob, {
    hasSubtitles,
    filename: `preview-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`,
  }).catch((err) => console.warn('無法保存預覽影片', err));
}

/**
 * Restore preview video + timeline UI from IndexedDB / localStorage.
 */
async function restorePreviewFromStore() {
  try {
    const stored = await loadPreview();
    if (!stored?.blob) return false;

    previewBlob = stored.blob;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(stored.blob);
    hasFinalExport = false;

    const hasSubs = Boolean(
      stored.hasSubtitles && lastChunks?.length && lastSrtText?.trim(),
    );
    isSubtitlePreviewMode = hasSubs || Boolean(lastChunks?.length);

    els.resultVideo.src = resultUrl;
    bindResultTimecode();
    if (els.btnDownloadPreview) {
      els.btnDownloadPreview.href = resultUrl;
      els.btnDownloadPreview.download = stored.filename || 'preview.mp4';
    }

    if (lastChunks?.length) {
      publishSubtitleOutputs({ silentInvalidate: true, fromTimeline: false });
      if (els.subsPreview) els.subsPreview.hidden = false;
      if (els.subsResultHint) {
        els.subsResultHint.hidden = false;
        els.subsResultHint.textContent =
          `已還原上次預覽影片與字幕時間軸（${lastChunks.length} 句）。可繼續調整或正式輸出；重新「產生預覽」會覆蓋影片。`;
      }
      setSrtDownloadVisible(true);
      const tl = ensureSubtitleTimeline();
      tl?.bindVideo();
      requestAnimationFrame(() => {
        tl?.fit();
        tl?.render();
        setTimeout(() => {
          tl?.fit();
          tl?.render();
        }, 400);
      });
    } else if (!stored.hasSubtitles) {
      isSubtitlePreviewMode = false;
      if (els.btnDownload) {
        els.btnDownload.hidden = false;
        els.btnDownload.href = resultUrl;
        els.btnDownload.textContent = '下載合併影片';
      }
    }

    els.resultBlock.classList.add('is-visible');
    els.resultBlock.classList.remove('is-collapsed');
    if (els.resultCollapsed) els.resultCollapsed.hidden = true;
    if (els.resultBody) els.resultBody.hidden = false;
    if (els.btnClearPreview) els.btnClearPreview.hidden = false;
    if (els.btnClearPreviewCollapsed) els.btnClearPreviewCollapsed.hidden = false;

    syncResultPhaseUI();
    toast('已還原上次預覽影片與時間軸', 'info');
    return true;
  } catch (err) {
    console.warn('還原預覽失敗', err);
    return false;
  }
}

/**
 * Recompute lastChunks from savedBaseChunks by applying:
 *   1) global offset (previewExtraOffset) to all cues
 *   2) partial offset (previewPartialDelta) to cues from previewPartialFrom onwards
 * Then refresh VTT/SRT blobs and the live subtitle track.
 * Does NOT re-merge the video — instant and non-destructive.
 *
 * @param {{ global?: number, partialFrom?: number, partialDelta?: number }} [overrides]
 */
async function recomputePreviewChunks(overrides = {}) {
  if (!savedBaseChunks?.length) {
    toast('目前沒有字幕可調整', 'error');
    return;
  }

  // Resolve new values (fall back to current state)
  const globalOff  = ('global'       in overrides) ? overrides.global       : previewExtraOffset;
  const partFrom   = ('partialFrom'  in overrides) ? overrides.partialFrom  : previewPartialFrom;
  const partDelta  = ('partialDelta' in overrides) ? overrides.partialDelta : previewPartialDelta;

  // 1. Start from pristine base
  const maxEnd = lastTotalDur || lastCycleDur || undefined;
  let chunks = shiftChunks(savedBaseChunks, globalOff, maxEnd);

  // 2. Apply partial offset on top
  if (partDelta !== 0 && partFrom < chunks.length) {
    chunks = shiftChunksFrom(chunks, partFrom, partDelta, maxEnd);
  }

  // Seed undo with state before offset tweak
  if (lastChunks?.length) {
    if (subHistoryIndex < 0) {
      subHistory = [cloneChunks(lastChunks)];
      subHistoryIndex = 0;
    }
  }

  // 3. Persist new state
  lastChunks = chunks;
  previewExtraOffset = globalOff;
  previewPartialFrom = partFrom;
  previewPartialDelta = partDelta;

  publishSubtitleOutputs();
  pushSubHistoryFromCurrent();
}

/**
 * Apply global offset (shifts ALL cues).
 * Reads value from #subs-adjust-offset.
 */
async function applyPreviewOffset() {
  const inputDelta = Number(els.subsAdjustOffset?.value) || 0;
  await recomputePreviewChunks({ global: inputDelta });

  const sign = inputDelta >= 0 ? '+' : '';
  const displayChunks = lastChunks || [];
  if (els.subsAdjustHint) {
    const firstSec = displayChunks[0]?.timestamp?.[0] ?? 0;
    els.subsAdjustHint.textContent =
      `已套用整體 ${sign}${inputDelta}s 偏移，第一句字幕在 ${firstSec.toFixed(2)}s`;
  }
  toast(`整體字幕偏移已更新（${sign}${inputDelta}s）`, 'success');
}

/**
 * Set first cue start time; later cues follow according to timeline mode:
 * - chain (default): 2nd after 1st ends, 3rd after 2nd, …
 * - shift: all cues translate by the same delta
 * - off: only first cue moves
 */
async function applyFirstStart() {
  if (!lastChunks?.length) {
    toast('目前沒有字幕可調整', 'error');
    return;
  }
  const target = Number(els.subsFirstStart?.value);
  if (!Number.isFinite(target) || target < 0) {
    toast('請輸入有效的第一句開始秒數', 'error');
    return;
  }
  const currentFirst = Number(lastChunks[0].timestamp?.[0]) || 0;
  const firstDur = Math.max(
    0.2,
    (Number(lastChunks[0].timestamp?.[1]) || 0) - currentFirst,
  );
  let delta = target - currentFirst;
  if (Math.abs(delta) < 0.001) {
    toast('第一句已在該時間', 'info');
    return;
  }

  const maxDur = lastTotalDur || lastCycleDur || 0;
  const mode =
    ensureSubtitleTimeline()?.getFollowMode?.() ||
    (() => {
      try {
        return localStorage.getItem('videomerge.followMode') || 'chain';
      } catch {
        return 'chain';
      }
    })();

  let next;
  if (mode === 'shift') {
    for (const c of lastChunks) {
      const s = Number(c.timestamp[0]) || 0;
      const e = Number(c.timestamp[1]) || 0;
      if (s + delta < 0) delta = Math.max(delta, -s);
      if (maxDur > 0 && e + delta > maxDur) delta = Math.min(delta, maxDur - e);
    }
    delta = Math.round(delta * 100) / 100;
    next = lastChunks.map((c) => ({
      timestamp: [
        (Number(c.timestamp[0]) || 0) + delta,
        (Number(c.timestamp[1]) || 0) + delta,
      ],
      text: c.text,
    }));
  } else {
    // off or chain: move first cue only, then chain-pack the rest
    let s0 = Math.max(0, target);
    let e0 = s0 + firstDur;
    if (maxDur > 0 && e0 > maxDur) {
      e0 = maxDur;
      s0 = Math.max(0, e0 - firstDur);
    }
    next = lastChunks.map((c, i) =>
      i === 0
        ? { timestamp: [s0, e0], text: c.text }
        : {
            timestamp: [Number(c.timestamp[0]) || 0, Number(c.timestamp[1]) || 0],
            text: c.text,
          },
    );
    if (mode === 'chain' || mode === 'off') {
      // even for "off" when using 第一句開始, chain is usually desired for lyrics;
      // only skip chain when mode is explicitly shift (handled above).
      // User asked: 2 after 1, 3 after 2 — apply chain whenever not pure shift.
      if (mode === 'chain') {
        next = rechainSubtitleChunks(next, 0, maxDur, 0.06);
      }
    }
  }

  commitFreeTimelineChunks(next);
  ensureSubtitleTimeline()?.render();

  const actual = lastChunks?.[0]?.timestamp?.[0] ?? target;
  const sign = delta >= 0 ? '+' : '';
  if (els.subsFirstHint) {
    els.subsFirstHint.textContent =
      mode === 'chain'
        ? `第一句 @ ${Number(actual).toFixed(2)}s，後句已自動銜接（2接1、3接2…）`
        : mode === 'shift'
          ? `第一句 @ ${Number(actual).toFixed(2)}s，後句同秒平移 ${sign}${delta.toFixed(2)}s`
          : `第一句 @ ${Number(actual).toFixed(2)}s（僅本句）`;
  }
  if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
  toast(
    mode === 'chain'
      ? `第一句改為 ${Number(actual).toFixed(2)}s，後句已依序銜接`
      : mode === 'shift'
        ? `第一句改為 ${Number(actual).toFixed(2)}s，後句平移 ${sign}${delta.toFixed(2)}s`
        : `第一句改為 ${Number(actual).toFixed(2)}s`,
    'success',
  );
}

/**
 * Apply partial offset starting from a specific sentence (1-indexed in UI).
 * Reads values from #subs-partial-from and #subs-partial-offset.
 */
async function applyPartialOffset() {
  if (!savedBaseChunks?.length) {
    toast('目前沒有字幕可調整', 'error');
    return;
  }
  const fromSentence = Math.max(1, Math.floor(Number(els.subsPartialFrom?.value) || 1));
  const fromIdx = fromSentence - 1; // convert to 0-based
  const delta = Number(els.subsPartialOffset?.value) || 0;

  if (fromIdx >= savedBaseChunks.length) {
    toast(`只有 ${savedBaseChunks.length} 句字幕，請輸入較小的句號`, 'error');
    return;
  }

  await recomputePreviewChunks({ partialFrom: fromIdx, partialDelta: delta });

  const sign = delta >= 0 ? '+' : '';
  if (els.subsPartialHint) {
    const pivotSec = (lastChunks?.[fromIdx]?.timestamp?.[0] ?? 0).toFixed(2);
    els.subsPartialHint.textContent =
      `第 ${fromSentence} 句起再 ${sign}${delta}s，該句字幕在 ${pivotSec}s`;
  }
  toast(`區段偏移已更新：第 ${fromSentence} 句起 ${sign}${delta}s`, 'success');
}

/**
 * After preview + manual timeline tweaks: embed current SRT into preview blob.
 */
async function runFormalExport() {
  if (exporting || merging) return;
  if (!previewBlob) {
    toast('請先產生預覽影片', 'error');
    return;
  }
  if (!lastSrtText?.trim()) {
    toast('沒有可嵌入的字幕', 'error');
    return;
  }

  exporting = true;
  updateToolbar();
  syncResultPhaseUI();
  els.progressBlock.classList.add('is-visible');
  els.logBox.hidden = false;
  resetProgressFloor();
  setProgress(0, '正式輸出：嵌入調整後字幕…');
  appendLog('正式輸出開始（僅嵌入目前字幕軸，不重跑合併）');

  try {
    const { blob, subtitlesEmbedded } = await embedSubtitlesIntoVideo(
      previewBlob,
      lastSrtText,
      {
        onStatus: (s) => setProgress(undefined, s),
        onProgress: (p) => {
          if (typeof p === 'number' && Number.isFinite(p)) setProgress(p);
        },
        onLog: (msg) => appendLog(msg),
      },
    );

    if (finalUrl) {
      URL.revokeObjectURL(finalUrl);
      finalUrl = null;
    }
    finalUrl = URL.createObjectURL(blob);
    hasFinalExport = true;

    const name = `final-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
    if (els.btnDownload) {
      els.btnDownload.href = finalUrl;
      els.btnDownload.download = name;
      els.btnDownload.hidden = false;
    }

    setProgress(1, subtitlesEmbedded ? '正式輸出完成（字幕已嵌入）' : '輸出完成（字幕嵌入可能失敗，請另存 SRT）');
    if (els.exportStatusHint) {
      els.exportStatusHint.hidden = false;
      els.exportStatusHint.textContent = subtitlesEmbedded
        ? '正式影片已就緒，可下載。播放器仍為預覽＋即時字幕軌。'
        : '嵌入字幕可能失敗：請下載 SRT 搭配預覽影片，或換瀏覽器再試正式輸出。';
    }

    // Step 3 done
    if (els.workflowSteps) {
      els.workflowSteps.hidden = false;
      els.workflowSteps.querySelectorAll('.workflow-step').forEach((el) => {
        el.classList.remove('is-active');
        el.classList.add('is-done');
      });
    }
    if (els.resultTitle) els.resultTitle.textContent = '正式輸出完成';

    toast(
      subtitlesEmbedded
        ? '正式輸出完成，可下載影片'
        : '已輸出影片，但嵌入字幕失敗，請下載 SRT',
      subtitlesEmbedded ? 'success' : 'error',
    );
    syncResultPhaseUI();
    els.btnDownload?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    setProgress(0, '正式輸出失敗');
    appendLog(err?.message || String(err));
    toast(err?.message || '正式輸出失敗', 'error');
  } finally {
    exporting = false;
    updateToolbar();
    syncResultPhaseUI();
  }
}

/**
 * Estimate final video duration from loop options + ready clips.
 */
function estimateOutputDurationSec() {
  const base = baseSequenceDuration();
  const loop = getLoopOptions();
  if (loop.mode === 'count') {
    return base * Math.max(1, loop.count || 1);
  }
  if (loop.mode === 'duration') {
    return Math.max(0, loop.targetSeconds || 0);
  }
  return base;
}

/** Monotonic progress so bar never jumps backward mid-job */
let progressFloor = 0;

function resetProgressFloor() {
  progressFloor = 0;
}

function setProgress(ratio, status) {
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    const clamped = Math.max(0, Math.min(1, ratio));
    // Explicit 0 resets (job start / failure); otherwise never go backwards
    if (clamped === 0) progressFloor = 0;
    else progressFloor = Math.max(progressFloor, clamped);
    const pct = Math.round(progressFloor * 100);
    els.progressFill.style.width = `${pct}%`;
    els.progressPct.textContent = `${pct}%`;
    els.progressBar.setAttribute('aria-valuenow', String(pct));
  }
  if (status) els.progressStatus.textContent = status;
}

function appendLog(line) {
  if (!els.logBox.hidden) {
    const text = typeof line === 'string' ? line : String(line);
    els.logBox.textContent += `${text}\n`;
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }
}

function wantsSubtitleWorkflow() {
  const scriptRaw = getScriptText();
  const wantScript = Boolean(els.optScriptSubs?.checked) && Boolean(scriptRaw);
  const wantAsr =
    Boolean(els.optAutoSubs?.checked) &&
    Boolean(audioFile) &&
    !els.optNoAudio?.checked;
  return wantScript || wantAsr;
}

function updateToolbar() {
  const ready = clips.filter((c) => c.status === 'ready');
  const hasClips = clips.length > 0;
  const busy = merging || exporting;
  els.btnClear.disabled = !hasClips || busy;
  els.btnMerge.disabled = ready.length === 0 || busy || clips.some((c) => c.status === 'loading');
  els.btnAddMore.disabled = busy;
  els.fileInput.disabled = busy;
  els.optNoAudio.disabled = busy;

  // Primary action label: with subtitles → preview first; else plain merge
  if (els.btnMerge) {
    els.btnMerge.textContent = wantsSubtitleWorkflow()
      ? merging
        ? '產生預覽中…'
        : '產生預覽'
      : merging
        ? '合併中…'
        : '合併為一個影片';
  }
  if (els.mergeActionHint) {
    if (ready.length === 0) {
      els.mergeActionHint.textContent = '請先加入至少一段影片，並完成上方延長／音軌／字幕設定';
    } else if (clips.some((c) => c.status === 'loading')) {
      els.mergeActionHint.textContent = '影片影格載入中，請稍候…';
    } else if (wantsSubtitleWorkflow()) {
      els.mergeActionHint.textContent =
        '將產生可調字幕的預覽（尚未正式輸出）；調好時間軸後再按「正式輸出影片」';
    } else {
      els.mergeActionHint.textContent = '將依上方設定合併為一個影片，完成後可預覽與下載';
    }
  }
  if (els.btnExportFinal) {
    els.btnExportFinal.disabled = busy || !previewBlob || !lastSrtText;
  }

  const loopInputs = document.querySelectorAll(
    'input[name="loop-mode"], #loop-count, #loop-hours, #loop-mins, #loop-secs',
  );
  loopInputs.forEach((el) => {
    el.disabled = busy;
  });
  syncAudioUI();

  if (!hasClips) {
    els.clipsCount.textContent = '尚未加入影片';
  } else {
    const totalDur = ready.reduce((sum, c) => sum + (c.duration || 0), 0);
    els.clipsCount.textContent = `${clips.length} 段 · 約 ${formatDuration(totalDur)} · 就緒 ${ready.length}`;
  }

  els.headerMeta.textContent = hasClips
    ? `${clips.length} 個檔案 · 本機處理`
    : '本機處理 · 不上傳伺服器';

  syncExtendUI();
}

function renderClips() {
  if (clips.length === 0) {
    els.clipsRoot.innerHTML = `
      <div class="empty-state">
        <p>加入影片後，這裡會顯示每段的<strong>首幀</strong>與<strong>尾幀</strong>預覽。</p>
      </div>
    `;
    updateToolbar();
    return;
  }

  const list = document.createElement('ul');
  list.className = 'clip-list';
  list.setAttribute('aria-label', '影片片段列表');

  clips.forEach((clip, index) => {
    const li = document.createElement('li');
    li.className = 'clip-card';
    li.dataset.id = clip.id;

    const statusHtml =
      clip.status === 'loading'
        ? `<span class="clip-status">正在擷取首尾幀…</span>`
        : clip.status === 'error'
          ? `<span class="clip-status is-error">${escapeHtml(clip.error || '讀取失敗')}</span>`
          : `<span class="clip-status is-ok">首尾幀就緒</span>`;

    const firstInner = clip.firstFrame
      ? `<img src="${clip.firstFrame}" alt="${escapeHtml(clip.name)} 首幀" />`
      : `<div class="placeholder">${clip.status === 'loading' ? '擷取中…' : '—'}</div>`;

    const lastInner = clip.lastFrame
      ? `<img src="${clip.lastFrame}" alt="${escapeHtml(clip.name)} 尾幀" />`
      : `<div class="placeholder">${clip.status === 'loading' ? '擷取中…' : '—'}</div>`;

    li.innerHTML = `
      <div class="clip-order">
        <span class="order-badge" aria-label="順序 ${index + 1}">${index + 1}</span>
        <div class="order-actions">
          <button type="button" class="icon-btn" data-action="up" data-id="${clip.id}" title="上移" aria-label="上移 ${escapeHtml(clip.name)}" ${index === 0 || merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 14l6-6 6 6"/></svg>
          </button>
          <button type="button" class="icon-btn" data-action="down" data-id="${clip.id}" title="下移" aria-label="下移 ${escapeHtml(clip.name)}" ${index === clips.length - 1 || merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 10l6 6 6-6"/></svg>
          </button>
          <button type="button" class="icon-btn danger" data-action="remove" data-id="${clip.id}" title="移除" aria-label="移除 ${escapeHtml(clip.name)}" ${merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>
      <div class="clip-body">
        <div class="clip-meta">
          <p class="clip-name" title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</p>
          <div class="clip-stats">
            <span>${formatDuration(clip.duration)}</span>
            <span>${formatBytes(clip.size)}</span>
            <span>${clip.width && clip.height ? `${clip.width}×${clip.height}` : '—'}</span>
          </div>
        </div>
        <div class="frames-row">
          <div class="frame-cell">
            <span class="frame-label">首幀</span>
            <div class="frame-thumb">${firstInner}</div>
          </div>
          <div class="frame-connector" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M14 7l5 5-5 5"/></svg>
            <span>→</span>
          </div>
          <div class="frame-cell">
            <span class="frame-label">尾幀</span>
            <div class="frame-thumb">${lastInner}</div>
          </div>
        </div>
        ${statusHtml}
      </div>
    `;

    list.appendChild(li);
  });

  els.clipsRoot.replaceChildren(list);
  updateToolbar();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** @type {ReturnType<typeof setTimeout> | null} */
let clipPersistTimer = null;

function schedulePersistClips() {
  if (clipPersistTimer) clearTimeout(clipPersistTimer);
  clipPersistTimer = setTimeout(() => {
    clipPersistTimer = null;
    persistClipsNow().catch(() => {
      /* ignore storage errors */
    });
  }, 350);
}

async function persistClipsNow() {
  try {
    await saveClips(clips);
  } catch (err) {
    console.warn('無法保存影片清單', err);
  }
}

async function processClip(clip) {
  try {
    const info = await extractFrames(clip.file);
    const current = clips.find((c) => c.id === clip.id);
    if (!current) return;
    Object.assign(current, {
      firstFrame: info.firstFrame,
      lastFrame: info.lastFrame,
      duration: info.duration,
      width: info.width,
      height: info.height,
      status: 'ready',
      error: null,
    });
  } catch (err) {
    const current = clips.find((c) => c.id === clip.id);
    if (!current) return;
    current.status = 'error';
    current.error = err?.message || '無法擷取影格';
  }
  renderClips();
  schedulePersistClips();
}

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(f.name));
  if (files.length === 0) {
    toast('請選擇有效的影片檔案', 'error');
    return;
  }

  // Keep existing preview until user regenerates or clears it
  const newClips = files.map((file) => ({
    id: uid(),
    file,
    name: file.name,
    size: file.size,
    firstFrame: null,
    lastFrame: null,
    duration: null,
    width: null,
    height: null,
    status: /** @type {const} */ ('loading'),
    error: null,
  }));

  clips = [...clips, ...newClips];
  renderClips();
  schedulePersistClips();
  toast(`已加入 ${newClips.length} 段影片（將保留到按「清除全部」）`, 'success');

  for (const clip of newClips) {
    processClip(clip);
  }
}

function moveClip(id, dir) {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= clips.length) return;
  const next = [...clips];
  [next[i], next[j]] = [next[j], next[i]];
  clips = next;
  renderClips();
  schedulePersistClips();
}

function removeClip(id) {
  clips = clips.filter((c) => c.id !== id);
  renderClips();
  schedulePersistClips();
  if (clips.length === 0) {
    clearClips().catch(() => {});
    // Preview kept until user clears it or regenerates
  }
}

function clearAll() {
  if (merging || exporting) return;
  clips = [];
  clearAudioFile(true);
  clearClips().catch(() => {});
  clearStoredAudio().catch(() => {});
  clearLoopOptions();
  syncExtendUI();
  renderClips();
  revokeResult({ clearStorage: true, keepSubtitleData: true });
  els.progressBlock.classList.remove('is-visible');
  els.logBox.hidden = true;
  els.logBox.textContent = '';
  toast('已手動清除影片、音軌、目標時長與預覽', 'success');
}

/**
 * Restore clips from IndexedDB (until user clicks 清除全部).
 */
async function restoreClipsFromStore() {
  try {
    const list = await loadClips();
    if (!list.length) return;
    clips = list;
    renderClips();
    updateToolbar();
    toast(`已還原上次加入的 ${list.length} 段影片`, 'info');

    // Re-extract frames if missing (e.g. old store without thumbnails)
    for (const clip of clips) {
      if (clip.status === 'loading' || !clip.firstFrame || !clip.lastFrame) {
        clip.status = 'loading';
        processClip(clip);
      }
    }
  } catch (err) {
    console.warn('還原影片清單失敗', err);
  }
}

async function runMerge() {
  const ready = clips.filter((c) => c.status === 'ready');
  if (ready.length === 0 || merging) return;

  merging = true;
  // Regenerating preview replaces previous preview video
  revokeResult({ clearStorage: true, keepSubtitleData: true });
  updateToolbar();
  renderClips();

  els.progressBlock.classList.add('is-visible');
  els.logBox.hidden = false;
  els.logBox.textContent = '';
  resetProgressFloor();
  setProgress(0, '載入 FFmpeg…');

  try {
    // Re-check files still readable before heavy work
    for (const clip of ready) {
      if (!(clip.file instanceof File) || clip.file.size <= 0) {
        throw new Error(`檔案無效或為空：${clip.name}`);
      }
    }

    const noAudio = Boolean(els.optNoAudio.checked);
    const loop = getLoopOptions();
    const bgm = !noAudio && audioFile instanceof File ? audioFile : null;
    const scriptRaw = getScriptText();
    const wantScriptSubs = Boolean(els.optScriptSubs?.checked) && Boolean(scriptRaw);
    const wantAsrSubs = Boolean(els.optAutoSubs.checked) && Boolean(bgm);
    // Script takes priority when both checked
    const wantSubs = wantScriptSubs || wantAsrSubs;

    if (els.optScriptSubs?.checked && !scriptRaw) {
      throw new Error('已勾選語音稿字幕，請先貼上或上傳講稿');
    }
    if (els.optAutoSubs.checked && !bgm && !wantScriptSubs) {
      throw new Error('自動辨識字幕需要先選擇 MP3 音軌（且勿勾選「不要聲音」）');
    }

    if (loop.mode === 'count') {
      if (loop.count < 1 || loop.count > LOOP_LIMITS.maxCount) {
        throw new Error(`重複次數請介於 1～${LOOP_LIMITS.maxCount}`);
      }
    }
    if (loop.mode === 'duration') {
      if (!loop.targetSeconds || loop.targetSeconds <= 0) {
        throw new Error('請設定大於 0 的目標時長');
      }
      if (loop.targetSeconds > LOOP_LIMITS.maxDurationSec) {
        throw new Error(
          `目標時長不可超過 ${LOOP_LIMITS.maxDurationSec / 3600} 小時`,
        );
      }
    }

    let subtitleSrt = null;
    let subtitleVtt = null;
    let subChunkCount = 0;

    // Script/ASR prep occupies 0–22% of bar; FFmpeg merge uses remaining
    const mergeRangeStart = wantSubs ? 0.22 : 0;

    if (wantScriptSubs) {
      setProgress(0.05, '依語音稿產生字幕…');
      appendLog('使用語音稿上字幕（對齊音軌／影片時軸）');

      let videoDur = estimateOutputDurationSec();
      if (!(videoDur > 0)) {
        videoDur = ready.reduce(
          (s, c) => s + (Number.isFinite(c.duration) && c.duration > 0 ? c.duration : 0),
          0,
        );
      }
      let audioDur = 0;
      if (bgm) {
        try {
          audioDur = await getMediaDuration(bgm);
        } catch {
          audioDur = 0;
        }
      }
      if (!(videoDur > 0.5) && audioDur > 0.5) videoDur = audioDur;
      if (!(videoDur > 0.5)) {
        throw new Error('無法估算影片時長，請先加入至少一段有效影片');
      }

      // Key sync fix: time script to one audio cycle, then tile if video loops audio
      const timeline = resolveSubtitleTimeline({
        videoDur,
        audioDur,
        hasCustomAudio: Boolean(bgm),
      });
      appendLog(
        `字幕時軸：mode=${timeline.mode} cycle=${timeline.cycleDur.toFixed(2)}s total=${timeline.totalDur.toFixed(2)}s` +
          (audioDur ? ` audio=${audioDur.toFixed(2)}s` : '') +
          ` video=${videoDur.toFixed(2)}s`,
      );

      /** @type {{ timestamp: [number, number], text: string }[]} */
      let chunks;
      let reused = false;

      // Reuse last script subtitles (incl. timeline edits) until script changes or 清除稿件
      if (
        lastScriptSource === scriptRaw &&
        savedBaseChunks?.length &&
        lastChunks?.length
      ) {
        reused = true;
        lastCycleDur = timeline.cycleDur;
        lastTotalDur = timeline.totalDur;
        chunks = lastChunks.map((c) => ({
          timestamp: [c.timestamp[0], c.timestamp[1]],
          text: c.text,
        }));
        appendLog(
          `沿用上次語音稿字幕（${chunks.length} 句，含時間軸手動調整）；改稿或「清除稿件」後才會重算`,
        );
      } else {
        const built = scriptToSubtitles(scriptRaw, timeline.cycleDur, {
          leadInSec: 0,
        });
        chunks = applySubtitleOffset(
          built.chunks,
          bgm,
          timeline.cycleDur,
          appendLog,
        );

        // Save pristine base for in-preview retiming (before tile)
        savedBaseChunks = chunks.map((c) => ({
          timestamp: [...c.timestamp],
          text: c.text,
        }));
        lastChunks = savedBaseChunks.map((c) => ({
          timestamp: [...c.timestamp],
          text: c.text,
        }));
        lastCycleDur = timeline.cycleDur;
        lastTotalDur = timeline.totalDur;
        previewExtraOffset = 0;
        previewPartialFrom = 0;
        previewPartialDelta = 0;
        lastScriptSource = scriptRaw;
        if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
        if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
        if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
        appendLog(
          `語音稿字幕：${built.source} · ${chunks.length} 句 · 第一句@${(chunks[0]?.timestamp?.[0] ?? 0).toFixed(2)}s`,
        );
      }

      // Tile when video is longer than one speech/audio cycle (matches looped MP3)
      let displayChunks = chunks;
      if (
        timeline.totalDur > timeline.cycleDur + 0.25 &&
        timeline.cycleDur > 0.2
      ) {
        displayChunks = tileChunksToDuration(
          chunks,
          timeline.cycleDur,
          timeline.totalDur,
        );
        appendLog(
          `字幕循環對齊：${timeline.cycleDur.toFixed(1)}s → ${timeline.totalDur.toFixed(1)}s，句數 ${displayChunks.length}`,
        );
      }

      subtitleSrt = chunksToSrt(displayChunks);
      subtitleVtt = chunksToVtt(displayChunks);
      subChunkCount = displayChunks.length;
      appendLog(
        `${reused ? '沿用' : '新建'}語音稿字幕 · ${subChunkCount} 句 · 第一句@${(chunks[0]?.timestamp?.[0] ?? 0).toFixed(2)}s · 「${(chunks.map((c) => c.text).join(' ') || '').slice(0, 80)}」`,
      );
      if (!subtitleSrt.trim()) throw new Error('語音稿未能產生有效字幕');
      // Undo stack: new generate resets baseline; reuse keeps existing history
      if (!reused) {
        resetSubHistory(lastChunks, { asBaseline: true });
      } else if (subHistoryIndex < 0 && lastChunks?.length) {
        resetSubHistory(lastChunks, { asBaseline: false });
      }
      persistScriptAndSubtitles();
      setProgress(mergeRangeStart, '開始合併影片…');
    } else if (wantAsrSubs) {
      setProgress(0.02, '語音辨識中…');
      const lang = els.subLang.value || 'chinese';
      const asr = await transcribeAudioToSubtitles(bgm, {
        language: lang === 'auto' ? null : lang,
        onStatus: (s) => setProgress(undefined, s),
        onProgress: (p) => {
          if (typeof p === 'number' && Number.isFinite(p)) {
            setProgress(0.02 + Math.min(1, Math.max(0, p)) * 0.18, els.progressStatus.textContent);
          }
        },
        onLog: (msg) => appendLog(msg),
      });

      let chunks = asr.chunks;
      appendLog(
        `辨識模型：${asr.modelId || '?'} · 原始 ${chunks.length} 句 · 「${(asr.text || '').slice(0, 80)}」`,
      );
      if (!chunks.length || !(asr.text || '').trim()) {
        throw new Error(
          '語音辨識沒有產生任何文字。也可改用「語音稿字幕」貼上講稿。',
        );
      }
      try {
        const audioDur = await getMediaDuration(bgm);
        const videoDur = estimateOutputDurationSec() || audioDur;
        const timeline = resolveSubtitleTimeline({
          videoDur,
          audioDur,
          hasCustomAudio: true,
        });
        chunks = applySubtitleOffset(chunks, bgm, timeline.cycleDur, appendLog);
        // Save pristine base (pre-tile) chunks for in-preview retiming
        savedBaseChunks = chunks.map((c) => ({ timestamp: [...c.timestamp], text: c.text }));
        lastChunks = savedBaseChunks.map((c) => ({ timestamp: [...c.timestamp], text: c.text }));
        lastCycleDur = timeline.cycleDur;
        lastTotalDur = timeline.totalDur;
        previewExtraOffset = 0;
        previewPartialFrom = 0;
        previewPartialDelta = 0;
        if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
        if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
        if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
        if (timeline.totalDur > timeline.cycleDur + 0.25) {
          chunks = tileChunksToDuration(chunks, timeline.cycleDur, timeline.totalDur);
          appendLog(
            `字幕對齊：音訊 ${timeline.cycleDur.toFixed(1)}s → 影片 ${timeline.totalDur.toFixed(1)}s，句數 ${chunks.length}`,
          );
        }
      } catch (e) {
        appendLog(`字幕時長對齊略過：${e?.message || e}`);
        // Even without timeline, save chunks for possible retiming
        savedBaseChunks = chunks.map((c) => ({ timestamp: [...c.timestamp], text: c.text }));
        lastChunks = savedBaseChunks.map((c) => ({ timestamp: [...c.timestamp], text: c.text }));
        lastCycleDur = 0;
        lastTotalDur = 0;
        previewExtraOffset = 0;
        previewPartialFrom = 0;
        previewPartialDelta = 0;
        if (els.subsAdjustOffset) els.subsAdjustOffset.value = '0';
        if (els.subsPartialFrom) els.subsPartialFrom.value = '1';
        if (els.subsPartialOffset) els.subsPartialOffset.value = '0';
      }

      subtitleSrt = chunksToSrt(chunks);
      subtitleVtt = chunksToVtt(chunks);
      subChunkCount = chunks.length;
      if (!subtitleSrt.trim()) {
        throw new Error('SRT 內容為空，字幕產生失敗');
      }
      if (lastChunks?.length) {
        resetSubHistory(lastChunks, { asBaseline: true });
      }
      setProgress(mergeRangeStart, '開始合併影片…');
    }

    const clipDurations = ready.map((c) =>
      Number.isFinite(c.duration) && c.duration > 0 ? c.duration : 10,
    );

    // With subtitles: merge video/audio only for PREVIEW (soft captions via <track>).
    // Formal embed happens after user finishes manual timeline tweaks.
    if (wantSubs && subtitleSrt?.trim()) {
      appendLog('預覽模式：先不嵌入字幕，調好時間軸後再「正式輸出」');
      setProgress(mergeRangeStart, '產生預覽影片（尚未嵌入字幕）…');
    }

    const { blob } = await mergeVideos(
      ready.map((c) => c.file),
      {
        noAudio,
        audioFile: bgm,
        // Defer hard embed when we have subtitles to adjust
        subtitleSrt: null,
        clipDurations,
        loop,
        onStatus: (s) => setProgress(undefined, s),
        onProgress: (p) => {
          if (typeof p === 'number' && Number.isFinite(p)) {
            const local = Math.min(1, Math.max(0, p));
            setProgress(
              mergeRangeStart + local * (1 - mergeRangeStart),
              els.progressStatus.textContent,
            );
          }
        },
        onLog: (msg) => appendLog(msg),
      },
    );

    setProgress(1, wantSubs ? '預覽就緒' : '完成');
    previewBlob = blob;
    resultUrl = URL.createObjectURL(blob);
    hasFinalExport = false;
    if (finalUrl) {
      URL.revokeObjectURL(finalUrl);
      finalUrl = null;
    }
    els.resultVideo.src = resultUrl;
    bindResultTimecode();
    persistPreviewBlob(blob, Boolean(wantSubs && subtitleSrt?.trim()));

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (els.btnDownload) {
      els.btnDownload.download = `merged-${stamp}.mp4`;
    }
    if (els.btnDownloadPreview) {
      els.btnDownloadPreview.download = `preview-${stamp}.mp4`;
      els.btnDownloadPreview.href = resultUrl;
    }

    if (subtitleSrt && subtitleSrt.trim()) {
      isSubtitlePreviewMode = true;
      lastSrtText = subtitleSrt;
      lastSrtFilename = `subtitles-${stamp}.srt`;
      if (lastSrtUrl) {
        URL.revokeObjectURL(lastSrtUrl);
        lastSrtUrl = null;
      }
      lastSrtUrl = URL.createObjectURL(
        new Blob(['\uFEFF' + subtitleSrt], {
          type: 'application/x-subrip;charset=utf-8',
        }),
      );

      if (subtitleVtt) {
        if (lastVttUrl) URL.revokeObjectURL(lastVttUrl);
        lastVttUrl = URL.createObjectURL(
          new Blob([subtitleVtt], { type: 'text/vtt;charset=utf-8' }),
        );
      }

      setSrtDownloadVisible(true);

      if (els.resultTrack && lastVttUrl) {
        els.resultTrack.hidden = false;
        els.resultTrack.removeAttribute('hidden');
        els.resultTrack.kind = 'subtitles';
        els.resultTrack.label = '預覽字幕';
        els.resultTrack.srclang = 'zh';
        els.resultTrack.default = true;
        els.resultTrack.src = lastVttUrl;
        els.resultVideo.load();
        els.resultVideo.src = resultUrl;
        enableSubtitleTrack();
      }

      els.subsResultHint.hidden = false;
      els.subsResultHint.textContent =
        `已產生 ${subChunkCount} 句字幕（僅預覽）— 下方時間軸與清單各 ${subChunkCount} 列（一句一列）。` +
        ` 請對齊時間軸後再按「正式輸出影片」。` +
        (lastChunks?.[0]
          ? ` 目前第一句 @ ${Number(lastChunks[0].timestamp[0]).toFixed(2)}s。`
          : '');

      if (els.subsPreview && els.subsPreviewBody) {
        els.subsPreview.hidden = false;
        const preview = lastSrtText.split('\n').slice(0, 60).join('\n');
        els.subsPreviewBody.textContent =
          preview + (lastSrtText.split('\n').length > 60 ? '\n…' : '');
      }
      if (els.subsFirstStart && lastChunks?.[0]) {
        els.subsFirstStart.value = String(
          Math.round(Number(lastChunks[0].timestamp[0]) * 100) / 100,
        );
      }
      // Mount NLE-style timeline after preview + soft captions ready
      const tl = ensureSubtitleTimeline();
      tl?.bindVideo();
      syncTimelineUndoUI();
      // Fit after layout (video metadata may arrive slightly later)
      requestAnimationFrame(() => {
        tl?.fit();
        tl?.render();
        syncTimelineUndoUI();
        setTimeout(() => {
          tl?.fit();
          tl?.render();
          syncTimelineUndoUI();
        }, 400);
      });
    } else {
      isSubtitlePreviewMode = false;
      lastSrtText = null;
      lastSrtFilename = null;
      setSrtDownloadVisible(false);
      if (els.subsPreview) els.subsPreview.hidden = true;
      // No-subs path: download is the merged file immediately
      if (els.btnDownload) {
        els.btnDownload.hidden = false;
        els.btnDownload.href = resultUrl;
        els.btnDownload.textContent = '下載合併影片';
      }
    }

    els.resultBlock.classList.add('is-visible');
    els.resultBlock.classList.remove('is-collapsed');
    if (els.resultCollapsed) els.resultCollapsed.hidden = true;
    if (els.resultBody) els.resultBody.hidden = false;
    if (els.btnClearPreview) els.btnClearPreview.hidden = false;
    if (els.btnClearPreviewCollapsed) els.btnClearPreviewCollapsed.hidden = false;
    syncResultPhaseUI();
    toast(
      wantSubs
        ? '預覽已就緒（會保留到重新產生或清除預覽）'
        : '合併完成，可預覽或下載（會保留到清除預覽）',
      'success',
    );
    els.resultBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    setProgress(0, '失敗');
    appendLog(err?.message || String(err));
    toast(err?.message || '合併失敗，請查看日誌', 'error');
  } finally {
    merging = false;
    updateToolbar();
    renderClips();
  }
}

/* —— Events —— */
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  }
});

els.btnAddMore.addEventListener('click', () => els.fileInput.click());
els.btnClear.addEventListener('click', clearAll);
els.btnMerge.addEventListener('click', runMerge);
els.btnDismissResult.addEventListener('click', hideResultPreview);
els.btnShowResult.addEventListener('click', showResultPreview);
els.btnClearPreview?.addEventListener('click', () => clearPreviewManually());
els.btnClearPreviewCollapsed?.addEventListener('click', () => clearPreviewManually());

// Global Ctrl+Z / Ctrl+Y for subtitle timeline when not typing in an input
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const t = /** @type {HTMLElement} */ (e.target);
  const tag = (t?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
  if (!lastChunks?.length) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoTimeline();
  } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
    e.preventDefault();
    redoTimeline();
  }
});
els.btnExportFinal?.addEventListener('click', () => runFormalExport());
els.btnSubsAdjust?.addEventListener('click', () => applyPreviewOffset());
els.subsAdjustOffset?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyPreviewOffset(); }
});
els.btnSubsFirst?.addEventListener('click', () => applyFirstStart());
els.subsFirstStart?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyFirstStart(); }
});
els.btnSubsPartial?.addEventListener('click', () => applyPartialOffset());
els.subsPartialOffset?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyPartialOffset(); }
});
els.subsPartialFrom?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyPartialOffset(); }
});
els.btnDownloadSrt.addEventListener('click', (e) => {
  e.preventDefault();
  downloadSrt();
});
els.btnDownloadSrtCollapsed.addEventListener('click', (e) => {
  e.preventDefault();
  downloadSrt();
});
// Keep merge button label in sync when subtitle options change
els.optScriptSubs?.addEventListener('change', () => updateToolbar());
els.optAutoSubs?.addEventListener('change', () => updateToolbar());
els.scriptText?.addEventListener('input', () => updateToolbar());

els.btnPickAudio.addEventListener('click', () => {
  if (!els.optNoAudio.checked) els.audioInput.click();
});
els.btnClearAudio.addEventListener('click', clearAudioFile);
els.audioInput.addEventListener('change', () => {
  const f = els.audioInput.files?.[0];
  if (f) setAudioFile(f);
  els.audioInput.value = '';
});
els.optNoAudio.addEventListener('change', () => {
  syncAudioUI();
});
els.optAutoSubs.addEventListener('change', () => {
  if (els.optAutoSubs.checked && !audioFile) {
    toast('請先選擇 MP3 音軌', 'error');
    els.optAutoSubs.checked = false;
  }
  if (els.optAutoSubs.checked && els.optNoAudio.checked) {
    els.optNoAudio.checked = false;
    toast('已關閉「不要聲音」以便產生字幕');
  }
  if (els.optAutoSubs.checked && els.optScriptSubs?.checked) {
    toast('已同時勾選語音稿：合併時將優先使用語音稿', 'info');
  }
  syncAudioUI();
});

els.optScriptSubs.addEventListener('change', () => {
  if (els.optScriptSubs.checked && !getScriptText()) {
    toast('請先貼上或上傳語音稿', 'error');
    // still allow check; merge will validate
    els.scriptText?.focus();
  }
  persistScriptAndSubtitles();
  syncAudioUI();
});

els.scriptText.addEventListener('input', () => {
  if (els.scriptText.value.trim() && !els.optScriptSubs.checked) {
    // gentle: don't auto-check; just update hint
  }
  // Editing script text means next preview regenerates (unless equal to lastScriptSource)
  persistScriptAndSubtitles();
  syncAudioUI();
});

els.btnLoadScript.addEventListener('click', () => els.scriptFile.click());
els.scriptFile.addEventListener('change', async () => {
  const f = els.scriptFile.files?.[0];
  els.scriptFile.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    els.scriptText.value = text;
    els.optScriptSubs.checked = true;
    // New file replaces script → force regenerate next time (keep until clear only if same)
    if (lastScriptSource != null && lastScriptSource !== text.trim()) {
      lastScriptSource = null;
      // Keep old chunks until next generate so user can still download; mark source mismatch
    }
    persistScriptAndSubtitles();
    syncAudioUI();
    toast(`已載入稿件：${f.name}`, 'success');
  } catch (err) {
    toast(err?.message || '讀取稿件失敗', 'error');
  }
});
els.btnClearScript.addEventListener('click', () => {
  clearScriptAndSubtitles();
  syncAudioUI();
  updateToolbar();
  syncResultPhaseUI();
  toast('已清除語音稿與字幕（含時間軸調整）', 'success');
});

document.querySelectorAll('input[name="loop-mode"]').forEach((el) => {
  el.addEventListener('change', () => {
    syncExtendUI();
    persistLoopOptions();
  });
});
['input', 'change'].forEach((evt) => {
  const onLoopField = () => {
    syncExtendUI();
    persistLoopOptions();
  };
  els.loopCount.addEventListener(evt, onLoopField);
  els.loopHours.addEventListener(evt, onLoopField);
  els.loopMins.addEventListener(evt, onLoopField);
  els.loopSecs.addEventListener(evt, onLoopField);
});

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.remove('is-dragover');
  });
});

els.dropzone.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
});

els.clipsRoot.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || merging) return;
  const { action, id } = btn.dataset;
  if (action === 'up') moveClip(id, -1);
  if (action === 'down') moveClip(id, 1);
  if (action === 'remove') removeClip(id);
});

// Restore 延長／目標時長（直到手動「清除全部」）
const hadLoop = restoreLoopOptions();
// Restore 語音稿 + 字幕 session（直到手動「清除稿件」）
restoreScriptAndSubtitles();
if (lastChunks?.length && lastSrtText) {
  if (els.subsPreviewBody) {
    const preview = lastSrtText.split('\n').slice(0, 60).join('\n');
    els.subsPreviewBody.textContent =
      preview + (lastSrtText.split('\n').length > 60 ? '\n…' : '');
  }
  if (els.subsPreview) els.subsPreview.hidden = false;
  if (els.subsResultHint) {
    els.subsResultHint.hidden = false;
    els.subsResultHint.textContent = `已還原上次語音稿字幕（${lastChunks.length} 句）。加入影片並產生預覽後可繼續調時間軸。`;
  }
  setSrtDownloadVisible(true);
  isSubtitlePreviewMode = true;
}
renderClips();
updateToolbar();
syncExtendUI();
if (hadLoop && getLoopMode() === 'duration') {
  const t = getTargetSecondsFromFields();
  if (t > 0) {
    // Light notice only when a non-default duration mode was restored
    console.info(`已還原目標時長：${formatDuration(t)}`);
  }
}
// Restore 加入的影片 + 自訂音軌 + 預覽影片／時間軸（直到重新產生或清除預覽）
(async () => {
  await restoreClipsFromStore();
  await restoreAudioFromStore();
  // Script/subs restored earlier; attach preview video last
  await restorePreviewFromStore();
})();
