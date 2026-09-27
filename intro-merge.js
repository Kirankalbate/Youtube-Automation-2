// Optional "intro video" feature.
//
// This file is loaded as an ES module (see the <script type="module"> tag in
// index.html) and is entirely separate from script.js, which still owns the
// original image + audio -> video workflow untouched. The two talk to each
// other only through two small CustomEvents dispatched on `window`:
//
//   'still:main-video-ready'  -> { blob, mimeType, duration }  main video is done
//   'still:main-video-reset'  -> fired right before a new main video starts rendering
//
// Merging an arbitrary user-supplied intro clip with the generated video
// requires re-encoding (the two files can have completely different
// resolutions, frame rates and codecs), which the browser's built-in
// MediaRecorder cannot do. This uses ffmpeg.wasm for that step, loaded lazily
// so visitors who never touch the intro feature never download it.

import { FFmpeg } from './vendor/ffmpeg-wasm/index.js';
import { fetchFile, toBlobURL } from './vendor/ffmpeg-util/index.js';

// Must match the canvas size / frame rate used in script.js so the intro
// clip and the generated video line up on the same footing when concatenated.
const TARGET_W = 1280;
const TARGET_H = 720;
const TARGET_FPS = 30;

// Pin to matching @ffmpeg/ffmpeg (vendored) / @ffmpeg/core (CDN) versions to
// avoid version-mismatch bugs between the two.
const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

