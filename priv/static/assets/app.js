const NICK_STORAGE_KEY = "blockball-name";
const AUTH_STORAGE_KEY = "blockball-auth";
const LOBBY_POLL_MS = 5000;

const authConfig = readAuthConfig();

const canvas = document.querySelector("#game-canvas");
const ctx = canvas.getContext("2d");

const canvasEmpty = document.querySelector("#canvas-empty");

const redScore = document.querySelector("#red-score");
const blueScore = document.querySelector("#blue-score");
const matchTimer = document.querySelector("#match-timer");
const matchState = document.querySelector("#match-state");
const scorebug = document.querySelector("#scorebug");
const matchResult = document.querySelector("#match-result");
const matchResultTitle = document.querySelector("#match-result-title");
const matchResultRed = document.querySelector("#match-result-red");
const matchResultBlue = document.querySelector("#match-result-blue");

const lobbyNick = document.querySelector("#lobby-nick");
const lobbyWallet = document.querySelector("#lobby-wallet");
const nicknameWallet = document.querySelector("#nickname-wallet");
const lobbyMeta = document.querySelector("#lobby-meta");
const roomRows = document.querySelector("#room-rows");
const nicknameForm = document.querySelector("#nickname-form");
const nicknameInput = document.querySelector("#nickname-input");
const privyEmailForm = document.querySelector("#privy-email-form");
const privyCodeForm = document.querySelector("#privy-code-form");
const privyEmailInput = document.querySelector("#privy-email-input");
const privyCodeInput = document.querySelector("#privy-code-input");
const authStatus = document.querySelector("#auth-status");
const authProfileCard = document.querySelector("#auth-profile-card");
const authProfileName = document.querySelector("#auth-profile-name");
const authProfileWallet = document.querySelector("#auth-profile-wallet");
const authContinueButton = document.querySelector("#auth-continue-button");
const devAuthButton = document.querySelector("#dev-auth-button");
const createRoomPanel = document.querySelector("#create-room-panel");
const createRoomForm = document.querySelector("#create-room-form");
const createRoomName = document.querySelector("#create-room-name");
const createRoomMode = document.querySelector("#create-room-mode");
const waitingOverlay = document.querySelector("#waiting-room-overlay");
const waitingRoomTitle = document.querySelector("#waiting-room-title");
const waitingPlayerCount = document.querySelector("#waiting-player-count");
const waitingCapacity = document.querySelector("#waiting-capacity");
const waitingRoster = document.querySelector("#waiting-roster");
const waitingHint = document.querySelector("#waiting-hint");
const startMatchBtn = document.querySelector("#start-match-btn");
const toast = document.querySelector("#toast");

const MODE_LABELS = {
  vs1: "1v1",
  vs2: "2v2",
  vs3: "3v3",
  vs4: "4v4",
  practice: "Practice",
  public: "4v4"
};

const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");

const state = {
  screen: "landing",
  nickname: localStorage.getItem(NICK_STORAGE_KEY) || "",
  profile: loadAuthProfile(),
  authToken: null,
  socket: null,
  topic: null,
  joinRef: null,
  ref: 0,
  heartbeat: null,
  playerId: null,
  clientId: null,
  roomId: null,
  spectator: false,
  snapshot: null,
  snapshotAt: 0,
  receipts: [],
  leaderboard: [],
  input: { up: false, down: false, left: false, right: false, kick: false },
  lastSent: "",
  rooms: [],
  pollHandle: null,
  toastHandle: null,
  pendingRoomId: null,
  bubbles: new Map(),
  chatFocused: false,
  kickCooldowns: new Map(),
  audioReady: false,
  prevScores: { red: 0, blue: 0 },
  scoresSeen: false,
  goalFx: null,
  hostId: null,
  roomCapacity: 0,
  roomMode: null,
  pendingStartRef: null
};

let privyModulePromise = null;
let privyClientPromise = null;
let privyIframe = null;
let privyMessageListener = null;
let audioCtx = null;

function readAuthConfig() {
  const el = document.querySelector("#blockball-auth-config");
  if (!el || !el.textContent) return {};
  try {
    return JSON.parse(el.textContent);
  } catch (err) {
    console.warn("Auth config parse failed:", err);
    return {};
  }
}

function loadAuthProfile() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function hasPrivyConfig() {
  return Boolean(authConfig.privyAppId && authConfig.privyClientId);
}

function shortAddress(address) {
  if (!address) return "—";
  const value = String(address);
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function authDisplayName(profile = state.profile) {
  if (!profile) return "Not registered";
  if (profile.kind === "privy") return profile.email || "Privy wallet";
  if (profile.kind === "external") return profile.provider || "External wallet";
  return profile.provider || "Local account";
}

function setAuthStatus(message) {
  if (authStatus) authStatus.textContent = message || "";
}

function setAuthProfile(profile, opts = {}) {
  state.profile = {
    ...profile,
    issuedAt: profile.issuedAt || new Date().toISOString()
  };
  state.authToken = opts.token || null;
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state.profile));
  renderAccountState();
}

function clearAuthProfile() {
  state.profile = null;
  state.authToken = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  renderAccountState();
}

function renderAccountState() {
  const profile = state.profile;
  const label = profile ? `${authDisplayName(profile)} · ${shortAddress(profile.address)}` : "Wallet · —";

  if (lobbyWallet) lobbyWallet.textContent = profile ? `Wallet · ${shortAddress(profile.address)}` : "Wallet · —";
  if (nicknameWallet) nicknameWallet.textContent = profile ? `Wallet · ${shortAddress(profile.address)}` : "Wallet · —";

  if (authProfileCard) authProfileCard.hidden = !profile;
  if (authProfileName) authProfileName.textContent = authDisplayName(profile);
  if (authProfileWallet) authProfileWallet.textContent = label;
  if (authContinueButton) authContinueButton.hidden = !profile;
  if (devAuthButton) devAuthButton.hidden = !authConfig.devAuthEnabled;

  if (!profile && state.screen === "signup") {
    setAuthStatus(
      hasPrivyConfig()
        ? "Use email OTP to create a Privy embedded wallet, or connect an injected wallet."
        : "Set PRIVY_APP_ID and PRIVY_CLIENT_ID to enable Privy email login. Local dev account is available in development."
    );
  }
}

function registrationPayload() {
  if (!state.profile) return null;

  return {
    kind: state.profile.kind,
    provider: state.profile.provider,
    wallet_address: state.profile.address || null,
    privy_user_id: state.profile.privyUserId || null,
    email: state.profile.email || null,
    chain_id: state.profile.chainId || null,
    signed_message: state.profile.signedMessage || null,
    signature: state.profile.signature || null,
    issued_at: state.profile.issuedAt || null,
    access_token: state.authToken || null
  };
}

