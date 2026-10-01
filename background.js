const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Process tab audio with the Web Audio equalizer and effects chain.'
      })
      .finally(() => { creating = null; });
  }
  await creating;
}

async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) await chrome.offscreen.closeDocument();
}

async function getActive() {
  const { active = [] } = await chrome.storage.session.get('active');
  return active;
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2dd4bf' });
      await chrome.action.setBadgeTextColor({ tabId, color: '#06201c' });
    }
  } catch {
    // tab may already be gone
  }
}

async function markActive(tabId, on) {
  const set = new Set(await getActive());
  on ? set.add(tabId) : set.delete(tabId);
  await chrome.storage.session.set({ active: [...set] });
  await setBadge(tabId, on);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;

  if (msg.type === 'start') {
    (async () => {
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'start',
        tabId: msg.tabId,
        streamId: msg.streamId,
        settings: msg.settings
      });
      if (res?.ok) await markActive(msg.tabId, true);
      else if ((await getActive()).length === 0) await closeOffscreen();
      sendResponse(res ?? { ok: false, error: 'No response from audio engine' });
    })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'stopped') {
    (async () => {
      await markActive(msg.tabId, false);
      if (msg.remaining === 0) await closeOffscreen();
    })();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading') return;
  if ((await getActive()).includes(tabId)) setBadge(tabId, true);
});
