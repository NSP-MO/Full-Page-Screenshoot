/**
 * Content Script for Full Page Screenshot Extension
 * Handles standard webpage scrolling and internal SPA containers (DeepSeek, Twitch, ChatGPT, Google Docs, Notion, etc.)
 */

(function () {
  let activeScroller = null;
  let originalScrollY = 0;
  let originalScrollBehavior = '';
  let hiddenFixedElements = [];

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
   * Find and cache fixed/sticky elements to prevent duplicate repeated headers during vertical stitching
   */
  function findAndCacheFixedElements() {
    hiddenFixedElements = [];
    const root = (activeScroller && !activeScroller.isWindow) ? activeScroller.element : document;
    const allElements = root.querySelectorAll('*');

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (el.id && el.id.startsWith('fps-')) continue;

      const style = window.getComputedStyle(el);
      const position = style.position;
      if (position === 'fixed' || position === 'sticky') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
          hiddenFixedElements.push({
            element: el,
            originalVisibility: el.style.visibility
          });
        }
      }
    }
  }

  function setFixedElementsVisibility(visible) {
    for (const item of hiddenFixedElements) {
      if (visible) {
        item.element.style.visibility = item.originalVisibility;
      } else {
        item.element.style.visibility = 'hidden';
      }
    }
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

    if (activeScroller) {
      if (activeScroller.isWindow) {
        setFixedElementsVisibility(true);
        window.scrollTo({ left: 0, top: originalScrollY, behavior: 'instant' });
      } else {
        const el = activeScroller.element;
        el.classList.remove('fps-hide-scrollbar');
        el.style.scrollBehavior = originalScrollBehavior;
        el.scrollTop = originalScrollY;
        setFixedElementsVisibility(true);
      }
    }
    hiddenFixedElements = [];
  }

  /**
   * Scroll target scroller to vertical position and await DOM reflow + GPU repaint
   */
  function scrollToPosition(y, isFirstSlice, hideFixed, delayMs) {
    return new Promise((resolve) => {
      if (!activeScroller) {
        getMetrics();
      }

      if (hideFixed && hiddenFixedElements.length > 0) {
        setFixedElementsVisibility(isFirstSlice);
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
            resolve({ actualY });
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