async function loadPrivyModule() {
  if (!privyModulePromise) {
    if (!authConfig.privySdkUrl) throw new Error("Missing Privy SDK URL.");
    privyModulePromise = import(authConfig.privySdkUrl);
  }
  return privyModulePromise;
}

async function getPrivyClient() {
  if (!hasPrivyConfig()) {
    throw new Error("Privy app ID/client ID are not configured.");
  }

  if (!privyClientPromise) {
    privyClientPromise = (async () => {
      const mod = await loadPrivyModule();
      const Privy = mod.default;
      if (!Privy || !mod.LocalStorage) throw new Error("Privy SDK did not expose the expected core exports.");

      const privy = new Privy({
        appId: authConfig.privyAppId,
        clientId: authConfig.privyClientId,
        storage: new mod.LocalStorage()
      });

      await privy.initialize();
      mountPrivySecureContext(privy);
      return { privy, mod };
    })();
  }

  return privyClientPromise;
}

function mountPrivySecureContext(privy) {
  if (privyIframe) return;

  privyIframe = document.createElement("iframe");
  privyIframe.src = privy.embeddedWallet.getURL();
  privyIframe.title = "Privy embedded wallet context";
  privyIframe.style.display = "none";
  document.body.appendChild(privyIframe);
  privy.setMessagePoster(privyIframe.contentWindow);

  privyMessageListener = (event) => {
    if (event.source !== privyIframe.contentWindow) return;
    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    privy.embeddedWallet.onMessage(data);
  };
  window.addEventListener("message", privyMessageListener);
}

function extractPrivyEmail(user) {
  const accounts = user?.linkedAccounts || user?.linked_accounts || [];
  const account = accounts.find((item) => item.type === "email" || item.email || item.address?.includes("@"));
  return account?.email || account?.address || user?.email?.address || user?.email || "";
}

function getEmbeddedEthereumWallet(user, mod) {
  try {
    return mod.getUserEmbeddedEthereumWallet(user);
  } catch (_) {
    return null;
  }
}

async function buildPrivyProfile(user, privy, mod) {
  let currentUser = user;
  let wallet = getEmbeddedEthereumWallet(currentUser, mod);

  if (!wallet) {
    const created = await privy.embeddedWallet.create({});
    currentUser = created.user || currentUser;
    wallet = getEmbeddedEthereumWallet(currentUser, mod);
  }

  if (!wallet) throw new Error("Privy did not return an embedded Ethereum wallet.");

  const { entropyId, entropyIdVerifier } = mod.getEntropyDetailsFromUser(currentUser);
  await privy.embeddedWallet.getEthereumProvider({
    wallet,
    entropyId,
    entropyIdVerifier
  });

  const token = await privy.getAccessToken().catch(() => null);

  return {
    token,
    profile: {
      kind: "privy",
      provider: "Privy Embedded Wallet",
      privyUserId: currentUser.id,
      email: extractPrivyEmail(currentUser),
      address: wallet.address,
      issuedAt: new Date().toISOString()
    }
  };
}

async function hydratePrivySession() {
  if (!hasPrivyConfig() || state.profile) return;

  try {
    const { privy, mod } = await getPrivyClient();
    const { user } = await privy.user.get();
    if (!user) return;
    const { profile, token } = await buildPrivyProfile(user, privy, mod);
    setAuthProfile(profile, { token });
    setAuthStatus("Privy session restored.");
  } catch (err) {
    console.warn("Privy session restore failed:", err);
  }
}

async function submitPrivyEmail(event) {
  event.preventDefault();
  const email = privyEmailInput.value.trim();
  if (!email) return;

  try {
    setAuthStatus("Sending Privy verification code…");
    const { privy } = await getPrivyClient();
    await privy.auth.email.sendCode(email);
    privyCodeForm.hidden = false;
    setAuthStatus(`Verification code sent to ${email}.`);
    setTimeout(() => privyCodeInput.focus(), 30);
  } catch (err) {
    console.warn(err);
    setAuthStatus(err.message || "Privy email sign in failed.");
  }
}

async function submitPrivyCode(event) {
  event.preventDefault();
  const email = privyEmailInput.value.trim();
  const code = privyCodeInput.value.trim();
  if (!email || !code) return;

  try {
    setAuthStatus("Verifying and creating embedded wallet…");
    const { privy, mod } = await getPrivyClient();
    const session = await privy.auth.email.loginWithCode(email, code);
    const { profile, token } = await buildPrivyProfile(session.user, privy, mod);
    setAuthProfile(profile, { token });
    setAuthStatus("Privy embedded wallet ready.");
    continueAfterAuth();
  } catch (err) {
    console.warn(err);
    setAuthStatus(err.message || "Verification failed.");
  }
}

async function connectExternalWallet() {
  const provider = window.ethereum;
  if (!provider || !provider.request) {
    setAuthStatus("No injected wallet found. Install MetaMask, Rabby, or Coinbase Wallet, or use Privy email login.");
    return;
  }

  try {
    setAuthStatus("Requesting wallet connection…");
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const address = accounts && accounts[0];
    if (!address) throw new Error("No wallet account returned.");

    const nonce = Math.random().toString(36).slice(2);
    const issuedAt = new Date().toISOString();
    const signedMessage = `Blockball registration\nAddress: ${address}\nIssued At: ${issuedAt}\nNonce: ${nonce}`;
    const signature = await provider.request({
      method: "personal_sign",
      params: [signedMessage, address]
    });
    const chainId = await provider.request({ method: "eth_chainId" }).catch(() => null);
    const providerName = provider.isCoinbaseWallet
      ? "Coinbase Wallet"
      : provider.isRabby
        ? "Rabby"
        : provider.isMetaMask
          ? "MetaMask"
          : "External Wallet";

    setAuthProfile({
      kind: "external",
      provider: providerName,
      address,
      chainId,
      signedMessage,
      signature,
      issuedAt
    });
    setAuthStatus(`${providerName} registered.`);
    continueAfterAuth();
  } catch (err) {
    console.warn(err);
    setAuthStatus(err.message || "Wallet connection failed.");
  }
}

function useDevAuth() {
  if (!authConfig.devAuthEnabled) return;
  const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  setAuthProfile({
    kind: "dev",
    provider: "Local Dev Account",
    address: `0xdev${id}`,
    issuedAt: new Date().toISOString()
  });
  setAuthStatus("Local dev account registered.");
  continueAfterAuth();
}

