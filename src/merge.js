import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpeg = null;
let loadPromise = null;
/** Single progress listener flag per FFmpeg instance */
let progressListenerBound = false;
/** @type {null | ((ev: { progress?: number, time?: number }) => void)} */
let activeProgressSink = null;
/** @type {null | ((msg: string) => void)} */
let activeLogSink = null;

/** Prefer esm for Vite (per ffmpeg.wasm docs). Multiple CDNs for reliability. */
const CORE_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
];

/**
 * Read a File/Blob into Uint8Array without FileReader.
 * FileReader often throws "File could not be read! Code=8" on Windows
 * for some paths / cloud-synced / locked files.
 * @param {File | Blob} file
 * @returns {Promise<Uint8Array>}
 */
async function readBytes(file) {
  if (!file) throw new Error('找不到媒體檔案');
  if (!(file instanceof Blob)) {
    throw new Error('無效的檔案物件');
  }
  if (file.size === 0) {
    throw new Error(`檔案是空的：${file.name || 'unknown'}`);
  }

  try {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (err) {
    // Last resort: Response.arrayBuffer (also avoids FileReader)
    try {
      const buffer = await new Response(file).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      const name = file instanceof File ? file.name : 'blob';
      throw new Error(
        `無法讀取檔案「${name}」。請確認檔案仍存在、未被其他程式鎖定，並改從本機磁碟選擇（不要用僅線上可用的雲端捷徑）。原始錯誤：${err?.message || err}`,
      );
    }
  }
}

/**
 * Bind log/progress once; route via active sinks so handlers never stack.
 * @param {FFmpeg} instance
 */
function bindInstanceEvents(instance) {
  if (progressListenerBound) return;
  instance.on('log', ({ message }) => {
    activeLogSink?.(message);
  });
  instance.on('progress', (ev) => {
    activeProgressSink?.(ev);
  });
  progressListenerBound = true;
}

/**
 * @param {string} base
 * @param {(msg: string) => void} [onLog]
 */
async function loadFromBase(base, onLog) {
  // New instance → rebind allowed
  progressListenerBound = false;
  const instance = new FFmpeg();
  activeLogSink = onLog || null;
  bindInstanceEvents(instance);

  const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
  await instance.load({ coreURL, wasmURL });
  return instance;
}

/**
 * Lazy-load ffmpeg.wasm (single-thread core).
 * @param {(msg: string) => void} [onLog]
 */
export async function ensureFFmpeg(onLog) {
  activeLogSink = onLog || null;

  if (ffmpeg?.loaded) {
    return ffmpeg;
  }

  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const errors = [];
    for (const base of CORE_CANDIDATES) {
      try {
        onLog?.(`載入 FFmpeg 核心：${base}`);
        const instance = await loadFromBase(base, onLog);
        ffmpeg = instance;
        onLog?.('FFmpeg 載入完成');
        return instance;
      } catch (err) {
        errors.push(`${base}: ${err?.message || err}`);
        onLog?.(`載入失敗，嘗試下一個來源… (${err?.message || err})`);
      }
    }
    throw new Error(
      `無法載入 FFmpeg（需要網路下載核心約 30MB）。\n${errors.join('\n')}`,
    );
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = (m?.[1] || 'mp4').toLowerCase();
  // Keep MEMFS names simple (ASCII only)
  if (!/^[a-z0-9]+$/.test(ext)) return 'mp4';
  return ext;
}

/**
 * Map ffmpeg progress event → local 0..1 using media time when possible.
 * Raw `progress` often jumps to ~1 early on multi-step / loop jobs.
 * @param {{ progress?: number, time?: number }} ev
 * @param {number} [expectedSec]
 */
function localProgressFromEvent(ev, expectedSec) {
  const timeUs = ev?.time;
  if (
    Number.isFinite(expectedSec) &&
    expectedSec > 0 &&
    typeof timeUs === 'number' &&
    Number.isFinite(timeUs) &&
    timeUs > 0
  ) {
    // ffmpeg.wasm reports time in microseconds
    return Math.min(0.99, Math.max(0, timeUs / 1e6 / expectedSec));
  }

  const p = ev?.progress;
  if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) {
    // Ignore values that already look "done" unless near end of expected — too noisy
    return Math.min(0.99, Math.max(0, p));
  }
  return null;
}

