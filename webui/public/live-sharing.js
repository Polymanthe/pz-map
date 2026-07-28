const HOST_STORAGE_KEY = 'pz-map-live-host-v1';
const EMIT_INTERVAL_MS = 100;
const ACK_TIMEOUT_MS = 7000;

export function isValidSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
}

export function parseLiveSessionId(fragment) {
  const value = String(fragment ?? '').replace(/^#/, '');
  const params = new URLSearchParams(value);
  const sessions = params.getAll('live');
  return sessions.length === 1 && isValidSessionId(sessions[0]) ? sessions[0] : null;
}

export function buildLiveReaderUrl(currentUrl, sessionId) {
  if (!isValidSessionId(sessionId)) throw new TypeError('Invalid live session id');
  const current = new URL(typeof currentUrl === 'string' ? currentUrl : currentUrl.href);
  const readerUrl = new URL(`${current.pathname}${current.search}`, current.origin);
  readerUrl.hash = new URLSearchParams({ live: sessionId }).toString();
  return readerUrl.href;
}

export function isValidPzPosition(position) {
  return position !== null
    && typeof position === 'object'
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isInteger(position.z);
}

export function isValidPositionChanged(payload) {
  const observedAt = payload?.observedAt;
  const hasValidObservedAt = (typeof observedAt === 'string' && Number.isFinite(Date.parse(observedAt)))
    || (typeof observedAt === 'number' && Number.isFinite(observedAt));
  return payload?.source?.id === 'host'
    && payload.source.type === 'cursor'
    && isValidPzPosition(payload.position)
    && Number.isSafeInteger(payload.sequence)
    && payload.sequence >= 0
    && hasValidObservedAt;
}

function expirationTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function isValidStoredHost(value) {
  return value !== null
    && typeof value === 'object'
    && isValidSessionId(value.sessionId)
    && typeof value.publisherToken === 'string'
    && value.publisherToken.length > 0
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0
    && Number.isFinite(expirationTimestamp(value.expiresAt));
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      reject(new Error(`${eventName} timeout`));
    }, ACK_TIMEOUT_MS);
    const acknowledge = (response) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(response);
    };
    if (payload === undefined) socket.emit(eventName, acknowledge);
    else socket.emit(eventName, payload, acknowledge);
  });
}

