/**
 * Extract first / last video frames as JPEG data URLs via HTML5 video + canvas.
 */

function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.crossOrigin = 'anonymous';

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.addEventListener(
      'loadedmetadata',
      () => {
        resolve({ video, url, cleanup });
      },
      { once: true },
    );

    video.addEventListener(
      'error',
      () => {
        URL.revokeObjectURL(url);
        cleanup();
        reject(new Error(`無法讀取影片：${file.name}`));
      },
      { once: true },
    );

    video.src = url;
  });
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      // One rAF helps some browsers finish frame decode after seek.
      requestAnimationFrame(() => resolve());
    };

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener(
      'error',
      () => {
        video.removeEventListener('seeked', onSeeked);
        reject(new Error('影片定位失敗'));
      },
      { once: true },
    );

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = Math.max(0, Math.min(time, Math.max(duration - 0.05, 0)));
    try {
      video.currentTime = target;
    } catch (err) {
      video.removeEventListener('seeked', onSeeked);
      reject(err);
    }
  });
}

function captureFrame(video) {
  const width = video.videoWidth || 640;
  const height = video.videoHeight || 360;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

/**
 * @param {File} file
 * @returns {Promise<{
 *   firstFrame: string,
 *   lastFrame: string,
 *   duration: number,
 *   width: number,
 *   height: number,
 * }>}
 */
export async function extractFrames(file) {
  const { video, url, cleanup } = await loadVideo(file);

  try {
    // Nudge decode on some codecs
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.load();
      });
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;

    await seekTo(video, 0.01);
    const firstFrame = captureFrame(video);

    const lastTime = duration > 0.15 ? duration - 0.08 : Math.max(duration - 0.01, 0);
    await seekTo(video, lastTime);
    const lastFrame = captureFrame(video);

    return {
      firstFrame,
      lastFrame,
      duration,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
    };
  } finally {
    URL.revokeObjectURL(url);
    cleanup();
  }
}

/**
 * Whether a File looks like a still image (not video).
 * @param {File | Blob | null | undefined} file
 * @param {string} [name]
 */
export function isImageFile(file, name = '') {
  if (!file) return false;
  const n = name || (file instanceof File ? file.name : '') || '';
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test(n);
}

/**
 * Load still image metadata + JPEG data URL for clip thumbnails.
 * @param {File} file
 * @returns {Promise<{
 *   firstFrame: string,
 *   lastFrame: string,
 *   duration: number,
 *   width: number,
 *   height: number,
 *   kind: 'image',
 *   orientation: 'portrait' | 'landscape' | 'square',
 * }>}
 */
export function extractImageInfo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';

    const fail = (msg) => {
      URL.revokeObjectURL(url);
      reject(new Error(msg || `無法讀取圖片：${file.name}`));
    };

    img.onload = () => {
      try {
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        if (!width || !height) {
          fail('圖片尺寸無效');
          return;
        }

        // Cap thumbnail decode size for memory
        const maxEdge = 1280;
        let tw = width;
        let th = height;
        if (Math.max(tw, th) > maxEdge) {
          const scale = maxEdge / Math.max(tw, th);
          tw = Math.max(1, Math.round(tw * scale));
          th = Math.max(1, Math.round(th * scale));
        }

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        URL.revokeObjectURL(url);

        const orientation =
          height > width ? 'portrait' : width > height ? 'landscape' : 'square';

        resolve({
          firstFrame: dataUrl,
          lastFrame: dataUrl,
          duration: 0, // still — real length set at merge (often = MP3)
          width,
          height,
          kind: 'image',
          orientation,
        });
      } catch (err) {
        fail(err?.message || '圖片處理失敗');
      }
    };

    img.onerror = () => fail(`無法讀取圖片：${file.name}`);
    img.src = url;
  });
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {'portrait' | 'landscape' | 'square'}
 */
export function orientationFromSize(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (h > w) return 'portrait';
  if (w > h) return 'landscape';
  return 'square';
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
