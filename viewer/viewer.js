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

  // Inline Interactive Text Editor Elements
  const inlineTextEditor = document.getElementById('inlineTextEditor');
  const textEditorToolbar = document.getElementById('textEditorToolbar');
  const textDragHandle = document.getElementById('textDragHandle');
  const btnTextSizeDec = document.getElementById('btnTextSizeDec');
  const textSizeLabel = document.getElementById('textSizeLabel');
  const btnTextSizeInc = document.getElementById('btnTextSizeInc');
  const textColorPicker = document.getElementById('textColorPicker');
  const textColorDots = document.querySelectorAll('.text-color-dot');
  const btnTextConfirm = document.getElementById('btnTextConfirm');
  const btnTextDelete = document.getElementById('btnTextDelete');
  const textEditorInput = document.getElementById('textEditorInput');

  let currentZoom = 0.5;
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

  // Text Editor State
  let currentEditingAnnotationIndex = -1;
  let currentEditingOriginalItem = null;
  let currentEditingFontSize = 24;
  let currentEditingColor = '#ffffff';
  let isEditingText = false;

  // Extract Session ID from URL query parameters
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('id');

  if (!sessionId) {
    showError('Invalid screenshot session.');
    return;
  }

  try {
    let storageResult = {};
    if (window.chrome && chrome.storage && chrome.storage.local) {
      storageResult = await chrome.storage.local.get([sessionId]);
    } else if (window.sessionStorage && sessionStorage.getItem(sessionId)) {
      storageResult[sessionId] = JSON.parse(sessionStorage.getItem(sessionId));
    } else if (window.localStorage && localStorage.getItem(sessionId)) {
      storageResult[sessionId] = JSON.parse(localStorage.getItem(sessionId));
    }
    sessionData = storageResult[sessionId];

    if (!sessionData) {
      showError('Screenshot data not found or expired.');
      return;
    }

    // Set target webpage metadata with tooltip hover for truncated text
    if (pageTitle) {
      pageTitle.textContent = sessionData.title || 'Screenshot';
      pageTitle.title = sessionData.title || 'Screenshot';
    }
    if (pageUrl) {
      pageUrl.textContent = sessionData.url || '-';
      pageUrl.title = sessionData.url || '-';
    }
    document.title = `${sessionData.title || 'Screenshot'} - Full Page Screenshot`;

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

    // Set default preview zoom to 50%
    setZoom(0.5);
    workspace.scrollLeft = 0;
    workspace.scrollTop = 0;

    // Automatically copy screenshot to clipboard upon completion
    copyToClipboard(true);
  } catch (err) {
    console.error(err);
    showError('Failed to render screenshot: ' + err.message);
  }

  /**
   * Helper to check if a CSS color string represents a dark or light background
   */
  function isDarkColor(colorStr) {
    if (!colorStr) return true;
    if (colorStr.startsWith('#')) {
      const hex = colorStr.replace('#', '');
      const r = parseInt(hex.substr(0, 2), 16) || 0;
      const g = parseInt(hex.substr(2, 2), 16) || 0;
      const b = parseInt(hex.substr(4, 2), 16) || 0;
      return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }
    const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = parseInt(match[1], 10);
      const g = parseInt(match[2], 10);
      const b = parseInt(match[3], 10);
      return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }
    return true;
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
      loadingStatusText.textContent = 'Processing captured images...';
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
    const capturedWinH = (metrics && metrics.windowHeight) || (metrics && metrics.clientHeight) || firstImg.naturalHeight;
    const dpr = (metrics && metrics.devicePixelRatio) || (firstImg.naturalWidth / capturedWinW) || 1;
    const pageBgColor = (metrics && metrics.backgroundColor) || '#1f1f1f';

    const isPrimarySpaLayout = isContainer && cropRect && (
      (cropRect.width >= capturedWinW * 0.55 || cropRect.width + cropRect.x >= capturedWinW - 30) &&
      cropRect.height >= capturedWinH * 0.55
    );

    if (isPrimarySpaLayout) {
      // Full Application Frame stitching (Gemini, DeepSeek, ChatGPT, Claude, Twitch)
      const rawSx = Math.max(0, Math.round(cropRect.x * dpr));
      const detectedSidebarW = Math.round(((metrics && metrics.leftSidebarWidth) || 0) * dpr);
      const sx = detectedSidebarW > 0 ? detectedSidebarW : rawSx;
      const sy = Math.max(0, Math.round(cropRect.y * dpr));
      const sw = Math.min(firstImg.naturalWidth - sx, Math.round(cropRect.width * dpr));
      const sh = Math.min(firstImg.naturalHeight - sy, Math.round(cropRect.height * dpr));
      const pinnedHeaderH = Math.round(((metrics && metrics.pinnedHeaderHeight) || 0) * dpr);
      const isSpreadsheet = !!(metrics && metrics.isSpreadsheet);
      const spreadsheetStepH = (isSpreadsheet && metrics && metrics.stepHeight)
        ? Math.round(metrics.stepHeight * dpr)
        : null;

      let maxContainerReach = 0;
      if (spreadsheetStepH) {
        maxContainerReach = loadedImages.length * spreadsheetStepH;
      } else if (pinnedHeaderH > 0) {
        const effectiveSliceH = Math.max(1, sh - pinnedHeaderH);
        maxContainerReach = Math.max(
          ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + effectiveSliceH)
        ) + pinnedHeaderH;
      } else {
        maxContainerReach = Math.max(
          ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + sh)
        );
      }
      const bottomMargin = Math.max(0, firstImg.naturalHeight - (sy + sh));

      canvas.width = Math.round(firstImg.naturalWidth);
      canvas.height = sy + maxContainerReach + bottomMargin;

      ctx.fillStyle = pageBgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (loadingStatusText) {
        loadingStatusText.textContent = 'Assembling full page screenshot...';
      }

      // 1. Draw Slice 0 at (0, 0) - renders full window width, top header/toolbar, and sidebar head
      ctx.drawImage(firstImg, 0, 0);

      // 2. If left sidebar exists (sx > 0), extend its background cleanly down to canvas bottom
      if (sx > 0 && canvas.height > firstImg.naturalHeight) {
        let sidebarBg = (metrics && metrics.leftSidebarBgColor) || '';
        if (!sidebarBg || sidebarBg === 'transparent' || sidebarBg === 'rgba(0, 0, 0, 0)') {
          sidebarBg = pageBgColor;
        }
        let sidebarBorder = (metrics && metrics.leftSidebarBorderColor) || '';
        const sidebarBorderW = Math.max(1, Math.round(((metrics && metrics.leftSidebarBorderWidth) || 1) * dpr));
        if (!sidebarBorder || sidebarBorder === 'transparent' || sidebarBorder === 'rgba(0, 0, 0, 0)') {
          const isDark = isDarkColor(sidebarBg);
          sidebarBorder = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
        }

        const extendStartY = firstImg.naturalHeight - bottomMargin;
        const targetExtendH = canvas.height - extendStartY;

        if (targetExtendH > 0) {
          // Fill sidebar extension column with clean background color - NEVER stretch image strips
          ctx.fillStyle = sidebarBg;
          ctx.fillRect(0, extendStartY, sx, targetExtendH);

          // Draw clean continuous vertical divider line along the right edge of the sidebar
          ctx.fillStyle = sidebarBorder;
          ctx.fillRect(sx - sidebarBorderW, extendStartY, sidebarBorderW, targetExtendH);
        }
      }

      // 3. Draw container content for each slice at its true vertical position
      for (let i = 0; i < loadedImages.length; i++) {
        const { img, slice } = loadedImages[i];
        if (i === 0) {
          // Slice 0 content is already drawn by drawImage(firstImg, 0, 0)
          continue;
        }
        if (spreadsheetStepH) {
          // For spreadsheets, draw exactly one complete quantized step height at each slice seam
          const sliceSrcY = sy + pinnedHeaderH;
          const destinationY = sy + pinnedHeaderH + i * spreadsheetStepH;
          ctx.drawImage(img, sx, sliceSrcY, sw, spreadsheetStepH, sx, destinationY, sw, spreadsheetStepH);
        } else if (pinnedHeaderH > 0) {
          // For spreadsheets with frozen column headers, skip the duplicate header row in subsequent slices
          const sliceSrcY = sy + pinnedHeaderH;
          const sliceH = Math.max(1, sh - pinnedHeaderH);
          const destinationY = sy + pinnedHeaderH + Math.round(slice.actualY * dpr);
          ctx.drawImage(img, sx, sliceSrcY, sw, sliceH, sx, destinationY, sw, sliceH);
        } else {
          const destinationY = sy + Math.round(slice.actualY * dpr);
          ctx.drawImage(img, sx, sy, sw, sh, sx, destinationY, sw, sh);
        }
      }

      // 4. If bottom margin exists (e.g. docked composer outside scroller or sheet tabs), draw from last slice
      if (bottomMargin > 0) {
        const lastImg = loadedImages[loadedImages.length - 1].img;
        const bottomSrcY = firstImg.naturalHeight - bottomMargin;
        const bottomDestY = canvas.height - bottomMargin;
        ctx.drawImage(
          lastImg,
          0, bottomSrcY, firstImg.naturalWidth, bottomMargin,
          0, bottomDestY, firstImg.naturalWidth, bottomMargin
        );
      }
    } else if (isContainer && cropRect) {
      // Localized container mode (small embedded scrollers)
      const sx = Math.max(0, Math.round(cropRect.x * dpr));
      const sy = Math.max(0, Math.round(cropRect.y * dpr));
      const sw = Math.min(firstImg.naturalWidth - sx, Math.round(cropRect.width * dpr));
      const sh = Math.min(firstImg.naturalHeight - sy, Math.round(cropRect.height * dpr));
      const pinnedHeaderH = Math.round(((metrics && metrics.pinnedHeaderHeight) || 0) * dpr);

      if (pinnedHeaderH > 0) {
        const isSpreadsheet = !!(metrics && metrics.isSpreadsheet);
        const spreadsheetStepH = (isSpreadsheet && metrics && metrics.stepHeight)
          ? Math.round(metrics.stepHeight * dpr)
          : null;

        const effectiveSliceH = Math.max(1, sh - pinnedHeaderH);
        const containerStitchedHeight = spreadsheetStepH
          ? (loadedImages.length * spreadsheetStepH + pinnedHeaderH)
          : (Math.max(
              ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + effectiveSliceH)
            ) + pinnedHeaderH);

        canvas.width = sw;
        canvas.height = containerStitchedHeight;

        ctx.fillStyle = pageBgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (loadingStatusText) {
          loadingStatusText.textContent = 'Assembling full page screenshot...';
        }

        // Draw slice 0 with header
        ctx.drawImage(loadedImages[0].img, sx, sy, sw, sh, 0, 0, sw, sh);

        for (let i = 1; i < loadedImages.length; i++) {
          const { img, slice } = loadedImages[i];
          const sliceSrcY = sy + pinnedHeaderH;
          if (spreadsheetStepH) {
            const destinationY = pinnedHeaderH + i * spreadsheetStepH;
            ctx.drawImage(img, sx, sliceSrcY, sw, spreadsheetStepH, 0, destinationY, sw, spreadsheetStepH);
          } else {
            const sliceH = Math.max(1, sh - pinnedHeaderH);
            const destinationY = pinnedHeaderH + Math.round(slice.actualY * dpr);
            ctx.drawImage(img, sx, sliceSrcY, sw, sliceH, 0, destinationY, sw, sliceH);
          }
        }
      } else {
        const containerStitchedHeight = Math.max(
          ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + sh)
        );

        canvas.width = sw;
        canvas.height = containerStitchedHeight;

        ctx.fillStyle = pageBgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (loadingStatusText) {
          loadingStatusText.textContent = 'Assembling full page screenshot...';
        }

        for (const item of loadedImages) {
          const { img, slice } = item;
          const destinationY = Math.round(slice.actualY * dpr);
          ctx.drawImage(img, sx, sy, sw, sh, 0, destinationY, sw, sh);
        }
      }
    } else {
      // Standard full page mode (GitHub, Wikipedia, MDN, Instagram, Twitter/X, Kanban, etc.)
      const isWideHorizontal = loadedImages.some(
        (item) => item.slice && typeof item.slice.actualX === 'number' && item.slice.actualX > 0
      );
      const totalCanvasWidth = isWideHorizontal
        ? Math.max(
            ...loadedImages.map(
              (item) => Math.round(((item.slice && item.slice.actualX) || 0) * dpr) + firstImg.naturalWidth
            )
          )
        : Math.round(firstImg.naturalWidth);
      const maxReach = Math.max(
        ...loadedImages.map((item) => Math.round(item.slice.actualY * dpr) + firstImg.naturalHeight)
      );

      canvas.width = totalCanvasWidth;
      canvas.height = maxReach;

      ctx.fillStyle = pageBgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (loadingStatusText) {
        loadingStatusText.textContent = 'Assembling full page screenshot...';
      }

      if (isWideHorizontal) {
        // Render 2D matrix layout across rows and columns (e.g. Trello, Jira boards, wide tables)
        for (let i = 0; i < loadedImages.length; i++) {
          const { img, slice } = loadedImages[i];
          const destinationX = Math.round(((slice && slice.actualX) || 0) * dpr);
          const destinationY = Math.round(slice.actualY * dpr);
          ctx.drawImage(img, destinationX, destinationY);
        }
      } else {
        const leftSidebarW = Math.round(((metrics && metrics.leftSidebarWidth) || 0) * dpr);
        const bottomBarH = Math.round(((metrics && metrics.bottomBarHeight) || 0) * dpr);

        // 1. Draw Slice 0 in full at (0, 0)
        ctx.drawImage(firstImg, 0, 0);

        // 2. If a persistent left sidebar exists and canvas height exceeds viewport:
        // Extend the sidebar background and vertical divider line down to the bottom of the canvas
        if (leftSidebarW > 0 && canvas.height > firstImg.naturalHeight) {
          let sidebarBg = (metrics && metrics.leftSidebarBgColor) || '';
          if (!sidebarBg || sidebarBg === 'transparent' || sidebarBg === 'rgba(0, 0, 0, 0)') {
            sidebarBg = pageBgColor;
          }
          let sidebarBorder = (metrics && metrics.leftSidebarBorderColor) || '';
          const sidebarBorderW = Math.max(1, Math.round(((metrics && metrics.leftSidebarBorderWidth) || 1) * dpr));
          if (!sidebarBorder || sidebarBorder === 'transparent' || sidebarBorder === 'rgba(0, 0, 0, 0)') {
            const isDark = isDarkColor(sidebarBg);
            sidebarBorder = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
          }

          const extendStartY = firstImg.naturalHeight - bottomBarH;
          const targetExtendH = canvas.height - extendStartY;

          if (targetExtendH > 0) {
            // Fill sidebar extension column with clean background color - NEVER stretch image strips
            ctx.fillStyle = sidebarBg;
            ctx.fillRect(0, extendStartY, leftSidebarW, targetExtendH);

            // Draw clean continuous vertical divider line along the right edge of the sidebar
            ctx.fillStyle = sidebarBorder;
            ctx.fillRect(leftSidebarW - sidebarBorderW, extendStartY, sidebarBorderW, targetExtendH);
          }
        }

        // 3. Draw remaining slices
        for (let i = 0; i < loadedImages.length; i++) {
          const { img, slice } = loadedImages[i];
          const destinationY = Math.round(slice.actualY * dpr);

          if (leftSidebarW > 0) {
            if (i === 0) {
              // Slice 0 was already drawn in full above
              continue;
            }
            // For slices 1..N, draw ONLY the content area to the right of the sidebar
            // so the extended sidebar background and vertical divider line are preserved!
            const contentW = firstImg.naturalWidth - leftSidebarW;
            ctx.drawImage(
              img,
              leftSidebarW, 0, contentW, firstImg.naturalHeight,
              leftSidebarW, destinationY, contentW, firstImg.naturalHeight
            );
          } else {
            ctx.drawImage(img, 0, destinationY);
          }
        }

        // 4. If bottom bar exists (docked composer / disclaimer / cookie bar), draw from last slice
        if (bottomBarH > 0 && loadedImages.length > 1) {
          const lastImg = loadedImages[loadedImages.length - 1].img;
          const bottomSrcY = firstImg.naturalHeight - bottomBarH;
          const bottomDestY = canvas.height - bottomBarH;
          ctx.drawImage(
            lastImg,
            0, bottomSrcY, firstImg.naturalWidth, bottomBarH,
            0, bottomDestY, firstImg.naturalWidth, bottomBarH
          );
        }
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

  let toastTimer = null;
  function showToast(message, duration = 1200) {
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
      toastTimer = null;
    }, duration);
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
    if (isEditingText && inlineTextEditor && !inlineTextEditor.classList.contains('hidden')) {
      updateToolbarPosition(parseFloat(inlineTextEditor.style.top) || 0);
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
    if (activeTool !== tool && isEditingText) {
      commitActiveTextEditor();
    }
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
      if (isEditingText) {
        updateEditingTextColor(activeColor);
      }
    });
  });

  // Stroke width selection
  strokeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      strokeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeStrokeWidth = parseInt(btn.dataset.size, 10);
      if (isEditingText) {
        const sizeMap = { 2: 16, 4: 24, 8: 36 };
        updateEditingTextSize(sizeMap[activeStrokeWidth] || 24);
      }
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
        annoCtx.font = `bold ${item.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const lines = String(item.text || '').split('\n');
        const lineHeight = Math.round(item.fontSize * 1.25);

        // Draw pure font lines with selected color (zero background box, zero corners)
        annoCtx.fillStyle = item.color;
        annoCtx.textBaseline = 'alphabetic';
        for (let i = 0; i < lines.length; i++) {
          annoCtx.fillText(lines[i], item.x, item.y + i * lineHeight);
        }
      }
    }
  }

  // Text Annotation Geometry & Hit-Testing
  function getTextAnnotationBounds(item) {
    annoCtx.font = `bold ${item.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const lines = String(item.text || '').split('\n');
    const lineHeight = Math.round(item.fontSize * 1.25);
    let maxW = 0;
    for (const line of lines) {
      const m = annoCtx.measureText(line || ' ');
      if (m.width > maxW) maxW = m.width;
    }
    const totalTextH = Math.max(item.fontSize, lines.length * lineHeight);
    const hitMargin = 6;
    return {
      x: item.x - hitMargin,
      y: item.y - item.fontSize - hitMargin + 4,
      width: maxW + hitMargin * 2,
      height: totalTextH + hitMargin * 2
    };
  }

  function findTextAnnotationAt(coords) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const item = annotations[i];
      if (item.type === 'text') {
        const b = getTextAnnotationBounds(item);
        if (
          coords.x >= b.x &&
          coords.x <= b.x + b.width &&
          coords.y >= b.y &&
          coords.y <= b.y + b.height
        ) {
          return { item, index: i, bounds: b };
        }
      }
    }
    return null;
  }

  // Interactive Text Editor Engine
  function autoResizeTextEditor() {
    if (!textEditorInput) return;
    textEditorInput.style.width = 'auto';
    textEditorInput.style.height = 'auto';

    const lines = textEditorInput.value.split('\n');
    annoCtx.font = `bold ${currentEditingFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    let maxW = 0;
    for (const line of lines) {
      const m = annoCtx.measureText(line || ' ');
      if (m.width > maxW) maxW = m.width;
    }
    if (!textEditorInput.value) {
      const pw = annoCtx.measureText(textEditorInput.placeholder || 'Type text...').width;
      maxW = Math.max(maxW, pw);
    }
    const padding = 4;
    const targetW = Math.max(80, Math.ceil(maxW + padding * 2 + 16));
    const lineHeight = Math.round(currentEditingFontSize * 1.25);
    const targetH = Math.max(lineHeight + padding * 2, textEditorInput.scrollHeight);

    textEditorInput.style.width = `${targetW}px`;
    textEditorInput.style.height = `${targetH}px`;
  }

  let lastTextEditorOpenTime = 0;

  function updateToolbarPosition(badgeTop) {
    if (!textEditorToolbar) return;
    const invScale = currentZoom > 0 ? (1 / currentZoom) : 1;
    if (badgeTop < 45) {
      textEditorToolbar.classList.add('toolbar-bottom');
      textEditorToolbar.style.transform = `scale(${invScale})`;
      textEditorToolbar.style.transformOrigin = '0 0';
    } else {
      textEditorToolbar.classList.remove('toolbar-bottom');
      textEditorToolbar.style.transform = `scale(${invScale})`;
      textEditorToolbar.style.transformOrigin = '0 100%';
    }
  }

  function updateEditorVisuals() {
    if (!inlineTextEditor || !textEditorInput) return;
    textEditorInput.style.fontSize = `${currentEditingFontSize}px`;
    textEditorInput.style.color = currentEditingColor;
    if (textSizeLabel) {
      textSizeLabel.textContent = `${currentEditingFontSize}px`;
    }
    if (textColorDots) {
      textColorDots.forEach((dot) => {
        if (dot.dataset && dot.dataset.color && dot.dataset.color.toLowerCase() === currentEditingColor.toLowerCase()) {
          dot.classList.add('active');
        } else {
          dot.classList.remove('active');
        }
      });
    }
    autoResizeTextEditor();
  }

  function updateEditingTextColor(color) {
    currentEditingColor = color;
    updateEditorVisuals();
  }

  function updateEditingTextSize(size) {
    currentEditingFontSize = Math.max(12, Math.min(96, size));
    updateEditorVisuals();
  }

  function openTextEditor(x, y, existingItem = null, existingIndex = -1) {
    if (isEditingText) {
      commitActiveTextEditor(true);
    }
    isEditingText = true;
    lastTextEditorOpenTime = Date.now();

    if (existingItem) {
      currentEditingAnnotationIndex = existingIndex;
      currentEditingOriginalItem = { ...existingItem };
      currentEditingFontSize = existingItem.fontSize || 24;
      currentEditingColor = existingItem.color || '#ffffff';

      // Temporarily remove from annotations so canvas renders clean underneath
      annotations.splice(existingIndex, 1);
      redrawAnnotations();

      const padding = 4;
      const editorLeft = existingItem.x - padding;
      const editorTop = existingItem.y - currentEditingFontSize - padding + 4;
      inlineTextEditor.style.left = `${Math.max(0, Math.round(editorLeft))}px`;
      inlineTextEditor.style.top = `${Math.max(0, Math.round(editorTop))}px`;
      updateToolbarPosition(editorTop);

      textEditorInput.value = existingItem.text || '';
    } else {
      currentEditingAnnotationIndex = -1;
      currentEditingOriginalItem = null;

      const sizeMap = { 2: 16, 4: 24, 8: 36 };
      currentEditingFontSize = sizeMap[activeStrokeWidth] || 24;
      currentEditingColor = activeColor || '#ffffff';

      const padding = 4;
      const editorLeft = x - padding;
      const editorTop = y - padding + 4;
      inlineTextEditor.style.left = `${Math.max(0, Math.round(editorLeft))}px`;
      inlineTextEditor.style.top = `${Math.max(0, Math.round(editorTop))}px`;
      updateToolbarPosition(editorTop);

      textEditorInput.value = '';
    }

    inlineTextEditor.classList.remove('hidden');
    updateEditorVisuals();

    setTimeout(() => {
      if (textEditorInput) {
        textEditorInput.focus();
        if (existingItem) {
          textEditorInput.select();
        }
      }
    }, 10);
  }

  function commitActiveTextEditor(force = false) {
    if (!isEditingText || !inlineTextEditor || inlineTextEditor.classList.contains('hidden')) return;
    if (!force && Date.now() - lastTextEditorOpenTime < 250) return;

    const val = textEditorInput.value.trim();
    if (val) {
      const padding = 4;
      const left = parseFloat(inlineTextEditor.style.left) || 0;
      const top = parseFloat(inlineTextEditor.style.top) || 0;
      const newX = left + padding;
      const newY = top + currentEditingFontSize + padding - 4;

      const newItem = {
        type: 'text',
        x: newX,
        y: newY,
        text: val,
        color: currentEditingColor,
        fontSize: currentEditingFontSize
      };

      if (currentEditingAnnotationIndex >= 0 && currentEditingAnnotationIndex <= annotations.length) {
        annotations.splice(currentEditingAnnotationIndex, 0, newItem);
      } else {
        annotations.push(newItem);
      }
    }

    inlineTextEditor.classList.add('hidden');
    isEditingText = false;
    currentEditingAnnotationIndex = -1;
    currentEditingOriginalItem = null;
    redrawAnnotations();
  }

  function cancelActiveTextEditor() {
    if (!isEditingText || !inlineTextEditor || inlineTextEditor.classList.contains('hidden')) return;

    if (currentEditingOriginalItem) {
      if (currentEditingAnnotationIndex >= 0 && currentEditingAnnotationIndex <= annotations.length) {
        annotations.splice(currentEditingAnnotationIndex, 0, currentEditingOriginalItem);
      } else {
        annotations.push(currentEditingOriginalItem);
      }
    }

    inlineTextEditor.classList.add('hidden');
    isEditingText = false;
    currentEditingAnnotationIndex = -1;
    currentEditingOriginalItem = null;
    redrawAnnotations();
  }

  function deleteActiveTextEditor() {
    if (!isEditingText || !inlineTextEditor || inlineTextEditor.classList.contains('hidden')) return;

    inlineTextEditor.classList.add('hidden');
    isEditingText = false;
    currentEditingAnnotationIndex = -1;
    currentEditingOriginalItem = null;
    redrawAnnotations();
    showToast('Text annotation deleted');
  }

  // Inline Text Editor Controls Listeners
  if (btnTextSizeInc) {
    btnTextSizeInc.addEventListener('mousedown', (e) => e.preventDefault());
    btnTextSizeInc.addEventListener('click', (e) => {
      e.stopPropagation();
      updateEditingTextSize(currentEditingFontSize + 4);
    });
  }

  if (btnTextSizeDec) {
    btnTextSizeDec.addEventListener('mousedown', (e) => e.preventDefault());
    btnTextSizeDec.addEventListener('click', (e) => {
      e.stopPropagation();
      updateEditingTextSize(currentEditingFontSize - 4);
    });
  }

  if (btnTextConfirm) {
    btnTextConfirm.addEventListener('click', (e) => {
      e.stopPropagation();
      commitActiveTextEditor(true);
    });
  }

  if (btnTextDelete) {
    btnTextDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteActiveTextEditor();
    });
  }

  if (textColorDots) {
    textColorDots.forEach((dot) => {
      dot.addEventListener('mousedown', (e) => e.preventDefault());
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        updateEditingTextColor(dot.dataset.color);
      });
    });
  }

  if (textEditorInput) {
    textEditorInput.addEventListener('input', autoResizeTextEditor);
    textEditorInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitActiveTextEditor(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelActiveTextEditor();
      }
    });
  }

  // Drag text editor to reposition
  let isDraggingTextEditor = false;
  let dragEditorStartX = 0;
  let dragEditorStartY = 0;
  let initialBadgeLeft = 0;
  let initialBadgeTop = 0;

  if (textDragHandle) {
    textDragHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDraggingTextEditor = true;
      dragEditorStartX = e.clientX;
      dragEditorStartY = e.clientY;
      initialBadgeLeft = parseFloat(inlineTextEditor.style.left) || 0;
      initialBadgeTop = parseFloat(inlineTextEditor.style.top) || 0;
      document.body.style.cursor = 'grabbing';
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingTextEditor) return;
    const dx = (e.clientX - dragEditorStartX) / currentZoom;
    const dy = (e.clientY - dragEditorStartY) / currentZoom;
    const newLeft = Math.max(0, Math.min(canvas.width - 50, initialBadgeLeft + dx));
    const newTop = Math.max(0, Math.min(canvas.height - 30, initialBadgeTop + dy));
    inlineTextEditor.style.left = `${newLeft}px`;
    inlineTextEditor.style.top = `${newTop}px`;
    updateToolbarPosition(newTop);
  });

  window.addEventListener('mouseup', () => {
    if (isDraggingTextEditor) {
      isDraggingTextEditor = false;
      document.body.style.cursor = '';
    }
  });

  if (inlineTextEditor) {
    inlineTextEditor.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
  }

  // Click outside text editor commits changes
  window.addEventListener('mousedown', (e) => {
    if (!isEditingText) return;
    if (Date.now() - lastTextEditorOpenTime < 250) return;
    if (inlineTextEditor && (inlineTextEditor.contains(e.target) || e.target === inlineTextEditor)) return;
    if (e.target === annoCanvas) return;
    if (e.target && e.target.closest && (e.target.closest('#annotationToolbar') || e.target.closest('.view-controls') || e.target.closest('.action-controls'))) return;
    commitActiveTextEditor(true);
  });

  // Panning state for Select mode or middle-click drag
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let scrollStartX = 0;
  let scrollStartY = 0;

  // Mouse Interaction on Annotation Canvas
  annoCanvas.addEventListener('mousedown', (e) => {
    if (inlineTextEditor && inlineTextEditor.contains(e.target)) return;

    const coords = getCanvasCoords(e);

    // 1. Text tool interaction: direct interactive click or edit existing
    if (activeTool === 'text' && e.button === 0) {
      e.stopPropagation();
      const hit = findTextAnnotationAt(coords);
      if (hit) {
        openTextEditor(coords.x, coords.y, hit.item, hit.index);
        return;
      }
      openTextEditor(coords.x, coords.y);
      return;
    }

    // 2. Select tool interaction: click on text to edit
    if (activeTool === 'select' && e.button === 0) {
      const hit = findTextAnnotationAt(coords);
      if (hit) {
        e.stopPropagation();
        openTextEditor(coords.x, coords.y, hit.item, hit.index);
        return;
      }
    }

    // Commit any active text editor if clicking canvas with another tool or empty space
    if (isEditingText) {
      commitActiveTextEditor(true);
    }

    if (activeTool === 'select' || e.button === 1) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = workspace.scrollLeft;
      scrollStartY = workspace.scrollTop;
      annoCanvas.style.cursor = 'grabbing';
      return;
    }

    isDrawing = true;
    startX = coords.x;
    startY = coords.y;

    if (activeTool === 'pen') {
      currentPath = [{ x: startX, y: startY }];
    }
  });

  annoCanvas.addEventListener('dblclick', (e) => {
    const coords = getCanvasCoords(e);
    const hit = findTextAnnotationAt(coords);
    if (hit) {
      openTextEditor(coords.x, coords.y, hit.item, hit.index);
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      workspace.scrollLeft = scrollStartX - (e.clientX - panStartX);
      workspace.scrollTop = scrollStartY - (e.clientY - panStartY);
      return;
    }

    const coords = getCanvasCoords(e);

    // Dynamic hover cursor over text annotations
    if (!isDrawing && (activeTool === 'text' || activeTool === 'select')) {
      const hit = findTextAnnotationAt(coords);
      if (hit) {
        annoCanvas.style.cursor = 'pointer';
        return;
      }
      annoCanvas.style.cursor = activeTool === 'select' ? 'grab' : 'text';
    }

    if (!isDrawing) return;

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
    if (isEditingText) {
      cancelActiveTextEditor();
      return;
    }
    if (annotations.length > 0) {
      annotations.pop();
      redrawAnnotations();
      showToast('Undo annotation');
    }
  }

  if (btnUndo) btnUndo.addEventListener('click', undoLastAnnotation);

  if (btnClearAnno) {
    btnClearAnno.addEventListener('click', () => {
      if (isEditingText) {
        cancelActiveTextEditor();
      }
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
    if (isEditingText) {
      commitActiveTextEditor();
    }
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
