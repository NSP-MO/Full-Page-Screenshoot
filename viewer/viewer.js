/**
 * Viewer Script for Full Page Screenshoot Extension
 * Handles high-resolution canvas stitching, zoom controls, interactive annotations,
 * Gaussian Blur & Pixelated Mosaic redaction, continuous & multi-page A4 PDF generation,
 * PNG/JPEG export, and clipboard copying.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const pageTitle = document.getElementById('pageTitle');
  const pageUrl = document.getElementById('pageUrl');
  const resolutionBadge = document.getElementById('resolutionBadge');
  const loadingState = document.getElementById('loadingState');
  const loadingStatusText = document.getElementById('loadingStatusText');
  const canvasViewport = document.getElementById('canvasViewport');
  const canvasWrapper = document.getElementById('canvasWrapper');
  const canvas = document.getElementById('screenshotCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const annoCanvas = document.getElementById('annotationCanvas');
  const annoCtx = annoCanvas.getContext('2d', { willReadFrequently: true });
  const workspace = document.getElementById('workspace');

  // Zoom & Pan Controls
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const zoomLevelText = document.getElementById('zoomLevelText');
  const btnFitWidth = document.getElementById('btnFitWidth');
  const btnActualSize = document.getElementById('btnActualSize');

  // Action Buttons
  const btnCopyClipboard = document.getElementById('btnCopyClipboard');
  const btnSaveImage = document.getElementById('btnSaveImage');
  const btnDropdownToggle = document.getElementById('btnDropdownToggle');
  const exportDropdownMenu = document.getElementById('exportDropdownMenu');
  const btnSavePngOption = document.getElementById('btnSavePngOption');
  const btnSavePdfContinuous = document.getElementById('btnSavePdfContinuous');
  const btnSavePdfA4 = document.getElementById('btnSavePdfA4');
  const toast = document.getElementById('toast');

  // Annotation Tools
  const annoButtons = document.querySelectorAll('.anno-btn[data-tool]');
  const btnUndo = document.getElementById('btnUndo');
  const btnClearAnno = document.getElementById('btnClearAnno');
  const colorDots = document.querySelectorAll('.color-dot');
  const strokeBtns = document.querySelectorAll('.stroke-btn');

  let currentZoom = 1.0;
  let sessionData = null;

  // Annotation State (Default palette: Pure White #ffffff)
  let activeTool = 'select';
  let activeColor = '#ffffff';
  let activeStrokeWidth = 4;
  let annotations = [];
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let currentPath = [];

  // Extract Session ID from URL query parameters
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('id');

  if (!sessionId) {
    showError('Invalid screenshoot session.');
    return;
  }

  try {
    const storageResult = await chrome.storage.local.get([sessionId]);
    sessionData = storageResult[sessionId];

    if (!sessionData) {
      showError('Screenshoot data not found or expired.');
      return;
    }

    // Set target webpage metadata
    if (pageTitle) pageTitle.textContent = sessionData.title || 'Screenshoot';
    if (pageUrl) pageUrl.textContent = sessionData.url || '-';
    document.title = `${sessionData.title || 'Screenshoot'} - Full Page Screenshoot`;

    // Process rendering based on capture session type
    if (sessionData.type === 'fullpage') {
      await stitchFullPage(sessionData);
    } else if (sessionData.type === 'crop') {
      await renderCroppedArea(sessionData);
    } else {
      await renderSingleImage(sessionData.dataUrl);
    }

    // Setup annotation canvas overlay dimensions
    annoCanvas.width = canvas.width;
    annoCanvas.height = canvas.height;
    if (canvasWrapper) {
      canvasWrapper.style.width = `${canvas.width}px`;
      canvasWrapper.style.height = `${canvas.height}px`;
    }

    // Display canvas and hide loading spinner
    if (loadingState) loadingState.classList.add('hidden');
    if (canvasWrapper) canvasWrapper.classList.remove('hidden');

    // Auto-fit to width on initial display
    fitToWidth();

    // Automatically copy screenshot to clipboard upon completion
    copyToClipboard(true);
  } catch (err) {
    console.error(err);
    showError('Failed to render screenshoot: ' + err.message);
  }

  /**
   * Stitch vertical slices into a unified master canvas
   */
  async function stitchFullPage(data) {
    const { slices, metrics, isContainer, cropRect } = data;
    if (!slices || slices.length === 0) {
      throw new Error('No image slices found.');
    }

    if (loadingStatusText) {
      loadingStatusText.textContent = `Loading ${slices.length} image slices...`;
    }

    // Load all slice images in parallel
    const loadedImages = await Promise.all(
      slices.map((slice, index) => {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ img, slice });
          img.onerror = () => reject(new Error(`Failed to load slice #${index + 1}`));
          img.src = slice.dataUrl;
        });
      })
    );

    const firstImg = loadedImages[0].img;
    const capturedWinW = (metrics && metrics.windowWidth) || (metrics && metrics.clientWidth) || firstImg.naturalWidth;
    const dpr = (metrics && metrics.devicePixelRatio) || (firstImg.naturalWidth / capturedWinW) || 1;
    const pageBgColor = (metrics && metrics.backgroundColor) || '#1f1f1f';

    if (isContainer && cropRect) {
      // Container mode (DeepSeek, Twitch, ChatGPT, Google Docs, Notion)
      const sx = Math.max(0, Math.round(cropRect.x * dpr));
      const sy = Math.max(0, Math.round(cropRect.y * dpr));
      const sw = Math.min(firstImg.naturalWidth - sx, Math.round(cropRect.width * dpr));
      const sh = Math.min(firstImg.naturalHeight - sy, Math.round(cropRect.height * dpr));

      const containerStitchedHeight = Math.max(
        ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + sh)
      );

      canvas.width = sw;
      canvas.height = containerStitchedHeight;

      ctx.fillStyle = pageBgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (loadingStatusText) {
        loadingStatusText.textContent = 'Stitching slices into continuous screenshot...';
      }

      for (const item of loadedImages) {
        const { img, slice } = item;
        const destinationY = Math.round(slice.actualY * dpr);
        ctx.drawImage(img, sx, sy, sw, sh, 0, destinationY, sw, sh);
      }
    } else {
      // Standard full page mode (GitHub, Wikipedia, MDN, etc.)
      const totalCanvasWidth = Math.round(firstImg.naturalWidth);
      const maxReach = Math.max(
        ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + firstImg.naturalHeight)
      );

      canvas.width = totalCanvasWidth;
      canvas.height = maxReach;

      ctx.fillStyle = pageBgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (loadingStatusText) {
        loadingStatusText.textContent = 'Stitching slices into master canvas...';
      }

      for (const item of loadedImages) {
        const { img, slice } = item;
        const destinationY = Math.round(slice.actualY * dpr);
        ctx.drawImage(img, 0, destinationY);
      }
    }

    updateResolutionBadge(canvas.width, canvas.height);
  }

  /**
   * Render cropped selection region
   */
  async function renderCroppedArea(data) {
    const { dataUrl, cropRect, dpr } = data;
    const img = await loadImageAsync(dataUrl);

    const scale = dpr || 1;
    const sx = Math.round(cropRect.x * scale);
    const sy = Math.round(cropRect.y * scale);
    const sw = Math.round(cropRect.width * scale);
    const sh = Math.round(cropRect.height * scale);

    canvas.width = sw;
    canvas.height = sh;

    const pageBgColor = (data.metrics && data.metrics.backgroundColor) || '#1f1f1f';
    ctx.fillStyle = pageBgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    updateResolutionBadge(canvas.width, canvas.height);
  }

  /**
   * Render single viewport image
   */
  async function renderSingleImage(dataUrl) {
    const img = await loadImageAsync(dataUrl);
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const pageBgColor = (sessionData && sessionData.metrics && sessionData.metrics.backgroundColor) || '#1f1f1f';
    ctx.fillStyle = pageBgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    updateResolutionBadge(canvas.width, canvas.height);
  }

  function loadImageAsync(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image resource.'));
      img.src = url;
    });
  }

  function updateResolutionBadge(width, height) {
    if (resolutionBadge) {
      resolutionBadge.textContent = `${width.toLocaleString()} x ${height.toLocaleString()} px`;
    }
  }

  function showError(msg) {
    if (loadingState) {
      loadingState.innerHTML = `<p style="color: #f87171; font-weight: 600;">${msg}</p>`;
    }
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  }

  // Viewport layout synchronization helper
  function updateViewportLayout() {
    if (!canvas.width || !canvas.height || !canvasViewport || !canvasWrapper) return;

    const scaledW = canvas.width * currentZoom;
    const scaledH = canvas.height * currentZoom;
    const wsWidth = workspace.clientWidth || window.innerWidth;

    const horizontalPad = Math.max(20, Math.floor((wsWidth - scaledW) / 2));
    const topPad = 60;
    const bottomPad = 40;

    canvasViewport.style.width = `${Math.round(scaledW + horizontalPad * 2)}px`;
    canvasViewport.style.height = `${Math.round(scaledH + topPad + bottomPad)}px`;

    canvasWrapper.style.left = `${horizontalPad}px`;
    canvasWrapper.style.top = `${topPad}px`;
    canvasWrapper.style.transform = `scale(${currentZoom})`;
  }

  // Zoom Handling
  function setZoom(newZoom) {
    currentZoom = Math.max(0.05, Math.min(5.0, newZoom));
    updateViewportLayout();
    if (zoomLevelText) {
      zoomLevelText.textContent = `${Math.round(currentZoom * 100)}%`;
    }
  }

  function zoomAroundPoint(factor, clientX, clientY) {
    if (!canvas.width || !canvas.height) return;

    const oldZoom = currentZoom;
    const newZoom = Math.max(0.05, Math.min(5.0, oldZoom * factor));
    if (Math.abs(newZoom - oldZoom) < 0.0001) return;

    const rect = workspace.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;

    const wsWidth = workspace.clientWidth;
    const oldScaledW = canvas.width * oldZoom;
    const oldPadX = Math.max(20, Math.floor((wsWidth - oldScaledW) / 2));
    const topPad = 60;

    // Canvas coordinate under the cursor
    const canvasX = (workspace.scrollLeft + cursorX - oldPadX) / oldZoom;
    const canvasY = (workspace.scrollTop + cursorY - topPad) / oldZoom;

    // Apply new scale and layout
    currentZoom = newZoom;
    updateViewportLayout();

    if (zoomLevelText) {
      zoomLevelText.textContent = `${Math.round(currentZoom * 100)}%`;
    }

    // Anchor: reposition scroll so the canvas point under cursor remains exactly stationary
    const newScaledW = canvas.width * newZoom;
    const newPadX = Math.max(20, Math.floor((wsWidth - newScaledW) / 2));

    const targetScrollX = Math.round(newPadX + canvasX * newZoom - cursorX);
    const targetScrollY = Math.round(topPad + canvasY * newZoom - cursorY);

    workspace.scrollLeft = Math.max(0, targetScrollX);
    workspace.scrollTop = Math.max(0, targetScrollY);
  }

  function zoomByCenter(factor) {
    const rect = workspace.getBoundingClientRect();
    zoomAroundPoint(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomByCenter(1.15));
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomByCenter(1 / 1.15));
  if (btnActualSize) btnActualSize.addEventListener('click', () => { setZoom(1.0); workspace.scrollLeft = 0; });

  function fitToWidth() {
    if (!canvas.width || !workspace) return;
    const availableWidth = workspace.clientWidth - 80;
    const ratio = availableWidth / canvas.width;
    setZoom(Math.min(1.0, ratio));
    workspace.scrollLeft = 0;
    workspace.scrollTop = 0;
  }

  if (btnFitWidth) btnFitWidth.addEventListener('click', fitToWidth);

  // Intercept Ctrl + Wheel, Alt + Wheel, and trackpad pinch to zoom preview instead of browser page
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const zoomFactor = Math.exp(-e.deltaY * 0.0025);
      zoomAroundPoint(zoomFactor, e.clientX, e.clientY);
    }
  }, { passive: false });

  // Keep centering layout updated on window resize
  window.addEventListener('resize', () => {
    updateViewportLayout();
  });

  // Filename generator
  function generateFilename(ext) {
    const rawTitle = (sessionData && sessionData.title) || 'screenshoot';
    const cleanTitle = rawTitle.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `${cleanTitle}_${dateStr}.${ext}`;
  }

  // ==========================================
  // ANNOTATION ENGINE
  // ==========================================

  function setActiveTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.anno-btn[data-tool]').forEach((b) => {
      if (b.dataset.tool === tool) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    if (tool === 'select') {
      annoCanvas.style.cursor = 'grab';
    } else if (tool === 'text') {
      annoCanvas.style.cursor = 'text';
    } else {
      annoCanvas.style.cursor = 'crosshair';
    }
  }

  annoButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveTool(btn.dataset.tool);
    });
  });

  // Color selection
  colorDots.forEach((dot) => {
    dot.addEventListener('click', () => {
      colorDots.forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      activeColor = dot.dataset.color;
    });
  });

  // Stroke width selection
  strokeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      strokeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeStrokeWidth = parseInt(btn.dataset.size, 10);
    });
  });

  // Canvas coordinates helper (taking zoom scale into account)
  function getCanvasCoords(e) {
    const rect = annoCanvas.getBoundingClientRect();
    const scaleX = annoCanvas.width / rect.width;
    const scaleY = annoCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  // Draw arrow helper
  function drawArrow(targetCtx, fromX, fromY, toX, toY, color, lineWidth) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;

    const angle = Math.atan2(dy, dx);
    const headAngle = Math.PI / 6;
    const headLength = Math.min(dist * 0.85, Math.max(16, lineWidth * 3.8));
    const baseDist = headLength * Math.cos(headAngle);

    targetCtx.save();
    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineWidth = lineWidth;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';

    // 1. Draw line shaft terminating at the base of the arrowhead (never reaching the tip)
    if (dist > baseDist) {
      const shaftEndX = toX - baseDist * Math.cos(angle);
      const shaftEndY = toY - baseDist * Math.sin(angle);

      targetCtx.beginPath();
      targetCtx.moveTo(fromX, fromY);
      targetCtx.lineTo(shaftEndX, shaftEndY);
      targetCtx.stroke();
    }

    // 2. Draw crisp arrowhead polygon with true tip at (toX, toY)
    const wing1X = toX - headLength * Math.cos(angle - headAngle);
    const wing1Y = toY - headLength * Math.sin(angle - headAngle);
    const wing2X = toX - headLength * Math.cos(angle + headAngle);
    const wing2Y = toY - headLength * Math.sin(angle + headAngle);

    targetCtx.beginPath();
    targetCtx.moveTo(toX, toY);
    targetCtx.lineTo(wing1X, wing1Y);
    targetCtx.lineTo(wing2X, wing2Y);
    targetCtx.closePath();
    targetCtx.fill();

    targetCtx.restore();
  }

  // Draw smooth Gaussian blur helper
  function drawGaussianBlur(targetCtx, x, y, width, height, blurRadius = 14) {
    const minW = Math.max(1, Math.round(width));
    const minH = Math.max(1, Math.round(height));

    const offscreen = document.createElement('canvas');
    offscreen.width = minW;
    offscreen.height = minH;
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true });

    // Native GPU-accelerated Canvas Gaussian filter
    offCtx.filter = `blur(${blurRadius}px)`;

    const pad = blurRadius * 2;
    offCtx.drawImage(
      canvas,
      x - pad, y - pad, minW + pad * 2, minH + pad * 2,
      -pad, -pad, minW + pad * 2, minH + pad * 2
    );

    targetCtx.save();
    targetCtx.drawImage(offscreen, x, y, minW, minH);

    // Subtle sleek border around blurred redaction
    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    targetCtx.lineWidth = 1;
    targetCtx.strokeRect(x, y, minW, minH);
    targetCtx.restore();
  }

  // Draw pixelated blur mosaic helper
  function drawPixelatedBlur(targetCtx, x, y, width, height) {
    const minW = Math.max(1, Math.round(width));
    const minH = Math.max(1, Math.round(height));

    const sourceData = ctx.getImageData(x, y, minW, minH);
    const offscreen = document.createElement('canvas');
    offscreen.width = minW;
    offscreen.height = minH;
    const offCtx = offscreen.getContext('2d', { willReadFrequently: true });
    offCtx.putImageData(sourceData, 0, 0);

    const pixelBlockSize = 14;
    const miniW = Math.max(1, Math.round(minW / pixelBlockSize));
    const miniH = Math.max(1, Math.round(minH / pixelBlockSize));

    const miniCanvas = document.createElement('canvas');
    miniCanvas.width = miniW;
    miniCanvas.height = miniH;
    const miniCtx = miniCanvas.getContext('2d', { willReadFrequently: true });

    miniCtx.drawImage(offscreen, 0, 0, miniW, miniH);

    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(miniCanvas, 0, 0, miniW, miniH, x, y, minW, minH);

    // Subtle border around blurred redaction
    targetCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    targetCtx.lineWidth = 1;
    targetCtx.strokeRect(x, y, minW, minH);
    targetCtx.restore();
  }

  // Redraw all annotations on annotationCanvas
  function redrawAnnotations() {
    annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);

    for (const item of annotations) {
      if (item.type === 'blur') {
        drawGaussianBlur(annoCtx, item.x, item.y, item.width, item.height, item.blurRadius || 14);
      } else if (item.type === 'mosaic') {
        drawPixelatedBlur(annoCtx, item.x, item.y, item.width, item.height);
      } else if (item.type === 'rect') {
        annoCtx.strokeStyle = item.color;
        annoCtx.lineWidth = item.lineWidth;
        annoCtx.strokeRect(item.x, item.y, item.width, item.height);
      } else if (item.type === 'arrow') {
        drawArrow(annoCtx, item.startX, item.startY, item.endX, item.endY, item.color, item.lineWidth);
      } else if (item.type === 'pen') {
        if (item.points && item.points.length > 1) {
          annoCtx.strokeStyle = item.color;
          annoCtx.lineWidth = item.lineWidth;
          annoCtx.lineCap = 'round';
          annoCtx.lineJoin = 'round';
          annoCtx.beginPath();
          annoCtx.moveTo(item.points[0].x, item.points[0].y);
          for (let i = 1; i < item.points.length; i++) {
            annoCtx.lineTo(item.points[i].x, item.points[i].y);
          }
          annoCtx.stroke();
        }
      } else if (item.type === 'text') {
        annoCtx.font = `bold ${item.fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        const textMetrics = annoCtx.measureText(item.text);
        const padding = 8;
        const textH = item.fontSize;

        // Background pill badge
        annoCtx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        annoCtx.fillRect(
          item.x - padding,
          item.y - textH - padding + 4,
          textMetrics.width + padding * 2,
          textH + padding * 2
        );
        annoCtx.strokeStyle = item.color;
        annoCtx.lineWidth = 2;
        annoCtx.strokeRect(
          item.x - padding,
          item.y - textH - padding + 4,
          textMetrics.width + padding * 2,
          textH + padding * 2
        );

        // Text
        annoCtx.fillStyle = item.color;
        annoCtx.fillText(item.text, item.x, item.y);
      }
    }
  }

  // Panning state for Select mode or middle-click drag
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let scrollStartX = 0;
  let scrollStartY = 0;

  // Mouse Interaction on Annotation Canvas
  annoCanvas.addEventListener('mousedown', (e) => {
    if (activeTool === 'select' || e.button === 1) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = workspace.scrollLeft;
      scrollStartY = workspace.scrollTop;
      annoCanvas.style.cursor = 'grabbing';
      return;
    }

    const coords = getCanvasCoords(e);
    isDrawing = true;
    startX = coords.x;
    startY = coords.y;

    if (activeTool === 'pen') {
      currentPath = [{ x: startX, y: startY }];
    } else if (activeTool === 'text') {
      const userText = prompt('Enter annotation text:');
      if (userText && userText.trim()) {
        annotations.push({
          type: 'text',
          x: startX,
          y: startY,
          text: userText.trim(),
          color: activeColor,
          fontSize: Math.max(16, activeStrokeWidth * 4)
        });
        redrawAnnotations();
      }
      isDrawing = false;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      workspace.scrollLeft = scrollStartX - (e.clientX - panStartX);
      workspace.scrollTop = scrollStartY - (e.clientY - panStartY);
      return;
    }
    if (!isDrawing) return;

    const coords = getCanvasCoords(e);
    redrawAnnotations();

    const curX = coords.x;
    const curY = coords.y;

    if (activeTool === 'rect') {
      const left = Math.min(startX, curX);
      const top = Math.min(startY, curY);
      const width = Math.abs(curX - startX);
      const height = Math.abs(curY - startY);

      annoCtx.strokeStyle = activeColor;
      annoCtx.lineWidth = activeStrokeWidth;
      annoCtx.strokeRect(left, top, width, height);
    } else if (activeTool === 'blur') {
      const left = Math.min(startX, curX);
      const top = Math.min(startY, curY);
      const width = Math.abs(curX - startX);
      const height = Math.abs(curY - startY);

      drawGaussianBlur(annoCtx, left, top, width, height, 14);
    } else if (activeTool === 'mosaic') {
      const left = Math.min(startX, curX);
      const top = Math.min(startY, curY);
      const width = Math.abs(curX - startX);
      const height = Math.abs(curY - startY);

      drawPixelatedBlur(annoCtx, left, top, width, height);
    } else if (activeTool === 'arrow') {
      drawArrow(annoCtx, startX, startY, curX, curY, activeColor, activeStrokeWidth);
    } else if (activeTool === 'pen') {
      currentPath.push({ x: curX, y: curY });
      annoCtx.strokeStyle = activeColor;
      annoCtx.lineWidth = activeStrokeWidth;
      annoCtx.lineCap = 'round';
      annoCtx.lineJoin = 'round';
      annoCtx.beginPath();
      annoCtx.moveTo(currentPath[0].x, currentPath[0].y);
      for (let i = 1; i < currentPath.length; i++) {
        annoCtx.lineTo(currentPath[i].x, currentPath[i].y);
      }
      annoCtx.stroke();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (isPanning) {
      isPanning = false;
      annoCanvas.style.cursor = activeTool === 'select' ? 'grab' : 'crosshair';
      return;
    }
    if (!isDrawing) return;
    isDrawing = false;

    const coords = getCanvasCoords(e);
    const endX = coords.x;
    const endY = coords.y;

    if (activeTool === 'rect') {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      if (width > 4 && height > 4) {
        annotations.push({
          type: 'rect',
          x: left,
          y: top,
          width: width,
          height: height,
          color: activeColor,
          lineWidth: activeStrokeWidth
        });
      }
    } else if (activeTool === 'blur') {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      if (width > 4 && height > 4) {
        annotations.push({
          type: 'blur',
          x: left,
          y: top,
          width: width,
          height: height,
          blurRadius: 14
        });
      }
    } else if (activeTool === 'mosaic') {
      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);
      if (width > 4 && height > 4) {
        annotations.push({
          type: 'mosaic',
          x: left,
          y: top,
          width: width,
          height: height
        });
      }
    } else if (activeTool === 'arrow') {
      const dist = Math.hypot(endX - startX, endY - startY);
      if (dist > 8) {
        annotations.push({
          type: 'arrow',
          startX: startX,
          startY: startY,
          endX: endX,
          endY: endY,
          color: activeColor,
          lineWidth: activeStrokeWidth
        });
      }
    } else if (activeTool === 'pen') {
      if (currentPath.length > 1) {
        annotations.push({
          type: 'pen',
          points: currentPath,
          color: activeColor,
          lineWidth: activeStrokeWidth
        });
      }
    }

    redrawAnnotations();
  });

  // Undo & Clear
  function undoLastAnnotation() {
    if (annotations.length > 0) {
      annotations.pop();
      redrawAnnotations();
      showToast('Undo annotation');
    }
  }

  if (btnUndo) btnUndo.addEventListener('click', undoLastAnnotation);

  if (btnClearAnno) {
    btnClearAnno.addEventListener('click', () => {
      if (annotations.length > 0) {
        annotations = [];
        redrawAnnotations();
        showToast('All annotations cleared');
      }
    });
  }

  // Keyboard shortcut for Undo (Ctrl+Z), Zoom (Ctrl + / -, Ctrl 0), & Tools (V, G, M, R, A, P, T)
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomByCenter(1.15);
        return;
      }
      if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomByCenter(1 / 1.15);
        return;
      }
      if (e.key === '0' || e.code === 'Numpad0') {
        e.preventDefault();
        setZoom(1.0);
        workspace.scrollLeft = 0;
        return;
      }
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoLastAnnotation();
        return;
      }
    }

    const k = e.key.toLowerCase();
    if (k === 'v') setActiveTool('select');
    if (k === 'g') setActiveTool('blur');
    if (k === 'm' || k === 'b') setActiveTool('mosaic');
    if (k === 'r') setActiveTool('rect');
    if (k === 'a') setActiveTool('arrow');
    if (k === 'p') setActiveTool('pen');
    if (k === 't') setActiveTool('text');
  });

  // Merge base canvas and annotations into a single output canvas
  function getFlattenedCanvas() {
    const flatCanvas = document.createElement('canvas');
    flatCanvas.width = canvas.width;
    flatCanvas.height = canvas.height;
    const flatCtx = flatCanvas.getContext('2d', { willReadFrequently: true });

    // Draw base screenshoot
    flatCtx.drawImage(canvas, 0, 0);

    // Draw annotations layer
    flatCtx.drawImage(annoCanvas, 0, 0);

    return flatCanvas;
  }

  // ==========================================
  // EXPORT & DOWNLOAD HANDLERS
  // ==========================================

  async function downloadBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        saveAs: true
      });
    } catch (e) {
      const link = document.createElement('a');
      link.download = filename;
      link.href = blobUrl;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  }

  // PNG / JPEG Download
  async function triggerImageDownload(format = 'png') {
    showToast(`Preparing ${format.toUpperCase()} file...`);
    const flatCanvas = getFlattenedCanvas();
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpeg' ? 0.94 : undefined;
    const filename = generateFilename(format);

    flatCanvas.toBlob(async (blob) => {
      if (!blob) {
        showToast('Failed to generate image file.');
        return;
      }
      await downloadBlob(blob, filename);
      showToast(`${format.toUpperCase()} downloaded successfully!`);
    }, mimeType, quality);
  }

  // Escape PDF literal string (parentheses and backslashes)
  function escapePdfString(str) {
    if (!str) return '';
    let safeStr = str;
    try {
      safeStr = encodeURI(decodeURI(str));
    } catch (e) {
      safeStr = str;
    }
    return safeStr.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  // Retrieve active links mapped to canvas coordinates, excluding redacted areas
  function getActiveLinks() {
    const rawLinks = (sessionData && ((sessionData.metrics && sessionData.metrics.links) || sessionData.links)) || [];
    if (!rawLinks || rawLinks.length === 0) return [];

    const metrics = sessionData.metrics;
    const dpr = (metrics && metrics.devicePixelRatio) || 1;

    let offsetX = 0;
    let offsetY = 0;
    if (sessionData.type === 'crop' && sessionData.cropRect) {
      offsetX = sessionData.cropRect.x;
      offsetY = sessionData.cropRect.y;
    }

    const result = [];
    for (const link of rawLinks) {
      const lx = (link.x - offsetX) * dpr;
      const ly = (link.y - offsetY) * dpr;
      const lw = link.width * dpr;
      const lh = link.height * dpr;

      // Filter out-of-bounds links
      if (lx + lw <= 0 || ly + lh <= 0 || lx >= canvas.width || ly >= canvas.height) {
        continue;
      }

      // Redaction safety: discard link if covered by blur or mosaic annotations
      const isRedacted = annotations.some((anno) => {
        if (anno.type !== 'blur' && anno.type !== 'mosaic') return false;
        return (
          lx < anno.x + anno.width &&
          lx + lw > anno.x &&
          ly < anno.y + anno.height &&
          ly + lh > anno.y
        );
      });

      if (isRedacted) continue;

      result.push({
        url: link.url,
        x: Math.max(0, lx),
        y: Math.max(0, ly),
        width: Math.min(canvas.width - Math.max(0, lx), lw),
        height: Math.min(canvas.height - Math.max(0, ly), lh)
      });
    }

    return result;
  }

  // Continuous Single-Page PDF (Standard PDF 1.4)
  function createContinuousPdfBlob(cvs, quality = 0.94) {
    return new Promise((resolve, reject) => {
      cvs.toBlob((jpegBlob) => {
        if (!jpegBlob) {
          reject(new Error('Failed to create JPEG data stream.'));
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          try {
            const jpegBytes = new Uint8Array(reader.result);
            const wPx = cvs.width;
            const hPx = cvs.height;
            const wPt = (wPx * 72) / 96;
            const hPt = (hPx * 72) / 96;

            const activeLinks = getActiveLinks();
            const annotRefs = [];
            const annotObjects = [];

            // Annotations start at object ID 6
            for (let i = 0; i < activeLinks.length; i++) {
              const link = activeLinks[i];
              const annotObjNum = 6 + i;
              annotRefs.push(`${annotObjNum} 0 R`);

              let llx = ((link.x * 72) / 96);
              let lly = (hPt - ((link.y + link.height) * 72) / 96);
              let urx = (((link.x + link.width) * 72) / 96);
              let ury = (hPt - (link.y * 72) / 96);

              if (urx <= llx) urx = llx + 0.1;
              if (ury <= lly) ury = lly + 0.1;

              const escapedUri = escapePdfString(link.url);
              const annotObjStr = `${annotObjNum} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${llx.toFixed(2)} ${lly.toFixed(2)} ${urx.toFixed(2)} ${ury.toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI (${escapedUri}) >> >>\nendobj\n`;
              annotObjects.push(annotObjStr);
            }

            const annotsEntry = annotRefs.length > 0 ? `/Annots [${annotRefs.join(' ')}] ` : '';

            const encoder = new TextEncoder();
            const parts = [];
            function addChunk(strOrBytes) {
              const b = typeof strOrBytes === 'string' ? encoder.encode(strOrBytes) : strOrBytes;
              parts.push(b);
            }

            const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
            addChunk(header);

            const objByteOffsets = [];
            let currentOffset = header.length;

            const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
            objByteOffsets.push(currentOffset);
            addChunk(obj1);
            currentOffset += obj1.length;

            const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
            objByteOffsets.push(currentOffset);
            addChunk(obj2);
            currentOffset += obj2.length;

            const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ${annotsEntry}/Resources << /XObject << /Im1 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`;
            objByteOffsets.push(currentOffset);
            addChunk(obj3);
            currentOffset += obj3.length;

            const imgHeader = `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`;
            const imgFooter = '\nendstream\nendobj\n';
            objByteOffsets.push(currentOffset);
            addChunk(imgHeader);
            addChunk(jpegBytes);
            addChunk(imgFooter);
            currentOffset += imgHeader.length + jpegBytes.length + imgFooter.length;

            const contentStream = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im1 Do Q`;
            const obj5 = `5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`;
            objByteOffsets.push(currentOffset);
            addChunk(obj5);
            currentOffset += obj5.length;

            for (let i = 0; i < annotObjects.length; i++) {
              const annotStr = annotObjects[i];
              objByteOffsets.push(currentOffset);
              addChunk(annotStr);
              currentOffset += annotStr.length;
            }

            const startXref = currentOffset;
            const totalObjs = 6 + annotObjects.length;
            const pad = (n) => String(n).padStart(10, '0');

            let xrefStr = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
            for (let i = 0; i < objByteOffsets.length; i++) {
              xrefStr += `${pad(objByteOffsets[i])} 00000 n \n`;
            }
            xrefStr += `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
            addChunk(xrefStr);

            const pdfBlob = new Blob(parts, { type: 'application/pdf' });
            resolve(pdfBlob);
          } catch (e) {
            reject(e);
          }
        };
        reader.readAsArrayBuffer(jpegBlob);
      }, 'image/jpeg', quality);
    });
  }

  // Multi-Page Paginated A4 PDF Generator
  async function createMultiPageA4PdfBlob(flatCvs) {
    const a4WidthPt = 595.28;
    const a4HeightPt = 841.89;
    const marginPt = 20;

    const printableWidthPt = a4WidthPt - (marginPt * 2);
    const printableHeightPt = a4HeightPt - (marginPt * 2) - 15;

    const scale = printableWidthPt / flatCvs.width;
    const sliceHeightPx = Math.floor(printableHeightPt / scale);

    const totalPages = Math.max(1, Math.ceil(flatCvs.height / sliceHeightPx));
    const pageImageBlobs = [];
    const pageBgColor = (sessionData && sessionData.metrics && sessionData.metrics.backgroundColor) || '#1f1f1f';

    for (let p = 0; p < totalPages; p++) {
      const sliceTop = p * sliceHeightPx;
      const currentSliceH = Math.min(sliceHeightPx, flatCvs.height - sliceTop);

      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = flatCvs.width;
      sliceCanvas.height = currentSliceH;
      const sCtx = sliceCanvas.getContext('2d', { willReadFrequently: true });
      sCtx.fillStyle = pageBgColor;
      sCtx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      sCtx.drawImage(flatCvs, 0, sliceTop, flatCvs.width, currentSliceH, 0, 0, flatCvs.width, currentSliceH);

      const jpegBlob = await new Promise((r) => sliceCanvas.toBlob(r, 'image/jpeg', 0.94));
      const arrayBuffer = await jpegBlob.arrayBuffer();
      pageImageBlobs.push({
        bytes: new Uint8Array(arrayBuffer),
        widthPx: sliceCanvas.width,
        heightPx: sliceCanvas.height,
        heightPt: currentSliceH * scale,
        sliceTop: sliceTop,
        currentSliceH: currentSliceH
      });
    }

    // Partition active links per page
    const activeLinks = getActiveLinks();
    const pageLinks = Array.from({ length: totalPages }, () => []);

    for (const link of activeLinks) {
      const linkTop = link.y;
      const linkBottom = link.y + link.height;

      for (let p = 0; p < totalPages; p++) {
        const sliceTop = p * sliceHeightPx;
        const currentSliceH = pageImageBlobs[p].currentSliceH;

        if (linkBottom > sliceTop && linkTop < sliceTop + currentSliceH) {
          const visibleTop = Math.max(linkTop, sliceTop);
          const visibleBottom = Math.min(linkBottom, sliceTop + currentSliceH);
          const topOffset = visibleTop - sliceTop;
          const bottomOffset = visibleBottom - sliceTop;

          let llx = marginPt + (link.x * scale);
          let urx = marginPt + ((link.x + link.width) * scale);
          let ury = (a4HeightPt - marginPt) - (topOffset * scale);
          let lly = (a4HeightPt - marginPt) - (bottomOffset * scale);

          if (urx <= llx) urx = llx + 0.1;
          if (ury <= lly) ury = lly + 0.1;

          pageLinks[p].push({
            url: link.url,
            rect: [llx.toFixed(2), lly.toFixed(2), urx.toFixed(2), ury.toFixed(2)]
          });
        }
      }
    }

    // Allocate dynamic object numbers
    let nextObjId = 1;
    const catalogObjId = nextObjId++; // 1
    const pagesObjId = nextObjId++;   // 2

    const pageMeta = [];
    for (let p = 0; p < totalPages; p++) {
      const pageObjId = nextObjId++;
      const imgObjId = nextObjId++;
      const contentObjId = nextObjId++;
      const annotObjIds = [];

      for (let k = 0; k < pageLinks[p].length; k++) {
        annotObjIds.push(nextObjId++);
      }

      pageMeta.push({
        pageObjId,
        imgObjId,
        contentObjId,
        annotObjIds,
        links: pageLinks[p],
        data: pageImageBlobs[p]
      });
    }

    const encoder = new TextEncoder();
    const parts = [];
    function addChunk(strOrBytes) {
      const bytes = typeof strOrBytes === 'string' ? encoder.encode(strOrBytes) : strOrBytes;
      parts.push(bytes);
    }

    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    addChunk(header);

    const objByteOffsets = [];
    let currentOffset = header.length;

    const kidsRefs = pageMeta.map((m) => `${m.pageObjId} 0 R`).join(' ');
    const obj1 = `${catalogObjId} 0 obj\n<< /Type /Catalog /Pages ${pagesObjId} 0 R >>\nendobj\n`;
    const obj2 = `${pagesObjId} 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${totalPages} >>\nendobj\n`;

    objByteOffsets.push(currentOffset);
    addChunk(obj1);
    currentOffset += obj1.length;

    objByteOffsets.push(currentOffset);
    addChunk(obj2);
    currentOffset += obj2.length;

    for (let p = 0; p < totalPages; p++) {
      const meta = pageMeta[p];
      const pData = meta.data;

      const annotsEntry = meta.annotObjIds.length > 0
        ? `/Annots [${meta.annotObjIds.map((id) => `${id} 0 R`).join(' ')}] `
        : '';

      const pageObjStr = `${meta.pageObjId} 0 obj\n<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${a4WidthPt} ${a4HeightPt}] ${annotsEntry}/Resources << /XObject << /Im${p + 1} ${meta.imgObjId} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${meta.contentObjId} 0 R >>\nendobj\n`;
      objByteOffsets.push(currentOffset);
      addChunk(pageObjStr);
      currentOffset += pageObjStr.length;

      const imgHeaderStr = `${meta.imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pData.widthPx} /Height ${pData.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pData.bytes.length} >>\nstream\n`;
      const imgFooterStr = '\nendstream\nendobj\n';

      objByteOffsets.push(currentOffset);
      addChunk(imgHeaderStr);
      addChunk(pData.bytes);
      addChunk(imgFooterStr);
      currentOffset += imgHeaderStr.length + pData.bytes.length + imgFooterStr.length;

      const drawY = a4HeightPt - marginPt - pData.heightPt;
      const contentStr = `q ${printableWidthPt.toFixed(2)} 0 0 ${pData.heightPt.toFixed(2)} ${marginPt} ${drawY.toFixed(2)} cm /Im${p + 1} Do Q`;
      const contentObjStr = `${meta.contentObjId} 0 obj\n<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream\nendobj\n`;

      objByteOffsets.push(currentOffset);
      addChunk(contentObjStr);
      currentOffset += contentObjStr.length;

      // Link annotation objects for this page
      for (let k = 0; k < meta.links.length; k++) {
        const link = meta.links[k];
        const annotId = meta.annotObjIds[k];
        const escapedUri = escapePdfString(link.url);
        const annotStr = `${annotId} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${escapedUri}) >> >>\nendobj\n`;

        objByteOffsets.push(currentOffset);
        addChunk(annotStr);
        currentOffset += annotStr.length;
      }
    }

    const startXref = currentOffset;
    const totalObjs = nextObjId;
    const pad = (n) => String(n).padStart(10, '0');

    let xrefStr = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
    for (let i = 0; i < objByteOffsets.length; i++) {
      xrefStr += `${pad(objByteOffsets[i])} 00000 n \n`;
    }
    xrefStr += `trailer\n<< /Size ${totalObjs} /Root ${catalogObjId} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    addChunk(xrefStr);

    return new Blob(parts, { type: 'application/pdf' });
  }

  // Continuous PDF Download Action
  async function triggerContinuousPdfDownload() {
    showToast('Generating single-page continuous PDF...');
    try {
      const flatCanvas = getFlattenedCanvas();
      const pdfBlob = await createContinuousPdfBlob(flatCanvas);
      const filename = generateFilename('pdf');
      await downloadBlob(pdfBlob, filename);
      showToast('Continuous PDF downloaded successfully!');
    } catch (err) {
      console.error(err);
      showToast('Failed to generate PDF: ' + err.message);
    }
  }

  // Multi-Page A4 PDF Download Action
  async function triggerMultiPagePdfDownload() {
    showToast('Generating multi-page A4 PDF...');
    try {
      const flatCanvas = getFlattenedCanvas();
      const pdfBlob = await createMultiPageA4PdfBlob(flatCanvas);
      const rawTitle = (sessionData && sessionData.title) || 'screenshoot';
      const cleanTitle = rawTitle.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 40);
      const filename = `${cleanTitle}_A4_document.pdf`;
      await downloadBlob(pdfBlob, filename);
      showToast('Multi-Page A4 PDF downloaded successfully!');
    } catch (err) {
      console.error(err);
      showToast('Failed to generate A4 PDF: ' + err.message);
    }
  }

  // Unified Clipboard Copy Handler (Auto & Manual)
  async function copyToClipboard(isAuto = false) {
    const flatCanvas = getFlattenedCanvas();
    flatCanvas.toBlob(async (blob) => {
      if (!blob) {
        if (!isAuto) showToast('Failed to copy');
        return;
      }

      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showToast('Copied to clipboard');
      } catch (err) {
        console.warn('Clipboard copy error:', err);
        if (isAuto) {
          // Retry once when tab gains focus if initial copy was delayed by window activation
          const onFocusRetry = async () => {
            window.removeEventListener('focus', onFocusRetry);
            try {
              await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
              ]);
              showToast('Copied to clipboard');
            } catch (retryErr) {
              console.warn('Clipboard retry on focus failed:', retryErr);
            }
          };
          window.addEventListener('focus', onFocusRetry, { once: true });
        } else {
          showToast('Failed to copy');
        }
      }
    }, 'image/png');
  }

  // Copy to Clipboard Button (PNG with flattened annotations)
  if (btnCopyClipboard) {
    btnCopyClipboard.addEventListener('click', () => copyToClipboard(false));
  }

  // Action Buttons
  if (btnSaveImage) {
    btnSaveImage.addEventListener('click', () => triggerImageDownload('png'));
  }

  // Dropdown Menu Toggle
  if (btnDropdownToggle && exportDropdownMenu) {
    btnDropdownToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdownMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      exportDropdownMenu.classList.add('hidden');
    });
  }

  if (btnSavePngOption) {
    btnSavePngOption.addEventListener('click', () => {
      if (exportDropdownMenu) exportDropdownMenu.classList.add('hidden');
      triggerImageDownload('png');
    });
  }

  if (btnSavePdfContinuous) {
    btnSavePdfContinuous.addEventListener('click', () => {
      if (exportDropdownMenu) exportDropdownMenu.classList.add('hidden');
      triggerContinuousPdfDownload();
    });
  }

  if (btnSavePdfA4) {
    btnSavePdfA4.addEventListener('click', () => {
      if (exportDropdownMenu) exportDropdownMenu.classList.add('hidden');
      triggerMultiPagePdfDownload();
    });
  }
});
