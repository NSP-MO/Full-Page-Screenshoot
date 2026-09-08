/**
 * Content Script for Full Page Screenshot Extension
 * Handles standard webpage scrolling and internal SPA containers (DeepSeek, Twitch, ChatGPT, Google Docs, Notion, etc.)
 */

(function () {
  let activeScroller = null;
  let originalScrollY = 0;
  let originalScrollBehavior = '';
  let hiddenFixedElements = [];
  let cachedFixedHeaders = [];
  let cachedFixedFooters = [];
  let cachedFloatingWidgets = [];
  let unhitchedStickyElements = [];

  /**
   * Determine the effective background color of an element or the document
   */
  function getEffectiveBackgroundColor(el) {
    let cur = el;
    while (cur && cur !== document && cur !== document.documentElement) {
      const style = window.getComputedStyle(cur);
      const bg = style.backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        return bg;
      }
      cur = cur.parentElement;
    }
    if (document.body) {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      if (bodyBg && bodyBg !== 'transparent' && bodyBg !== 'rgba(0, 0, 0, 0)') {
        return bodyBg;
      }
    }
    const docBg = window.getComputedStyle(document.documentElement).backgroundColor;
    if (docBg && docBg !== 'transparent' && docBg !== 'rgba(0, 0, 0, 0)') {
      return docBg;
    }
    return '#1f1f1f'; // Clean dark modern fallback
  }

  /**
   * Universal primary scroller detection: accurately handles SPAs (DeepSeek, Twitch, ChatGPT, etc.)
   * and standard window-scrolling pages.
   */
  function detectPrimaryScroller() {
    const winW = window.innerWidth || document.documentElement.clientWidth;
    const winH = window.innerHeight || document.documentElement.clientHeight;

    // 1. High-priority targeted selectors for well-known complex SPAs
    const knownSelectors = [
      // DeepSeek chat container
      '.ds-chat-message-list',
      'main div[class*="overflow-y-auto"]',
      'div[class*="chat-message-container"]',
      // Twitch root scroller
      '[data-a-target="root-scroller"]',
      '.root-scrollable',
      '[data-test-selector="root-scroller"]',
      // ChatGPT conversation scroller
      'div[class*="react-scroll-to-bottom"]',
      // Google Docs canvas container
      '.kix-appview-editor',
      '.goog-scrollable-container',
      // Notion page scroller
      '.notion-scroller'
    ];

    for (const selector of knownSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const style = window.getComputedStyle(el);
          const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
                            (el.scrollHeight > el.clientHeight + 40);
          const rect = el.getBoundingClientRect();
          if (canScroll && rect.width > winW * 0.35 && rect.height > winH * 0.35) {
            return {
              element: el,
              isWindow: false,
              name: `Known SPA Scroller (${selector})`
            };
          }
        }
      } catch (e) {}
    }

    // 2. Evaluate window scrollability
    const doc = document.documentElement;
    const body = document.body;
    const docStyle = window.getComputedStyle(doc);
    const bodyStyle = body ? window.getComputedStyle(body) : null;
    const docOverflowY = docStyle.overflowY;
    const bodyOverflowY = bodyStyle ? bodyStyle.overflowY : '';

    const isDocOverflowHidden = (docOverflowY === 'hidden' || docOverflowY === 'clip');
    const isBodyOverflowHidden = (bodyOverflowY === 'hidden' || bodyOverflowY === 'clip');

    let windowCanScroll = false;
    const docScrollH = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.offsetHeight,
      body ? body.offsetHeight : 0
    );

    if (!isDocOverflowHidden && !(isBodyOverflowHidden && bodyStyle && bodyStyle.height === '100%')) {
      const currentScroll = window.scrollY || doc.scrollTop || (body ? body.scrollTop : 0);
      if (currentScroll > 0) {
        windowCanScroll = true;
      } else if (docScrollH > winH + 40) {
        // Probe test: test 2px scroll displacement
        window.scrollTo({ top: 2, behavior: 'instant' });
        const probeScroll = window.scrollY || doc.scrollTop || (body ? body.scrollTop : 0);
        window.scrollTo({ top: currentScroll, behavior: 'instant' });
        if (probeScroll > 0) {
          windowCanScroll = true;
        }
      }
    }

    // 3. Scan DOM for internal scrollable containers (SPAs, chat lists, feeds)
    const candidates = document.querySelectorAll('div, main, section, article');
    let bestEl = null;
    let bestScore = -1;

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.id && el.id.startsWith('fps-')) continue;

      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        const scrollDiff = el.scrollHeight - el.clientHeight;
        if (scrollDiff > 40) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 220 && rect.height > 160 &&
              rect.top < winH && rect.bottom > 0 &&
              rect.left < winW && rect.right > 0 &&
              style.display !== 'none' && style.visibility !== 'hidden') {

            const areaFraction = (rect.width * rect.height) / (winW * winH);
            let score = scrollDiff * Math.pow(areaFraction, 1.5);

            // Semantic boost for primary layout containers
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
            const id = (typeof el.id === 'string' ? el.id : '').toLowerCase();

            if (tag === 'main' || role === 'main' || className.includes('main') || id.includes('main')) {
              score *= 2.2;
            }
            if (className.includes('chat') || className.includes('message') || className.includes('conversation') ||
                className.includes('stream') || className.includes('content') || className.includes('editor')) {
              score *= 1.8;
            }

            // Narrow edge penalty (heavily down-weight sidebar chat lists or channel lists)
            if (rect.width < winW * 0.32 && (rect.left <= 15 || rect.right >= winW - 15)) {
              score *= 0.12;
            }

            if (score > bestScore) {
              bestScore = score;
              bestEl = el;
            }
          }
        }
      }
    }

    // 4. Decision: compare window vs internal container
    if (bestEl) {
      const bestRect = bestEl.getBoundingClientRect();
      const bestAreaFraction = (bestRect.width * bestRect.height) / (winW * winH);

      // If window cannot scroll or container is the dominant scroll surface
      if (!windowCanScroll || (bestAreaFraction > 0.45 && bestEl.scrollHeight > winH * 1.3)) {
        return {
          element: bestEl,
          isWindow: false,
          name: 'Internal Container Scroller'
        };
      }
    }

    if (windowCanScroll || docScrollH > winH + 40) {
      return {
        element: window,
        isWindow: true,
        name: 'Window Document Scroller'
      };
    }

    // Fallback: return best internal element or window
    return bestEl ? { element: bestEl, isWindow: false, name: 'Internal Fallback' }
                  : { element: window, isWindow: true, name: 'Window Default' };
  }

  /**
   * Get accurate metrics for the target scroller
   */
  function getMetrics() {
    const scrollerInfo = detectPrimaryScroller();
    activeScroller = scrollerInfo;

    const dpr = window.devicePixelRatio || 1;
    const winW = window.innerWidth || document.documentElement.clientWidth;
    const winH = window.innerHeight || document.documentElement.clientHeight;

    if (scrollerInfo.isWindow) {
      const doc = document.documentElement;
      const body = document.body;
      const scrollHeight = Math.max(
        doc.scrollHeight,
        body ? body.scrollHeight : 0,
        doc.offsetHeight,
        body ? body.offsetHeight : 0,
        doc.clientHeight
      );
      const scrollWidth = Math.max(
        doc.scrollWidth,
        body ? body.scrollWidth : 0,
        doc.offsetWidth,
        body ? body.offsetWidth : 0,
        doc.clientWidth
      );

      return {
        isContainer: false,
        scrollHeight,
        scrollWidth,
        clientHeight: winH,
        clientWidth: winW,
        windowWidth: winW,
        windowHeight: winH,
        devicePixelRatio: dpr,
        backgroundColor: getEffectiveBackgroundColor(body || doc),
        title: document.title || 'Screenshoot',
        url: window.location.href,
        cropRect: {
          x: 0,
          y: 0,
          width: winW,
          height: winH
        }
      };
    } else {
      const el = scrollerInfo.element;
      const rect = el.getBoundingClientRect();

      const cropX = Math.max(0, Math.round(rect.left));
      const cropY = Math.max(0, Math.round(rect.top));
      const cropW = Math.min(winW - cropX, Math.round(rect.width));
      const cropH = Math.min(winH - cropY, Math.round(rect.height));

      return {
        isContainer: true,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        windowWidth: winW,
        windowHeight: winH,
        devicePixelRatio: dpr,
        backgroundColor: getEffectiveBackgroundColor(el),
        title: document.title || 'Screenshoot',
        url: window.location.href,
        cropRect: {
          x: cropX,
          y: cropY,
          width: cropW,
          height: cropH
        }
      };
    }
  }

  /**
   * Find, classify, and cache floating/fixed/sticky elements to eliminate repetition across slices.
   * Un-hitches sticky elements (thinking process headers, code headers) to relative flow,
   * hides transient floating buttons (scroll-to-bottom), keeps top headers on slice 0 only,
   * and suppresses bottom input prompt bars on intermediate slices.
   */
  function findAndCacheFixedElements() {
    hiddenFixedElements = [];
    cachedFixedHeaders = [];
    cachedFixedFooters = [];
    cachedFloatingWidgets = [];
    unhitchedStickyElements = [];

    const winW = window.innerWidth || document.documentElement.clientWidth;
    const winH = window.innerHeight || document.documentElement.clientHeight;

    // Scan the entire document so fixed elements outside container scrollers are discovered
    const allElements = document.querySelectorAll('*');

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (el.id && el.id.startsWith('fps-')) continue;

      const style = window.getComputedStyle(el);
      const position = style.position;
      const display = style.display;
      const visibility = style.visibility;

      if (display === 'none' || visibility === 'hidden') continue;

      // 1. Un-hitch position: sticky elements so they flow naturally with their message/section
      if (position === 'sticky') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          unhitchedStickyElements.push({
            element: el,
            originalPosition: el.style.position
          });
          el.style.setProperty('position', 'relative', 'important');
        }
        continue;
      }

      // 2. Fixed elements (and absolute bottom-docked overlays)
      if (position === 'fixed' || (position === 'absolute' && el.parentElement === document.body)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const id = (typeof el.id === 'string' ? el.id : '').toLowerCase();

        // 2a. Floating Action Buttons / Transient Controls (Scroll to bottom, quick prompts, jump buttons)
        const isFloatingControl =
          (rect.width < 110 && rect.height < 110 && (rect.left > winW * 0.4 || rect.top > winH * 0.5)) ||
          className.includes('scroll-to-bottom') ||
          className.includes('scroll-bottom') ||
          className.includes('back-to-bottom') ||
          className.includes('jump-to-bottom') ||
          ariaLabel.includes('scroll to bottom') ||
          ariaLabel.includes('bottom') ||
          id.includes('scroll-bottom');

        const record = {
          element: el,
          originalVisibility: el.style.visibility
        };

        if (isFloatingControl) {
          cachedFloatingWidgets.push(record);
          hiddenFixedElements.push(record);
          el.style.setProperty('visibility', 'hidden', 'important');
          continue;
        }

        // 2b. Fixed Top Headers (Visible ONLY on slice 0)
        if (rect.top <= 35 && rect.height < winH * 0.35) {
          cachedFixedHeaders.push(record);
          hiddenFixedElements.push(record);
          continue;
        }

        // 2c. Fixed Bottom Footers / Prompt Input Bars (Visible ONLY on the last slice)
        if (rect.bottom >= winH - 35 && rect.height < winH * 0.45) {
          cachedFixedFooters.push(record);
          hiddenFixedElements.push(record);
          continue;
        }

        // 2d. General fixed overlays
        hiddenFixedElements.push(record);
      }
    }
  }

  /**
   * Set visibility of fixed/floating elements per slice
   */
  function setFixedElementsVisibility(visible, isLastSlice = false) {
    const isFirstSlice = !!visible;

    // Top headers: visible only on slice 0
    for (const item of cachedFixedHeaders) {
      if (isFirstSlice) {
        item.element.style.visibility = item.originalVisibility;
      } else {
        item.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }

    // Bottom prompt bars / footers: visible only on the last slice
    for (const item of cachedFixedFooters) {
      if (isLastSlice) {
        item.element.style.visibility = item.originalVisibility;
      } else {
        item.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }

    // Floating action buttons (e.g. scroll-to-bottom): strictly hidden throughout capture
    for (const item of cachedFloatingWidgets) {
      item.element.style.setProperty('visibility', 'hidden', 'important');
    }

    // General fallback for any other fixed elements
    for (const item of hiddenFixedElements) {
      const isAlreadyHandled =
        cachedFixedHeaders.some((h) => h.element === item.element) ||
        cachedFixedFooters.some((f) => f.element === item.element) ||
        cachedFloatingWidgets.some((w) => w.element === item.element);

      if (isAlreadyHandled) continue;

      if (isFirstSlice) {
        item.element.style.visibility = item.originalVisibility;
      } else {
        item.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

  /**
   * Extract hyperlinks currently visible in the active slice viewport
   */
  function extractSliceLinks(scrollerInfo, currentScrollY) {
    try {
      const isWin = !scrollerInfo || scrollerInfo.isWindow;
      const root = isWin ? document : scrollerInfo.element;
      const anchorElements = root.querySelectorAll('a[href]');
      if (!anchorElements || anchorElements.length === 0) return [];

      const winW = window.innerWidth || document.documentElement.clientWidth;
      const winH = window.innerHeight || document.documentElement.clientHeight;

      let containerRect = null;
      if (!isWin) {
        containerRect = scrollerInfo.element.getBoundingClientRect();
      }

      const links = [];
      for (let i = 0; i < anchorElements.length; i++) {
        if (links.length >= 600) break;
        const el = anchorElements[i];

        if (el.id && el.id.startsWith('fps-')) continue;

        const rawHref = el.getAttribute('href');
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;

        let fullUrl = '';
        try {
          fullUrl = el.href;
        } catch (e) {
          continue;
        }
        if (!fullUrl || !(fullUrl.startsWith('http://') || fullUrl.startsWith('https://') || fullUrl.startsWith('mailto:') || fullUrl.startsWith('tel:'))) {
          continue;
        }

        const clientRects = el.getClientRects();
        if (!clientRects || clientRects.length === 0) continue;

        for (let r = 0; r < clientRects.length; r++) {
          const rect = clientRects[r];
          if (rect.width <= 1 || rect.height <= 1) continue;

          if (isWin) {
            // Check if link is within visible viewport slice
            if (rect.bottom <= 0 || rect.top >= winH || rect.right <= 0 || rect.left >= winW) continue;
            links.push({
              url: fullUrl,
              x: Math.round(rect.left),
              y: Math.round(rect.top + currentScrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          } else if (containerRect) {
            // Check if link is within container visible viewport slice
            if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom ||
                rect.right <= containerRect.left || rect.left >= containerRect.right) {
              continue;
            }
            links.push({
              url: fullUrl,
              x: Math.round(rect.left - containerRect.left),
              y: Math.round((rect.top - containerRect.top) + currentScrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          }
        }
      }
      return links;
    } catch (err) {
      console.warn('Failed to extract slice links:', err);
      return [];
    }
  }

  /**
   * Extract clickable hyperlinks with accurate canvas-mapped coordinates
   */
  function extractPageLinks(scrollerInfo) {
    return extractSliceLinks(scrollerInfo, 0);
  }

  /**
   * Prepare webpage before capture sequence
   */
  function preparePage(hideFixedElements) {
    const metrics = getMetrics();

    // Disable smooth scrolling to enforce immediate synchronous scroll jumps
    document.documentElement.classList.add('fps-hide-scrollbar');
    if (document.body) {
      document.body.classList.add('fps-hide-scrollbar');
    }

    if (activeScroller.isWindow) {
      originalScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      originalScrollBehavior = document.documentElement.style.scrollBehavior || '';
      document.documentElement.style.scrollBehavior = 'auto';
      if (document.body) {
        document.body.style.scrollBehavior = 'auto';
      }
      if (hideFixedElements) {
        findAndCacheFixedElements();
      }
    } else {
      const el = activeScroller.element;
      originalScrollY = el.scrollTop || 0;
      originalScrollBehavior = el.style.scrollBehavior || '';
      el.style.scrollBehavior = 'auto';
      el.classList.add('fps-hide-scrollbar');
      if (hideFixedElements) {
        findAndCacheFixedElements();
      }
    }

    metrics.links = extractPageLinks(activeScroller);
    return metrics;
  }

  /**
   * Restore document scroll position, styles, and visibility
   */
  function restorePage() {
    document.documentElement.classList.remove('fps-hide-scrollbar');
    if (document.body) {
      document.body.classList.remove('fps-hide-scrollbar');
      document.body.style.scrollBehavior = '';
    }
    document.documentElement.style.scrollBehavior = '';

    // Restore un-hitched sticky elements
    for (const item of unhitchedStickyElements) {
      item.element.style.position = item.originalPosition;
    }
    unhitchedStickyElements = [];

    // Restore fixed headers
    for (const item of cachedFixedHeaders) {
      item.element.style.visibility = item.originalVisibility;
    }
    cachedFixedHeaders = [];

    // Restore fixed footers
    for (const item of cachedFixedFooters) {
      item.element.style.visibility = item.originalVisibility;
    }
    cachedFixedFooters = [];

    // Restore floating widgets
    for (const item of cachedFloatingWidgets) {
      item.element.style.visibility = item.originalVisibility;
    }
    cachedFloatingWidgets = [];

    for (const item of hiddenFixedElements) {
      item.element.style.visibility = item.originalVisibility;
    }
    hiddenFixedElements = [];

    if (activeScroller) {
      if (activeScroller.isWindow) {
        window.scrollTo({ left: 0, top: originalScrollY, behavior: 'instant' });
      } else {
        const el = activeScroller.element;
        el.classList.remove('fps-hide-scrollbar');
        el.style.scrollBehavior = originalScrollBehavior;
        el.scrollTop = originalScrollY;
      }
    }
  }

  /**
   * Scroll target scroller to vertical position and await DOM reflow + GPU repaint
   */
  function scrollToPosition(y, isFirstSlice, isLastSlice, hideFixed, delayMs) {
    return new Promise((resolve) => {
      if (!activeScroller) {
        getMetrics();
      }

      if (hideFixed) {
        setFixedElementsVisibility(isFirstSlice, isLastSlice);
      }

      if (activeScroller.isWindow) {
        window.scrollTo({ left: 0, top: y, behavior: 'instant' });
        document.documentElement.scrollTop = y;
        if (document.body) {
          document.body.scrollTop = y;
        }
      } else {
        const el = activeScroller.element;
        el.scrollTop = y;
        // Trigger synthetic scroll event for reactive SPAs (DeepSeek, Twitch, ChatGPT)
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }

      // Wait for rendering and dynamic SPA DOM reflow (default 150ms)
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            let actualY = y;
            if (activeScroller.isWindow) {
              actualY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
            } else {
              actualY = activeScroller.element.scrollTop || y;
            }

            const links = extractSliceLinks(activeScroller, actualY);
            resolve({ actualY, links });
          });
        });
      }, delayMs || 150);
    });
  }

  /**
   * Runtime message listener with safe re-binding
   */
  if (window.__fpsMessageHandler) {
    try {
      chrome.runtime.onMessage.removeListener(window.__fpsMessageHandler);
    } catch (e) {}
  }

  window.__fpsMessageHandler = function (request, sender, sendResponse) {
    if (request.action === 'ping') {
      sendResponse({ status: 'ok' });
      return true;
    }

    if (request.action === 'getMetrics') {
      const metrics = getMetrics();
      sendResponse({ status: 'ok', metrics });
      return true;
    }

    if (request.action === 'prepareCapture') {
      const metrics = preparePage(request.hideFixedElements);
      sendResponse({ status: 'ok', metrics });
      return true;
    }

    if (request.action === 'scrollTo') {
      scrollToPosition(
        request.y,
        request.isFirstSlice,
        request.isLastSlice,
        request.hideFixedElements,
        request.delayMs
      ).then((result) => {
        sendResponse({ status: 'ok', scroll: result });
      }).catch((err) => {
        sendResponse({ status: 'error', error: err ? err.message : 'Scroll error' });
      });
      return true;
    }

    if (request.action === 'restorePage') {
      restorePage();
      sendResponse({ status: 'ok' });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__fpsMessageHandler);
})();
