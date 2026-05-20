const AUTH_STORAGE_KEY = "blockball-auth";
const MODE_STORAGE_KEY = "blockball-mode";
const LOBBY_POLL_MS = 5000;
const VALID_MODES = ["casual", "ranked"];

const authConfig = readJsonConfig("#blockball-auth-config");
const physicsConfig = readJsonConfig("#blockball-physics-config");

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

// Client-side simulation constants — sourced from server's Blockball.Game.Room.physics_config/0.
// Defaults below are fallbacks if the inline JSON is unavailable; they should never be the active values.
const SIM_TICK_MS = physicsConfig.tick_ms ?? 16;
const SIM_PLAYER_ACCEL = physicsConfig.player_accel ?? 760;
const SIM_PLAYER_FRICTION = physicsConfig.player_friction ?? 0.965;
const SIM_MAX_SPEED = physicsConfig.max_speed ?? 240;
const SIM_WALL_RESTITUTION = physicsConfig.wall_restitution ?? 0.5;

// Reconciliation: how aggressively predicted local pos converges to server.
const RECONCILE_HARD_PX = 60;
const RECONCILE_POS_ALPHA = 0.22;
const RECONCILE_VEL_ALPHA = 0.3;

// Render remote entities ~100ms in the past so we always have two snapshots
// bracketing render time and can interpolate without jitter.
const INTERP_DELAY_MS = 100;
const SNAPSHOT_BUFFER_MAX = 6;
const EXTRAPOLATE_FALLBACK_MS = 80;

const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");

