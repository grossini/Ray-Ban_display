(function () {
  'use strict';

  var CONFIG = {
    maxVolumeDim: 256,
    rotStep: 0.08,
  };

  // 'rotate' | 'threshold'
  var viewerMode = 'rotate';
  var threshold  = 0.42; // current wMin value [0..1]

  var state = {
    currentScreen: 'home',
    screenHistory: [],
  };

  var screens = {};
  var threeApp = null;
  var animFrameId = null;
  var viewerRotX = 0;
  var viewerRotY = 0;

  // ── Navigation ──────────────────────────────────────────

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function (s) {
      if (s.id) screens[s.id] = s;
    });
  }

  function navigateTo(screenId, opts) {
    opts = opts || {};
    if (opts.addToHistory !== false && state.currentScreen) {
      state.screenHistory.push(state.currentScreen);
    }
    Object.values(screens).forEach(function (s) { s.classList.add('hidden'); });
    var screen = screens[screenId];
    if (!screen) return;
    screen.classList.remove('hidden');
    state.currentScreen = screenId;
    onScreenEnter(screenId);
  }

  function onScreenEnter(screenId) {
    if (screenId === 'viewer') {
      var canvas = document.getElementById('three-canvas');
      if (canvas) setTimeout(function () { canvas.focus(); }, 50);
    } else {
      var el = screens[screenId] && screens[screenId].querySelector('.focusable');
      if (el) setTimeout(function () { el.focus(); }, 50);
    }
  }

  // ── Focus (non-viewer screens) ───────────────────────────

  function moveFocus(direction) {
    var container = screens[state.currentScreen];
    if (!container) return;
    var focusables = Array.from(container.querySelectorAll('.focusable:not([disabled]):not(.hidden)'));
    if (!focusables.length) return;
    var idx = focusables.indexOf(document.activeElement);
    if (idx === -1) { focusables[0].focus(); return; }
    var next;
    if (direction === 'up' || direction === 'left') {
      next = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      next = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[next].focus();
  }

  // ── DICOM loading ────────────────────────────────────────

  function loadDicomFile(file) {
    navigateTo('loading-screen', { addToHistory: false });
    setLoadingText('Reading file…');
    setProgress(5);

    var reader = new FileReader();
    reader.onload = function (e) {
      setProgress(30);
      setLoadingText('Parsing DICOM…');
      // Yield to allow UI update before heavy work
      setTimeout(function () {
        try {
          var info = parseDicom(e.target.result);
          var dims = info.cols + '×' + info.rows + '×' + info.frames;
          setProgress(50);
          setLoadingText('Building volume (' + dims + ')…');
          setTimeout(function () {
            try {
              var vol = buildVolume(info);
              setProgress(80);
              setLoadingText('Uploading to GPU…');
              setTimeout(function () {
                try {
                  setupViewer(vol);
                  setProgress(100);
                  navigateTo('viewer', { addToHistory: false });
                } catch (err) {
                  onError('Renderer error: ' + err.message);
                }
              }, 60);
            } catch (err) {
              onError('Volume error: ' + err.message);
            }
          }, 60);
        } catch (err) {
          onError('DICOM parse error: ' + err.message);
        }
      }, 60);
    };
    reader.onerror = function () { onError('Failed to read file.'); };
    reader.readAsArrayBuffer(file);
  }

  function parseDicom(arrayBuffer) {
    var byteArray = new Uint8Array(arrayBuffer);
    var dataSet = dicomParser.parseDicom(byteArray);

    var rows   = dataSet.uint16('x00280010') || 512;
    var cols   = dataSet.uint16('x00280011') || 512;
    var frStr  = dataSet.string('x00280008');
    var frames = frStr ? parseInt(frStr, 10) : 1;
    var bitsAllocated = dataSet.uint16('x00280100') || 16;

    var wcStr = dataSet.string('x00281050');
    var wwStr = dataSet.string('x00281051');
    var windowCenter = wcStr ? parseFloat(wcStr.split('\\')[0]) : 0;
    var windowWidth  = wwStr ? parseFloat(wwStr.split('\\')[0]) : 0;

    var pixelEl = dataSet.elements.x7fe00010;
    if (!pixelEl) throw new Error('No pixel data (7FE0,0010) found.');

    return { byteArray, rows, cols, frames, bitsAllocated, windowCenter, windowWidth, pixelEl };
  }

  function buildVolume(info) {
    var maxDim = CONFIG.maxVolumeDim;
    var tW = Math.min(info.cols,   maxDim);
    var tH = Math.min(info.rows,   maxDim);
    var tD = Math.min(info.frames, maxDim);

    var pixelCount = info.rows * info.cols * info.frames;
    var rawPixels;
    if (info.bitsAllocated === 16) {
      rawPixels = new Uint16Array(info.byteArray.buffer, info.pixelEl.dataOffset, pixelCount);
    } else {
      rawPixels = new Uint8Array(info.byteArray.buffer, info.pixelEl.dataOffset, pixelCount);
    }

    // Auto window/level if DICOM tags are missing
    var wc = info.windowCenter, ww = info.windowWidth;
    if (!ww || ww < 1) {
      var step = Math.max(1, Math.floor(rawPixels.length / 8000));
      var mn = Infinity, mx = -Infinity;
      for (var i = 0; i < rawPixels.length; i += step) {
        if (rawPixels[i] < mn) mn = rawPixels[i];
        if (rawPixels[i] > mx) mx = rawPixels[i];
      }
      wc = (mn + mx) / 2;
      ww = (mx - mn) || 1;
    }

    var wMin = wc - ww / 2;
    var wMax = wc + ww / 2;
    var range = wMax - wMin;

    var data = new Uint8Array(tW * tH * tD);
    for (var z = 0; z < tD; z++) {
      var sz = Math.floor(z * info.frames / tD);
      for (var y = 0; y < tH; y++) {
        var sy = Math.floor(y * info.rows / tH);
        for (var x = 0; x < tW; x++) {
          var sx  = Math.floor(x * info.cols / tW);
          var raw = rawPixels[sz * info.rows * info.cols + sy * info.cols + sx] || 0;
          var val = Math.round(255 * Math.max(0, Math.min(1, (raw - wMin) / range)));
          data[z * tH * tW + y * tW + x] = val;
        }
      }
    }

    return { data, width: tW, height: tH, depth: tD };
  }

  // ── Three.js volume renderer ─────────────────────────────

  var VERT = `
    out vec3 vOrigin;
    out vec3 vDirection;
    void main() {
      vOrigin    = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
      vDirection = position - vOrigin;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  // MIP ray-caster with bone-tissue colour ramp
  var FRAG = `
    precision highp float;
    precision highp sampler3D;

    uniform sampler3D uVolume;
    uniform float uWMin;
    uniform float uWMax;

    in vec3 vOrigin;
    in vec3 vDirection;
    out vec4 fragColor;

    vec2 hitBox(vec3 orig, vec3 dir) {
      const vec3 bMin = vec3(-0.5);
      const vec3 bMax = vec3( 0.5);
      vec3 invDir  = 1.0 / dir;
      vec3 tMinTmp = (bMin - orig) * invDir;
      vec3 tMaxTmp = (bMax - orig) * invDir;
      vec3 tMin = min(tMinTmp, tMaxTmp);
      vec3 tMax = max(tMinTmp, tMaxTmp);
      float t0 = max(tMin.x, max(tMin.y, tMin.z));
      float t1 = min(tMax.x, min(tMax.y, tMax.z));
      return vec2(t0, t1);
    }

    void main() {
      vec3 dir    = normalize(vDirection);
      vec2 bounds = hitBox(vOrigin, dir);
      if (bounds.x > bounds.y) discard;
      bounds.x = max(bounds.x, 0.0);

      float step   = 1.0 / 320.0;
      float t      = bounds.x;
      float maxVal = 0.0;

      for (int i = 0; i < 450; i++) {
        if (t > bounds.y) break;
        vec3 p   = vOrigin + t * dir + 0.5;
        float raw = texture(uVolume, p).r;
        float val = clamp((raw - uWMin) / (uWMax - uWMin), 0.0, 1.0);
        if (val > maxVal) maxVal = val;
        t += step;
      }

      if (maxVal < 0.04) discard;

      // Tissue → bone colour ramp
      vec3 col;
      if (maxVal < 0.35) {
        col = mix(vec3(0.02, 0.02, 0.08), vec3(0.55, 0.18, 0.10), maxVal / 0.35);
      } else if (maxVal < 0.70) {
        col = mix(vec3(0.55, 0.18, 0.10), vec3(0.90, 0.72, 0.52), (maxVal - 0.35) / 0.35);
      } else {
        col = mix(vec3(0.90, 0.72, 0.52), vec3(1.00, 0.97, 0.93), (maxVal - 0.70) / 0.30);
      }

      fragColor = vec4(col, 1.0);
    }
  `;

  function setupViewer(vol) {
    // Dispose previous renderer if reloading a file
    if (threeApp) {
      cancelAnimationFrame(animFrameId);
      threeApp.renderer.dispose();
      threeApp = null;
    }

    var canvas = document.getElementById('three-canvas');
    canvas.width  = 600;
    canvas.height = 600;

    // Require WebGL2 for DataTexture3D + sampler3D
    var gl2 = canvas.getContext('webgl2');
    if (!gl2) throw new Error('WebGL2 not available. Please use a modern browser.');

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl2, antialias: false });
    renderer.setSize(600, 600, false);
    renderer.setPixelRatio(1);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    var camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
    camera.position.set(0, 0, 2.0);

    // 3D texture (R8, WebGL2)
    var tex = new THREE.DataTexture3D(vol.data, vol.width, vol.height, vol.depth);
    tex.format         = THREE.RedFormat;
    tex.type           = THREE.UnsignedByteType;
    tex.minFilter      = THREE.LinearFilter;
    tex.magFilter      = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate    = true;

    // Scale box to match volume aspect
    var scaleX = vol.width  / vol.height;
    var scaleZ = vol.depth  / vol.height;

    var mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uVolume: { value: tex },
        uWMin:   { value: threshold },
        uWMax:   { value: 1.0 },
      },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
    });

    var geo  = new THREE.BoxGeometry(scaleX, 1.0, scaleZ);
    var mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    threeApp = { renderer, scene, camera, mesh };
    viewerRotX = 0;
    viewerRotY = 0.4;
    viewerMode = 'rotate';

    startRenderLoop();
  }

  function setThreshold(val) {
    threshold = Math.max(0, Math.min(0.98, val));
    if (threeApp) threeApp.mesh.material.uniforms.uWMin.value = threshold;
    updateSliderUI();
  }

  function updateSliderUI() {
    var pct = Math.round(threshold * 100);
    var fillEl  = document.getElementById('slider-fill');
    var thumbEl = document.getElementById('slider-thumb');
    var valEl   = document.getElementById('slider-value');
    if (fillEl)  fillEl.style.width  = pct + '%';
    if (thumbEl) thumbEl.style.left  = pct + '%';
    if (valEl)   valEl.textContent   = pct + '%';
  }

  function setViewerMode(mode) {
    viewerMode = mode;
    var modeEl   = document.getElementById('viewer-mode');
    var sliderEl = document.getElementById('viewer-slider');
    var hudEl    = document.getElementById('viewer-hud');
    if (mode === 'threshold') {
      if (modeEl)   { modeEl.textContent = 'THRESHOLD'; modeEl.classList.add('threshold-mode'); }
      if (sliderEl) sliderEl.classList.add('visible');
      if (hudEl)    hudEl.classList.add('hidden');
      updateSliderUI();
    } else {
      if (modeEl)   { modeEl.textContent = 'ROTATE'; modeEl.classList.remove('threshold-mode'); }
      if (sliderEl) sliderEl.classList.remove('visible');
      if (hudEl)    hudEl.classList.remove('hidden');
    }
  }

  function startRenderLoop() {
    function loop() {
      animFrameId = requestAnimationFrame(loop);
      if (threeApp && state.currentScreen === 'viewer') {
        threeApp.mesh.rotation.x = viewerRotX;
        threeApp.mesh.rotation.y = viewerRotY;
        threeApp.renderer.render(threeApp.scene, threeApp.camera);
      }
    }
    loop();
  }

  // ── UI helpers ───────────────────────────────────────────

  function setLoadingText(txt) {
    var el = document.getElementById('loading-text');
    if (el) el.textContent = txt;
  }

  function setProgress(pct) {
    var el = document.getElementById('progress-fill');
    if (el) el.style.width = pct + '%';
  }

  function onError(msg) {
    navigateTo('home', { addToHistory: false });
    showToast(msg, 'error');
  }

  function showToast(msg, type) {
    var t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.offsetHeight; // force reflow
    t.classList.add('visible');
    setTimeout(function () { t.classList.remove('visible'); }, 3000);
  }

  // ── Action dispatch ──────────────────────────────────────

  function handleAction(action) {
    switch (action) {
      case 'pick-file':
        document.getElementById('file-input').click();
        break;
      case 'back':
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        navigateTo('home', { addToHistory: false });
        break;
    }
  }

  // ── Events ───────────────────────────────────────────────

  function setupEvents() {
    // Button clicks
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (el) handleAction(el.dataset.action);
    });

    // File picker
    document.getElementById('file-input').addEventListener('change', function (e) {
      if (e.target.files[0]) loadDicomFile(e.target.files[0]);
    });

    // Drag-and-drop
    var dz = document.getElementById('drop-zone');
    dz.addEventListener('dragover',  function (e) { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', function ()  { dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('drag-over');
      var f = e.dataTransfer.files[0];
      if (f) loadDicomFile(f);
    });

    // Keyboard / D-pad
    document.addEventListener('keydown', function (e) {
      var inViewer     = state.currentScreen === 'viewer';
      var canvasFocused = document.activeElement && document.activeElement.id === 'three-canvas';

      switch (e.key) {
        case 'ArrowLeft':
          if (inViewer && viewerMode === 'threshold') { setThreshold(threshold - 0.02); }
          else if (inViewer) { viewerRotY -= CONFIG.rotStep; }
          else moveFocus('left');
          e.preventDefault(); break;

        case 'ArrowRight':
          if (inViewer && viewerMode === 'threshold') { setThreshold(threshold + 0.02); }
          else if (inViewer) { viewerRotY += CONFIG.rotStep; }
          else moveFocus('right');
          e.preventDefault(); break;

        case 'ArrowUp':
          if (inViewer && viewerMode === 'rotate') { viewerRotX -= CONFIG.rotStep; }
          else if (!inViewer) moveFocus('up');
          e.preventDefault(); break;

        case 'ArrowDown':
          if (inViewer && viewerMode === 'rotate') { viewerRotX += CONFIG.rotStep; }
          else if (!inViewer) moveFocus('down');
          e.preventDefault(); break;

        case 'Enter':
          if (inViewer) {
            setViewerMode(viewerMode === 'rotate' ? 'threshold' : 'rotate');
          } else if (document.activeElement && document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault(); break;

        case 'r':
        case 'R':
          if (inViewer) { viewerRotX = 0; viewerRotY = 0.4; showToast('View reset'); }
          break;

        case 'Escape':
          if (inViewer) handleAction('back');
          e.preventDefault(); break;
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────

  function init() {
    collectScreens();
    setupEvents();
    navigateTo('home', { addToHistory: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
