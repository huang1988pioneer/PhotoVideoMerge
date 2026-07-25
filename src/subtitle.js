/**
 * Speech-to-text (Whisper via Transformers.js) → SRT / WebVTT subtitles.
 * Decodes local MP3 via Web Audio API (blob URL alone is unreliable for Whisper).
 */

/** @type {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline | null} */
let transcriber = null;
/** @type {string | null} */
let loadedModelId = null;
/** @type {Promise<unknown> | null} */
let loadPromise = null;

const SAMPLE_RATE = 16000;
const PREFERRED_MODEL_KEY = 'videomerge.whisper.model';

/**
 * Prefer models/dtypes that work with current onnxruntime-web.
 * Browser Cache API keeps weights after first successful download.
 */
const LOAD_CANDIDATES = [
  {
    model: 'Xenova/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'whisper-tiny fp32',
  },
  {
    model: 'Xenova/whisper-tiny',
    options: { device: 'wasm' },
    label: 'whisper-tiny default',
  },
  {
    model: 'Xenova/whisper-base',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'whisper-base fp32（中文較準）',
  },
  {
    model: 'onnx-community/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'onnx-community/whisper-tiny fp32',
  },
];

function getPreferredModelId() {
  try {
    return sessionStorage.getItem(PREFERRED_MODEL_KEY) || localStorage.getItem(PREFERRED_MODEL_KEY);
  } catch {
    return null;
  }
}

function setPreferredModelId(modelId) {
  try {
    sessionStorage.setItem(PREFERRED_MODEL_KEY, modelId);
    localStorage.setItem(PREFERRED_MODEL_KEY, modelId);
  } catch {
    /* private mode etc. */
  }
}

/**
 * @param {{ preferBetterChinese?: boolean }} [opts]
 */
function buildCandidateOrder(opts = {}) {
  const preferBase = Boolean(opts.preferBetterChinese);
  const preferred = getPreferredModelId();
  let order = [...LOAD_CANDIDATES];

  if (preferBase) {
    order = [
      ...order.filter((c) => c.model.includes('base')),
      ...order.filter((c) => !c.model.includes('base')),
    ];
  }

  // Always try last successful model first (cached path)
  if (preferred) {
    order = [
      ...order.filter((c) => c.model === preferred),
      ...order.filter((c) => c.model !== preferred),
    ];
  }
  return order;
}

/**
 * @param {(msg: string) => void} [onStatus]
 * @param {(ratio: number) => void} [onProgress]
 * @param {{ preferBetterChinese?: boolean }} [opts]
 */
export async function ensureTranscriber(onStatus, onProgress, opts = {}) {
  // Same page session: model already in memory — no download
  if (transcriber && loadedModelId) {
    onStatus?.(`使用記憶體中的模型（${loadedModelId}，無需重新下載）`);
    onProgress?.(1);
    return transcriber;
  }
  if (loadPromise) return loadPromise;

  const order = buildCandidateOrder(opts);
  const preferred = getPreferredModelId();

  loadPromise = (async () => {
    onStatus?.(
      preferred
        ? '載入語音辨識模型（優先讀取瀏覽器快取，通常很快）…'
        : '載入語音辨識模型（僅首次需下載，之後會快取）…',
    );
    const { pipeline, env } = await import('@huggingface/transformers');

    env.allowLocalModels = false;
    env.useBrowserCache = true; // Cache API / IndexedDB — survives refresh

    let sawNetworkProgress = false;
    const progress_callback = (p) => {
      if (p?.status === 'progress' && typeof p.progress === 'number') {
        // Slow progress usually means real download; instant 100% often cache
        if (p.progress < 100 && p.progress > 0) sawNetworkProgress = true;
        onProgress?.(Math.min(0.95, p.progress / 100));
        const name = p.file ? String(p.file).split('/').pop() : '';
        onStatus?.(
          sawNetworkProgress
            ? `下載模型：${name} ${Math.round(p.progress)}%（僅首次）`
            : `讀取模型：${name} ${Math.round(p.progress)}%`,
        );
      } else if (p?.status === 'done' && p.file) {
        const name = String(p.file).split('/').pop();
        onStatus?.(
          sawNetworkProgress ? `已下載並快取：${name}` : `已從快取載入：${name}`,
        );
      }
    };

    const errors = [];
    for (const candidate of order) {
      try {
        onStatus?.(`載入：${candidate.label}…`);
        const t0 = performance.now();
        const asr = await pipeline(
          'automatic-speech-recognition',
          candidate.model,
          {
            ...candidate.options,
            progress_callback,
          },
        );
        const ms = Math.round(performance.now() - t0);
        transcriber = asr;
        loadedModelId = candidate.model;
        setPreferredModelId(candidate.model);
        onProgress?.(1);
        onStatus?.(
          sawNetworkProgress || ms > 8000
            ? `模型就緒（${candidate.label}，${(ms / 1000).toFixed(1)}s，已寫入快取，下次會更快）`
            : `模型就緒（${candidate.label}，${(ms / 1000).toFixed(1)}s，多半來自快取）`,
        );
        return asr;
      } catch (err) {
        const msg = err?.message || String(err);
        errors.push(`${candidate.label}: ${msg}`);
        onStatus?.(`載入失敗（${candidate.label}），改試下一組…`);
      }
    }

    throw new Error(
      [
        '無法載入 Whisper 模型。',
        '請確認網路可連到 Hugging Face。',
        '若曾清除網站資料，需重新下載一次。',
        errors.join(' | '),
      ].join(' '),
    );
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err instanceof Error
      ? err
      : new Error(`無法載入 Whisper 模型。${err?.message || err}`);
  }
}

/**
 * Decode File/Blob to mono Float32Array @ 16 kHz for Whisper.
 * @param {File | Blob} file
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<Float32Array>}
 */
export async function decodeAudioForWhisper(file, onLog) {
  if (!file) throw new Error('找不到音訊檔');

  // 1) Preferred: Web Audio API (works with local File, MP3/WAV/M4A)
  try {
    const ab = await file.arrayBuffer();
    if (!ab.byteLength) throw new Error('音訊檔是空的');

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('瀏覽器不支援 AudioContext');

    const ctx = new AudioCtx();
    let audioBuffer;
    try {
      // slice copy: decodeAudioData may detach the buffer
      audioBuffer = await ctx.decodeAudioData(ab.slice(0));
    } finally {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }

    const { numberOfChannels, length, sampleRate } = audioBuffer;
    onLog?.(
      `音訊解碼：${(length / sampleRate).toFixed(1)}s · ${sampleRate}Hz · ${numberOfChannels}ch`,
    );

    // Mixdown to mono
    const mono = new Float32Array(length);
    for (let c = 0; c < numberOfChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i] / numberOfChannels;
    }

    // RMS energy check (silence → empty ASR)
    let sumSq = 0;
    const step = Math.max(1, Math.floor(mono.length / 20000));
    let n = 0;
    for (let i = 0; i < mono.length; i += step) {
      sumSq += mono[i] * mono[i];
      n += 1;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    onLog?.(`音量 RMS≈${rms.toFixed(5)}`);
    if (rms < 1e-4) {
      throw new Error(
        '音訊幾乎無聲（或解碼失敗）。請確認 MP3 含人聲且音量正常。',
      );
    }

    if (sampleRate === SAMPLE_RATE) return mono;

    // Linear resample → 16 kHz
    const newLength = Math.max(1, Math.round((length * SAMPLE_RATE) / sampleRate));
    const out = new Float32Array(newLength);
    const ratio = length / newLength;
    for (let i = 0; i < newLength; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, length - 1);
      const t = src - i0;
      out[i] = mono[i0] * (1 - t) + mono[i1] * t;
    }
    onLog?.(`已重採樣至 ${SAMPLE_RATE} Hz（${out.length} samples）`);
    return out;
  } catch (err) {
    onLog?.(`Web Audio 解碼失敗，改試 transformers.read_audio：${err?.message || err}`);
  }

  // 2) Fallback: transformers read_audio (fetch-based)
  const url = URL.createObjectURL(file);
  try {
    const { read_audio } = await import('@huggingface/transformers');
    const audio = await read_audio(url, SAMPLE_RATE);
    if (!(audio instanceof Float32Array) || !audio.length) {
      throw new Error('read_audio 回傳空資料');
    }
    onLog?.(`read_audio 成功：${audio.length} samples @ ${SAMPLE_RATE}Hz`);
    return audio;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {number} sec
 * @param {'srt' | 'vtt'} style
 */
function formatTimestamp(sec, style) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  if (style === 'vtt') {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * @typedef {{ timestamp: [number, number], text: string }} SubChunk
 */

/**
 * Character weight for timing (CJK counts as 1, latin ~0.5, space low).
 * @param {string} text
 */
export function scriptWeight(text) {
  let w = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) w += 0.15;
    else if (/[\u3400-\u9fff\uF900-\uFAFF]/.test(ch)) w += 1;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else w += 0.45;
  }
  return Math.max(0.5, w);
}

/**
 * Split plain script into subtitle lines (Chinese/English punctuation + newlines).
 * If text looks like SRT/VTT, returns null (caller should parse timed format).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitScriptIntoLines(raw) {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];

  // Already timed? leave to parseTimedScript
  if (
    /^WEBVTT/i.test(text) ||
    /^\d+\s*\n\d{1,2}:\d{2}/m.test(text) ||
    /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*/.test(text)
  ) {
    return null;
  }

  // Prefer explicit line breaks first
  const byLine = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  // If user wrote one long paragraph, split on sentence ends
  const lines = [];
  for (const line of byLine) {
    // Keep short lines as-is
    if (line.length <= 40 || !/[。！？!?.；;]/.test(line)) {
      lines.push(line);
      continue;
    }
    // Split but keep delimiter with previous clause
    const parts = line.split(/(?<=[。！？!?.；;])\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      lines.push(line);
    } else {
      for (const p of parts) {
        // Further split very long clauses
        if (p.length > 48) {
          let buf = '';
          for (const ch of p) {
            buf += ch;
            if (buf.length >= 36 && /[，,、\s]/.test(ch)) {
              lines.push(buf.trim());
              buf = '';
            }
          }
          if (buf.trim()) lines.push(buf.trim());
        } else {
          lines.push(p);
        }
      }
    }
  }

  return lines.filter(Boolean);
}