function continueAfterAuth() {
  if (!state.profile) {
    showScreen("signup");
    return;
  }

  if (!state.nickname) {
    showScreen("nickname");
    setTimeout(() => nicknameInput.focus(), 30);
    return;
  }

  if (state.pendingRoomId) {
    const roomId = state.pendingRoomId;
    state.pendingRoomId = null;
    enterGame(roomId);
    return;
  }

  showScreen("lobby");
}

function signOut() {
  if (state.socket) leaveGame();
  clearAuthProfile();
  state.nickname = "";
  state.pendingRoomId = null;
  localStorage.removeItem(NICK_STORAGE_KEY);
  nicknameInput.value = "";
  if (lobbyNick) lobbyNick.textContent = "—";
  showScreen("signup");
}

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
    } catch (_) {
      return null;
    }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function unlockAudio() {
  const ctx = ensureAudioCtx();
  if (ctx && ctx.state === "running") state.audioReady = true;
}

function playKickSound(intensity = 1) {
  const ctx = ensureAudioCtx();
  if (!ctx || ctx.state !== "running") return;

  const now = ctx.currentTime;
  const gain = Math.min(0.6, 0.35 * intensity);

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(gain, now + 0.005);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  master.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(230, now);
  osc.frequency.exponentialRampToValueAtTime(55, now + 0.18);
  osc.connect(master);
  osc.start(now);
  osc.stop(now + 0.25);

  const noiseLen = Math.floor(ctx.sampleRate * 0.05);
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.22 * intensity;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1400;
  noise.connect(hp).connect(noiseGain).connect(master);
  noise.start(now);
  noise.stop(now + 0.05);
}

function detectKicks(snapshot) {
  if (!snapshot || !snapshot.players) return;
  const seen = new Set();
  let played = false;
  for (const p of snapshot.players) {
    seen.add(p.id);
    const prev = state.kickCooldowns.get(p.id) || 0;
    const curr = p.kick_cooldown || 0;
    if (!played && prev < 0.05 && curr > 0.1) {
      const intensity = p.id === state.playerId ? 1.0 : 0.7;
      playKickSound(intensity);
      played = true;
    }
    state.kickCooldowns.set(p.id, curr);
  }
  for (const id of state.kickCooldowns.keys()) {
    if (!seen.has(id)) state.kickCooldowns.delete(id);
  }
}

function playGoalSound() {
  const audio = ensureAudioCtx();
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime;

  const master = audio.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.42, now + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  master.connect(audio.destination);

  const notes = [
    { f: 523.25, t: 0.0 },
    { f: 659.25, t: 0.12 },
    { f: 783.99, t: 0.24 },
    { f: 1046.5, t: 0.36 }
  ];
  for (const { f, t } of notes) {
    const osc = audio.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f, now + t);
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(0.5, now + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35);
    osc.connect(g).connect(master);
    osc.start(now + t);
    osc.stop(now + t + 0.4);
  }
}

const GOAL_FX_MS = 1800;

function triggerGoalFx(team) {
  state.goalFx = { team, start: performance.now() };
  playGoalSound();
  const el = team === "red" ? redScore : blueScore;
  if (el) {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }
}

function detectGoals(match) {
  if (!match) return;
  const red = match.red_score || 0;
  const blue = match.blue_score || 0;
  if (state.scoresSeen) {
    if (red > state.prevScores.red) triggerGoalFx("red");
    else if (blue > state.prevScores.blue) triggerGoalFx("blue");
  }
  state.prevScores = { red, blue };
  state.scoresSeen = true;
}

const BUBBLE_TTL_MS = 4000;

function pushBubble(name, text) {
  if (!name || !text) return;
  state.bubbles.set(name, { text: String(text).slice(0, 80), until: performance.now() + BUBBLE_TTL_MS });
}

const keyMap = new Map([
  ["KeyW", "up"],
  ["ArrowUp", "up"],
  ["KeyS", "down"],
  ["ArrowDown", "down"],
  ["KeyA", "left"],
  ["ArrowLeft", "left"],
  ["KeyD", "right"],
  ["ArrowRight", "right"],
  ["Space", "kick"],
  ["ShiftLeft", "kick"],
  ["ShiftRight", "kick"]
]);

const fallbackSnapshot = {
  arena: { width: 1600, height: 900, goal_size: 260, goal_depth: 64, corner_radius: 96 },
  match: {
    id: "offline",
    season_id: "blockball-alpha-01",
    status: "waiting",
    red_score: 0,
    blue_score: 0,
    time_left: 120,
    message: "Join a room to start."
  },
  ball: { x: 800, y: 450, radius: 11, vx: 0, vy: 0 },
  players: []
};

function urlForScreen(name, roomId) {
  switch (name) {
    case "landing":
      return "/";
    case "signup":
      return "/signup";
    case "nickname":
      return "/play";
    case "lobby":
      return "/lobby";
    case "game":
      return roomId ? `/play/${encodeURIComponent(roomId)}` : "/play";
    default:
      return "/";
  }
}

function showScreen(name, opts = {}) {
  state.screen = name;
  document.querySelectorAll("[data-screen]").forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });

  if (opts.pushUrl !== false) {
    const url = urlForScreen(name, opts.roomId || state.roomId);
    if (location.pathname !== url) {
      const method = opts.replaceUrl ? "replaceState" : "pushState";
      history[method]({ screen: name, roomId: state.roomId || null }, "", url);
    }
  }

  if (name === "lobby") {
    refreshRooms();
    startLobbyPolling();
    if (state.nickname) lobbyNick.textContent = state.nickname;
  } else {
    stopLobbyPolling();
  }

  renderAccountState();
}

function parseRoute(pathname) {
  if (!pathname || pathname === "/") return { screen: "landing" };
  if (pathname === "/signup" || pathname === "/signup/") return { screen: "signup" };
  if (pathname === "/play" || pathname === "/play/") return { screen: "play-entry" };
  if (pathname === "/lobby" || pathname === "/lobby/") return { screen: "lobby" };
  const match = pathname.match(/^\/play\/([^\/]+)\/?$/);
  if (match) return { screen: "game", roomId: decodeURIComponent(match[1]) };
  return { screen: "landing" };
}