(() => {
  'use strict';

  const introDeck        = document.getElementById('intro-deck');
  const introInput       = document.getElementById('intro-input');
  const introDrop        = document.getElementById('intro-drop');
  const introVideoPreview= document.getElementById('intro-video-preview');
  const introDurationEl  = document.getElementById('intro-duration');

  const mergeBtn          = document.getElementById('merge-btn');
  const mergeStatus       = document.getElementById('merge-status');
  const mergeProgressRail = document.getElementById('merge-progress-rail');
  const mergeProgressFill = document.getElementById('merge-progress-fill');
  const mergeProgressCtr  = document.getElementById('merge-progress-counter');

  const finalVideoOutput  = document.getElementById('final-video-output');
  const finalDownloadBtn  = document.getElementById('final-download-btn');

  let mainVideo = null;      // { blob, mimeType, duration }
  let introFile = null;
  let introDuration = 0;
  let introObjectUrl = null;
  let finalObjectUrl = null;

  let ffmpeg = null;
  let ffmpegLoadPromise = null;

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function setMergeStatus(message, isError) {
    mergeStatus.textContent = message;
    mergeStatus.classList.toggle('is-error', Boolean(isError));
  }

  function extensionFor(filenameOrMime, fallback) {
    if (!filenameOrMime) return fallback;
    const fromName = /\.([a-z0-9]+)$/i.exec(filenameOrMime);
    if (fromName) return fromName[1].toLowerCase();
    return fallback;
  }

  function resetFinalOutput() {
    if (finalObjectUrl) {
      URL.revokeObjectURL(finalObjectUrl);
      finalObjectUrl = null;
    }
    finalVideoOutput.removeAttribute('src');
    finalVideoOutput.classList.add('hidden');
    finalDownloadBtn.classList.add('hidden');
    finalDownloadBtn.removeAttribute('href');
    mergeProgressRail.classList.add('hidden');
    mergeProgressFill.style.width = '0%';
    mergeProgressCtr.textContent = 'Preparing\u2026';
  }

  // ---------- respond to the main generator ----------

  window.addEventListener('still:main-video-ready', (e) => {
    mainVideo = e.detail;
    introDeck.classList.remove('hidden');
    resetFinalOutput();
    updateMergeButtonState();
    setMergeStatus(
      introFile
        ? 'Ready to combine the intro with the video above.'
        : 'Choose an intro clip to combine it with the video above.'
    );
  });

  window.addEventListener('still:main-video-reset', () => {
    // The video above is about to be rebuilt, so any final export made from
    // the previous version is now stale.
    mainVideo = null;
    introDeck.classList.add('hidden');
    resetFinalOutput();
  });

  // ---------- intro file handling ----------

  function updateMergeButtonState() {
    mergeBtn.disabled = !(mainVideo && introFile);
  }

  function handleIntroFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      setMergeStatus('That file does not look like a video.', true);
      return;
    }
    introFile = file;

    if (introObjectUrl) URL.revokeObjectURL(introObjectUrl);
    introObjectUrl = URL.createObjectURL(file);
    introVideoPreview.src = introObjectUrl;

    introVideoPreview.onloadedmetadata = () => {
      introDuration = introVideoPreview.duration || 0;
      introDurationEl.textContent = formatTime(introDuration);
      introDeck.classList.add('filled');
      updateMergeButtonState();
      setMergeStatus('Ready to combine the intro with the video above.');
    };
    introVideoPreview.onerror = () => {
      setMergeStatus('Could not read that video file.', true);
      introFile = null;
      updateMergeButtonState();
    };
  }

  introInput.addEventListener('change', () => {
    if (introInput.files && introInput.files[0]) handleIntroFile(introInput.files[0]);
  });

  ['dragenter', 'dragover'].forEach(evt => {
    introDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      introDrop.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    introDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      introDrop.classList.remove('drag-over');
    });
  });
  introDrop.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleIntroFile(file);
  });

  // ---------- ffmpeg loading ----------

  async function ensureFFmpegLoaded() {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    if (ffmpegLoadPromise) return ffmpegLoadPromise;

    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      if (typeof progress === 'number' && isFinite(progress)) {
        const pct = Math.min(100, Math.max(0, progress * 100));
        mergeProgressFill.style.width = pct.toFixed(1) + '%';
        mergeProgressCtr.textContent = 'Rendering final video \u2014 ' + Math.round(pct) + '%';
      }
    });

    setMergeStatus('Loading the video engine (first time only, ~25\u201330\u2009MB)\u2026');
    mergeProgressRail.classList.remove('hidden');
    mergeProgressCtr.textContent = 'Downloading video engine\u2026';

    ffmpegLoadPromise = (async () => {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    })();

    try {
      await ffmpegLoadPromise;
    } catch (err) {
      ffmpeg = null;
      ffmpegLoadPromise = null;
      throw err;
    }
    return ffmpeg;
  }

  // Detect whether an input file has an audio stream, by asking ffmpeg to
  // "convert" it with no output (which fails, but logs the stream list on
  // the way) and scanning the logged lines. Avoids depending on ffprobe.
  async function hasAudioStream(engine, inputPath) {
    const lines = [];
    const collector = ({ message }) => lines.push(message);
    engine.on('log', collector);
    try {
      await engine.exec(['-i', inputPath]);
    } catch (err) {
      // exec resolves with a non-zero code rather than throwing in normal
      // use, but guard here too in case the worker itself errors out.
    } finally {
      engine.off('log', collector);
    }
    return lines.some(line => /Stream #\d+:\d+.*Audio:/i.test(line));
  }

  // ---------- the merge itself ----------

  async function runMerge() {
    if (!mainVideo || !introFile) return;

    mergeBtn.disabled = true;
    resetFinalOutput();
    mergeProgressRail.classList.remove('hidden');

    try {
      const engine = await ensureFFmpegLoaded();

      setMergeStatus('Preparing files\u2026');
      mergeProgressFill.style.width = '0%';
      mergeProgressCtr.textContent = 'Preparing files\u2026';

      const introExt = extensionFor(introFile.name, 'mp4');
      const mainExt = extensionFor(mainVideo.mimeType, 'webm');
      const introPath = 'intro.' + introExt;
      const mainPath = 'main.' + mainExt;
      const outputPath = 'final-video.mp4';

      await engine.writeFile(introPath, await fetchFile(introFile));
      await engine.writeFile(mainPath, await fetchFile(mainVideo.blob));

      setMergeStatus('Checking the intro clip\u2026');
      const introHasAudio = await hasAudioStream(engine, introPath);

      setMergeStatus('Rendering the final video \u2014 this can take a little while.');
      mergeProgressCtr.textContent = 'Rendering final video\u2026';

      const scaleFilter = (label, outLabel) =>
        `[${label}]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
        `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${TARGET_FPS},format=yuv420p[${outLabel}]`;

      let filterComplex;
      let inputArgs;

      if (introHasAudio) {
        inputArgs = ['-i', introPath, '-i', mainPath];
        filterComplex =
          `${scaleFilter('0:v', 'v0')};` +
          `${scaleFilter('1:v', 'v1')};` +
          `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];` +
          `[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];` +
          `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`;
      } else {
        // Intro has no audio track of its own: pad it out with silence for
        // exactly its own duration so timing still lines up.
        inputArgs = [
          '-i', introPath,
          '-i', mainPath,
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'
        ];
        filterComplex =
          `${scaleFilter('0:v', 'v0')};` +
          `${scaleFilter('1:v', 'v1')};` +
          `[2:a]atrim=duration=${Math.max(introDuration, 0.1).toFixed(3)},asetpts=PTS-STARTPTS[a0];` +
          `[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];` +
          `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`;
      }

      await engine.exec([
        ...inputArgs,
        '-filter_complex', filterComplex,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
      ]);

      const data = await engine.readFile(outputPath);
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      finalObjectUrl = URL.createObjectURL(blob);

      finalVideoOutput.src = finalObjectUrl;
      finalVideoOutput.classList.remove('hidden');
      finalDownloadBtn.href = finalObjectUrl;
      finalDownloadBtn.download = 'final-video.mp4';
      finalDownloadBtn.classList.remove('hidden');
      mergeProgressRail.classList.add('hidden');
      setMergeStatus('Done. The final video (intro + main video) is ready below.');

      // Tidy the virtual filesystem so a second merge with a different
      // intro doesn't accumulate stale files.
      for (const p of [introPath, mainPath, outputPath]) {
        try { await engine.deleteFile(p); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.error(err);
      mergeProgressRail.classList.add('hidden');
      setMergeStatus('Something went wrong while building the final video. ' +
        'Try a shorter or more common intro format (H.264 MP4 works best).', true);
    } finally {
      mergeBtn.disabled = !(mainVideo && introFile);
    }
  }

  mergeBtn.addEventListener('click', runMerge);
})();