/**
 * Parse user-provided SRT or simple timed lines into chunks.
 * Supports:
 *  - Standard SRT
 *  - WebVTT
 *  - Lines like: [00:01.00-00:03.50] 字幕文字
 *  - Lines like: 00:01 --> 00:03 字幕
 * @param {string} raw
 * @returns {SubChunk[] | null}
 */
export function parseTimedScript(raw) {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;

  /** @type {SubChunk[]} */
  const chunks = [];

  const toSec = (h, m, s, ms) => {
    const frac = ms != null ? Number(`0.${String(ms).padEnd(3, '0').slice(0, 3)}`) : 0;
    return (
      (Number(h) || 0) * 3600 +
      (Number(m) || 0) * 60 +
      (Number(s) || 0) +
      frac
    );
  };

  const parseTs = (str) => {
    const t = str.trim().replace(',', '.');
    let m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (m) return toSec(m[1] || 0, m[2], m[3], m[4]);
    m = t.match(/^(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (m) return toSec(0, m[1], m[2], m[3]);
    m = t.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
    return NaN;
  };

  // SRT / VTT blocks with -->
  if (/\d{1,2}:\d{2}.*-->/.test(text) || /^WEBVTT/i.test(text)) {
    const body = text.replace(/^WEBVTT[^\n]*\n+/i, '');
    const blocks = body.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) continue;
      const [a, b] = timeLine.split('-->').map((x) => x.trim());
      const start = parseTs(a.split(/\s+/)[0]);
      const end = parseTs(b.split(/\s+/)[0]);
      const cueText = lines
        .filter((l) => l !== timeLine && !/^\d+$/.test(l))
        .join('\n')
        .trim();
      if (cueText && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        chunks.push({ timestamp: [start, end], text: cueText });
      }
    }
    return chunks.length ? chunks : null;
  }

  // [mm:ss-mm:ss] text  or  [0:01.0-0:03.0] text
  const bracketRe =
    /^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*[-–—~]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*\]?\s*(.+)$/;
  for (const line of text.split('\n')) {
    const m = line.trim().match(bracketRe);
    if (!m) continue;
    const start = parseTs(m[1]);
    const end = parseTs(m[2]);
    const cue = m[3].trim();
    if (cue && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      chunks.push({ timestamp: [start, end], text: cue });
    }
  }
  return chunks.length ? chunks : null;
}

/**
 * RMS bounds on a mono waveform (energy only — may trigger on instruments).
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{
 *   frameMs?: number,
 *   thresholdRatio?: number,
 *   minRunFrames?: number,
 *   minOnsetSec?: number,
 * }} [opts]
 * @returns {{ onsetSec: number, endSec: number, peakRms: number }}
 */
export function detectSpeechBounds(mono, sampleRate, opts = {}) {
  const frameMs = opts.frameMs ?? 30;
  const thresholdRatio = opts.thresholdRatio ?? 0.14;
  const minRunFrames = opts.minRunFrames ?? 5; // ~150ms+ sustained
  const minOnsetSec = opts.minOnsetSec ?? 0;
  const frameSize = Math.max(64, Math.floor((sampleRate * frameMs) / 1000));
  const nFrames = Math.floor(mono.length / frameSize);
  const durationSec = mono.length / sampleRate;
  if (nFrames < 2) {
    return { onsetSec: 0, endSec: durationSec, peakRms: 0 };
  }

  const rms = new Float32Array(nFrames);
  let peak = 0;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const base = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const v = mono[base + i];
      sum += v * v;
    }
    const r = Math.sqrt(sum / frameSize);
    rms[f] = r;
    if (r > peak) peak = r;
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.2)] || 0;
  // Never let noise floor dominate peak — otherwise thr can exceed peak and
  // no frame ever qualifies (common on continuous music beds).
  const thr = Math.min(
    peak * 0.55,
    Math.max(peak * thresholdRatio, noise * 3.5, 0.006),
  );

  const startFrame = Math.floor((minOnsetSec * sampleRate) / frameSize);

  let onsetFrame = startFrame;
  for (let f = startFrame; f < nFrames; f++) {
    let ok = true;
    for (let k = 0; k < minRunFrames; k++) {
      if (f + k >= nFrames || rms[f + k] < thr) {
        ok = false;
        break;
      }
    }
    if (ok) {
      onsetFrame = f;
      break;
    }
  }

  let endFrame = nFrames - 1;
  for (let f = nFrames - 1; f >= onsetFrame; f--) {
    let ok = true;
    for (let k = 0; k < minRunFrames; k++) {
      if (f - k < 0 || rms[f - k] < thr) {
        ok = false;
        break;
      }
    }
    if (ok) {
      endFrame = f;
      break;
    }
  }

  const onsetSec = (onsetFrame * frameSize) / sampleRate;
  const endSec = Math.min(durationSec, ((endFrame + 1) * frameSize) / sampleRate);
  return { onsetSec, endSec, peakRms: peak };
}

