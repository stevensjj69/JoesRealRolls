const MODULE_ID = "joes-real-rolls-bridge";
let bridgeSocket = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
let authenticated = false;
const pendingRolls = new Map();
const queuedPhysicalResults = new Map();
const replayExpirationTimers = new Map();
const REPLAY_TTL_MS = 60000;

function rollImageSource(payload) {
  const image = payload?.image;
  if (!["image/jpeg", "image/webp"].includes(image?.mime) || typeof image.data !== "string" ||
      image.data.length > 2100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return "";
  return `data:${image.mime};base64,${image.data}`;
}

Hooks.once("init", () => {
  CONFIG.Dice.fulfillment.methods[MODULE_ID] = {
    label: "Joes Real Rolls",
    icon: "fa-solid fa-camera",
    interactive: false,
    handler: requestPhysicalDie
  };
  game.settings.register(MODULE_ID, "bridgeUrl", {
    name: "Joes Real Rolls WebSocket URL",
    hint: "Copy the Module WebSocket URL from Joes Real Rolls. For remote use, it contains that PC's hostname or IP.",
    scope: "client", config: true, type: String, default: "ws://127.0.0.1:8765"
  });
  game.settings.register(MODULE_ID, "sharedToken", {
    name: "Joes Real Rolls Shared Token",
    hint: "Copy this from Integration > Foundry VTT Integration in the desktop application.",
    scope: "client", config: true, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "autoConnect", {
    name: "Connect Automatically",
    hint: "Reconnect automatically whenever Joes Real Rolls becomes available.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "gmReceiverOnly", {
    name: "GM Receives Physical Rolls",
    hint: "Recommended to prevent duplicate chat cards when several users enable the module.",
    scope: "world", config: true, type: Boolean, default: true,
    restricted: true
  });
  game.settings.register(MODULE_ID, "notifications", {
    name: "Show Connection Notifications",
    scope: "client", config: true, type: Boolean, default: true
  });
});

Hooks.once("ready", () => {
  restoreReplayExpirations();
  if (game.settings.get(MODULE_ID, "autoConnect")) connectBridge();
});

function requestPhysicalDie(term) {
  const faces = Number(term.faces);
  const queued = queuedPhysicalResults.get(faces) ?? [];
  if (queued.length) {
    const value = queued.shift();
    if (!queued.length) queuedPhysicalResults.delete(faces);
    return Promise.resolve(value);
  }
  if (!authenticated || bridgeSocket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Joes Real Rolls is not connected."));
  }
  const id = crypto.randomUUID();
  const count = Math.max(1, Number(term.number) || 1);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRolls.delete(id);
      sendBridge({type: "roll-cancel", id});
      reject(new Error("Timed out waiting for a reviewed physical die."));
    }, 300000);
    pendingRolls.set(id, {resolve, reject, timeout, faces, count});
    sendBridge({
      type: "roll-request", id, faces, count,
      denomination: String(term.denomination ?? `d${term.faces}`),
      formula: term.expression ?? term.formula ?? `${term.number ?? 1}d${term.faces}`
    });
  });
}

function sendBridge(payload) {
  if (bridgeSocket?.readyState === WebSocket.OPEN) bridgeSocket.send(JSON.stringify(payload));
}

