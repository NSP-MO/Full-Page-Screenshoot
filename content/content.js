/**
 * Content Script for Full Page Screenshot Extension
 * Handles standard webpage scrolling and internal SPA containers (Google Docs, Gmail, Notion, etc.)
 */

(function () {
  if (window.__fpsContentScriptLoaded) return;
  window.__fpsContentScriptLoaded = true;

  let activeScroller = null;
  let originalScrollY = 0;
  let hiddenFixedElements = [];

  /**
   * Universal scroller detection: detects window vs nested container (Google Docs, Gmail, etc.)
   */
  function detectPrimaryScroller() {
    // 1. Google Docs specific selector
    const gdocsEditor = document.querySelector('.kix-appview-editor, .goog-scrollable-container');
    if (gdocsEditor && gdocsEditor.scrollHeight > gdocsEditor.clientHeight + 40) {
      return {
        element: gdocsEditor,
        isWindow: false,
        name: 'Google Docs Editor'
      };
    }

    // 2. Standard document check
    const doc = document.documentElement;
    const body = document.body;
    const docScrollH = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.offsetHeight,
      body ? body.offsetHeight : 0
    );

    const winH = window.innerHeight || doc.clientHeight;

    if (docScrollH > winH + 60) {
      return {
        element: window,
        isWindow: true,
        name: 'Window Document'
      };
    }

    // 3. Scan DOM for internal scrollable containers (Gmail, Notion, Slack, etc.)
    const candidates = document.querySelectorAll('div, main, section, article');
    let bestEl = null;
    let maxDiff = 40;

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.id && el.id.startsWith('fps-')) continue;

      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        const diff = el.scrollHeight - el.clientHeight;
        const rect = el.getBoundingClientRect();
        if (diff > maxDiff && rect.width > 250 && rect.height > 180) {
          maxDiff = diff;
          bestEl = el;
        }
      }
    }

    if (bestEl) {
      return {
        element: bestEl,
        isWindow: false,
        name: 'Internal Container'
      };
    }

    return {
      element: window,
      isWindow: true,
      name: 'Window Default'
    };
  }

  /**
   * Get accurate metrics for the target scroller
   */
  function getMetrics() {
    const scrollerInfo = detectPrimaryScroller();
    activeScroller = scrollerInfo;

    const dpr = window.devicePixelRatio || 1;

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
      const clientHeight = window.innerHeight || doc.clientHeight;
      const clientWidth = window.innerWidth || doc.clientWidth;

      return {
        isContainer: false,
        scrollHeight,
        scrollWidth,
        clientHeight,
        clientWidth,
        devicePixelRatio: dpr,
        title: document.title || 'Screenshot',
        url: window.location.href,
        cropRect: {
          x: 0,
          y: 0,
          width: clientWidth,
          height: clientHeight
        }
      };
    } else {
      const el = scrollerInfo.element;
      const rect = el.getBoundingClientRect();

      return {
        isContainer: true,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        devicePixelRatio: dpr,
        title: document.title || 'Screenshot',
        url: window.location.href,
        cropRect: {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: rect.width,
          height: rect.height
        }
      };
    }
  }

  /**
   * Hide fixed elements temporarily on standard pages
   */
  function findAndCacheFixedElements() {
    hiddenFixedElements = [];
    if (!activeScroller || !activeScroller.isWindow) return;

    const allElements = document.querySelectorAll('*');
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
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

    if (activeScroller.isWindow) {
      originalScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
      document.documentElement.classList.add('fps-hide-scrollbar');
      if (document.body) {
        document.body.classList.add('fps-hide-scrollbar');
      }
      if (hideFixedElements) {
        findAndCacheFixedElements();
      }
    } else {
      originalScrollY = activeScroller.element.scrollTop || 0;
      activeScroller.element.classList.add('fps-hide-scrollbar');
    }

    return metrics;
  }

  /**
   * Restore document scroll position and classes
   */
  function restorePage() {
    if (activeScroller) {
      if (activeScroller.isWindow) {
        document.documentElement.classList.remove('fps-hide-scrollbar');
        if (document.body) {
          document.body.classList.remove('fps-hide-scrollbar');
        }
        setFixedElementsVisibility(true);
        window.scrollTo({ left: 0, top: originalScrollY, behavior: 'instant' });
      } else {
        activeScroller.element.classList.remove('fps-hide-scrollbar');
        activeScroller.element.scrollTop = originalScrollY;
      }
    }
    hiddenFixedElements = [];
  }

  /**
   * Scroll target scroller to target position
   */
  function scrollToPosition(y, isFirstSlice, hideFixed, delayMs) {
    return new Promise((resolve) => {
      if (!activeScroller) {
        getMetrics();
      }

      if (activeScroller.isWindow) {
        if (hideFixed && hiddenFixedElements.length > 0) {
          setFixedElementsVisibility(isFirstSlice);
        }
        window.scrollTo({ left: 0, top: y, behavior: 'instant' });
        document.documentElement.scrollTop = y;
        if (document.body) {
          document.body.scrollTop = y;
        }
      } else {
        const el = activeScroller.element;
        el.scrollTop = y;
        // Trigger synthetic scroll event for reactive SPAs (Google Docs, Gmail)
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }

      // Wait for rendering and dynamic SPA DOM reflow (fast 120ms)
      setTimeout(() => {
        requestAnimationFrame(() => {
          let actualY = y;
          if (activeScroller.isWindow) {
            actualY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
          } else {
            actualY = activeScroller.element.scrollTop || y;
          }
          resolve({ actualY });
        });
      }, delayMs || 120);
    });
  }

  /**
   * Runtime message listener
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
      });
      return true;
    }

    if (request.action === 'restorePage') {
      restorePage();
      sendResponse({ status: 'ok' });
      return true;
    }
  });
})();