/**
 * Band-pass filter mono audio to focus on vocal / singing range (~350–4500 Hz).
 * Uses steeper HP cutoff to reject kick/bass and a peaking EQ at ~2.5 kHz to
 * boost the most discriminating vocal formant (F2) region.
 * Skips bass intros and pure instrumental beds better than full-band RMS.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @returns {Promise<Float32Array>}
 */
async function filterVocalBand(mono, sampleRate) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return mono;

  const len = mono.length;
  const ctx = new OfflineCtx(1, len, sampleRate);
  const buffer = ctx.createBuffer(1, len, sampleRate);
  const ch = buffer.getChannelData(0);
  ch.set(mono);

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // Stage 1: HP @ 380 Hz — aggressively cuts kick drum (50–100 Hz) and bass guitar
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 380;
  hp.Q.value = 0.9;

  // Stage 2: HP @ 340 Hz (cascaded for steeper roll-off ~24 dB/oct below ~360 Hz)
  const hp2 = ctx.createBiquadFilter();
  hp2.type = 'highpass';
  hp2.frequency.value = 340;
  hp2.Q.value = 0.6;

  // Stage 3: Peaking EQ @ 2500 Hz — boosts vocal F2 formant region
  // Human voice has strong energy here; most instruments are weaker at this freq.
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 2500;
  peak.Q.value = 1.2;
  peak.gain.value = 6; // +6 dB boost

  // Stage 4: LP @ 4500 Hz — retains fricatives (s, sh, f sounds) but cuts hats
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4500;
  lp.Q.value = 0.707;

  src.connect(hp);
  hp.connect(hp2);
  hp2.connect(peak);
  peak.connect(lp);
  lp.connect(ctx.destination);
  src.start(0);

  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice(0);
}

/**
 * Smooth a frame series with a short centered window (~±250ms).
 * @param {Float32Array} src
 * @param {number} halfWin frames on each side
 */
function smoothFrames(src, halfWin) {
  const n = src.length;
  const out = new Float32Array(n);
  const w = Math.max(1, halfWin | 0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let k = -w; k <= w; k++) {
      const j = i + k;
      if (j >= 0 && j < n) {
        sum += src[j];
        c += 1;
      }
    }
    out[i] = sum / Math.max(1, c);
  }
  return out;
}

/**
 * Detect singing / speech entry.
 *
 * Primary signal for music (Suno / kids songs / ballads): quiet intro then a
 * clear energy rise into the song body — NOT raw mid-band RMS at 0:00, and
 * NOT vocal-ratio alone (mid-heavy mixes often keep ratio high through intros).
 *
 * v2 improvements:
 *  - Per-frame vocalRatio (vocRms/fullRms) used in scoring and intro detection.
 *  - hasQuietIntro also fires when early vocalRatio is low (beat intro with no voice).
 *  - Candidate scoring includes a vocalRatio-rise bonus.
 *  - Earliest candidate undergoes a 1.5s persistence check to reject drum hits.
 *  - Safety guard extended from 1.2s to 1.5s.
 *
 * @param {Float32Array} mono full-band
 * @param {Float32Array} vocal mono vocal-filtered
 * @param {number} sampleRate
 * @returns {{ onsetSec: number, endSec: number, peakRms: number, method: string, introSec: number }}
 */
