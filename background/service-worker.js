/**
 * Service Worker (Background) for Full Page Screenshot Extension
 * Handles high-speed 1-click full page capture with pipelined rate limiting and storage cleanup.
 */

let isCapturingActive = false;
let lastCaptureTimestamp = 0;

/**
 * Capture visible tab with optimized 520ms interval (maximum theoretical throughput under Chromium's 2 calls/sec quota)
 */
async function safeCaptureVisibleTab(windowId, options = { format: 'png' }, maxRetries = 4) {
  const MIN_CAPTURE_INTERVAL_MS = 520; // 520ms enforces ~1.92 calls/sec, strictly compliant with 2 calls/sec limit

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const now = Date.now();
    const timeSinceLast = now - lastCaptureTimestamp;

    if (timeSinceLast < MIN_CAPTURE_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_CAPTURE_INTERVAL_MS - timeSinceLast));
    }

    try {
      lastCaptureTimestamp = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      return dataUrl;
    } catch (err) {
      const isQuotaError = err && err.message && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      if (isQuotaError && attempt < maxRetries - 1) {
        const backoffWait = 650 + attempt * 300;
        console.warn(`Rate-limit backoff ${backoffWait}ms (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, backoffWait));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Failed to capture screen: rate limit exceeded.');
}

/**
 * Clean up screenshot sessions older than 24 hours
 */
async function cleanupExpiredSessions() {
  try {
    const allData = await chrome.storage.local.get(null);
    const now = Date.now();
    const expiredKeys = [];
    const maxAgeMs = 24 * 60 * 60 * 1000;

    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith('session_')) {
        const parts = key.split('_');
        const timestamp = parseInt(parts[1], 10);
        if (!isNaN(timestamp) && (now - timestamp > maxAgeMs)) {
          expiredKeys.push(key);
        }
      }
    }

    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
      console.log(`Cleaned up ${expiredKeys.length} expired screenshot session(s).`);
    }
  } catch (err) {
    console.warn('Garbage collection error:', err);
  }
}

// Initial storage cleanup
cleanupExpiredSessions();

/**
 * Ensure content script and stylesheet are injected into target tab
 */
async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
  } catch (e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  } catch (e) {}
}

/**
 * Capture complete webpage from top to bottom (Fast Pipelined Full Page Capture)
 */
async function captureFullPage(tab) {
  if (isCapturingActive) {
    console.warn('Capture already in progress.');
    return;
  }

  isCapturingActive = true;
  const tabId = tab.id;

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#007acc' });
    await chrome.action.setBadgeText({ tabId, text: '...' });
  } catch (e) {}

  try {
    await ensureContentScriptInjected(tabId);

    const hideFixedElements = true;
    const scrollDelayMs = 120; // Fast 120ms scroll repaint delay

    // Prepare page and measure scroller metrics
    const prepResponse = await chrome.tabs.sendMessage(tabId, {
      action: 'prepareCapture',
      hideFixedElements: hideFixedElements
    });

    if (!prepResponse || !prepResponse.metrics) {
      throw new Error('Failed to retrieve webpage dimensions.');
    }

    const metrics = prepResponse.metrics;
    const totalHeight = metrics.scrollHeight;
    const viewportHeight = Math.max(metrics.clientHeight, 100);

    // Calculate vertical scroll step positions
    const yPositions = [];
    let currentY = 0;
    while (currentY < totalHeight) {
      yPositions.push(currentY);
      currentY += viewportHeight;
    }
    const maxY = Math.max(0, totalHeight - viewportHeight);
    if (yPositions.length === 0 || yPositions[yPositions.length - 1] < maxY) {
      yPositions.push(maxY);
    }

    const slices = [];
    const totalSlices = yPositions.length;

    for (let i = 0; i < totalSlices; i++) {
      const targetY = yPositions[i];
      const isFirstSlice = (i === 0);
      const percent = Math.round(((i + 1) / totalSlices) * 100);

      try {
        await chrome.action.setBadgeText({ tabId, text: `${percent}%` });
      } catch (e) {}

      // Scroll target scroller (fast 120ms delay)
      const scrollRes = await chrome.tabs.sendMessage(tabId, {
        action: 'scrollTo',
        y: targetY,
        isFirstSlice: isFirstSlice,
        hideFixedElements: hideFixedElements,
        delayMs: scrollDelayMs
      });

      const actualY = (scrollRes && scrollRes.scroll && typeof scrollRes.scroll.actualY === 'number')
        ? scrollRes.scroll.actualY
        : targetY;

      // Capture visible viewport slice with pipelined 520ms interval
      const dataUrl = await safeCaptureVisibleTab(tab.windowId, { format: 'png' });

      slices.push({
        index: i,
        targetY: targetY,
        actualY: actualY,
        dataUrl: dataUrl
      });
    }

    // Restore page to original state
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'restorePage' });
    } catch (e) {}

    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch (e) {}

    // Store session and open viewer tab
    const now = Date.now();
    const sessionId = 'session_' + now + '_' + Math.random().toString(36).substr(2, 9);
    const sessionData = {
      type: 'fullpage',
      isContainer: metrics.isContainer || false,
      cropRect: metrics.cropRect,
      createdAt: now,
      slices: slices,
      metrics: metrics,
      title: tab.title || 'Full Page Screenshoot',
      url: tab.url || '',
      format: 'png',
      quality: 94
    };

    await chrome.storage.local.set({ [sessionId]: sessionData });
    const viewerUrl = chrome.runtime.getURL(`viewer/viewer.html?id=${sessionId}`);
    await chrome.tabs.create({ url: viewerUrl });

    cleanupExpiredSessions();
    return { status: 'success', sessionId };
  } finally {
    isCapturingActive = false;
  }
}

/**
 * Handle direct extension icon click in browser toolbar (1-Click Screenshot)
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://')) {
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: 'X' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#ef4444' });
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      }, 2500);
    } catch (e) {}
    return;
  }

  try {
    await captureFullPage(tab);
  } catch (err) {
    console.error('Error during full page capture:', err);
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#ef4444' });
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      }, 3000);
    } catch (e) {}
  }
});