function applyRoute(route, opts = {}) {
  if (route.screen === "play-entry") {
    openPlayEntry({ pushUrl: false, ...opts });
    return;
  }

  if (route.screen === "lobby" && !state.profile) {
    showScreen("signup", { replaceUrl: true });
    return;
  }

  if (route.screen === "lobby" && !state.nickname) {
    showScreen("nickname", { replaceUrl: true });
    return;
  }

  if (route.screen === "game") {
    state.pendingRoomId = route.roomId;
    if (!state.profile) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    if (!state.nickname) {
      showScreen("nickname", { replaceUrl: true });
      return;
    }
    state.pendingRoomId = null;
    enterGame(route.roomId, { pushUrl: false });
    return;
  }

  showScreen(route.screen, { pushUrl: false, ...opts });
}

function openPlayEntry(opts = {}) {
  if (!state.profile) {
    showScreen("signup", opts);
    return;
  }

  if (!state.nickname) {
    showScreen("nickname", opts);
    setTimeout(() => nicknameInput.focus(), 30);
    return;
  }

  showScreen("lobby", opts);
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  if (state.toastHandle) clearTimeout(state.toastHandle);
  state.toastHandle = setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function startLobbyPolling() {
  stopLobbyPolling();
  state.pollHandle = setInterval(refreshRooms, LOBBY_POLL_MS);
}

function stopLobbyPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

async function refreshRooms() {
  try {
    const res = await fetch("/api/rooms", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.rooms = data.rooms || [];
    renderRooms();
  } catch (err) {
    console.warn("Room list fetch failed:", err);
  }
}

function renderRooms() {
  const totalPlayers = state.rooms.reduce((acc, r) => acc + (r.player_count || 0), 0);
  lobbyMeta.textContent = `${totalPlayers} player${totalPlayers === 1 ? "" : "s"} · ${state.rooms.length} room${state.rooms.length === 1 ? "" : "s"}`;

  if (!state.rooms.length) {
    roomRows.innerHTML = `<tr class="empty"><td colspan="5">No active rooms. Start a practice match or create one.</td></tr>`;
    return;
  }

  roomRows.innerHTML = state.rooms
    .map((room) => {
      const modeClass = room.mode === "practice" ? "practice" : "public";
      const modeLabel = MODE_LABELS[room.mode] || room.mode;
      const statusClass = room.status === "live" ? "live" : room.status === "complete" ? "complete" : "waiting";
      const status = room.status === "live" ? "Live" : room.status === "complete" ? "Result" : "Waiting";
      const canJoin = !(room.mode === "practice" && room.player_count >= 1);
      const joinLabel = room.mode === "practice" ? "Watch" : room.player_count >= room.capacity ? "Spectate" : "Join";
      return `
        <tr>
          <td>
            <span class="room-name">${escapeHtml(room.name || room.id)}</span>
            <span class="room-id-mini">${escapeHtml(room.id)}</span>
          </td>
          <td><span class="mode-tag ${modeClass}">${modeLabel}</span></td>
          <td><span class="player-meter">${room.player_count} / ${room.capacity}</span></td>
          <td><span class="status-cell ${statusClass}">${status}</span></td>
          <td><button class="cta-button join-btn" data-action="join-room" data-room="${escapeHtml(room.id)}" ${canJoin ? "" : "disabled"}>${joinLabel}</button></td>
        </tr>
      `;
    })
    .join("");
}

async function createRoom(name, mode) {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mode })
  });

  if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  return res.json();
}

async function startPractice() {
  try {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const data = await createRoom(`Practice ${suffix}`, "practice");
    enterGame(data.room_id);
  } catch (err) {
    showToast("Could not start practice room.");
    console.warn(err);
  }
}

async function submitCreate(event) {
  event.preventDefault();
  const name = createRoomName.value.trim();
  const mode = createRoomMode.value;
  if (!name) return;

  try {
    const data = await createRoom(name, mode);
    createRoomPanel.hidden = true;
    createRoomForm.reset();
    enterGame(data.room_id);
  } catch (err) {
    showToast("Create failed.");
    console.warn(err);
  }
}

function enterGame(roomId, opts = {}) {
  if (!state.profile) {
    state.pendingRoomId = roomId;
    showScreen("signup");
    return;
  }

  if (!state.nickname) {
    state.pendingRoomId = roomId;
    showScreen("nickname");
    setTimeout(() => nicknameInput.focus(), 30);
    return;
  }

  state.snapshot = null;
  state.receipts = [];
  state.leaderboard = [];
  state.playerId = null;
  state.roomId = roomId;
  state.spectator = false;
  state.hostId = null;
  state.roomCapacity = 0;
  state.roomMode = null;
  state.pendingStartRef = null;
  state.kickCooldowns.clear();
  state.prevScores = { red: 0, blue: 0 };
  state.scoresSeen = false;
  state.goalFx = null;
  unlockAudio();
  canvasEmpty.classList.remove("hidden");
  hideWaitingOverlay();
  if (matchResult) matchResult.hidden = true;

  resetChat();

  showScreen("game", { roomId, pushUrl: opts.pushUrl, replaceUrl: opts.replaceUrl });
  connect(roomId, state.nickname);
}

function leaveGame() {
  if (state.socket) {
    try {
      state.socket.close();
    } catch (_) {}
  }
  clearInterval(state.heartbeat);
  state.socket = null;
  state.topic = null;
  state.playerId = null;
  state.roomId = null;
  state.hostId = null;
  state.roomCapacity = 0;
  state.roomMode = null;
  state.pendingStartRef = null;
  state.goalFx = null;
  state.scoresSeen = false;
  hideWaitingOverlay();
  if (matchResult) matchResult.hidden = true;
  showScreen("lobby");
}

function nextRef() {
  state.ref += 1;
  return String(state.ref);
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = String(safe % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function connect(roomId, playerName) {
  if (state.socket) {
    try {
      state.socket.close();
    } catch (_) {}
  }

  clearInterval(state.heartbeat);
  state.topic = `room:${roomId}`;
  state.joinRef = nextRef();

  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProtocol}//${window.location.host}/socket/websocket?vsn=2.0.0`;
  const socket = new WebSocket(url);
  state.socket = socket;
  state.roomId = roomId;

  socket.addEventListener("open", () => {
    push("phx_join", { name: playerName, registration: registrationPayload() }, state.joinRef);
    state.heartbeat = setInterval(() => {
      sendRaw([null, nextRef(), "phoenix", "heartbeat", {}]);
    }, 30000);
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(JSON.parse(event.data));
  });

  socket.addEventListener("close", () => {
    clearInterval(state.heartbeat);
  });

  socket.addEventListener("error", () => {});
}

function sendRaw(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(payload));
}

