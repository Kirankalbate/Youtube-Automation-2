(() => {
  'use strict';

  // ---------- elements ----------
  const imageInput      = document.getElementById('image-input');
  const imageDrop       = document.getElementById('image-drop');
  const imageSlot       = document.getElementById('image-slot');
  const imagePreview    = document.getElementById('image-preview');

  const audioInput      = document.getElementById('audio-input');
  const audioDrop       = document.getElementById('audio-drop');
  const audioSlot       = document.getElementById('audio-slot');
  const audioDurationEl = document.getElementById('audio-duration');
  const waveformEl      = document.getElementById('waveform');

  const buildBtn        = document.getElementById('build-btn');
  const statusLine      = document.getElementById('status-line');

  const outputDeck      = document.getElementById('output-deck');
  const outputHint      = document.getElementById('output-hint');
  const progressRail    = document.getElementById('progress-rail');
  const progressFill    = document.getElementById('progress-fill');
  const progressCounter = document.getElementById('progress-counter');
  const videoOutput      = document.getElementById('video-output');
  const downloadBtn      = document.getElementById('download-btn');

  const canvas          = document.getElementById('render-canvas');
  const ctx             = canvas.getContext('2d');

  // ---------- state ----------
  let imageFile   = null;
  let imageEl     = null;      // loaded HTMLImageElement
  let audioFile   = null;
  let audioBuffer = null;      // decoded AudioBuffer
  let sharedAudioCtx = null;
  let objectUrls  = [];        // track for cleanup

  const CANVAS_W = canvas.width;
  const CANVAS_H = canvas.height;

  // ---------- helpers ----------
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function setStatus(message, isError) {
    statusLine.textContent = message;
    statusLine.classList.toggle('is-error', Boolean(isError));
  }

  function revokeTrackedUrls() {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
  }

  function trackUrl(url) {
    objectUrls.push(url);
    return url;
  }

  function getAudioContext() {
    if (!sharedAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      sharedAudioCtx = new Ctx();
    }
    return sharedAudioCtx;
  }

  function updateBuildButtonState() {
    buildBtn.disabled = !(imageEl && audioBuffer);
    if (imageEl && audioBuffer) {
      setStatus('Ready \u2014 ' + formatTime(audioBuffer.duration) + ' of audio will set the video length.');
    } else if (imageEl && !audioBuffer) {
      setStatus('Now add a voice recording.');
    } else if (!imageEl && audioBuffer) {
      setStatus('Now add a photo.');
    } else {
      setStatus('Add a photo and a recording to begin.');
    }
  }

  // ---------- image handling ----------
  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      setStatus('That file does not look like an image.', true);
      return;
    }
    imageFile = file;
    const url = trackUrl(URL.createObjectURL(file));
    const img = new Image();
    img.onload = () => {
      imageEl = img;
      imagePreview.src = url;
      imageSlot.classList.add('filled');
      updateBuildButtonState();
    };
    img.onerror = () => {
      setStatus('Could not read that image file.', true);
    };
    img.src = url;
  }

  imageDrop.addEventListener('click', (e) => {
    // label already opens the file picker; nothing extra needed
  });
  imageInput.addEventListener('change', () => {
    if (imageInput.files && imageInput.files[0]) handleImageFile(imageInput.files[0]);
  });

  // ---------- audio handling ----------
  function drawWaveform(buffer) {
    waveformEl.innerHTML = '';
    const channelData = buffer.getChannelData(0);
    const barCount = 48;
    const blockSize = Math.floor(channelData.length / barCount) || 1;
    const peaks = [];
    let maxPeak = 0.001;

    for (let i = 0; i < barCount; i++) {
      const start = i * blockSize;
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        const v = channelData[start + j] || 0;
        sum += Math.abs(v);
      }
      const avg = sum / blockSize;
      peaks.push(avg);
      if (avg > maxPeak) maxPeak = avg;
    }

    const frag = document.createDocumentFragment();
    peaks.forEach(p => {
      const bar = document.createElement('span');
      const pct = Math.max(6, Math.round((p / maxPeak) * 100));
      bar.style.height = pct + '%';
      frag.appendChild(bar);
    });
    waveformEl.appendChild(frag);
  }

  function handleAudioFile(file) {
    if (!file || !file.type.startsWith('audio/')) {
      setStatus('That file does not look like an audio recording.', true);
      return;
    }
    audioFile = file;
    setStatus('Reading the recording\u2026');

    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result;
      // decodeAudioData detaches the buffer in some browsers, so clone for safety
      const bufferCopy = arrayBuffer.slice(0);
      getAudioContext().decodeAudioData(bufferCopy).then(decoded => {
        audioBuffer = decoded;
        audioDurationEl.textContent = formatTime(decoded.duration);
        drawWaveform(decoded);
        audioSlot.classList.add('filled');
        updateBuildButtonState();
      }).catch(() => {
        setStatus('Could not decode that audio file. Try a standard MP3 or WAV.', true);
      });
    };
    reader.onerror = () => {
      setStatus('Could not read that audio file.', true);
    };
    reader.readAsArrayBuffer(file);
  }

  audioInput.addEventListener('change', () => {
    if (audioInput.files && audioInput.files[0]) handleAudioFile(audioInput.files[0]);
  });

  // ---------- drag and drop ----------
  function wireDropZone(zone, onFile) {
    ['dragenter', 'dragover'].forEach(evt => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(evt => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
      });
    });
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }
  wireDropZone(imageDrop, handleImageFile);
  wireDropZone(audioDrop, handleAudioFile);

  // ---------- canvas drawing ----------
  function drawImageContained(img) {
    ctx.fillStyle = '#1C1A17';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const imgRatio = img.width / img.height;
    const canvasRatio = CANVAS_W / CANVAS_H;
    let drawW, drawH;

    if (imgRatio > canvasRatio) {
      drawW = CANVAS_W;
      drawH = CANVAS_W / imgRatio;
    } else {
      drawH = CANVAS_H;
      drawW = CANVAS_H * imgRatio;
    }
    const dx = (CANVAS_W - drawW) / 2;
    const dy = (CANVAS_H - drawH) / 2;
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }

  // ---------- video build ----------
  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  function resetOutputUI() {
    revokeTrackedUrls.length; // no-op guard
    videoOutput.removeAttribute('src');
    videoOutput.classList.add('hidden');
    downloadBtn.classList.add('hidden');
    downloadBtn.removeAttribute('href');
    progressRail.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressCounter.textContent = '00:00 / 00:00';
    outputDeck.classList.remove('hidden');
    outputHint.textContent = 'Rendering\u2026';

    // A fresh main video invalidates any previously-built final (intro + main)
    // video, so let the optional intro-merge feature know to reset itself.
    window.dispatchEvent(new CustomEvent('still:main-video-reset'));
  }

  function buildVideo() {
    if (!imageEl || !audioBuffer) return;

    if (!window.MediaRecorder || !canvas.captureStream) {
      setStatus('This browser cannot record video. Try a recent Chrome, Edge, or Firefox.', true);
      return;
    }
    const mimeType = pickMimeType();
    if (!mimeType) {
      setStatus('This browser has no supported video format for recording. Try Chrome or Firefox.', true);
      return;
    }

    buildBtn.disabled = true;
    resetOutputUI();
    setStatus('Rendering the video \u2014 this takes about as long as the recording itself.');

    drawImageContained(imageEl);

    const audioCtx = getAudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);

    const videoStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 4_000_000
      });
    } catch (err) {
      setStatus('Could not start the recorder in this browser.', true);
      buildBtn.disabled = false;
      return;
    }

    const duration = audioBuffer.duration;
    const startedAt = audioCtx.currentTime;
    let progressTimer = null;
    let finished = false;

    function finishUp() {
      if (finished) return;
      finished = true;
      if (progressTimer) clearInterval(progressTimer);
      progressFill.style.width = '100%';
      progressCounter.textContent = formatTime(duration) + ' / ' + formatTime(duration);
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      finishUp();
      const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
      const url = trackUrl(URL.createObjectURL(blob));
      videoOutput.src = url;
      videoOutput.classList.remove('hidden');
      progressRail.classList.add('hidden');
      downloadBtn.href = url;
      downloadBtn.download = (imageFile.name.replace(/\.[^/.]+$/, '') || 'video') + '.webm';
      downloadBtn.classList.remove('hidden');
      outputHint.textContent = formatTime(duration) + ' \u00b7 matches the recording exactly';
      buildBtn.disabled = false;
      setStatus('Done. The video is ready below.');

      // Let the optional intro-merge feature know a main video is ready,
      // and hand it the blob so it can stitch an intro in front of it.
      window.dispatchEvent(new CustomEvent('still:main-video-ready', {
        detail: {
          blob,
          mimeType: mimeType.split(';')[0],
          duration
        }
      }));
    };

    source.onended = () => {
      if (recorder.state === 'recording') recorder.stop();
    };

    // safety net in case onended does not fire in some browser
    const safetyTimeout = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, (duration + 1.5) * 1000);

    recorder.start(250);
    source.start(0);

    progressTimer = setInterval(() => {
      const elapsed = Math.min(duration, audioCtx.currentTime - startedAt);
      const pct = (elapsed / duration) * 100;
      progressFill.style.width = pct.toFixed(1) + '%';
      progressCounter.textContent = formatTime(elapsed) + ' / ' + formatTime(duration);
      if (elapsed >= duration) {
        clearInterval(progressTimer);
        clearTimeout(safetyTimeout);
      }
    }, 200);
  }

  buildBtn.addEventListener('click', buildVideo);

  updateBuildButtonState();
})();