const state = {
  screen: "landing",
  mode: loadMode(),
  nickname: "",
  nicknameOnchain: false,
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
  snapshotBuffer: [],
  predicted: null,
  predictAccumMs: 0,
  predictLastAt: 0,
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

function readJsonConfig(selector) {
  const el = document.querySelector(selector);
  if (!el || !el.textContent) return {};
  try {
    return JSON.parse(el.textContent);
  } catch (err) {
    console.warn(`${selector} parse failed:`, err);
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

function loadMode() {
  const stored = localStorage.getItem(MODE_STORAGE_KEY);
  return VALID_MODES.includes(stored) ? stored : "casual";
}

function setMode(mode) {
  if (!VALID_MODES.includes(mode)) return;
  state.mode = mode;
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  renderModeChrome();
}

function hasRankedAccount() {
  return Boolean(state.profile && state.profile.address);
}

function isRanked() {
  return state.mode === "ranked";
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
  state.nicknameOnchain = false;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  renderAccountState();
}

function renderAccountState() {
  const profile = state.profile;

  if (lobbyWallet) lobbyWallet.textContent = profile ? `Wallet · ${shortAddress(profile.address)}` : "Wallet · —";
  if (nicknameWallet) nicknameWallet.textContent = profile ? `Wallet · ${shortAddress(profile.address)}` : "Wallet · —";

  if (authContinueButton) {
    const ready = profile && (!isRanked() || hasRankedAccount());
    authContinueButton.hidden = !profile;
    authContinueButton.disabled = !ready;
  }
  if (devAuthButton) devAuthButton.hidden = !authConfig.devAuthEnabled;

  if (state.screen === "signup") {
    if (!profile) {
      setAuthStatus(
        hasPrivyConfig()
          ? "Use email OTP to create a Privy embedded wallet, or connect an injected wallet."
          : "Set PRIVY_APP_ID and PRIVY_CLIENT_ID to enable Privy email login. Local dev account is available in development."
      );
    } else {
      setAuthStatus("Wallet verified — continue to ranked lobby.");
    }
  }

  renderModeChrome();
}

function renderModeChrome() {
  const ranked = isRanked();
  const tagText = ranked ? "Ranked" : "Casual";
  const tagClass = ranked ? "mode-tag ranked" : "mode-tag casual";

  const lobbyTag = document.querySelector("#lobby-mode-tag");
  if (lobbyTag) {
    lobbyTag.className = tagClass;
    lobbyTag.textContent = tagText;
  }
  const nickTag = document.querySelector("#nickname-mode-tag");
  if (nickTag) {
    nickTag.className = tagClass;
    nickTag.textContent = tagText;
    nickTag.hidden = false;
  }
  if (lobbyWallet) lobbyWallet.hidden = !ranked;
  if (nicknameWallet) nicknameWallet.hidden = !ranked;

  const signoutBtns = document.querySelectorAll("#nickname-signout-btn, #lobby-signout-btn");
  signoutBtns.forEach((b) => {
    b.hidden = !ranked;
  });

  const profileBtn = document.querySelector("#lobby-profile-btn");
  if (profileBtn) profileBtn.hidden = !ranked;
  const playersBtn = document.querySelector("#lobby-players-btn");
  if (playersBtn) playersBtn.hidden = !ranked;

  const createLabel = document.querySelector("#create-room-mode-label");
  if (createLabel) createLabel.textContent = ranked ? "Ranked" : "Casual";

  // Practice rooms are casual-only — hide the shortcut in ranked.
  const practiceBtn = document.querySelector('[data-action="practice"]');
  if (practiceBtn) practiceBtn.hidden = ranked;

  const help = document.querySelector(".lobby-help");
  if (help) {
    help.textContent = ranked
      ? "Ranked rooms need every player to verify a wallet. Host starts when the roster is full."
      : "Casual rooms accept any nickname. The host starts the match once everyone has joined.";
  }
}

function registrationPayload() {
  // Casual rooms join without a wallet registration — the server allows nil.
  if (!isRanked()) return null;
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
  const ethereumProvider = await privy.embeddedWallet.getEthereumProvider({
    wallet,
    entropyId,
    entropyIdVerifier
  });

  const challenge = await requestWalletChallenge(wallet.address);
  const signature = await ethereumProvider.request({
    method: "personal_sign",
    params: [challenge.message, wallet.address]
  });
  const token = await privy.getAccessToken().catch((err) => {
    console.warn("Privy access token fetch failed:", err);
    return null;
  });
  if (!token) throw new Error("Privy session unavailable. Sign in again.");

  return {
    token,
    profile: {
      kind: "privy",
      provider: "Privy Embedded Wallet",
      privyUserId: currentUser.id,
      email: extractPrivyEmail(currentUser),
      address: wallet.address,
      signedMessage: challenge.message,
      signature,
      issuedAt: challenge.issued_at,
      challengeNonce: challenge.nonce,
      challengeExpiresAt: challenge.expires_at
    }
  };
}

async function hydratePrivySession() {
  if (!hasPrivyConfig() || state.profile) return;

  let activePrivy = null;
  try {
    const { privy, mod } = await getPrivyClient();
    activePrivy = privy;
    const { user } = await privy.user.get();
    if (!user) return;
    const { profile, token } = await buildPrivyProfile(user, privy, mod);
    setAuthProfile(profile, { token });
    setAuthStatus("Privy session restored.");
    if (isRanked()) {
      try {
        await syncOnchainAccount();
      } catch (err) {
        if (err && err.code === "invalid_privy_token") {
          console.warn("Stored Privy session no longer valid — clearing.");
          clearAuthProfile();
          await clearPrivySession(privy);
          setAuthStatus("");
        }
      }
    }
  } catch (err) {
    console.warn("Privy session restore failed:", err);
    clearAuthProfile();
    if (activePrivy) await clearPrivySession(activePrivy);
  }
}

async function clearPrivySession(privy) {
  if (!privy) return;
  try {
    if (privy.auth && typeof privy.auth.logout === "function") {
      await privy.auth.logout();
    } else if (typeof privy.logout === "function") {
      await privy.logout();
    }
  } catch (err) {
    console.warn("Privy logout failed:", err);
  }
}

async function submitPrivyEmail(event) {
  event.preventDefault();
  const email = privyEmailInput.value.trim();
  if (!email) return;

  // Always start sign-in from a clean Privy session. Reusing the cached one
  // causes two issues: (a) sendCode while still logged in is rejected with
  // "User already has one email account linked", and (b) the cached access
  // token is often stale and the server rejects it as invalid_privy_token.
  clearAuthProfile();
  try {
    const { privy } = await getPrivyClient();
    await clearPrivySession(privy);
  } catch (err) {
    console.warn("Privy session reset failed:", err);
  }

  // Swap to the verification step right away so the user can wait there instead
  // of staring at the email form while Privy ships the code.
  privyEmailForm.hidden = true;
  privyCodeForm.hidden = false;
  privyCodeInput.value = "";
  setAuthStatus(`Sending verification code to ${email}…`);
  setTimeout(() => privyCodeInput.focus(), 30);

  try {
    const { privy } = await getPrivyClient();
    await privy.auth.email.sendCode(email);
    setAuthStatus(`Verification code sent to ${email}.`);
  } catch (err) {
    console.warn(err);
    privyEmailForm.hidden = false;
    privyCodeForm.hidden = true;
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
    try {
      await syncOnchainAccount();
    } catch (_) {
      return;
    }
    continueAfterAuth();
  } catch (err) {
    console.warn(err);
    setAuthStatus(err.message || "Verification failed.");
  }
}

async function requestWalletChallenge(address) {
  const res = await fetch("/api/wallet/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet_address: address })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.message) {
    throw new Error(data.error || "Could not create wallet challenge.");
  }
  return data;
}

const WALLET_API_ERRORS = {
  invalid_privy_token: "Privy session expired. Sign in again.",
  invalid_wallet_address: "Wallet address looks malformed.",
  nickname_too_short: "Nickname must be at least 2 characters.",
  nickname_too_long: "Nickname must be at most 18 characters.",
  nickname_invalid_chars: "Nickname can only contain letters, numbers, and underscores.",
  nickname_invalid: "Nickname is invalid.",
  invalid_identifier: "Email is required.",
  nickname_taken: "That nickname is already taken.",
  contract_address_not_configured: "On-chain registry not configured yet.",
  rpc_url_not_configured: "On-chain RPC not configured.",
  submitter_private_key_not_configured: "Server submitter key not configured.",
  onchain_call_failed: "On-chain call failed. Try again shortly.",
  onchain_response_invalid: "On-chain response unreadable. Try again."
};

async function walletApi(path, body) {
  const headers = { "content-type": "application/json" };
  if (state.authToken) headers["authorization"] = `Bearer ${state.authToken}`;
  const res = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const code = data && data.error;
    const message = (code && WALLET_API_ERRORS[code]) || `Request failed (${res.status}).`;
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function persistRankedNickname(nickname) {
  const profile = state.profile;
  if (!profile || !profile.address) throw new Error("Wallet not registered.");
  if (!state.authToken) throw new Error("Privy session expired. Sign in again.");

  if (state.nicknameOnchain) {
    showToast("Updating nickname on-chain…");
    const data = await walletApi("/api/wallet/update-nickname", {
      wallet_address: profile.address,
      nickname
    });
    return data.nickname || nickname;
  }

  if (!profile.email) throw new Error("Email is required to register ranked account.");
  showToast("Registering on-chain…");
  const data = await walletApi("/api/wallet/register", {
    wallet_address: profile.address,
    email: profile.email,
    nickname
  });
  return data.nickname || nickname;
}

async function openProfile() {
  if (!state.profile || !state.profile.address) {
    showToast("Sign in to view your profile.");
    return;
  }
  showScreen("profile");
  await loadProfile();
}

function setProfileField(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "—";
}

async function loadProfile() {
  const profile = state.profile;
  const status = document.getElementById("profile-status");
  setProfileField("profile-wallet", profile && profile.address);
  setProfileField("profile-nickname", state.nickname);
  setProfileField("profile-identifier", "—");
  setProfileField("profile-contract", "—");
  setProfileField("profile-chain", "—");
  if (status) status.textContent = "Loading on-chain record…";

  if (!profile || !profile.address || !state.authToken) {
    if (status) status.textContent = "Privy session required.";
    return;
  }

  try {
    const data = await walletApi("/api/wallet/me", { wallet_address: profile.address });
    setProfileField("profile-wallet", data.wallet_address || profile.address);
    setProfileField("profile-contract", data.contract_address);
    setProfileField("profile-chain", data.chain_id ? `Sepolia (${data.chain_id})` : "—");
    if (data.registered) {
      setProfileField("profile-nickname", data.nickname);
      setProfileField("profile-identifier", data.identifier_hash);
      state.nickname = data.nickname || state.nickname;
      state.nicknameOnchain = true;
      if (status) status.textContent = "On-chain record loaded.";
    } else {
      setProfileField("profile-nickname", "Not registered");
      setProfileField("profile-identifier", "—");
      state.nicknameOnchain = false;
      if (status) status.textContent = "Wallet is not registered yet.";
    }
  } catch (err) {
    console.warn("profile load failed:", err);
    if (status) status.textContent = err.message || "Could not load profile.";
  }
}

async function openPlayers() {
  if (!state.profile || !state.profile.address) {
    showToast("Sign in to view the registry.");
    return;
  }
  showScreen("players");
  await loadPlayers();
}

async function loadPlayers() {
  const status = document.getElementById("players-status");
  const rows = document.getElementById("players-rows");
  const count = document.getElementById("players-count");
  if (rows) rows.innerHTML = '<tr class="empty"><td colspan="5">Loading on-chain players…</td></tr>';
  if (status) status.textContent = "Reading UserRegistered events…";

  if (!state.authToken) {
    if (status) status.textContent = "Privy session required.";
    return;
  }

  try {
    const data = await walletApi("/api/wallet/players", {});
    const players = Array.isArray(data.players) ? data.players : [];
    if (count) count.textContent = `${players.length} player${players.length === 1 ? "" : "s"}`;
    if (status) status.textContent = `Contract ${data.contract_address || "—"}`;

    if (!rows) return;
    if (players.length === 0) {
      rows.innerHTML = '<tr class="empty"><td colspan="5">No registrations yet.</td></tr>';
      return;
    }

    const baseTx = explorerTxBase(data.chain_id);
    rows.innerHTML = players
      .map((p) => {
        const wallet = escapeHtml(p.wallet || "—");
        const idHash = escapeHtml(p.identifier_hash || "—");
        const nick = escapeHtml(p.nickname || "—");
        const block = p.block_number ? parseInt(p.block_number, 16) : null;
        const blockLabel = block != null && !Number.isNaN(block) ? String(block) : "—";
        const tx = p.tx_hash;
        const txCell = tx && baseTx
          ? `<a href="${baseTx}${escapeHtml(tx)}" target="_blank" rel="noopener">tx ↗</a>`
          : "—";
        return `<tr>
          <td>${nick}</td>
          <td class="mono">${wallet}</td>
          <td class="mono">${idHash}</td>
          <td>${blockLabel}</td>
          <td>${txCell}</td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    console.warn("players load failed:", err);
    if (status) status.textContent = err.message || "Could not load players.";
    if (rows) rows.innerHTML = '<tr class="empty"><td colspan="5">—</td></tr>';
  }
}

function explorerTxBase(chainId) {
  switch (Number(chainId)) {
    case 11155111:
      return "https://sepolia.etherscan.io/tx/";
    case 1:
      return "https://etherscan.io/tx/";
    default:
      return null;
  }
}

async function syncOnchainAccount() {
  const profile = state.profile;
  if (!isRanked() || !profile || !profile.address || !state.authToken) return null;
  setAuthStatus("Checking on-chain registration…");
  try {
    const data = await walletApi("/api/wallet/lookup", { wallet_address: profile.address });
    if (data.registered && data.nickname) {
      state.nickname = data.nickname;
      state.nicknameOnchain = true;
      if (lobbyNick) lobbyNick.textContent = data.nickname;
      setAuthStatus("Welcome back.");
    } else {
      state.nicknameOnchain = false;
      setAuthStatus("Pick a nickname to finish ranked sign-up.");
    }
    return data;
  } catch (err) {
    console.warn("on-chain lookup failed:", err);
    state.nicknameOnchain = false;
    setAuthStatus(err.message || "Could not verify on-chain registration.");
    throw err;
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

    const challenge = await requestWalletChallenge(address);
    const signedMessage = challenge.message;
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
      issuedAt: challenge.issued_at,
      challengeNonce: challenge.nonce,
      challengeExpiresAt: challenge.expires_at
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
    address: `0x${id}${"0".repeat(32)}`,
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

  // Ranked flows require a verified wallet-backed account before leaving signup.
  if (isRanked() && !hasRankedAccount()) {
    setAuthStatus("Verify a wallet to unlock ranked rooms.");
    showScreen("signup");
    return;
  }

  if (!state.nickname) {
    showScreen("nickname");
    setTimeout(() => nicknameInput && nicknameInput.focus(), 30);
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
  state.nicknameOnchain = false;
  state.pendingRoomId = null;
  nicknameInput.value = "";
  if (lobbyNick) lobbyNick.textContent = "—";
  setMode("casual");
  showScreen("landing");
  if (privyClientPromise) {
    privyClientPromise
      .then(({ privy }) => clearPrivySession(privy))
      .catch((err) => console.warn("Privy logout skipped:", err));
  }
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
  const modeSeg = state.mode || "casual";
  switch (name) {
    case "landing":
      return "/";
    case "signup":
      return "/signup";
    case "profile":
      return "/profile";
    case "players":
      return "/players";
    case "nickname":
      return `/play/${modeSeg}`;
    case "lobby":
      return `/lobby/${modeSeg}`;
    case "game":
      return roomId
        ? `/play/${modeSeg}/${encodeURIComponent(roomId)}`
        : `/play/${modeSeg}`;
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
  if (pathname === "/profile" || pathname === "/profile/") return { screen: "profile" };
  if (pathname === "/players" || pathname === "/players/") return { screen: "players" };

  let m = pathname.match(/^\/play\/(casual|ranked)\/([^\/]+)\/?$/);
  if (m) return { screen: "game", mode: m[1], roomId: decodeURIComponent(m[2]) };

  m = pathname.match(/^\/play\/(casual|ranked)\/?$/);
  if (m) return { screen: "play-entry", mode: m[1] };

  m = pathname.match(/^\/lobby\/(casual|ranked)\/?$/);
  if (m) return { screen: "lobby", mode: m[1] };

  if (pathname === "/play" || pathname === "/play/")
    return { screen: "play-entry", mode: state.mode };
  if (pathname === "/lobby" || pathname === "/lobby/")
    return { screen: "lobby", mode: state.mode };

  m = pathname.match(/^\/play\/([^\/]+)\/?$/);
  if (m) return { screen: "game", mode: state.mode, roomId: decodeURIComponent(m[1]) };

  return { screen: "landing" };
}

function applyRoute(route, opts = {}) {
  if (route.mode) setMode(route.mode);
  // The signup screen is meaningful only for the ranked flow.
  if (route.screen === "signup") setMode("ranked");

  if (route.screen === "play-entry") {
    openPlayEntry({ pushUrl: false, ...opts });
    return;
  }

  if (route.screen === "lobby") {
    if (isRanked() && !state.profile) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    if (isRanked() && !hasRankedAccount()) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    if (!state.nickname) {
      showScreen("nickname", { replaceUrl: true });
      return;
    }
    showScreen("lobby", { pushUrl: false, ...opts });
    return;
  }

  if (route.screen === "game") {
    state.pendingRoomId = route.roomId;
    if (isRanked() && !state.profile) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    if (isRanked() && !hasRankedAccount()) {
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

  if (route.screen === "profile") {
    if (!state.profile) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    showScreen("profile", { pushUrl: false, ...opts });
    loadProfile();
    return;
  }

  if (route.screen === "players") {
    if (!state.profile) {
      showScreen("signup", { replaceUrl: true });
      return;
    }
    showScreen("players", { pushUrl: false, ...opts });
    loadPlayers();
    return;
  }

  showScreen(route.screen, { pushUrl: false, ...opts });
}

function openPlayEntry(opts = {}) {
  if (isRanked() && !state.profile) {
    showScreen("signup", opts);
    return;
  }

  if (isRanked() && !hasRankedAccount()) {
    showScreen("signup", opts);
    return;
  }

  if (!state.nickname) {
    showScreen("nickname", opts);
    setTimeout(() => nicknameInput && nicknameInput.focus(), 30);
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
  // Casual lobby hides ranked rooms and vice versa. Practice rooms are solo
  // sessions, so they never surface in the lobby — the host enters directly
  // via the "Practice vs bot" shortcut.
  const visible = state.rooms.filter(
    (r) => Boolean(r.ranked) === isRanked() && r.mode !== "practice"
  );
  const totalPlayers = visible.reduce((acc, r) => acc + (r.player_count || 0), 0);
  lobbyMeta.textContent = `${totalPlayers} player${totalPlayers === 1 ? "" : "s"} · ${visible.length} room${visible.length === 1 ? "" : "s"}`;

  if (!visible.length) {
    const blurb = isRanked()
      ? "No ranked rooms open. Create one or invite a verified wallet player."
      : "No casual rooms open. Start a practice match or create one.";
    roomRows.innerHTML = `<tr class="empty"><td colspan="6">${blurb}</td></tr>`;
    return;
  }

  roomRows.innerHTML = visible
    .map((room) => {
      const modeClass = room.mode === "practice" ? "practice" : "public";
      const modeLabel = MODE_LABELS[room.mode] || room.mode;
      const statusClass = room.status === "live" ? "live" : room.status === "complete" ? "complete" : "waiting";
      const status = room.status === "live" ? "Live" : room.status === "complete" ? "Result" : "Waiting";
      const canJoin = !(room.mode === "practice" && room.player_count >= 1);
      const joinLabel = room.mode === "practice" ? "Watch" : room.player_count >= room.capacity ? "Spectate" : "Join";
      const typeTag = room.ranked
        ? '<span class="mode-tag ranked" title="Ranked receipts are recorded only after chain confirmation">Ranked</span>'
        : '<span class="mode-tag casual" title="Not recorded">Casual</span>';
      return `
        <tr>
          <td>
            <span class="room-name">${escapeHtml(room.name || room.id)}</span>
            <span class="room-id-mini">${escapeHtml(room.id)}</span>
          </td>
          <td><span class="mode-tag ${modeClass}">${modeLabel}</span></td>
          <td>${typeTag}</td>
          <td><span class="player-meter">${room.player_count} / ${room.capacity}</span></td>
          <td><span class="status-cell ${statusClass}">${status}</span></td>
          <td><button class="cta-button join-btn" data-action="join-room" data-room="${escapeHtml(room.id)}" ${canJoin ? "" : "disabled"}>${joinLabel}</button></td>
        </tr>
      `;
    })
    .join("");
}

async function createRoom(name, mode, ranked = false) {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mode, ranked })
  });

  if (!res.ok) throw new Error(`Create failed: ${res.status}`);
  return res.json();
}

async function startPractice() {
  try {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    // Practice rooms are always casual — the server enforces this regardless.
    const data = await createRoom(`Practice ${suffix}`, "practice", false);
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
  // Match type follows the active lobby — no per-room toggle in the form.
  const ranked = isRanked() && mode !== "practice";
  if (!name) return;

  try {
    const data = await createRoom(name, mode, ranked);
    createRoomPanel.hidden = true;
    createRoomForm.reset();
    enterGame(data.room_id);
  } catch (err) {
    showToast("Create failed.");
    console.warn(err);
  }
}

function enterGame(roomId, opts = {}) {
  if (isRanked() && !state.profile) {
    state.pendingRoomId = roomId;
    showScreen("signup");
    return;
  }

  if (isRanked() && !hasRankedAccount()) {
    state.pendingRoomId = roomId;
    showScreen("signup");
    showToast("Verify a wallet to join ranked rooms.");
    return;
  }

  if (!state.nickname) {
    state.pendingRoomId = roomId;
    showScreen("nickname");
    setTimeout(() => nicknameInput && nicknameInput.focus(), 30);
    return;
  }

  state.snapshot = null;
  state.snapshotBuffer = [];
  state.predicted = null;
  state.predictAccumMs = 0;
  state.predictLastAt = 0;
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
  state.snapshotBuffer = [];
  state.predicted = null;
  state.predictAccumMs = 0;
  state.predictLastAt = 0;
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
    showToast("Signed ranked receipt ready — pending chain confirmation.");
    return;
  }

  if (event === "receipt_status") {
    if (payload && payload.status === "chain_confirmed") {
      state.receipts = state.receipts.map((r) =>
        r.match_id === payload.match_id
          ? { ...r, status: "chain_confirmed", recorded: true, recorded_on_chain: true, tx_hash: payload.tx_hash, block_number: payload.block_number }
          : r
      );
      renderReceiptStatus();
      showToast("Recorded on-chain.");
    } else if (payload && payload.receipt) {
      state.receipts = state.receipts.map((r) =>
        r.match_id === payload.match_id ? { ...r, status: payload.status, fallback_available: true } : r
      );
      renderReceiptStatus();
      showToast("Submission failed — signed fallback receipt available.");
    }
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
  const now = performance.now();
  detectKicks(snapshot);
  detectGoals(snapshot.match);
  state.snapshot = snapshot;
  state.snapshotAt = now;
  state.snapshotBuffer.push({ at: now, snapshot });
  if (state.snapshotBuffer.length > SNAPSHOT_BUFFER_MAX) {
    state.snapshotBuffer.splice(0, state.snapshotBuffer.length - SNAPSHOT_BUFFER_MAX);
  }
  reconcileLocalPlayer(snapshot);
  state.leaderboard = snapshot.leaderboard || state.leaderboard;
  state.receipts = snapshot.receipts || state.receipts;
  if (snapshot.host_id !== undefined) state.hostId = snapshot.host_id;
  if (snapshot.room_capacity) state.roomCapacity = snapshot.room_capacity;
  if (snapshot.room_mode) state.roomMode = snapshot.room_mode;
  renderHud(snapshot);
  renderWaitingRoom(snapshot);
  canvasEmpty.classList.add("hidden");
}

function findLocalPlayer(snapshot) {
  if (!state.playerId || !snapshot || !snapshot.players) return null;
  return snapshot.players.find((p) => p.id === state.playerId) || null;
}

function reconcileLocalPlayer(snapshot) {
  const server = findLocalPlayer(snapshot);
  if (!server) return;
  if (!state.predicted) {
    state.predicted = {
      x: server.x,
      y: server.y,
      vx: server.vx || 0,
      vy: server.vy || 0,
      radius: server.radius
    };
    return;
  }
  const p = state.predicted;
  p.radius = server.radius;
  const dx = server.x - p.x;
  const dy = server.y - p.y;
  const err = Math.hypot(dx, dy);
  if (err > RECONCILE_HARD_PX) {
    // Server fired a discrete event we cannot mirror locally (kick recoil,
    // goal reset, hard collision). Snap to authoritative state.
    p.x = server.x;
    p.y = server.y;
    p.vx = server.vx || 0;
    p.vy = server.vy || 0;
  } else {
    p.vx = p.vx * (1 - RECONCILE_VEL_ALPHA) + (server.vx || 0) * RECONCILE_VEL_ALPHA;
    p.vy = p.vy * (1 - RECONCILE_VEL_ALPHA) + (server.vy || 0) * RECONCILE_VEL_ALPHA;
    p.x += dx * RECONCILE_POS_ALPHA;
    p.y += dy * RECONCILE_POS_ALPHA;
  }
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
  renderReceiptStatus();
  matchResult.hidden = false;
}

function renderReceiptStatus() {
  const statusEl = document.querySelector("#match-result-receipt-status");
  if (!statusEl) return;
  if (!isRanked()) {
    statusEl.textContent = "Casual match — no on-chain record.";
    statusEl.className = "receipt-status casual";
    return;
  }
  const receipt = state.receipts[0];
  if (!receipt) {
    statusEl.textContent = "Preparing ranked receipt…";
    statusEl.className = "receipt-status pending";
    return;
  }
  if (receipt.recorded_on_chain || receipt.status === "chain_confirmed") {
    const tx = receipt.tx_hash ? ` · ${shortAddress(receipt.tx_hash)}` : "";
    statusEl.textContent = `Recorded on-chain${tx}`;
    statusEl.className = "receipt-status confirmed";
    return;
  }
  if (receipt.fallback_available || receipt.status === "submission_failed_permissionless_available") {
    statusEl.textContent = "Signed receipt ready · submission failed · fallback available";
    statusEl.className = "receipt-status failed";
    return;
  }
  statusEl.textContent = "Signed receipt ready · pending chain confirmation";
  statusEl.className = "receipt-status pending";
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

  drawCourtBackground(arena, cornerR);
  drawCourtLines(arena, cx, cy, cornerR);
  drawPenaltyZones(arena, cy);
  drawGoal(-arena.goal_depth, goalTop, arena.goal_depth, arena.goal_size, TEAM_RED, "left");
  drawGoal(arena.width, goalTop, arena.goal_depth, arena.goal_size, TEAM_BLUE, "right");
}

function drawCourtBackground(arena, cornerR) {
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
}

function drawCourtLines(arena, cx, cy, cornerR) {
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
}

function drawPenaltyZones(arena, cy) {
  const penaltyRadius = 130;
  const firstPenaltySpot = 60;
  const secondPenaltySpot = 110;

  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, cy, penaltyRadius, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(arena.width, cy, penaltyRadius, Math.PI / 2, -Math.PI / 2, false);
  ctx.stroke();

  ctx.fillStyle = LINE_COLOR;
  for (const dist of [firstPenaltySpot, secondPenaltySpot]) {
    ctx.beginPath();
    ctx.arc(dist, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(arena.width - dist, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
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
  drawBallShadow(ball, speed);
  drawBallBody(ball);
  drawBallPentagons(ball);
  drawBallHighlight(ball);
  ctx.restore();
}

function drawBallShadow(ball, speed) {
  ctx.fillStyle = `rgba(63, 143, 1, ${0.12 + speed * 0.18})`;
  ctx.beginPath();
  ctx.ellipse(3, 7, ball.radius * 1.15, ball.radius * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBallBody(ball) {
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
}

function drawBallPentagons(ball) {
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
}

function drawBallHighlight(ball) {
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

function stepLocalPrediction(now) {
  if (!state.predicted || !state.snapshot) {
    state.predictLastAt = now;
    state.predictAccumMs = 0;
    return;
  }
  if (!state.predictLastAt) state.predictLastAt = now;
  let elapsed = now - state.predictLastAt;
  state.predictLastAt = now;
  if (elapsed < 0) elapsed = 0;
  // Cap accumulator so a tab that was backgrounded doesn't fast-forward.
  state.predictAccumMs = Math.min(state.predictAccumMs + elapsed, 200);
  while (state.predictAccumMs >= SIM_TICK_MS) {
    integratePredictedStep();
    state.predictAccumMs -= SIM_TICK_MS;
  }
}

function integratePredictedStep() {
  const p = state.predicted;
  const input = state.input;
  const dt = SIM_TICK_MS / 1000;
  const ax = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const ay = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const len = Math.hypot(ax, ay);
  const dx = len > 0 ? ax / len : 0;
  const dy = len > 0 ? ay / len : 0;
  p.vx = (p.vx + dx * SIM_PLAYER_ACCEL * dt) * SIM_PLAYER_FRICTION;
  p.vy = (p.vy + dy * SIM_PLAYER_ACCEL * dt) * SIM_PLAYER_FRICTION;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > SIM_MAX_SPEED) {
    p.vx = (p.vx / speed) * SIM_MAX_SPEED;
    p.vy = (p.vy / speed) * SIM_MAX_SPEED;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  clampPredictedToArena();
}

function clampPredictedToArena() {
  const arena = state.snapshot && state.snapshot.arena;
  if (!arena) return;
  const p = state.predicted;
  const r = p.radius || 18;
  if (p.x < r) {
    p.x = r;
    if (p.vx < 0) p.vx = -p.vx * SIM_WALL_RESTITUTION;
  } else if (p.x > arena.width - r) {
    p.x = arena.width - r;
    if (p.vx > 0) p.vx = -p.vx * SIM_WALL_RESTITUTION;
  }
  if (p.y < r) {
    p.y = r;
    if (p.vy < 0) p.vy = -p.vy * SIM_WALL_RESTITUTION;
  } else if (p.y > arena.height - r) {
    p.y = arena.height - r;
    if (p.vy > 0) p.vy = -p.vy * SIM_WALL_RESTITUTION;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

// Pick the two buffered snapshots that bracket renderTime. Falls back to the
// edges (with a tiny extrapolation budget) if renderTime is outside the buffer.
function findInterpPair(renderTime) {
  const buf = state.snapshotBuffer;
  if (buf.length === 0) return null;
  if (buf.length === 1) return { a: buf[0], b: buf[0], t: 0 };
  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i];
    const b = buf[i + 1];
    if (renderTime >= a.at && renderTime <= b.at) {
      const span = Math.max(b.at - a.at, 1);
      return { a, b, t: (renderTime - a.at) / span };
    }
  }
  // renderTime is past the newest snapshot: extrapolate from the last pair.
  const a = buf[buf.length - 2];
  const b = buf[buf.length - 1];
  const span = Math.max(b.at - a.at, 1);
  const overshoot = Math.min(renderTime - b.at, EXTRAPOLATE_FALLBACK_MS);
  return { a, b, t: 1 + overshoot / span };
}

function buildRenderSnapshot(now) {
  const base = state.snapshot;
  if (!base) return null;
  const renderTime = now - INTERP_DELAY_MS;
  const pair = findInterpPair(renderTime);
  const ball = renderBall(base, pair);
  const players = renderPlayers(base, pair);
  return { ...base, players, ball };
}

function renderBall(base, pair) {
  if (!base.ball) return base.ball;
  if (!pair) return base.ball;
  const a = pair.a.snapshot.ball;
  const b = pair.b.snapshot.ball;
  if (!a || !b) return b || a || base.ball;
  return { ...b, x: lerp(a.x, b.x, pair.t), y: lerp(a.y, b.y, pair.t) };
}

function renderPlayers(base, pair) {
  const newest = pair ? pair.b.snapshot.players || [] : base.players || [];
  const oldest = pair ? pair.a.snapshot.players || [] : newest;
  const byIdOld = new Map(oldest.map((p) => [p.id, p]));
  return newest.map((bp) => {
    if (bp.id === state.playerId && state.predicted) {
      return { ...bp, x: state.predicted.x, y: state.predicted.y };
    }
    if (!pair) return bp;
    const ap = byIdOld.get(bp.id);
    if (!ap) return bp;
    return { ...bp, x: lerp(ap.x, bp.x, pair.t), y: lerp(ap.y, bp.y, pair.t) };
  });
}

function draw() {
  const now = performance.now();
  stepLocalPrediction(now);
  const snapshot = state.snapshot ? buildRenderSnapshot(now) : fallbackSnapshot;
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
    case "play-casual":
      setMode("casual");
      openPlayEntry();
      break;
    case "play-ranked":
      setMode("ranked");
      clearAuthProfile();
      privyEmailForm.hidden = false;
      privyCodeForm.hidden = true;
      privyEmailInput.value = "";
      privyCodeInput.value = "";
      showScreen("signup");
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
    case "open-profile":
      openProfile();
      break;
    case "back-to-lobby-from-profile":
      showScreen("lobby");
      break;
    case "open-players":
      openPlayers();
      break;
    case "back-to-lobby-from-players":
      showScreen("lobby");
      break;
  }
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

function bindActionDelegate() {
  document.addEventListener("click", (event) => {
    unlockAudio();
    const target = event.target.closest("[data-action]");
    if (!target) return;
    event.preventDefault();
    handleAction(target.dataset.action, target.dataset);
  });
}

function bindNicknameForm() {
  nicknameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = nicknameInput.value.trim().slice(0, 18);
    if (!value) return;
    if (isRanked() && !state.profile) {
      showScreen("signup");
      return;
    }
    if (isRanked() && !hasRankedAccount()) {
      showScreen("signup");
      showToast("Verify a wallet to join ranked rooms.");
      return;
    }

    const submitBtn = nicknameForm.querySelector("button[type=submit]");
    if (isRanked()) {
      if (submitBtn) submitBtn.disabled = true;
      try {
        const resolved = await persistRankedNickname(value);
        state.nickname = resolved;
        state.nicknameOnchain = true;
      } catch (err) {
        showToast(err.message || "Could not save nickname.");
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      if (submitBtn) submitBtn.disabled = false;
    } else {
      state.nickname = value;
    }
    lobbyNick.textContent = state.nickname;

    if (state.pendingRoomId) {
      const roomId = state.pendingRoomId;
      state.pendingRoomId = null;
      enterGame(roomId);
    } else {
      showScreen("lobby");
    }
  });
}

function bindRouter() {
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
}

function bindAuthAndRoomForms() {
  createRoomForm.addEventListener("submit", submitCreate);
  if (privyEmailForm) privyEmailForm.addEventListener("submit", submitPrivyEmail);
  if (privyCodeForm) privyCodeForm.addEventListener("submit", submitPrivyCode);
}

function bindWaitingControls() {
  if (!startMatchBtn) return;
  startMatchBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (startMatchBtn.disabled) return;
    startMatch();
  });
}

function bindChat() {
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

  if (!chatInput) return;

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

function bindGameInput() {
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

function bindEvents() {
  bindActionDelegate();
  bindNicknameForm();
  bindRouter();
  bindAuthAndRoomForms();
  bindWaitingControls();
  bindChat();
  bindGameInput();
}

function boot() {
  bindEvents();
  renderHud(fallbackSnapshot);
  draw();
  renderAccountState();
  hydratePrivySession();

  applyRoute(parseRoute(location.pathname));
  initCourtPreviewAnimation();
}

function initCourtPreviewAnimation() {
  const clock = document.querySelector(".court-preview .court-clock");
  if (!clock) return;

  const TOTAL_SECONDS = 120;
  let remaining = TOTAL_SECONDS;

  const fmt = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  clock.textContent = fmt(remaining);

  setInterval(() => {
    remaining = remaining > 0 ? remaining - 1 : TOTAL_SECONDS;
    clock.textContent = fmt(remaining);
  }, 1000);
}

boot();