/**
 * Weighted multi-stage progress (overall never jumps to 99% on first short step).
 * @param {{
 *   onProgress?: (ratio: number) => void,
 *   onStatus?: (status: string) => void,
 * }} hooks
 * @param {{ id: string, weight: number, label: string }[]} stages
 */
function createStageTracker(hooks, stages) {
  const total = Math.max(
    1e-6,
    stages.reduce((s, st) => s + Math.max(0.01, st.weight), 0),
  );
  let index = 0;
  let lastRatio = 0;

  const emit = (local, label) => {
    const safeLocal = Math.min(1, Math.max(0, local));
    let done = 0;
    for (let i = 0; i < index; i++) done += Math.max(0.01, stages[i].weight);
    const curW = Math.max(0.01, stages[index]?.weight ?? 1);
    // Cap in-stage at 0.98 so stage completion (1.0) is the only jump to stage end
    const inStage = Math.min(0.98, safeLocal);
    let ratio = (done + curW * inStage) / total;
    ratio = Math.max(lastRatio, Math.min(0.99, ratio));
    lastRatio = ratio;
    hooks.onProgress?.(ratio);
    if (label) hooks.onStatus?.(label);
  };

  return {
    /** @param {string} id */
    start(id) {
      const i = stages.findIndex((s) => s.id === id);
      if (i >= 0) index = i;
      emit(0, stages[index]?.label);
    },
    /**
     * @param {number} [local] 0..1 within current stage (omit to only refresh label)
     * @param {string} [label]
     */
    update(local, label) {
      if (typeof local === 'number' && Number.isFinite(local)) {
        emit(local, label ?? stages[index]?.label);
      } else if (label) {
        hooks.onStatus?.(label);
      }
    },
    /** Mark current stage complete and move on if needed */
    complete() {
      emit(1, stages[index]?.label);
      if (index < stages.length - 1) index += 1;
    },
    finish() {
      lastRatio = 1;
      hooks.onProgress?.(1);
      hooks.onStatus?.('完成');
    },
  };
}

/**
 * Run ffmpeg exec; throw with logs if non-zero.
 * @param {FFmpeg} ff
 * @param {string[]} args
 * @param {(msg: string) => void} [onLog]
 * @param {{ expectedSec?: number, onLocal?: (r: number) => void }} [prog]
 */
async function execOrThrow(ff, args, onLog, prog = {}) {
  const { expectedSec, onLocal } = prog;
  onLog?.(`$ ffmpeg ${args.join(' ')}`);

  activeProgressSink = (ev) => {
    const local = localProgressFromEvent(ev, expectedSec);
    if (local != null) onLocal?.(local);
  };

  try {
    const code = await ff.exec(args);
    if (code !== 0) {
      throw new Error(`FFmpeg 結束代碼 ${code}（指令：ffmpeg ${args.join(' ')}）`);
    }
    onLocal?.(1);
  } finally {
    activeProgressSink = null;
  }
}

/** Default still length when image has no MP3 / target duration. */
export const DEFAULT_STILL_SEC = 5;

/**
 * Output canvas from source orientation (image or first video).
 * Portrait → 720×1280, landscape → 1280×720, square → 720×720.
 * @param {number} [srcW]
 * @param {number} [srcH]
 * @returns {{ width: number, height: number, orientation: 'portrait' | 'landscape' | 'square' }}
 */
export function resolveOutputSize(srcW, srcH) {
  const w = Number(srcW) || 0;
  const h = Number(srcH) || 0;
  if (h > w && w > 0) {
    return { width: 720, height: 1280, orientation: 'portrait' };
  }
  if (w > 0 && h > 0 && w === h) {
    return { width: 720, height: 720, orientation: 'square' };
  }
  return { width: 1280, height: 720, orientation: 'landscape' };
}

/**
 * True if MEMFS / file name looks like a still image.
 * @param {string} name
 */
function isImageInputName(name) {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name || '');
}

