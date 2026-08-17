/**
 * Popup Script for Full Page Screenshot Extension
 */

document.addEventListener('DOMContentLoaded', async () => {
  const btnFullPage = document.getElementById('btnFullPage');
  const btnVisibleArea = document.getElementById('btnVisibleArea');
  const btnSelectedArea = document.getElementById('btnSelectedArea');
  const btnSettingsToggle = document.getElementById('btnSettingsToggle');

  const actionView = document.getElementById('actionView');
  const progressView = document.getElementById('progressView');
  const progressText = document.getElementById('progressText');
  const progressBarFill = document.getElementById('progressBarFill');
  const settingsPanel = document.getElementById('settingsPanel');
  const statusMessage = document.getElementById('statusMessage');

  const selectFormat = document.getElementById('selectFormat');
  const groupQuality = document.getElementById('groupQuality');
  const rangeQuality = document.getElementById('rangeQuality');
  const valQuality = document.getElementById('valQuality');
  const selectDelay = document.getElementById('selectDelay');
  const checkHideFixed = document.getElementById('checkHideFixed');

  // Load saved preferences
  const storedSettings = await chrome.storage.local.get([
    'pref_format',
    'pref_quality',
    'pref_delay',
    'pref_hide_fixed'
  ]);

  if (storedSettings.pref_format) {
    selectFormat.value = storedSettings.pref_format;
  }
  if (storedSettings.pref_quality) {
    rangeQuality.value = storedSettings.pref_quality;
    valQuality.textContent = storedSettings.pref_quality + '%';
  }
  if (storedSettings.pref_delay) {
    selectDelay.value = storedSettings.pref_delay;
  }
  if (typeof storedSettings.pref_hide_fixed === 'boolean') {
    checkHideFixed.checked = storedSettings.pref_hide_fixed;
  }

  updateQualityVisibility();

  // Event Listeners for Settings
  selectFormat.addEventListener('change', () => {
    updateQualityVisibility();
    savePreferences();
  });

  rangeQuality.addEventListener('input', () => {
    valQuality.textContent = rangeQuality.value + '%';
    savePreferences();
  });

  selectDelay.addEventListener('change', savePreferences);
  checkHideFixed.addEventListener('change', savePreferences);

  btnSettingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  function updateQualityVisibility() {
    if (selectFormat.value === 'jpeg') {
      groupQuality.classList.remove('hidden');
    } else {
      groupQuality.classList.add('hidden');
    }
  }

  function savePreferences() {
    chrome.storage.local.set({
      pref_format: selectFormat.value,
      pref_quality: parseInt(rangeQuality.value, 10),
      pref_delay: parseInt(selectDelay.value, 10),
      pref_hide_fixed: checkHideFixed.checked
    });
  }

  function getCaptureOptions() {
    return {
      format: selectFormat.value,
      quality: parseInt(rangeQuality.value, 10),
      delayMs: parseInt(selectDelay.value, 10),
      hideFixedElements: checkHideFixed.checked
    };
  }

  function showStatus(text, type = 'error') {
    statusMessage.textContent = text;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');
  }

  function setProgressState(active) {
    if (active) {
      actionView.classList.add('hidden');
      progressView.classList.remove('hidden');
      statusMessage.classList.add('hidden');
    } else {
      actionView.classList.remove('hidden');
      progressView.classList.add('hidden');
    }
  }

  // Progress Update Listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'captureProgress') {
      progressText.textContent = `Processing slice ${message.current} of ${message.total} (${message.percent}%)`;
      progressBarFill.style.width = `${message.percent}%`;
    }
  });

  // Full Page Capture Button
  btnFullPage.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://')) {
      showStatus('Internal browser pages cannot be captured due to Chromium security policies.');
      return;
    }

    setProgressState(true);
    progressText.textContent = 'Preparing capture...';
    progressBarFill.style.width = '5%';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'captureFullPage',
        options: getCaptureOptions()
      });

      if (response && response.status === 'error') {
        setProgressState(false);
        showStatus(response.message || 'An error occurred while capturing the page.');
      } else {
        // Popup will automatically close as the new viewer tab is opened
        window.close();
      }
    } catch (err) {
      setProgressState(false);
      showStatus('Failed to start capture: ' + err.message);
    }
  });

  // Visible Area Capture Button
  btnVisibleArea.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://')) {
      showStatus('Internal browser pages cannot be captured due to security restrictions.');
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        action: 'captureVisible',
        options: getCaptureOptions()
      });
      window.close();
    } catch (err) {
      showStatus('Failed to capture visible area: ' + err.message);
    }
  });

  // Selected Area Capture Button
  btnSelectedArea.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('edge://')) {
      showStatus('Internal browser pages cannot be captured.');
      return;
    }

    try {
      await chrome.runtime.sendMessage({ action: 'startAreaCapture' });
      // Close popup immediately so user can draw selection box on webpage
      window.close();
    } catch (err) {
      showStatus('Failed to initiate area selection: ' + err.message);
    }
  });
});