function push(event, payload, joinRef = state.joinRef) {
  const ref = nextRef();
  sendRaw([joinRef, ref, state.topic, event, payload]);
  return ref;
}

function handleSocketMessage(frame) {
  const [_joinRef, _ref, topic, event, payload] = frame;
  if (topic !== state.topic && topic !== "phoenix") return;

  if (event === "phx_reply") {
    if (state.pendingStartRef && _ref === state.pendingStartRef) {
      state.pendingStartRef = null;
      if (payload.status === "error") {
        handleStartMatchError(payload.response && payload.response.reason);
      }
      return;
    }

    if (topic !== state.topic) return;

    if (payload.status === "ok" && payload.response) {
      handleWelcome(payload.response);
    } else if (payload.status === "error") {
      handleJoinError(payload.response);
    }
    return;
  }

  if (event === "snapshot") {
    handleSnapshot(payload);
    return;
  }

  if (event === "receipt") {
    state.receipts = [payload.receipt, ...state.receipts].slice(0, 8);
    state.leaderboard = payload.leaderboard || state.leaderboard;
    return;
  }

  if (event === "system") {
    if (payload && payload.message) {
      showToast(payload.message);
    }
    return;
  }

  if (event === "chat") {
    pushBubble(payload.from, payload.text);
  }
}

function resetChat() {
  state.bubbles.clear();
}

function sendChat(text) {
  const value = (text || "").trim().slice(0, 240);
  if (!value) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    showToast("Not connected — message not sent.");
    return;
  }
  push("chat", { text: value });
}

function handleJoinError(response) {
  const reason = response && response.reason;
  const message =
    reason === "practice_locked"
      ? "That practice room is busy. Try a public room or start your own."
      : reason === "registration_required"
        ? "Sign in before joining a room."
      : "Could not join room.";
  showToast(message);
  leaveGame();
}

function handleWelcome(payload) {
  state.playerId = payload.player_id;
  state.roomId = payload.room_id;
  state.spectator = payload.spectator;
  if (payload.host_id) state.hostId = payload.host_id;
  if (payload.snapshot) handleSnapshot(payload.snapshot);
}

function handleSnapshot(snapshot) {
  detectKicks(snapshot);
  detectGoals(snapshot.match);
  state.snapshot = snapshot;
  state.snapshotAt = performance.now();
  state.leaderboard = snapshot.leaderboard || state.leaderboard;
  state.receipts = snapshot.receipts || state.receipts;
  if (snapshot.host_id !== undefined) state.hostId = snapshot.host_id;
  if (snapshot.room_capacity) state.roomCapacity = snapshot.room_capacity;
  if (snapshot.room_mode) state.roomMode = snapshot.room_mode;
  renderHud(snapshot);
  renderWaitingRoom(snapshot);
  canvasEmpty.classList.add("hidden");
}

function handleStartMatchError(reason) {
  const msg =
    reason === "not_host"
      ? "Only the host can start the match."
      : reason === "not_full"
        ? "Waiting for all players to join."
        : reason === "not_waiting"
          ? "Match has already started."
          : "Could not start the match.";
  showToast(msg);
}

function renderWaitingRoom(snapshot) {
  if (!waitingOverlay) return;

  const status = snapshot.match && snapshot.match.status;
  const isPractice = (snapshot.room_mode || state.roomMode) === "practice";

  if (status !== "waiting" || isPractice) {
    hideWaitingOverlay();
    return;
  }

  const capacity = snapshot.room_capacity || state.roomCapacity || 0;
  const humans = (snapshot.players || []).filter((p) => !p.is_bot);
  const count = humans.length;
  const hostId = snapshot.host_id !== undefined ? snapshot.host_id : state.hostId;
  const isHost = state.playerId && state.playerId === hostId;
  const isFull = capacity > 0 && count >= capacity;
  const modeLabel = MODE_LABELS[snapshot.room_mode || state.roomMode] || "";
  const title =
    (snapshot.room_name ? snapshot.room_name : "Room") +
    (modeLabel ? ` · ${modeLabel}` : "");

  waitingOverlay.hidden = false;
  if (waitingRoomTitle) waitingRoomTitle.textContent = title;
  if (waitingPlayerCount) waitingPlayerCount.textContent = String(count);
  if (waitingCapacity) waitingCapacity.textContent = String(capacity || count);

  if (waitingRoster) {
    waitingRoster.innerHTML = humans
      .map((p) => {
        const star = p.id === hostId ? '<span class="host-star" aria-label="Host">★</span>' : "";
        const teamClass = p.team === "red" ? "team-red" : "team-blue";
        return `<li class="${teamClass}">${star}<span class="roster-name">${escapeHtml(p.name || "Player")}</span></li>`;
      })
      .join("");
  }

  if (startMatchBtn) {
    if (!isHost) {
      startMatchBtn.disabled = true;
      startMatchBtn.textContent = "Waiting for host…";
    } else if (!isFull) {
      startMatchBtn.disabled = true;
      startMatchBtn.textContent = `Waiting for players (${count}/${capacity})`;
    } else {
      startMatchBtn.disabled = false;
      startMatchBtn.textContent = "Play";
    }
  }

  if (waitingHint) {
    waitingHint.textContent = isHost
      ? isFull
        ? "Everyone's here — press Play to begin."
        : "Share the room code to fill the remaining seats."
      : "The host will start the match when the room is full.";
  }
}

function hideWaitingOverlay() {
  if (waitingOverlay) waitingOverlay.hidden = true;
}

function startMatch() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.pendingStartRef) return;
  state.pendingStartRef = push("start_match", {});
}

function renderHud(snapshot) {
  redScore.textContent = snapshot.match.red_score;
  blueScore.textContent = snapshot.match.blue_score;
  matchTimer.textContent = formatTime(snapshot.match.time_left);

  const status = snapshot.match.status;
  const label =
    status === "live" ? "Live"
    : status === "complete" ? "Final"
    : status === "waiting" ? "Waiting"
    : (status || "—").toString().replace(/_/g, " ");
  if (matchState) matchState.textContent = label.replace(/\b\w/g, (c) => c.toUpperCase());
  if (scorebug) scorebug.classList.toggle("idle", status !== "live");

  renderMatchResult(snapshot.match);
}

