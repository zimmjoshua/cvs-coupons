export const AUTH_LIMITATION = 'This Gmail connection is suitable for Testing mode, where a refresh token can stop working after 7 days. Background checks then show that a person must sign in again. They do not open a Google prompt on the timer. An Internal OAuth client is the later setup for this organization, after it is configured and signed in again.';
export const PARSER_VERSION = 2;

export function isLabelMissing(error) {
  return error?.code === 'label_missing';
}

export function backoffMs(attempt) {
  const step = Math.min(Math.max(Number(attempt) || 1, 1), 5);
  return Math.min(15 * 60 * 1000, 60 * 1000 * 2 ** (step - 1));
}

export function isReauthError(error) {
  const code = String(error?.oauthError || '');
  const message = String(error?.message || error || '');
  return code === 'invalid_grant' || /invalid_grant|needs_reauthentication/i.test(message);
}

export function isHistoryExpired(error) {
  return Number(error?.status) === 404;
}

export function shouldOpenOAuth({ interactive = false, oauthError = '' } = {}) {
  return interactive === true && (oauthError === 'invalid_grant' || oauthError === 'missing_refresh_token');
}

export function visibleSyncError(error) {
  if (isReauthError(error)) {
    return 'Gmail needs to be signed in again. A Testing-mode refresh token can expire after 7 days. Background checks will not open a Google prompt.';
  }
  return String(error?.message || 'Mailbox check failed.').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function normalizeSyncState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    running: false,
    lastSuccess: state.lastSuccess || null,
    nextPoll: state.nextPoll || null,
    lastError: state.lastError || null,
    needsReauthentication: Boolean(state.needsReauthentication),
    attempt: Number(state.attempt) || 0,
    historyId: state.historyId || null,
    processedMessageIds: Array.isArray(state.processedMessageIds) ? state.processedMessageIds : [],
    capture: {},
    parserVersion: Number(state.parserVersion) || 0,
    rescan: state.rescan === true,
    label: state.label && typeof state.label === 'object' ? {
      name: state.label.name || 'CVS',
      id: state.label.id || null,
      found: Boolean(state.label.found),
    } : null,
  };
}

export function publicSyncStatus(raw) {
  const state = normalizeSyncState(raw);
  return {
    lastSuccess: state.lastSuccess,
    nextPoll: state.nextPoll,
    lastError: state.lastError,
    needsReauthentication: state.needsReauthentication,
    authLimitation: AUTH_LIMITATION,
    label: state.label,
  };
}

export async function collectMessageIds({ pageSize, listPage, historyPage, checkpoint }) {
  const size = Math.max(1, Number(pageSize) || 5);
  if (checkpoint?.historyId && historyPage) {
    try {
      const ids = [];
      let pageToken = '';
      let historyId = checkpoint.historyId;
      let labelId = null;
      do {
        const page = await historyPage({ startHistoryId: checkpoint.historyId, pageToken, maxResults: size });
        if (page?.historyId) historyId = String(page.historyId);
        if (page?.labelId) labelId = String(page.labelId);
        for (const record of page?.history || []) {
          for (const added of record.messagesAdded || []) {
            if (added.message?.id) ids.push(added.message.id);
          }
          for (const added of record.labelsAdded || []) {
            if (added.message?.id) ids.push(added.message.id);
          }
        }
        pageToken = page?.nextPageToken || '';
      } while (pageToken);
      return { ids: [...new Set(ids)], historyId, labelId, mode: 'history' };
    } catch (error) {
      if (isReauthError(error) || !isHistoryExpired(error)) throw error;
    }
  }
  const ids = [];
  let pageToken = '';
  let historyId = checkpoint?.historyId || null;
  let labelId = null;
  do {
    const page = await listPage({ pageToken, maxResults: size });
    if (page?.historyId) historyId = String(page.historyId);
    if (page?.labelId) labelId = String(page.labelId);
    for (const message of page?.messages || []) {
      if (message?.id) ids.push(message.id);
    }
    pageToken = page?.nextPageToken || '';
  } while (pageToken);
  return { ids, historyId, labelId, mode: 'full' };
}