function rejectPendingRolls(message) {
  for (const pending of pendingRolls.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  pendingRolls.clear();
}

function notify(message, type = "info") {
  if (game.settings.get(MODULE_ID, "notifications")) ui.notifications?.[type](message);
}

function connectBridge() {
  clearTimeout(reconnectTimer);
  const url = game.settings.get(MODULE_ID, "bridgeUrl");
  const token = game.settings.get(MODULE_ID, "sharedToken");
  if (!token) {
    notify("Joes Real Rolls: configure the shared token in Module Settings.", "warn");
    return;
  }
  try {
    bridgeSocket = new WebSocket(url);
  } catch (error) {
    scheduleReconnect();
    return;
  }
  bridgeSocket.addEventListener("open", () => {
    authenticated = false;
    bridgeSocket.send(JSON.stringify({type: "authenticate", token}));
  });
  bridgeSocket.addEventListener("message", async event => {
    let payload;
    try { payload = JSON.parse(event.data); } catch (_error) { return; }
    if (payload.type === "authentication_ok") {
      authenticated = true;
      reconnectDelay = 2000;
      notify("Joes Real Rolls connected.");
      return;
    }
    if (payload.type === "authentication_failed") {
      notify("Joes Real Rolls rejected the shared token.", "error");
      bridgeSocket.close();
      return;
    }
    if (payload.type === "roll-result" && authenticated) {
      if (rollImageSource(payload)) await receiveRollImage(payload);
      const pending = pendingRolls.get(payload.id);
      const values = Array.isArray(payload.values) ? payload.values.map(Number) : [Number(payload.value)];
      if (!pending || Number(payload.faces) !== pending.faces || values.length !== pending.count ||
          values.some(value => !Number.isInteger(value) || value < 1 || value > pending.faces)) return;
      clearTimeout(pending.timeout);
      pendingRolls.delete(payload.id);
      if (values.length > 1) queuedPhysicalResults.set(pending.faces, values.slice(1));
      pending.resolve(values[0]);
      return;
    }
    if (payload.type === "physical-roll" && authenticated) await receivePhysicalRoll(payload);
  });
  bridgeSocket.addEventListener("close", () => {
    const wasConnected = authenticated;
    authenticated = false;
    bridgeSocket = null;
    rejectPendingRolls("Joes Real Rolls disconnected during the roll.");
    queuedPhysicalResults.clear();
    if (wasConnected) notify("Joes Real Rolls disconnected; reconnecting…", "warn");
    scheduleReconnect();
  });
  bridgeSocket.addEventListener("error", () => bridgeSocket?.close());
}

function scheduleReconnect() {
  if (!game.settings.get(MODULE_ID, "autoConnect")) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBridge, reconnectDelay);
  reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function renderRoll(payload) {
  const dice = (payload.dice ?? []).map(die => {
    const confidence = die.confidence == null ? "" : ` <span class="pdr-confidence">${Math.round(die.confidence * 100)}%</span>`;
    const unknown = die.unknown ? " pdr-unknown" : "";
    return `<li class="${unknown}"><strong>${escapeHtml(die.type)}</strong>: ${escapeHtml(die.value)}${confidence}</li>`;
  }).join("");
  const total = payload.total == null ? "" : `<div class="pdr-total">Total: ${escapeHtml(payload.total)}</div>`;
  const review = escapeHtml(payload.review ?? "unreviewed");
  const source = rollImageSource(payload);
  const media = source
    ? `<div class="pdr-image-frame"><img class="pdr-roll-image" src="${source}" alt="Animated physical dice roll replay" title="Click to enlarge the roll replay"></div>`
    : "";
  return `<section class="physical-dice-roll"><header>Physical Dice Roll</header>${media}<ul>${dice}</ul>${total}<footer>Status: ${review}</footer></section>`;
}

function renderImageOnly(payload) {
  const source = rollImageSource(payload);
  if (!source) return "";
  return `<section class="physical-dice-roll"><header>Captured Physical Roll</header><div class="pdr-image-frame"><img class="pdr-roll-image" src="${source}" alt="Animated physical dice roll replay" title="Click to enlarge the roll replay"></div></section>`;
}

function replayExpiredContent(content) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(content ?? "");
  for (const frame of wrapper.querySelectorAll(".pdr-image-frame")) {
    const notice = document.createElement("p");
    notice.className = "pdr-replay-expired";
    notice.textContent = "Roll replay expired after 1 minute.";
    frame.replaceWith(notice);
  }
  return wrapper.innerHTML;
}

async function expireReplay(message) {
  if (!message || !message.content?.includes("pdr-image-frame")) return;
  replayExpirationTimers.delete(message.id);
  await message.update({
    content: replayExpiredContent(message.content),
    [`flags.${MODULE_ID}.replayExpired`]: true,
    [`flags.${MODULE_ID}.replayExpiresAt`]: null
  });
}

function scheduleReplayExpiration(message, expiresAt) {
  if (!message?.id || !Number.isFinite(expiresAt)) return;
  clearTimeout(replayExpirationTimers.get(message.id));
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    expireReplay(message).catch(error => console.warn(`${MODULE_ID} | Could not expire replay`, error));
  }, delay);
  replayExpirationTimers.set(message.id, timer);
}

function restoreReplayExpirations() {
  for (const message of game.messages ?? []) {
    const expiresAt = Number(message.getFlag(MODULE_ID, "replayExpiresAt"));
    if (Number.isFinite(expiresAt) && expiresAt > 0) scheduleReplayExpiration(message, expiresAt);
  }
}

async function receivePhysicalRoll(payload) {
  if (!payload.id || !Array.isArray(payload.dice)) return;
  if (game.settings.get(MODULE_ID, "gmReceiverOnly") && !game.user.isGM) return;
  const content = renderRoll(payload);
  const existing = game.messages.find(message => message.getFlag(MODULE_ID, "rollId") === payload.id);
  const flagPayload = {...payload};
  delete flagPayload.image;
  const expiresAt = Date.now() + REPLAY_TTL_MS;
  const flags = {[MODULE_ID]: {
    rollId: payload.id,
    payload: flagPayload,
    replayExpiresAt: rollImageSource(payload) ? expiresAt : null
  }};
  let message;
  if (existing) {
    message = await existing.update({content, flags});
  } else {
    message = await ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker(),
      content,
      flags
    });
  }
  if (rollImageSource(payload)) scheduleReplayExpiration(message, expiresAt);
}

async function receiveRollImage(payload) {
  if (game.settings.get(MODULE_ID, "gmReceiverOnly") && !game.user.isGM) return;
  const content = renderImageOnly(payload);
  if (!content) return;
  const rollId = `capture-${payload.id}`;
  if (game.messages.find(message => message.getFlag(MODULE_ID, "rollId") === rollId)) return;
  const flagPayload = {...payload};
  delete flagPayload.image;
  const expiresAt = Date.now() + REPLAY_TTL_MS;
  const message = await ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker(),
    content,
    flags: {[MODULE_ID]: {rollId, payload: flagPayload, replayExpiresAt: expiresAt}}
  });
  scheduleReplayExpiration(message, expiresAt);
}

document.addEventListener("click", event => {
  const image = event.target.closest?.(".pdr-roll-image");
  if (!image) return;
  event.preventDefault();
  const Popout = globalThis.ImagePopout ?? globalThis.foundry?.applications?.apps?.ImagePopout;
  if (Popout) new Popout(image.src, {title: "Captured Physical Roll"}).render(true);
  else window.open(image.src, "_blank", "noopener,noreferrer");
});