function detectVocalOnsetFromBands(mono, vocal, sampleRate) {
  const frameMs = 40;
  const frameSize = Math.max(128, Math.floor((sampleRate * frameMs) / 1000));
  const hop = Math.floor(frameSize / 2);
  const hopSec = hop / sampleRate;
  const nFrames = Math.max(1, Math.floor((mono.length - frameSize) / hop) + 1);
  const durationSec = mono.length / sampleRate;

  const fullRms = new Float32Array(nFrames);
  const vocRms = new Float32Array(nFrames);
  /** Ratio of vocal-band energy to full-band energy per frame */
  const vocalRatio = new Float32Array(nFrames);
  let peakV = 0;
  let peakF = 0;

  for (let f = 0; f < nFrames; f++) {
    const base = f * hop;
    let sf = 0;
    let sv = 0;
    for (let i = 0; i < frameSize; i++) {
      const a = mono[base + i] || 0;
      const b = vocal[base + i] || 0;
      sf += a * a;
      sv += b * b;
    }
    fullRms[f] = Math.sqrt(sf / frameSize);
    vocRms[f] = Math.sqrt(sv / frameSize);
    // vocalRatio: how much of the energy is in the vocal band
    vocalRatio[f] = fullRms[f] > 1e-6 ? vocRms[f] / fullRms[f] : 0;
    if (vocRms[f] > peakV) peakV = vocRms[f];
    if (fullRms[f] > peakF) peakF = fullRms[f];
  }

  // ~200ms smooth — reject single drum hits but keep phrase onsets
  const halfWin = Math.max(2, Math.round(200 / frameMs));
  const smF = smoothFrames(fullRms, halfWin);
  const smV = smoothFrames(vocRms, halfWin);
  const smR = smoothFrames(vocalRatio, halfWin); // smoothed vocal ratio

  const sortedF = Array.from(smF).sort((a, b) => a - b);
  const sortedV = Array.from(smV).sort((a, b) => a - b);
  const sortedR = Array.from(smR).sort((a, b) => a - b);
  const p20F = sortedF[Math.floor(nFrames * 0.2)] || 0;
  const p50F = sortedF[Math.floor(nFrames * 0.5)] || 0;
  const p90F = sortedF[Math.floor(nFrames * 0.9)] || peakF;
  const p50V = sortedV[Math.floor(nFrames * 0.5)] || 0;
  const p80V = sortedV[Math.floor(nFrames * 0.8)] || peakV;
  const noiseV = sortedV[Math.floor(nFrames * 0.25)] || 0;
  // Global median vocal ratio — body sections (with voice) tend to lift this above intro
  const medianR = sortedR[Math.floor(nFrames * 0.5)] || 0;

  // --- Quiet intro / beat-intro detection ---
  const introProbeSec = Math.min(10, Math.max(4, durationSec * 0.12));
  const introFrames = Math.max(1, Math.floor(introProbeSec / hopSec));
  let earlySum = 0;
  let earlyVRatioSum = 0;
  let earlyN = 0;
  for (let f = 0; f < Math.min(introFrames, nFrames); f++) {
    earlySum += smF[f];
    earlyVRatioSum += smR[f];
    earlyN += 1;
  }
  const earlyAvg = earlyN ? earlySum / earlyN : 0;
  const earlyVocalRatio = earlyN ? earlyVRatioSum / earlyN : 0;

  // Quiet intro: energy criterion (classic) OR vocal-ratio-low criterion (v2).
  // The second branch catches "beat intro" tracks: drums/pads are audible, so
  // earlyAvg is moderate, but voice hasn't entered yet (earlyVocalRatio is low).
  const hasQuietIntro =
    durationSec > 8 &&
    earlyAvg > 1e-5 &&
    (
      // Classic: full-band energy well below the median song body
      (earlyAvg < p50F * 0.72 && p90F > earlyAvg * 1.75 && p90F > peakF * 0.35) ||
      // Beat intro: energy moderate, but vocal-band ratio is clearly below the body
      (earlyVocalRatio < Math.max(medianR * 0.45, 0.3) && medianR > 0.28 && durationSec > 12)
    );

  // Body threshold relative to intro when quiet; else absolute energy
  let bodyThrF = hasQuietIntro
    ? Math.max(earlyAvg * 2.6, p50F * 0.7, peakF * 0.2, 0.02)
    : Math.max(peakF * 0.16, p50F * 0.85, p20F * 2.2, 0.01);
  bodyThrF = Math.min(bodyThrF, peakF * 0.55);

  // Mid-band (voice-ish) companion thr — capped so continuous beds still work
  let bodyThrV = hasQuietIntro
    ? Math.max(earlyAvg * 1.8, p50V * 0.65, peakV * 0.18, 0.012)
    : Math.max(peakV * 0.18, p50V * 0.8, noiseV * 3, 0.008);
  bodyThrV = Math.min(bodyThrV, peakV * 0.55 || bodyThrV);

  // Vocal ratio threshold — above this level strongly suggests voice is present
  const ratioThr = Math.max(medianR * 0.55, earlyVocalRatio * 1.6, 0.32);

  // Phrase onset can be short (~350ms); don't require full chorus sustain
  const runFrames = Math.max(5, Math.round(0.35 / hopSec));
  const lookback = Math.max(8, Math.round(1.4 / hopSec));
  // Persistence window for candidacy validation (~1.5s post-onset)
  const persistFrames = Math.max(8, Math.round(1.5 / hopSec));

  /**
   * @param {number} f
   * @returns {{ ok: boolean, rise: number, prev: number, cur: number, midOk: number, ratioOk: number, ratioRise: number, curR: number }}
   */
  const evalOnset = (f) => {
    let okF = 0;
    let midOk = 0;
    let ratioOk = 0;
    for (let k = 0; k < runFrames; k++) {
      const i = f + k;
      if (i >= nFrames) break;
      if (smF[i] >= bodyThrF) okF += 1;
      if (smV[i] >= bodyThrV * 0.85) midOk += 1;
      if (smR[i] >= ratioThr) ratioOk += 1;
    }
    let prev = 0;
    let prevR = 0;
    let c = 0;
    for (let i = Math.max(0, f - lookback); i < f; i++) {
      prev += smF[i];
      prevR += smR[i];
      c += 1;
    }
    prev = c ? prev / c : smF[f];
    prevR = c ? prevR / c : smR[f];
    const cur = smF[f];
    const curR = smR[f];
    const rise = cur / Math.max(prev, 1e-6);
    // Vocal ratio rise: how much the ratio lifted relative to the lookback average
    const ratioRise = curR / Math.max(prevR, 0.05);
    const ok =
      okF >= runFrames * 0.72 &&
      // need either mid-band presence, strong full-band, or rising vocal ratio
      (midOk >= runFrames * 0.4 || cur >= bodyThrF * 1.05 || ratioOk >= runFrames * 0.5);
    return { ok, rise, prev, cur, midOk, ratioOk, ratioRise, curR };
  };

  /**
   * Verify that a candidate onset sustains for ~1.5s (rejects drum transients).
   * Returns true if energy + vocal ratio are maintained for 60% of the window.
   * @param {number} f
   */
  const isPersistent = (f) => {
    if (f + persistFrames >= nFrames) return true; // near end — accept
    const sustainThr = bodyThrF * 0.65;
    const ratioHoldThr = ratioThr * 0.75;
    let energyOk = 0;
    let ratioOk = 0;
    for (let k = 0; k < persistFrames; k++) {
      const i = f + k;
      if (i >= nFrames) break;
      if (smF[i] >= sustainThr) energyOk += 1;
      if (smR[i] >= ratioHoldThr) ratioOk += 1;
    }
    // Accept if energy is sustained, OR combined energy + vocal-ratio evidence
    return (
      energyOk >= persistFrames * 0.6 ||
      (energyOk >= persistFrames * 0.45 && ratioOk >= persistFrames * 0.4)
    );
  };

  /** @type {{ frame: number, t: number, score: number, rise: number }[]} */
  const riseCandidates = [];
  const scanStart = hasQuietIntro ? Math.floor(0.6 / hopSec) : 0;
  for (let f = scanStart; f < nFrames - runFrames; f++) {
    const e = evalOnset(f);
    if (!e.ok) continue;
    if (hasQuietIntro) {
      // Require clear lift out of intro (skip soft pads that barely clear thr)
      if (e.rise < 1.45 && e.prev > bodyThrF * 0.72) continue;
      if (e.cur < bodyThrF * 0.95) continue;
    }
    // Score: energy × (rise factor) + vocal-ratio bonus (capped at 25% of total)
    const ratioBonus = Math.min(0.25, (e.ratioRise - 1) * 0.15 + (e.curR > ratioThr ? 0.10 : 0));
    const score = e.cur * (0.55 + Math.min(2.8, e.rise) * 0.30 + ratioBonus);
    riseCandidates.push({
      frame: f,
      t: f * hopSec,
      score,
      rise: e.rise,
    });
    // Skip dense duplicates within ~0.5s
    f += Math.max(1, Math.round(0.45 / hopSec));
  }

  let onsetFrame = -1;
  let method = 'energy-body';
  let introSec = hasQuietIntro ? introProbeSec : 0;

  if (riseCandidates.length) {
    // Prefer earliest solid entry — not chorus peak later in the song
    const best = Math.max(...riseCandidates.map((c) => c.score));
    // Slightly tighter bar (0.42 vs old 0.38) to keep quality candidates
    const good = riseCandidates
      .filter((c) => c.score >= best * 0.42)
      .sort((a, b) => a.frame - b.frame);

    // Walk from earliest to find first persistent onset (not just a drum transient)
    let chosen = good[0];
    for (const cand of good) {
      if (isPersistent(cand.frame)) {
        chosen = cand;
        break;
      }
    }
    onsetFrame = chosen.frame;
    method = hasQuietIntro ? 'energy-rise-after-intro' : 'energy-body';
    if (hasQuietIntro) {
      introSec = Math.max(0, chosen.t - 0.15);
    }
  }

  // Secondary: mid-band absolute energy (speech / vocal-led, little intro)
  if (onsetFrame < 0) {
    const thrV = Math.min(
      peakV * 0.5,
      Math.max(peakV * 0.2, p80V * 0.4, noiseV * 3.5, 0.005),
    );
    const minRun = Math.max(5, Math.round(0.3 / hopSec));
    for (let f = 0; f < nFrames - minRun; f++) {
      let ok = 0;
      for (let k = 0; k < minRun; k++) {
        if (smV[f + k] >= thrV) ok += 1;
      }
      if (ok >= minRun) {
        onsetFrame = f;
        method = 'vocal-band-energy';
        break;
      }
    }
  }

  // Last resort
  if (onsetFrame < 0) {
    const loose = detectSpeechBounds(vocal, sampleRate, {
      frameMs: 40,
      thresholdRatio: 0.18,
      minRunFrames: Math.max(5, Math.round(280 / 40)),
      minOnsetSec: hasQuietIntro ? Math.max(2, introProbeSec * 0.4) : 0.15,
    });
    return {
      onsetSec: loose.onsetSec,
      endSec: loose.endSec,
      peakRms: peakV || peakF,
      method: 'energy-fallback',
      introSec: hasQuietIntro ? introProbeSec : 0,
    };
  }

  let onsetSec = onsetFrame * hopSec;

  // Never trust near-zero on quiet/beat-intro music beds (guard extended to 1.5s)
  if (hasQuietIntro && onsetSec < 1.5 && riseCandidates.length > 1) {
    const later = riseCandidates.find((c) => c.t >= 1.8);
    if (later && isPersistent(later.frame)) {
      onsetFrame = later.frame;
      onsetSec = later.t;
      method = 'energy-skip-false-zero';
      introSec = Math.max(introSec, 1.5);
    }
  }

  // End of active body
  let endFrame = nFrames - 1;
  const endRun = Math.max(runFrames, Math.round(0.5 / hopSec));
  const endThr = bodyThrF * 0.72;
  for (let f = nFrames - 1; f >= onsetFrame; f--) {
    let ok = 0;
    for (let k = 0; k < endRun; k++) {
      if (f - k >= 0 && smF[f - k] >= endThr) ok += 1;
    }
    if (ok >= endRun * 0.65) {
      endFrame = f;
      break;
    }
  }

  const endSec = Math.min(
    durationSec,
    (endFrame * hop + frameSize) / sampleRate,
  );

  return {
    onsetSec,
    endSec,
    peakRms: peakV || peakF,
    method,
    introSec,
  };
}

