/**
 * Service Worker (Background) for Full Page Screenshot Extension
 * Handles high-speed pipelined full page capture, visible viewport capture, area crop, and storage management.
 */

let isCapturingActive = false;
let lastCaptureTimestamp = 0;

/**
 * Capture visible tab with rate limiting adhering strictly to Chromium quota (2 calls/sec)
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
 * Check if URL permits content scripting and screen capture
 */
function isSupportedUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return !(
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('brave://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('view-source:') ||
    lower.startsWith('devtools://') ||
    lower.includes('chromewebstore.google.com') ||
    lower.includes('chrome.google.com/webstore')
  );
}

/**
 * Ping tab to verify if content script is active and listening
 */
async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return res && res.status === 'ok';
  } catch (e) {
    return false;
  }
}

/**
 * Send message to tab with automatic retry on transient IPC handshake delays
 */
async function safeSendMessage(tabId, message, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      const isConnectionError = err && err.message && err.message.includes('Could not establish connection');
      if (isConnectionError && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 120));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Ensure content script and stylesheet are actively responding in target tab
 */
async function ensureContentScriptInjected(tabId) {
  // If content script is already alive and responding, proceed immediately
  if (await pingTab(tabId)) {
    return true;
  }

  // Inject stylesheet if not already injected
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
  } catch (e) {}

  // Inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  } catch (err) {
    console.warn('Script injection failed on tab:', tabId, err);
    throw new Error('Cannot capture this page. Extension scripting access is restricted on this URL.');
  }

  // Wait for content script message listener port to become ready (up to 1200ms)
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await pingTab(tabId)) {
      return true;
    }
  }

  throw new Error('Could not establish connection with content script on tab.');
}

/**
 * Capture complete webpage from top to bottom (Fast Pipelined Full Page Capture)
 */
async function captureFullPage(tab, options = {}) {
  if (isCapturingActive) {
    console.warn('Capture already in progress.');
    return { status: 'error', message: 'Capture already in progress.' };
  }

  isCapturingActive = true;
  const tabId = tab.id;

  const scrollDelayMs = typeof options.delayMs === 'number' ? options.delayMs : 150;
  const hideFixedElements = typeof options.hideFixedElements === 'boolean' ? options.hideFixedElements : true;
  const imageFormat = options.format === 'jpeg' ? 'jpeg' : 'png';
  const imageQuality = typeof options.quality === 'number' ? options.quality : 94;

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#007acc' });
    await chrome.action.setBadgeText({ tabId, text: '...' });
  } catch (e) {}

  try {
    await ensureContentScriptInjected(tabId);

    // Prepare page and measure scroller metrics
    const prepResponse = await safeSendMessage(tabId, {
      action: 'prepareCapture',
      hideFixedElements: hideFixedElements
    });

    if (!prepResponse || !prepResponse.metrics) {
      throw new Error('Failed to retrieve webpage dimensions.');
    }

    const metrics = prepResponse.metrics;
    const totalHeight = metrics.scrollHeight;
    const viewportHeight = Math.max(metrics.clientHeight, 100);
    const scrollStep = (metrics && typeof metrics.stepHeight === 'number' && metrics.stepHeight >= 150)
      ? metrics.stepHeight
      : viewportHeight;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);

    // Calculate vertical scroll step positions with precise bottom clamping
    const yPositions = [];
    let currentY = 0;
    while (currentY < maxScrollY) {
      yPositions.push(currentY);
      currentY += scrollStep;
    }
    if (yPositions.length === 0 || yPositions[yPositions.length - 1] < maxScrollY) {
      yPositions.push(maxScrollY);
    }

    const slices = [];
    const allLinks = [];
    const totalSlices = yPositions.length;

    for (let i = 0; i < totalSlices; i++) {
      const targetY = yPositions[i];
      const isFirstSlice = (i === 0);
      const isLastSlice = (i === totalSlices - 1);
      const percent = Math.round(((i + 1) / totalSlices) * 100);

      try {
        await chrome.action.setBadgeText({ tabId, text: `${percent}%` });
      } catch (e) {}

      // Scroll target scroller
      const scrollRes = await safeSendMessage(tabId, {
        action: 'scrollTo',
        y: targetY,
        isFirstSlice: isFirstSlice,
        isLastSlice: isLastSlice,
        hideFixedElements: hideFixedElements,
        delayMs: scrollDelayMs
      });

      const actualY = (scrollRes && scrollRes.scroll && typeof scrollRes.scroll.actualY === 'number')
        ? scrollRes.scroll.actualY
        : targetY;

      if (scrollRes && scrollRes.scroll && Array.isArray(scrollRes.scroll.links)) {
        allLinks.push(...scrollRes.scroll.links);
      }

      // Capture visible viewport slice
      const captureOpts = imageFormat === 'jpeg'
        ? { format: 'jpeg', quality: imageQuality }
        : { format: 'png' };

      const dataUrl = await safeCaptureVisibleTab(tab.windowId, captureOpts);

      slices.push({
        index: i,
        targetY: targetY,
        actualY: actualY,
        dataUrl: dataUrl
      });
    }

    // Restore page to original state
    try {
      await safeSendMessage(tabId, { action: 'restorePage' }, 1);
    } catch (e) {}

    try {
      await chrome.action.setBadgeText({ tabId, text: '' });
    } catch (e) {}

    // Deduplicate collected links across overlapping slice boundaries
    const deduplicatedLinks = [];
    for (const link of allLinks) {
      const isDup = deduplicatedLinks.some((item) => {
        return item.url === link.url &&
               Math.abs(item.x - link.x) <= 6 &&
               Math.abs(item.y - link.y) <= 6;
      });
      if (!isDup) {
        deduplicatedLinks.push(link);
      }
    }

    const finalLinks = (deduplicatedLinks.length > 0) ? deduplicatedLinks : ((metrics && metrics.links) || []);

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
      links: (metrics && metrics.links) && deduplicatedLinks.length === 0 ? metrics.links : finalLinks,
      title: tab.title || 'Screenshot',
      url: tab.url || '',
      format: imageFormat,
      quality: imageQuality
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
 * Runtime message listener
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureFullPage') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
      if (!activeTab) {
        sendResponse({ status: 'error', message: 'No active tab found.' });
        return;
      }
      captureFullPage(activeTab, request.options || {})
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ status: 'error', message: err.message }));
    }).catch((err) => {
      sendResponse({ status: 'error', message: err.message });
    });
    return true;
  }
});

/**
 * Direct extension icon click in browser toolbar (1-Click Screenshot)
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url || !isSupportedUrl(tab.url)) {
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