/**
 * Normalize one clip to H.264 @ 30fps (optional AAC audio).
 * Size follows opts.width/height (portrait or landscape).
 * Still images use -loop 1 -t duration.
 * @param {FFmpeg} ff
 * @param {string} input
 * @param {string} output
 * @param {{
 *   noAudio?: boolean,
 *   onLog?: (msg: string) => void,
 *   expectedSec?: number,
 *   onLocal?: (r: number) => void,
 *   width?: number,
 *   height?: number,
 *   isImage?: boolean,
 *   durationSec?: number,
 * }} [opts]
 */
async function normalizeClip(ff, input, output, opts = {}) {
  const {
    noAudio = false,
    onLog,
    expectedSec,
    onLocal,
    width = 1280,
    height = 720,
    isImage = false,
    durationSec,
  } = opts;
  const W = Math.max(2, Math.round(Number(width) || 1280) & ~1);
  const H = Math.max(2, Math.round(Number(height) || 720) & ~1);
  const prog = { expectedSec, onLocal };
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;

  // Still image → video of fixed length (no audio track; BGM muxed later)
  if (isImage || isImageInputName(input)) {
    const t = Math.max(
      0.1,
      Number(durationSec) > 0
        ? Number(durationSec)
        : Number(expectedSec) > 0
          ? Number(expectedSec)
          : DEFAULT_STILL_SEC,
    );
    onLog?.(`靜態圖轉影片：${input} → ${W}x${H} · ${t.toFixed(2)}s`);
    await execOrThrow(
      ff,
      [
        '-loop',
        '1',
        '-framerate',
        '30',
        '-i',
        input,
        '-t',
        String(t),
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-y',
        output,
      ],
      onLog,
      { expectedSec: t, onLocal },
    );
    return;
  }

  const videoArgs = [
    '-i',
    input,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
  ];

  if (noAudio) {
    await execOrThrow(ff, [...videoArgs, '-an', '-y', output], onLog, prog);
    return;
  }

  try {
    await execOrThrow(
      ff,
      [
        ...videoArgs,
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '128k',
        '-shortest',
        '-y',
        output,
      ],
      onLog,
      prog,
    );
  } catch (err) {
    onLog?.(`含音訊轉檔失敗，改為純影像：${err?.message || err}`);
    await execOrThrow(ff, [...videoArgs, '-an', '-y', output], onLog, prog);
  }
}

/** Soft limits to avoid browser OOM (still effectively “extend as needed”). */
export const LOOP_LIMITS = {
  maxCount: 999,
  maxDurationSec: 2 * 60 * 60, // 2 hours
};

/**
 * Concat multiple MEMFS files into one (stream copy).
 * @param {FFmpeg} ff
 * @param {string[]} names
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 * @param {string[]} written
 */
/**
 * @param {FFmpeg} ff
 * @param {string[]} names
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 * @param {string[]} written
 * @param {{ expectedSec?: number, onLocal?: (r: number) => void }} [prog]
 */
async function concatCopy(ff, names, output, onLog, written, prog = {}) {
  if (names.length === 1) {
    // Copy single file to output name via remux
    await execOrThrow(
      ff,
      ['-i', names[0], '-c', 'copy', '-movflags', '+faststart', '-y', output],
      onLog,
      prog,
    );
    return;
  }
  const listName = `list_${Date.now().toString(36)}.txt`;
  const listBody = `${names.map((n) => `file ${n}`).join('\n')}\n`;
  await ff.writeFile(listName, listBody);
  written.push(listName);
  await execOrThrow(
    ff,
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listName,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    onLog,
    prog,
  );
}

/**
 * Loop base clip by count and/or trim to target duration.
 * @param {FFmpeg} ff
 * @param {string} baseName
 * @param {{
 *   mode: 'once' | 'count' | 'duration',
 *   count?: number,
 *   targetSeconds?: number,
 *   baseDurationSec?: number,
 * }} loop
 * @param {(msg: string) => void} [onLog]
 * @param {(status: string) => void} [onStatus]
 * @param {string[]} written
 */
/**
 * Encode args for trim/loop re-encode (respect noAudio).
 * @param {boolean} noAudio
 */
