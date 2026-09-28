import type { Replay } from '../engine/replay.ts';
import { replayFileName } from './matchView.ts';
import { t } from './i18n.ts';

const FAST_FORWARD_KEY = 'harena.video.fastForward';

function loadFastForward(): boolean {
  try {
    return localStorage.getItem(FAST_FORWARD_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveFastForward(on: boolean): void {
  try {
    localStorage.setItem(FAST_FORWARD_KEY, String(on));
  } catch {
    // Not remembered; the default stays on.
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Modal that renders a replay to a video file and downloads it. */
export function openVideoExport(replay: Replay): void {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `
    <div class="modal" role="dialog" aria-label="${t('Export video')}">
      <h2>${t('Export video')}</h2>
      <p class="muted">${t('1920×1080 video of this replay with a title card and final results, rendered in your browser. MP4 (H.264) plays everywhere and can be uploaded to video sites.')}</p>
      <label class="check"><input type="checkbox" id="video-ff" /> ${t('Speed up quiet stretches (4× when nobody lands a hit)')}</label>
      <div class="video-progress hidden">
        <progress id="video-bar" max="1" value="0"></progress>
        <div id="video-status" class="note"></div>
      </div>
      <div class="modal-actions">
        <button id="video-close">${t('Close')}</button>
        <button id="video-go" class="primary">${t('Export')}</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const ff = $<HTMLInputElement>('video-ff');
  const go = $<HTMLButtonElement>('video-go');
  const close = $<HTMLButtonElement>('video-close');
  const bar = $<HTMLProgressElement>('video-bar');
  const status = $('video-status');
  ff.checked = loadFastForward();
  let abort: AbortController | null = null;

  const dismiss = () => {
    abort?.abort();
    root.remove();
  };
  close.onclick = dismiss;
  root.addEventListener('keydown', (e) => e.stopPropagation()); // keep game shortcuts out

  go.onclick = async () => {
    saveFastForward(ff.checked);
    abort = new AbortController();
    go.disabled = true;
    ff.disabled = true;
    close.textContent = t('Cancel');
    root.querySelector('.video-progress')!.classList.remove('hidden');
    status.textContent = t('Preparing…');
    const started = performance.now();
    try {
      const { exportReplayVideo } = await import('../video/export.ts');
      const video = await exportReplayVideo(replay, {
        fastForward: ff.checked,
        signal: abort.signal,
        onProgress: (done, total) => {
          bar.value = done / total;
          status.textContent = t('Rendering frame {done} / {total} ({pct}%)', { done, total, pct: Math.round((100 * done) / total) });
        },
      });
      const name = replayFileName(replay).replace(/\.json$/, `.${video.extension}`);
      download(video.blob, name);
      const mb = (video.blob.size / 1e6).toFixed(1);
      const took = ((performance.now() - started) / 1000).toFixed(0);
      status.textContent = t('Saved {name} · {s} s long · {mb} MB · rendered in {took} s', { name, s: Math.round(video.seconds), mb, took });
    } catch (err) {
      status.textContent = (err as Error).name === 'AbortError' ? t('Cancelled.') : t('Export failed: {error}', { error: (err as Error).message });
      status.classList.add('warn-text');
    } finally {
      abort = null;
      go.disabled = false;
      ff.disabled = false;
      close.textContent = t('Close');
    }
  };
}