/**
 * Decode file and detect singing/speech onset (skips pure instrumental intros).
 * Assumption: lyrics/singing almost never begin at 0:00 on commercial music beds.
 * @param {File | Blob} file
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{ onsetSec: number, endSec: number, durationSec: number, method?: string }>}
 */
export async function detectAudioSpeechOnset(file, onLog) {
  const wave = await decodeAudioForWhisper(file, onLog);
  const durationSec = wave.length / SAMPLE_RATE;

  onLog?.('分析歌聲起點（前奏樂器 ≠ 開唱；偵測安靜前奏後的能量躍升）…');
  let vocal = wave;
  try {
    vocal = await filterVocalBand(wave, SAMPLE_RATE);
  } catch (e) {
    onLog?.(`人聲濾波失敗，改用全頻：${e?.message || e}`);
  }

  let bounds = detectVocalOnsetFromBands(wave, vocal, SAMPLE_RATE);

  // Safety net (v2: extended to 1.5s). If onset is still too early on a long
  // track, look for a real quiet→loud energy step beyond 2s.
  if (durationSec > 10 && bounds.onsetSec < 1.5) {
    const frameMs = 50;
    const frameSize = Math.max(128, Math.floor((SAMPLE_RATE * frameMs) / 1000));
    const nFrames = Math.floor(wave.length / frameSize);
    if (nFrames > 40) {
      const rms = new Float32Array(nFrames);
      let peak = 0;
      for (let f = 0; f < nFrames; f++) {
        let sum = 0;
        const base = f * frameSize;
        for (let i = 0; i < frameSize; i++) {
          const v = wave[base + i] || 0;
          sum += v * v;
        }
        rms[f] = Math.sqrt(sum / frameSize);
        if (rms[f] > peak) peak = rms[f];
      }
      const sm = smoothFrames(rms, 3);
      const sorted = Array.from(sm).sort((a, b) => a - b);
      const p50 = sorted[Math.floor(nFrames * 0.5)] || 0;
      const earlyN = Math.min(nFrames, Math.floor(8 / (frameMs / 1000)));
      let early = 0;
      for (let f = 0; f < earlyN; f++) early += sm[f];
      early /= Math.max(1, earlyN);
      if (early < p50 * 0.6 && peak > early * 2) {
        const thr = Math.max(early * 2.5, p50 * 0.7, peak * 0.22);
        const run = Math.max(4, Math.round(400 / frameMs));
        const look = Math.max(6, Math.round(1200 / frameMs));
        const startF = Math.floor(2 / (frameMs / 1000));
        for (let f = startF; f < nFrames - run; f++) {
          let ok = 0;
          for (let k = 0; k < run; k++) if (sm[f + k] >= thr) ok += 1;
          if (ok < run * 0.75) continue;
          let prev = 0;
          let c = 0;
          for (let i = Math.max(0, f - look); i < f; i++) {
            prev += sm[i];
            c += 1;
          }
          prev = c ? prev / c : sm[f];
          if (sm[f] >= prev * 1.45) {
            const t = (f * frameSize) / SAMPLE_RATE;
            if (t > bounds.onsetSec + 0.8) {
              onLog?.(
                `拒絕過早起點 ${bounds.onsetSec.toFixed(2)}s，改能量躍升 ${t.toFixed(2)}s`,
              );
              bounds = {
                onsetSec: t,
                endSec: bounds.endSec,
                peakRms: bounds.peakRms,
                method: 'energy-rise-guard',
                introSec: t,
              };
            }
            break;
          }
        }
      }
    }
  }

  onLog?.(
    `開唱／人聲≈${bounds.onsetSec.toFixed(2)}s · 終點≈${bounds.endSec.toFixed(2)}s · ${bounds.method}` +
      (bounds.introSec ? ` · 前奏~${bounds.introSec.toFixed(1)}s` : ''),
  );

  return {
    onsetSec: bounds.onsetSec,
    endSec: bounds.endSec,
    durationSec,
    method: bounds.method,
  };
}

/**
 * Auto subtitle offset so first cue aligns with detected speech onset.
 * offset = speechOnset - firstCueStart  (positive → delay subtitles)
 * @param {SubChunk[]} chunks
 * @param {number} speechOnsetSec
 * @param {{ clamp?: [number, number], biasSec?: number }} [opts]
 * @returns {number}
 */
export function computeAutoOffsetSec(chunks, speechOnsetSec, opts = {}) {
  // Soft intros on kids/AI songs often run 10–25s before first lyric
  const [lo, hi] = opts.clamp || [-30, 45];
  // Slightly before speech feels natural for reading; keep tiny
  const bias = opts.biasSec ?? -0.05;
  if (!chunks?.length) return 0;
  const firstStart = Number(chunks[0].timestamp?.[0]) || 0;
  const onset = Number(speechOnsetSec);
  if (!Number.isFinite(onset)) return 0;
  let delta = onset - firstStart + bias;
  if (!Number.isFinite(delta)) return 0;
  delta = Math.max(lo, Math.min(hi, delta));
  if (Math.abs(delta) < 0.03) return 0;
  return Math.round(delta * 100) / 100;
}

/**
 * Build script subtitles that only start when speech starts (silence before = no cues).
 * Plain text is paced across the active speech window [onset, end], then placed at onset.
 * Timed SRT/VTT is shifted so first cue meets speech onset.
 *
 * @param {string} scriptText
 * @param {{
 *   cycleDur: number,
 *   onsetSec: number,
 *   endSec: number,
 * }} speech
 * @returns {{ chunks: SubChunk[], srt: string, vtt: string, text: string, source: string }}
 */
