/**
 * Persist added video clips + custom audio in IndexedDB until manual clear.
 * File blobs survive page reload (unlike in-memory FileList).
 */

const DB_NAME = 'videomerge-clips';
const DB_VERSION = 2;
const STORE = 'clips';
const AUDIO_STORE = 'audio';
const AUDIO_ID = 'bgm';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   size: number,
 *   type: string,
 *   lastModified: number,
 *   blob: Blob,
 *   firstFrame: string | null,
 *   lastFrame: string | null,
 *   duration: number | null,
 *   width: number | null,
 *   height: number | null,
 *   status: string,
 *   error: string | null,
 *   order: number,
 * }} StoredClip
 */

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('無法開啟影片快取'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      }
    };
  });
  return dbPromise;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {{
 *   id: string,
 *   file: File | Blob,
 *   name: string,
 *   size: number,
 *   firstFrame: string | null,
 *   lastFrame: string | null,
 *   duration: number | null,
 *   width: number | null,
 *   height: number | null,
 *   status: string,
 *   error: string | null,
 * }[]} clips
 */
export async function saveClips(clips) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  await reqToPromise(store.clear());

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const file = c.file;
    if (!(file instanceof Blob) || !file.size) continue;
    /** @type {StoredClip} */
    const row = {
      id: c.id,
      name: c.name || (file instanceof File ? file.name : `clip-${i}.mp4`),
      size: c.size || file.size,
      type: file.type || 'video/mp4',
      lastModified: file instanceof File ? file.lastModified : Date.now(),
      blob: file,
      firstFrame: c.firstFrame ?? null,
      lastFrame: c.lastFrame ?? null,
      duration: c.duration ?? null,
      width: c.width ?? null,
      height: c.height ?? null,
      status: c.status === 'ready' || c.status === 'error' ? c.status : 'ready',
      error: c.error ?? null,
      order: i,
    };
    store.put(row);
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('儲存中止'));
  });
}

/**
 * @returns {Promise<{
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
 * }[]>}
 */
export async function loadClips() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  /** @type {StoredClip[]} */
  const rows = await reqToPromise(store.getAll());
  rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return rows
    .filter((r) => r?.blob instanceof Blob && r.blob.size > 0)
    .map((r) => {
      const file = new File([r.blob], r.name || 'video.mp4', {
        type: r.type || r.blob.type || 'video/mp4',
        lastModified: r.lastModified || Date.now(),
      });
      const hasFrames = Boolean(r.firstFrame && r.lastFrame);
      return {
        id: r.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        name: r.name || file.name,
        size: r.size || file.size,
        firstFrame: r.firstFrame ?? null,
        lastFrame: r.lastFrame ?? null,
        duration: Number.isFinite(r.duration) ? r.duration : null,
        width: Number.isFinite(r.width) ? r.width : null,
        height: Number.isFinite(r.height) ? r.height : null,
        status: /** @type {'ready' | 'error' | 'loading'} */ (
          r.status === 'error'
            ? 'error'
            : hasFrames
              ? 'ready'
              : 'loading'
        ),
        error: r.error ?? null,
      };
    });
}

export async function clearClips() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/**
 * @param {File | Blob | null} file
 */
export async function saveAudio(file) {
  const db = await openDb();
  const tx = db.transaction(AUDIO_STORE, 'readwrite');
  const store = tx.objectStore(AUDIO_STORE);
  if (!(file instanceof Blob) || !file.size) {
    store.delete(AUDIO_ID);
  } else {
    store.put({
      id: AUDIO_ID,
      name: file instanceof File ? file.name : 'audio.mp3',
      size: file.size,
      type: file.type || 'audio/mpeg',
      lastModified: file instanceof File ? file.lastModified : Date.now(),
      blob: file,
    });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('音軌儲存中止'));
  });
}

/**
 * @returns {Promise<File | null>}
 */
export async function loadAudio() {
  try {
    const db = await openDb();
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const store = tx.objectStore(AUDIO_STORE);
    const row = await reqToPromise(store.get(AUDIO_ID));
    if (!row?.blob || !(row.blob instanceof Blob) || !row.blob.size) return null;
    return new File([row.blob], row.name || 'audio.mp3', {
      type: row.type || row.blob.type || 'audio/mpeg',
      lastModified: row.lastModified || Date.now(),
    });
  } catch {
    return null;
  }
}

export async function clearStoredAudio() {
  try {
    const db = await openDb();
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).delete(AUDIO_ID);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}