export async function runMailboxSync({
  now,
  state,
  intervalMs = 60000,
  pageSize = 5,
  listPage,
  historyPage,
  readOffers,
  upsert,
  openInteractive,
}) {
  void openInteractive;
  const current = normalizeSyncState(state);
  if (state?.running) return { ...current, skipped: 'overlap', running: true };
  const forceRescan = current.rescan || current.parserVersion !== PARSER_VERSION;
  const seen = new Set(forceRescan ? [] : current.processedMessageIds);
  try {
    const collected = await collectMessageIds({
      pageSize,
      listPage,
      historyPage,
      checkpoint: forceRescan ? { ...current, historyId: null } : current,
    });
    let imported = 0;
    let already = 0;
    let skippedExpired = 0;
    const today = String(now).slice(0, 10);
    for (const id of collected.ids) {
      if (seen.has(id)) {
        already += 1;
        continue;
      }
      const offers = await readOffers(id);
      for (const offer of offers || []) {
        if (offer.expiresOn && offer.expiresOn < today) {
          skippedExpired += 1;
          continue;
        }
        const result = await upsert(offer);
        if (result === 'imported') imported += 1;
        else already += 1;
      }
      seen.add(id);
    }
    return {
      ...current,
      running: false,
      skipped: null,
      lastSuccess: now,
      lastError: null,
      needsReauthentication: false,
      attempt: 0,
      nextPoll: new Date(Date.parse(now) + intervalMs).toISOString(),
      historyId: collected.historyId || current.historyId,
      processedMessageIds: [...seen],
      capture: {},
      parserVersion: PARSER_VERSION,
      rescan: false,
      label: {
        name: current.label?.name || 'CVS',
        id: collected.labelId || current.label?.id || null,
        found: true,
      },
      imported,
      already,
      skippedExpired,
      found: collected.ids.length,
      rescanned: forceRescan,
    };
  } catch (error) {
    const attempt = current.attempt + 1;
    return {
      ...current,
      running: false,
      skipped: null,
      lastError: visibleSyncError(error),
      needsReauthentication: isReauthError(error),
      attempt,
      nextPoll: new Date(Date.parse(now) + backoffMs(attempt)).toISOString(),
      processedMessageIds: forceRescan ? current.processedMessageIds : [...seen],
      capture: {},
      label: isLabelMissing(error)
        ? { name: error.labelName || current.label?.name || 'CVS', id: null, found: false }
        : current.label,
      imported: 0,
      already: 0,
      found: 0,
    };
  }
}

export function startSyncLoop({ loadState, saveState, runOnce, setTimer = setTimeout, clearTimer = clearTimeout, clock = () => Date.now() }) {
  let timer = null;
  let running = false;
  let stopped = false;
  let resolveReady;
  let resolveIdle = null;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  async function tick() {
    if (stopped || running) return;
    running = true;
    let state = normalizeSyncState(null);
    try {
      state = normalizeSyncState(await loadState());
      const next = await runOnce(state);
      if (next?.skipped === 'overlap') return;
      state = normalizeSyncState(next);
      await saveState(state);
    } catch (error) {
      const attempt = state.attempt + 1;
      state = {
        ...state,
        running: false,
        lastError: visibleSyncError(error),
        needsReauthentication: isReauthError(error),
        attempt,
        nextPoll: new Date(clock() + backoffMs(attempt)).toISOString(),
      };
      await saveState(state);
    } finally {
      running = false;
      resolveReady();
      if (resolveIdle) {
        resolveIdle();
        resolveIdle = null;
      }
      if (!stopped) {
        const delay = Date.parse(state.nextPoll || '') - clock();
        const wait = Number.isFinite(delay) && delay > 0 ? delay : 60000;
        timer = setTimer(() => { tick(); }, wait);
      }
    }
  }
  tick();
  return {
    ready,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      if (!running) return Promise.resolve();
      return new Promise((resolve) => {
        resolveIdle = resolve;
      });
    },
  };
}