export function scriptToSubtitlesFromSpeechStart(scriptText, speech) {
  const cycleDur = Math.max(0.5, Number(speech.cycleDur) || 0);
  let onset = Math.max(0, Number(speech.onsetSec) || 0);
  let end = Number(speech.endSec);
  if (!Number.isFinite(end) || end <= onset + 0.3) {
    end = cycleDur;
  }
  end = Math.min(cycleDur, end);
  // Keep a little tail after last energy for last syllable
  end = Math.min(cycleDur, end + 0.15);
  onset = Math.min(onset, Math.max(0, end - 0.5));

  const span = Math.max(0.6, end - onset);

  // Timed files: keep relative structure, only snap start to speech
  const timed = parseTimedScript(scriptText);
  if (timed?.length) {
    const delta = computeAutoOffsetSec(timed, onset, { biasSec: 0 });
    const chunks = shiftChunks(timed, delta, cycleDur);
    // Drop any cue still entirely before speech (shouldn't happen)
    const filtered = chunks.filter((c) => c.timestamp[1] > onset - 0.05);
    return {
      chunks: filtered.length ? filtered : chunks,
      srt: chunksToSrt(filtered.length ? filtered : chunks),
      vtt: chunksToVtt(filtered.length ? filtered : chunks),
      text: (filtered.length ? filtered : chunks).map((c) => c.text).join(' '),
      source: 'timed+speech-start',
    };
  }

  // Plain script: fit into speech/singing window only (no pre-roll before voice).
  // Singing is slower than spoken Chinese (~3.2) — use ~2.4 weight-units/s so
  // short lyric lines aren't over-compressed against long music beds.
  const built = scriptToSubtitles(scriptText, span, {
    leadInSec: 0,
    leadOutSec: 0.12,
    minCueSec: 0.85,
    maxCueSec: 9,
    charsPerSec: 2.4,
    gapSec: 0.08,
  });
  // Place window at speech onset
  const placed = shiftChunks(built.chunks, onset, cycleDur);
  // Ensure first cue starts at/after onset (no silent-region subtitles)
  if (placed.length) {
    placed[0].timestamp[0] = Math.max(placed[0].timestamp[0], onset);
    if (placed[0].timestamp[1] <= placed[0].timestamp[0]) {
      placed[0].timestamp[1] = Math.min(cycleDur, placed[0].timestamp[0] + 0.6);
    }
  }

  return {
    chunks: placed,
    srt: chunksToSrt(placed),
    vtt: chunksToVtt(placed),
    text: built.text,
    source: 'script+speech-start',
  };
}

/**
 * Shift all cue times by delta seconds (can be negative). Clamps start >= 0.
 * @param {SubChunk[]} chunks
 * @param {number} deltaSec
 * @param {number} [maxEndSec] clamp ends to this duration if provided
 * @returns {SubChunk[]}
 */
export function shiftChunks(chunks, deltaSec, maxEndSec) {
  const d = Number(deltaSec) || 0;
  if (!d && maxEndSec == null) return chunks;
  /** @type {SubChunk[]} */
  const out = [];
  for (const c of chunks) {
    let s = c.timestamp[0] + d;
    let e = c.timestamp[1] + d;
    if (Number.isFinite(maxEndSec)) {
      if (s >= maxEndSec) continue;
      e = Math.min(e, maxEndSec);
    }
    if (s < 0) {
      e += -s; // keep length when clamping start
      s = 0;
    }
    if (e <= s) e = s + 0.4;
    out.push({ timestamp: [s, e], text: c.text });
  }
  return out;
}

/**
 * Shift cues from fromIdx (0-based) onwards by deltaSec; leave earlier cues unchanged.
 * Useful for correcting drift in the latter half of a subtitle track without touching
 * the cues that are already correctly timed.
 *
 * @param {SubChunk[]} chunks
 * @param {number} fromIdx   0-based index of the first cue to shift
 * @param {number} deltaSec  Seconds to add (negative = move earlier)
 * @param {number} [maxEndSec]
 * @returns {SubChunk[]}
 */
export function shiftChunksFrom(chunks, fromIdx, deltaSec, maxEndSec) {
  const d = Number(deltaSec) || 0;
  const from = Math.max(0, Math.floor(fromIdx));
  /** @type {SubChunk[]} */
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (i < from || !d) {
      // Keep cues before the split point as-is (but still filter by maxEndSec)
      if (Number.isFinite(maxEndSec) && c.timestamp[0] >= maxEndSec) continue;
      out.push({ timestamp: [...c.timestamp], text: c.text });
    } else {
      let s = c.timestamp[0] + d;
      let e = c.timestamp[1] + d;
      if (Number.isFinite(maxEndSec)) {
        if (s >= maxEndSec) continue;
        e = Math.min(e, maxEndSec);
      }
      if (s < 0) {
        e += -s;
        s = 0;
      }
      if (e <= s) e = s + 0.4;
      out.push({ timestamp: [s, e], text: c.text });
    }
  }
  return out;
}

/**
 * Build timed subtitles from plain script + speech-cycle duration.
 * Uses speaking-rate model (CJK ~3.2 weight-units/sec), then scale-to-fit
 * the target duration so the last cue ends with the audio/video cycle.
 *
 * @param {string} scriptText
 * @param {number} durationSec  One speech cycle (usually MP3 length, else video)
 * @param {{
 *   minCueSec?: number,
 *   maxCueSec?: number,
 *   gapSec?: number,
 *   charsPerSec?: number,
 *   leadInSec?: number,
 *   leadOutSec?: number,
 * }} [opts]
 * @returns {{ chunks: SubChunk[], srt: string, vtt: string, text: string, source: 'timed' | 'script' }}
 */
export function scriptToSubtitles(scriptText, durationSec, opts = {}) {
  const minCueSec = opts.minCueSec ?? 0.85;
  const maxCueSec = opts.maxCueSec ?? 7.5;
  const gapSec = opts.gapSec ?? 0.06;
  // Spoken Chinese ≈ 3–4 chars/s; weight units ≈ similar for CJK
  const charsPerSec = opts.charsPerSec ?? 3.2;
  const leadInSec = opts.leadInSec ?? 0.12;
  const leadOutSec = opts.leadOutSec ?? 0.15;

  const timed = parseTimedScript(scriptText);
  if (timed?.length) {
    return {
      chunks: timed,
      srt: chunksToSrt(timed),
      vtt: chunksToVtt(timed),
      text: timed.map((c) => c.text).join(' '),
      source: 'timed',
    };
  }

  const lines = splitScriptIntoLines(scriptText);
  if (!lines.length) {
    throw new Error('語音稿是空的，請貼上或上傳文字稿');
  }

  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0.5) {
    throw new Error('無法取得影片／音訊時長，請先加入影片（或選擇音軌）再上字幕');
  }

  const weights = lines.map((l) => scriptWeight(l));
  // Ideal durations from speaking rate
  let ideals = weights.map((w) => {
    const ideal = w / charsPerSec;
    return Math.min(maxCueSec, Math.max(minCueSec, ideal));
  });
  const gapsTotal = Math.max(0, lines.length - 1) * gapSec;
  const lead = leadInSec + leadOutSec;
  let sumIdeal = ideals.reduce((a, b) => a + b, 0) + gapsTotal + lead;

  // Scale to fit available duration (keeps relative pacing of speech)
  const usable = Math.max(dur - 0.02, lines.length * minCueSec * 0.4);
  if (sumIdeal > 1e-6) {
    const scale = (usable - gapsTotal - lead) / (sumIdeal - gapsTotal - lead);
    if (Number.isFinite(scale) && scale > 0) {
      ideals = ideals.map((x) =>
        Math.min(maxCueSec, Math.max(minCueSec * 0.7, x * scale)),
      );
    }
  }

  // Re-normalize if still over/under
  let sumCues = ideals.reduce((a, b) => a + b, 0);
  const targetCues = Math.max(usable - gapsTotal - lead, lines.length * minCueSec * 0.5);
  if (sumCues > 1e-6) {
    const s2 = targetCues / sumCues;
    ideals = ideals.map((x) => Math.max(0.5, x * s2));
  }

  /** @type {SubChunk[]} */
  const chunks = [];
  let t = leadInSec;
  for (let i = 0; i < lines.length; i++) {
    let len = ideals[i];
    if (i === lines.length - 1) {
      // Snap last cue end to cycle end (minus lead-out)
      const endTarget = Math.max(t + minCueSec, dur - leadOutSec);
      len = endTarget - t;
    }
    let end = t + len;
    if (end > dur) end = dur;
    if (end <= t) end = Math.min(dur, t + 0.5);
    chunks.push({ timestamp: [t, end], text: lines[i] });
    t = end + (i < lines.length - 1 ? gapSec : 0);
  }

  // Ensure last ends at duration (audio/video cycle end)
  if (chunks.length) {
    chunks[0].timestamp[0] = Math.max(0, chunks[0].timestamp[0]);
    chunks[chunks.length - 1].timestamp[1] = dur;
  }

  return {
    chunks,
    srt: chunksToSrt(chunks),
    vtt: chunksToVtt(chunks),
    text: lines.join(' '),
    source: 'script',
  };
}