function renderMatchResult(match) {
  if (!matchResult) return;
  if (!match || match.status !== "complete") {
    matchResult.hidden = true;
    return;
  }

  const red = match.red_score || 0;
  const blue = match.blue_score || 0;
  let winner = "draw";
  let title = "Draw";
  if (red > blue) {
    winner = "red";
    title = "Red Wins";
  } else if (blue > red) {
    winner = "blue";
    title = "Blue Wins";
  }

  if (matchResultTitle) {
    matchResultTitle.textContent = title;
    matchResultTitle.classList.remove("red", "blue", "draw");
    matchResultTitle.classList.add(winner);
  }
  if (matchResultRed) matchResultRed.textContent = red;
  if (matchResultBlue) matchResultBlue.textContent = blue;
  matchResult.hidden = false;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
      }[char])
  );
}

function sendInput() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.playerId) return;
  const input = state.input;
  const serialized = JSON.stringify(input);
  if (serialized === state.lastSent) return;
  state.lastSent = serialized;
  push("input", input);
}

const ARENA_PADDING_X = 34;
const ARENA_PADDING_Y = 22;
const LINE_COLOR = "rgba(60, 60, 60, 0.28)";
const TEAM_RED = "#ff4b4b";
const TEAM_BLUE = "#1cb0f6";
const ACCENT_VOLT = "#58cc02";
const COURT_DARK = "#d7ffb8";
const COURT_MID = "#e5ffd4";
const COURT_LIGHT = "#f4ffeb";

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

const ARENA_VIEW_SCALE = 0.88;

function getViewTransform(snapshot) {
  const arena = snapshot.arena;
  const availW = canvas.width - ARENA_PADDING_X * 2;
  const availH = canvas.height - ARENA_PADDING_Y * 2;
  const scale = Math.min(availW / arena.width, availH / arena.height) * ARENA_VIEW_SCALE;
  const offsetX = (canvas.width - arena.width * scale) / 2;
  const offsetY = (canvas.height - arena.height * scale) / 2;
  return { scale, offsetX, offsetY };
}

