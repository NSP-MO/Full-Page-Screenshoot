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
  let dynamicallyHiddenElements = [];
  let cachedBlurOverlays = [];
  let cachedFixedSidebars = [];
  let escKeyCaptureHandler = null;

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
    // 0. Dedicated Spreadsheet & Data Grid Detectors (Google Sheets, FortuneSheet, Handsontable, Excel Online, ag-Grid)
    // Google Sheets (/edit interactive mode)
    const waffleScrollY = document.querySelector('.native-scrollbar-y, div[class*="native-scrollbar-y"], #waffleScrollbar');
    const waffleGrid = document.querySelector('#waffle-grid-container, .waffle-grid-container, div[class*="grid-container"]');
    if (waffleScrollY && waffleGrid) {
      const scrollDiff = waffleScrollY.scrollHeight - waffleScrollY.clientHeight;
      if (scrollDiff > 20 || waffleScrollY.scrollHeight > 600) {
        return {
          element: waffleScrollY,
          visualElement: waffleGrid,
          isWindow: false,
          isSpreadsheet: true,
          name: 'Google Sheets Waffle Scroller'
        };
      }
    }

    // FortuneSheet / Luckysheet
    const luckyScrollY = document.querySelector('#luckysheet-scrollbar-y, .luckysheet-scrollbar-y');
    const luckyGrid = document.querySelector('#luckysheet-cell-main, #fortune-sheet, .luckysheet-grid-window');
    if (luckyScrollY && luckyGrid) {
      const scrollDiff = luckyScrollY.scrollHeight - luckyScrollY.clientHeight;
      if (scrollDiff > 20 || luckyScrollY.scrollHeight > 600) {
        return {
          element: luckyScrollY,
          visualElement: luckyGrid,
          isWindow: false,
          isSpreadsheet: true,
          name: 'FortuneSheet/Luckysheet Scroller'
        };
      }
    }

    // Handsontable
    const hotHolder = document.querySelector('.ht_master .wtHolder, .handsontable .wtHolder');
    if (hotHolder) {
      const scrollDiff = hotHolder.scrollHeight - hotHolder.clientHeight;
      if (scrollDiff > 40) {
        const hotRoot = hotHolder.closest('.handsontable') || hotHolder;
        return {
          element: hotHolder,
          visualElement: hotRoot,
          isWindow: false,
          isSpreadsheet: true,
          name: 'Handsontable Data Grid'
        };
      }
    }

    // Microsoft Excel Online
    const excelScroller = document.querySelector('.ewa-scroll-container, div[class*="ewa-scroll"]');
    if (excelScroller) {
      const excelGrid = document.querySelector('#m_excelWebRenderer_ewaCtl_sheetContentGrid, .ewa-grid-wrapper') || excelScroller;
      const scrollDiff = excelScroller.scrollHeight - excelScroller.clientHeight;
      if (scrollDiff > 40) {
        return {
          element: excelScroller,
          visualElement: excelGrid,
          isWindow: false,
          isSpreadsheet: true,
          name: 'Excel Online Data Grid'
        };
      }
    }

    // ag-Grid / Enterprise Data Grids
    const agViewport = document.querySelector('.ag-body-viewport, .ag-center-cols-viewport');
    if (agViewport) {
      const scrollDiff = agViewport.scrollHeight - agViewport.clientHeight;
      if (scrollDiff > 40) {
        const agRoot = agViewport.closest('.ag-root-wrapper, .ag-root') || agViewport;
        return {
          element: agViewport,
          visualElement: agRoot,
          isWindow: false,
          isSpreadsheet: true,
          name: 'ag-Grid Data Grid'
        };
      }
    }

    // 1. High-priority targeted selectors for well-known complex SPAs
    const knownSelectors = [
      // Google Gemini conversation scroller
      'infinite-scroller.chat-history',
      'infinite-scroller',
      '#chat-history',
      '.conversation-container',
      'div[class*="chat-history"]',
      'div[class*="conversation-container"]',
      'chat-window',
      'ms-chat-container',
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
    const candidates = document.querySelectorAll(
      'div, main, section, article, infinite-scroller, chat-window, ms-chat-container, [role="region"], [role="main"], [role="feed"], [class*="scroll"], [class*="chat"], [class*="conversation"], [class*="history"]'
    );
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
                className.includes('stream') || className.includes('content') || className.includes('editor') ||
                className.includes('history') || tag.includes('scroller') || tag.includes('chat') ||
                id.includes('chat') || id.includes('conversation') || id.includes('history')) {
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

    // Detect bottom-docked prompt bars, input containers, disclaimers, or composer widgets
    let bottomBarHeight = 0;
    const bottomCandidates = document.querySelectorAll(
      'input-container, rich-textarea, textarea, [class*="input"], [class*="composer"], [class*="prompt"], [class*="bottom-container"], [class*="gradient"], [class*="disclaimer"]'
    );
    let minBottomTop = winH;
    for (let i = 0; i < bottomCandidates.length; i++) {
      const bEl = bottomCandidates[i];
      if (bEl.id && bEl.id.startsWith('fps-')) continue;
      if (!scrollerInfo.isWindow && scrollerInfo.element === bEl) continue;
      const bStyle = window.getComputedStyle(bEl);
      if (bStyle.display === 'none' || bStyle.visibility === 'hidden') continue;
      const bRect = bEl.getBoundingClientRect();
      if (bRect.width > 200 && bRect.height >= 30 && bRect.height < winH * 0.45 &&
          bRect.bottom >= winH - 65 && bRect.top > winH * 0.35) {
        if (bRect.top < minBottomTop) {
          minBottomTop = bRect.top;
        }
      }
    }
    if (minBottomTop < winH) {
      bottomBarHeight = Math.max(0, Math.round(winH - minBottomTop));
    }

    // Detect persistent left navigation sidebar (e.g. Instagram, Twitter/X, Discord, Docs)
    let leftSidebarWidth = 0;
    let leftSidebarBgColor = '';
    let leftSidebarBorderColor = '';
    let leftSidebarBorderWidth = 1;
    let detectedSidebarEl = null;

    const sidebarCandidates = document.querySelectorAll(
      'nav, aside, header, [role="navigation"], [role="banner"], [class*="sidebar"], [class*="nav"], [class*="menu"], [id*="sidebar"], [id*="nav"], [class*="x9f619"]'
    );
    for (let i = 0; i < sidebarCandidates.length; i++) {
      const sEl = sidebarCandidates[i];
      if (sEl.id && sEl.id.startsWith('fps-')) continue;
      if (!scrollerInfo.isWindow && scrollerInfo.element === sEl) continue;
      const sStyle = window.getComputedStyle(sEl);
      if (sStyle.display === 'none' || sStyle.visibility === 'hidden') continue;
      const pos = sStyle.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const sRect = sEl.getBoundingClientRect();
      if (sRect.left <= 25 && sRect.left >= -15 &&
          sRect.top <= 100 && sRect.top >= -15 &&
          sRect.height >= winH * 0.55 &&
          sRect.width >= 40 && sRect.width < winW * 0.45) {
        if (sRect.width > leftSidebarWidth) {
          leftSidebarWidth = Math.round(sRect.width);
          detectedSidebarEl = sEl;
        }
      }
    }

    // Fallback: check top-level direct children if semantic selectors missed the sidebar
    if (leftSidebarWidth === 0) {
      const topLevelChildren = (document.body ? Array.from(document.body.children) : []).concat(
        Array.from(document.documentElement.children)
      );
      for (const tEl of topLevelChildren) {
        if (tEl.id && tEl.id.startsWith('fps-')) continue;
        if (!scrollerInfo.isWindow && scrollerInfo.element === tEl) continue;
        const tStyle = window.getComputedStyle(tEl);
        if (tStyle.display === 'none' || tStyle.visibility === 'hidden') continue;
        const pos = tStyle.position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;
        const tRect = tEl.getBoundingClientRect();
        if (tRect.left <= 25 && tRect.left >= -15 &&
            tRect.top <= 100 && tRect.top >= -15 &&
            tRect.height >= winH * 0.55 &&
            tRect.width >= 40 && tRect.width < winW * 0.45) {
          if (tRect.width > leftSidebarWidth) {
            leftSidebarWidth = Math.round(tRect.width);
            detectedSidebarEl = tEl;
          }
        }
      }
    }

    if (detectedSidebarEl) {
      leftSidebarBgColor = getEffectiveBackgroundColor(detectedSidebarEl);
      if ((!leftSidebarBgColor || leftSidebarBgColor === '#1f1f1f') && detectedSidebarEl.firstElementChild) {
        const childBg = getEffectiveBackgroundColor(detectedSidebarEl.firstElementChild);
        if (childBg && childBg !== '#1f1f1f') {
          leftSidebarBgColor = childBg;
        }
      }
      const sStyle = window.getComputedStyle(detectedSidebarEl);
      let bColor = sStyle.borderRightColor;
      let bWidth = parseInt(sStyle.borderRightWidth);
      if ((!bColor || bColor === 'transparent' || bColor === 'rgba(0, 0, 0, 0)' || !bWidth) && detectedSidebarEl.firstElementChild) {
        const cStyle = window.getComputedStyle(detectedSidebarEl.firstElementChild);
        if (cStyle.borderRightColor && cStyle.borderRightColor !== 'transparent' && cStyle.borderRightColor !== 'rgba(0, 0, 0, 0)' && parseInt(cStyle.borderRightWidth) > 0) {
          bColor = cStyle.borderRightColor;
          bWidth = parseInt(cStyle.borderRightWidth);
        }
      }
      if (bColor && bColor !== 'transparent' && bColor !== 'rgba(0, 0, 0, 0)' && bWidth > 0) {
        leftSidebarBorderColor = bColor;
        leftSidebarBorderWidth = bWidth;
      }
    }

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

      const stepHeight = Math.max(150, winH - bottomBarHeight);

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
        bottomBarHeight,
        leftSidebarWidth,
        leftSidebarBgColor,
        leftSidebarBorderColor,
        leftSidebarBorderWidth,
        stepHeight,
        cropRect: {
          x: 0,
          y: 0,
          width: winW,
          height: winH
        }
      };
    } else {
      const el = scrollerInfo.element;
      const visualEl = scrollerInfo.visualElement || el;
      const rect = visualEl.getBoundingClientRect();

      let pinnedHeaderHeight = 0;
      let spreadsheetRowHeight = 0;
      if (scrollerInfo.isSpreadsheet) {
        // Check for frozen row container or column headers in Google Sheets, Luckysheet, Handsontable, etc.
        const headerCandidates = visualEl.querySelectorAll(
          '[class*="column-headers"], [class*="fixed-table"], [class*="grid-fixed"], .ht_clone_top, [id*="col-header"], thead, .ewa-header'
        );
        for (let i = 0; i < headerCandidates.length; i++) {
          const hRect = headerCandidates[i].getBoundingClientRect();
          if (hRect.height > 15 && hRect.height < rect.height * 0.4 && hRect.top >= rect.top - 5 && hRect.top <= rect.top + 10) {
            if (hRect.height > pinnedHeaderHeight) {
              pinnedHeaderHeight = Math.round(hRect.height);
            }
          }
        }
        // If Google Sheets waffle canvas is used without explicit header element height, check column-headers-background
        if (pinnedHeaderHeight === 0 && (document.querySelector('.waffle-grid-container, #waffle-grid-container') || (scrollerInfo.name && scrollerInfo.name.includes('Google Sheets')))) {
          const colBg = visualEl.querySelector('.column-headers-background, [class*="column-headers"]');
          if (colBg && colBg.offsetHeight > 15) {
            pinnedHeaderHeight = Math.round(colBg.offsetHeight);
          }
        }

        // Detect discrete spreadsheet row height for seamless slice row snapping
        const rowCandidates = visualEl.querySelectorAll('tr, [role="row"], .ag-row, .ht_master tbody tr');
        for (let i = 0; i < rowCandidates.length; i++) {
          const rH = rowCandidates[i].offsetHeight;
          if (rH >= 16 && rH <= 120) {
            spreadsheetRowHeight = Math.round(rH);
            break;
          }
        }
        if (!spreadsheetRowHeight) {
          // Standard default for Google Sheets canvas waffle-grid-container
          spreadsheetRowHeight = 21;
        }
      }

      const cropX = Math.max(0, Math.round(rect.left));
      const cropY = Math.max(0, Math.round(rect.top));
      const cropW = Math.min(winW - cropX, Math.round(rect.width));
      const cropH = Math.min(winH - cropY, Math.round(rect.height));

      const availableH = Math.max(100, cropH - bottomBarHeight - pinnedHeaderHeight);
      let stepHeight = availableH;
      if (scrollerInfo.isSpreadsheet && spreadsheetRowHeight > 0) {
        // Snap stepHeight to an exact multiple of integer rows to eliminate chopped rows and seam fractures
        const completeRows = Math.floor(availableH / spreadsheetRowHeight);
        stepHeight = Math.max(spreadsheetRowHeight * 2, completeRows * spreadsheetRowHeight);
      } else {
        stepHeight = Math.max(150, availableH);
      }

      return {
        isContainer: true,
        isSpreadsheet: !!scrollerInfo.isSpreadsheet,
        spreadsheetRowHeight,
        pinnedHeaderHeight,
        scrollHeight: el.scrollHeight,
        scrollWidth: Math.max(el.scrollWidth, visualEl.scrollWidth || 0),
        clientHeight: el.clientHeight,
        clientWidth: visualEl.clientWidth || el.clientWidth,
        windowWidth: winW,
        windowHeight: winH,
        devicePixelRatio: dpr,
        backgroundColor: getEffectiveBackgroundColor(visualEl),
        title: document.title || 'Screenshoot',
        url: window.location.href,
        bottomBarHeight,
        leftSidebarWidth,
        leftSidebarBgColor,
        leftSidebarBorderColor,
        leftSidebarBorderWidth,
        stepHeight,
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
    cachedFixedSidebars = [];
    unhitchedStickyElements = [];
    dynamicallyHiddenElements = [];
    cachedBlurOverlays = [];

    const winW = window.innerWidth || document.documentElement.clientWidth;
    const winH = window.innerHeight || document.documentElement.clientHeight;

    // Scan the entire document so fixed elements outside container scrollers are discovered
    const allElements = document.querySelectorAll('*');

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (el.id && el.id.startsWith('fps-')) continue;
      if (activeScroller) {
        if (activeScroller.element === el) continue;
        if (activeScroller.visualElement && (activeScroller.visualElement === el || activeScroller.visualElement.contains(el))) continue;
      }

      const style = window.getComputedStyle(el);
      const position = style.position;
      const display = style.display;
      const visibility = style.visibility;

      if (display === 'none' || visibility === 'hidden') continue;

      const backdropFilter = style.backdropFilter || style.webkitBackdropFilter || '';
      const filter = style.filter || '';
      const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const id = (typeof el.id === 'string' ? el.id : '').toLowerCase();
      const tag = el.tagName.toLowerCase();

      // 0. Detect and suppress frosted-glass blur overlays and gradient scrims (e.g., Gemini .blur-bg, .bottom-gradient)
      const hasBackdropBlur = backdropFilter.includes('blur');
      const isScrimOrGradient =
        className.includes('blur-bg') ||
        className.includes('autosuggest-scrim') ||
        className.includes('chat-scrim') ||
        className.includes('bottom-gradient') ||
        className.includes('top-gradient') ||
        className.includes('gradient-container') ||
        (className.includes('scrim') && (position === 'absolute' || position === 'fixed' || position === 'sticky')) ||
        id.includes('scrim') ||
        id.includes('gradient');

      if (hasBackdropBlur || isScrimOrGradient) {
        const blurRecord = {
          element: el,
          originalDisplay: el.style.display,
          originalVisibility: el.style.visibility,
          originalOpacity: el.style.opacity,
          originalPointerEvents: el.style.pointerEvents,
          originalBackdropFilter: el.style.backdropFilter,
          originalWebkitBackdropFilter: el.style.webkitBackdropFilter,
          originalFilter: el.style.filter
        };
        cachedBlurOverlays.push(blurRecord);
        hideElementFully(el);
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        el.style.setProperty('filter', 'none', 'important');
        continue;
      }

      // 1. Un-hitch position: sticky elements so they flow naturally with their message/section
      if (position === 'sticky') {
        unhitchedStickyElements.push({
          element: el,
          originalPosition: el.style.position
        });
        el.style.setProperty('position', 'relative', 'important');
        continue;
      }

      // 2. Fixed elements (and bottom-docked composer/prompt overlays)
      const isFixed = (position === 'fixed');
      const isAbsolute = (position === 'absolute');

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

      // 2a. Floating Action Buttons / Transient Controls (Scroll to bottom, quick prompts, jump buttons)
      const isContentElement = (
        tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'canvas' ||
        tag === 'source' || tag === 'span' || tag === 'p' || tag === 'h1' ||
        tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6' ||
        tag === 'li' || tag === 'tr' || tag === 'td' || tag === 'article' || tag === 'section'
      );

      const isFloatingControl =
        !isContentElement &&
        (isFixed || (isAbsolute && (el.parentElement === document.body || el.parentElement === document.documentElement))) && (
          className.includes('scroll-to-bottom') ||
          className.includes('scroll-bottom') ||
          className.includes('back-to-bottom') ||
          className.includes('jump-to-bottom') ||
          ariaLabel.includes('scroll to bottom') ||
          ariaLabel.includes('jump to bottom') ||
          id.includes('scroll-bottom') ||
          (rect.width <= 90 && rect.height <= 90 && (
            (rect.bottom >= winH - 90 && rect.right >= winW - 90) ||
            (rect.bottom >= winH - 90 && rect.left <= 90)
          ))
        );

      const record = {
        element: el,
        originalDisplay: el.style.display,
        originalVisibility: el.style.visibility,
        originalOpacity: el.style.opacity,
        originalPointerEvents: el.style.pointerEvents
      };

      if (isFloatingControl) {
        cachedFloatingWidgets.push(record);
        hiddenFixedElements.push(record);
        hideElementFully(el);
        continue;
      }

      // 2b. Fixed Left Navigation Sidebars (e.g. Instagram, Twitter/X, Reddit, Discord, docs)
      const isLeftSidebar =
        (isFixed || (position === 'sticky' && rect.top <= 25)) &&
        rect.left <= 25 && rect.left >= -15 &&
        rect.top <= 100 && rect.top >= -15 &&
        rect.height >= winH * 0.55 &&
        rect.width >= 40 && rect.width < winW * 0.45;

      if (isLeftSidebar) {
        const isChildOfExisting = cachedFixedSidebars.some((item) => item.element.contains(el));
        if (!isChildOfExisting) {
          const existingChildIdx = cachedFixedSidebars.findIndex((item) => el.contains(item.element));
          if (existingChildIdx >= 0) {
            cachedFixedSidebars[existingChildIdx] = record;
          } else {
            cachedFixedSidebars.push(record);
          }
        }
        hiddenFixedElements.push(record);
        continue;
      }

      // 2c. Fixed Top Headers (Visible ONLY on slice 0)
      const isHeaderLike = className.includes('header') || className.includes('navbar') || className.includes('navtab') ||
                           className.includes('toolbar') || className.includes('formula') || className.includes('docs-chrome') ||
                           className.includes('ewa-ribbon') || id.includes('header') || id.includes('navbar') ||
                           id.includes('toolbar') || id.includes('formula') || id.includes('docs-chrome') ||
                           id.includes('luckysheet-wa-calculate') || tag === 'header' || tag === 'nav';
      if (isFixed && (rect.top <= 65 || isHeaderLike) && rect.top < 150 && rect.height < winH * 0.35) {
        cachedFixedHeaders.push(record);
        hiddenFixedElements.push(record);
        continue;
      }

      // 2c. Fixed Bottom Footers / Prompt Input Bars / Sheet Tab Bars (Visible ONLY on the last slice)
      const isPromptBar =
        tag.includes('input') || tag.includes('composer') || tag.includes('textarea') ||
        tag.includes('rich-textarea') || tag.includes('disclaimer') ||
        className.includes('input') || className.includes('composer') ||
        className.includes('prompt') || className.includes('chat-bar') ||
        className.includes('bottom-container') || className.includes('disclaimer') ||
        className.includes('gradient') || className.includes('sheet-tab') ||
        className.includes('sheet-area') || className.includes('ewa-sheet-tabs') ||
        id.includes('input') || id.includes('prompt') || id.includes('composer') ||
        id.includes('sheet-tab') || id.includes('docs-sheet-tab-bar') || id.includes('sheetTabs');

      const isBottomDocked = (rect.bottom >= winH - 65 && rect.top > winH * 0.35 && rect.height < winH * 0.45);
      const isScroller = (activeScroller && (activeScroller.element === el || (activeScroller.visualElement && activeScroller.visualElement === el)));

      if (!isScroller && isBottomDocked && (isFixed || isPromptBar || (isAbsolute && el.parentElement === document.body))) {
        record.preserveLayout = (position !== 'fixed' && position !== 'absolute');
        cachedFixedFooters.push(record);
        hiddenFixedElements.push(record);
        continue;
      }

      // 2d. General fixed overlays
      if (isFixed || (isAbsolute && el.parentElement === document.body)) {
        hiddenFixedElements.push(record);
      }
    }
  }

  /**
   * Helper to completely hide a fixed/floating element and suppress all child rendering
   */
  function hideElementFully(el) {
    if (!el || !el.style) return;
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('opacity', '0', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    el.classList.add('fps-element-hidden-temporarily');
  }

  /**
   * Helper to restore a fixed/floating element to its original state
   */
  function restoreElementFully(item) {
    if (!item || !item.element || !item.element.style) return;
    item.element.style.display = item.originalDisplay;
    item.element.style.visibility = item.originalVisibility;
    item.element.style.opacity = item.originalOpacity;
    item.element.style.pointerEvents = item.originalPointerEvents;
    item.element.classList.remove('fps-element-hidden-temporarily');
  }

  /**
   * Set visibility of fixed/floating elements per slice
   */
  function setFixedElementsVisibility(visible, isLastSlice = false) {
    const isFirstSlice = !!visible;

    // Top headers: visible only on slice 0
    for (const item of cachedFixedHeaders) {
      if (isFirstSlice) {
        restoreElementFully(item);
      } else {
        hideElementFully(item.element);
      }
    }

    // Bottom prompt bars / footers: visible only on the last slice
    for (const item of cachedFixedFooters) {
      if (isLastSlice) {
        restoreElementFully(item);
      } else {
        if (item.preserveLayout) {
          item.element.style.setProperty('visibility', 'hidden', 'important');
          item.element.style.setProperty('opacity', '0', 'important');
          item.element.style.setProperty('pointer-events', 'none', 'important');
          item.element.classList.add('fps-element-hidden-temporarily');
        } else {
          hideElementFully(item.element);
        }
      }
    }

    // Fixed left sidebars: visible on slice 0, hidden with preserved layout on subsequent slices
    for (const item of cachedFixedSidebars) {
      if (isFirstSlice) {
        restoreElementFully(item);
      } else {
        item.element.style.setProperty('visibility', 'hidden', 'important');
        item.element.style.setProperty('opacity', '0', 'important');
        item.element.style.setProperty('pointer-events', 'none', 'important');
        item.element.classList.add('fps-element-hidden-temporarily');
      }
    }

    // Floating action buttons (e.g. scroll-to-bottom): strictly hidden throughout capture
    for (const item of cachedFloatingWidgets) {
      hideElementFully(item.element);
    }

    // General fallback for any other fixed elements
    for (const item of hiddenFixedElements) {
      const isAlreadyHandled =
        cachedFixedHeaders.some((h) => h.element === item.element) ||
        cachedFixedFooters.some((f) => f.element === item.element) ||
        cachedFloatingWidgets.some((w) => w.element === item.element) ||
        cachedFixedSidebars.some((s) => s.element === item.element);

      if (isAlreadyHandled) continue;

      if (isFirstSlice) {
        restoreElementFully(item);
      } else {
        hideElementFully(item.element);
      }
    }

    // Blur overlays remain strictly hidden across all slices
    for (const item of cachedBlurOverlays) {
      hideElementFully(item.element);
      item.element.style.setProperty('backdrop-filter', 'none', 'important');
      item.element.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    }

    // Dynamically discovered fixed elements (e.g. Ko-fi dynamic tab menu, dynamic ribbons)
    for (const item of dynamicallyHiddenElements) {
      if (item.isBlurOverlay) {
        hideElementFully(item.element);
        item.element.style.setProperty('backdrop-filter', 'none', 'important');
        item.element.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
      } else if (item.isHeader) {
        if (isFirstSlice) {
          restoreElementFully(item);
        } else {
          hideElementFully(item.element);
        }
      } else if (item.isFooter) {
        if (isLastSlice) {
          restoreElementFully(item);
        } else {
          if (item.preserveLayout) {
            item.element.style.setProperty('visibility', 'hidden', 'important');
            item.element.style.setProperty('opacity', '0', 'important');
            item.element.style.setProperty('pointer-events', 'none', 'important');
            item.element.classList.add('fps-element-hidden-temporarily');
          } else {
            hideElementFully(item.element);
          }
        }
      } else {
        hideElementFully(item.element);
      }
    }
  }

  /**
   * Scan for and suppress elements that dynamically become fixed or sticky after scrolling
   * (e.g., Ko-fi #tabsMenu dynamically acquiring .fixed-tab-menu, dynamic sticky ribbons)
   */
  function suppressDynamicFixedElements(isFirstSlice, isLastSlice) {
    const winW = window.innerWidth || document.documentElement.clientWidth;
    const winH = window.innerHeight || document.documentElement.clientHeight;

    const allElements = document.querySelectorAll('*');
    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (el.id && el.id.startsWith('fps-')) continue;

      const isTracked =
        cachedFixedHeaders.some((h) => h.element === el) ||
        cachedFixedFooters.some((f) => f.element === el) ||
        cachedFloatingWidgets.some((w) => w.element === el) ||
        cachedBlurOverlays.some((b) => b.element === el) ||
        cachedFixedSidebars.some((s) => s.element === el) ||
        hiddenFixedElements.some((h) => h.element === el) ||
        dynamicallyHiddenElements.some((d) => d.element === el);

      if (isTracked) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const backdropFilter = style.backdropFilter || style.webkitBackdropFilter || '';
      const filter = style.filter || '';
      const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const id = (typeof el.id === 'string' ? el.id : '').toLowerCase();
      const tag = el.tagName.toLowerCase();

      const hasBackdropBlur = backdropFilter.includes('blur');
      const isScrimOrGradient =
        className.includes('blur-bg') ||
        className.includes('autosuggest-scrim') ||
        className.includes('chat-scrim') ||
        className.includes('bottom-gradient') ||
        className.includes('top-gradient') ||
        className.includes('gradient-container') ||
        (className.includes('scrim') && (position === 'absolute' || position === 'fixed' || position === 'sticky')) ||
        id.includes('scrim') ||
        id.includes('gradient');

      if (hasBackdropBlur || isScrimOrGradient) {
        dynamicallyHiddenElements.push({
          element: el,
          originalDisplay: el.style.display,
          originalVisibility: el.style.visibility,
          originalOpacity: el.style.opacity,
          originalPointerEvents: el.style.pointerEvents,
          originalBackdropFilter: el.style.backdropFilter,
          originalWebkitBackdropFilter: el.style.webkitBackdropFilter,
          originalFilter: el.style.filter,
          isBlurOverlay: true
        });
        hideElementFully(el);
        el.style.setProperty('backdrop-filter', 'none', 'important');
        el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        el.style.setProperty('filter', 'none', 'important');
        continue;
      }

      const position = style.position;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const isPromptBar =
        tag.includes('input') || tag.includes('composer') || tag.includes('textarea') ||
        tag.includes('rich-textarea') || tag.includes('disclaimer') ||
        className.includes('input') || className.includes('composer') ||
        className.includes('prompt') || className.includes('chat-bar') ||
        className.includes('bottom-container') || className.includes('disclaimer') ||
        className.includes('gradient') ||
        id.includes('input') || id.includes('prompt') || id.includes('composer');

      const isHeader = !isFirstSlice && (position === 'fixed' || (position === 'absolute' && el.parentElement === document.body)) && rect.top <= 75 && rect.height < winH * 0.45;
      const isFooter = !isLastSlice && (position === 'fixed' || isPromptBar) && rect.bottom >= winH - 75 && rect.top > winH * 0.35 && rect.height < winH * 0.45;
      const isScroller = (activeScroller && activeScroller.element === el);

      if (!isScroller && (isHeader || isFooter)) {
        const preserveLayout = (position !== 'fixed' && position !== 'absolute');
        dynamicallyHiddenElements.push({
          element: el,
          originalDisplay: el.style.display,
          originalVisibility: el.style.visibility,
          originalOpacity: el.style.opacity,
          originalPointerEvents: el.style.pointerEvents,
          isHeader: isHeader,
          isFooter: isFooter,
          preserveLayout: preserveLayout
        });
        if (preserveLayout) {
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.classList.add('fps-element-hidden-temporarily');
        } else {
          hideElementFully(el);
        }
      }
    }

    // On last slice, restore any dynamically hidden footers
    if (isLastSlice) {
      for (let i = dynamicallyHiddenElements.length - 1; i >= 0; i--) {
        const item = dynamicallyHiddenElements[i];
        if (item.isFooter) {
          restoreElementFully(item);
          dynamicallyHiddenElements.splice(i, 1);
        }
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
            const isPrimaryContainer =
              (containerRect.width >= winW * 0.55 || containerRect.width + containerRect.left >= winW - 30) &&
              containerRect.height >= winH * 0.55;

            links.push({
              url: fullUrl,
              x: isPrimaryContainer ? Math.round(rect.left) : Math.round(rect.left - containerRect.left),
              y: isPrimaryContainer
                ? Math.round(rect.top + currentScrollY)
                : Math.round((rect.top - containerRect.top) + currentScrollY),
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
   * Proactively eagerize and trigger lazy images across the page before capture
   */
  function triggerAndPreloadLazyImages() {
    try {
      const imgs = document.querySelectorAll('img');
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        if (img.loading === 'lazy') {
          img.loading = 'eager';
        }
        const dataSrc =
          img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('data-lazy') ||
          img.getAttribute('data-url');
        if (dataSrc && (!img.src || img.src.includes('data:image') || img.src.includes('placeholder') || img.src.includes('blank'))) {
          img.src = dataSrc;
        }
        const dataSrcset = img.getAttribute('data-srcset');
        if (dataSrcset && !img.srcset) {
          img.srcset = dataSrcset;
        }
      }

      const bgEls = document.querySelectorAll('[data-bg], [data-background], [data-background-image]');
      for (let i = 0; i < bgEls.length; i++) {
        const el = bgEls[i];
        const bg =
          el.getAttribute('data-bg') ||
          el.getAttribute('data-background') ||
          el.getAttribute('data-background-image');
        if (bg && (!el.style.backgroundImage || el.style.backgroundImage === 'none')) {
          el.style.backgroundImage = `url("${bg}")`;
        }
      }

      // Wake up JavaScript IntersectionObservers by dispatching scroll and resize events
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    } catch (e) {
      console.warn('Error eagerizing lazy assets:', e);
    }
  }

  /**
   * Ensure images in the visible slice are decoded before taking screenshot
   */
  async function awaitSliceImagesLoaded() {
    try {
      const winW = window.innerWidth || document.documentElement.clientWidth;
      const winH = window.innerHeight || document.documentElement.clientHeight;
      const imgs = Array.from(document.querySelectorAll('img'));
      const visibleImgs = imgs.filter((img) => {
        const r = img.getBoundingClientRect();
        return r.bottom > -40 && r.top < winH + 40 && r.right > -40 && r.left < winW + 40;
      });

      const decodePromises = visibleImgs.map((img) => {
        if (img.loading === 'lazy') img.loading = 'eager';
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        if (typeof img.decode === 'function') {
          return Promise.race([
            img.decode().catch(() => {}),
            new Promise((r) => setTimeout(r, 250))
          ]);
        }
        return new Promise((r) => {
          const timer = setTimeout(r, 250);
          img.addEventListener('load', () => { clearTimeout(timer); r(); }, { once: true });
          img.addEventListener('error', () => { clearTimeout(timer); r(); }, { once: true });
        });
      });

      await Promise.all(decodePromises);
    } catch (e) {
      console.warn('Error awaiting slice images:', e);
    }
  }

  /**
   * Prepare webpage before capture sequence
   */
  function preparePage(hideFixedElements) {
    const metrics = getMetrics();

    // Proactively eagerize all lazy images and background assets across the page
    triggerAndPreloadLazyImages();

    // Disable smooth scrolling to enforce immediate synchronous scroll jumps
    document.documentElement.classList.add('fps-hide-scrollbar', 'fps-capturing');
    if (document.body) {
      document.body.classList.add('fps-hide-scrollbar', 'fps-capturing');
    }

    // Listen for ESC key to conclude capture early and finalize captured slices
    if (!escKeyCaptureHandler) {
      escKeyCaptureHandler = function (e) {
        if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
          e.preventDefault();
          e.stopPropagation();
          try {
            chrome.runtime.sendMessage({ action: 'stopCaptureEarly' });
          } catch (err) {}
        }
      };
      window.addEventListener('keydown', escKeyCaptureHandler, true);
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
      if (activeScroller.visualElement) {
        activeScroller.visualElement.classList.add('fps-hide-scrollbar');
      }
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
    document.documentElement.classList.remove('fps-hide-scrollbar', 'fps-capturing');
    if (document.body) {
      document.body.classList.remove('fps-hide-scrollbar', 'fps-capturing');
      document.body.style.scrollBehavior = '';
    }
    document.documentElement.style.scrollBehavior = '';

    // Restore blur overlays
    for (const item of cachedBlurOverlays) {
      restoreElementFully(item);
      if (item.element && item.element.style) {
        item.element.style.backdropFilter = item.originalBackdropFilter;
        item.element.style.webkitBackdropFilter = item.originalWebkitBackdropFilter;
        item.element.style.filter = item.originalFilter;
      }
    }
    cachedBlurOverlays = [];

    // Restore un-hitched sticky elements
    for (const item of unhitchedStickyElements) {
      item.element.style.position = item.originalPosition;
    }
    unhitchedStickyElements = [];

    // Restore fixed headers
    for (const item of cachedFixedHeaders) {
      restoreElementFully(item);
    }
    cachedFixedHeaders = [];

    // Restore fixed sidebars
    for (const item of cachedFixedSidebars) {
      restoreElementFully(item);
    }
    cachedFixedSidebars = [];

    // Restore fixed footers
    for (const item of cachedFixedFooters) {
      restoreElementFully(item);
    }
    cachedFixedFooters = [];

    // Restore floating widgets
    for (const item of cachedFloatingWidgets) {
      restoreElementFully(item);
    }
    cachedFloatingWidgets = [];

    for (const item of hiddenFixedElements) {
      restoreElementFully(item);
    }
    hiddenFixedElements = [];

    // Restore dynamically hidden elements
    for (const item of dynamicallyHiddenElements) {
      restoreElementFully(item);
    }
    dynamicallyHiddenElements = [];

    if (activeScroller) {
      if (activeScroller.isWindow) {
        window.scrollTo({ left: 0, top: originalScrollY, behavior: 'instant' });
      } else {
        const el = activeScroller.element;
        el.classList.remove('fps-hide-scrollbar');
        if (activeScroller.visualElement) {
          activeScroller.visualElement.classList.remove('fps-hide-scrollbar');
        }
        el.style.scrollBehavior = originalScrollBehavior;
        el.scrollTop = originalScrollY;
      }
    }

    // Detach ESC key listener
    if (escKeyCaptureHandler) {
      window.removeEventListener('keydown', escKeyCaptureHandler, true);
      escKeyCaptureHandler = null;
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
        // Trigger synthetic scroll event for reactive SPAs (DeepSeek, Gemini, Twitch, ChatGPT, Google Sheets)
        // Note: bubbles: false prevents window-level reset listeners (e.g. Google Sheets resetting scroll to 0)
        el.dispatchEvent(new Event('scroll', { bubbles: false }));
        if (activeScroller.isSpreadsheet && activeScroller.visualElement) {
          activeScroller.visualElement.dispatchEvent(new Event('scroll', { bubbles: false }));
        }
      }

      // Wait for rendering and dynamic SPA DOM reflow (default 150ms, 250ms for spreadsheets)
      const effectiveDelay = delayMs || (activeScroller && activeScroller.isSpreadsheet ? 250 : 150);
      setTimeout(async () => {
        // Await visible images to load and decode before capturing slice
        await awaitSliceImagesLoaded();

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            let actualY = y;
            if (activeScroller.isWindow) {
              actualY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
            } else {
              actualY = activeScroller.element.scrollTop || y;
            }

            if (hideFixed) {
              suppressDynamicFixedElements(isFirstSlice, isLastSlice);
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