/**
 * Resolve how to time subtitles against video + optional custom audio.
 * Custom audio is looped to video length in merge (-stream_loop -1 -shortest),
 * so one speech cycle = min(audio, video) or audio if video longer with loop.
 *
 * @param {{
 *   videoDur: number,
 *   audioDur?: number | null,
 *   hasCustomAudio?: boolean,
 * }} p
 * @returns {{ cycleDur: number, totalDur: number, mode: string }}
 */
export function resolveSubtitleTimeline(p) {
  const videoDur = Math.max(0, Number(p.videoDur) || 0);
  const audioDur = Math.max(0, Number(p.audioDur) || 0);
  const hasAudio = Boolean(p.hasCustomAudio) && audioDur > 0.2;

  if (!hasAudio) {
    return {
      cycleDur: videoDur,
      totalDur: videoDur,
      mode: 'video-only',
    };
  }

  // Final mux: video length wins; audio loops if shorter, cut if longer.
  const totalDur = videoDur > 0.2 ? videoDur : audioDur;

  if (audioDur <= totalDur + 0.15) {
    // Speech cycle = full audio; tile subtitles when video longer
    return {
      cycleDur: audioDur,
      totalDur,
      mode: 'audio-cycle-tile',
    };
  }

  // Audio longer than video → audio is cut at video end; time to video
  return {
    cycleDur: totalDur,
    totalDur,
    mode: 'audio-trimmed-to-video',
  };
}

/**
 * @param {SubChunk[]} chunks
 * @returns {string}
 */
export function chunksToSrt(chunks) {
  const lines = [];
  let idx = 1;
  for (const c of chunks) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [0, 0];
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    lines.push(String(idx));
    lines.push(
      `${formatTimestamp(start, 'srt')} --> ${formatTimestamp(end, 'srt')}`,
    );
    lines.push(text);
    lines.push('');
    idx += 1;
  }
  return lines.join('\n');
}

/**
 * @param {SubChunk[]} chunks
 * @returns {string}
 */
export function chunksToVtt(chunks) {
  const lines = ['WEBVTT', ''];
  let idx = 1;
  for (const c of chunks) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [0, 0];
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    lines.push(String(idx));
    lines.push(
      `${formatTimestamp(start, 'vtt')} --> ${formatTimestamp(end, 'vtt')}`,
    );
    lines.push(text);
    lines.push('');
    idx += 1;
  }
  return lines.join('\n');
}

/**
 * @param {File | Blob} file
 * @returns {Promise<number>}
 */
export async function getMediaDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(
      file.type?.startsWith('video/') ? 'video' : 'audio',
    );
    el.preload = 'metadata';
    el.src = url;
    await new Promise((resolve, reject) => {
      el.addEventListener('loadedmetadata', resolve, { once: true });
      el.addEventListener(
        'error',
        () => reject(new Error('無法讀取音訊時長')),
        { once: true },
      );
    });
    const d = el.duration;
    return Number.isFinite(d) ? d : 0;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * If video is longer than one pass of the audio (looped BGM), tile cues.
 * @param {SubChunk[]} chunks
 * @param {number} audioDurationSec
 * @param {number} videoDurationSec
 * @returns {SubChunk[]}
 */
export function tileChunksToDuration(chunks, audioDurationSec, videoDurationSec) {
  if (!chunks.length) return chunks;
  if (
    !Number.isFinite(audioDurationSec) ||
    audioDurationSec <= 0 ||
    !Number.isFinite(videoDurationSec) ||
    videoDurationSec <= audioDurationSec + 0.25
  ) {
    return chunks;
  }

  const out = [];
  let offset = 0;
  while (offset < videoDurationSec - 0.05) {
    for (const c of chunks) {
      let [s, e] = c.timestamp || [0, 0];
      if (!Number.isFinite(s)) s = 0;
      if (!Number.isFinite(e) || e <= s) e = s + 1.5;
      const ns = s + offset;
      const ne = Math.min(e + offset, videoDurationSec);
      if (ns >= videoDurationSec) break;
      if (ne > ns + 0.05) {
        out.push({ timestamp: [ns, ne], text: c.text });
      }
    }
    offset += audioDurationSec;
    if (offset > videoDurationSec + audioDurationSec * 2) break;
  }
  return out;
}

/**
 * Normalize Whisper language option.
 * @param {string | null | undefined} language
 */
function normalizeLanguage(language) {
  if (!language || language === 'auto') return null;
  const map = {
    chinese: 'chinese',
    zh: 'chinese',
    'zh-tw': 'chinese',
    'zh-cn': 'chinese',
    中文: 'chinese',
    english: 'english',
    en: 'english',
  };
  const key = String(language).toLowerCase();
  return map[key] || language;
}

/**
 * Parse various ASR return shapes into chunks.
 * @param {any} result
 * @param {number} audioDurationSec
 * @returns {SubChunk[]}
 */