function drawStadium() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const wash = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  wash.addColorStop(0, "rgba(215, 255, 184, 0.58)");
  wash.addColorStop(0.52, "rgba(255, 255, 255, 0.78)");
  wash.addColorStop(1, "rgba(221, 244, 255, 0.78)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(88, 204, 2, 0.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 34) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 34) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function pathRoundedRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawArena(snapshot) {
  const arena = snapshot.arena;
  const cx = arena.width / 2;
  const cy = arena.height / 2;
  const goalTop = cy - arena.goal_size / 2;
  const cornerR = arena.corner_radius || 60;

  ctx.save();
  ctx.beginPath();
  pathRoundedRect(0, 0, arena.width, arena.height, cornerR);
  ctx.clip();

  const court = ctx.createLinearGradient(0, 0, arena.width, arena.height);
  court.addColorStop(0, COURT_LIGHT);
  court.addColorStop(0.48, COURT_MID);
  court.addColorStop(1, COURT_DARK);
  ctx.fillStyle = court;
  ctx.fillRect(0, 0, arena.width, arena.height);

  ctx.strokeStyle = "rgba(63, 143, 1, 0.08)";
  ctx.lineWidth = 1;
  for (let x = 32; x < arena.width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, arena.height);
    ctx.stroke();
  }
  for (let y = 32; y < arena.height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(arena.width, y);
    ctx.stroke();
  }

  const laneWidth = arena.width / 8;
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? "rgba(255, 255, 255, 0.2)" : "rgba(88, 204, 2, 0.045)";
    ctx.fillRect(i * laneWidth, 0, laneWidth, arena.height);
  }

  ctx.restore();

  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 3;

  ctx.beginPath();
  pathRoundedRect(1.5, 1.5, arena.width - 3, arena.height - 3, cornerR);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, arena.height);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, 72, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(88, 204, 2, 0.52)";
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.arc(cx, cy, 108, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = LINE_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  const penaltyRadius = 130;

  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, cy, penaltyRadius, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(arena.width, cy, penaltyRadius, Math.PI / 2, -Math.PI / 2, false);
  ctx.stroke();

  const firstPenaltySpot = 60;
  const secondPenaltySpot = 110;
  ctx.fillStyle = LINE_COLOR;
  for (const dist of [firstPenaltySpot, secondPenaltySpot]) {
    ctx.beginPath();
    ctx.arc(dist, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(arena.width - dist, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  drawGoal(-arena.goal_depth, goalTop, arena.goal_depth, arena.goal_size, TEAM_RED, "left");
  drawGoal(arena.width, goalTop, arena.goal_depth, arena.goal_size, TEAM_BLUE, "right");
}

function drawGoal(x, y, w, h, color, side) {
  const frontX = side === "left" ? x + w : x;
  const backX = side === "left" ? x : x + w;

  ctx.save();

  const glow = ctx.createLinearGradient(frontX, 0, backX, 0);
  glow.addColorStop(0, `${color}44`);
  glow.addColorStop(1, `${color}12`);
  ctx.fillStyle = glow;
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.48)";
  ctx.lineWidth = 1;
  const step = 7;
  for (let i = -h; i <= w + h; i += step) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = `${color}aa`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(frontX, y);
  ctx.lineTo(backX, y);
  ctx.moveTo(frontX, y + h);
  ctx.lineTo(backX, y + h);
  ctx.moveTo(backX, y);
  ctx.lineTo(backX, y + h);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(frontX, y - 2);
  ctx.lineTo(frontX, y + h + 2);
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(frontX, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(frontX, y + h, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawRegularPolygon(sides, radius, rotation = -Math.PI / 2) {
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * Math.PI * 2) / sides;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function soccerPentagon(x, y, radius, rotation) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  drawRegularPolygon(5, radius, rotation);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawBall(ball) {
  ctx.save();
  ctx.translate(ball.x, ball.y);
  const speed = Math.min(1, Math.hypot(ball.vx || 0, ball.vy || 0) / 620);
  ctx.fillStyle = `rgba(63, 143, 1, ${0.12 + speed * 0.18})`;
  ctx.beginPath();
  ctx.ellipse(3, 7, ball.radius * 1.15, ball.radius * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  const ballGradient = ctx.createRadialGradient(
    -ball.radius * 0.38,
    -ball.radius * 0.45,
    ball.radius * 0.18,
    ball.radius * 0.1,
    ball.radius * 0.18,
    ball.radius * 1.1
  );
  ballGradient.addColorStop(0, "#ffffff");
  ballGradient.addColorStop(0.58, "#f4f4ef");
  ballGradient.addColorStop(1, "#bfc4ba");

  ctx.beginPath();
  ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = ballGradient;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, ball.radius - 0.15, 0, Math.PI * 2);
  ctx.clip();

  const roll = ((ball.x + ball.y) / Math.max(1, ball.radius * 2.3)) % (Math.PI * 2);
  ctx.rotate(roll);

  ctx.strokeStyle = "rgba(26, 27, 24, 0.56)";
  ctx.fillStyle = "#171815";
  ctx.lineWidth = 0.85;
  ctx.lineJoin = "round";

  soccerPentagon(0, 0, ball.radius * 0.34, -Math.PI / 2);

  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const innerX = Math.cos(angle) * ball.radius * 0.33;
    const innerY = Math.sin(angle) * ball.radius * 0.33;
    const outerX = Math.cos(angle) * ball.radius * 0.92;
    const outerY = Math.sin(angle) * ball.radius * 0.92;

    ctx.beginPath();
    ctx.moveTo(innerX, innerY);
    ctx.quadraticCurveTo(
      Math.cos(angle) * ball.radius * 0.58,
      Math.sin(angle) * ball.radius * 0.58,
      outerX,
      outerY
    );
    ctx.stroke();

    soccerPentagon(
      Math.cos(angle + Math.PI / 5) * ball.radius * 0.75,
      Math.sin(angle + Math.PI / 5) * ball.radius * 0.75,
      ball.radius * 0.24,
      angle + Math.PI / 2
    );
  }

  ctx.restore();

  const shade = ctx.createRadialGradient(
    -ball.radius * 0.35,
    -ball.radius * 0.45,
    ball.radius * 0.1,
    ball.radius * 0.45,
    ball.radius * 0.5,
    ball.radius * 1.2
  );
  shade.addColorStop(0, "rgba(255, 255, 255, 0.46)");
  shade.addColorStop(0.52, "rgba(255, 255, 255, 0)");
  shade.addColorStop(1, "rgba(0, 0, 0, 0.22)");

  ctx.beginPath();
  ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = shade;
  ctx.fill();

  ctx.strokeStyle = "rgba(18, 24, 18, 0.54)";
  ctx.lineWidth = 1.15;
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.beginPath();
  ctx.arc(-ball.radius * 0.38, -ball.radius * 0.42, ball.radius * 0.22, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawPlayer(player) {
  const isSelf = player.id === state.playerId;
  const color = player.team === "red" ? TEAM_RED : TEAM_BLUE;

  ctx.save();
  ctx.translate(player.x, player.y);

  if (isSelf) {
    ctx.strokeStyle = ACCENT_VOLT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, player.radius + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (player.charging) {
    ctx.strokeStyle = "#ffc700";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, player.radius + 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, player.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = isSelf ? ACCENT_VOLT : "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.arc(0, 0, player.radius * 0.46, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#3c3c3c";
  ctx.font = '800 11px "Nunito Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(player.is_bot ? "BOT" : player.name.slice(0, 10), 0, -player.radius - 11);

  const bubble = state.bubbles.get(player.name);
  const showBubble = bubble && bubble.until > performance.now();
  if (showBubble) {
    drawSpeechBubble(bubble.text, -player.radius - 22);
  } else if (bubble) {
    state.bubbles.delete(player.name);
  }

  if (isSelf && state.chatFocused && !showBubble) {
    drawTypingIndicator(-player.radius - 22);
  }
  ctx.restore();
}

function drawTypingIndicator(baselineY) {
  ctx.save();
  const r = 11;
  const cx = 0;
  const cy = baselineY - r;
  const bob = Math.sin(performance.now() / 220) * 1.5;

  ctx.translate(0, bob);
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.strokeStyle = "rgba(60, 60, 60, 0.32)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx - 3, cy + r - 0.5);
  ctx.lineTo(cx, cy + r + 5);
  ctx.lineTo(cx + 3, cy + r - 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#58cc02";
  ctx.font = '900 14px "Nunito Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", cx, cy + 0.5);
  ctx.restore();
}

function drawSpeechBubble(text, baselineY) {
  ctx.save();
  ctx.font = '700 12px "Nunito Sans", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = 8;
  const padY = 5;
  const tailH = 6;
  const measured = ctx.measureText(text);
  const w = Math.min(Math.max(measured.width + padX * 2, 36), 220);
  const h = 22;
  const x = -w / 2;
  const y = baselineY - h - tailH;
  const r = 8;

  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.strokeStyle = "rgba(60, 60, 60, 0.28)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(4, y + h);
  ctx.lineTo(0, y + h + tailH);
  ctx.lineTo(-4, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#3c3c3c";
  let display = text;
  if (measured.width > w - padX * 2) {
    while (display.length > 1 && ctx.measureText(display + "…").width > w - padX * 2) {
      display = display.slice(0, -1);
    }
    display += "…";
  }
  ctx.fillText(display, 0, y + h / 2 + 0.5);
  ctx.restore();
}

const EXTRAPOLATE_MAX_MS = 60;

function extrapolateSnapshot(snapshot) {
  if (!snapshot || !state.snapshotAt) return snapshot;
  const ageMs = Math.min(performance.now() - state.snapshotAt, EXTRAPOLATE_MAX_MS);
  if (ageMs <= 0) return snapshot;
  const dt = ageMs / 1000;

  const players = (snapshot.players || []).map((p) => ({
    ...p,
    x: p.x + (p.vx || 0) * dt,
    y: p.y + (p.vy || 0) * dt
  }));

  const ball = snapshot.ball
    ? {
        ...snapshot.ball,
        x: snapshot.ball.x + (snapshot.ball.vx || 0) * dt,
        y: snapshot.ball.y + (snapshot.ball.vy || 0) * dt
      }
    : snapshot.ball;

  return { ...snapshot, players, ball };
}

function draw() {
  const base = state.snapshot || fallbackSnapshot;
  const snapshot = state.snapshot ? extrapolateSnapshot(base) : base;
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawStadium();

  const view = getViewTransform(snapshot);
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  drawArena(snapshot);
  for (const player of snapshot.players || []) {
    drawPlayer(player);
  }
  drawBall(snapshot.ball);
  ctx.restore();

  drawGoalFx();

  requestAnimationFrame(draw);
}

function drawGoalFx() {
  const fx = state.goalFx;
  if (!fx) return;
  const elapsed = performance.now() - fx.start;
  if (elapsed >= GOAL_FX_MS) {
    state.goalFx = null;
    return;
  }
  const t = elapsed / GOAL_FX_MS;
  const color = fx.team === "red" ? TEAM_RED : TEAM_BLUE;

  const flashT = Math.min(elapsed / 360, 1);
  const flashAlpha = (1 - flashT) * 0.32;
  if (flashAlpha > 0.005) {
    ctx.save();
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  const pop = Math.min(elapsed / 200, 1);
  const scaleIn = 0.6 + pop * 0.6;
  const fade = t < 0.78 ? 1 : Math.max(0, 1 - (t - 0.78) / 0.22);

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scaleIn, scaleIn);
  ctx.globalAlpha = fade;
  const fontSize = Math.min(canvas.width, canvas.height) * 0.2;
  ctx.font = `900 ${fontSize}px "Fredoka", "Nunito Sans", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.lineWidth = fontSize * 0.12;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.strokeText("GOAL!", 0, 0);
  ctx.fillStyle = color;
  ctx.fillText("GOAL!", 0, 0);
  ctx.restore();
}

function handleAction(action, dataset) {
  switch (action) {
    case "goto-play":
      openPlayEntry();
      break;
    case "auth-continue":
      continueAfterAuth();
      break;
    case "connect-external-wallet":
      connectExternalWallet();
      break;
    case "dev-auth":
      useDevAuth();
      break;
    case "sign-out":
      signOut();
      break;
    case "back-to-landing":
      showScreen("landing");
      break;
    case "change-nick":
      if (!state.profile) {
        showScreen("signup");
        return;
      }
      nicknameInput.value = state.nickname;
      showScreen("nickname");
      setTimeout(() => nicknameInput.focus(), 30);
      break;
    case "practice":
      startPractice();
      break;
    case "open-create":
      createRoomPanel.hidden = false;
      setTimeout(() => createRoomName.focus(), 30);
      break;
    case "close-create":
      createRoomPanel.hidden = true;
      break;
    case "refresh-rooms":
      refreshRooms();
      break;
    case "join-room":
      if (dataset.room) enterGame(dataset.room);
      break;
    case "back-to-lobby":
      leaveGame();
      break;
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    unlockAudio();
    const target = event.target.closest("[data-action]");
    if (!target) return;
    event.preventDefault();
    handleAction(target.dataset.action, target.dataset);
  });

  nicknameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = nicknameInput.value.trim().slice(0, 18);
    if (!value) return;
    if (!state.profile) {
      showScreen("signup");
      return;
    }
    state.nickname = value;
    localStorage.setItem(NICK_STORAGE_KEY, value);
    lobbyNick.textContent = value;

    if (state.pendingRoomId) {
      const roomId = state.pendingRoomId;
      state.pendingRoomId = null;
      enterGame(roomId);
    } else {
      showScreen("lobby");
    }
  });

  window.addEventListener("popstate", () => {
    const route = parseRoute(location.pathname);
    if (state.screen === "game" && route.screen !== "game" && state.socket) {
      try {
        state.socket.close();
      } catch (_) {}
      clearInterval(state.heartbeat);
      state.socket = null;
      state.topic = null;
      state.playerId = null;
      state.roomId = null;
    }
    applyRoute(route);
  });

  createRoomForm.addEventListener("submit", submitCreate);
  if (privyEmailForm) privyEmailForm.addEventListener("submit", submitPrivyEmail);
  if (privyCodeForm) privyCodeForm.addEventListener("submit", submitPrivyCode);

  if (startMatchBtn) {
    startMatchBtn.addEventListener("click", (event) => {
      event.preventDefault();
      if (startMatchBtn.disabled) return;
      startMatch();
    });
  }

  if (chatForm) {
    chatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = chatInput.value;
      chatInput.value = "";
      chatInput.blur();
      if (!value.trim()) return;
      sendChat(value);
    });
  }

  if (chatInput) {
    chatInput.addEventListener("keydown", (event) => {
      if (event.code === "Escape") {
        event.preventDefault();
        chatInput.value = "";
        chatInput.blur();
      }
    });
    chatInput.addEventListener("focus", () => {
      state.chatFocused = true;
    });
    chatInput.addEventListener("blur", () => {
      state.chatFocused = false;
    });
  }

  function clearInputState() {
    let changed = false;
    for (const key of Object.keys(state.input)) {
      if (state.input[key]) {
        state.input[key] = false;
        changed = true;
      }
    }
    if (changed) sendInput();
  }

  // 창이 포커스를 잃거나 탭이 가려지면 keyup이 도착하지 않아 키가
  // 눌린 상태로 남는다. 이 때 입력을 비워서 stuck-key를 막는다.
  window.addEventListener("blur", clearInputState);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInputState();
  });

  window.addEventListener("keydown", (event) => {
    if (state.screen !== "game") return;
    if (document.activeElement === chatInput) return;
    if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault();
      clearInputState();
      chatInput.focus();
      return;
    }
    const action = keyMap.get(event.code);
    if (!action) return;
    event.preventDefault();
    if (action === "kick") unlockAudio();
    state.input[action] = true;
    sendInput();
  });

  window.addEventListener("keyup", (event) => {
    if (state.screen !== "game") return;
    if (document.activeElement === chatInput) return;
    const action = keyMap.get(event.code);
    if (!action) return;
    event.preventDefault();
    state.input[action] = false;
    sendInput();
  });

  // 입력 상태가 바뀔 때마다 즉시 보내지만, 패킷이 유실되거나 서버
  // 상태가 어긋나는 경우를 대비해 주기적으로 현재 상태를 강제 재전송한다.
  setInterval(() => {
    if (state.screen !== "game") return;
    state.lastSent = "";
    sendInput();
  }, 200);
}

function boot() {
  bindEvents();
  renderHud(fallbackSnapshot);
  draw();
  renderAccountState();
  hydratePrivySession();

  if (state.nickname) {
    lobbyNick.textContent = state.nickname;
    nicknameInput.value = state.nickname;
  }

  applyRoute(parseRoute(location.pathname));
  initCourtPreviewAnimation();
}

function initCourtPreviewAnimation() {
  const clock = document.querySelector(".court-preview .court-clock");
  const hash = document.querySelector(".court-preview .receipt-tape strong");
  if (!clock && !hash) return;

  const TOTAL_SECONDS = 120;
  let remaining = TOTAL_SECONDS;

  const fmt = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  if (clock) clock.textContent = fmt(remaining);

  setInterval(() => {
    remaining = remaining > 0 ? remaining - 1 : TOTAL_SECONDS;
    if (clock) clock.textContent = fmt(remaining);
  }, 1000);

  if (hash) {
    const randHex = (n) =>
      Array.from({ length: n }, () =>
        "0123456789ABCDEF"[Math.floor(Math.random() * 16)]
      ).join("");
    setInterval(() => {
      hash.textContent = `0x${randHex(4)}...${randHex(4)}`;
    }, 4000);
  }
}

boot();