export function initLiveSharing({
  onPointerMove,
  isPositionInside,
  showRemoteCursor,
  clearRemoteCursor,
  root = document,
  ioFactory = globalThis.io,
  now = () => Date.now(),
}) {
  const elements = {
    copy: root.querySelector('#live-copy'),
    help: root.querySelector('#live-help'),
    hostPanel: root.querySelector('#live-host-panel'),
    link: root.querySelector('#live-reader-link'),
    share: root.querySelector('#live-share'),
    status: root.querySelector('#live-status'),
    statusRow: root.querySelector('.live-status'),
    stop: root.querySelector('#live-stop'),
  };
  if (Object.values(elements).some((element) => !element)) return null;

  const view = root.defaultView ?? window;
  const coarsePointer = view.matchMedia('(pointer: coarse)').matches;
  let socket = null;
  let mode = 'idle';
  let sessionId = parseLiveSessionId(view.location.hash);
  let publisherToken = null;
  let expiresAt = null;
  let sequence = 0;
  let lastReceivedSequence = -1;
  let lastEmitAt = -Infinity;
  let pendingCreate = false;
  let pendingStop = false;
  let joinInFlight = false;
  let hostResumeInFlight = false;
  let sessionEnded = false;
  let everConnected = false;
  let joinRetryTimer = null;

  function storage() {
    try {
      return view.sessionStorage;
    } catch {
      return null;
    }
  }

  function removeStoredHost() {
    try {
      storage()?.removeItem(HOST_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
  }

  function saveHost() {
    try {
      storage()?.setItem(HOST_STORAGE_KEY, JSON.stringify({
        sessionId,
        publisherToken,
        expiresAt,
        sequence,
      }));
    } catch {
      // Sharing still works for the lifetime of the current page.
    }
  }

  function loadStoredHost() {
    try {
      const value = JSON.parse(storage()?.getItem(HOST_STORAGE_KEY) ?? 'null');
      if (isValidStoredHost(value)) return value;
    } catch {
      // Invalid or unavailable session storage is treated as empty.
    }
    removeStoredHost();
    return null;
  }

  function setStatus(state, label, help) {
    elements.statusRow.dataset.state = state;
    elements.status.textContent = label;
    elements.help.textContent = help;
  }

  function renderMode() {
    const isHost = mode === 'host';
    elements.hostPanel.hidden = !isHost;
    elements.share.hidden = mode !== 'idle';
    elements.share.disabled = coarsePointer || typeof ioFactory !== 'function' || pendingCreate;
    elements.stop.disabled = pendingStop;
    if (isHost && sessionId) elements.link.value = buildLiveReaderUrl(view.location.href, sessionId);
    else elements.link.value = '';
  }

  function expireSession() {
    sessionEnded = true;
    pendingCreate = false;
    pendingStop = false;
    joinInFlight = false;
    hostResumeInFlight = false;
    window.clearTimeout(joinRetryTimer);
    clearRemoteCursor();
    if (mode === 'host') {
      mode = 'idle';
      sessionId = null;
      publisherToken = null;
      expiresAt = null;
      removeStoredHost();
    }
    renderMode();
    setStatus('expired', 'Session expirée', mode === 'reader'
      ? 'Le curseur partagé n’est plus disponible.'
      : 'Vous pouvez démarrer un nouveau partage.');
  }

  async function createSession() {
    if (!socket?.connected || !pendingCreate) return;
    try {
      const response = await emitWithAck(socket, 'session:create');
      if (!pendingCreate) return;
      const valid = response?.ok === true
        && isValidSessionId(response.sessionId)
        && typeof response.publisherToken === 'string'
        && response.publisherToken.length > 0
        && expirationTimestamp(response.expiresAt) > now();
      if (!valid) throw new Error('Invalid session:create response');
      mode = 'host';
      sessionId = response.sessionId;
      publisherToken = response.publisherToken;
      expiresAt = response.expiresAt;
      sequence = 0;
      sessionEnded = false;
      pendingCreate = false;
      saveHost();
      renderMode();
      setStatus('live', 'Direct', 'Votre curseur est visible par les lecteurs du lien.');
    } catch {
      pendingCreate = false;
      renderMode();
      setStatus('offline', 'Hors ligne', 'Impossible de créer le partage pour le moment.');
    }
  }

  async function joinSession() {
    if (!socket?.connected || mode !== 'reader' || sessionEnded || joinInFlight) return;
    joinInFlight = true;
    window.clearTimeout(joinRetryTimer);
    setStatus(everConnected ? 'reconnecting' : 'connecting', everConnected ? 'Reconnexion' : 'Connexion', 'Connexion au curseur partagé…');
    try {
      const response = await emitWithAck(socket, 'session:join', { sessionId });
      if (mode !== 'reader' || sessionEnded) return;
      const joined = response?.ok === true
        && response.session?.id === sessionId
        && expirationTimestamp(response.session.expiresAt) > now();
      if (!joined && response?.error?.code === 'SESSION_NOT_FOUND') {
        expireSession();
        return;
      }
      if (!joined) throw new Error('Unable to join session');
      expiresAt = response.session.expiresAt;
      lastReceivedSequence = -1;
      if (isValidPzPosition(response.session.position) && isPositionInside(response.session.position)) {
        showRemoteCursor(response.session.position);
      } else {
        clearRemoteCursor();
      }
      setStatus('live', 'Direct', 'Vous suivez le curseur partagé.');
    } catch {
      if (mode === 'reader' && !sessionEnded && socket?.connected) {
        setStatus('reconnecting', 'Reconnexion', 'Nouvelle tentative de connexion au partage…');
        joinRetryTimer = window.setTimeout(joinSession, 2000);
      }
    } finally {
      joinInFlight = false;
    }
  }

  function requestShare() {
    if (coarsePointer || typeof ioFactory !== 'function' || pendingCreate) return;
    pendingCreate = true;
    sessionEnded = false;
    renderMode();
    setStatus('connecting', 'Connexion', 'Création du lien lecteur…');
    if (socket.connected) createSession();
    else socket.connect();
  }

  function finalizeStop() {
    pendingCreate = false;
    pendingStop = false;
    sessionEnded = true;
    mode = 'idle';
    sessionId = null;
    publisherToken = null;
    expiresAt = null;
    sequence = 0;
    removeStoredHost();
    renderMode();
    setStatus('offline', 'Hors ligne', 'Le partage de votre curseur est arrêté.');
  }

  async function stopSharing() {
    if (mode !== 'host' || !sessionId || !publisherToken) return;
    if (!pendingStop) {
      pendingStop = true;
      renderMode();
      setStatus('reconnecting', 'Arrêt en cours', socket?.connected
        ? 'Fermeture de la session…'
        : 'La session sera fermée dès le retour de la connexion.');
    }
    if (!socket?.connected) return;

    try {
      const response = await emitWithAck(socket, 'session:stop', { sessionId, publisherToken });
      if (response?.ok === true || response?.error?.code === 'SESSION_NOT_FOUND') finalizeStop();
      else throw new Error('Unable to stop session');
    } catch {
      if (mode === 'host' && pendingStop) {
        setStatus('reconnecting', 'Arrêt en attente', 'Nouvelle tentative dès que le service répondra.');
      }
    }
  }

  async function resumeHost() {
    if (!socket?.connected || mode !== 'host' || sessionEnded || pendingStop || hostResumeInFlight) return;
    hostResumeInFlight = true;
    window.clearTimeout(joinRetryTimer);
    try {
      const response = await emitWithAck(socket, 'session:join', { sessionId });
      if (response?.ok === true && response.session?.id === sessionId) {
        expiresAt = response.session.expiresAt;
        saveHost();
        setStatus('live', 'Direct', 'Votre curseur est visible par les lecteurs du lien.');
      } else if (response?.error?.code === 'SESSION_NOT_FOUND') {
        expireSession();
      } else {
        throw new Error('Unable to resume session');
      }
    } catch {
      if (mode === 'host' && !sessionEnded && !pendingStop) {
        setStatus('reconnecting', 'Reconnexion', 'Nouvelle tentative de reprise du partage…');
        joinRetryTimer = window.setTimeout(resumeHost, 2000);
      }
    } finally {
      hostResumeInFlight = false;
    }
  }

  async function copyReaderLink() {
    const link = elements.link.value;
    try {
      if (view.navigator.clipboard?.writeText) await view.navigator.clipboard.writeText(link);
      else {
        elements.link.select();
        root.execCommand('copy');
      }
      elements.copy.textContent = 'Copié';
      window.setTimeout(() => { elements.copy.textContent = 'Copier'; }, 1400);
    } catch {
      elements.link.focus();
      elements.link.select();
      setStatus('live', 'Direct', 'Sélectionnez le lien puis copiez-le manuellement.');
    }
  }

  function publishPosition(position) {
    if (mode !== 'host' || sessionEnded || pendingStop || !socket?.connected || !isValidPzPosition(position)) return;
    const emittedAt = now();
    if (!isPositionInside(position) || emittedAt - lastEmitAt < EMIT_INTERVAL_MS) return;
    lastEmitAt = emittedAt;
    sequence += 1;
    saveHost();
    const emitter = socket.volatile && typeof socket.volatile.emit === 'function' ? socket.volatile : socket;
    emitter.emit('cursor:update', {
      sessionId,
      publisherToken,
      position: { x: position.x, y: position.y, z: position.z },
      sequence,
    });
  }

  elements.share.addEventListener('click', requestShare);
  elements.stop.addEventListener('click', stopSharing);
  elements.copy.addEventListener('click', copyReaderLink);
  onPointerMove(publishPosition);

  if (sessionId) {
    mode = 'reader';
    setStatus('connecting', 'Connexion', 'Connexion au curseur partagé…');
  } else if (!coarsePointer) {
    const host = loadStoredHost();
    if (host) {
      mode = 'host';
      sessionId = host.sessionId;
      publisherToken = host.publisherToken;
      expiresAt = host.expiresAt;
      sequence = host.sequence;
      setStatus('reconnecting', 'Reconnexion', 'Reprise de votre partage…');
    }
  }
  renderMode();

  if (typeof ioFactory !== 'function') {
    setStatus('offline', 'Hors ligne', mode === 'reader'
      ? 'Le service temps réel est indisponible. La carte reste utilisable.'
      : 'Le service temps réel est indisponible.');
    return null;
  }

  try {
    socket = ioFactory({ autoConnect: false });
  } catch {
    setStatus('offline', 'Hors ligne', 'Le service temps réel est indisponible.');
    elements.share.disabled = true;
    return null;
  }

  socket.on('connect', () => {
    if (mode === 'reader') joinSession();
    else if (mode === 'host' && !sessionEnded) {
      if (pendingStop) stopSharing();
      else resumeHost();
    } else if (pendingCreate) createSession();
    everConnected = true;
  });
  socket.on('disconnect', () => {
    clearRemoteCursor();
    if ((mode === 'host' || mode === 'reader') && !sessionEnded) {
      setStatus('reconnecting', pendingStop ? 'Arrêt en attente' : 'Reconnexion', pendingStop
        ? 'La session sera fermée dès le retour de la connexion.'
        : 'Connexion interrompue, nouvelle tentative en cours…');
    } else if (!pendingCreate) {
      setStatus('offline', 'Hors ligne', 'Aucun partage actif.');
    }
  });
  socket.on('connect_error', () => {
    if ((mode === 'host' || mode === 'reader' || pendingCreate) && !sessionEnded) {
      setStatus(everConnected ? 'reconnecting' : 'offline', everConnected ? 'Reconnexion' : 'Hors ligne', 'Service temps réel indisponible, nouvelle tentative en cours…');
    }
  });
  socket.on('position:changed', (payload) => {
    if (mode !== 'reader' || sessionEnded || !isValidPositionChanged(payload)) return;
    if (payload.sequence <= lastReceivedSequence || !isPositionInside(payload.position)) return;
    lastReceivedSequence = payload.sequence;
    showRemoteCursor(payload.position);
    setStatus('live', 'Direct', 'Vous suivez le curseur partagé.');
  });
  socket.on('session:expired', (payload) => {
    if (payload?.sessionId === sessionId && (mode === 'host' || mode === 'reader') && !sessionEnded) expireSession();
  });

  if (mode === 'host' || mode === 'reader') socket.connect();
  else setStatus('offline', 'Hors ligne', coarsePointer
    ? 'La publication nécessite un pointeur précis. La lecture d’un lien reste disponible.'
    : 'Aucun partage actif.');

  return { stop: stopSharing };
}