function parseAsrResult(result, audioDurationSec) {
  /** @type {SubChunk[]} */
  const chunks = [];

  const pushChunk = (text, start, end) => {
    const t = String(text || '')
      .replace(/\[.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return;
    // Whisper silence hallucinations
    if (/^(\.|…|\.\.\.|♪|\[Music\]|\[音樂\]|thank you\.?|thanks for watching\.?)$/i.test(t)) {
      return;
    }
    let s = Number(start);
    let e = Number(end);
    if (!Number.isFinite(s) || s < 0) s = 0;
    if (!Number.isFinite(e) || e <= s) e = s + 1.5;
    chunks.push({ timestamp: [s, e], text: t });
  };

  // Array of segment results
  const list = Array.isArray(result) ? result : [result];
  for (const item of list) {
    if (!item) continue;
    if (Array.isArray(item.chunks) && item.chunks.length) {
      for (const c of item.chunks) {
        const ts = c.timestamp;
        const start = Array.isArray(ts) ? ts[0] : 0;
        const end = Array.isArray(ts) ? ts[1] : start + 1.5;
        pushChunk(c.text, start, end);
      }
    } else if (item.text) {
      pushChunk(
        item.text,
        0,
        Math.max(audioDurationSec || 2, 2),
      );
    }
  }

  // Fix null / overlapping ends
  for (let i = 0; i < chunks.length; i++) {
    let [s, e] = chunks[i].timestamp;
    if (!Number.isFinite(e) || e <= s) {
      const next = chunks[i + 1]?.timestamp?.[0];
      e = Number.isFinite(next) && next > s ? next : s + 2;
      chunks[i].timestamp = [s, e];
    }
  }

  return chunks;
}

/** Manual slice length — small enough that WASM Whisper finishes in reasonable time */
const SLICE_SEC = 15;
const SLICE_OVERLAP_SEC = 0.5;
/** Per-slice timeout (whisper-tiny on WASM: ~15s audio can take 30–90s) */
const SLICE_TIMEOUT_MS = 90_000;
/** Hard cap so jobs don't run forever */
const MAX_ASR_SEC = 10 * 60;

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} 逾時（>${Math.round(ms / 1000)} 秒）。瀏覽器內辨識較慢，請換較短 MP3 或稍後再試。`,
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function yieldToUi() {
  return new Promise((resolve) => {
    // Double rAF + timeout so status text actually paints before heavy WASM work
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  });
}

/**
 * Run ASR on short slices with progress + timeout (avoids infinite hang on long files).
 * @param {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline} asr
 * @param {Float32Array} waveform
 * @param {Record<string, unknown>} baseKwargs
 * @param {{
 *   onStatus?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onLog?: (msg: string) => void,
 * }} hooks
 * @returns {Promise<SubChunk[]>}
 */
async function transcribeInSlices(asr, waveform, baseKwargs, hooks) {
  const { onStatus, onProgress, onLog } = hooks;
  const totalSec = waveform.length / SAMPLE_RATE;
  const stepSec = SLICE_SEC - SLICE_OVERLAP_SEC;
  const numSlices = Math.max(1, Math.ceil(totalSec / stepSec));
  /** @type {SubChunk[]} */
  const all = [];
  const t0 = Date.now();

  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    onStatus?.(
      `辨識進行中…已 ${elapsed} 秒（瀏覽器內轉寫偏慢，請勿關閉分頁）`,
    );
  }, 2000);

  try {
    for (let i = 0; i < numSlices; i++) {
      const startSec = i * stepSec;
      const endSec = Math.min(totalSec, startSec + SLICE_SEC);
      const startSample = Math.floor(startSec * SAMPLE_RATE);
      const endSample = Math.min(waveform.length, Math.floor(endSec * SAMPLE_RATE));
      if (endSample <= startSample) continue;

      const slice = waveform.subarray(startSample, endSample);
      const sliceDur = (endSample - startSample) / SAMPLE_RATE;
      const elapsed = Math.round((Date.now() - t0) / 1000);

      onStatus?.(
        `辨識 ${i + 1}/${numSlices}（${startSec.toFixed(0)}–${endSec.toFixed(0)}s / 共 ${totalSec.toFixed(0)}s）· 已 ${elapsed}s`,
      );
      onProgress?.(0.1 + (0.85 * i) / numSlices);
      onLog?.(
        `ASR 片段 ${i + 1}/${numSlices}: ${startSec.toFixed(1)}–${endSec.toFixed(1)}s (${sliceDur.toFixed(1)}s, ${slice.length} samples)`,
      );

      // Let UI update before blocking WASM
      await yieldToUi();

      // No nested chunk_length_s — slice is already short
      /** @type {Record<string, unknown>} */
      const kwargs = {
        ...baseKwargs,
        return_timestamps: true,
        // Cap generation so silence doesn't spin forever
        max_new_tokens: 128,
      };
      delete kwargs.chunk_length_s;
      delete kwargs.stride_length_s;

      let result;
      try {
        result = await withTimeout(
          asr(slice, kwargs),
          SLICE_TIMEOUT_MS,
          `第 ${i + 1}/${numSlices} 段`,
        );
      } catch (err) {
        onLog?.(`片段 ${i + 1} 失敗：${err?.message || err}`);
        // Continue other slices rather than abort entire job
        continue;
      }

      const part = parseAsrResult(result, sliceDur);
      for (const c of part) {
        const [s, e] = c.timestamp;
        // Skip cues fully inside overlap with previous slice (except first)
        if (i > 0 && s < SLICE_OVERLAP_SEC * 0.8) continue;
        all.push({
          timestamp: [s + startSec, e + startSec],
          text: c.text,
        });
      }

      onLog?.(
        `片段 ${i + 1} 完成：+${part.length} 句 · 累計 ${all.length} · 「${part.map((p) => p.text).join(' ').slice(0, 60)}」`,
      );
      onProgress?.(0.1 + (0.85 * (i + 1)) / numSlices);
      await yieldToUi();
    }
  } finally {
    clearInterval(heartbeat);
  }

  // Sort & light merge of adjacent identical lines
  all.sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  return all;
}

/**
 * Transcribe an audio File (e.g. MP3) into timed subtitle chunks.
 * @param {File} file
 * @param {{
 *   language?: string | null,
 *   onStatus?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onLog?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{ chunks: SubChunk[], text: string, srt: string, vtt: string, modelId: string | null }>}
 */
export async function transcribeAudioToSubtitles(file, opts = {}) {
  const { language = 'chinese', onStatus, onProgress, onLog } = opts;
  if (!file) throw new Error('請先選擇 MP3 / 音訊檔');

  const lang = normalizeLanguage(language);

  // Prefer tiny for speed — base is often too slow in-browser and feels "stuck"
  const asr = await ensureTranscriber(onStatus, onProgress, {
    preferBetterChinese: false,
  });

  onStatus?.('解碼音訊…');
  onLog?.(`ASR 檔案：${file.name}（${file.size} bytes） language=${lang || 'auto'}`);

  let waveform = await decodeAudioForWhisper(file, onLog);
  let audioDurationSec = waveform.length / SAMPLE_RATE;
  onLog?.(`波形長度 ${audioDurationSec.toFixed(2)}s · model=${loadedModelId || '?'}`);

  if (audioDurationSec > MAX_ASR_SEC) {
    onLog?.(
      `音訊 ${audioDurationSec.toFixed(0)}s 超過上限 ${MAX_ASR_SEC}s，只辨識前 ${MAX_ASR_SEC / 60} 分鐘`,
    );
    onStatus?.(`音訊較長，僅辨識前 ${MAX_ASR_SEC / 60} 分鐘…`);
    waveform = waveform.subarray(0, Math.floor(MAX_ASR_SEC * SAMPLE_RATE));
    audioDurationSec = waveform.length / SAMPLE_RATE;
  }

  /** @type {Record<string, unknown>} */
  const baseKwargs = {
    return_timestamps: true,
    max_new_tokens: 128,
  };
  if (lang) {
    baseKwargs.language = lang;
    baseKwargs.task = 'transcribe';
  }

  onStatus?.('開始分段辨識（每段約 15 秒音訊）…');
  onProgress?.(0.1);

  const chunks = await transcribeInSlices(asr, waveform, baseKwargs, {
    onStatus,
    onProgress,
    onLog,
  });

  const fullText = chunks.map((c) => c.text).join(' ').trim();
  onLog?.(
    `解析後 ${chunks.length} 句，文字：${fullText.slice(0, 120)}${fullText.length > 120 ? '…' : ''}`,
  );

  if (!chunks.length) {
    throw new Error(
      '未能從音訊辨識出文字。請確認：① MP3 含清楚人聲 ② 語言選對 ③ 音量足夠。純音樂通常無法產生字幕。若各段都逾時，請換較短 MP3 再試。',
    );
  }

  const srt = chunksToSrt(chunks);
  const vtt = chunksToVtt(chunks);
  if (!srt.trim() || !vtt.includes('-->')) {
    throw new Error('字幕檔產生失敗（內容為空）');
  }

  onStatus?.(`字幕就緒（${chunks.length} 句）`);
  onProgress?.(1);
  return {
    chunks,
    text: fullText || chunks.map((c) => c.text).join(' '),
    srt,
    vtt,
    modelId: loadedModelId,
  };
}