function reencodeTailArgs(noAudio) {
  const args = [
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
  ];
  if (noAudio) {
    args.push('-an');
  } else {
    args.push('-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-movflags', '+faststart', '-y', 'output.mp4');
  return args;
}

/**
 * @param {FFmpeg} ff
 * @param {string} baseName
 * @param {{
 *   mode: 'once' | 'count' | 'duration',
 *   count?: number,
 *   targetSeconds?: number,
 *   baseDurationSec?: number,
 *   noAudio?: boolean,
 * }} loop
 * @param {(msg: string) => void} [onLog]
 * @param {(status: string) => void} [onStatus]
 * @param {string[]} written
 * @param {(r: number) => void} [onLocal]
 */
async function applyLoopExtend(ff, baseName, loop, onLog, onStatus, written, onLocal) {
  const mode = loop?.mode || 'once';
  const noAudio = Boolean(loop?.noAudio);
  const baseDur = Number(loop.baseDurationSec);

  if (mode === 'once') {
    if (baseName === 'output.mp4') return;
    await execOrThrow(
      ff,
      ['-i', baseName, '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4'],
      onLog,
      { expectedSec: baseDur > 0 ? baseDur : undefined, onLocal },
    );
    return;
  }

  if (mode === 'count') {
    const count = Math.floor(Number(loop.count) || 1);
    if (count < 1) throw new Error('重複次數至少為 1');
    if (count > LOOP_LIMITS.maxCount) {
      throw new Error(`重複次數上限為 ${LOOP_LIMITS.maxCount}`);
    }
    if (count === 1) {
      await applyLoopExtend(
        ff,
        baseName,
        { mode: 'once', noAudio, baseDurationSec: baseDur },
        onLog,
        onStatus,
        written,
        onLocal,
      );
      return;
    }

    const outSec = baseDur > 0 ? baseDur * count : undefined;
    onStatus?.(`循環延長：重複 ${count} 次…`);
    onLog?.(`stream_loop extra=${count - 1}（總播放 ${count} 次，預估 ${outSec || '?'}s）`);

    try {
      // -stream_loop N means N additional loops (total plays = N+1)
      await execOrThrow(
        ff,
        [
          '-stream_loop',
          String(count - 1),
          '-i',
          baseName,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          'output.mp4',
        ],
        onLog,
        { expectedSec: outSec, onLocal },
      );
    } catch (err) {
      onLog?.(`stream_loop 失敗，改用 concat 清單：${err?.message || err}`);
      const names = Array.from({ length: count }, () => baseName);
      await concatCopy(ff, names, 'output.mp4', onLog, written, {
        expectedSec: outSec,
        onLocal,
      });
    }
    return;
  }

  if (mode === 'duration') {
    const target = Number(loop.targetSeconds);
    if (!Number.isFinite(target) || target <= 0) {
      throw new Error('請輸入有效的目標時長（秒）');
    }
    if (target > LOOP_LIMITS.maxDurationSec) {
      throw new Error(
        `目標時長上限為 ${LOOP_LIMITS.maxDurationSec / 3600} 小時（${LOOP_LIMITS.maxDurationSec} 秒）`,
      );
    }

    if (Number.isFinite(baseDur) && baseDur > 0 && target <= baseDur + 0.05) {
      onStatus?.(`裁切至 ${target.toFixed(1)} 秒…`);
      await execOrThrow(
        ff,
        [
          '-i',
          baseName,
          '-t',
          target.toFixed(3),
          ...reencodeTailArgs(noAudio),
        ],
        onLog,
        { expectedSec: target, onLocal },
      );
      return;
    }

    onStatus?.(`循環延長並裁切至 ${formatSec(target)}…`);
    onLog?.(`stream_loop -1 + -t ${target}`);

    try {
      await execOrThrow(
        ff,
        [
          '-stream_loop',
          '-1',
          '-i',
          baseName,
          '-t',
          target.toFixed(3),
          ...reencodeTailArgs(noAudio),
        ],
        onLog,
        { expectedSec: target, onLocal },
      );
    } catch (err) {
      onLog?.(`stream_loop 時長模式失敗，改用重複 concat：${err?.message || err}`);
      const unit = Number.isFinite(baseDur) && baseDur > 0 ? baseDur : target;
      const times = Math.max(1, Math.ceil(target / unit));
      if (times > LOOP_LIMITS.maxCount) {
        throw new Error(
          `依時長推算需重複 ${times} 次，超過上限 ${LOOP_LIMITS.maxCount}。請縮短目標時長。`,
        );
      }
      const names = Array.from({ length: times }, () => baseName);
      const looped = 'looped_tmp.mp4';
      await concatCopy(ff, names, looped, onLog, written, {
        expectedSec: unit * times,
        onLocal: (r) => onLocal?.(r * 0.5),
      });
      written.push(looped);
      await execOrThrow(
        ff,
        ['-i', looped, '-t', target.toFixed(3), ...reencodeTailArgs(noAudio)],
        onLog,
        { expectedSec: target, onLocal: (r) => onLocal?.(0.5 + r * 0.5) },
      );
    }
    return;
  }

  throw new Error(`未知的延長模式：${mode}`);
}

function formatSec(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(r)}`;
  return `${m}:${pad(r)}`;
}

/**
 * Soft-mux SRT subtitles into MP4 (mov_text). Falls back by throwing.
 * @param {FFmpeg} ff
 * @param {string} videoName
 * @param {string} srtName
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 */
/**
 * @param {FFmpeg} ff
 * @param {string} videoName
 * @param {string} srtName
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 * @param {(r: number) => void} [onLocal]
 */
async function muxSubtitles(ff, videoName, srtName, output, onLog, onLocal) {
  await execOrThrow(
    ff,
    [
      '-i',
      videoName,
      '-i',
      srtName,
      '-map',
      '0',
      '-map',
      '1',
      '-c',
      'copy',
      '-c:s',
      'mov_text',
      '-metadata:s:s:0',
      'language=zho',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    onLog,
    { onLocal },
  );
}

/**
 * Embed adjusted SRT into an already-merged preview video (no full re-merge).
 * Used after the user finishes manual subtitle timeline tweaks in the preview UI.
 *
 * @param {Blob} videoBlob  preview MP4 (without or with prior soft track — we soft-mux SRT)
 * @param {string} subtitleSrt
 * @param {{
 *   onLog?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onStatus?: (status: string) => void,
 * }} [hooks]
 * @returns {Promise<{ blob: Blob, subtitlesEmbedded: boolean }>}
 */
export async function embedSubtitlesIntoVideo(videoBlob, subtitleSrt, hooks = {}) {
  if (!(videoBlob instanceof Blob) || !videoBlob.size) {
    throw new Error('找不到可嵌入字幕的預覽影片');
  }
  const srt = String(subtitleSrt || '').trim();
  if (!srt) throw new Error('字幕內容是空的，請先產生或調整字幕');

  const { onLog, onProgress, onStatus } = hooks;
  const ff = await ensureFFmpeg(onLog);
  const written = [];

  try {
    onStatus?.('讀取預覽影片…');
    onProgress?.(0.05);
    const vidBytes = await readBytes(videoBlob);
    const videoName = 'preview_in.mp4';
    await ff.writeFile(videoName, vidBytes);
    written.push(videoName);

    const srtName = 'export_subs.srt';
    // Strip BOM if present — ffmpeg may choke on BOM in some builds
    const srtClean = srt.replace(/^\uFEFF/, '');
    await ff.writeFile(srtName, srtClean);
    written.push(srtName);
    onProgress?.(0.2);
    onStatus?.('嵌入字幕到正式輸出…');

    const outName = 'export_final.mp4';
    try {
      await muxSubtitles(ff, videoName, srtName, outName, onLog, (r) => {
        onProgress?.(0.2 + Math.min(1, Math.max(0, r)) * 0.7);
      });
      written.push(outName);
      const data = await ff.readFile(outName);
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!u8.byteLength) throw new Error('正式輸出是空檔');
      onProgress?.(1);
      onStatus?.('正式輸出完成');
      onLog?.('字幕已嵌入正式影片（mov_text）');
      return {
        blob: new Blob([u8], { type: 'video/mp4' }),
        subtitlesEmbedded: true,
      };
    } catch (err) {
      onLog?.(`嵌入字幕失敗：${err?.message || err}`);
      // Fall back: return original preview so user still has a file
      onProgress?.(1);
      onStatus?.('嵌入失敗，回傳預覽影片');
      return {
        blob: videoBlob,
        subtitlesEmbedded: false,
      };
    }
  } finally {
    activeProgressSink = null;
    for (const name of written) {
      try {
        await ff.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Replace video audio with a custom audio file (mp3 etc).
 * Loops audio if shorter than video; trims to video length if longer.
 * @param {FFmpeg} ff
 * @param {string} videoName
 * @param {string} audioName
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 */
/**
 * @param {FFmpeg} ff
 * @param {string} videoName
 * @param {string} audioName
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 * @param {{ expectedSec?: number, onLocal?: (r: number) => void }} [prog]
 */
async function muxCustomAudio(ff, videoName, audioName, output, onLog, prog = {}) {
  // Prefer looped audio + shortest (video ends first → clean length)
  try {
    await execOrThrow(
      ff,
      [
        '-i',
        videoName,
        '-stream_loop',
        '-1',
        '-i',
        audioName,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        output,
      ],
      onLog,
      prog,
    );
    return;
  } catch (err) {
    onLog?.(`循環音訊失敗，改試單次貼上：${err?.message || err}`);
  }

  await execOrThrow(
    ff,
    [
      '-i',
      videoName,
      '-i',
      audioName,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    onLog,
    prog,
  );
}

/**
 * Merge multiple video / still-image Files into one MP4 Blob.
 * clipMeta: per-clip isImage/width/height (stills use -loop 1).
 * outputWidth/Height: force canvas; else inferred from first clip.
 * @param {File[]} files
 * @param {{
 *   noAudio?: boolean,
 *   audioFile?: File | null,
 *   subtitleSrt?: string | null,
 *   clipDurations?: number[],
 *   clipMeta?: { isImage?: boolean, width?: number, height?: number }[],
 *   outputWidth?: number,
 *   outputHeight?: number,
 *   loop?: {
 *     mode: 'once' | 'count' | 'duration',
 *     count?: number,
 *     targetSeconds?: number,
 *     baseDurationSec?: number,
 *   },
 *   onLog?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onStatus?: (status: string) => void,
 * }} [hooks]
 * @returns {Promise<{ blob: Blob, subtitlesEmbedded: boolean }>}
 */
export async function mergeVideos(files, hooks = {}) {
  if (!files?.length) throw new Error('請至少選擇一段影片或圖片');

  const {
    onLog,
    onProgress,
    onStatus,
    noAudio = false,
    audioFile = null,
    subtitleSrt = null,
    clipDurations = [],
    clipMeta = [],
    outputWidth,
    outputHeight,
    loop = { mode: 'once' },
  } = hooks;
  const ff = await ensureFFmpeg(onLog);

  // Custom soundtrack replaces original audio; strip during normalize.
  const useCustomAudio = Boolean(audioFile) && !noAudio;
  const stripOriginalAudio = noAudio || useCustomAudio;
  const needsLoop = loop?.mode && loop.mode !== 'once';

  const isImageFlags = files.map((file, i) => {
    if (clipMeta[i]?.isImage != null) return Boolean(clipMeta[i].isImage);
    return isImageInputName(file?.name || '');
  });

  // Output size: explicit → first clip with size → landscape default
  let outW = Number(outputWidth) || 0;
  let outH = Number(outputHeight) || 0;
  if (!(outW > 0 && outH > 0)) {
    const seed = clipMeta.find((m) => Number(m?.width) > 0 && Number(m?.height) > 0);
    if (seed) {
      const size = resolveOutputSize(seed.width, seed.height);
      outW = size.width;
      outH = size.height;
      onLog?.(
        `輸出畫幅：${size.orientation === 'portrait' ? '直式' : size.orientation === 'square' ? '方形' : '橫式'} ${outW}×${outH}（依素材）`,
      );
    } else {
      const size = resolveOutputSize(1280, 720);
      outW = size.width;
      outH = size.height;
    }
  } else {
    onLog?.(`輸出畫幅：${outW}×${outH}`);
  }

  const durs = files.map((_, i) => {
    const d = Number(clipDurations[i]);
    if (Number.isFinite(d) && d > 0) return d;
    // Stills without duration default shorter; videos keep 10s fallback
    return isImageFlags[i] ? DEFAULT_STILL_SEC : 10;
  });
  const baseDur =
    Number(loop.baseDurationSec) > 0
      ? Number(loop.baseDurationSec)
      : durs.reduce((a, b) => a + b, 0);

  let outDur = baseDur;
  if (loop?.mode === 'count') {
    outDur = baseDur * Math.max(1, Math.floor(Number(loop.count) || 1));
  } else if (loop?.mode === 'duration') {
    outDur = Math.max(0.1, Number(loop.targetSeconds) || baseDur);
  }

  // Weights ≈ encode cost (re-encode heavy; copy light)
  /** @type {{ id: string, weight: number, label: string }[]} */
  const stages = [{ id: 'write', weight: 3, label: '讀取並寫入暫存檔…' }];
  for (let i = 0; i < files.length; i++) {
    stages.push({
      id: `norm${i}`,
      weight: Math.max(8, durs[i]),
      label: isImageFlags[i]
        ? `圖片轉影片 ${i + 1} / ${files.length}…`
        : `標準化第 ${i + 1} / ${files.length} 段…`,
    });
  }
  stages.push({
    id: 'concat',
    weight: 4,
    label: files.length === 1 ? '準備基底片段…' : '串接片段…',
  });
  if (needsLoop) {
    // Loop/re-encode is often the longest step (e.g. 1:01 → 2:50)
    stages.push({
      id: 'loop',
      weight: Math.max(20, outDur * 1.5),
      label:
        loop.mode === 'count'
          ? `循環延長：重複 ${loop.count} 次…`
          : `循環延長並裁切至 ${formatSec(outDur)}…`,
    });
  } else {
    stages.push({ id: 'export', weight: 3, label: '輸出中…' });
  }
  if (useCustomAudio) {
    stages.push({
      id: 'audio',
      weight: Math.max(5, outDur * 0.25),
      label: '套用自訂音軌（MP3）…',
    });
  }
  if (subtitleSrt?.trim()) {
    stages.push({ id: 'subs', weight: 3, label: '嵌入字幕…' });
  }
  stages.push({ id: 'read', weight: 2, label: '讀取結果…' });

  const tracker = createStageTracker({ onProgress, onStatus }, stages);

  if (noAudio) onLog?.('選項：不要聲音（輸出無音軌）');
  if (useCustomAudio) {
    onLog?.(`選項：自訂音軌 ${audioFile.name}（取代原影片聲音）`);
  }
  if (loop?.mode && loop.mode !== 'once') {
    onLog?.(
      `選項：延長模式=${loop.mode}` +
        (loop.mode === 'count' ? ` count=${loop.count}` : '') +
        (loop.mode === 'duration' ? ` target=${loop.targetSeconds}s` : '') +
        ` base≈${baseDur.toFixed(1)}s out≈${outDur.toFixed(1)}s`,
    );
  }

  const written = [];
  try {
    tracker.start('write');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = file?.name || `clip-${i}`;
      tracker.update((i + 0.3) / (files.length + (useCustomAudio ? 1 : 0)), `讀取第 ${i + 1} / ${files.length} 段：${label}`);
      onLog?.(`讀取 ${label}（${file.size} bytes）…`);

      const bytes = await readBytes(file);
      // Keep image extensions so normalize can detect stills
      const name = `in${i}.${extFromName(file.name)}`;
      await ff.writeFile(name, bytes);
      written.push(name);
      onLog?.(`已寫入 MEMFS：${name}`);
      tracker.update((i + 1) / (files.length + (useCustomAudio ? 1 : 0)));
    }

    let audioMemName = null;
    if (useCustomAudio) {
      tracker.update(0.85, `讀取音訊：${audioFile.name}`);
      const audioBytes = await readBytes(audioFile);
      audioMemName = `bgm.${extFromName(audioFile.name) || 'mp3'}`;
      await ff.writeFile(audioMemName, audioBytes);
      written.push(audioMemName);
      onLog?.(`已寫入音訊：${audioMemName}（${audioFile.size} bytes）`);
    }
    tracker.complete();

    const baseName = 'base.mp4';

    // 1) Normalize every input to shared format / canvas size
    const normalized = [];
    const inputCount = files.length;
    for (let i = 0; i < inputCount; i++) {
      tracker.start(`norm${i}`);
      const out = `norm${i}.mp4`;
      await normalizeClip(ff, written[i], out, {
        noAudio: stripOriginalAudio,
        onLog,
        expectedSec: durs[i],
        durationSec: durs[i],
        isImage: isImageFlags[i],
        width: outW,
        height: outH,
        onLocal: (r) => tracker.update(r),
      });
      normalized.push(out);
      written.push(out);
      tracker.complete();
    }

    // 2) Build base sequence
    tracker.start('concat');
    await concatCopy(ff, normalized, baseName, onLog, written, {
      expectedSec: baseDur,
      onLocal: (r) => tracker.update(r),
    });
    written.push(baseName);
    tracker.complete();

    // 3) Optional loop / duration trim
    const videoOut = useCustomAudio ? 'video_only.mp4' : 'output.mp4';
    if (needsLoop) {
      tracker.start('loop');
      await applyLoopExtend(
        ff,
        baseName,
        { ...loop, noAudio: stripOriginalAudio, baseDurationSec: baseDur },
        onLog,
        (s) => tracker.update(null, s),
        written,
        (r) => tracker.update(r),
      );
      if (useCustomAudio) {
        await execOrThrow(
          ff,
          ['-i', 'output.mp4', '-c', 'copy', '-y', videoOut],
          onLog,
          { expectedSec: outDur, onLocal: (r) => tracker.update(0.95 + r * 0.05) },
        );
        written.push(videoOut);
      }
      tracker.complete();
    } else {
      tracker.start('export');
      await execOrThrow(
        ff,
        ['-i', baseName, '-c', 'copy', '-movflags', '+faststart', '-y', videoOut],
        onLog,
        { expectedSec: baseDur, onLocal: (r) => tracker.update(r) },
      );
      written.push(videoOut);
      tracker.complete();
    }
    if (!useCustomAudio) written.push('output.mp4');

    // 4) Mux custom audio
    let currentVideo = useCustomAudio ? videoOut : 'output.mp4';
    if (useCustomAudio && audioMemName) {
      tracker.start('audio');
      await muxCustomAudio(ff, videoOut, audioMemName, 'output.mp4', onLog, {
        expectedSec: outDur,
        onLocal: (r) => tracker.update(r),
      });
      written.push('output.mp4');
      currentVideo = 'output.mp4';
      tracker.complete();
    }

    // 5) Soft-mux subtitles
    let subtitlesEmbedded = false;
    if (subtitleSrt && subtitleSrt.trim()) {
      tracker.start('subs');
      const srtName = 'subs.srt';
      await ff.writeFile(srtName, subtitleSrt);
      written.push(srtName);
      try {
        const withSubs = 'output_subs.mp4';
        await muxSubtitles(
          ff,
          currentVideo,
          srtName,
          withSubs,
          onLog,
          (r) => tracker.update(r),
        );
        written.push(withSubs);
        const subData = await ff.readFile(withSubs);
        await ff.writeFile('output.mp4', subData);
        currentVideo = 'output.mp4';
        subtitlesEmbedded = true;
        onLog?.('字幕已嵌入 MP4（mov_text）');
      } catch (err) {
        onLog?.(
          `嵌入字幕失敗（仍會提供 SRT 下載）：${err?.message || err}`,
        );
        subtitlesEmbedded = false;
      }
      tracker.complete();
    }

    tracker.start('read');
    const data = await ff.readFile(
      currentVideo === 'output.mp4' ? 'output.mp4' : currentVideo,
    );
    if (!written.includes('output.mp4')) written.push('output.mp4');
    tracker.finish();

    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!u8.byteLength) {
      throw new Error('合併結果是空檔，請換一段影片再試');
    }
    return {
      blob: new Blob([u8], { type: 'video/mp4' }),
      subtitlesEmbedded,
    };
  } finally {
    activeProgressSink = null;
    for (const name of written) {
      try {
        await ff.deleteFile(name);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
