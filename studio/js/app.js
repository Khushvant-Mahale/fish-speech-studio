const state = {
  currentView: "dashboard", // "dashboard" | "studio"
  projects: [],
  currentProject: null,
  voices: [],
  activeBlockIndex: 0,
  selectedBlockIndices: new Set([0]),
  lastClickedIndex: 0,
  targetBlockForVoice: null,
  activeFilter: "all",
  activeSort: "recommended",
  searchQuery: "",
  sampleAudioPlayer: new Audio(),
  storyAudioPlayer: new Audio(),
  playingVoiceSampleId: null,
  currentlyPlayingBlockIdx: null,
  isPlayingStory: false,
  isBatchRunning: false,
  nextSentenceTimer: null,
  activeEngine: "fish_s2",
  activeModel: "drama3",
  folders: [],
  activeFolderId: null,
  activeFolderData: null,
  movingProjectId: null,
  editingMasterCast: [],
  refAudioPlayer: new Audio(),
  config: { remote_worker_url: "", active: false },
  undoStack: [],
  redoStack: [],
  savedCharacters: [],
  selectedCharacterColor: "#6366f1",
  editingCharacterId: null,
  charModalFxFilter: "none",
  draggedBlockIndex: null,
  fishLibrary: {
    query: "",
    tag: "all",
    language: "en",
    sortBy: "score",
    page: 1,
    pageSize: 24,
    total: 0,
    hasMore: false,
    isLoading: false,
    exploreData: null,
    searchResults: [],
    activePlayingId: null,
    savedModelIds: new Set()
  }
};

// ---------------- UTILITIES & HELPERS ---------------- //

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "Recently";
  const sec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (sec < 10) return "Just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function countHeadings() {
  if (!state.currentProject?.blocks) return 0;
  return state.currentProject.blocks.filter(b => b.type === "heading" || b.is_spoken === false).length;
}

// ---------------- UNDO / REDO & ACTION HISTORY ENGINE ---------------- //

function recordHistory(actionLabel) {
  if (!state.currentProject || !state.currentProject.blocks) return;

  const blocksClone = JSON.parse(JSON.stringify(state.currentProject.blocks));
  const activeIdx = state.activeBlockIndex;
  const selectedIndices = Array.from(state.selectedBlockIndices || [0]);

  state.undoStack.push({
    label: actionLabel,
    blocks: blocksClone,
    activeBlockIndex: activeIdx,
    selectedBlockIndices: selectedIndices,
    timestamp: Date.now()
  });

  if (state.undoStack.length > 50) {
    state.undoStack.shift();
  }

  // Any new action clears the redo stack
  state.redoStack = [];
  updateUndoRedoUI();
}

function handleUndo() {
  if (!state.currentProject || !state.undoStack || state.undoStack.length === 0) {
    showToast("ℹ️ Nothing to undo.");
    return;
  }

  // Take current state and push onto redo stack
  const currentSnapshot = {
    label: state.undoStack[state.undoStack.length - 1].label || "Action",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.redoStack.push(currentSnapshot);

  // Pop previous snapshot from undo stack
  const previousSnapshot = state.undoStack.pop();
  state.currentProject.blocks = previousSnapshot.blocks;
  state.activeBlockIndex = Math.min(previousSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((previousSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateUndoRedoUI();
  syncProjectAudioCache();
  showToast(`↺ Undid: ${previousSnapshot.label}`);
}

function handleRedo() {
  if (!state.currentProject || !state.redoStack || state.redoStack.length === 0) {
    showToast("ℹ️ Nothing to redo.");
    return;
  }

  // Take current state and push onto undo stack
  const currentSnapshot = {
    label: state.redoStack[state.redoStack.length - 1].label || "Action",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.undoStack.push(currentSnapshot);

  // Pop next snapshot from redo stack
  const nextSnapshot = state.redoStack.pop();
  state.currentProject.blocks = nextSnapshot.blocks;
  state.activeBlockIndex = Math.min(nextSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((nextSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateUndoRedoUI();
  syncProjectAudioCache();
  showToast(`↻ Redid: ${nextSnapshot.label}`);
}

function revertToHistoryStep(targetIndex) {
  if (!state.currentProject || !state.undoStack || targetIndex < 0 || targetIndex >= state.undoStack.length) return;

  // Take snapshot of current state for redo
  const currentSnapshot = {
    label: "Current State",
    blocks: JSON.parse(JSON.stringify(state.currentProject.blocks)),
    activeBlockIndex: state.activeBlockIndex,
    selectedBlockIndices: Array.from(state.selectedBlockIndices || [0]),
    timestamp: Date.now()
  };
  state.redoStack.push(currentSnapshot);

  // Pop all items after targetIndex into redo stack
  while (state.undoStack.length > targetIndex + 1) {
    state.redoStack.push(state.undoStack.pop());
  }

  const targetSnapshot = state.undoStack.pop();
  state.currentProject.blocks = targetSnapshot.blocks;
  state.activeBlockIndex = Math.min(targetSnapshot.activeBlockIndex || 0, Math.max(0, state.currentProject.blocks.length - 1));
  state.selectedBlockIndices = new Set((targetSnapshot.selectedBlockIndices || [0]).filter(i => i < state.currentProject.blocks.length));
  if (state.selectedBlockIndices.size === 0) state.selectedBlockIndices.add(0);

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateUndoRedoUI();
  syncProjectAudioCache();
  closeHistoryDropdown();
  showToast(`↺ Restored state: "${targetSnapshot.label}"`);
}

function updateUndoRedoUI() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  const badgeCount = document.getElementById("history-badge-count");
  const totalLabel = document.getElementById("history-dropdown-total");

  const canUndo = Boolean(state.undoStack && state.undoStack.length > 0);
  const canRedo = Boolean(state.redoStack && state.redoStack.length > 0);

  if (undoBtn) {
    undoBtn.disabled = !canUndo;
    if (canUndo) {
      undoBtn.title = `Undo "${state.undoStack[state.undoStack.length - 1].label}" (Ctrl+Z)`;
    } else {
      undoBtn.title = "Nothing to undo (Ctrl+Z)";
    }
  }

  if (redoBtn) {
    redoBtn.disabled = !canRedo;
    if (canRedo) {
      redoBtn.title = `Redo "${state.redoStack[state.redoStack.length - 1].label}" (Ctrl+Y)`;
    } else {
      redoBtn.title = "Nothing to redo (Ctrl+Y)";
    }
  }

  const totalSteps = (state.undoStack?.length || 0);
  if (badgeCount) badgeCount.textContent = totalSteps;
  if (totalLabel) totalLabel.textContent = `${totalSteps} step${totalSteps === 1 ? '' : 's'}`;

  renderHistoryDropdownList();
}

function toggleHistoryDropdown(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("history-dropdown-menu");
  if (!menu) return;
  const isHidden = (menu.style.display === "none" || !menu.style.display);
  menu.style.display = isHidden ? "flex" : "none";
  if (isHidden) {
    renderHistoryDropdownList();
  }
}

function closeHistoryDropdown() {
  const menu = document.getElementById("history-dropdown-menu");
  if (menu) menu.style.display = "none";
}

function renderHistoryDropdownList() {
  const listEl = document.getElementById("history-dropdown-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const undoLen = state.undoStack ? state.undoStack.length : 0;
  const redoLen = state.redoStack ? state.redoStack.length : 0;

  if (undoLen === 0 && redoLen === 0) {
    listEl.innerHTML = `<div class="history-empty-item">No actions in history yet.<br><span style="font-size: 11px; opacity: 0.7;">Edits and changes will appear here.</span></div>`;
    return;
  }

  // 1. Redo steps (future)
  if (redoLen > 0) {
    state.redoStack.slice().reverse().forEach((item) => {
      const div = document.createElement("div");
      div.className = "history-dropdown-item redo-item";
      div.title = "Click to redo forward to this state";
      div.innerHTML = `
        <div class="history-item-label">
          <span>↻</span>
          <span>${escapeHtml(item.label || "Action")}</span>
        </div>
        <span class="history-item-time">Redo</span>
      `;
      div.addEventListener("click", () => {
        handleRedo();
      });
      listEl.appendChild(div);
    });
  }

  // 2. Current State Marker
  const currentMarker = document.createElement("div");
  currentMarker.className = "history-dropdown-item active";
  currentMarker.innerHTML = `
    <div class="history-item-label">
      <span>●</span>
      <span>Current Story State</span>
    </div>
    <span class="history-item-time">Now</span>
  `;
  listEl.appendChild(currentMarker);

  // 3. Undo steps (past, newest on top)
  for (let i = undoLen - 1; i >= 0; i--) {
    const item = state.undoStack[i];
    const div = document.createElement("div");
    div.className = "history-dropdown-item";
    div.title = `Click to roll back story to: ${item.label}`;
    const timeAgo = formatTimeAgo(item.timestamp);

    div.innerHTML = `
      <div class="history-item-label">
        <span>↺</span>
        <span>${escapeHtml(item.label || "Action")}</span>
      </div>
      <span class="history-item-time">${timeAgo}</span>
    `;
    div.addEventListener("click", () => {
      revertToHistoryStep(i);
    });
    listEl.appendChild(div);
  }
}

// ---------------- INITIALIZATION ---------------- //

async function initApp() {
  try {
    await initAuth();
    loadSavedCharacters();
    await loadVoices();
    await loadConfig();
    if (!state.currentUser) {
      initGoogleAuth();
    } else if (window.google?.accounts?.id) {
      try {
        google.accounts.id.cancel();
      } catch (e) {}
    }
    initAIAgentConfig();
    setupEventListeners();

    // Front-door gate: require login to access the studio
    if (!state.currentUser) {
      switchToView("auth", false);
      return;
    }

    await loadProjectsList();

    // Check URL parameters for direct studio deep-linking
    const urlParams = new URLSearchParams(window.location.search);
    const projectId = urlParams.get("project") || urlParams.get("id");
    const isStudioPath = window.location.pathname.includes("/studio");

    if (projectId) {
      await openProject(projectId, false);
    } else if (isStudioPath) {
      // Direct navigation to /app/studio without project param -> open default project in studio
      const targetId = (state.projects && state.projects.length > 0) ? state.projects[0].id : "proj_eb9ab585";
      await openProject(targetId, false);
    } else {
      switchToView("dashboard", false);
    }

    // Handle browser back/forward buttons
    window.addEventListener("popstate", (e) => {
      const params = new URLSearchParams(window.location.search);
      const pid = params.get("project") || params.get("id");
      const isStudio = window.location.pathname.includes("/studio");
      if (!state.currentUser) {
        switchToView("auth", false);
      } else if (pid && (!state.currentProject || state.currentProject.id !== pid)) {
        openProject(pid, false);
      } else if (isStudio && (!state.currentProject || state.currentView !== "studio")) {
        const targetId = (state.projects && state.projects.length > 0) ? state.projects[0].id : "proj_eb9ab585";
        openProject(targetId, false);
      } else if (!pid && !isStudio) {
        switchToView("dashboard", false);
      }
    });
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

// ---------------- API CALLS ---------------- //

async function loadVoices() {
  try {
    const res = await fetch("/api/voices");
    state.voices = await res.json();
    populateVoiceSelects();
  } catch (err) {
    console.error("Failed to load voices", err);
  }
}

let currentNewProjectTier = "standard";

function handleNewProjectTierChange(tier) {
  currentNewProjectTier = tier || "standard";
  const lblStandard = document.getElementById("lbl-new-proj-tier-standard");
  const lblPro = document.getElementById("lbl-new-proj-tier-pro");
  const radioStandard = document.getElementById("new-project-tier-standard");
  const radioPro = document.getElementById("new-project-tier-pro");

  if (currentNewProjectTier === "standard") {
    if (radioStandard) radioStandard.checked = true;
    if (lblStandard) {
      lblStandard.style.borderColor = "#10b981";
      lblStandard.style.background = "rgba(16, 185, 129, 0.10)";
    }
    if (lblPro) {
      lblPro.style.borderColor = "var(--border-color)";
      lblPro.style.background = "rgba(255, 255, 255, 0.03)";
    }
  } else {
    if (radioPro) radioPro.checked = true;
    if (lblPro) {
      lblPro.style.borderColor = "#8b5cf6";
      lblPro.style.background = "rgba(139, 92, 246, 0.12)";
    }
    if (lblStandard) {
      lblStandard.style.borderColor = "var(--border-color)";
      lblStandard.style.background = "rgba(255, 255, 255, 0.03)";
    }
  }

  populateVoiceSelects(currentNewProjectTier);
}

function populateVoiceSelects(tier = currentNewProjectTier || "standard") {
  const newProjSelect = document.getElementById("new-project-voice-select");
  const importSelect = document.getElementById("import-voice-select");
  if (!state.voices || state.voices.length === 0) return;

  const isPro = (tier === "cinema_pro");

  // Filter voices according to studio tier
  let filteredVoices = [];
  if (isPro) {
    // Cinema Pro: Fish Drama 3, ElevenLabs, Cartesia, OpenAI, and Edge TTS (for free narrator)
    filteredVoices = state.voices.filter(v => 
      v.engine === "fish_s2" || 
      v.engine === "elevenlabs" || 
      v.engine === "cartesia" || 
      v.engine === "openai" || 
      v.engine === "edge_tts"
    );
  } else {
    // Standard Free: Edge TTS and Kokoro (and fish_s2 if Colab tunnel connected)
    const hasColab = Boolean(state.config?.remote_worker_url);
    filteredVoices = state.voices.filter(v => 
      v.engine === "edge_tts" || 
      v.engine === "kokoro" || 
      (hasColab && v.engine === "fish_s2")
    );
  }

  if (filteredVoices.length === 0) {
    filteredVoices = state.voices;
  }

  const groupDefs = [
    { id: "fish_s2", label: "🎭 Fish Speech Drama 3 (Cinema Emotion Acting)" },
    { id: "elevenlabs", label: "🌟 ElevenLabs Premier (v4 / v3 / Flash)" },
    { id: "cartesia", label: "⚡ Cartesia Sonic (Ultra-Fast 3.6 / 4)" },
    { id: "openai", label: "🤖 OpenAI Audio (gpt-4o-mini / tts-1)" },
    { id: "edge_tts", label: "🌐 Microsoft Edge TTS (300+ Clean Free Cloud Voices)" },
    { id: "kokoro", label: "⚡ Kokoro 82M (On-Device WebGPU • Free)" }
  ];

  let html = "";
  groupDefs.forEach(g => {
    const groupVoices = filteredVoices.filter(v => (v.engine || "fish_s2") === g.id);
    if (groupVoices.length === 0) return;
    html += `<optgroup label="${g.label}">`;
    groupVoices.forEach(v => {
      const isDefault = isPro
        ? (v.id === "voice_stanley_narrator" || v.id === "fish_narrator_dark")
        : (v.id === "en-US-GuyNeural" || v.id === "blend_fenrir_onyx" || (v.id && v.id.includes("GuyNeural")));
      html += `<option value="${v.id}" data-engine="${v.engine || g.id}" ${isDefault ? 'selected' : ''}>${v.flag || '🎙️'} ${v.name} (${v.accent || 'EN'} • ${v.gender || 'Actor'})</option>`;
    });
    html += `</optgroup>`;
  });

  if (newProjSelect) newProjSelect.innerHTML = html;
  if (importSelect) importSelect.innerHTML = html;
}

async function loadProjectsList() {
  try {
    const [projRes, folderRes] = await Promise.all([
      fetch("/api/projects?engine=fish_s2"),
      fetch("/api/folders?engine=fish_s2").catch(() => null)
    ]);
    state.projects = await projRes.json();
    if (folderRes && folderRes.ok) {
      state.folders = await folderRes.json();
    } else {
      state.folders = [];
    }
    populateFolderSelects();
    renderDashboard();
  } catch (err) {
    console.error("Failed to load projects", err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    state.config = await res.json();
    if (state.config.active_engine) {
      state.activeEngine = state.config.active_engine;
    }

    // Check localStorage fallback for remote worker URL across page reloads
    const localRemoteUrl = localStorage.getItem("fish_speech_remote_url");
    if (!state.config.remote_worker_url && localRemoteUrl) {
      console.log("[Studio] Restoring remote worker URL from localStorage:", localRemoteUrl);
      state.config.remote_worker_url = localRemoteUrl;
      state.config.active = true;
      // Sync to server so server-side engine also has it
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remote_worker_url: localRemoteUrl, active_engine: state.activeEngine || "fish_s2" })
      }).catch(() => {});
    } else if (state.config.remote_worker_url) {
      localStorage.setItem("fish_speech_remote_url", state.config.remote_worker_url);
    }

    updateEngineUI(state.config.remote_worker_url, state.config.active);
    if (state.config.tier_status) {
      updateTierDisplay(state.config.tier_status);
    } else {
      fetch("/api/tier/status").then(r => r.json()).then(data => updateTierDisplay(data)).catch(() => {});
    }
    if (state.config.remote_worker_url) {
      checkRemoteWorkerHealth(true);
    }
  } catch (err) {
    console.error("Failed to load config", err);
  }
}

function updateEngineUI(remoteUrl, active, meta = {}) {
  const isFish = (state.activeEngine !== "kokoro");
  const hasApi = Boolean(state.config && state.config.fish_api_key);
  const isHealthy = state.remoteWorkerHealthy !== false;
  const isOnline = Boolean(active && remoteUrl && isHealthy);
  const isOfflineWorker = Boolean(remoteUrl && state.remoteWorkerHealthy === false);

  let badgeText = "🐟 Fish Audio S2 Pro";
  if (isOnline) badgeText = "🚀 S2 Pro GPU Active";
  else if (isOfflineWorker) badgeText = "🔴 GPU Offline";
  else if (hasApi) badgeText = "🔑 Fish Cloud API";
  else badgeText = "🐟 Fish Audio S2 Pro";

  // Update top bar buttons on both views
  const btns = [
    document.getElementById("btn-engine-status"),
    document.getElementById("btn-dashboard-engine-status")
  ];
  btns.forEach(btn => {
    if (!btn) return;
    const label = btn.querySelector(".engine-label");
    if (label && !state.tierStatus) label.textContent = badgeText;
    
    btn.classList.remove("gpu-active", "gpu-offline");
    if (isOnline) {
      btn.classList.add("gpu-active");
      btn.title = `Cloud GPU Active: ${remoteUrl} (Connected)`;
    } else if (isOfflineWorker) {
      btn.classList.add("gpu-offline");
      btn.title = `Remote GPU is OFFLINE or stopped (${remoteUrl}). Click to reconnect or launch Kaggle.`;
    } else if (hasApi) {
      btn.classList.add("gpu-active");
      btn.title = "Fish Audio Cloud API Connected";
    } else {
      btn.title = "Configure Cloud GPU (Google Colab / Kaggle) or Fish API";
    }
  });

  // Update dashboard stats strip engine card
  const statEngineName = document.getElementById("stat-engine-name");
  const statEngineSpeed = document.getElementById("stat-engine-speed");
  const statEngineIcon = document.getElementById("stat-engine-icon");
  if (statEngineName) {
    if (isOnline) statEngineName.textContent = "S2 Pro GPU";
    else if (isOfflineWorker) statEngineName.textContent = "GPU Offline";
    else if (hasApi) statEngineName.textContent = "Fish API";
    else statEngineName.textContent = "Fish S2 Pro";
  }
  if (statEngineSpeed) {
    if (isOnline) statEngineSpeed.textContent = "~0.3s per sentence (Fast)";
    else if (isOfflineWorker) statEngineSpeed.textContent = "Worker Stopped — Click to Reconnect";
    else if (hasApi) statEngineSpeed.textContent = "~0.3s per sentence (Cloud API)";
    else statEngineSpeed.textContent = "Requires Worker / API";
  }
  if (statEngineIcon) statEngineIcon.textContent = isOfflineWorker ? "🔴" : "🐟";

  // Auto-configure parallel concurrency selector
  const concurrencySelect = document.getElementById("batch-concurrency-select");
  if (concurrencySelect) {
    if (isOnline || hasApi) {
      if (concurrencySelect.value === "1") concurrencySelect.value = "3";
    } else {
      concurrencySelect.value = "1";
    }
  }

  // Update batch render button
  const batchBtn = document.getElementById("btn-batch-generate");
  if (batchBtn && !state.isBatchRunning) {
    batchBtn.textContent = (isOnline || hasApi) ? "⚡ Render All" : "⚡ Render All";
  }

  // Update modal controls
  const urlInput = document.getElementById("colab-url-input");
  if (urlInput && remoteUrl !== undefined) {
    urlInput.value = remoteUrl || "";
  }
  const keyInput = document.getElementById("fish-api-key-input");
  if (keyInput && state.config && state.config.fish_api_key !== undefined) {
    keyInput.value = state.config.fish_api_key || "";
  }

  // Update modal banner
  const bannerTitle = document.getElementById("banner-title");
  const bannerDesc = document.getElementById("banner-desc");
  const bannerEl = document.getElementById("colab-status-banner");
  if (bannerEl) {
    bannerEl.classList.remove("online", "offline", "stopped");
    if (isOnline) {
      bannerEl.classList.add("online");
      if (bannerTitle) bannerTitle.textContent = "Active Mode: Cloud GPU (Tesla T4) 🟢";
      if (bannerDesc) bannerDesc.textContent = `Connected securely to remote worker via ${remoteUrl}`;
    } else if (isOfflineWorker) {
      bannerEl.classList.add("stopped");
      if (bannerTitle) bannerTitle.textContent = "⚠️ Mode: Cloud GPU Stopped / Offline 🔴";
      if (bannerDesc) bannerDesc.textContent = `Remote worker at ${remoteUrl} stopped or is unreachable. Click 'Launch Cloud GPU' to start a new session.`;
    } else if (isFish && hasApi) {
      bannerEl.classList.add("online");
      if (bannerTitle) bannerTitle.textContent = "Active Mode: Fish Cloud API 🔑";
      if (bannerDesc) bannerDesc.textContent = "Inference routes directly to Fish Audio Cloud servers.";
    } else {
      bannerEl.classList.add("offline");
      if (bannerTitle) bannerTitle.textContent = isFish ? "Current Mode: No Worker or API Connected" : "Current Mode: Local CPU Engine";
      if (bannerDesc) bannerDesc.textContent = isFish ? "Connect Google Colab GPU or paste your Fish API key below." : "Generating on local CPU (~14s per sentence). Connect Cloud GPU for 100x speed!";
    }
  }
}

function updateEngineBadges() {
  updateEngineUI(state.config?.remote_worker_url, state.config?.active);
}

// ---------------- WORKER HEALTH SENTINEL ---------------- //
let _isCheckingHealth = false;

async function checkRemoteWorkerHealth(silent = false) {
  if (_isCheckingHealth) return;
  // If actively synthesizing audio, the GPU worker is busy processing requests!
  // Do NOT send health checks or disconnect the worker while it is generating audio.
  if ((window.activeBlockProgressQueue && window.activeBlockProgressQueue.length > 0) || state.isBatchRunning) {
    return;
  }

  const remoteUrl = (state.config && state.config.remote_worker_url) || "";
  const hasApi = Boolean(state.config && state.config.fish_api_key);

  if (!remoteUrl) {
    state.remoteWorkerHealthy = null;
    updateEngineUI("", false);
    return;
  }

  _isCheckingHealth = true;
  try {
    const res = await fetch("/api/test_remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: remoteUrl })
    });
    const data = await res.json().catch(() => ({ ok: false }));

    if (res.ok && data.ok) {
      const wasOffline = (state.remoteWorkerHealthy === false);
      state.remoteWorkerHealthy = true;
      state.config.active = true;
      updateEngineUI(remoteUrl, true, { hardware: data.details?.hardware });
      
      const isKaggle = (state.config?.remote_worker_provider === "kaggle");
      if (isKaggle) {
        const launchBtn = document.getElementById("btn-launch-kaggle");
        const stopBtn = document.getElementById("btn-stop-kaggle");
        if (launchBtn) {
          launchBtn.textContent = "🟢 GPU Active & Connected";
          launchBtn.style.background = "#10b981";
          launchBtn.disabled = true;
        }
        if (stopBtn) stopBtn.style.display = "inline-block";
      }

      if (wasOffline && !silent) {
        showToast("🟢 Cloud GPU reconnected successfully!");
      }
    } else {
      // If synthesis started while we were awaiting response, ignore
      if ((window.activeBlockProgressQueue && window.activeBlockProgressQueue.length > 0) || state.isBatchRunning) {
        return;
      }
      state.remoteWorkerHealthy = false;
      // NOTE: Do NOT wipe remote_worker_url here! The worker may simply be busy generating or warming up.
      // The URL is only cleared when the user explicitly clicks "Disconnect" in the Cloud GPU modal.
      updateEngineUI(remoteUrl, false, { error: data.error || "Worker busy or unreachable" });

      const launchBtn = document.getElementById("btn-launch-kaggle");
      const stopBtn = document.getElementById("btn-stop-kaggle");
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      if (stopBtn) stopBtn.style.display = "none";
    }
  } catch (err) {
    if ((window.activeBlockProgressQueue && window.activeBlockProgressQueue.length > 0) || state.isBatchRunning) {
      return;
    }
    state.remoteWorkerHealthy = false;
    updateEngineUI(remoteUrl, false, { error: err.message });
  } finally {
    _isCheckingHealth = false;
  }
}

// Auto-check worker health on tab focus, visibility change, and periodic poll
window.addEventListener("focus", () => {
  if (state.config && state.config.remote_worker_url) {
    checkRemoteWorkerHealth(true);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.config && state.config.remote_worker_url) {
    checkRemoteWorkerHealth(true);
  }
});

setInterval(() => {
  if (document.visibilityState === "visible" && state.config && state.config.remote_worker_url) {
    checkRemoteWorkerHealth(true);
  }
}, 25000);

async function openProject(projectId, updateUrl = true) {
  try {
    const res = await fetch(`/api/project?id=${encodeURIComponent(projectId)}&t=${Date.now()}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}: Project not found`);
    }
    state.currentProject = await res.json();
    state.activeEngine = state.currentProject?.engine || "fish_s2";
    state.activeBlockIndex = 0;
    state.selectedBlockIndices = new Set([0]);
    state.lastClickedIndex = 0;
    state.undoStack = [];
    state.redoStack = [];
    updateUndoRedoUI();
    loadSavedCharactersForCurrentProject();

    // Multi-Engine Character Continuity Auto-Healing:
    // Ensure every block has an engine and voice aligned to its character, preventing any orphaned or mismatched blocks
    if (state.currentProject && Array.isArray(state.currentProject.blocks)) {
      const charMap = {};
      (state.savedCharacters || []).forEach(c => { if (c && c.id) charMap[c.id] = c; });
      state.currentProject.blocks.forEach(block => {
        if (!block) return;
        const char = block.character_id ? charMap[block.character_id] : (block.speaker ? (state.savedCharacters || []).find(c => c && c.name === block.speaker) : null);
        if (char) {
          if (!block.character_id) block.character_id = char.id;
          if (!block.engine && char.engine) block.engine = char.engine;
          if (!block.is_custom_edited) {
            if (char.engine && block.engine !== char.engine) block.engine = char.engine;
            if (char.voice_id && block.voice_id !== char.voice_id) block.voice_id = char.voice_id;
          }
        } else if (!block.engine) {
          block.engine = state.currentProject.engine || "fish_s2";
        }
      });
    }

    if (state.currentProject && Array.isArray(state.currentProject.blocks)) {
      state.currentProject.blocks.forEach(block => {
        if (!block) return;
        // Sanitize any stale blob: URLs from previous browser sessions
        if (block.audio_url && block.audio_url.startsWith("blob:")) {
          block.audio_url = block.hash ? `/api/audio/${block.hash}.wav` : "";
          if (!block.audio_url) {
            delete block.audio_url;
            delete block.cachedSig;
          }
        }
        if (block.cachedAudioUrl && block.cachedAudioUrl.startsWith("blob:")) {
          block.cachedAudioUrl = block.hash ? `/api/audio/${block.hash}.wav` : "";
          if (!block.cachedAudioUrl) delete block.cachedAudioUrl;
        }
        if (block.take_cache) {
          Object.keys(block.take_cache).forEach(k => {
            const t = block.take_cache[k];
            if (t && t.audio_url && t.audio_url.startsWith("blob:")) {
              if (block.hash) {
                t.audio_url = `/api/audio/${block.hash}.wav`;
              } else {
                delete block.take_cache[k];
              }
            }
          });
        }

        const sig = getBlockSignature(block);
        if (block.cachedAudioUrl || block.audio_url) {
          block.audio_url = block.cachedAudioUrl || block.audio_url;
          block.cachedAudioUrl = block.audio_url;
          if (!block.cachedSig) {
            block.cachedSig = sig;
          }
          if (block.cachedSig === sig) {
            saveCurrentTakeToBlockCache(block);
          }
        }
      });
    }

    const isFish = (state.activeEngine || "fish_s2") === "fish_s2";
    const emotionSection = document.getElementById("inspector-emotion-section");
    if (emotionSection) emotionSection.style.display = isFish ? "block" : "none";
    const zeroShotSection = document.getElementById("inspector-zero-shot-section");
    if (zeroShotSection) zeroShotSection.style.display = isFish ? "block" : "none";

    switchToView("studio", updateUrl);

    try {
      renderStudio();
    } catch (renderErr) {
      console.error("renderStudio error:", renderErr);
    }

    try {
      syncProjectAudioCache();
    } catch (syncErr) {
      console.warn("syncProjectAudioCache warning:", syncErr);
    }

    try {
      initAIAgentSessions();
      updateAIAgentContextUI();
    } catch (agentErr) {
      console.warn("initAIAgentSessions warning:", agentErr);
    }

    if (state.currentProject && (state.currentProject.is_stub || (!state.currentProject.blocks?.length && state.currentProject.source_epub))) {
      setTimeout(() => openStubDirectModal(), 150);
    }
  } catch (err) {
    console.error("Failed to load project: " + err);
    showToast(`⚠️ Could not load project: ${err.message || 'Unknown error'}`);
    switchToView("dashboard", true);
  }
}

async function saveCurrentProject() {
  if (!state.currentProject) return;
  try {
    await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.currentProject)
    });
  } catch (err) {
    console.error("Save error:", err);
  }
}

let saveTimeout = null;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveCurrentProject, 600);
}

function createBlockSynthesizePayload(block, forceRefresh = false) {
  const char = getCharacterById(block.character_id || block.speaker);
  let activeEng = block.engine || (char && char.engine) || state.activeEngine || "fish_s2";
  let activeMod = block.model || (char && char.model) || state.activeModel || (state.currentProject && state.currentProject.model) || "";
  let chosenVoiceId = block.voice_id || (char && (char.voice_id || char.assigned_voice_id));

  // Voice compatibility guard per engine
  if (activeEng === "edge_tts") {
    if (!chosenVoiceId || !chosenVoiceId.includes("Neural")) {
      chosenVoiceId = "en-US-GuyNeural";
    }
  } else if (activeEng === "kokoro") {
    if (!chosenVoiceId || chosenVoiceId.startsWith("fish_") || chosenVoiceId.includes("Neural")) {
      chosenVoiceId = "af_bella";
    }
  } else if (activeEng === "elevenlabs") {
    if (!chosenVoiceId || chosenVoiceId.includes("Neural") || chosenVoiceId.startsWith("af_") || chosenVoiceId.startsWith("am_")) {
      chosenVoiceId = "21m00Tcm4TlvDq8ikWAM";
    }
  } else if (activeEng === "cartesia") {
    if (!chosenVoiceId || chosenVoiceId.includes("Neural") || chosenVoiceId.startsWith("af_") || chosenVoiceId.startsWith("am_")) {
      chosenVoiceId = "a0e99841-438c-4a64-b679-ae501e7d6091";
    }
  } else if (activeEng === "openai") {
    if (!chosenVoiceId || chosenVoiceId.includes("Neural") || chosenVoiceId.startsWith("af_") || chosenVoiceId.startsWith("am_")) {
      chosenVoiceId = "alloy";
    }
  } else if (activeEng === "fish_s2") {
    if (chosenVoiceId && (chosenVoiceId.includes("Neural") || chosenVoiceId.startsWith("af_") || chosenVoiceId.startsWith("am_"))) {
      chosenVoiceId = "fish_narrator_dark";
    }
  }
  const voiceObj = getVoiceById(chosenVoiceId);

  // Reference audio resolution: Character explicit reference audio OR Voice metadata reference audio ALWAYS takes precedence over stale block.reference_audio
  let refAudio = (char && char.reference_audio) || "";
  let refText = (char && char.reference_text) || "";

  if (voiceObj && voiceObj.reference_audio) {
    if (!refAudio || (refAudio.includes("ref_fish_") && voiceObj.reference_audio.includes("ref_fish_") && refAudio !== voiceObj.reference_audio)) {
      refAudio = voiceObj.reference_audio;
      refText = voiceObj.reference_text || "";
    }
  }

  if (!refAudio && block.reference_audio) {
    refAudio = block.reference_audio;
    refText = block.reference_text || "";
  }

  if (voiceObj && voiceObj.reference_audio && (!refAudio || refAudio !== voiceObj.reference_audio) && !char?.reference_audio) {
    refAudio = voiceObj.reference_audio;
    refText = voiceObj.reference_text || "";
  }

  return {
    text: block.text,
    voice_id: chosenVoiceId,
    engine: activeEng,
    model: activeMod,
    emotion_tag: block.emotion_tag || "",
    reference_audio: refAudio,
    reference_text: refText,
    temperature: block.temperature !== undefined ? Number(block.temperature) : 0.70,
    top_p: block.top_p !== undefined ? Number(block.top_p) : 0.85,
    blend_weights: block.blend_weights || (char && char.blend_weights) || (voiceObj && voiceObj.blend_weights),
    speed: Number(block.speed || (activeEng === "fish_s2" ? 1.0 : 0.90)),
    gain: Number(block.gain || 1.0),
    pitch_shift: Number(block.pitch_shift || 0.0),
    warmth: Number(block.warmth || 0.0),
    clarity: Number(block.clarity || 0.0),
    reverb: Number(block.reverb || 0.0),
    radio_fx: Boolean(block.radio_fx),
    force_refresh: Boolean(forceRefresh),
    fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
  };
}

function getEngineModelBadge(bEngine, bModel) {
  let badgeText = "Drama 3";
  let badgeIcon = "🎭";
  let badgeBg = "rgba(245, 158, 11, 0.15)";
  let badgeColor = "#fcd34d";

  if (bEngine === "fish_s2") {
    badgeText = (bModel === "s2_pro" || bModel === "s2.1-pro" || bModel === "s2-pro") ? "S2.1 Pro" : "Drama 3";
    badgeIcon = "🎭";
    badgeBg = "rgba(245, 158, 11, 0.15)";
    badgeColor = "#fcd34d";
  } else if (bEngine === "elevenlabs") {
    badgeText = (bModel === "v3") ? "Eleven v3" : (bModel === "flash_v2.5" ? "Flash v2.5" : "Eleven v4");
    badgeIcon = "🌟";
    badgeBg = "rgba(139, 92, 246, 0.15)";
    badgeColor = "#c4b5fd";
  } else if (bEngine === "cartesia") {
    badgeText = (bModel === "sonic_3.6") ? "Sonic 3.6" : "Sonic 4";
    badgeIcon = "⚡";
    badgeBg = "rgba(236, 72, 153, 0.15)";
    badgeColor = "#f472b6";
  } else if (bEngine === "openai") {
    badgeText = (bModel === "tts-1") ? "tts-1" : "gpt-4o";
    badgeIcon = "🤖";
    badgeBg = "rgba(16, 185, 129, 0.15)";
    badgeColor = "#6ee7b7";
  } else if (bEngine === "edge_tts") {
    badgeText = "Edge TTS";
    badgeIcon = "🌐";
    badgeBg = "rgba(16, 185, 129, 0.15)";
    badgeColor = "#34d399";
  } else if (bEngine === "kokoro") {
    badgeText = "Kokoro 82M";
    badgeIcon = "⚡";
    badgeBg = "rgba(59, 130, 246, 0.15)";
    badgeColor = "#93c5fd";
  }
  return { text: badgeText, bg: badgeBg, color: badgeColor, icon: badgeIcon };
}

function getBlockSignature(block) {
  if (!block) return "";
  const text = (block.text || "").trim();
  const char = (typeof getCharacterById === "function") ? getCharacterById(block.character_id || block.speaker) : null;
  const voice = block.voice_id || (char && (char.voice_id || char.assigned_voice_id)) || "";
  const engine = block.engine || (char && char.engine) || state.activeEngine || "fish_s2";
  const model = block.model || (char && char.model) || state.activeModel || "";
  const emotion = block.emotion_tag || "";
  let refAudio = (char && char.reference_audio) || "";
  const voiceObj = (typeof getVoiceById === "function") ? getVoiceById(voice) : null;
  if (voiceObj && voiceObj.reference_audio) {
    if (!refAudio || (refAudio.includes("ref_fish_") && voiceObj.reference_audio.includes("ref_fish_") && refAudio !== voiceObj.reference_audio)) {
      refAudio = voiceObj.reference_audio;
    }
  }
  if (!refAudio && block.reference_audio) {
    refAudio = block.reference_audio;
  }
  if (voiceObj && voiceObj.reference_audio && (!refAudio || refAudio !== voiceObj.reference_audio) && !char?.reference_audio) {
    refAudio = voiceObj.reference_audio;
  }

  const speed = Number(block.speed || (engine === "fish_s2" ? 1.0 : 0.90)).toFixed(2);
  const gain = Number(block.gain || 1.0).toFixed(2);
  const temp = Number(block.temperature !== undefined ? block.temperature : 0.70).toFixed(2);
  const topP = Number(block.top_p !== undefined ? block.top_p : 0.85).toFixed(2);
  const pitch = Number(block.pitch_shift || 0.0).toFixed(1);
  const warmth = Number(block.warmth || 0.0).toFixed(1);
  const clarity = Number(block.clarity || 0.0).toFixed(1);
  const reverb = Number(block.reverb || 0.0).toFixed(2);
  const filter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();
  let blendStr = "";
  const blend = block.blend_weights || (char && char.blend_weights) || (voiceObj && voiceObj.blend_weights);
  if (blend) {
    blendStr = Object.entries(blend).sort().map(([k, v]) => `${k}:${Number(v).toFixed(2)}`).join(",");
  }
  return `${engine}__${model}__${text}__${voice}__${emotion}__${refAudio}__${temp}__${topP}__${blendStr}__${speed}__${gain}__${pitch}__${warmth}__${clarity}__${reverb}__${filter}`;
}

function saveCurrentTakeToBlockCache(block) {
  if (!block) return;
  const sig = getBlockSignature(block);
  const audioUrl = block.cachedAudioUrl || block.audio_url;
  if (!audioUrl) return;
  if (!block.take_cache) block.take_cache = {};
  block.take_cache[sig] = {
    audio_url: audioUrl,
    duration: block.duration,
    cachedSig: sig,
    timestamp: Date.now()
  };
}

function getVoiceById(voiceId) {
  const vid = voiceId || "blend_fenrir_onyx";
  return state.voices.find(v => v.id === vid) || {
    id: vid,
    name: vid,
    badge: (vid || "VO").slice(0, 2).toUpperCase(),
    color: "#ea580c",
    flag: "🎙️",
    timbre: "Custom Voice"
  };
}

// ---------------- VIEW ROUTING & DIRECT LINKING ---------------- //

function switchToView(viewName, updateUrl = true) {
  state.currentView = viewName;
  const authEl = document.getElementById("view-auth-gate");
  const dashEl = document.getElementById("view-dashboard");
  const studioEl = document.getElementById("view-studio");

  // Always dismiss any open modal and dropdown menu
  const colabModalEl = document.getElementById("colab-modal");
  if (colabModalEl) colabModalEl.classList.remove("active");
  const userMenuEl = document.getElementById("user-dropdown-menu");
  if (userMenuEl) userMenuEl.style.display = "none";

  if (viewName !== "auth" && window.google?.accounts?.id) {
    try {
      google.accounts.id.cancel();
    } catch (e) {}
  }

  if (viewName === "auth") {
    if (authEl) authEl.style.display = "flex";
    if (dashEl) dashEl.style.display = "none";
    if (studioEl) studioEl.style.display = "none";
    document.title = "Sign In — Kashva Voice";
    if (updateUrl) {
      history.pushState({ view: "auth" }, "", "/login");
    }
  } else if (viewName === "dashboard") {
    if (authEl) authEl.style.display = "none";
    if (dashEl) dashEl.style.display = "flex";
    if (studioEl) studioEl.style.display = "none";
    document.title = "Story Projects — Kashva Voice";
    if (updateUrl) {
      history.pushState({ view: "dashboard" }, "", "/app/");
    }
    loadProjectsList();
  } else {
    if (authEl) authEl.style.display = "none";
    if (dashEl) dashEl.style.display = "none";
    if (studioEl) studioEl.style.display = "flex";
    const projTitle = state.currentProject?.title || "Story Studio";
    document.title = `${projTitle} — Kashva Voice`;
    if (updateUrl && state.currentProject?.id) {
      const studioUrl = `/app/studio?project=${encodeURIComponent(state.currentProject.id)}`;
      history.pushState({ view: "studio", projectId: state.currentProject.id }, "", studioUrl);
    }
  }
}

// ---------------- DASHBOARD STATE & CONTROLS ---------------- //

let dashboardFilter = "all";
let dashboardSort = "recent";
let dashboardSearchQuery = "";
let dashboardLayout = "grid";
let currentDashboardAudio = null;
let activePreviewProjectId = null;

function formatAudioDuration(totalSeconds) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return "0s";
  const sec = Math.round(totalSeconds);
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function handleDashboardSearch(val) {
  dashboardSearchQuery = (val || "").trim();
  const clearBtn = document.getElementById("dashboard-search-clear");
  if (clearBtn) clearBtn.style.display = dashboardSearchQuery ? "inline-flex" : "none";
  renderDashboard();
}

function clearDashboardSearch() {
  dashboardSearchQuery = "";
  const input = document.getElementById("dashboard-search-input");
  if (input) input.value = "";
  const clearBtn = document.getElementById("dashboard-search-clear");
  if (clearBtn) clearBtn.style.display = "none";
  renderDashboard();
}

function setDashboardFilter(filter) {
  dashboardFilter = filter;
  const pillBtns = document.querySelectorAll("#dashboard-filter-pills .filter-pill");
  pillBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === filter);
  });
  renderDashboard();
}

function handleDashboardSort(sortVal) {
  dashboardSort = sortVal;
  renderDashboard();
}

function setDashboardLayout(layout) {
  dashboardLayout = layout;
  const gridBtn = document.getElementById("btn-layout-grid");
  const listBtn = document.getElementById("btn-layout-list");
  if (gridBtn) gridBtn.classList.toggle("active", layout === "grid");
  if (listBtn) listBtn.classList.toggle("active", layout === "list");
  renderDashboard();
}

async function loadSampleStoryIntoProject() {
  openNewProjectModal();
  await loadSampleIntoNewProject();
}

function toggleDashboardPreview(projectId, audioUrl, buttonEl) {
  if (!audioUrl) return;

  if (activePreviewProjectId === projectId && currentDashboardAudio && !currentDashboardAudio.paused) {
    currentDashboardAudio.pause();
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
    return;
  }

  if (currentDashboardAudio) {
    currentDashboardAudio.pause();
    currentDashboardAudio = null;
    document.querySelectorAll(".preview-audio-btn.playing").forEach(btn => {
      btn.innerHTML = "▶ Preview";
      btn.classList.remove("playing");
    });
  }

  activePreviewProjectId = projectId;
  if (buttonEl) {
    buttonEl.innerHTML = "⏸ Pause";
    buttonEl.classList.add("playing");
  }

  currentDashboardAudio = new Audio(audioUrl);
  currentDashboardAudio.onended = () => {
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
  };
  currentDashboardAudio.onerror = () => {
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
    showToast("⚠️ Could not play audio preview");
  };
  currentDashboardAudio.play().catch(e => {
    console.warn("Audio play prevented:", e);
    activePreviewProjectId = null;
    if (buttonEl) {
      buttonEl.innerHTML = "▶ Preview";
      buttonEl.classList.remove("playing");
    }
  });
}

async function handleDuplicateProject(projectId) {
  try {
    showToast("📋 Duplicating project...");
    const res = await fetch("/api/projects/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId })
    });
    const data = await res.json();
    const proj = data.project || (data.id ? data : null);
    if (proj && data.success !== false) {
      showToast(`✓ Duplicated as "${proj.title || "Copy"}"`);
      await loadProjectsList();
    } else {
      showToast("❌ Failed to duplicate project: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    showToast("❌ Duplicate error: " + err.message);
  }
}

function showMessageCard({
  icon = "ℹ️",
  title = "Notification",
  subtitle = "",
  body = "",
  primaryText = "OK",
  secondaryText = "Cancel",
  showSecondary = false,
  danger = false
} = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll(".message-card-backdrop").forEach(el => el.remove());

    const backdrop = document.createElement("div");
    backdrop.className = "message-card-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "message-card-dialog";

    dialog.innerHTML = `
      <div class="message-card-header">
        <div class="message-card-icon-wrap" style="${danger ? 'background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35);' : ''}">${icon}</div>
        <div class="message-card-title-group">
          <h3 class="message-card-title">${escapeHtml(title)}</h3>
          ${subtitle ? `<span class="message-card-subtitle">${escapeHtml(subtitle)}</span>` : ''}
        </div>
        <button class="message-card-close" aria-label="Close">✕</button>
      </div>
      <div class="message-card-body">
        ${body}
      </div>
      <div class="message-card-footer">
        ${showSecondary ? `<button class="btn btn-secondary message-card-secondary-btn" style="padding: 7px 16px; border-radius: 8px; font-weight: 600; cursor: pointer;">${escapeHtml(secondaryText)}</button>` : ''}
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} message-card-primary-btn" style="padding: 7px 18px; border-radius: 8px; font-weight: 700; cursor: pointer;">${escapeHtml(primaryText)}</button>
      </div>
    `;

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      dialog.style.animation = "messageCardSlideUp 0.16s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards";
      backdrop.style.animation = "messageCardFadeIn 0.16s cubic-bezier(0.16, 1, 0.3, 1) reverse forwards";
      setTimeout(() => {
        backdrop.remove();
        resolve(result);
      }, 140);
    };

    dialog.querySelector(".message-card-close").addEventListener("click", () => finish(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) finish(false);
    });

    const primaryBtn = dialog.querySelector(".message-card-primary-btn");
    if (primaryBtn) {
      primaryBtn.focus();
      primaryBtn.addEventListener("click", () => finish(true));
    }

    const secondaryBtn = dialog.querySelector(".message-card-secondary-btn");
    if (secondaryBtn) {
      secondaryBtn.addEventListener("click", () => finish(false));
    }

    const handleKey = (e) => {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", handleKey);
        finish(false);
      }
    };
    document.addEventListener("keydown", handleKey);
  });
}

async function handleCopyProjectToOtherEngine(projectId, targetEngine, title) {
  const targetName = targetEngine === "kokoro" ? "Kokoro 82M" : "Fish Speech";
  const icon = targetEngine === "kokoro" ? "⚡" : "🐟";
  try {
    showToast(`⏳ Copying "${title}" to ${targetName}...`);
    const res = await fetch("/api/projects/copy_to_engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, target_engine: targetEngine })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to copy project");
    }
    const newProj = data.project;
    const destUrl = `/studio?project=${encodeURIComponent(newProj.id)}`;
    showToast(`✅ Copied as "${newProj.title}"!`);

    const openNow = await showMessageCard({
      icon: icon,
      title: "Project Copied Successfully",
      subtitle: `Ready in ${targetName}`,
      body: `
        <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px;">
          <div style="font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 4px;">New Project Title</div>
          <div style="font-size: 15px; font-weight: 700; color: #f8fafc;">${escapeHtml(newProj.title)}</div>
        </div>
        <p style="margin: 0; color: #cbd5e1; font-size: 13.5px;">All manuscript blocks and dialogue have been transferred with voice casting mapped to <strong>${targetName}</strong>.</p>
        <p style="margin: 8px 0 0 0; color: #94a3b8; font-size: 12.5px;">Would you like to open it in ${targetName} right now?</p>
      `,
      primaryText: `Open in ${targetName} ↗`,
      secondaryText: "Stay Here",
      showSecondary: true
    });

    if (openNow) {
      window.open(destUrl, "_blank");
    }
  } catch (err) {
    showToast("❌ Could not copy project: " + err.message);
  }
}

async function handleCopyCurrentProjectToOther(targetEngine) {
  if (!state.currentProject) {
    showToast("⚠️ Open a story project first to copy.");
    return;
  }
  try {
    await saveProjectToServer();
  } catch (e) {}
  await handleCopyProjectToOtherEngine(state.currentProject.id, targetEngine, state.currentProject.title || "Project");
}

async function handleRenameProject(projectId, currentTitle) {
  const newTitle = prompt("Enter new project title:", currentTitle);
  if (!newTitle || newTitle.trim() === "" || newTitle.trim() === currentTitle) {
    return;
  }
  try {
    showToast("✏️ Renaming project...");
    const res = await fetch("/api/projects/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, title: newTitle.trim() })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✓ Renamed to "${data.title || newTitle.trim()}"`);
      await loadProjectsList();
    } else {
      showToast("❌ Failed to rename: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    showToast("❌ Rename error: " + err.message);
  }
}

// ---------------- VIEW 1: DASHBOARD RENDERING ---------------- //

function populateFolderSelects() {
  const epubSel = document.getElementById("epub-folder-select");
  const newProjSel = document.getElementById("new-project-folder-select");
  const moveSel = document.getElementById("move-destination-folder-select");

  const folders = state.folders || [];

  if (epubSel) {
    const curVal = epubSel.value;
    epubSel.innerHTML = `
      <option value="">📁 None (Standalone Project)</option>
      <option value="__new__">✨ + Create New Series Folder...</option>
      ${folders.map(f => `<option value="${f.id}">📚 ${escapeHtml(f.title)} (${f.chapter_count || 0} chapters)</option>`).join("")}
    `;
    if (curVal && folders.some(f => f.id === curVal)) {
      epubSel.value = curVal;
    } else if (state.activeFolderId) {
      epubSel.value = state.activeFolderId;
    }
  }

  if (newProjSel) {
    const curVal = newProjSel.value;
    newProjSel.innerHTML = `
      <option value="">📁 None (Standalone Story)</option>
      ${folders.map(f => `<option value="${f.id}">📚 ${escapeHtml(f.title)}</option>`).join("")}
    `;
    if (curVal && folders.some(f => f.id === curVal)) {
      newProjSel.value = curVal;
    } else if (state.activeFolderId) {
      newProjSel.value = state.activeFolderId;
    }
  }

  if (moveSel) {
    moveSel.innerHTML = `
      <option value="none">📁 Root (Standalone Story - No Folder)</option>
      ${folders.map(f => `<option value="${f.id}">📚 ${escapeHtml(f.title)}</option>`).join("")}
    `;
  }
}

function createFolderCardElement(f) {
  const card = document.createElement("div");
  card.className = "folder-card";
  const isSeriesParent = Boolean(f.subfolder_count && f.subfolder_count > 0);
  const chCount = isSeriesParent 
    ? (f.total_series_chapters || (f.subfolders || []).reduce((acc, s) => acc + (s.chapter_count || 0), 0))
    : (f.chapter_count || (f.chapter_ids ? f.chapter_ids.length : 0));
  const totalSentences = isSeriesParent ? (f.total_series_sentences || 0) : (f.block_count || 0);
  const renderedCount = f.rendered_count || 0;
  const percent = totalSentences > 0 ? Math.min(100, Math.round((renderedCount / totalSentences) * 100)) : 0;
  const durationStr = formatAudioDuration(isSeriesParent ? (f.total_series_duration || 0) : (f.total_duration || 0));
  const castCount = (f.characters || []).length;
  const authorStr = f.author ? `by ${escapeHtml(f.author)}` : "";

  card.innerHTML = `
    <div class="folder-card-top">
      <div class="folder-icon-badge">📚</div>
      <div style="flex: 1; min-width: 0;">
        <div class="folder-card-title" title="${escapeHtml(f.title)}">${escapeHtml(f.title)}</div>
        ${authorStr ? `<div class="folder-card-author">${authorStr}</div>` : ''}
      </div>
      <span class="badge" style="background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.3); font-size: 11px;">
        ${isSeriesParent ? `${f.subfolder_count} Books · ${chCount} Ch.` : `${chCount} Ch.`}
      </span>
    </div>

    ${f.description ? `<div class="folder-card-desc">${escapeHtml(f.description)}</div>` : ''}

    <div class="project-render-bar" style="margin-top: 10px;" title="${renderedCount} of ${totalSentences} sentences rendered (${percent}%)">
      <div class="project-render-fill" style="width: ${percent}%;"></div>
    </div>

    <div class="folder-card-metrics">
      <div class="project-meta-pill"><span>📖</span> <strong>${chCount}</strong> chapters${isSeriesParent ? ` (${f.subfolder_count} books)` : ''}</div>
      <div class="project-meta-pill"><span>📝</span> <strong>${totalSentences}</strong> lines</div>
      <div class="project-meta-pill pill-duration"><span>⏱️</span> <strong>${durationStr}</strong></div>
      <div class="project-meta-pill" style="cursor: pointer;" onclick="event.stopPropagation(); openMasterCastModal('${f.id}')" title="Click to view & edit Universe Master Cast">
        <span>🎭</span> <strong>${castCount}</strong> Cast
      </div>
    </div>

    <div class="folder-card-footer">
      <button type="button" class="btn btn-primary" onclick="openFolderView('${f.id}')" style="font-size: 12px; padding: 6px 14px; font-weight: 600;">
        Open Series ➔
      </button>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="card-icon-btn" onclick="openMasterCastModal('${f.id}')" title="Universe Master Cast Directory">🎭</button>
        <button type="button" class="card-icon-btn" onclick="handleExportFullAudiobook('${f.id}')" title="Export Master Audiobook (Continuous WAV + Chapters JSON)">🎵</button>
        <button type="button" class="card-icon-btn" onclick="openNewFolderModal('${f.id}')" title="Edit Series Info">✏️</button>
        <button type="button" class="card-icon-btn" onclick="handleDeleteFolder('${f.id}')" title="Delete Series">🗑️</button>
      </div>
    </div>
  `;

  card.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest(".project-meta-pill")) return;
    openFolderView(f.id);
  });

  return card;
}

function renderDashboard() {
  const grid = document.getElementById("projects-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const projects = state.projects || [];
  state.activeEngine = "fish_s2";

  // Update header branding badge & title to match Kashva Voice
  const brandBadge = document.getElementById("dashboard-brand-badge");
  const brandTitle = document.getElementById("dashboard-brand-title");
  if (brandBadge) {
    brandBadge.textContent = "Kashva";
    brandBadge.style.background = "linear-gradient(135deg, #6366f1, #4f46e5)";
  }
  if (brandTitle) {
    brandTitle.textContent = "Voice";
  }

  // 1. Calculate top metrics strip stats
  const totalProjectsCount = projects.length;
  let totalSentencesCount = 0;
  let totalRenderedAudioSec = 0;
  let countReady = 0;
  let countProgress = 0;
  let countDraft = 0;

  projects.forEach(p => {
    const total = p.block_count || 0;
    const rendered = p.rendered_count || 0;
    totalSentencesCount += total;
    totalRenderedAudioSec += (p.total_duration || 0);

    if (total > 0 && rendered >= total) {
      countReady++;
    } else if (rendered > 0) {
      countProgress++;
    } else {
      countDraft++;
    }
  });

  const statProjects = document.getElementById("stat-total-projects");
  if (statProjects) statProjects.textContent = totalProjectsCount;

  const statSentences = document.getElementById("stat-total-sentences");
  if (statSentences) statSentences.textContent = totalSentencesCount;

  const statAudio = document.getElementById("stat-total-audio");
  if (statAudio) statAudio.textContent = formatAudioDuration(totalRenderedAudioSec);

  const dashCount = document.getElementById("dashboard-project-count");
  if (dashCount) {
    dashCount.textContent = `${totalProjectsCount} project${totalProjectsCount === 1 ? '' : 's'}`;
  }

  // 2. Update filter pill counts
  const cAll = document.getElementById("filter-count-all");
  const cReady = document.getElementById("filter-count-ready");
  const cProg = document.getElementById("filter-count-progress");
  const cDraft = document.getElementById("filter-count-draft");
  if (cAll) cAll.textContent = totalProjectsCount;
  if (cReady) cReady.textContent = countReady;
  if (cProg) cProg.textContent = countProgress;
  if (cDraft) cDraft.textContent = countDraft;

  // 3. Apply layout mode
  if (dashboardLayout === "list") {
    grid.classList.add("projects-list-view");
  } else {
    grid.classList.remove("projects-list-view");
  }

  const breadcrumbEl = document.getElementById("dashboard-breadcrumb");
  const foldersSecEl = document.getElementById("dashboard-folders-section");
  const storiesHeaderEl = document.getElementById("dashboard-stories-header");
  const storiesTitleEl = document.getElementById("dashboard-stories-title");
  const foldersCountBadge = document.getElementById("folders-count-badge");
  const storiesCountBadge = document.getElementById("stories-count-badge");
  const foldersGrid = document.getElementById("dashboard-folders-grid");

  // ================= VIEW A: INSIDE A SPECIFIC SERIES / BOOK FOLDER ================= //
  if (state.activeFolderId) {
    if (foldersSecEl) foldersSecEl.style.display = "none";
    if (storiesHeaderEl) storiesHeaderEl.style.display = "none";

    const activeFolder = (state.folders || []).find(f => f.id === state.activeFolderId) || state.activeFolderData || {
      id: state.activeFolderId,
      title: "Audiobook Series",
      chapter_count: 0,
      characters: []
    };

    if (breadcrumbEl) {
      breadcrumbEl.style.display = "flex";
      if (activeFolder.parent_folder) {
        breadcrumbEl.innerHTML = `
          <button type="button" class="folder-breadcrumb-btn" onclick="exitFolderView()">📁 All Stories &amp; Series</button>
          <span class="folder-breadcrumb-sep">/</span>
          <button type="button" class="folder-breadcrumb-btn" onclick="openFolderView('${activeFolder.parent_folder.id}')">📖 ${escapeHtml(activeFolder.parent_folder.title)}</button>
          <span class="folder-breadcrumb-sep">/</span>
          <span class="folder-breadcrumb-current">📕 ${escapeHtml(activeFolder.title)}</span>
        `;
      } else {
        breadcrumbEl.innerHTML = `
          <button type="button" class="folder-breadcrumb-btn" onclick="exitFolderView()">📁 All Stories &amp; Series</button>
          <span class="folder-breadcrumb-sep">/</span>
          <span class="folder-breadcrumb-current">📖 ${escapeHtml(activeFolder.title)}</span>
        `;
      }
    }

    // Filter projects that belong to this folder
    let folderChapters = projects.filter(p => p.folder_id === state.activeFolderId);
    const orderList = activeFolder.chapter_order || activeFolder.chapter_ids || [];
    if (orderList && orderList.length > 0) {
      folderChapters.sort((a, b) => {
        const idxA = orderList.indexOf(a.id);
        const idxB = orderList.indexOf(b.id);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.chapter_number || 0) - (b.chapter_number || 0);
      });
    } else {
      folderChapters.sort((a, b) => (a.chapter_number || 0) - (b.chapter_number || 0));
    }

    // Calculate folder-level totals
    let fTotalSentences = 0;
    let fRenderedSentences = 0;
    let fTotalDuration = 0;
    folderChapters.forEach(p => {
      fTotalSentences += (p.block_count || 0);
      fRenderedSentences += (p.rendered_count || 0);
      fTotalDuration += (p.total_duration || 0);
    });
    const fPercent = fTotalSentences > 0 ? Math.min(100, Math.round((fRenderedSentences / fTotalSentences) * 100)) : 0;
    const castCount = (activeFolder.characters || []).length;

    // Insert full-width hero banner into dedicated header container (outside cards grid)
    const heroContainer = document.getElementById("dashboard-folder-hero");
    if (heroContainer) {
      heroContainer.style.display = "block";
      heroContainer.innerHTML = `
        <div class="folder-hero-banner">
          <div class="folder-hero-content">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap;">
              <div>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-size: 32px;">📖</span>
                  <div>
                    <h2 style="font-size: 22px; font-weight: 800; color: #fff; margin: 0; letter-spacing: -0.02em;">${escapeHtml(activeFolder.title)}</h2>
                    ${activeFolder.author ? `<div style="font-size: 13.5px; color: #93c5fd; margin-top: 3px; font-weight: 500;">by ${escapeHtml(activeFolder.author)}</div>` : ''}
                  </div>
                </div>
                ${activeFolder.description ? `<p style="font-size: 13px; color: var(--text-muted); margin: 10px 0 0; max-width: 720px; line-height: 1.5;">${escapeHtml(activeFolder.description)}</p>` : ''}
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                <button type="button" class="btn btn-primary" onclick="openNewProjectModal()" style="font-size: 12px; padding: 7px 14px; display: inline-flex; align-items: center; gap: 6px;">
                  <span>＋</span> Add Chapter
                </button>
                <button type="button" class="btn btn-secondary" onclick="openSeriesSettingsModal('${activeFolder.id}')" style="font-size: 12px; padding: 7px 14px; background: rgba(139, 92, 246, 0.25); border-color: rgba(139, 92, 246, 0.6); color: #c4b5fd; display: inline-flex; align-items: center; gap: 6px;" title="Configure Series Defaults & AI Director Preferences">
                  <span>⚙️</span> Series Settings
                </button>
                <button type="button" class="btn btn-secondary" onclick="handleSortFolderChapters('${activeFolder.id}')" style="font-size: 12px; padding: 7px 14px; background: rgba(59, 130, 246, 0.2); border-color: rgba(59, 130, 246, 0.5); color: #93c5fd; display: inline-flex; align-items: center; gap: 6px;" title="Automatically arrange chapters into natural book order (Front Matter -> Ch 1..N -> Back Matter)">
                  <span>✨</span> Auto-Sort by Chapter
                </button>
                <button type="button" class="btn btn-secondary" onclick="handleRemoveFluffChapters('${activeFolder.id}')" style="font-size: 12px; padding: 7px 12px; background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.45); color: #fbbf24; display: inline-flex; align-items: center; gap: 6px;" title="Scan this collection and remove unrendered front-matter/fluff chapters (Copyright, Dedication, Acknowledgments)">
                  <span>🧹</span> Remove Fluff Cards
                </button>
                <button type="button" class="btn btn-secondary" onclick="openMasterCastModal('${activeFolder.id}')" style="font-size: 12px; padding: 7px 14px; background: rgba(139, 92, 246, 0.2); border-color: rgba(139, 92, 246, 0.5); color: #c4b5fd; display: inline-flex; align-items: center; gap: 6px;">
                  <span>🎭</span> Universe Master Cast (${castCount})
                </button>
                <button type="button" class="btn btn-secondary" onclick="handleExportFullAudiobook('${activeFolder.id}')" style="font-size: 12px; padding: 7px 14px; background: rgba(16, 185, 129, 0.2); border-color: rgba(16, 185, 129, 0.5); color: #6ee7b7; display: inline-flex; align-items: center; gap: 6px;">
                  <span>🎵</span> Export Master Audiobook
                </button>
                <button type="button" class="btn btn-ghost" onclick="openNewFolderModal('${activeFolder.id}')" style="font-size: 12px; padding: 7px 10px;" title="Edit Series Info">✏️</button>
                <button type="button" class="btn btn-ghost" onclick="handleDeleteFolder('${activeFolder.id}')" style="font-size: 12px; padding: 7px 10px; color: #f87171;" title="Delete Series">🗑️</button>
              </div>
            </div>

            <div style="display: flex; gap: 16px; margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 12.5px; color: var(--text-muted); flex-wrap: wrap; align-items: center;">
              <span><strong style="color: #fff;">${folderChapters.length}</strong> chapters</span>
              <span style="opacity: 0.4;">•</span>
              <span><strong style="color: #fff;">${fTotalSentences}</strong> sentences</span>
              <span style="opacity: 0.4;">•</span>
              <span><strong style="color: #60a5fa;">${formatAudioDuration(fTotalDuration)}</strong> audio (${fPercent}% rendered)</span>
              <span style="opacity: 0.4;">•</span>
              <span>Universe Cast: <strong style="color: #c4b5fd;">${castCount}</strong> characters</span>
            </div>
          </div>
        </div>
      `;
    }

    const subfolders = activeFolder.subfolders || [];
    if (subfolders.length > 0) {
      const subHeader = document.createElement("div");
      subHeader.style.gridColumn = "1 / -1";
      subHeader.style.marginBottom = "16px";
      subHeader.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h3 style="font-size: 15px; font-weight: 700; color: #fff; margin: 0; display: flex; align-items: center; gap: 8px;">
            <span>📚</span> Books &amp; Volumes in this Series (${subfolders.length})
          </h3>
          <span style="font-size: 11.5px; color: var(--text-muted);">Unified Universe Cast shared across all books</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px;">
          ${subfolders.map(sf => `
            <div class="project-card" style="padding: 16px; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease;" onclick="openFolderView('${sf.id}')">
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 26px;">📕</span>
                  <div>
                    <h4 style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">${escapeHtml(sf.title)}</h4>
                    <div style="font-size: 12px; color: #60a5fa; margin-top: 3px; font-weight: 600;">${sf.chapter_count} chapters</div>
                  </div>
                </div>
                <button type="button" class="btn btn-primary" onclick="openFolderView('${sf.id}')" style="font-size: 11px; padding: 4px 10px;">Open ➔</button>
              </div>
            </div>
          `).join("")}
        </div>
      `;
      grid.appendChild(subHeader);
    }

    if (folderChapters.length === 0) {
      if (subfolders.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "dashboard-empty-state";
        emptyDiv.style.gridColumn = "1 / -1";
        emptyDiv.innerHTML = `
          <div class="empty-icon">📖</div>
          <div class="empty-title">No chapters in this series yet</div>
          <div class="empty-desc">Add existing chapters into this folder or create/import new chapters directly.</div>
          <div style="display: flex; gap: 10px; margin-top: 14px;">
            <button class="btn btn-primary" onclick="openNewProjectModal()">＋ Add Chapter</button>
            <button class="btn btn-secondary" onclick="document.getElementById('dashboard-file-input').click()">📥 Import EPUB Chapter</button>
          </div>
        `;
        grid.appendChild(emptyDiv);
      }
      return;
    }

    // Render each chapter card in order
    folderChapters.forEach((p, chIdx) => {
      const card = renderSingleProjectCard(p, true, chIdx, folderChapters.length, activeFolder.id, activeFolder.title);
      grid.appendChild(card);
    });

    return;
  }

  // ================= VIEW B: ROOT DASHBOARD (FOLDERS + STANDALONE STORIES) ================= //
  if (breadcrumbEl) breadcrumbEl.style.display = "none";
  const rootHeroContainer = document.getElementById("dashboard-folder-hero");
  if (rootHeroContainer) {
    rootHeroContainer.style.display = "none";
    rootHeroContainer.innerHTML = "";
  }

  // 4. Render Series / Collections Grid
  if (state.folders && state.folders.length > 0) {
    if (foldersSecEl) foldersSecEl.style.display = "block";
    if (foldersCountBadge) foldersCountBadge.textContent = state.folders.length;
    if (foldersGrid) {
      foldersGrid.innerHTML = "";
      state.folders.forEach(f => {
        const folderCard = createFolderCardElement(f);
        foldersGrid.appendChild(folderCard);
      });
    }
  } else {
    if (foldersSecEl) foldersSecEl.style.display = "none";
  }

  // 5. Filter projects
  let filtered = [...projects];

  if (dashboardSearchQuery) {
    const q = dashboardSearchQuery.toLowerCase();
    filtered = filtered.filter(p => (p.title || "").toLowerCase().includes(q));
  }

  if (dashboardFilter === "ready") {
    filtered = filtered.filter(p => (p.block_count > 0 && (p.rendered_count || 0) >= p.block_count));
  } else if (dashboardFilter === "progress") {
    filtered = filtered.filter(p => ((p.rendered_count || 0) > 0 && (p.rendered_count || 0) < (p.block_count || 0)));
  } else if (dashboardFilter === "draft") {
    filtered = filtered.filter(p => ((p.rendered_count || 0) === 0));
  }

  // Sort projects
  if (dashboardSort === "recent") {
    filtered.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  } else if (dashboardSort === "sentences") {
    filtered.sort((a, b) => (b.block_count || 0) - (a.block_count || 0));
  } else if (dashboardSort === "duration") {
    filtered.sort((a, b) => (b.total_duration || 0) - (a.total_duration || 0));
  } else if (dashboardSort === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  const isSearchingOrFiltering = Boolean(dashboardSearchQuery) || dashboardFilter !== "all";

  // In root view without search/filters: hide chapters that belong to a folder so root is clean
  if (!isSearchingOrFiltering) {
    filtered = filtered.filter(p => !p.folder_id && !p.parent_series_id);
  }

  if (storiesHeaderEl) {
    storiesHeaderEl.style.display = (state.folders && state.folders.length > 0) ? "flex" : "none";
    if (storiesTitleEl) {
      storiesTitleEl.textContent = isSearchingOrFiltering ? "All Matching Stories" : "Standalone Stories";
    }
    if (storiesCountBadge) {
      storiesCountBadge.textContent = filtered.length;
    }
  }

  // Empty state handling
  if (filtered.length === 0) {
    const isSearching = Boolean(dashboardSearchQuery);
    const hasFilter = dashboardFilter !== "all";
    const emptyState = document.createElement("div");
    emptyState.className = "dashboard-empty-state";
    emptyState.style.gridColumn = "1 / -1";
    emptyState.innerHTML = `
      <div class="empty-icon">${isSearching ? "🔍" : "📂"}</div>
      <div class="empty-title">${isSearching ? `No stories match "${escapeHtml(dashboardSearchQuery)}"` : (hasFilter ? `No projects in this category` : (state.folders?.length ? "No standalone stories (all projects are in Series Folders)" : "No projects yet"))}</div>
      <div class="empty-desc">${isSearching ? "Check spelling or search by a different story title." : (hasFilter ? "Try selecting 'All' or a different filter tab above." : "Create a new story project, or open one of your series folders above.")}</div>
      <div style="display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; justify-content: center;">
        ${isSearching ? `<button class="btn btn-secondary" onclick="clearDashboardSearch()">Clear Search</button>` : ''}
        ${hasFilter ? `<button class="btn btn-secondary" onclick="setDashboardFilter('all')">View All Projects</button>` : ''}
        <button class="btn btn-primary" onclick="openNewProjectModal()">＋ Create Story Project</button>
        <button class="btn btn-secondary" onclick="openNewFolderModal()">📁 New Series Folder</button>
      </div>
    `;
    grid.appendChild(emptyState);
    return;
  }

  // Render project cards
  filtered.forEach(p => {
    const card = renderSingleProjectCard(p, false);
    grid.appendChild(card);
  });
}

function renderSingleProjectCard(p, isFolderView = false, chIdx = 0, totalInFolder = 1, folderId = null, activeFolderTitle = "") {
  const card = document.createElement("div");
  card.className = "project-card";

  const total = p.block_count || 0;
  const rendered = p.rendered_count || 0;
  const percent = total > 0 ? Math.min(100, Math.round((rendered / total) * 100)) : 0;

  let statusBadgeClass = "draft";
  let statusText = "Draft";
  if (p.is_stub) {
    statusBadgeClass = "progress";
    statusText = "⚡ Ready to Direct";
  } else if (total > 0 && rendered >= total) {
    statusBadgeClass = "ready";
    statusText = "✓ Ready";
  } else if (rendered > 0) {
    statusBadgeClass = "progress";
    statusText = `⚡ ${percent}%`;
  }

  const durationStr = formatAudioDuration(p.total_duration);
  const dateStr = formatTimeAgo(p.updated_at ? p.updated_at * 1000 : null);
  const studioUrl = `/app/studio?project=${encodeURIComponent(p.id)}`;
  const isPlaying = activePreviewProjectId === p.id && currentDashboardAudio && !currentDashboardAudio.paused;

  // Build cast voice badges
  let voicePillsHtml = "";
  if (p.voices_used && p.voices_used.length > 0) {
    const displayVoices = p.voices_used.slice(0, 3);
    const extraCount = p.voices_used.length - 3;
    voicePillsHtml = displayVoices.map(vId => {
      const vObj = state.voices ? state.voices.find(v => v.id === vId) : null;
      let vName = vObj ? vObj.name : vId.replace(/^blend_/, "").replace(/^a[mf]_/, "").replace(/_/g, " ");
      if (vName.length > 14) vName = vName.substring(0, 13) + "…";
      return `<span class="voice-badge" title="Voice: ${vObj?.name || vId}">${vObj?.flag || '🎙️'} ${escapeHtml(vName)}</span>`;
    }).join("");
    if (extraCount > 0) {
      voicePillsHtml += `<span class="voice-badge extra" title="${extraCount} more cast voices">+${extraCount}</span>`;
    }
  } else {
    voicePillsHtml = `<span class="voice-badge" style="opacity: 0.6;">🎙️ Default</span>`;
  }

  // If inside a folder, clean the title by removing redundant folder title prefix
  let displayTitle = p.title || "Untitled Chapter";
  if (isFolderView && activeFolderTitle) {
    const fTitleTrim = activeFolderTitle.trim();
    if (displayTitle.toLowerCase().startsWith(fTitleTrim.toLowerCase() + " - ")) {
      displayTitle = displayTitle.substring(fTitleTrim.length + 3).trim();
    } else if (displayTitle.toLowerCase().startsWith(fTitleTrim.toLowerCase() + ": ")) {
      displayTitle = displayTitle.substring(fTitleTrim.length + 2).trim();
    }
  }

  // Chapter Pill: Detect Front Matter vs Chapter Number
  let chapterPill = "";
  if (isFolderView) {
    const tLower = (p.title || "").toLowerCase();
    const isFrontMatter = /^(copyright|acknowledgments?|foreword|preface|prologue|dedication|legal)/i.test(displayTitle) || /^(copyright|acknowledgments?|foreword|preface|prologue|dedication|legal)/i.test(tLower);
    const isBackMatter = /^(epilogue|afterword|conclusion|appendix|glossary|index)/i.test(displayTitle) || /^(epilogue|afterword|conclusion|appendix|glossary|index)/i.test(tLower);
    
    if (isFrontMatter) {
      const label = /copyright/i.test(tLower) ? "Legal" : (/ack/i.test(tLower) ? "Ack" : "Intro");
      chapterPill = `<span class="chapter-number-pill front-matter" title="Front Matter (${label})">${label}</span>`;
    } else if (isBackMatter) {
      chapterPill = `<span class="chapter-number-pill front-matter" title="Back Matter">End</span>`;
    } else if (p.chapter_number) {
      chapterPill = `<span class="chapter-number-pill" title="Chapter ${p.chapter_number}">Ch. ${p.chapter_number}</span>`;
    } else {
      chapterPill = `<span class="chapter-number-pill" title="Chapter ${chIdx + 1}">Ch. ${chIdx + 1}</span>`;
    }
  }

  card.innerHTML = `
    <div class="project-card-header">
      <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
        ${chapterPill}
        <div class="project-card-title" title="${escapeHtml(p.title)}">${escapeHtml(displayTitle)}</div>
      </div>
      <span class="proj-status-badge ${statusBadgeClass}">${statusText}</span>
    </div>

    <div class="project-render-bar" title="${rendered} of ${total} sentences rendered (${percent}%)">
      <div class="project-render-fill" style="width: ${percent}%;"></div>
    </div>

    <div class="project-meta-grid">
      ${p.is_stub ? `
        <div class="project-meta-pill" style="color: #60a5fa;"><span>📝</span> <strong>~${(p.word_count || 1200).toLocaleString()}</strong> <span>words</span></div>
        <div class="project-meta-pill pill-duration"><span>⏱️</span> <strong>Est. ${p.estimated_minutes || 8}m</strong></div>
        <div class="project-meta-pill"><span style="color:#a7f3d0;">⚡</span> <span>eBook Chapter</span></div>
      ` : `
        <div class="project-meta-pill"><span>📝</span> <strong>${total}</strong> <span>sentences</span> <span style="opacity: 0.6; font-size: 10.5px;">(${rendered}✓)</span></div>
        <div class="project-meta-pill pill-duration"><span>⏱️</span> <strong>${durationStr}</strong></div>
        <div class="project-meta-pill"><span>🕒</span> <span>${dateStr}</span></div>
      `}
    </div>

    <div class="project-voices-wrap">
      <span class="meta-label" style="font-size: 11px; color: var(--text-subtle); margin-right: 4px;">Cast:</span>
      <div class="project-voices-pills">${voicePillsHtml}</div>
    </div>

    <div class="project-card-footer">
      <div class="footer-left-actions">
        <a href="${studioUrl}" onclick="event.preventDefault(); openProject('${p.id}');" class="open-proj-btn" style="${p.is_stub ? 'background: linear-gradient(135deg, #0284c7, #2563eb); border: none; font-weight: 700;' : ''}">${p.is_stub ? 'Direct in Studio ↗' : 'Open in Studio ↗'}</a>
        ${p.preview_audio ? `<button class="preview-audio-btn ${isPlaying ? 'playing' : ''}" title="Quick audition of rendered dialogue">${isPlaying ? '⏸ Pause' : '▶ Preview'}</button>` : `<button class="preview-audio-btn disabled" disabled title="Render sentences in studio to audition audio">🔇 No Audio</button>`}
      </div>
      <div class="footer-right-actions">
        ${isFolderView ? `
          <button class="card-icon-btn reorder-up-btn" ${chIdx === 0 ? 'disabled style="opacity:0.35;"' : ''} title="Move chapter earlier">▲</button>
          <button class="card-icon-btn reorder-down-btn" ${chIdx === totalInFolder - 1 ? 'disabled style="opacity:0.35;"' : ''} title="Move chapter later">▼</button>
        ` : ''}
        <button class="card-icon-btn move-proj-btn" title="Move to / remove from Series Folder">📁</button>
        <button class="card-icon-btn copy-to-other-btn" title="⚡ Copy to Kokoro Studio">⚡</button>
        <button class="card-icon-btn duplicate-proj-btn" title="Duplicate project">📋</button>
        <button class="card-icon-btn rename-proj-btn" title="Rename project">✏️</button>
        <button class="card-icon-btn delete-proj-btn" title="Delete project">🗑️</button>
      </div>
    </div>
  `;

  // Click card body to open in studio
  card.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("a")) return;
    openProject(p.id);
  });

  // Reorder buttons
  if (isFolderView && folderId) {
    card.querySelector(".reorder-up-btn:not([disabled])")?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleReorderChapter(folderId, p.id, "up");
    });
    card.querySelector(".reorder-down-btn:not([disabled])")?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleReorderChapter(folderId, p.id, "down");
    });
  }

  // Move project to folder
  card.querySelector(".move-proj-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openMoveToFolderModal(p.id);
  });

  // Preview button
  const previewBtn = card.querySelector(".preview-audio-btn:not(.disabled)");
  if (previewBtn) {
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDashboardPreview(p.id, p.preview_audio, previewBtn);
    });
  }

  // Copy to Kokoro button
  card.querySelector(".copy-to-other-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    handleCopyProjectToOtherEngine(p.id, "kokoro", p.title);
  });

  // Duplicate button
  card.querySelector(".duplicate-proj-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    handleDuplicateProject(p.id);
  });

  // Rename button
  card.querySelector(".rename-proj-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    handleRenameProject(p.id, p.title);
  });

  // Delete button
  card.querySelector(".delete-proj-btn")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await showMessageCard({
      icon: "🗑️",
      title: "Delete Project?",
      subtitle: "Cannot be undone",
      body: `<p style="margin: 0; color: #cbd5e1;">Are you sure you want to permanently delete story project <strong>"${escapeHtml(p.title)}"</strong>?</p>`,
      primaryText: "Delete Project",
      secondaryText: "Cancel",
      showSecondary: true,
      danger: true
    });
    if (confirmed) {
      try {
        await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
        showToast(`🗑️ Deleted "${p.title}"`);
        loadProjectsList();
      } catch (err) {
        showToast("❌ Failed to delete project: " + err.message);
      }
    }
  });

  return card;
}

// ---------------- FOLDER & SERIES MANAGEMENT ---------------- //

async function openFolderView(folderId) {
  state.activeFolderId = folderId;
  try {
    const res = await fetch(`/api/folder?id=${encodeURIComponent(folderId)}`);
    if (res.ok) {
      const data = await res.json();
      state.activeFolderData = data.folder || data;
    }
  } catch (err) {
    console.error("Failed to load folder details:", err);
  }
  renderDashboard();
}

function exitFolderView() {
  state.activeFolderId = null;
  state.activeFolderData = null;
  renderDashboard();
}

let editingFolderId = null;
function openNewFolderModal(folderId = null) {
  editingFolderId = folderId;
  const modal = document.getElementById("create-folder-modal");
  const modalTitle = document.getElementById("folder-modal-title");
  const submitBtn = document.getElementById("btn-save-folder-submit");
  const titleInput = document.getElementById("new-folder-title-input");
  const authorInput = document.getElementById("new-folder-author-input");
  const descInput = document.getElementById("new-folder-desc-input");
  const ebookSection = document.getElementById("folder-ebook-dropzone")?.parentElement;

  if (folderId) {
    const f = (state.folders || []).find(item => item.id === folderId) || state.activeFolderData;
    if (modalTitle) modalTitle.textContent = "Edit Series Folder";
    if (submitBtn) submitBtn.textContent = "💾 Save Changes";
    if (titleInput) titleInput.value = f?.title || "";
    if (authorInput) authorInput.value = f?.author || "";
    if (descInput) descInput.value = f?.description || "";
    if (ebookSection) ebookSection.style.display = "none";
  } else {
    clearFolderEbookSelection();
    if (modalTitle) modalTitle.textContent = "New Audiobook / Series Folder";
    if (submitBtn) submitBtn.textContent = "📁 Create Series Folder";
    if (titleInput) titleInput.value = "";
    if (authorInput) authorInput.value = "";
    if (descInput) descInput.value = "";
    if (ebookSection) ebookSection.style.display = "block";
  }

  if (modal) modal.style.display = "flex";
}

function closeCreateFolderModal() {
  const modal = document.getElementById("create-folder-modal");
  if (modal) modal.style.display = "none";
  editingFolderId = null;
}

async function handleFolderEbookSelected(inputOrFile) {
  const file = (inputOrFile instanceof File) ? inputOrFile : (inputOrFile?.files && inputOrFile.files[0]);
  if (!file) return;

  const dropText = document.getElementById("folder-ebook-drop-text");
  if (dropText) dropText.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></span> Inspecting eBook structure...`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/epub/inspect", {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    const info = data.info || data;
    if (!data.ok || !info.books || info.books.length === 0) {
      throw new Error(data.error || "Could not read eBook file or no chapters found");
    }

    state.selectedFolderEpub = {
      path: data.epub_path || info.epub_path,
      info: info,
      file_name: file.name
    };

    // Auto-fill Title and Author if empty
    const firstBook = info.books && info.books[0];
    const titleInput = document.getElementById("new-folder-title-input");
    const authorInput = document.getElementById("new-folder-author-input");
    const descInput = document.getElementById("new-folder-desc-input");
    const submitBtn = document.getElementById("btn-save-folder-submit");

    if (titleInput && (!titleInput.value.trim() || titleInput.value.startsWith("Untitled"))) {
      titleInput.value = firstBook?.title || file.name.replace(/\.[^/.]+$/, "");
    }
    if (authorInput && (!authorInput.value.trim() || authorInput.value === "Unknown Author")) {
      authorInput.value = firstBook?.author || "";
    }
    if (descInput && !descInput.value.trim()) {
      descInput.value = `Complete audio edition of ${titleInput.value}${authorInput.value ? ' by ' + authorInput.value : ''}.`;
    }

    // Render Preview of Structure
    const previewEl = document.getElementById("folder-ebook-preview");
    const statsBadge = document.getElementById("folder-ebook-stats-badge");
    const volsList = document.getElementById("folder-ebook-volumes-list");
    const clearBtn = document.getElementById("folder-ebook-clear-btn");

    if (previewEl) previewEl.style.display = "block";
    if (clearBtn) clearBtn.style.display = "inline-flex";

    const totalBooks = info.total_books || (info.books ? info.books.length : 1);
    let totalCh = 0;
    (info.books || []).forEach(b => { totalCh += (b.chapters ? b.chapters.length : 0); });

    if (statsBadge) {
      statsBadge.textContent = totalBooks > 1
        ? `✨ Multi-Volume Boxset: ${totalBooks} Books detected (${totalCh} total chapters)`
        : `✨ 1 Book detected (${totalCh} chapters)`;
    }

    if (volsList) {
      volsList.innerHTML = (info.books || []).map((b, idx) => {
        const bIdx = b.book_index || (idx + 1);
        const totalChapters = b.chapters ? b.chapters.length : 0;
        const isSingleBook = (totalBooks === 1);

        const chaptersHtml = (b.chapters || []).map(ch => {
          const chIdx = ch.chapter_index;
          const isFluff = isFluffChapter(ch.title, ch.word_count);
          const titleClean = escapeHtml(ch.title || `Chapter ${chIdx}`);
          const wordsStr = ch.word_count ? `${ch.word_count.toLocaleString()} words` : '';
          const minsStr = ch.estimated_minutes ? `⏱️ ${ch.estimated_minutes}m` : '';

          return `
            <label style="display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-radius: 4px; background: rgba(255,255,255,0.02); cursor: pointer; transition: background 0.15s ease;">
              <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                <input type="checkbox" class="folder-ebook-chapter-check" data-book="${bIdx}" data-ch="${chIdx}" data-fluff="${isFluff ? '1' : '0'}" checked onchange="updateEbookBookSelectionCount(${bIdx})" style="accent-color: #3b82f6;">
                <span style="font-size: 11.5px; color: ${isFluff ? '#94a3b8' : '#e2e8f0'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${chIdx}. ${titleClean}
                </span>
                ${isFluff ? `<span style="font-size: 9.5px; padding: 1px 5px; border-radius: 3px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; font-weight: 700;">FLUFF</span>` : ''}
              </div>
              <span style="font-size: 10.5px; color: #64748b; white-space: nowrap; margin-left: 8px;">
                ${wordsStr}${minsStr ? ' · ' + minsStr : ''}
              </span>
            </label>
          `;
        }).join("");

        return `
          <div class="folder-ebook-book-container" data-book="${bIdx}" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255,255,255,0.02);">
              <label style="display: flex; align-items: center; gap: 9px; min-width: 0; cursor: pointer; flex: 1; margin: 0;">
                <input type="checkbox" class="folder-ebook-book-check" data-book="${bIdx}" value="${bIdx}" checked onchange="toggleEbookBookChapters(${bIdx}, this.checked)" style="accent-color: #3b82f6;">
                <span style="font-size: 12.5px; color: #e2e8f0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  📕 Book ${bIdx}: <span style="font-weight: 500; color: #cbd5e1;">${escapeHtml(b.title)}</span>
                </span>
              </label>
              <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                <span id="ebook-book-badge-${bIdx}" style="color: #60a5fa; font-weight: 700; font-size: 11px; background: rgba(59, 130, 246, 0.15); padding: 2px 7px; border-radius: 4px; white-space: nowrap;">
                  ${totalChapters} / ${totalChapters} ch
                </span>
                <button type="button" class="btn btn-ghost" id="ebook-book-expand-btn-${bIdx}" onclick="toggleEbookBookExpand(${bIdx})" style="font-size: 11px; padding: 2px 8px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 4px;">
                  ${isSingleBook ? '▲ Collapse' : '▼ Chapters'}
                </button>
              </div>
            </div>
            <div id="ebook-book-chapters-${bIdx}" style="display: ${isSingleBook ? 'flex' : 'none'}; flex-direction: column; gap: 4px; padding: 8px 12px; background: rgba(0,0,0,0.25); border-top: 1px solid rgba(255,255,255,0.04); max-height: 220px; overflow-y: auto;">
              ${chaptersHtml}
            </div>
          </div>
        `;
      }).join("");
    }

    if (submitBtn) {
      submitBtn.innerHTML = `📚 Create Series &amp; Generate Chapter Cards`;
    }

    if (dropText) {
      dropText.innerHTML = `📄 <strong style="color: #fff;">${escapeHtml(file.name)}</strong> (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    }
  } catch (err) {
    console.error("eBook inspect error:", err);
    showToast(`❌ Could not inspect eBook: ${err.message}`, 4000);
    clearFolderEbookSelection();
  }
}

function isFluffChapter(title, wordCount) {
  if (!title) return true;
  const t = title.trim().toLowerCase();
  const fluffRegex = /\b(copyright|dedication|acknowledg(e)?ments?|contents|table of contents|title page|also by|praise for|praise|epigraph|about the author|about author|colophon|preface|foreword|disclaimer|legal|advertisement|other books|half title|frontispiece)\b/i;
  if (fluffRegex.test(t)) return true;
  if (wordCount !== undefined && wordCount < 90 && !/\b(ch\b|chapter|lesson|prologue|epilogue|act|scene)/i.test(t)) {
    return true;
  }
  return false;
}

function toggleEbookBookExpand(bIdx) {
  const container = document.getElementById(`ebook-book-chapters-${bIdx}`);
  const btn = document.getElementById(`ebook-book-expand-btn-${bIdx}`);
  if (!container) return;
  const isHidden = (container.style.display === "none");
  container.style.display = isHidden ? "flex" : "none";
  if (btn) btn.innerHTML = isHidden ? "▲ Collapse" : "▼ Chapters";
}

function toggleEbookBookChapters(bIdx, isChecked) {
  document.querySelectorAll(`.folder-ebook-chapter-check[data-book="${bIdx}"]`).forEach(cb => {
    cb.checked = isChecked;
  });
  updateEbookBookSelectionCount(bIdx);
}

function updateEbookBookSelectionCount(bIdx) {
  const allCh = document.querySelectorAll(`.folder-ebook-chapter-check[data-book="${bIdx}"]`);
  const checkedCh = document.querySelectorAll(`.folder-ebook-chapter-check[data-book="${bIdx}"]:checked`);
  const badge = document.getElementById(`ebook-book-badge-${bIdx}`);
  if (badge) {
    badge.textContent = `${checkedCh.length} / ${allCh.length} ch`;
  }
  const bookCb = document.querySelector(`.folder-ebook-book-check[data-book="${bIdx}"]`);
  if (bookCb) {
    bookCb.checked = checkedCh.length > 0;
  }
}

function toggleAllEbookChapters(selectAll) {
  document.querySelectorAll(".folder-ebook-chapter-check").forEach(cb => {
    cb.checked = selectAll;
  });
  document.querySelectorAll(".folder-ebook-book-check").forEach(cb => {
    cb.checked = selectAll;
  });
  document.querySelectorAll(".folder-ebook-book-container").forEach(el => {
    const bIdx = el.getAttribute("data-book");
    if (bIdx) updateEbookBookSelectionCount(bIdx);
  });
}

function filterFluffEbookChapters() {
  let fluffCount = 0;
  let totalCount = 0;
  document.querySelectorAll(".folder-ebook-chapter-check").forEach(cb => {
    totalCount++;
    const isFluff = cb.getAttribute("data-fluff") === "1";
    if (isFluff) {
      cb.checked = false;
      fluffCount++;
    } else {
      cb.checked = true;
    }
  });

  document.querySelectorAll(".folder-ebook-book-container").forEach(el => {
    const bIdx = el.getAttribute("data-book");
    if (bIdx) updateEbookBookSelectionCount(bIdx);
  });

  const keptCount = totalCount - fluffCount;
  showToast(`🧹 Excluded ${fluffCount} front-matter/fluff sections (Copyright, Dedication, Acknowledgments). ${keptCount} story chapters selected!`, 4000);
}

function toggleAllEbookBooks(selectAll) {
  toggleAllEbookChapters(selectAll);
}

function handleFolderEbookDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  const dropzone = document.getElementById("folder-ebook-dropzone");
  if (dropzone) dropzone.style.borderColor = "rgba(255, 255, 255, 0.08)";
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    handleFolderEbookSelected(files[0]);
  }
}

function clearFolderEbookSelection() {
  state.selectedFolderEpub = null;
  const fileInput = document.getElementById("folder-ebook-file-input");
  if (fileInput) fileInput.value = "";
  const previewEl = document.getElementById("folder-ebook-preview");
  if (previewEl) previewEl.style.display = "none";
  const clearBtn = document.getElementById("folder-ebook-clear-btn");
  if (clearBtn) clearBtn.style.display = "none";
  const dropText = document.getElementById("folder-ebook-drop-text");
  if (dropText) {
    dropText.innerHTML = `<span style="color: #60a5fa; font-weight: 600;">Click to select</span> or drag &amp; drop an EPUB eBook here (e.g. Harry Potter 1-7, multi-part novels)`;
  }
  const submitBtn = document.getElementById("btn-save-folder-submit");
  if (submitBtn) {
    submitBtn.textContent = editingFolderId ? "💾 Save Changes" : "📁 Create Series Folder";
  }
}

async function handleCreateFolderSubmit() {
  const title = (document.getElementById("new-folder-title-input")?.value || "").trim();
  const author = (document.getElementById("new-folder-author-input")?.value || "").trim();
  const description = (document.getElementById("new-folder-desc-input")?.value || "").trim();

  if (!title) {
    showToast("⚠️ Please enter a title for the series folder.");
    return;
  }

  const submitBtn = document.getElementById("btn-save-folder-submit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; border-width: 2px; border-color: #fff; border-top-color: transparent; display: inline-block; border-radius: 50%; animation: spin 0.8s linear infinite;"></span> Creating Series...`;
  }

  let createdFolderId = null;

  try {
    if (editingFolderId) {
      const res = await fetch("/api/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder_id: editingFolderId,
          title,
          author,
          description,
          engine: "fish_s2"
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update folder");
      showToast(`✨ Updated series "${title}"!`);
      createdFolderId = editingFolderId;
    } else if (state.selectedFolderEpub) {
      showToast("📚 Creating series & generating chapter cards from eBook...", 5000);
      const checkedBoxes = Array.from(document.querySelectorAll(".folder-ebook-book-check:checked"));
      const selectedBooks = checkedBoxes.map(cb => parseInt(cb.value, 10));

      const selectedChapters = {};
      let totalCheckedCh = 0;
      document.querySelectorAll(".folder-ebook-chapter-check:checked").forEach(cb => {
        const b = cb.getAttribute("data-book");
        const ch = parseInt(cb.getAttribute("data-ch"), 10);
        if (!selectedChapters[b]) selectedChapters[b] = [];
        selectedChapters[b].push(ch);
        totalCheckedCh++;
      });

      if (document.querySelectorAll(".folder-ebook-chapter-check").length > 0 && totalCheckedCh === 0) {
        throw new Error("Please select at least 1 chapter to import!");
      }

      const res = await fetch("/api/epub/generate_series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epub_path: state.selectedFolderEpub.path,
          title,
          author,
          description,
          engine: "fish_s2",
          selected_books: selectedBooks.length > 0 ? selectedBooks : null,
          selected_chapters: Object.keys(selectedChapters).length > 0 ? selectedChapters : null
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to generate series from eBook");
      showToast(`✨ Successfully generated "${title}" with ${data.total_chapters} chapter cards!`, 4000);
      createdFolderId = data.folder_id;
    } else {
      const res = await fetch("/api/folders/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          author,
          description,
          engine: "fish_s2"
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to create folder");
      showToast(`📁 Created series "${title}"!`);
      createdFolderId = data.folder?.id;
    }

    closeCreateFolderModal();
    await loadProjectsList();
    if (createdFolderId) {
      await openFolderView(createdFolderId);
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = editingFolderId ? "💾 Save Changes" : "📁 Create Series Folder";
    }
  }
}

// ---------------- STUB CHAPTER INGESTION & DIRECTING ---------------- //

async function openStubDirectModal() {
  const modal = document.getElementById("stub-chapter-direct-modal");
  if (!modal || !state.currentProject) return;

  const titleEl = document.getElementById("stub-modal-title");
  const wordsEl = document.getElementById("stub-modal-words");
  const durEl = document.getElementById("stub-modal-duration");
  const seriesEl = document.getElementById("stub-modal-series");
  const castPreviewEl = document.getElementById("stub-modal-cast-preview");
  const castCountEl = document.getElementById("stub-modal-cast-count");
  const progressEl = document.getElementById("stub-direct-progress");
  if (progressEl) progressEl.style.display = "none";

  if (titleEl) titleEl.textContent = state.currentProject.title || "Direct Chapter";
  if (wordsEl) wordsEl.textContent = (state.currentProject.word_count || 1200).toLocaleString();
  if (durEl) durEl.textContent = `${state.currentProject.estimated_minutes || 8}m`;

  // Fetch folder to get series name & unified master cast
  let folderData = null;
  if (state.currentProject.folder_id) {
    try {
      const res = await fetch(`/api/folder?id=${encodeURIComponent(state.currentProject.folder_id)}`);
      if (res.ok) {
        const d = await res.json();
        folderData = d.folder || d;
      }
    } catch (e) {}
  }

  if (seriesEl) {
    const parentTitle = folderData?.parent_folder?.title;
    seriesEl.textContent = parentTitle ? `${parentTitle} › ${folderData.title}` : (folderData?.title || "Audiobook Series");
  }

  const masterCast = (folderData?.characters) || [];
  if (castCountEl) {
    castCountEl.textContent = `${masterCast.length} character${masterCast.length === 1 ? '' : 's'} established`;
  }

  if (castPreviewEl) {
    if (masterCast.length > 0) {
      castPreviewEl.innerHTML = masterCast.map(c => `
        <span class="voice-badge" style="background: rgba(139, 92, 246, 0.2); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.4); font-size: 11px;">
          🎭 ${escapeHtml(c.name || 'Character')} <span style="opacity: 0.6; font-size: 10px;">(${c.gender || 'voice'})</span>
        </span>
      `).join("");
    } else {
      castPreviewEl.innerHTML = `<span style="font-size: 11px; color: var(--text-muted); opacity: 0.7;">No characters in universe cast yet. AI Director will discover speakers in this chapter and establish them into the Unified Cast!</span>`;
    }
  }

  // Populate Narrator Voice dropdown
  const narratorSelect = document.getElementById("stub-narrator-voice");
  if (narratorSelect) {
    if (!state.voices || state.voices.length === 0) {
      try { await loadVoices(); } catch(e) {}
    }
    const isFish = (state.activeEngine || "fish_s2") === "fish_s2";
    const rawVoices = (state.voices && state.voices.length > 0) ? state.voices : (state.fishVoices || []);
    const voices = Array.isArray(rawVoices) ? rawVoices : Object.values(rawVoices || {});
    const defVoice = state.currentProject?.default_voice || (isFish ? "voice_stanley_narrator" : "am_adam");
    if (voices.length > 0) {
      narratorSelect.innerHTML = voices.map(v => {
        const vid = v.id || v;
        const vname = v.name || vid;
        const isSel = (vid === defVoice);
        return `<option value="${vid}" ${isSel ? 'selected' : ''}>${escapeHtml(vname)}</option>`;
      }).join("");
    } else {
      narratorSelect.innerHTML = `<option value="${defVoice}">${escapeHtml(defVoice)}</option>`;
    }
  }

  // Inspect saved series director settings
  const dirSettings = folderData?.director_settings || {};
  const hasDefaults = Boolean(dirSettings && Object.keys(dirSettings).length > 0);
  const presetBanner = document.getElementById("stub-preset-banner");
  const presetSummary = document.getElementById("stub-preset-summary");
  const useDefaultsCheck = document.getElementById("stub-use-series-defaults");

  if (hasDefaults) {
    if (presetBanner) presetBanner.style.display = "flex";
    if (useDefaultsCheck) useDefaultsCheck.checked = true;
    if (presetSummary) {
      const modeStr = dirSettings.cast_mode === "solo" ? "🎙️ Solo Narrator" : "🎭 Multi-Cast Drama";
      const modelStr = dirSettings.ai_model || "gemini-3.5-flash-lite";
      const intStr = dirSettings.acting_intensity || "balanced";
      const tempStr = dirSettings.analysis_temperature || 0.7;
      presetSummary.innerHTML = `<strong>${modeStr}</strong> · Model: <strong>${modelStr}</strong> · Acting Beats: <strong>${intStr} (${tempStr} temp)</strong>`;
    }
    applySettingsToStubModal(dirSettings);
    toggleStubDefaultsMode(true);
  } else {
    if (presetBanner) presetBanner.style.display = "none";
    toggleStubDefaultsMode(false);
  }

  modal.style.display = "flex";
}

function applySettingsToStubModal(settings) {
  if (!settings) return;
  if (settings.cast_mode) {
    const radio = document.querySelector(`input[name="stub-cast-mode"][value="${settings.cast_mode}"]`);
    if (radio) radio.checked = true;
  }
  if (settings.ai_model) {
    const modelSelect = document.getElementById("stub-ai-model-select");
    if (modelSelect) modelSelect.value = settings.ai_model;
  }
  if (settings.acting_intensity) {
    const intSelect = document.getElementById("stub-acting-intensity");
    if (intSelect) intSelect.value = settings.acting_intensity;
  }
  if (settings.analysis_temperature !== undefined) {
    const tempInput = document.getElementById("stub-acting-temperature");
    if (tempInput) {
      tempInput.value = settings.analysis_temperature;
      updateStubTempDisplay(settings.analysis_temperature);
    }
  }
  if (settings.default_voice) {
    const narratorSelect = document.getElementById("stub-narrator-voice");
    if (narratorSelect) narratorSelect.value = settings.default_voice;
  }
  if (settings.split_quotes !== undefined) {
    const sq = document.getElementById("stub-split-quotes");
    if (sq) sq.checked = Boolean(settings.split_quotes);
  }
  if (settings.acting_tags !== undefined) {
    const at = document.getElementById("stub-acting-tags");
    if (at) at.checked = Boolean(settings.acting_tags);
  }
}

function updateStubTempDisplay(val) {
  const disp = document.getElementById("stub-acting-temp-display");
  if (!disp) return;
  const num = parseFloat(val).toFixed(2);
  let desc = "Balanced Subtext";
  if (num < 0.45) desc = "Strict & Literal";
  else if (num > 0.8) desc = "High Emotion & Psychological Nuance";
  else if (num > 0.65) desc = "Deep Subtext & Tension";
  disp.textContent = `${num} (${desc})`;
}

function toggleStubDefaultsMode(useDefaults) {
  const container = document.getElementById("stub-options-container");
  if (!container) return;
  container.style.opacity = useDefaults ? "0.65" : "1";
}

let stubProgressTimer = null;
let stubJobPollTimer = null;

function setStubProgress(pct, stepNum, stepDesc, activeStepIndex) {
  const bar = document.getElementById("stub-overlay-bar");
  const pctEl = document.getElementById("stub-overlay-pct");
  const stepEl = document.getElementById("stub-overlay-step");
  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (stepEl) stepEl.textContent = `Step ${stepNum} of 4: ${stepDesc}`;

  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`stub-step-${i}`);
    if (!el) continue;
    const icon = el.querySelector(".step-icon");
    if (i < activeStepIndex) {
      el.style.color = "#10b981";
      el.style.fontWeight = "600";
      if (icon) icon.textContent = "✅";
    } else if (i === activeStepIndex) {
      el.style.color = "#93c5fd";
      el.style.fontWeight = "700";
      if (icon) icon.textContent = (i === 1 ? "🔍" : i === 2 ? "🤖" : i === 3 ? "🎭" : "✨");
    } else {
      el.style.color = "#64748b";
      el.style.fontWeight = "400";
      if (icon) icon.textContent = (i === 1 ? "🔍" : i === 2 ? "🤖" : i === 3 ? "🎭" : "✨");
    }
  }
}

function startStubProgressAnimation(isAi) {
  if (stubProgressTimer) clearInterval(stubProgressTimer);
  if (stubJobPollTimer) clearInterval(stubJobPollTimer);
  const overlay = document.getElementById("stub-direct-overlay");
  const errBox = document.getElementById("stub-overlay-error");
  const icon = document.getElementById("stub-overlay-icon");
  const title = document.getElementById("stub-overlay-title");
  const subtitle = document.getElementById("stub-overlay-subtitle");

  if (errBox) errBox.style.display = "none";
  if (overlay) overlay.style.display = "flex";

  if (!isAi) {
    if (icon) icon.textContent = "⚡";
    if (title) title.textContent = "Fast Manuscript Split";
    if (subtitle) subtitle.textContent = "Instant paragraph extraction & dialogue quote detection...";
    setStubProgress(40, 1, "Reading chapter manuscript", 1);
    setTimeout(() => setStubProgress(80, 2, "Splitting paragraphs & quotes", 2), 200);
    return;
  }

  if (icon) icon.textContent = "🪄";
  if (title) title.textContent = "AI Script Director";
  if (subtitle) subtitle.textContent = "Analyzing manuscript subtext & casting character voices...";

  setStubProgress(15, 1, "Extracting manuscript text", 1);
}

function stopStubProgressAnimation() {
  if (stubProgressTimer) {
    clearInterval(stubProgressTimer);
    stubProgressTimer = null;
  }
  if (stubJobPollTimer) {
    clearInterval(stubJobPollTimer);
    stubJobPollTimer = null;
  }
}

function retryStubDirectModal() {
  stopStubProgressAnimation();
  const errBox = document.getElementById("stub-overlay-error");
  const overlay = document.getElementById("stub-direct-overlay");
  if (errBox) errBox.style.display = "none";
  if (overlay) overlay.style.display = "none";
  const submitBtn = document.getElementById("btn-stub-direct-submit");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `🚀 Generate Blocks &amp; Direct Chapter`;
  }
}

function closeStubDirectModal() {
  stopStubProgressAnimation();
  const overlay = document.getElementById("stub-direct-overlay");
  if (overlay) overlay.style.display = "none";
  const modal = document.getElementById("stub-chapter-direct-modal");
  if (modal) modal.style.display = "none";
}

function handleStubMethodChange(method) {
  const isAi = (method === "ai");
  const lblAi = document.getElementById("lbl-stub-method-ai");
  const lblManual = document.getElementById("lbl-stub-method-manual");
  const radAi = document.getElementById("stub-ingest-method-ai");
  const radManual = document.getElementById("stub-ingest-method-manual");
  const aiFields = document.getElementById("stub-ai-fields");
  const submitBtn = document.getElementById("btn-stub-direct-submit");

  if (radAi) radAi.checked = isAi;
  if (radManual) radManual.checked = !isAi;

  if (lblAi && lblManual) {
    if (isAi) {
      lblAi.style.borderColor = "#8b5cf6";
      lblAi.style.background = "rgba(139, 92, 246, 0.14)";
      lblManual.style.borderColor = "rgba(255, 255, 255, 0.1)";
      lblManual.style.background = "rgba(15, 23, 42, 0.6)";
    } else {
      lblManual.style.borderColor = "#8b5cf6";
      lblManual.style.background = "rgba(139, 92, 246, 0.14)";
      lblAi.style.borderColor = "rgba(255, 255, 255, 0.1)";
      lblAi.style.background = "rgba(15, 23, 42, 0.6)";
    }
  }

  if (aiFields) {
    aiFields.style.display = isAi ? "flex" : "none";
  }

  if (submitBtn) {
    if (isAi) {
      submitBtn.innerHTML = `🚀 Generate Blocks &amp; Direct Chapter`;
      submitBtn.style.background = "linear-gradient(135deg, #10b981, #059669)";
    } else {
      submitBtn.innerHTML = `⚡ Fast Split &amp; Open Chapter (No AI)`;
      submitBtn.style.background = "linear-gradient(135deg, #3b82f6, #1d4ed8)";
    }
  }
}

async function handleStubDirectSubmit() {
  if (!state.currentProject) return;

  const ingestMethodEl = document.querySelector('input[name="stub-ingest-method"]:checked');
  const isAiMethod = ingestMethodEl ? (ingestMethodEl.value === "ai") : true;

  const castModeEl = document.querySelector('input[name="stub-cast-mode"]:checked');
  const castMode = castModeEl ? castModeEl.value : "multi";
  const splitQuotes = document.getElementById("stub-split-quotes")?.checked ?? true;
  const actingTags = document.getElementById("stub-acting-tags")?.checked ?? true;
  const aiModel = document.getElementById("stub-ai-model-select")?.value || "gemini-3.5-flash-lite";
  const actingIntensity = document.getElementById("stub-acting-intensity")?.value || "balanced";
  const actingTemp = parseFloat(document.getElementById("stub-acting-temperature")?.value || "0.7");
  const defaultVoice = document.getElementById("stub-narrator-voice")?.value || state.currentProject.default_voice;
  const saveAsDefault = document.getElementById("stub-save-as-default")?.checked ?? false;

  const isAi = isAiMethod && (aiModel !== "fast_split");
  const jobId = "stub_job_" + Math.random().toString(36).substring(2, 9);

  const submitBtn = document.getElementById("btn-stub-direct-submit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner" style="width: 13px; height: 13px; border-width: 2px; display: inline-block; vertical-align: middle; margin-right: 6px;"></span> ${isAi ? 'Directing Chapter...' : 'Splitting Chapter...'}`;
  }

  startStubProgressAnimation(isAi);

  if (isAi) {
    stubJobPollTimer = setInterval(async () => {
      try {
        const pRes = await fetch(`/api/job_progress?job_id=${encodeURIComponent(jobId)}`);
        if (!pRes.ok) return;
        const pData = await pRes.json();
        if (pData.ok && pData.job) {
          const j = pData.job;
          const pct = Math.max(15, Math.min(99, j.percent || 15));
          let sNum = 1;
          if (pct > 75) sNum = 4;
          else if (pct > 50) sNum = 3;
          else if (pct > 25) sNum = 2;
          setStubProgress(pct, sNum, j.message || "Directing chapter manuscript...", sNum);
        }
      } catch (e) {}
    }, 600);
  }

  try {
    const res = await fetch("/api/chapter/direct_stub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        project_id: state.currentProject.id,
        cast_mode: castMode,
        ai_direct: isAi,
        ai_model: aiModel,
        split_quotes: splitQuotes,
        acting_tags: actingTags,
        acting_intensity: actingIntensity,
        analysis_temperature: actingTemp,
        default_voice: defaultVoice,
        save_as_folder_default: saveAsDefault
      })
    });
    const resText = await res.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Server returned status ${res.status}: ${resText.slice(0, 160)}`);
    }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Failed to direct chapter");
    }

    setStubProgress(100, 4, "Complete! Loading studio...", 4);
    stopStubProgressAnimation();

    setTimeout(() => {
      state.currentProject = data.project;
      closeStubDirectModal();
      showToast(`✨ Chapter directed! ${data.blocks_count} speech blocks ready.`, 4500);
      renderStudio();
    }, 450);

  } catch (err) {
    stopStubProgressAnimation();
    console.error("Direct stub error:", err);
    const errBox = document.getElementById("stub-overlay-error");
    const errMsg = document.getElementById("stub-overlay-error-msg");
    if (errBox && errMsg) {
      errMsg.textContent = err.message || "Failed to direct chapter";
      errBox.style.display = "flex";
    }
    showToast(`❌ Directing error: ${err.message}`, 5000);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `🚀 Generate Blocks &amp; Direct Chapter`;
    }
  }
}

async function handleStubFastSplit() {
  if (!state.currentProject) return;
  startStubProgressAnimation(false);

  try {
    const res = await fetch("/api/chapter/direct_stub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: state.currentProject.id,
        ai_direct: false,
        split_quotes: true
      })
    });
    const resText = await res.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Server returned status ${res.status}: ${resText.slice(0, 160)}`);
    }
    if (!res.ok || !data.ok) throw new Error(data.error || "Fast split failed");
    
    setStubProgress(100, 4, "Complete! Loading studio...", 4);
    stopStubProgressAnimation();

    setTimeout(() => {
      state.currentProject = data.project;
      closeStubDirectModal();
      showToast(`⚡ Fast split complete! ${data.blocks_count} blocks created.`, 3500);
      renderStudio();
    }, 350);

  } catch (err) {
    stopStubProgressAnimation();
    const errBox = document.getElementById("stub-overlay-error");
    const errMsg = document.getElementById("stub-overlay-error-msg");
    if (errBox && errMsg) {
      errMsg.textContent = err.message || "Fast split failed";
      errBox.style.display = "flex";
    }
    showToast(`❌ Error: ${err.message}`, 4000);
  }
}

async function handleDeleteFolder(folderId) {
  const f = (state.folders || []).find(item => item.id === folderId);
  const fTitle = f ? f.title : "Series";
  const confirmed = await showMessageCard({
    icon: "🗑️",
    title: `Delete "${escapeHtml(fTitle)}"?`,
    subtitle: "Your chapters will be safely kept as standalone stories.",
    body: `<p style="margin: 0; color: #cbd5e1;">Are you sure you want to delete this series folder? <strong>All chapters inside will be preserved as standalone projects.</strong></p>`,
    primaryText: "Delete Folder (Keep Chapters)",
    secondaryText: "Cancel",
    showSecondary: true,
    danger: true
  });

  if (!confirmed) return;

  try {
    const res = await fetch(`/api/folders/${encodeURIComponent(folderId)}?delete_chapters=0`, {
      method: "DELETE"
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to delete folder");
    showToast(`🗑️ Deleted series "${fTitle}"`);
    if (state.activeFolderId === folderId) {
      state.activeFolderId = null;
      state.activeFolderData = null;
    }
    await loadProjectsList();
  } catch (err) {
    showToast(`❌ Error: ${err.message}`);
  }
}

// ---------------- MASTER CAST DIRECTORY ---------------- //

let activeMasterCastFolderId = null;

async function openMasterCastModal(folderId = null) {
  activeMasterCastFolderId = folderId || state.activeFolderId;
  if (!activeMasterCastFolderId && state.currentProject?.folder_id) {
    activeMasterCastFolderId = state.currentProject.folder_id;
  }
  if (!activeMasterCastFolderId) {
    showToast("⚠️ This project is not part of a Series Folder.");
    return;
  }

  const modal = document.getElementById("master-cast-modal");
  const modalTitle = document.getElementById("master-cast-modal-title");

  try {
    const res = await fetch(`/api/folder?id=${encodeURIComponent(activeMasterCastFolderId)}`);
    const jsonRes = await res.json();
    const fData = jsonRes.folder || jsonRes;
    if (modalTitle) {
      modalTitle.textContent = `Master Cast: ${fData.title || "Universe"}`;
    }
    state.editingMasterCast = JSON.parse(JSON.stringify(fData.characters || []));
    renderMasterCastRows();
    if (modal) modal.style.display = "flex";
  } catch (err) {
    showToast(`❌ Could not load Master Cast: ${err.message}`);
  }
}

function closeMasterCastModal() {
  const modal = document.getElementById("master-cast-modal");
  if (modal) modal.style.display = "none";
  activeMasterCastFolderId = null;
  state.editingMasterCast = [];
}

function renderMasterCastRows() {
  const container = document.getElementById("master-cast-table-container");
  const countLabel = document.getElementById("master-cast-count-label");
  if (!container) return;

  const characters = state.editingMasterCast || [];
  if (countLabel) {
    countLabel.textContent = `${characters.length} Character${characters.length === 1 ? '' : 's'} in Universe Master Cast`;
  }

  if (characters.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 13px;">
        No characters in Master Cast yet. Click <strong>＋ Add Character</strong> to establish voices for your universe.
      </div>
    `;
    return;
  }

  container.innerHTML = "";
  const voiceOptions = (state.voices || []).map(v => `<option value="${v.id}">${v.flag || '🎙️'} ${escapeHtml(v.name)}</option>`).join("");

  characters.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "master-cast-row";
    row.style.background = "var(--bg-card)";
    row.style.border = "1px solid var(--border-color)";
    row.style.borderRadius = "8px";
    row.style.padding = "12px 14px";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1.2fr 1fr 1fr 1.5fr auto";
    row.style.gap = "10px";
    row.style.alignItems = "center";

    row.innerHTML = `
      <div>
        <label style="font-size: 10.5px; color: var(--text-muted); display: block; margin-bottom: 2px;">Character Name</label>
        <input type="text" class="search-input" value="${escapeHtml(c.name || '')}" placeholder="e.g. Rich Dad" style="width: 100%; font-size: 12.5px; padding: 6px 8px;" onchange="updateMasterCastField(${idx}, 'name', this.value)">
      </div>
      <div>
        <label style="font-size: 10.5px; color: var(--text-muted); display: block; margin-bottom: 2px;">Voice Timbre</label>
        <select class="search-input" style="width: 100%; font-size: 12px; padding: 6px 8px; background: var(--bg-base); color: var(--text-main);" onchange="updateMasterCastField(${idx}, 'voice_id', this.value)">
          ${voiceOptions}
        </select>
      </div>
      <div>
        <label style="font-size: 10.5px; color: var(--text-muted); display: block; margin-bottom: 2px;">Default Emotion Tag</label>
        <input type="text" class="search-input" value="${escapeHtml(c.default_emotion || '')}" placeholder="e.g. [sarcastic]" style="width: 100%; font-size: 11.5px; padding: 6px 8px;" onchange="updateMasterCastField(${idx}, 'default_emotion', this.value)">
      </div>
      <div>
        <label style="font-size: 10.5px; color: var(--text-muted); display: block; margin-bottom: 2px;">Role & Persona Summary</label>
        <input type="text" class="search-input" value="${escapeHtml(c.persona || '')}" placeholder="e.g. Wealthy entrepreneur, sharp, confident" style="width: 100%; font-size: 11.5px; padding: 6px 8px;" onchange="updateMasterCastField(${idx}, 'persona', this.value)">
      </div>
      <div style="padding-top: 14px;">
        <button type="button" class="card-icon-btn" onclick="handleDeleteMasterCastCharacter(${idx})" title="Remove character from Master Cast" style="color: #f87171;">✕</button>
      </div>
    `;

    const voiceSelect = row.querySelector("select");
    if (voiceSelect && c.voice_id) {
      voiceSelect.value = c.voice_id;
    }

    container.appendChild(row);
  });
}

function updateMasterCastField(idx, field, val) {
  if (state.editingMasterCast && state.editingMasterCast[idx]) {
    state.editingMasterCast[idx][field] = val;
  }
}

function handleAddMasterCastCharacter() {
  if (!state.editingMasterCast) state.editingMasterCast = [];
  const defaultVoice = state.voices && state.voices.length > 0 ? state.voices[0].id : "voice_stanley_narrator";
  state.editingMasterCast.push({
    id: `char_master_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    name: "New Character",
    voice_id: defaultVoice,
    default_emotion: "",
    persona: "Supporting character in the series",
    role: "supporting"
  });
  renderMasterCastRows();
}

function handleDeleteMasterCastCharacter(idx) {
  if (state.editingMasterCast) {
    state.editingMasterCast.splice(idx, 1);
    renderMasterCastRows();
  }
}

async function saveMasterCastSubmit() {
  if (!activeMasterCastFolderId) return;
  const syncToChapters = document.getElementById("master-cast-sync-checkbox")?.checked ?? true;
  const btn = document.getElementById("btn-save-master-cast");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Saving & Syncing...";
  }

  try {
    const res = await fetch("/api/folder/master_cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: activeMasterCastFolderId,
        characters: state.editingMasterCast,
        sync_to_chapters: syncToChapters
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to save master cast");

    showToast(syncToChapters
      ? `🎭 Saved Master Cast and synced to all ${data.chapters_synced || 0} chapters!`
      : "🎭 Master Cast updated successfully!");

    closeMasterCastModal();
    await loadProjectsList();
    if (state.activeFolderId === activeMasterCastFolderId) {
      await openFolderView(activeMasterCastFolderId);
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Save Master Cast";
    }
  }
}

// ---------------- MOVE PROJECT TO FOLDER ---------------- //

let movingProjectId = null;
function openMoveToFolderModal(projectId) {
  movingProjectId = projectId;
  const modal = document.getElementById("move-to-folder-modal");
  const p = (state.projects || []).find(item => item.id === projectId);
  const descEl = document.getElementById("move-project-desc");
  const selEl = document.getElementById("move-destination-folder-select");

  if (descEl && p) {
    descEl.innerHTML = `Move chapter <strong>"${escapeHtml(p.title)}"</strong> to:`;
  }

  populateFolderSelects();
  if (selEl) {
    selEl.value = p?.folder_id || "none";
  }

  if (modal) modal.style.display = "flex";
}

function closeMoveToFolderModal() {
  const modal = document.getElementById("move-to-folder-modal");
  if (modal) modal.style.display = "none";
  movingProjectId = null;
}

async function handleMoveToFolderSubmit() {
  if (!movingProjectId) return;
  const selEl = document.getElementById("move-destination-folder-select");
  const folderId = selEl ? selEl.value : "none";

  try {
    const res = await fetch("/api/folder/move_project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: movingProjectId,
        folder_id: folderId
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to move project");

    showToast(folderId === "none"
      ? "📄 Project moved to Standalone Stories."
      : "📁 Project moved to Series Folder!");

    closeMoveToFolderModal();
    await loadProjectsList();
  } catch (err) {
    showToast(`❌ Error: ${err.message}`);
  }
}

async function handleReorderChapter(folderId, chapterId, direction) {
  const folder = (state.folders || []).find(f => f.id === folderId) || state.activeFolderData;
  if (!folder) return;

  let chList = [...(folder.chapter_order || folder.chapter_ids || [])];
  const idx = chList.indexOf(chapterId);
  if (idx === -1) return;

  if (direction === "up" && idx > 0) {
    const temp = chList[idx];
    chList[idx] = chList[idx - 1];
    chList[idx - 1] = temp;
  } else if (direction === "down" && idx < chList.length - 1) {
    const temp = chList[idx];
    chList[idx] = chList[idx + 1];
    chList[idx + 1] = temp;
  } else {
    return;
  }

  try {
    const res = await fetch("/api/folder/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: folderId,
        chapter_ids: chList
      })
    });
    const data = await res.json();
    if (data.ok) {
      folder.chapter_order = chList;
      folder.chapter_ids = chList;
      if (state.activeFolderData) {
        state.activeFolderData.chapter_order = chList;
        state.activeFolderData.chapter_ids = chList;
      }
      renderDashboard();
    }
  } catch (err) {
    console.error("Failed to reorder chapters:", err);
  }
}

async function handleSortFolderChapters(folderId) {
  if (!folderId) return;
  try {
    showToast("✨ Sorting chapters into natural book order...", 2000);
    const res = await fetch("/api/folder/sort_chapters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to sort chapters");
    }
    showToast("✨ Chapters successfully organized in natural book order!", 3500);

    // Refresh projects list and folder state
    await loadProjectsList();
    if (state.activeFolderId === folderId) {
      const fRes = await fetch(`/api/folder?id=${encodeURIComponent(folderId)}`);
      if (fRes.ok) {
        const fData = await fRes.json();
        state.activeFolderData = fData.folder || fData;
      }
    }
    renderDashboard();
  } catch (err) {
    console.error("Sort folder chapters error:", err);
    showToast("❌ Could not sort chapters: " + err.message, 4000);
  }
}

// ---------------- EXPORT FULL MASTER AUDIOBOOK ---------------- //

async function handleExportFullAudiobook(folderId) {
  const folder = (state.folders || []).find(f => f.id === folderId) || state.activeFolderData;
  const fTitle = folder ? folder.title : "Audiobook";

  // Check if there are fluff chapters
  const chapters = folder?.chapters || [];
  const hasFluff = chapters.some(ch => isFluffChapter(ch.title, ch.word_count));
  let chaptersOnly = false;
  if (hasFluff) {
    chaptersOnly = confirm(
      `Master Audiobook Export for "${fTitle}":\n\n` +
      `Export STORY CHAPTERS ONLY?\n(Recommended: excludes front-matter fluff like Copyright, Dedication, Acknowledgments)\n\n` +
      `Click [OK] to export Story Chapters Only.\nClick [Cancel] to export All items including front matter.`
    );
  }

  showToast(`🎵 Assembling master audiobook for "${fTitle}" (${chaptersOnly ? 'Story Chapters Only' : 'All Items'})...`);
  try {
    const res = await fetch("/api/folder/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: folderId,
        silence_gap_sec: 2.0,
        chapters_only: chaptersOnly
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Audiobook export failed");

    // Trigger download of master audio
    const a = document.createElement("a");
    a.href = data.audio_url;
    a.download = data.audio_url.split("/").pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showToast(`✨ Complete Audiobook Exported! (${data.total_chapters} chapters, ${formatAudioDuration(data.total_duration)})`);
  } catch (err) {
    showToast(`❌ Export error: ${err.message}`);
  }
}

// ---------------- PURGE FLUFF CARDS FROM EXISTING SERIES ---------------- //

async function handleRemoveFluffChapters(folderId) {
  const folder = (state.folders || []).find(f => f.id === folderId) || state.activeFolderData;
  if (!folder) return;

  let chapters = folder.chapters || [];
  try {
    const res = await fetch(`/api/folder?id=${folderId}`);
    const data = await res.json();
    if (data.ok && data.folder) chapters = data.folder.chapters || [];
  } catch(e) {}

  // Filter unrendered stub chapters matching fluff
  const fluffChapters = chapters.filter(ch => {
    const hasAudio = (ch.rendered_count > 0) || (ch.total_duration > 0);
    if (hasAudio) return false; // Do not delete chapters user already rendered audio for!
    return isFluffChapter(ch.title, ch.word_count);
  });

  if (fluffChapters.length === 0) {
    showToast("ℹ️ No front-matter or fluff chapters found in this collection. All chapters are valid story chapters!");
    return;
  }

  const names = fluffChapters.map(c => `"${c.title.replace(/^.* - /, '')}"`).slice(0, 5).join(", ");
  const extra = fluffChapters.length > 5 ? ` and ${fluffChapters.length - 5} more` : "";
  const confirmed = confirm(`Found ${fluffChapters.length} front-matter/fluff chapters:\n\n${names}${extra}\n\nRemove these ${fluffChapters.length} fluff chapters from this collection?`);
  if (!confirmed) return;

  showToast(`🧹 Removing ${fluffChapters.length} fluff chapters...`);
  try {
    for (const ch of fluffChapters) {
      await fetch(`/api/project/delete?id=${ch.id}`, { method: "POST" });
    }
    showToast(`✅ Successfully removed ${fluffChapters.length} fluff chapters!`, 3500);
    await loadProjectsList();
    await openFolderView(folderId);
  } catch(err) {
    showToast(`❌ Error removing fluff: ${err.message}`);
  }
}

// ---------------- SERIES & PROJECT SETTINGS MODAL ---------------- //

async function openSeriesSettingsModal(folderId) {
  const modal = document.getElementById("series-settings-modal");
  if (!modal) return;

  let folder = (state.folders || []).find(f => f.id === folderId) || state.activeFolderData;
  try {
    const res = await fetch(`/api/folder?id=${folderId}`);
    const data = await res.json();
    if (data.ok && data.folder) folder = data.folder;
  } catch(e) {}

  if (!folder) return;

  const fidInput = document.getElementById("series-settings-folder-id");
  if (fidInput) fidInput.value = folder.id;

  const titleModal = document.getElementById("series-settings-modal-title");
  if (titleModal) titleModal.textContent = `Series Settings - ${folder.title}`;

  const titleInput = document.getElementById("series-settings-title");
  if (titleInput) titleInput.value = folder.title || "";

  const authorInput = document.getElementById("series-settings-author");
  if (authorInput) authorInput.value = folder.author || "";

  const descInput = document.getElementById("series-settings-desc");
  if (descInput) descInput.value = folder.description || "";

  // Populate narrator voices
  const voiceSelect = document.getElementById("series-settings-narrator-voice");
  if (voiceSelect) {
    const isFish = (state.activeEngine || "fish_s2") === "fish_s2";
    const voices = isFish ? (state.fishVoices || state.voices || []) : (state.voices || []);
    const voiceList = Array.isArray(voices) ? voices : Object.values(voices || {});
    voiceSelect.innerHTML = voiceList.map(v => {
      const vid = v.id || v;
      const vname = v.name || vid;
      return `<option value="${vid}">${escapeHtml(vname)} (${v.gender || 'voice'})</option>`;
    }).join("");
  }

  const settings = folder.director_settings || {};
  if (voiceSelect) {
    if (settings.default_voice) voiceSelect.value = settings.default_voice;
    else if (folder.default_voice) voiceSelect.value = folder.default_voice;
    else voiceSelect.value = "voice_stanley_narrator";
  }

  const castMode = settings.cast_mode || "multi";
  const castRadio = document.querySelector(`input[name="series-settings-cast-mode"][value="${castMode}"]`);
  if (castRadio) castRadio.checked = true;

  const modelSelect = document.getElementById("series-settings-ai-model");
  if (modelSelect) modelSelect.value = settings.ai_model || "gemini-3.5-flash-lite";

  const intensitySelect = document.getElementById("series-settings-acting-intensity");
  if (intensitySelect) intensitySelect.value = settings.acting_intensity || "balanced";

  const tempSlider = document.getElementById("series-settings-temperature");
  const tempDisplay = document.getElementById("series-settings-temp-display");
  const tempVal = (settings.analysis_temperature !== undefined) ? settings.analysis_temperature : 0.70;
  if (tempSlider) tempSlider.value = tempVal;
  if (tempDisplay) tempDisplay.textContent = parseFloat(tempVal).toFixed(2);

  const splitCb = document.getElementById("series-settings-split-quotes");
  if (splitCb) splitCb.checked = (settings.split_quotes !== undefined) ? settings.split_quotes : true;

  const actingCb = document.getElementById("series-settings-acting-tags");
  if (actingCb) actingCb.checked = (settings.acting_tags !== undefined) ? settings.acting_tags : true;

  modal.style.display = "flex";
}

function closeSeriesSettingsModal() {
  const modal = document.getElementById("series-settings-modal");
  if (modal) modal.style.display = "none";
}

async function handleSaveSeriesSettingsSubmit() {
  const folderId = document.getElementById("series-settings-folder-id")?.value;
  if (!folderId) return;

  const title = document.getElementById("series-settings-title")?.value.trim();
  const author = document.getElementById("series-settings-author")?.value.trim();
  const description = document.getElementById("series-settings-desc")?.value.trim();

  const voiceSelect = document.getElementById("series-settings-narrator-voice");
  const modelSelect = document.getElementById("series-settings-ai-model");
  const intensitySelect = document.getElementById("series-settings-acting-intensity");
  const tempSlider = document.getElementById("series-settings-temperature");
  const splitCb = document.getElementById("series-settings-split-quotes");
  const actingCb = document.getElementById("series-settings-acting-tags");

  const castModeEl = document.querySelector('input[name="series-settings-cast-mode"]:checked');
  const castMode = castModeEl ? castModeEl.value : "multi";

  const settings = {
    cast_mode: castMode,
    default_voice: voiceSelect?.value,
    ai_model: modelSelect?.value || "gemini-3.5-flash-lite",
    acting_intensity: intensitySelect?.value || "balanced",
    analysis_temperature: parseFloat(tempSlider?.value || 0.70),
    split_quotes: splitCb ? splitCb.checked : true,
    acting_tags: actingCb ? actingCb.checked : true
  };

  showToast("💾 Saving series preferences...");
  try {
    // 1. Update folder metadata
    await fetch("/api/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: folderId,
        title,
        author,
        description,
        default_voice: settings.default_voice
      })
    });

    // 2. Update director preferences
    await fetch("/api/folder/director_settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: folderId,
        settings
      })
    });

    showToast("✅ Series settings & AI director preferences saved!", 3000);
    closeSeriesSettingsModal();
    await loadProjectsList();
    await openFolderView(folderId);
  } catch(err) {
    showToast(`❌ Error saving series settings: ${err.message}`);
  }
}


// ---------------- VIEW 2: STUDIO RENDERING ---------------- //

const blockDiskCacheTimers = new Map();

function debouncedCheckBlockDiskCache(block, idx, rowEl) {
  if (blockDiskCacheTimers.has(idx)) {
    clearTimeout(blockDiskCacheTimers.get(idx));
  }
  const timer = setTimeout(async () => {
    blockDiskCacheTimers.delete(idx);
    if (!block || !state.currentProject) return;
    const sig = getBlockSignature(block);
    try {
      const payload = createBlockSynthesizePayload(block);
      payload.index = idx;
      const res = await fetch("/api/check_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block: payload })
      });
      if (!res.ok) return;
      const data = await res.json();
      const r = (data.results && data.results[0]) || null;
      if (r && r.cached && r.audio_url) {
        if (getBlockSignature(block) === sig) {
          block.audio_url = r.audio_url;
          block.cachedAudioUrl = r.audio_url;
          block.duration = r.duration;
          block.cachedSig = sig;
          if (!block.take_cache) block.take_cache = {};
          block.take_cache[sig] = {
            audio_url: r.audio_url,
            duration: r.duration,
            cachedSig: sig,
            timestamp: Date.now()
          };
          const targetRow = rowEl || document.querySelector(`[data-index="${idx}"]`);
          if (targetRow) {
            targetRow.classList.remove("processing");
            targetRow.classList.add("ready");
            const timeText = targetRow.querySelector(".scrubber-time");
            if (timeText) timeText.textContent = `● ${Number(r.duration).toFixed(1)}s`;
            const fill = targetRow.querySelector(".scrubber-fill");
            if (fill) fill.style.width = "0%";
            const playBtn = targetRow.querySelector(".play-block-btn");
            if (playBtn) playBtn.textContent = "▶";
            syncRowHeaderVisuals(block, targetRow);
          }
          if (typeof renderTimelinePreview === "function") renderTimelinePreview();
          debouncedSave();
        }
      }
    } catch (_) {}
  }, 250);
  blockDiskCacheTimers.set(idx, timer);
}

function syncRowHeaderVisuals(block, rowEl) {
  if (!block || !rowEl) return;
  const voice = (typeof getVoiceById === "function") ? getVoiceById(block.voice_id) : null;
  const char = block.character_id
    ? (typeof getCharacterById === "function" ? getCharacterById(block.character_id) : null)
    : (block.speaker && (!voice || block.speaker !== voice.name) && typeof getCharacterById === "function" ? getCharacterById(block.speaker) : null);
  
  const isCharVoice = Boolean(char && block.voice_id && (block.voice_id === char.voice_id || block.voice_id === char.assigned_voice_id));
  const isCustomVoice = Boolean(
    (voice && !isCharVoice) ||
    (!char && (block.voice_id || block.speaker)) ||
    (block.is_custom_edited && voice && !isCharVoice)
  );

  const blockColor = (isCustomVoice && voice && voice.color) ? voice.color : ((char && char.color) ? char.color : (voice ? voice.color : "#6366f1"));
  const blockBadge = (isCustomVoice && voice)
    ? (voice.badge || (voice.name ? voice.name.slice(0, 2).toUpperCase() : "VO"))
    : ((char && char.badge) ? char.badge : (voice ? (voice.badge || (voice.id ? voice.id.slice(0, 2).toUpperCase() : "VO")) : "VO"));
  const isCustom = Boolean(char && block.is_custom_edited);

  const avatar = rowEl.querySelector(".block-avatar");
  if (avatar) {
    avatar.style.backgroundColor = blockColor;
    avatar.innerHTML = `${escapeHtml(blockBadge)}${isCustom ? '<span class="custom-tweak-dot" title="Custom tweaked sentence"></span>' : ''}`;
  }

  const charTag = rowEl.querySelector(".block-character-tag");
  if (charTag) {
    charTag.style.backgroundColor = `${blockColor}22`;
    charTag.style.color = blockColor;
    charTag.style.borderColor = `${blockColor}45`;
    const cleanVoiceName = voice && voice.name ? voice.name.replace(/\s*\([^)]*\)/g, '').trim() : (block.speaker || "Voice");
    if (isCustomVoice && voice) {
      charTag.textContent = `🎙️ ${cleanVoiceName}`;
      charTag.className = "block-character-tag custom-voice-tag";
      charTag.title = `Custom Voice: ${voice.name}${char ? ` (Overriding ${char.name})` : ''} - click to change voice`;
    } else if (char) {
      charTag.textContent = `🎭 ${char.name}`;
      charTag.className = "block-character-tag";
      charTag.title = `Character: ${char.name} (${voice ? voice.name : ''}) - click to change voice`;
    } else {
      charTag.textContent = `🎙️ ${cleanVoiceName}`;
      charTag.className = "block-character-tag standalone-voice-tag";
      charTag.title = `Standalone Voice: ${cleanVoiceName} - click to change voice`;
    }
  }

  const engPill = rowEl.querySelector(".block-engine-pill");
  if (engPill) {
    const bEngine = block.engine || (char && char.engine) || (voice && voice.engine) || (state.currentProject?.tier === "cinema_pro" ? "fish_s2" : "edge_tts");
    const bModel = block.model || (char && char.model);
    const bEngBadge = getEngineModelBadge(bEngine, bModel);
    engPill.style.background = bEngBadge.bg;
    engPill.style.color = bEngBadge.color;
    engPill.style.borderColor = `${bEngBadge.color}33`;
    engPill.title = `Engine: ${bEngBadge.text}`;
    engPill.innerHTML = `<span>${bEngBadge.icon}</span> ${bEngBadge.text}`;
  }
}

function findMatchingTake(block) {
  if (!block || !block.take_cache) return null;
  const newSig = getBlockSignature(block);
  // 1. Exact signature match
  if (block.take_cache[newSig] && block.take_cache[newSig].audio_url) {
    return block.take_cache[newSig];
  }

  // 2. Smart fallback: find take with matching sentence text, target model, and target voice
  const text = (block.text || "").trim();
  const char = (typeof getCharacterById === "function") ? getCharacterById(block.character_id || block.speaker) : null;
  const targetVoice = block.voice_id || (char && (char.voice_id || char.assigned_voice_id)) || "";
  const voiceObj = (typeof getVoiceById === "function") ? getVoiceById(targetVoice) : null;
  const targetEngine = block.engine || voiceObj?.engine || state.activeEngine || "fish_s2";
  const targetModel = block.model || (char && char.model) || state.activeModel || "";

  let bestTake = null;
  let bestTs = -1;

  for (const [sKey, take] of Object.entries(block.take_cache)) {
    if (!take || !take.audio_url) continue;
    const parts = sKey.split("__");
    if (parts.length >= 4) {
      const tEng = parts[0];
      const tModel = parts[1];
      const tText = parts[2];
      const tVoice = parts[3];

      const isVoiceMatch = (tVoice === targetVoice) || (targetVoice && (tVoice.includes(targetVoice) || targetVoice.includes(tVoice)));
      const isTextMatch = (tText === text);
      const isModelMatch = !targetModel || !tModel || (tModel === targetModel);

      if (isTextMatch && isVoiceMatch && isModelMatch) {
        const ts = take.timestamp || 0;
        if (!bestTake || (tEng === targetEngine && ts >= bestTs) || ts > bestTs) {
          bestTake = take;
          bestTs = ts;
        }
      }
    } else if (parts.length >= 3) {
      // Legacy signature format fallback
      const tEng = parts[0];
      const tText = parts[1];
      const tVoice = parts[2];
      const isVoiceMatch = (tVoice === targetVoice) || (targetVoice && (tVoice.includes(targetVoice) || targetVoice.includes(tVoice)));
      const isTextMatch = (tText === text);
      if (isTextMatch && isVoiceMatch) {
        const ts = take.timestamp || 0;
        if (!bestTake || (tEng === targetEngine && ts >= bestTs) || ts > bestTs) {
          bestTake = take;
          bestTs = ts;
        }
      }
    }
  }

  return bestTake;
}

function invalidateBlockAudio(block, rowEl = null) {
  if (!block) return;

  // 1. Save current valid take before discarding or switching
  if (block.cachedSig && (block.cachedAudioUrl || block.audio_url)) {
    if (!block.take_cache) block.take_cache = {};
    let saveUrl = block.cachedAudioUrl || block.audio_url;
    if (saveUrl && saveUrl.startsWith("blob:") && block.hash) {
      saveUrl = `/api/audio/${block.hash}.wav`;
    }
    block.take_cache[block.cachedSig] = {
      audio_url: saveUrl,
      duration: block.duration,
      cachedSig: block.cachedSig,
      timestamp: Date.now()
    };
  }

  // 2. Check if the block's new state matches an existing take in memory (exact or matching voice/text)!
  const newSig = getBlockSignature(block);
  const matchingTake = findMatchingTake(block);
  if (matchingTake && matchingTake.audio_url) {
    let takeUrl = matchingTake.audio_url;
    if (takeUrl && takeUrl.startsWith("blob:") && block.hash) {
      takeUrl = `/api/audio/${block.hash}.wav`;
      matchingTake.audio_url = takeUrl;
    }
    block.audio_url = takeUrl;
    block.cachedAudioUrl = takeUrl;
    block.duration = matchingTake.duration;
    block.cachedSig = newSig;
    if (!block.take_cache) block.take_cache = {};
    block.take_cache[newSig] = {
      audio_url: takeUrl,
      duration: matchingTake.duration,
      cachedSig: newSig,
      timestamp: Date.now()
    };

    if (!rowEl && typeof block === "object") {
      const idx = state.currentProject?.blocks?.indexOf(block);
      if (idx !== undefined && idx >= 0) {
        rowEl = document.querySelector(`[data-index="${idx}"]`);
      }
    }
    if (rowEl) {
      rowEl.classList.remove("processing");
      rowEl.classList.add("ready");
      const timeText = rowEl.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = `● ${Number(matchingTake.duration).toFixed(1)}s`;
      const fill = rowEl.querySelector(".scrubber-fill");
      if (fill) fill.style.width = "0%";
      const playBtn = rowEl.querySelector(".play-block-btn");
      if (playBtn) playBtn.textContent = "▶";
      syncRowHeaderVisuals(block, rowEl);
    }
    if (typeof renderTimelinePreview === "function") renderTimelinePreview();
    return;
  }

  // 3. If not in memory, temporarily set to Draft and trigger debounced disk cache check
  delete block.cachedAudioUrl;
  delete block.audio_url;
  delete block.cachedSig;
  delete block.duration;
  delete block.audio_hash;
  delete block.rawAudioUrl;
  delete block.raw_audio_url;

  if (!rowEl && typeof block === "object") {
    const idx = state.currentProject?.blocks?.indexOf(block);
    if (idx !== undefined && idx >= 0) {
      rowEl = document.querySelector(`[data-index="${idx}"]`);
    }
  }
  if (rowEl) {
    rowEl.classList.remove("ready", "playing");
    const timeText = rowEl.querySelector(".scrubber-time");
    if (timeText) timeText.textContent = "Draft (click ▶ to render)";
    const fill = rowEl.querySelector(".scrubber-fill");
    if (fill) fill.style.width = "0%";
    const playBtn = rowEl.querySelector(".play-block-btn");
    if (playBtn) playBtn.textContent = "▶";
    syncRowHeaderVisuals(block, rowEl);
  }

  const idx = state.currentProject?.blocks?.indexOf(block);
  if (idx !== undefined && idx >= 0) {
    debouncedCheckBlockDiskCache(block, idx, rowEl);
  }
  if (typeof renderTimelinePreview === "function") renderTimelinePreview();
}

async function syncProjectAudioCache(forceAll = false) {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;

  const blocksToCheck = [];
  state.currentProject.blocks.forEach((b, idx) => {
    if (!b || !b.text || b.type === "heading" || b.is_spoken === false) return;
    const sig = getBlockSignature(b);
    
    // Guard against stale blob: URLs
    if (b.audio_url && b.audio_url.startsWith("blob:")) {
      b.audio_url = b.hash ? `/api/audio/${b.hash}.wav` : "";
      if (!b.audio_url) {
        delete b.audio_url;
        delete b.cachedSig;
      }
    }
    if (b.cachedAudioUrl && b.cachedAudioUrl.startsWith("blob:")) {
      b.cachedAudioUrl = b.hash ? `/api/audio/${b.hash}.wav` : "";
      if (!b.cachedAudioUrl) delete b.cachedAudioUrl;
    }

    // Check in-memory take_cache first (exact or matching voice/text)!
    const matchingTake = findMatchingTake(b);
    if (matchingTake && matchingTake.audio_url) {
      let takeUrl = matchingTake.audio_url;
      if (takeUrl && takeUrl.startsWith("blob:") && b.hash) {
        takeUrl = `/api/audio/${b.hash}.wav`;
        matchingTake.audio_url = takeUrl;
      }
      if (takeUrl) {
        b.audio_url = takeUrl;
        b.cachedAudioUrl = takeUrl;
        b.duration = matchingTake.duration;
        b.cachedSig = sig;
        if (!b.take_cache) b.take_cache = {};
        b.take_cache[sig] = {
          audio_url: takeUrl,
          duration: matchingTake.duration,
          cachedSig: sig,
          timestamp: Date.now()
        };
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("processing");
          row.classList.add("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = `● ${Number(matchingTake.duration).toFixed(1)}s`;
          syncRowHeaderVisuals(b, row);
        }
        return;
      }
    }

    // If audio is missing or cachedSig doesn't match current sig, query backend
    if (forceAll || !b.audio_url || !b.cachedAudioUrl || b.cachedSig !== sig) {
      const payload = createBlockSynthesizePayload(b);
      payload.index = idx;
      blocksToCheck.push(payload);
    }
  });

  if (blocksToCheck.length === 0) {
    if (typeof renderTimelinePreview === "function") renderTimelinePreview();
    return;
  }

  try {
    const res = await fetch("/api/check_cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: blocksToCheck })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.results)) return;

    let restoredCount = 0;
    data.results.forEach(r => {
      if (r && r.cached && r.audio_url) {
        const idx = r.index;
        const b = state.currentProject.blocks[idx];
        if (b) {
          const sig = getBlockSignature(b);
          b.audio_url = r.audio_url;
          b.cachedAudioUrl = r.audio_url;
          b.duration = r.duration;
          b.cachedSig = sig;
          if (!b.take_cache) b.take_cache = {};
          b.take_cache[sig] = {
            audio_url: r.audio_url,
            duration: r.duration,
            cachedSig: sig,
            timestamp: Date.now()
          };
          const row = document.querySelector(`[data-index="${idx}"]`);
          if (row) {
            row.classList.remove("processing");
            row.classList.add("ready");
            const timeText = row.querySelector(".scrubber-time");
            if (timeText) timeText.textContent = `● ${Number(r.duration).toFixed(1)}s`;
            syncRowHeaderVisuals(b, row);
          }
          restoredCount++;
        }
      }
    });

    if (restoredCount > 0) {
      if (typeof renderTimelinePreview === "function") renderTimelinePreview();
      debouncedSave();
      console.log(`[Cache Sync] Reconnected ${restoredCount} cached audio takes from disk.`);
    }
  } catch (err) {
    console.warn("[Cache Sync] Error checking disk cache:", err);
  }
}

function extractLeadingTagsFromSentence(block, row = null, textareaEl = null, idx = null) {
  if (!block || !block.text) return false;
  // Match one or more bracketed tags at the start of sentence, e.g. "[sigh]" or "[sigh][uncanny realization]"
  const m = block.text.match(/^((?:\[[^\]\n]+\]\s*)+)(.*)$/s);
  if (!m) return false;

  const rawTags = m[1];
  const remainingText = m[2].trimStart();

  // Extract all tag contents inside brackets
  const newTagTokens = Array.from(rawTags.matchAll(/\[([^\]]+)\]/g)).map(x => x[1].trim()).filter(Boolean);
  if (!newTagTokens.length) return false;

  // Extract existing tags from block.emotion_tag
  let existingTokens = [];
  if (block.emotion_tag) {
    const existingMatches = Array.from(block.emotion_tag.matchAll(/\[([^\]]+)\]/g)).map(x => x[1].trim()).filter(Boolean);
    if (existingMatches.length) {
      existingTokens = existingMatches;
    } else if (block.emotion_tag.trim()) {
      existingTokens = [block.emotion_tag.trim()];
    }
  }

  // Merge tags: new tags from sentence come first, then existing tags (no duplicates)
  const merged = [...newTagTokens];
  for (const t of existingTokens) {
    if (!merged.includes(t)) {
      merged.push(t);
    }
  }

  const combinedTagStr = merged.map(t => `[${t}]`).join("");

  block.emotion_tag = combinedTagStr;
  block.text = remainingText;

  if (textareaEl) {
    textareaEl.value = remainingText;
    autoResizeTextarea(textareaEl);
  }

  const bIdx = (idx !== null && idx !== undefined) ? idx : state.currentProject?.blocks?.indexOf(block);
  if (!row && bIdx !== undefined && bIdx >= 0) {
    row = document.querySelector(`[data-index="${bIdx}"]`);
  }

  // Invalidate audio cache since text and tag changed
  invalidateBlockAudio(block, row);

  // Update green pill above block
  if (row) {
    let pill = row.querySelector(".block-emotion-pill");
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "block-emotion-pill";
      if (bIdx !== undefined && bIdx >= 0) {
        pill.onclick = () => handleFocusEmotionInput(bIdx);
      }
      const contentCol = row.querySelector(".block-content-col");
      if (contentCol) contentCol.prepend(pill);
    }
    pill.textContent = combinedTagStr;
    pill.title = `Fish S2 Pro Emotion Tag: ${combinedTagStr}`;
  }

  // Update left inspector input if this block is active or selected
  const inspectorTagInput = document.getElementById("input-emotion-tag");
  if (inspectorTagInput && (state.activeBlockIndex === bIdx || (state.selectedBlockIndices && state.selectedBlockIndices.has(bIdx)))) {
    inspectorTagInput.value = combinedTagStr;
  }

  return true;
}

function renderStudio() {
  if (!state.currentProject) return;

  // Always ensure state.savedCharacters is synced with state.currentProject.characters
  if ((!state.savedCharacters || state.savedCharacters.length === 0) && Array.isArray(state.currentProject.characters) && state.currentProject.characters.length > 0) {
    state.savedCharacters = [...state.currentProject.characters];
  } else if (Array.isArray(state.savedCharacters) && state.savedCharacters.length > 0 && (!state.currentProject.characters || state.currentProject.characters.length === 0)) {
    state.currentProject.characters = [...state.savedCharacters];
  }

  document.getElementById("project-title").value = state.currentProject.title || "Untitled Project";
  
  if (!state.selectedBlockIndices || state.selectedBlockIndices.size === 0) {
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
  }

  renderBlocks();
  renderInspector();
  renderSavedCharactersList();
  renderTimeline();
  updateSelectionUI();
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById("studio-toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

function getCharacterById(charIdOrSpeaker) {
  if (!charIdOrSpeaker) return null;
  const list = (state.savedCharacters && state.savedCharacters.length > 0)
    ? state.savedCharacters
    : (state.currentProject?.characters || []);
  const target = String(charIdOrSpeaker).toLowerCase();
  return list.find(c => c.id === charIdOrSpeaker || (c.name && c.name.toLowerCase() === target)) || null;
}

function renderBlocks() {
  const container = document.getElementById("story-container");
  const canvas = document.querySelector(".editor-canvas");
  const savedScrollTop = canvas ? canvas.scrollTop : 0;
  if (!container) return;
  container.innerHTML = "";

  if (!state.currentProject?.blocks || state.currentProject.blocks.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "dashboard-empty-state";
    emptyState.style.margin = "40px auto";
    emptyState.innerHTML = `
      <div class="empty-icon">📝</div>
      <div class="empty-title">No dialogue lines yet</div>
      <div class="empty-desc">Type your script above or click "Import Text" to populate sentences.</div>
    `;
    container.appendChild(emptyState);
    return;
  }

  if (activeCharacterFilter) {
    const filterBanner = document.createElement("div");
    filterBanner.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.4); border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; color: #93c5fd; font-size: 12.5px;";
    filterBanner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 16px;">🔍</span>
        <span>Filtered view: Showing only sentences spoken by <strong>${escapeHtml(activeCharacterFilter.name)}</strong></span>
      </div>
      <button type="button" class="btn btn-secondary" onclick="clearCharacterFilter()" style="font-size: 11px; padding: 4px 10px; background: rgba(59, 130, 246, 0.25); border-color: rgba(59, 130, 246, 0.5); color: #fff;">✕ Show All</button>
    `;
    container.appendChild(filterBanner);
  }

  state.currentProject.blocks.forEach((block, idx) => {
    // Check character filter
    if (activeCharacterFilter && block.type !== "heading" && block.is_spoken !== false) {
      const cLow = activeCharacterFilter.name.toLowerCase();
      const matches = (block.character_id === activeCharacterFilter.id) ||
                      ((block.speaker || "").toLowerCase() === cLow);
      if (!matches) return;
    }
    // ---------------- SCENE / SECTION DIVIDER (NON-SPOKEN) ---------------- //
    if (block.type === "heading" || block.is_spoken === false) {
      const isPlaying = state.currentlyPlayingBlockIdx === idx;
      const isSelected = state.selectedBlockIndices.has(idx);
      const isActive = state.activeBlockIndex === idx;

      const sceneRow = document.createElement("div");
      sceneRow.className = `scene-divider-row ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${isPlaying ? "playing" : ""}`;
      sceneRow.dataset.index = idx;

      const pVal = Number(block.pause_after !== undefined ? block.pause_after : 1.0).toFixed(1);

      sceneRow.innerHTML = `
        <div class="scene-divider-left">
          <div class="block-drag-handle scene-drag-handle" title="Drag to change order (or press Alt+↑ / Alt+↓)">
            <svg class="drag-handle-icon" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2.5" cy="2.5" r="1.5"/>
              <circle cx="7.5" cy="2.5" r="1.5"/>
              <circle cx="2.5" cy="8" r="1.5"/>
              <circle cx="7.5" cy="8" r="1.5"/>
              <circle cx="2.5" cy="13.5" r="1.5"/>
              <circle cx="7.5" cy="13.5" r="1.5"/>
            </svg>
          </div>
          <span class="scene-badge-icon" title="Scene / Chapter Divider">🎬</span>
          <div class="scene-content-col">
            <div class="scene-meta-row">
              <span class="scene-category-pill">Scene / Section Divider</span>
              <span class="scene-nonspoken-tag">🔇 Non-Spoken • Excluded from Voice Generation</span>
            </div>
            <input type="text" class="scene-title-input" value="${escapeHtml(block.text || '')}" placeholder="e.g. Scene 2: Day Three (non-spoken)...">
          </div>
        </div>
        <div class="scene-divider-right">
          <div class="scene-pause-box" title="Transition silence pause before the next scene starts">
            <span>⏱ Pause:</span>
            <input type="number" class="scene-pause-input" value="${pVal}" min="0" max="10" step="0.5">s
          </div>
          <div class="block-btn-cluster reorder-cluster">
            <button type="button" class="order-btn" onclick="moveBlockUp(${idx})" title="Move up (Alt+↑)">▲</button>
            <button type="button" class="order-btn" onclick="moveBlockDown(${idx})" title="Move down (Alt+↓)">▼</button>
          </div>
          <div class="block-btn-cluster insert-cluster">
            <button type="button" class="insert-block-btn" onclick="insertBlockAfter(${idx})" title="Insert sentence below this divider">＋</button>
            <button type="button" class="insert-block-btn" onclick="insertHeadingAfter(${idx})" title="Insert another scene divider below" style="font-size: 13px;">🎬</button>
          </div>
          <button type="button" class="scene-btn convert-speech-btn" onclick="convertHeadingToSpeech(${idx})" title="Convert to regular spoken sentence block">🎙️ Speak</button>
          <button type="button" class="scene-delete-btn" onclick="deleteBlock(${idx})" title="Delete scene heading">✕</button>
        </div>
      `;

      container.appendChild(sceneRow);
      attachBlockDragAndDrop(sceneRow, idx);

      const titleInput = sceneRow.querySelector(".scene-title-input");
      titleInput.addEventListener("input", (e) => {
        block.text = e.target.value;
        renderTimeline();
        debouncedSave();
      });
      titleInput.addEventListener("focus", () => {
        titleInput.dataset.initialText = block.text;
        selectBlock(idx, "single");
      });
      titleInput.addEventListener("blur", () => {
        if (titleInput.dataset.initialText !== undefined && titleInput.dataset.initialText !== block.text) {
          recordHistory("Edit Scene Title");
          delete titleInput.dataset.initialText;
        }
      });

      const pauseInput = sceneRow.querySelector(".scene-pause-input");
      pauseInput.addEventListener("change", (e) => {
        recordHistory("Change Scene Pause");
        block.pause_after = Math.max(0, parseFloat(e.target.value) || 0);
        debouncedSave();
      });

      sceneRow.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("input") || e.target.closest(".block-drag-handle")) return;
        selectBlock(idx, "single");
      });

      return;
    }

    // ---------------- SPOKEN SENTENCE BLOCK ---------------- //
    const voice = getVoiceById(block.voice_id);
    const row = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isProcessing = typeof activeBlockProgressQueue !== "undefined" && activeBlockProgressQueue.includes(idx);
    const isReady = !isProcessing && Boolean(block.cachedAudioUrl || block.audio_url);
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const isSelected = state.selectedBlockIndices.has(idx);
    const isActive = state.activeBlockIndex === idx;

    row.className = `block-row ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${isReady ? "ready" : ""} ${isPlaying ? "playing" : ""} ${isProcessing ? "processing" : ""}`;
    row.dataset.index = idx;

    const durText = isProcessing ? "⏳ Synthesizing..." : (isReady ? (block.duration ? `● ${block.duration.toFixed(1)}s` : "● Ready") : "Draft (click ▶ to render)");

    const char = block.character_id
      ? getCharacterById(block.character_id)
      : (block.speaker && (!voice || block.speaker !== voice.name) ? getCharacterById(block.speaker) : null);
    const isCharVoice = Boolean(char && block.voice_id && (block.voice_id === char.voice_id || block.voice_id === char.assigned_voice_id));
    const isCustomVoice = Boolean(
      (voice && !isCharVoice) ||
      (!char && (block.voice_id || block.speaker)) ||
      (block.is_custom_edited && voice && !isCharVoice)
    );
    const isStandaloneVoice = !char && Boolean(block.voice_id || block.speaker);
    const blockColor = (isCustomVoice && voice && voice.color) ? voice.color : ((char && char.color) ? char.color : (voice ? voice.color : "#6366f1"));
    const blockBadge = (isCustomVoice && voice)
      ? (voice.badge || (voice.name ? voice.name.slice(0, 2).toUpperCase() : "VO"))
      : ((char && char.badge) ? char.badge : (voice ? (voice.badge || voice.id.slice(0, 2).toUpperCase()) : "VO"));
    const isCustom = Boolean(char && block.is_custom_edited);
    const bEngine = block.engine || (char && char.engine) || (voice && voice.engine) || (state.currentProject?.tier === "cinema_pro" ? "fish_s2" : "edge_tts");
    const bModel = block.model || (char && char.model);
    const bEngBadge = getEngineModelBadge(bEngine, bModel);

    const cleanVoiceName = voice && voice.name ? voice.name.replace(/\s*\([^)]*\)/g, '').trim() : (block.speaker || "Voice");
    const blockTitle = (isCustomVoice && voice)
      ? `Custom Voice: ${voice.name}${char ? ` (Overriding ${char.name})` : ''} • Engine: ${bEngBadge.text}${isCustom ? ' • Customized for this sentence' : ''}`
      : (char ? `Character: ${char.name} (${voice ? voice.name : 'Voice'}) • Engine: ${bEngBadge.text}${isCustom ? ' • Customized for this sentence' : ' • Synced'}` : `Standalone Voice: ${cleanVoiceName} • Engine: ${bEngBadge.text} (Click to change)`);

    // SENTENCE BLOCK WITH AUDIO SCRUBBER, DRAG HANDLE & SLEEK CUSTOM CHECKBOX
    row.innerHTML = `
      <div class="block-drag-handle" title="Drag to change order (or press Alt+↑ / Alt+↓)">
        <svg class="drag-handle-icon" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
          <circle cx="2.5" cy="2.5" r="1.5"/>
          <circle cx="7.5" cy="2.5" r="1.5"/>
          <circle cx="2.5" cy="8" r="1.5"/>
          <circle cx="7.5" cy="8" r="1.5"/>
          <circle cx="2.5" cy="13.5" r="1.5"/>
          <circle cx="7.5" cy="13.5" r="1.5"/>
        </svg>
      </div>
      <button class="block-select-btn" data-index="${idx}" title="${isSelected ? 'Deselect sentence' : 'Select sentence'}">
        <span class="custom-chk-box"></span>
      </button>
      <button class="block-voice-btn" title="${escapeHtml(blockTitle)}">
        <div class="block-avatar" style="background-color: ${blockColor}">
          ${escapeHtml(blockBadge)}
          ${isCustom ? '<span class="custom-tweak-dot" title="Custom tweaked sentence"></span>' : ''}
        </div>
      </button>
      <div class="block-content-col" style="flex-direction: column; align-items: stretch; justify-content: center; gap: 3px;">
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px;">
          ${(isCustomVoice && voice) ? `
            <span class="block-character-tag custom-voice-tag" onclick="openVoiceDrawer(${idx})" style="background: ${blockColor}22; color: ${blockColor}; border: 1px solid ${blockColor}45; border-radius: 4px; padding: 1px 7px; font-size: 11px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Custom Voice: ${escapeHtml(voice.name)}${char ? ` (Overriding ${escapeHtml(char.name)})` : ''} - click to change voice">
              🎙️ ${escapeHtml(cleanVoiceName)}
            </span>
          ` : char ? `
            <span class="block-character-tag" onclick="openVoiceDrawer(${idx})" style="background: ${blockColor}22; color: ${blockColor}; border: 1px solid ${blockColor}45; border-radius: 4px; padding: 1px 7px; font-size: 11px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Character: ${escapeHtml(char.name)} (${escapeHtml(voice ? voice.name : '')}) - click to change voice">
              🎭 ${escapeHtml(char.name)}
            </span>
          ` : (isStandaloneVoice && (block.speaker !== "Narrator" || (voice && voice.id !== state.defaultNarratorVoiceId))) ? `
            <span class="block-character-tag standalone-voice-tag" onclick="openVoiceDrawer(${idx})" style="background: ${blockColor}22; color: ${blockColor}; border: 1px solid ${blockColor}45; border-radius: 4px; padding: 1px 7px; font-size: 11px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="Standalone Voice: ${escapeHtml(cleanVoiceName)} - click to change voice">
              🎙️ ${escapeHtml(cleanVoiceName)}
            </span>
          ` : ''}
          <span class="block-engine-pill" style="font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: ${bEngBadge.bg}; color: ${bEngBadge.color}; border: 1px solid ${bEngBadge.color}33; display: inline-flex; align-items: center; gap: 3px;" title="Engine: ${bEngBadge.text}">
            <span>${bEngBadge.icon}</span> ${bEngBadge.text}
          </span>
          ${block.emotion_tag ? `<span class="block-emotion-pill" onclick="handleFocusEmotionInput(${idx})" title="Fish S2 Pro Emotion: ${escapeHtml(block.emotion_tag)}">${escapeHtml(block.emotion_tag)}</span>` : ''}
        </div>
        <textarea class="block-textarea" placeholder="Type sentence here...">${block.text || ""}</textarea>
        <div class="block-audio-scrubber" title="Click anywhere to jump & listen from this point">
          <div class="scrubber-track">
            <div class="scrubber-fill"></div>
          </div>
          <span class="scrubber-time">${durText}</span>
        </div>
      </div>
      <div class="block-actions">
        <div class="block-btn-cluster reorder-cluster">
          <button type="button" class="order-btn" onclick="moveBlockUp(${idx})" title="Move sentence up (Alt+↑)">▲</button>
          <button type="button" class="order-btn" onclick="moveBlockDown(${idx})" title="Move sentence down (Alt+↓)">▼</button>
        </div>
        <div class="block-btn-cluster insert-cluster">
          <button type="button" class="insert-block-btn" onclick="insertBlockAfter(${idx})" title="Insert new sentence below (Ctrl+Enter)">＋</button>
          <button type="button" class="insert-block-btn" onclick="insertHeadingAfter(${idx})" title="Insert non-spoken Scene Heading below (🎬)" style="font-size: 13px;">🎬</button>
        </div>
        <button type="button" class="play-block-btn" title="Play sentence (or Space)">${isPlaying ? "🔊" : "▶"}</button>
        <button type="button" class="rerender-block-btn" onclick="handleReRenderBlock(${idx})" title="Force re-render fresh take (bypasses cache)">🔄</button>
        <button type="button" class="delete-block-btn" title="Delete sentence">✕</button>
      </div>
    `;

    container.appendChild(row);
    attachBlockDragAndDrop(row, idx);

    const selBtn = row.querySelector(".block-select-btn");
    selBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBlock(idx, "toggle");
    });

    const textarea = row.querySelector(".block-textarea");
    autoResizeTextarea(textarea);

    textarea.addEventListener("input", (e) => {
      block.text = e.target.value;
      invalidateBlockAudio(block, row);
      autoResizeTextarea(textarea);

      // If user typed/pasted one or more complete tags at start of sentence, auto-extract to tag pill!
      if (block.text && block.text.match(/^\[[^\]\n]+\](?:\s|\S)/)) {
        extractLeadingTagsFromSentence(block, row, textarea, idx);
      }
      renderTimeline();
      debouncedSave();
    });

    textarea.addEventListener("focus", () => {
      textarea.dataset.initialText = block.text || "";
      if (textarea.value === "New sentence..." || textarea.value === "Type sentence here...") {
        textarea.select();
      }
      if (!state.selectedBlockIndices.has(idx)) {
        selectBlock(idx, "single");
      } else {
        state.activeBlockIndex = idx;
        renderInspector();
        highlightTimelineBlock(idx);
        updateActiveSentenceHint(idx);
      }
    });

    textarea.addEventListener("blur", () => {
      // Auto-extract leading tags on blur even if user didn't type a trailing space
      if (block.text && block.text.match(/^\[[^\]\n]+\]/)) {
        extractLeadingTagsFromSentence(block, row, textarea, idx);
        renderTimeline();
        debouncedSave();
      }
      if (textarea.dataset.initialText !== undefined && textarea.dataset.initialText !== (block.text || "")) {
        recordHistory("Edit Sentence");
        delete textarea.dataset.initialText;
      }
    });

    textarea.addEventListener("keydown", (e) => {
      // Ctrl+Enter or Cmd+Enter to quickly insert the next sentence block right below
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        insertBlockAfter(idx);
      }
    });

    // Word-level click & seek within textarea
    textarea.addEventListener("click", () => {
      if (!state.selectedBlockIndices.has(idx)) {
        selectBlock(idx, "single");
      }
      const charPos = textarea.selectionStart;
      const totalChars = Math.max(textarea.value.length, 1);
      const ratio = Math.min(Math.max(charPos / totalChars, 0), 1);

      if (state.currentlyPlayingBlockIdx === idx && state.storyAudioPlayer.duration) {
        state.storyAudioPlayer.currentTime = ratio * state.storyAudioPlayer.duration;
      }
    });

    // Double-click word to jump & start playing from that word!
    textarea.addEventListener("dblclick", () => {
      selectBlock(idx, "single");
      const charPos = textarea.selectionStart;
      const totalChars = Math.max(textarea.value.length, 1);
      const ratio = Math.min(Math.max(charPos / totalChars, 0), 1);
      const targetSec = ratio * (block.duration || 4.0);
      state.isPlayingStory = true;
      playBlockAudio(idx, targetSec, false);
    });

    // Scrubber click seeks directly
    const scrubberTrack = row.querySelector(".scrubber-track");
    scrubberTrack.addEventListener("click", (e) => {
      e.stopPropagation();
      selectBlock(idx, "single");
      const rect = scrubberTrack.getBoundingClientRect();
      const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      if (state.currentlyPlayingBlockIdx === idx && state.storyAudioPlayer.duration) {
        state.storyAudioPlayer.currentTime = ratio * state.storyAudioPlayer.duration;
      } else {
        const targetSec = ratio * (block.duration || 4.0);
        state.isPlayingStory = true;
        playBlockAudio(idx, targetSec, false);
      }
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("textarea") || e.target.closest(".scrubber-track")) {
        return;
      }
      if (e.shiftKey) {
        selectBlock(idx, "range");
      } else if (e.ctrlKey || e.metaKey) {
        selectBlock(idx, "toggle");
      } else {
        selectBlock(idx, "single");
      }
    });

    // Voice button opens drawer
    row.querySelector(".block-voice-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openVoiceDrawer(idx);
    });

    // Play block audio button
    const playBtn = row.querySelector(".play-block-btn");
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.currentlyPlayingBlockIdx === idx && state.isPlayingStory && !state.storyAudioPlayer.paused) {
        pauseStoryPlayback();
      } else {
        state.isPlayingStory = true;
        playBlockAudio(idx, 0, false);
      }
    });

    // Delete block
    row.querySelector(".delete-block-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteBlock(idx);
    });
  });

  if (canvas && savedScrollTop > 0) {
    canvas.scrollTop = savedScrollTop;
  }

  if (typeof activeBlockProgressQueue !== "undefined" && activeBlockProgressQueue.length > 0) {
    updateBlockQueueDisplay();
  }
  updateAIAgentContextUI();
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.max(el.scrollHeight, 48) + "px";
}

function selectBlock(idx, mode = "single") {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  if (idx < 0 || idx >= total) return;

  if (mode === "single") {
    state.selectedBlockIndices = new Set([idx]);
    state.activeBlockIndex = idx;
    state.lastClickedIndex = idx;
  } else if (mode === "toggle") {
    if (state.selectedBlockIndices.has(idx)) {
      if (state.selectedBlockIndices.size > 1) {
        state.selectedBlockIndices.delete(idx);
        if (state.activeBlockIndex === idx) {
          state.activeBlockIndex = Array.from(state.selectedBlockIndices)[0];
        }
      }
    } else {
      state.selectedBlockIndices.add(idx);
      state.activeBlockIndex = idx;
    }
    state.lastClickedIndex = idx;
  } else if (mode === "range") {
    const start = Math.min(state.lastClickedIndex ?? 0, idx);
    const end = Math.max(state.lastClickedIndex ?? 0, idx);
    for (let i = start; i <= end; i++) {
      state.selectedBlockIndices.add(i);
    }
    state.activeBlockIndex = idx;
  }

  updateSelectionDOM();
  renderInspector();
  highlightTimelineBlock(state.activeBlockIndex);
  updateActiveSentenceHint(state.activeBlockIndex);
  updateSelectionUI();
}

function updateSelectionDOM() {
  const rows = document.querySelectorAll(".block-row, .scene-divider-row");
  rows.forEach((row, i) => {
    const isSelected = state.selectedBlockIndices.has(i);
    const isActive = state.activeBlockIndex === i;
    row.classList.toggle("selected", isSelected);
    row.classList.toggle("active", isActive);
    const selBtn = row.querySelector(".block-select-btn");
    if (selBtn) {
      selBtn.title = isSelected ? "Deselect sentence" : "Select sentence";
    }
  });
}

function updateSelectionUI() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  const count = state.selectedBlockIndices.size;
  const allSelected = (count === total && total > 0);

  // Header badge
  const badge = document.getElementById("selection-count-badge");
  if (badge) {
    if (count > 1) {
      badge.style.display = "inline-flex";
      badge.textContent = `${count} Selected`;
    } else {
      badge.style.display = "none";
    }
  }

  // Inspector scope label
  const scopeLabel = document.getElementById("inspector-scope-label");
  if (scopeLabel) {
    scopeLabel.textContent = count > 1 ? `${count} Sentences (Bulk)` : "1 Sentence";
  }

  // Canvas Action Bar
  const bar = document.getElementById("canvas-action-bar");
  if (bar) {
    bar.classList.toggle("has-selection", count > 1);
  }

  const icon = document.getElementById("select-all-icon");
  const label = document.getElementById("select-all-label");
  const countPill = document.getElementById("bulk-selection-count-text");
  const btnVoice = document.getElementById("btn-bulk-change-voice");
  const btnMerge = document.getElementById("btn-bulk-merge");
  const btnRender = document.getElementById("btn-bulk-render");
  const btnDelete = document.getElementById("btn-bulk-delete");

  if (icon && label) {
    if (allSelected) {
      icon.textContent = "✓";
      label.textContent = "Deselect All";
    } else if (count > 1) {
      icon.textContent = "☐";
      label.textContent = `Select All (${total})`;
    } else {
      icon.textContent = "☐";
      label.textContent = "Select All";
    }
  }

  if (countPill) {
    if (count > 1) {
      countPill.style.display = "inline-flex";
      countPill.textContent = `${count} of ${total} Selected`;
    } else {
      countPill.style.display = "none";
    }
  }

  // Mode containers: Story Utilities vs Bulk Actions
  const storyUtils = document.getElementById("story-utility-buttons");
  const bulkButtons = document.getElementById("bulk-selection-buttons");
  const isMultiSelect = (count > 1);

  if (storyUtils) {
    storyUtils.style.display = isMultiSelect ? "none" : "flex";
  }
  if (bulkButtons) {
    bulkButtons.style.display = isMultiSelect ? "flex" : "none";
  }

  if (btnVoice) {
    btnVoice.textContent = `👥 Voice (${count})`;
  }
  if (btnMerge) {
    btnMerge.textContent = `🔗 Merge Selected (${count})`;
  }
  if (btnRender) {
    btnRender.textContent = `⚡ Render (${count})`;
  }
  if (btnDelete) {
    btnDelete.textContent = `🗑️ Delete (${count})`;
  }

  const btnExport = document.getElementById("btn-bulk-export");
  if (btnExport) {
    btnExport.style.display = "none";
  }

  const btnCustomToggle = document.getElementById("btn-bulk-custom-toggle");
  if (btnCustomToggle) {
    btnCustomToggle.textContent = `🔄 Custom/Sync (${count})`;
  }

  // Update dynamic options inside unified export dropdown
  updateExportDropdownUI();

  const btnSelectAll = document.getElementById("btn-toggle-select-all");
  if (btnSelectAll) {
    btnSelectAll.title = allSelected ? "Deselect all sentences in this story" : (count > 1 ? `Select all (${total}) sentences` : "Select all sentences in this story");
  }

  // Update Apply to Selected inspector buttons
  const btnApplyVoice = document.getElementById("btn-apply-voice-to-selected");
  const btnApplySettings = document.getElementById("btn-apply-settings-to-selected");
  const applySelectedBadge = document.getElementById("apply-selected-count-badge");

  if (btnApplyVoice) {
    btnApplyVoice.textContent = count > 1 ? `🎭 Apply Voice to Selected (${count})` : "🎭 Apply Voice to Selected";
  }
  if (btnApplySettings) {
    btnApplySettings.textContent = count > 1 ? `⚡ Apply Audio FX & Pacing Only (${count})` : "⚡ Apply Audio FX & Pacing Only";
  }
  const btnApplyBothList = document.querySelectorAll(".btn-apply-both-to-selected");
  btnApplyBothList.forEach(btn => {
    btn.textContent = count > 1 ? `✨ Apply Voice & Settings to Selected (${count})` : "✨ Apply Voice & Settings to Selected";
  });
  if (applySelectedBadge) {
    applySelectedBadge.textContent = count > 1 ? `${count} Selected` : "1 Sentence";
  }

  updateOverriddenCastButtonUI();
  updateAIAgentContextUI();
}

function updateOverriddenCastButtonUI() {
  const btnApply = document.getElementById("btn-apply-to-overridden-cast");
  const btnRevert = document.getElementById("btn-revert-to-overridden-cast");
  const indicator = document.getElementById("default-voice-indicator");

  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    if (btnApply) btnApply.style.display = "none";
    if (btnRevert) btnRevert.style.display = "none";
    if (indicator) indicator.textContent = "";
    return;
  }

  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) {
    if (btnApply) btnApply.style.display = "none";
    if (btnRevert) btnRevert.style.display = "none";
    if (indicator) indicator.textContent = "";
    return;
  }

  // Find original / overridden character or current character
  const charId = activeBlock.overridden_character_id || activeBlock.character_id;
  const char = charId
    ? getCharacterById(charId)
    : (activeBlock.overridden_speaker ? getCharacterById(activeBlock.overridden_speaker) : (activeBlock.speaker ? getCharacterById(activeBlock.speaker) : null));
  const charName = char ? char.name : (activeBlock.overridden_speaker || (activeBlock.character_id ? activeBlock.speaker : ""));

  if (charName) {
    const isVoiceDifferent = char && activeBlock.voice_id && activeBlock.voice_id !== char.voice_id;
    if (btnApply) {
      btnApply.style.display = "flex";
      if (isVoiceDifferent) {
        btnApply.textContent = `✨ Set as ${charName}'s Default Voice`;
        btnApply.title = `Update character "${charName}" in Chapter Cast to this voice and sync all ${charName} sentences`;
      } else {
        btnApply.textContent = `🎭 Character: ${charName}`;
        btnApply.title = `Currently using ${charName}'s default cast voice`;
      }
    }
    if (btnRevert) {
      if (isVoiceDifferent || activeBlock.is_custom_edited) {
        btnRevert.style.display = "flex";
        btnRevert.textContent = `↺ Revert to ${charName}'s Default Voice`;
        btnRevert.title = `Revert this sentence back to ${charName}'s default character voice`;
      } else {
        btnRevert.style.display = "none";
      }
    }
    if (indicator) {
      indicator.textContent = `Cast: ${charName}`;
    }
  } else {
    if (btnApply) btnApply.style.display = "none";
    if (btnRevert) btnRevert.style.display = "none";
    if (indicator) indicator.textContent = "";
  }
}

function handleApplyVoiceToOverriddenCast() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const charId = activeBlock.overridden_character_id || activeBlock.character_id;
  const char = charId
    ? getCharacterById(charId)
    : (activeBlock.overridden_speaker ? getCharacterById(activeBlock.overridden_speaker) : (activeBlock.speaker ? getCharacterById(activeBlock.speaker) : null));
  if (!char) {
    showToast("⚠️ No original cast member found for this sentence.", "error");
    return;
  }

  const voice = getVoiceById(activeBlock.voice_id);
  const voiceName = voice ? voice.name : activeBlock.voice_id;

  recordHistory(`Apply Voice ${voiceName} to Cast ${char.name}`);

  // 1. Update the Character's voice in Chapter Cast
  char.voice_id = activeBlock.voice_id;
  char.assigned_voice_id = activeBlock.voice_id;
  if (activeBlock.engine) {
    char.engine = activeBlock.engine;
  }
  if (activeBlock.reference_audio) {
    char.reference_audio = activeBlock.reference_audio;
    char.reference_text = activeBlock.reference_text || "";
  } else {
    delete char.reference_audio;
    delete char.reference_text;
  }
  if (activeBlock.blend_weights) {
    char.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
  } else {
    delete char.blend_weights;
  }
  saveSavedCharactersToStorage();

  // 2. Sync all sentences belonging to that character!
  let syncedCount = 0;
  state.currentProject.blocks.forEach(b => {
    if (b.character_id === char.id || (b.speaker && b.speaker.toLowerCase() === (char.name || "").toLowerCase()) || b === activeBlock) {
      b.voice_id = char.voice_id;
      b.character_id = char.id;
      b.speaker = char.name;
      if (activeBlock.engine) {
        b.engine = activeBlock.engine;
      }
      delete b.is_custom_edited;
      delete b.overridden_character_id;
      delete b.overridden_speaker;
      if (char.reference_audio) {
        b.reference_audio = char.reference_audio;
        b.reference_text = char.reference_text || "";
      } else {
        delete b.reference_audio;
        delete b.reference_text;
      }
      if (char.blend_weights) {
        b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
      } else {
        delete b.blend_weights;
      }
      if (typeof invalidateBlockAudio === "function") {
        invalidateBlockAudio(b);
      }
      syncedCount++;
    }
  });

  renderStudio();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  renderSavedCharactersList();
  updateSelectionUI();
  syncProjectAudioCache();
  showToast(`✓ Applied voice "${voiceName}" to cast "${char.name}" & synced ${syncedCount} sentence(s)!`, "success");
}

function handleRevertToOverriddenCast() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const charId = activeBlock.overridden_character_id;
  const char = charId ? getCharacterById(charId) : (activeBlock.overridden_speaker ? getCharacterById(activeBlock.overridden_speaker) : null);
  if (!char) {
    showToast("⚠️ No previous cast member to revert to.", "error");
    return;
  }

  recordHistory(`Revert Sentence to Cast: ${char.name}`);

  activeBlock.character_id = char.id;
  activeBlock.speaker = char.name;
  activeBlock.voice_id = char.voice_id;

  const charVoice = (typeof getVoiceById === "function") ? getVoiceById(char.voice_id) : null;
  activeBlock.engine = char.engine || charVoice?.engine || (
    char.voice_id?.includes("Neural") ? "edge_tts" :
    (char.voice_id?.startsWith("af_") || char.voice_id?.startsWith("am_") || char.voice_id?.startsWith("bf_") || char.voice_id?.startsWith("bm_")) ? "kokoro" :
    "fish_s2"
  );

  delete activeBlock.is_custom_edited;
  delete activeBlock.overridden_character_id;
  delete activeBlock.overridden_speaker;
  if (char.model) {
    activeBlock.model = char.model;
  } else {
    delete activeBlock.model;
  }

  if (char.reference_audio) {
    activeBlock.reference_audio = char.reference_audio;
    activeBlock.reference_text = char.reference_text || "";
  } else {
    delete activeBlock.reference_audio;
    delete activeBlock.reference_text;
  }

  if (char.blend_weights) {
    activeBlock.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
  } else {
    delete activeBlock.blend_weights;
  }

  if (typeof invalidateBlockAudio === "function") {
    invalidateBlockAudio(activeBlock);
  }

  renderStudio();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  renderSavedCharactersList();
  updateSelectionUI();
  syncProjectAudioCache();
  showToast(`↺ Reverted sentence back to cast "${char.name}"!`, "success");
}

function toggleSelectAll() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  const allSelected = (state.selectedBlockIndices.size === total && total > 0);

  if (allSelected) {
    const keepIdx = (state.activeBlockIndex >= 0 && state.activeBlockIndex < total) ? state.activeBlockIndex : 0;
    state.selectedBlockIndices = new Set([keepIdx]);
    state.activeBlockIndex = keepIdx;
  } else {
    state.selectedBlockIndices = new Set(Array.from({ length: total }, (_, i) => i));
  }

  updateSelectionDOM();
  updateSelectionUI();
}

function clearBlockSelection() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const total = state.currentProject.blocks.length;
  const keepIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < total) ? state.activeBlockIndex : 0;
  state.selectedBlockIndices = new Set([keepIdx]);
  state.activeBlockIndex = keepIdx;
  updateSelectionDOM();
  updateSelectionUI();
}

function handleMakeDefaultVoice() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  recordHistory("Set Default Narrator");

  const newVoiceId = activeBlock.voice_id || "blend_fenrir_onyx";
  const newBlendWeights = activeBlock.blend_weights ? JSON.parse(JSON.stringify(activeBlock.blend_weights)) : null;
  const voiceObj = getVoiceById(newVoiceId);

  state.currentProject.default_voice = newVoiceId;
  if (state.currentProject.default_settings) {
    state.currentProject.default_settings.voice_id = newVoiceId;
    if (newBlendWeights) {
      state.currentProject.default_settings.blend_weights = JSON.parse(JSON.stringify(newBlendWeights));
    } else {
      delete state.currentProject.default_settings.blend_weights;
    }
  }

  let changedCount = 0;
  let preservedCount = 0;

  state.currentProject.blocks.forEach(b => {
    if (b.type === "heading" || b.is_spoken === false) return;

    // Preserve custom dialogue characters (don't overwrite specific character lines with narrator)
    if (b.character_id) {
      const char = getCharacterById(b.character_id);
      if (char && char.role !== "narrator" && char.id !== "char_narrator") {
        return;
      }
    }

    const hasSameVoice = (b.voice_id === newVoiceId);
    const hasSameBlend = JSON.stringify(b.blend_weights || null) === JSON.stringify(newBlendWeights || null);

    if (hasSameVoice && hasSameBlend) {
      // Voice already matches! Preserve audio cache completely — do NOT re-render!
      preservedCount++;
      return;
    }

    // Voice actually changed: update voice and invalidate cache for this block
    b.voice_id = newVoiceId;
    if (newBlendWeights) {
      b.blend_weights = JSON.parse(JSON.stringify(newBlendWeights));
    } else {
      delete b.blend_weights;
    }
    invalidateBlockAudio(b);
    changedCount++;
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  syncProjectAudioCache();
  if (changedCount > 0) {
    showToast(`👑 Set "${voiceObj.name}" as Default Narrator (${changedCount} updated, ${preservedCount} already had this voice preserved)!`);
  } else {
    showToast(`👑 "${voiceObj.name}" is already the default narrator across all narration blocks (${preservedCount} preserved)!`);
  }
}

function handleBulkDelete() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const count = state.selectedBlockIndices.size;
  if (count === 0) return;

  recordHistory(`Bulk Delete ${count} Sentences`);

  const remaining = state.currentProject.blocks.filter((_, idx) => !state.selectedBlockIndices.has(idx));
  if (remaining.length === 0) {
    const defs = getProjectDefaultSettings();
    const newB = {
      id: "b_1",
      text: "Type sentence here...",
      voice_id: defs.voice_id,
      speed: defs.speed,
      gain: defs.gain,
      pause_after: defs.pause_after,
      pitch_shift: defs.pitch_shift,
      warmth: defs.warmth,
      clarity: defs.clarity,
      reverb: defs.reverb,
      radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
      fx_filter: defs.fx_filter
    };
    if (defs.blend_weights) newB.blend_weights = JSON.parse(JSON.stringify(defs.blend_weights));
    state.currentProject.blocks = [newB];
  } else {
    state.currentProject.blocks = remaining;
  }

  state.selectedBlockIndices = new Set([0]);
  state.activeBlockIndex = 0;
  state.lastClickedIndex = 0;
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`✓ Deleted ${count} sentence(s).`);
}

function handleBulkMergeSelected() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const selectedList = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
  if (selectedList.length < 2) {
    showToast("⚠️ Select at least 2 sentences to merge.");
    return;
  }

  recordHistory(`Merge ${selectedList.length} Sentences`);

  const firstIdx = selectedList[0];
  const lastIdx = selectedList[selectedList.length - 1];
  const firstBlock = state.currentProject.blocks[firstIdx];
  const lastBlock = state.currentProject.blocks[lastIdx];

  const combinedText = selectedList
    .map(idx => (state.currentProject.blocks[idx]?.text || "").trim())
    .filter(t => t.length > 0)
    .join(" ");

  firstBlock.text = combinedText;
  firstBlock.pause_after = lastBlock.pause_after || firstBlock.pause_after || 0.6;
  delete firstBlock.cachedAudioUrl;
  delete firstBlock.cachedSig;
  delete firstBlock.duration;

  // Remove the other selected blocks
  const toRemove = new Set(selectedList.slice(1));
  state.currentProject.blocks = state.currentProject.blocks.filter((_, idx) => !toRemove.has(idx));

  state.selectedBlockIndices = new Set([firstIdx]);
  state.activeBlockIndex = firstIdx;
  state.lastClickedIndex = firstIdx;

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`🔗 Merged ${selectedList.length} sentences into 1 block!`);
}

async function handleMergeShortBlocks() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length <= 1) {
    showToast("ℹ️ Not enough sentences to merge.");
    return;
  }

  const btn = document.getElementById("btn-merge-short");
  if (btn) {
    btn.textContent = "⏳ Merging...";
    btn.disabled = true;
  }

  const initialCount = state.currentProject.blocks.length;

  try {
    const res = await fetch("/api/merge_short", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        max_chars: 90,
        max_words: 16,
        max_merged_chars: 320
      })
    });

    const mergedBlocks = await res.json();
    if (!Array.isArray(mergedBlocks) || mergedBlocks.length === 0) {
      showToast("ℹ️ No ultra-short blocks found to merge.");
      return;
    }

    if (mergedBlocks.length === initialCount) {
      showToast("ℹ️ All sentences are already optimal length (no ultra-short fragments found).");
      return;
    }

    recordHistory("Merge Short Sentences");

    state.currentProject.blocks = mergedBlocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;

    renderStudio();
    debouncedSave();
    const diff = initialCount - mergedBlocks.length;
    showToast(`🔗 Merged ${diff} ultra-short sentences of same narrator! Reduced story from ${initialCount} to ${mergedBlocks.length} blocks.`);
  } catch (err) {
    console.error("Merge error:", err);
    showToast("❌ Merge error: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = "🔗 Merge Short";
      btn.disabled = false;
    }
  }
}

// ---------------- APPLY TO SELECTED SENTENCES ---------------- //

function handleApplyVoiceToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length === 0) {
    showToast("⚠️ Select at least one spoken sentence.");
    return;
  }

  const activeChar = activeBlock.character_id ? getCharacterById(activeBlock.character_id) : null;
  const activeVoiceId = activeBlock.voice_id || (activeChar && (activeChar.voice_id || activeChar.assigned_voice_id)) || "";
  const voice = getVoiceById(activeVoiceId);
  const activeEngine = activeBlock.engine || voice?.engine || (
    activeVoiceId.includes("Neural") ? "edge_tts" :
    (activeVoiceId.startsWith("af_") || activeVoiceId.startsWith("am_") || activeVoiceId.startsWith("bf_") || activeVoiceId.startsWith("bm_")) ? "kokoro" :
    "fish_s2"
  );

  recordHistory(`Apply Voice to Selected (${spokenTargets.length})`);

  let changedCount = 0;
  let preservedCount = 0;

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    const bChar = b.character_id ? getCharacterById(b.character_id) : null;
    const bVoiceId = b.voice_id || (bChar && (bChar.voice_id || bChar.assigned_voice_id)) || "";
    const hasSameVoice = (bVoiceId === activeVoiceId);
    const hasSameBlend = JSON.stringify(b.blend_weights || null) === JSON.stringify(activeBlock.blend_weights || null);
    const hasSameEngine = (!b.engine || b.engine === activeEngine);

    if (hasSameVoice && hasSameBlend && hasSameEngine && (b.cachedAudioUrl || b.audio_url)) {
      // Same voice, blend & engine with existing audio: preserve completely!
      preservedCount++;
      return;
    }

    // Preserve previous character if applicable
    const prevChar = b.character_id ? getCharacterById(b.character_id) : (b.overridden_character_id ? getCharacterById(b.overridden_character_id) : null);
    if (prevChar && !activeBlock.character_id) {
      b.overridden_character_id = prevChar.id;
      b.overridden_speaker = prevChar.name;
    }

    b.voice_id = activeVoiceId;
    b.engine = activeEngine;
    if (activeBlock.model) {
      b.model = activeBlock.model;
    } else {
      delete b.model;
    }
    if (activeBlock.reference_audio) {
      b.reference_audio = activeBlock.reference_audio;
      b.reference_text = activeBlock.reference_text || "";
    } else if (voice?.reference_audio) {
      b.reference_audio = voice.reference_audio;
      b.reference_text = voice.reference_text || "";
    } else {
      delete b.reference_audio;
      delete b.reference_text;
    }
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }
    if (activeBlock.character_id) {
      b.character_id = activeBlock.character_id;
      b.speaker = activeBlock.speaker;
      b.is_custom_edited = Boolean(activeBlock.is_custom_edited);
    } else {
      delete b.character_id;
      delete b.is_custom_edited;
      b.speaker = voice?.name || activeBlock.speaker || "Voice";
    }

    changedCount++;
    const row = document.querySelector(`[data-index="${idx}"]`);
    invalidateBlockAudio(b, row);
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateActiveCharacterStatusBanner();
  updateOverriddenCastButtonUI();
  updateSelectionUI();
  syncProjectAudioCache();
  if (changedCount > 0) {
    showToast(`🎭 Applied voice "${voice?.name || activeVoiceId}" (${changedCount} updated, ${preservedCount} preserved)!`);
  } else {
    showToast(`🎭 All selected sentences already have "${voice?.name || activeVoiceId}" (${preservedCount} preserved)!`);
  }
}

function handleApplySettingsToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply these settings to.");
    return;
  }

  recordHistory(`Apply Audio FX & Pacing to Selected (${spokenTargets.length})`);

  const gainVal = activeBlock.gain !== undefined ? activeBlock.gain : 1.0;
  const speedVal = activeBlock.speed !== undefined ? activeBlock.speed : 0.90;
  const pauseVal = activeBlock.pause_after !== undefined ? activeBlock.pause_after : 0.6;
  const pitchVal = Number(activeBlock.pitch_shift || 0.0);
  const warmthVal = Number(activeBlock.warmth || 0.0);
  const clarityVal = Number(activeBlock.clarity || 0.0);
  const reverbVal = Number(activeBlock.reverb || 0.0);
  const radioVal = Boolean(activeBlock.radio_fx);
  const filterVal = (activeBlock.fx_filter || (radioVal ? "radio" : "none")).toLowerCase();

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.gain = gainVal;
    b.speed = speedVal;
    b.pause_after = pauseVal;
    b.pitch_shift = pitchVal;
    b.warmth = warmthVal;
    b.clarity = clarityVal;
    b.reverb = reverbVal;
    b.radio_fx = (filterVal === "radio");
    b.fx_filter = filterVal;
    if (b.character_id) {
      b.is_custom_edited = true;
    }
    if (!b.cachedAudioUrl) {
      delete b.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    }
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  triggerInstantBlockDsp(spokenTargets);
  showToast(`⚡ Applied pacing, pitch, EQ & filter to ${spokenTargets.length} selected sentences!`);
}

function handleApplyVoiceAndSettingsToSelected() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a source spoken sentence first.");
    return;
  }

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [activeIdx];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply voice & settings to.");
    return;
  }

  recordHistory(`Apply Voice & Settings to Selected (${spokenTargets.length})`);

  let changedCount = 0;
  let preservedCount = 0;

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    const prevSig = getBlockSignature(b);

    b.voice_id = activeBlock.voice_id;
    b.reference_audio = activeBlock.reference_audio || "";
    b.reference_text = activeBlock.reference_text || "";
    if (activeBlock.speaker) b.speaker = activeBlock.speaker;
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }

    b.speed = activeBlock.speed !== undefined ? activeBlock.speed : 0.90;
    b.gain = activeBlock.gain !== undefined ? activeBlock.gain : 1.0;
    b.pause_after = activeBlock.pause_after !== undefined ? activeBlock.pause_after : 0.6;
    b.pitch_shift = Number(activeBlock.pitch_shift || 0.0);
    b.warmth = Number(activeBlock.warmth || 0.0);
    b.clarity = Number(activeBlock.clarity || 0.0);
    b.reverb = Number(activeBlock.reverb || 0.0);
    b.fx_filter = activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none");
    b.radio_fx = Boolean(activeBlock.radio_fx || activeBlock.fx_filter === "radio");

    if (activeBlock.character_id) {
      b.character_id = activeBlock.character_id;
      b.is_custom_edited = Boolean(activeBlock.is_custom_edited);
    } else {
      delete b.character_id;
      delete b.is_custom_edited;
    }

    const newSig = getBlockSignature(b);
    if (prevSig === newSig && b.cachedAudioUrl) {
      // Audio parameters didn't change: preserve existing audio cache!
      preservedCount++;
      return;
    }

    changedCount++;
    const row = document.querySelector(`[data-index="${idx}"]`);
    invalidateBlockAudio(b, row);
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  syncProjectAudioCache();
  if (changedCount > 0) {
    showToast(`✨ Applied Voice & All Settings (${changedCount} updated, ${preservedCount} preserved)!`);
  } else {
    showToast(`✨ All selected sentences already match these settings (${preservedCount} preserved)!`);
  }
}

function handleApplyVoiceToAll() {
  handleApplyVoiceToSelected();
}

function handleApplyPacingToAll() {
  handleApplySettingsToSelected();
}

// ---------------- SAVED CHARACTER VOICES LIBRARY ---------------- //

const CHARACTER_COLOR_PALETTE = [
  "#6366f1", // Indigo
  "#3b82f6", // Blue
  "#06b6d4", // Cyan
  "#10b981", // Emerald
  "#eab308", // Amber
  "#f97316", // Orange
  "#ef4444", // Red
  "#ec4899", // Pink
  "#a855f7"  // Purple
];

let activeCharacterFilter = null;

function selectBlocksByCharacter(charId, charName) {
  if (!state.currentProject?.blocks) return;
  const indices = new Set();
  const cNameLow = (charName || "").toLowerCase();
  state.currentProject.blocks.forEach((b, idx) => {
    if (b.is_heading || b.type === "heading" || b.is_spoken === false) return;
    if (b.character_id === charId || (b.speaker && b.speaker.toLowerCase() === cNameLow)) {
      indices.add(idx);
    }
  });
  if (indices.size === 0) {
    showToast(`No sentences spoken by ${charName} found in this chapter.`);
    return;
  }
  state.selectedBlockIndices = indices;
  state.activeBlockIndex = Array.from(indices)[0];
  state.lastClickedIndex = state.activeBlockIndex;
  renderBlocks();
  renderInspector();
  updateSelectionUI();
  scrollBlockIntoView(state.activeBlockIndex);
  showToast(`🎯 Selected all ${indices.size} sentences spoken by ${charName}.`, 2500);
}

function toggleCharacterFilter(charId, charName) {
  if (activeCharacterFilter && (activeCharacterFilter.id === charId || activeCharacterFilter.name.toLowerCase() === (charName || "").toLowerCase())) {
    clearCharacterFilter();
  } else {
    activeCharacterFilter = { id: charId, name: charName };
    const banner = document.getElementById("inspector-char-filter-banner");
    const bannerText = document.getElementById("inspector-char-filter-text");
    if (banner) banner.style.display = "flex";
    if (bannerText) bannerText.textContent = `Showing only: ${charName}`;
    showToast(`🔍 Filtered view: Showing only ${charName}'s lines.`, 2500);
    renderBlocks();
    renderSavedCharactersList();
  }
}

function clearCharacterFilter() {
  activeCharacterFilter = null;
  const banner = document.getElementById("inspector-char-filter-banner");
  if (banner) banner.style.display = "none";
  showToast("Showing all chapter sentences.", 2000);
  renderBlocks();
  renderSavedCharactersList();
}

async function changeCharacterVoice(charId, newVoiceId) {
  if (!state.currentProject) return;
  const char = (state.savedCharacters || []).find(c => c.id === charId) ||
               (state.currentProject.characters || []).find(c => c.id === charId);
  if (!char) return;

  const voiceObj = getVoiceById(newVoiceId);
  char.voice_id = newVoiceId;
  char.assigned_voice_id = newVoiceId;
  char.reference_audio = voiceObj?.reference_audio || "";
  char.reference_text = voiceObj?.reference_text || "";

  let updatedBlocks = 0;
  const cLow = (char.name || "").toLowerCase();
  (state.currentProject.blocks || []).forEach(b => {
    if (b.character_id === charId || (b.speaker && b.speaker.toLowerCase() === cLow)) {
      // Save current take before changing voice
      saveCurrentTakeToBlockCache(b);

      b.voice_id = newVoiceId;
      b.character_id = charId;
      b.speaker = char.name;
      b.reference_audio = char.reference_audio || voiceObj?.reference_audio || "";
      b.reference_text = char.reference_text || voiceObj?.reference_text || "";

      const newSig = getBlockSignature(b);
      if (b.take_cache && b.take_cache[newSig]) {
        const take = b.take_cache[newSig];
        b.audio_url = take.audio_url;
        b.cachedAudioUrl = take.audio_url;
        b.duration = take.duration;
        b.cachedSig = newSig;
      } else {
        delete b.cachedAudioUrl;
        delete b.audio_url;
        delete b.cachedSig;
        delete b.duration;
      }
      updatedBlocks++;
    }
  });

  saveSavedCharactersToStorage();
  debouncedSave();

  if (state.currentProject.folder_id) {
    try {
      await fetch("/api/folder/master_cast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder_id: state.currentProject.folder_id,
          characters: [char]
        })
      });
    } catch(e) {}
  }

  showToast(`🎙️ ${char.name} voice updated to ${voiceObj.name} across ${updatedBlocks} sentences!`, 3500);
  renderBlocks();
  renderSavedCharactersList();
  syncProjectAudioCache();
}

async function syncWithUniverseCast() {
  if (!state.currentProject?.folder_id) {
    showToast("This project is not linked to an Audiobook Series folder.");
    return;
  }
  showToast("🔄 Syncing with Universe Master Cast...");
  try {
    const res = await fetch(`/api/folder?id=${encodeURIComponent(state.currentProject.folder_id)}`);
    if (!res.ok) throw new Error("Could not fetch series");
    const d = await res.json();
    const folder = d.folder || d;
    const masterCast = folder.characters || [];

    const currentChars = state.savedCharacters || state.currentProject.characters || [];
    const mergedMap = new Map();
    masterCast.forEach(c => mergedMap.set(c.id || c.name.toLowerCase(), c));
    currentChars.forEach(c => mergedMap.set(c.id || c.name.toLowerCase(), c));

    const merged = Array.from(mergedMap.values());
    state.savedCharacters = merged;
    state.currentProject.characters = merged;
    saveSavedCharactersToStorage();

    await fetch("/api/folder/master_cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: state.currentProject.folder_id,
        characters: merged
      })
    });

    renderSavedCharactersList();
    renderBlocks();
    showToast(`✅ Synced! Universe Master Cast has ${merged.length} characters.`, 3000);
  } catch (err) {
    showToast(`❌ Sync failed: ${err.message}`, 4000);
  }
}

function loadSavedCharacters() {
  loadSavedCharactersForCurrentProject();
}

function loadSavedCharactersForCurrentProject() {
  if (!state.currentProject) {
    state.savedCharacters = [];
    renderSavedCharactersList();
    return;
  }

  const projId = state.currentProject.id;

  // 1. If project object has characters, ALWAYS use them as primary truth
  if (Array.isArray(state.currentProject.characters) && state.currentProject.characters.length > 0) {
    state.savedCharacters = [...state.currentProject.characters];
    try {
      localStorage.setItem(`kss_chars_${projId}`, JSON.stringify(state.savedCharacters));
    } catch (e) {}
    renderSavedCharactersList();
    return;
  }

  // 2. Check localStorage cache
  try {
    const rawProj = localStorage.getItem(`kss_chars_${projId}`);
    if (rawProj) {
      const parsedProj = JSON.parse(rawProj);
      if (Array.isArray(parsedProj) && parsedProj.length > 0) {
        state.savedCharacters = parsedProj;
        state.currentProject.characters = [...state.savedCharacters];
        renderSavedCharactersList();
        return;
      }
    }
  } catch (e) {}

  state.savedCharacters = [];
  renderSavedCharactersList();
}

function saveSavedCharactersToStorage() {
  if (!state.savedCharacters || state.savedCharacters.length === 0) {
    if (Array.isArray(state.currentProject?.characters) && state.currentProject.characters.length > 0) {
      state.savedCharacters = [...state.currentProject.characters];
    } else {
      state.savedCharacters = [];
    }
  }

  if (state.currentProject) {
    state.currentProject.characters = [...state.savedCharacters];
    const projId = state.currentProject.id;
    try {
      localStorage.setItem(`kss_chars_${projId}`, JSON.stringify(state.savedCharacters));
    } catch (e) {
      console.warn("Could not save characters to localStorage:", e);
    }
    debouncedSave();
  }
}

function renderSavedCharactersList() {
  const container = document.getElementById("saved-characters-list");
  const countBadge = document.getElementById("characters-count-badge");
  const drawerBadge = document.getElementById("drawer-characters-badge");

  // Sync state.savedCharacters from state.currentProject.characters if not yet loaded
  if (!state.savedCharacters || state.savedCharacters.length === 0) {
    if (Array.isArray(state.currentProject?.characters) && state.currentProject.characters.length > 0) {
      state.savedCharacters = [...state.currentProject.characters];
    } else if (state.currentProject?.folder_id && Array.isArray(state.folders)) {
      const f = state.folders.find(x => x.id === state.currentProject.folder_id);
      const fChars = f ? (f.characters || f.master_cast) : null;
      if (Array.isArray(fChars) && fChars.length > 0) {
        state.savedCharacters = [...fChars];
        if (state.currentProject) {
          state.currentProject.characters = [...fChars];
          saveSavedCharactersToStorage();
        }
      }
    }
  }

  // Auto-detect any speakers explicitly present in blocks that aren't yet in savedCharacters
  if (state.currentProject?.blocks && Array.isArray(state.savedCharacters)) {
    // Helper to check if a name is actually a voice model name rather than a real story character
    const isVoiceArtifactName = (name) => {
      if (!name) return true;
      const lower = name.toLowerCase().trim();
      // NARRATOR IS A SACRED STORY CHARACTER — NEVER FILTER IT OUT!
      if (lower === "narrator") return false;
      if (["meta", "heading", "default", "voice", "system", "divider"].includes(lower)) return true;
      if (lower.includes("neural") || lower.includes("edge") || lower.includes("kokoro") || lower.includes("fish narrator") || lower.includes("bright & articulate") || lower.includes("united kingdom") || lower.includes("united states")) return true;
      if (/^(en|es|fr|de|it|pt|ja|zh|ko|ru|hi)-[a-z]{2}-/i.test(name)) return true;
      if (/^(af_|am_|bf_|bm_|fish_|voice_)/i.test(name)) return true;
      // Also check if name matches any known voice model name
      if (Array.isArray(state.voices) && state.voices.some(v => v.name && v.name.toLowerCase() === lower)) return true;
      return false;
    };

    // Filter out existing voice artifacts from savedCharacters
    state.savedCharacters = state.savedCharacters.filter(c => !isVoiceArtifactName(c.name));

    // Ensure Narrator is ALWAYS present at index 0 of savedCharacters
    if (!state.savedCharacters.some(c => (c.name || "").toLowerCase().trim() === "narrator")) {
      const narratorChar = (state.currentProject?.characters || []).find(c => (c.name || "").toLowerCase().trim() === "narrator") || {
        id: "char_1794985695_0_0bb8",
        name: "Narrator",
        voice_id: (state.activeEngine === "kokoro" ? "am_adam" : (state.activeEngine === "edge_tts" ? "en-US-GuyNeural" : "fish_71804f0aa9e8457e92e9e49c26691514")),
        badge: "NA",
        color: "#3b82f6",
        persona: "Pure bone-dry deadpan anchor for psychological horror and supernatural"
      };
      state.savedCharacters.unshift(narratorChar);
    }

    const knownNames = new Set(state.savedCharacters.map(c => (c.name || "").toLowerCase().trim()));
    const knownIds = new Set(state.savedCharacters.map(c => c.id));

    state.currentProject.blocks.forEach(b => {
      const spk = (b.speaker || "").trim();
      if (spk && !isVoiceArtifactName(spk) && !knownNames.has(spk.toLowerCase())) {
        if (b.character_id && knownIds.has(b.character_id)) return;
        const newId = "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000);
        const newChar = {
          id: newId,
          name: spk,
          voice_id: b.voice_id || state.currentProject.default_voice || "am_adam",
          badge: spk.slice(0, 2).toUpperCase(),
          color: "#f59e0b",
          persona: `Speaker in ${state.currentProject.title || 'Chapter'}`
        };
        b.character_id = newId;
        state.savedCharacters.push(newChar);
        knownNames.add(spk.toLowerCase());
        knownIds.add(newId);
        saveSavedCharactersToStorage();
      }
    });
  }

  // Deduplicate characters by both unique ID and unique normalized name
  if (Array.isArray(state.savedCharacters) && state.savedCharacters.length > 1) {
    const seenNames = new Set();
    const seenIds = new Set();
    state.savedCharacters = state.savedCharacters.filter(c => {
      const norm = (c.name || "").trim().toLowerCase();
      if (!norm || seenNames.has(norm) || (c.id && seenIds.has(c.id))) return false;
      seenNames.add(norm);
      if (c.id) seenIds.add(c.id);
      return true;
    });
  }

  const total = state.savedCharacters ? state.savedCharacters.length : 0;
  if (countBadge) countBadge.textContent = total;
  if (drawerBadge) {
    drawerBadge.textContent = total;
    drawerBadge.style.display = total > 0 ? "inline-flex" : "none";
  }

  if (!container) return;
  container.innerHTML = "";

  // Count sentences spoken by each character in this chapter strictly once per block
  const blockCounts = {};
  (state.currentProject?.blocks || []).forEach(b => {
    if (b.is_heading || b.type === "heading" || b.is_spoken === false) return;
    if (b.character_id) {
      blockCounts[b.character_id] = (blockCounts[b.character_id] || 0) + 1;
    } else if (b.speaker) {
      const spkKey = b.speaker.toLowerCase().trim();
      blockCounts[spkKey] = (blockCounts[spkKey] || 0) + 1;
    } else {
      blockCounts["narrator"] = (blockCounts["narrator"] || 0) + 1;
    }
  });

  if (total === 0) {
    container.innerHTML = `
      <div class="saved-char-empty" style="text-align: center; padding: 18px 12px; background: rgba(15, 23, 42, 0.4); border: 1px dashed rgba(255,255,255,0.1); border-radius: 8px;">
        <div style="font-size: 20px; margin-bottom: 6px;">🎭</div>
        <div style="font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 4px;">No Characters Assigned Yet</div>
        <div style="font-size: 11px; color: var(--text-muted); line-height: 1.4;">
          AI Director will automatically cast speakers, or click <strong>＋ New</strong> to create one!
        </div>
      </div>
    `;
    return;
  }

  const activeBlock = (state.currentProject?.blocks && typeof state.activeBlockIndex === "number")
    ? state.currentProject.blocks[state.activeBlockIndex]
    : null;

  const isFish = (state.activeEngine || "fish_s2") === "fish_s2";
  const allVoices = isFish ? (state.fishVoices || state.voices || []) : (state.voices || []);
  const voiceList = Array.isArray(allVoices) ? allVoices : Object.values(allVoices || {});

  state.savedCharacters.forEach(char => {
    const card = document.createElement("div");
    const voiceId = char.voice_id || char.assigned_voice_id;
    const voiceObj = getVoiceById(voiceId);
    const count = (char.id && blockCounts[char.id]) ? blockCounts[char.id] : (blockCounts[(char.name || "").toLowerCase().trim()] || 0);
    const isFiltered = activeCharacterFilter && (activeCharacterFilter.id === char.id || activeCharacterFilter.name.toLowerCase() === (char.name || "").toLowerCase());

    const isMatching = Boolean(
      activeBlock &&
      (activeBlock.character_id === char.id || (activeBlock.speaker && activeBlock.speaker.toLowerCase() === (char.name || "").toLowerCase()) || activeBlock.voice_id === voiceId)
    );

    card.className = `saved-char-card ${isMatching ? "active-char" : ""} ${isFiltered ? "filtered-char" : ""}`;
    card.dataset.charId = char.id;
    card.style.cssText = `display: flex; flex-direction: column; align-items: stretch; width: 100%; box-sizing: border-box; overflow: hidden; gap: 7px; padding: 10px 11px; background: ${isFiltered ? 'rgba(59, 130, 246, 0.15)' : 'rgba(18, 24, 40, 0.7)'}; border: 1px solid ${isFiltered ? '#3b82f6' : (isMatching ? 'var(--accent)' : 'rgba(255, 255, 255, 0.08)')}; border-radius: 8px; transition: all 0.16s ease;`;

    const badgeText = char.badge || char.name.slice(0, 2).toUpperCase();
    const personaText = char.persona ? `<div style="font-size: 10px; color: #94a3b8; margin-top: 1px; line-height: 1.3; max-height: 26px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(char.persona)}</div>` : '';
    const voiceDisplayName = voiceObj?.name || voiceId || "Default Voice";
    const charEngine = char.engine || voiceObj?.engine || (voiceDisplayName.includes("Neural") ? "edge_tts" : "fish_s2");
    const engineBadges = {
      edge_tts: { text: "Edge TTS", bg: "rgba(16, 185, 129, 0.18)", color: "#34d399", icon: "🌐" },
      kokoro: { text: "Kokoro 82M", bg: "rgba(59, 130, 246, 0.18)", color: "#93c5fd", icon: "⚡" },
      fish_s2: { text: "Drama 3", bg: "rgba(245, 158, 11, 0.18)", color: "#fcd34d", icon: "🎭" },
      elevenlabs: { text: "ElevenLabs", bg: "rgba(139, 92, 246, 0.18)", color: "#c4b5fd", icon: "🌟" },
      cartesia: { text: "Cartesia", bg: "rgba(236, 72, 153, 0.18)", color: "#f472b6", icon: "⚡" },
      openai: { text: "OpenAI", bg: "rgba(16, 185, 129, 0.18)", color: "#6ee7b7", icon: "🤖" }
    };
    const eBadge = engineBadges[charEngine] || { text: charEngine.toUpperCase(), bg: "rgba(255,255,255,0.08)", color: "#ddd", icon: "🎙️" };

    card.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; width: 100%; min-width: 0; box-sizing: border-box;">
        <div style="display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; overflow: hidden;">
          <div class="saved-char-avatar" style="background-color: ${char.color || '#6366f1'}; width: 30px; height: 30px; min-width: 30px; max-width: 30px; font-size: 11px; font-weight: 800; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.35); margin: 0;">
            ${escapeHtml(badgeText)}
          </div>
          <div style="min-width: 0; flex: 1; overflow: hidden;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; min-width: 0;">
              <span class="saved-char-name" style="font-size: 12.5px; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1;" title="${escapeHtml(char.name)}">${escapeHtml(char.name)}</span>
              <span class="badge-mini" style="font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(59, 130, 246, 0.2); color: #93c5fd; font-weight: 600; white-space: nowrap; flex-shrink: 0;">
                ${count} sent.
              </span>
            </div>
            ${personaText}
            <div style="font-size: 10px; color: #a5b4fc; display: flex; align-items: center; gap: 5px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; min-width: 0;" title="Assigned: ${escapeHtml(eBadge.text)} • ${escapeHtml(voiceDisplayName)}">
              <span style="font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: ${eBadge.bg}; color: ${eBadge.color}; border: 1px solid ${eBadge.color}33; flex-shrink: 0;">${eBadge.icon} ${eBadge.text}</span>
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;">${escapeHtml(voiceDisplayName)}</span>
            </div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: 4px;">
          <button type="button" class="saved-char-icon-btn" title="Edit character voice & settings" data-action="edit" style="padding: 3px 6px; font-size: 11px;">✏️</button>
          <button type="button" class="saved-char-icon-btn danger" title="Delete character" data-action="delete" style="padding: 3px 6px; font-size: 11px;">✕</button>
        </div>
      </div>

      <!-- Action Buttons Row (3-column CSS Grid: 1fr 1fr auto) -->
      <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; margin-top: 3px; width: 100%; box-sizing: border-box;">
        <button type="button" class="action-pill-btn secondary" data-action="select-all" style="justify-content: center; font-size: 10.5px; padding: 4px 6px; background: rgba(59, 130, 246, 0.15); border-color: rgba(59, 130, 246, 0.35); color: #93c5fd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;" title="Select all ${count} sentences spoken by ${escapeHtml(char.name)} in editor">
          🎯 Select (${count})
        </button>
        <button type="button" class="action-pill-btn secondary" data-action="filter-toggle" style="justify-content: center; font-size: 10.5px; padding: 4px 6px; background: ${isFiltered ? 'rgba(59, 130, 246, 0.35)' : 'rgba(255, 255, 255, 0.05)'}; border-color: ${isFiltered ? '#3b82f6' : 'rgba(255, 255, 255, 0.1)'}; color: ${isFiltered ? '#fff' : 'var(--text-muted)'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;" title="Isolate and show only ${escapeHtml(char.name)}'s lines on canvas">
          ${isFiltered ? '🔍 Show All' : '🔍 Solo'}
        </button>
        <button type="button" class="action-pill-btn primary" data-action="apply" style="font-size: 10.5px; padding: 4px 9px; background: rgba(99, 102, 241, 0.3); border-color: rgba(99, 102, 241, 0.6); color: #c7d2fe; white-space: nowrap; flex-shrink: 0;" title="Assign ${escapeHtml(char.name)} to currently highlighted sentences">
          Apply
        </button>
      </div>
    `;

    // Event listeners
    const selectAllBtn = card.querySelector('[data-action="select-all"]');
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectBlocksByCharacter(char.id, char.name);
      });
    }

    const filterBtn = card.querySelector('[data-action="filter-toggle"]');
    if (filterBtn) {
      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCharacterFilter(char.id, char.name);
      });
    }

    const applyBtn = card.querySelector('[data-action="apply"]');
    if (applyBtn) {
      applyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        applyCharacterToSelected(char.id);
      });
    }

    const editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditCharacterModal(char.id);
      });
    }

    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCharacter(char.id);
      });
    }

    container.appendChild(card);
  });
}

// ---------------- CHARACTER MODAL & AUTO-SYNC ENGINE ---------------- //

function renderCharModalEngineSelector(selectedEngine) {
  const container = document.getElementById("char-modal-engine-selector");
  if (!container) return;

  const isPro = (state.currentProject?.tier === "cinema_pro");
  const engines = isPro ? [
    { id: "fish_s2", name: "🎭 Fish Drama 3", color: "#f59e0b" },
    { id: "elevenlabs", name: "🌟 ElevenLabs", color: "#8b5cf6" },
    { id: "cartesia", name: "⚡ Cartesia", color: "#ec4899" },
    { id: "openai", name: "🤖 OpenAI", color: "#10b981" },
    { id: "edge_tts", name: "🌐 Edge TTS (0 Cr)", color: "#34d399" }
  ] : [
    { id: "edge_tts", name: "🌐 Microsoft Edge TTS", color: "#10b981" },
    { id: "kokoro", name: "⚡ Kokoro 82M", color: "#3b82f6" },
    { id: "fish_s2", name: "🐟 Fish S2 (Colab)", color: "#f59e0b" }
  ];

  state.editingCharModalEngine = selectedEngine || (isPro ? "fish_s2" : "edge_tts");

  container.innerHTML = engines.map(e => {
    const isSelected = (e.id === state.editingCharModalEngine);
    return `
      <button type="button" class="action-pill-btn"
        onclick="handleCharModalEngineChange('${e.id}')"
        style="padding: 5px 11px; font-size: 11px; font-weight: 700; border-radius: 6px; cursor: pointer; transition: all 0.16s ease;
        border: 1.5px solid ${isSelected ? e.color : 'rgba(255,255,255,0.12)'};
        background: ${isSelected ? `${e.color}25` : 'rgba(255,255,255,0.04)'};
        color: ${isSelected ? '#fff' : 'var(--text-muted)'};">
        ${e.name}
      </button>
    `;
  }).join("");
}

function handleCharModalEngineChange(newEngine) {
  state.editingCharModalEngine = newEngine;
  renderCharModalEngineSelector(newEngine);
  populateCharModalVoiceSelect(newEngine);

  const select = document.getElementById("char-modal-voice-select");
  if (select && select.options.length > 0) {
    const currentVal = select.value;
    const currentVoice = getVoiceById(currentVal);
    if (!currentVoice || (currentVoice.engine || "fish_s2") !== newEngine) {
      select.selectedIndex = 0;
      updateCharModalVoiceDetails(select.value);
    }
  }
}

function populateCharModalVoiceSelect(targetEngine = null) {
  const select = document.getElementById("char-modal-voice-select");
  if (!select || !state.voices || state.voices.length === 0) return;

  const eng = targetEngine || state.editingCharModalEngine || (state.currentProject?.tier === "cinema_pro" ? "fish_s2" : "edge_tts");
  state.editingCharModalEngine = eng;

  let voices = state.voices.filter(v => (v.engine || "fish_s2") === eng);
  if (voices.length === 0) {
    voices = state.voices;
  }

  const html = voices.map(v => {
    return `<option value="${v.id}" data-engine="${v.engine || eng}">${v.flag || "🎙️"} ${v.name} (${v.accent || 'EN'} ${v.gender || 'Actor'})</option>`;
  }).join("");
  select.innerHTML = html;
}

function setCharModalSlider(sliderId, valId, value, formatter) {
  const slider = document.getElementById(sliderId);
  const valEl = document.getElementById(valId);
  if (slider) slider.value = value;
  if (valEl) valEl.textContent = formatter(value);
}

function selectCharModalFilter(filterName) {
  state.charModalFxFilter = (filterName || "none").toLowerCase();
  const grid = document.getElementById("char-fx-grid");
  if (grid) {
    grid.querySelectorAll(".fx-filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === state.charModalFxFilter);
    });
  }
  const labelEl = document.getElementById("char-val-filter");
  if (labelEl) {
    const labels = {
      none: "Clean Studio",
      radio: "Radio",
      whisper: "Soft Whisper",
      scream: "Intense Scream",
      demon: "Deep Demon",
      youth: "Child / Youth"
    };
    labelEl.textContent = labels[state.charModalFxFilter] || state.charModalFxFilter;
  }
}

function renderCharModalPalette(selectedColor) {
  state.selectedCharacterColor = selectedColor || "#6366f1";
  const paletteEl = document.getElementById("char-modal-color-palette");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  if (avatarPreview) {
    avatarPreview.style.backgroundColor = state.selectedCharacterColor;
  }
  if (!paletteEl) return;
  paletteEl.innerHTML = "";
  CHARACTER_COLOR_PALETTE.forEach(color => {
    const sw = document.createElement("div");
    sw.className = `char-color-swatch ${color === state.selectedCharacterColor ? 'active' : ''}`;
    sw.style.backgroundColor = color;
    sw.addEventListener("click", () => {
      state.selectedCharacterColor = color;
      paletteEl.querySelectorAll(".char-color-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
      if (avatarPreview) avatarPreview.style.backgroundColor = color;
    });
    paletteEl.appendChild(sw);
  });
}

function updateCharModalVoiceDetails(voiceId) {
  const voice = getVoiceById(voiceId);
  const nameEl = document.getElementById("char-modal-voice-name");
  const subEl = document.getElementById("char-modal-voice-sub");
  const titleEl = document.getElementById("char-modal-selected-voice-title");
  const metaEl = document.getElementById("char-modal-selected-voice-meta");

  const vName = voice?.name || voiceId || "Select Voice";
  const genderStr = (voice?.gender || "").toUpperCase();
  const accentStr = voice?.accent ? ` • ${voice.accent}` : "";
  const timbreStr = voice?.timbre ? ` (${voice.timbre})` : "";
  const vMeta = `${genderStr}${accentStr}${timbreStr}`.trim() || "Voice Actor";

  if (nameEl) nameEl.textContent = vName;
  if (subEl) subEl.textContent = vMeta;
  if (titleEl) titleEl.textContent = vName;
  if (metaEl) metaEl.textContent = vMeta;
}

function pullActiveSentenceToCharModal() {
  if (!state.currentProject?.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const block = state.currentProject.blocks[activeIdx];
  if (!block || block.type === "heading" || block.is_spoken === false) {
    showToast("⚠️ Active block is not a spoken sentence.");
    return;
  }

  // Voice Actor
  const voiceSelect = document.getElementById("char-modal-voice-select");
  if (voiceSelect && block.voice_id) {
    voiceSelect.value = block.voice_id;
    updateCharModalVoiceDetails(block.voice_id);
  }

  // Sliders
  const speed = block.speed !== undefined ? Number(block.speed) : 0.90;
  const pause = block.pause_after !== undefined ? Number(block.pause_after) : 0.6;
  const pitch = Number(block.pitch_shift || 0.0);
  const warmth = Number(block.warmth || 0.0);
  const clarity = Number(block.clarity || 0.0);
  const reverb = Number(block.reverb || 0.0);
  const filter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();

  setCharModalSlider("char-slider-speed", "char-val-speed", speed, v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", pause, v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", pitch, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", warmth, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", clarity, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(reverb * 100), v => `${v}%`);
  selectCharModalFilter(filter);

  showToast("📥 Pulled voice actor & tone settings from active sentence!");
}

function updateCharModalLinkedInfo(char) {
  const linkedInfo = document.getElementById("char-modal-linked-info");
  if (!linkedInfo) return;
  if (!char || !state.currentProject?.blocks) {
    linkedInfo.style.display = "none";
    return;
  }

  const linkedBlocks = state.currentProject.blocks.filter(b => b.character_id === char.id);
  const customCount = linkedBlocks.filter(b => b.is_custom_edited === true).length;
  const syncableCount = linkedBlocks.length - customCount;

  if (linkedBlocks.length === 0) {
    linkedInfo.innerHTML = `ℹ️ No sentences currently assigned to this character in this story.`;
  } else if (customCount === 0) {
    linkedInfo.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span>🔗 <strong>${linkedBlocks.length} sentence${linkedBlocks.length > 1 ? 's' : ''}</strong> in this story will update immediately upon saving.</span>
        <button type="button" class="btn btn-secondary" onclick="markAllBlocksOfCharacter('${char.id}', true)" style="font-size: 11px; padding: 3px 8px; white-space: nowrap;" title="Protect all sentences from character auto-updates">🔒 Protect All as Custom</button>
      </div>
    `;
  } else {
    linkedInfo.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 6px;">
          <div>
            🔗 <strong>${syncableCount} sentence${syncableCount !== 1 ? 's' : ''}</strong> will update immediately.<br>
            <span style="color: #fbbf24;">🛡️ ${customCount} custom-edited sentence${customCount > 1 ? 's' : ''} currently preserved.</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn btn-secondary" onclick="markAllBlocksOfCharacter('${char.id}', false)" style="font-size: 11px; padding: 3px 8px;" title="Reset custom flags so all sentences sync with character">🔗 Make All Synced</button>
            <button type="button" class="btn btn-secondary" onclick="markAllBlocksOfCharacter('${char.id}', true)" style="font-size: 11px; padding: 3px 8px;" title="Mark all sentences as custom-edited">🔒 Protect All</button>
          </div>
        </div>
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; color: #fef08a; background: rgba(245, 158, 11, 0.12); border: 1px dashed rgba(245, 158, 11, 0.4); padding: 7px 10px; border-radius: 6px;">
          <input type="checkbox" id="char-modal-overwrite-custom" style="cursor: pointer; width: 16px; height: 16px; accent-color: #f59e0b;">
          <span>⚡ Overwrite custom-edited sentences (sync all ${linkedBlocks.length} to these settings)</span>
        </label>
      </div>
    `;
  }
  linkedInfo.style.display = "block";
}

function markAllBlocksOfCharacter(charId, isCustom) {
  if (!state.currentProject?.blocks) return;
  const char = getCharacterById(charId);
  if (!char) return;

  let count = 0;
  state.currentProject.blocks.forEach(b => {
    if (b.character_id === charId) {
      b.is_custom_edited = Boolean(isCustom);
      count++;
    }
  });

  debouncedSave();
  renderBlocks();
  renderInspector();
  updateCharModalLinkedInfo(char);

  if (isCustom) {
    showToast(`🔒 Marked ${count} sentence${count !== 1 ? 's' : ''} as Custom (protected from character auto-updates).`);
  } else {
    showToast(`🔗 Marked ${count} sentence${count !== 1 ? 's' : ''} as Synced (will update with character).`);
  }
}

function openEditCharacterModal(charId) {
  const char = getCharacterById(charId);
  if (!char) return;

  state.editingCharacterId = charId;
  const voiceObj = getVoiceById(char.voice_id);
  const charEngine = char.engine || voiceObj?.engine || (char.voice_id && char.voice_id.includes("Neural") ? "edge_tts" : (state.currentProject?.tier === "cinema_pro" ? "fish_s2" : "edge_tts"));
  state.editingCharModalEngine = charEngine;

  renderCharModalEngineSelector(charEngine);
  populateCharModalVoiceSelect(charEngine);

  const modal = document.getElementById("save-character-modal");
  const titleEl = document.getElementById("save-character-modal-title");
  const confirmBtn = document.getElementById("btn-save-character-confirm");
  const nameInput = document.getElementById("char-modal-name-input");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  const voiceSelect = document.getElementById("char-modal-voice-select");
  const linkedInfo = document.getElementById("char-modal-linked-info");

  if (titleEl) titleEl.textContent = `Edit Character: ${char.name}`;
  if (confirmBtn) confirmBtn.innerHTML = `💾 Save & Sync Character`;
  if (nameInput) {
    nameInput.value = char.name;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  if (voiceSelect) {
    voiceSelect.value = char.voice_id;
  }
  updateCharModalVoiceDetails(char.voice_id);

  // Sliders
  setCharModalSlider("char-slider-speed", "char-val-speed", Number(char.speed !== undefined ? char.speed : 0.90), v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", Number(char.pause_after !== undefined ? char.pause_after : 0.6), v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", Number(char.pitch_shift || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", Number(char.warmth || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", Number(char.clarity || 0.0), v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(Number(char.reverb || 0.0) * 100), v => `${v}%`);
  selectCharModalFilter(char.fx_filter || (char.radio_fx ? "radio" : "none"));

  renderCharModalPalette(char.color || "#6366f1");

  if (avatarPreview) {
    avatarPreview.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
  }

  // Linked Sentences Count calculation
  if (linkedInfo && state.currentProject?.blocks) {
    updateCharModalLinkedInfo(char);
  }

  if (modal) modal.classList.add("active");
}

function handleOpenSaveCharacterModal() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first to capture its voice & settings.");
    return;
  }

  state.editingCharacterId = null; // Create mode
  const activeEngine = activeBlock.engine || (state.currentProject?.tier === "cinema_pro" ? "fish_s2" : "edge_tts");
  state.editingCharModalEngine = activeEngine;

  renderCharModalEngineSelector(activeEngine);
  populateCharModalVoiceSelect(activeEngine);

  const modal = document.getElementById("save-character-modal");
  const titleEl = document.getElementById("save-character-modal-title");
  const confirmBtn = document.getElementById("btn-save-character-confirm");
  const nameInput = document.getElementById("char-modal-name-input");
  const avatarPreview = document.getElementById("char-modal-avatar-preview");
  const voiceSelect = document.getElementById("char-modal-voice-select");
  const linkedInfo = document.getElementById("char-modal-linked-info");

  if (titleEl) titleEl.textContent = "Save Character Voice";
  if (confirmBtn) confirmBtn.innerHTML = `💾 Save Character`;

  const existingCount = (state.savedCharacters?.length || 0) + 1;
  if (nameInput) {
    nameInput.value = `Character ${existingCount}`;
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  }

  if (voiceSelect && activeBlock.voice_id) {
    voiceSelect.value = activeBlock.voice_id;
  }
  updateCharModalVoiceDetails(activeBlock.voice_id);

  // Sliders
  const speed = activeBlock.speed !== undefined ? Number(activeBlock.speed) : 0.90;
  const pause = activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : 0.6;
  const pitch = Number(activeBlock.pitch_shift || 0.0);
  const warmth = Number(activeBlock.warmth || 0.0);
  const clarity = Number(activeBlock.clarity || 0.0);
  const reverb = Number(activeBlock.reverb || 0.0);
  const filter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();

  setCharModalSlider("char-slider-speed", "char-val-speed", speed, v => `${Number(v).toFixed(2)}x`);
  setCharModalSlider("char-slider-pause", "char-val-pause", pause, v => `${Number(v).toFixed(1)}s`);
  setCharModalSlider("char-slider-pitch", "char-val-pitch", pitch, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} st`);
  setCharModalSlider("char-slider-warmth", "char-val-warmth", warmth, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-clarity", "char-val-clarity", clarity, v => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`);
  setCharModalSlider("char-slider-reverb", "char-val-reverb", Math.round(reverb * 100), v => `${v}%`);
  selectCharModalFilter(filter);

  const voiceObj = getVoiceById(activeBlock.voice_id);
  renderCharModalPalette(voiceObj.color || "#6366f1");

  if (avatarPreview) {
    avatarPreview.textContent = `C${existingCount}`;
  }

  if (linkedInfo) {
    linkedInfo.style.display = "none";
  }

  if (modal) modal.classList.add("active");
}

function closeSaveCharacterModal() {
  const modal = document.getElementById("save-character-modal");
  if (modal) modal.classList.remove("active");
}

function confirmSaveCharacter() {
  const nameInput = document.getElementById("char-modal-name-input");
  const charName = (nameInput?.value || "").trim();
  if (!charName) {
    alert("Please enter a character name (e.g. 'Sarah', 'Detective Cole').");
    return;
  }

  const voiceSelect = document.getElementById("char-modal-voice-select");
  const voiceId = voiceSelect?.value || "blend_fenrir_onyx";
  const speed = parseFloat(document.getElementById("char-slider-speed")?.value || 0.90);
  const pause = parseFloat(document.getElementById("char-slider-pause")?.value || 0.6);
  const pitch = parseFloat(document.getElementById("char-slider-pitch")?.value || 0.0);
  const warmth = parseFloat(document.getElementById("char-slider-warmth")?.value || 0.0);
  const clarity = parseFloat(document.getElementById("char-slider-clarity")?.value || 0.0);
  const reverb = parseInt(document.getElementById("char-slider-reverb")?.value || 0, 10) / 100.0;
  const filter = state.charModalFxFilter || "none";
  const color = state.selectedCharacterColor || "#6366f1";
  const badge = charName.slice(0, 2).toUpperCase();

  if (state.editingCharacterId) {
    // Edit existing character
    const char = getCharacterById(state.editingCharacterId);
    if (!char) return;

    recordHistory(`Edit Character: ${charName}`);

    const voiceObj = getVoiceById(voiceId);
    char.name = charName;
    char.voice_id = voiceId;
    char.engine = state.editingCharModalEngine || voiceObj?.engine || (voiceId.includes("Neural") ? "edge_tts" : "fish_s2");
    char.speed = speed;
    char.pause_after = pause;
    char.pitch_shift = pitch;
    char.warmth = warmth;
    char.clarity = clarity;
    char.reverb = reverb;
    char.fx_filter = filter;
    char.radio_fx = (filter === "radio");
    char.color = color;
    char.badge = badge;

    if (voiceObj && voiceObj.blend_weights) {
      char.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    } else {
      delete char.blend_weights;
    }

    saveSavedCharactersToStorage();
    autoSyncToUniverseMasterCast();
    const overwriteCheckbox = document.getElementById("char-modal-overwrite-custom");
    const shouldOverwrite = Boolean(overwriteCheckbox && overwriteCheckbox.checked);
    const syncRes = syncCharacterToBlocks(char.id, shouldOverwrite);
    if (syncRes.renderedIndices && syncRes.renderedIndices.length > 0) {
      triggerInstantBlockDsp(syncRes.renderedIndices);
    }
    closeSaveCharacterModal();
    renderSavedCharactersList();
    renderStudio();

    let msg = `✓ Updated character "${char.name}"`;
    if (syncRes.updatedCount > 0) {
      msg += ` & synced ${syncRes.updatedCount} sentence${syncRes.updatedCount > 1 ? 's' : ''}`;
    }
    if (syncRes.skippedCustomCount > 0) {
      msg += ` (${syncRes.skippedCustomCount} custom-edited preserved)`;
    }
    showToast(msg + "!");
  } else {
    // Create new character
    const voiceObj = getVoiceById(voiceId);
    const newChar = {
      id: "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
      name: charName,
      voice_id: voiceId,
      engine: state.editingCharModalEngine || voiceObj?.engine || (voiceId.includes("Neural") ? "edge_tts" : "fish_s2"),
      speed: speed,
      gain: 1.0,
      pause_after: pause,
      pitch_shift: pitch,
      warmth: warmth,
      clarity: clarity,
      reverb: reverb,
      fx_filter: filter,
      radio_fx: (filter === "radio"),
      color: color,
      badge: badge
    };

    if (voiceObj && voiceObj.blend_weights) {
      newChar.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    }

    if (!state.savedCharacters) state.savedCharacters = [];
    state.savedCharacters.push(newChar);
    saveSavedCharactersToStorage();
    autoSyncToUniverseMasterCast();

    // Assign this character to active sentence if unassigned
    const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
      ? state.activeBlockIndex
      : 0;
    const activeBlock = state.currentProject.blocks[activeIdx];
    if (activeBlock && !activeBlock.character_id && activeBlock.type !== "heading") {
      activeBlock.character_id = newChar.id;
      activeBlock.speaker = newChar.name;
      activeBlock.engine = newChar.engine;
      activeBlock.voice_id = newChar.voice_id;
      activeBlock.is_custom_edited = false;
      renderStudio();
    }

    closeSaveCharacterModal();
    renderSavedCharactersList();
    showToast(`🎭 Saved Character "${newChar.name}"!`);
  }
}

function syncCharacterToBlocks(charId, overwriteCustom = false) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return { updatedCount: 0, skippedCustomCount: 0, renderedIndices: [] };

  let updatedCount = 0;
  let skippedCustomCount = 0;
  const renderedIndices = [];
  const chosenVoiceId = char.voice_id || char.assigned_voice_id || state.currentProject.default_voice;
  const voiceObj = getVoiceById(chosenVoiceId);

  state.currentProject.blocks.forEach((b, idx) => {
    if (b.character_id === charId || (!b.character_id && b.speaker && b.speaker.toLowerCase() === char.name.toLowerCase())) {
      if (b.is_custom_edited === true && !overwriteCustom) {
        skippedCustomCount++;
        return; // PRESERVE CUSTOM EDITED SENTENCES!
      }

      if (overwriteCustom) {
        b.is_custom_edited = false;
      }

      b.character_id = char.id;
      b.speaker = char.name;
      b.engine = char.engine || voiceObj?.engine || (chosenVoiceId && chosenVoiceId.includes("Neural") ? "edge_tts" : "fish_s2");
      b.voice_id = chosenVoiceId;
      b.reference_audio = char.reference_audio || voiceObj?.reference_audio || "";
      b.reference_text = char.reference_text || voiceObj?.reference_text || "";

      if (char.blend_weights || voiceObj?.blend_weights) {
        b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights || voiceObj.blend_weights));
      } else {
        delete b.blend_weights;
      }
      b.speed = char.speed;
      b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
      b.pitch_shift = Number(char.pitch_shift || 0.0);
      b.warmth = Number(char.warmth || 0.0);
      b.clarity = Number(char.clarity || 0.0);
      b.reverb = Number(char.reverb || 0.0);
      b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
      b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

      // CRITICAL: NEVER delete cachedAudioUrl or force re-render on character save!
      // Keep existing audio and update signature so the block stays Ready!
      if (b.cachedAudioUrl) {
        b.cachedSig = getBlockSignature(b);
        renderedIndices.push(idx);
      }

      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        if (b.cachedAudioUrl) {
          row.classList.add("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText && b.duration) timeText.textContent = `● ${b.duration.toFixed(1)}s`;
        }
        const avatar = row.querySelector(".block-avatar");
        if (avatar) {
          avatar.style.backgroundColor = char.color || (voiceObj && voiceObj.color) || "#6366f1";
          avatar.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
          if (overwriteCustom || !b.is_custom_edited) {
            const dot = avatar.querySelector(".custom-tweak-dot");
            if (dot) dot.remove();
          }
        }
        const charTag = row.querySelector(".block-character-tag");
        if (charTag) {
          charTag.style.backgroundColor = char.color || (voiceObj && voiceObj.color) || "#6366f1";
          charTag.textContent = `🎭 ${char.name}`;
        }
      }
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    debouncedSave();
  }
  return { updatedCount, skippedCustomCount, renderedIndices };
}

function applyCharacterToSelected(charId) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return;

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [state.activeBlockIndex || 0];

  const spokenTargets = targets.filter(idx => {
    const b = state.currentProject.blocks[idx];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (spokenTargets.length === 0) {
    showToast("ℹ️ Selected items contain no spoken sentences.");
    return;
  }

  recordHistory(`Apply Character: ${char.name}`);

  const chosenVoiceId = char.voice_id || char.assigned_voice_id || state.currentProject.default_voice;
  const voiceObj = getVoiceById(chosenVoiceId);

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    b.character_id = char.id;
    b.speaker = char.name;
    b.is_custom_edited = false;
    b.voice_id = chosenVoiceId;
    b.engine = char.engine || voiceObj?.engine || (chosenVoiceId && chosenVoiceId.includes("Neural") ? "edge_tts" : "fish_s2");
    b.reference_audio = char.reference_audio || voiceObj?.reference_audio || "";
    b.reference_text = char.reference_text || voiceObj?.reference_text || "";

    if (char.blend_weights || voiceObj?.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights || voiceObj.blend_weights));
    } else {
      delete b.blend_weights;
    }

    b.speed = char.speed;
    b.gain = char.gain !== undefined ? char.gain : 1.0;
    b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
    b.pitch_shift = Number(char.pitch_shift || 0.0);
    b.warmth = Number(char.warmth || 0.0);
    b.clarity = Number(char.clarity || 0.0);
    b.reverb = Number(char.reverb || 0.0);
    b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
    b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

    delete b.overridden_character_id;
    delete b.overridden_speaker;

    const row = document.querySelector(`[data-index="${idx}"]`);
    invalidateBlockAudio(b, row);
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateActiveCharacterStatusBanner();
  updateOverriddenCastButtonUI();
  updateSelectionUI();
  syncProjectAudioCache();
  showToast(`🎭 Assigned Character "${char.name}" to ${spokenTargets.length} sentence${spokenTargets.length > 1 ? 's' : ''}!`);
}

function updateCharacterWithCurrent(charId) {
  const char = getCharacterById(charId);
  if (!char || !state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  char.voice_id = activeBlock.voice_id || char.voice_id;
  if (activeBlock.engine) {
    char.engine = activeBlock.engine;
  }
  if (activeBlock.blend_weights) {
    char.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
  } else {
    delete char.blend_weights;
  }
  char.speed = activeBlock.speed !== undefined ? Number(activeBlock.speed) : char.speed;
  char.gain = activeBlock.gain !== undefined ? Number(activeBlock.gain) : char.gain;
  char.pause_after = activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : char.pause_after;
  char.pitch_shift = Number(activeBlock.pitch_shift || 0.0);
  char.warmth = Number(activeBlock.warmth || 0.0);
  char.clarity = Number(activeBlock.clarity || 0.0);
  char.reverb = Number(activeBlock.reverb || 0.0);
  char.fx_filter = activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none");
  char.radio_fx = Boolean(activeBlock.radio_fx || activeBlock.fx_filter === "radio");

  saveSavedCharactersToStorage();
  const syncRes = syncCharacterToBlocks(char.id);
  if (syncRes.renderedIndices && syncRes.renderedIndices.length > 0) {
    triggerInstantBlockDsp(syncRes.renderedIndices);
  }
  renderSavedCharactersList();
  renderStudio();

  let msg = `✓ Updated character "${char.name}"`;
  if (syncRes.updatedCount > 0) {
    msg += ` & synced to ${syncRes.updatedCount} sentence${syncRes.updatedCount > 1 ? 's' : ''}`;
  }
  if (syncRes.skippedCustomCount > 0) {
    msg += ` (${syncRes.skippedCustomCount} custom-edited preserved)`;
  }
  showToast(msg + "!");
}

function revertActiveBlockToCharacter() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const b = state.currentProject.blocks[activeIdx];
  if (!b || !b.character_id) return;

  const char = getCharacterById(b.character_id);
  if (!char) return;

  recordHistory(`Revert to Character: ${char.name}`);

  b.voice_id = char.voice_id;
  const charVoice = (typeof getVoiceById === "function") ? getVoiceById(char.voice_id) : null;
  b.engine = char.engine || charVoice?.engine || (
    char.voice_id?.includes("Neural") ? "edge_tts" :
    (char.voice_id?.startsWith("af_") || char.voice_id?.startsWith("am_") || char.voice_id?.startsWith("bf_") || char.voice_id?.startsWith("bm_")) ? "kokoro" :
    "fish_s2"
  );
  if (char.blend_weights) {
    b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
  } else {
    delete b.blend_weights;
  }
  b.speed = char.speed;
  b.gain = char.gain !== undefined ? char.gain : 1.0;
  b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
  b.pitch_shift = Number(char.pitch_shift || 0.0);
  b.warmth = Number(char.warmth || 0.0);
  b.clarity = Number(char.clarity || 0.0);
  b.reverb = Number(char.reverb || 0.0);
  b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
  b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");
  b.is_custom_edited = false;

  if (typeof invalidateBlockAudio === "function") {
    invalidateBlockAudio(b);
  } else {
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;
  }

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`↺ Reverted sentence to "${char.name}" character settings!`);
}

function makeActiveSentenceSyncedToCharacter() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock || activeBlock.type === "heading" || activeBlock.is_spoken === false) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const char = getCharacterById(activeBlock.character_id || activeBlock.speaker);
  if (!char) {
    toggleBlockCustomEdited(false);
    return;
  }

  recordHistory(`Make Synced: Update Character ${char.name} from Active Sentence`);

  // Pull settings from active sentence into character cast
  char.voice_id = activeBlock.voice_id || char.voice_id;
  if (activeBlock.engine) {
    char.engine = activeBlock.engine;
  }
  char.assigned_voice_id = char.voice_id;
  if (activeBlock.blend_weights) {
    char.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
  } else {
    delete char.blend_weights;
  }
  char.speed = activeBlock.speed !== undefined ? Number(activeBlock.speed) : char.speed;
  char.gain = activeBlock.gain !== undefined ? Number(activeBlock.gain) : char.gain;
  char.pause_after = activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : char.pause_after;
  char.pitch_shift = Number(activeBlock.pitch_shift || 0.0);
  char.warmth = Number(activeBlock.warmth || 0.0);
  char.clarity = Number(activeBlock.clarity || 0.0);
  char.reverb = Number(activeBlock.reverb || 0.0);
  char.fx_filter = activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none");
  char.radio_fx = Boolean(activeBlock.radio_fx || activeBlock.fx_filter === "radio");
  if (activeBlock.reference_audio) char.reference_audio = activeBlock.reference_audio;
  if (activeBlock.reference_text) char.reference_text = activeBlock.reference_text;

  // Active sentence is now synced
  activeBlock.is_custom_edited = false;

  // Save character changes to storage and master cast
  saveSavedCharactersToStorage();
  autoSyncToUniverseMasterCast();

  // Sync to all sentences of this character with overwriteCustom = true so all sentences of this cast update!
  const syncRes = syncCharacterToBlocks(char.id, true);
  if (syncRes.renderedIndices && syncRes.renderedIndices.length > 0) {
    triggerInstantBlockDsp(syncRes.renderedIndices);
  }

  renderSavedCharactersList();
  renderStudio();
  renderInspector();
  updateActiveCharacterStatusBanner();

  let msg = `🔗 Synced: Updated "${char.name}" and `;
  if (syncRes.updatedCount > 0) {
    msg += `${syncRes.updatedCount} sentence${syncRes.updatedCount > 1 ? 's' : ''} from active sentence`;
  } else {
    msg += `character settings from active sentence`;
  }
  showToast(msg + "!");
}

function updateActiveCharacterStatusBanner() {
  const banner = document.getElementById("inspector-character-link-banner");
  if (!banner) return;

  if (state.currentInspectorTab && state.currentInspectorTab !== "audio") {
    banner.style.display = "none";
    return;
  }

  if (!state.currentProject || !state.currentProject.blocks) {
    banner.style.display = "none";
    return;
  }

  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const block = state.currentProject.blocks[activeIdx];
  if (!block || block.type === "heading" || block.is_spoken === false || !block.character_id) {
    banner.style.display = "none";
    return;
  }

  const char = getCharacterById(block.character_id);
  if (!char) {
    banner.style.display = "none";
    return;
  }

  banner.className = "character-status-banner";
  banner.style.display = "flex";

  const isMulti = state.selectedBlockIndices && state.selectedBlockIndices.size > 1;
  const multiSuffix = isMulti ? ` (${state.selectedBlockIndices.size} selected)` : "";

  if (block.is_custom_edited) {
    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-main); min-width: 0;">
        <span style="font-size: 14px;">🎭</span>
        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Character: <strong>${escapeHtml(char.name)}</strong>${multiSuffix}</span>
        <span style="color: #f59e0b; font-weight: 600; font-size: 11px; background: rgba(245, 158, 11, 0.15); border-radius: 4px; padding: 1px 5px; white-space: nowrap;" title="This sentence has custom tone/pacing settings">Customized</span>
      </div>
      <div style="display: flex; gap: 5px; align-items: center; flex-shrink: 0;">
        <button type="button" class="btn btn-secondary" onclick="makeActiveSentenceSyncedToCharacter()" style="padding: 3px 8px; font-size: 11px; white-space: nowrap;" title="Update character settings to match this sentence, and sync all sentences of ${escapeHtml(char.name)}">🔗 Make Synced</button>
        <button type="button" class="btn btn-secondary" onclick="revertActiveBlockToCharacter()" style="padding: 3px 8px; font-size: 11px; white-space: nowrap;" title="Revert audio sliders back to original character defaults">↺ Revert</button>
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-main); min-width: 0;">
        <span style="font-size: 14px;">🎭</span>
        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Character: <strong>${escapeHtml(char.name)}</strong>${multiSuffix}</span>
        <span style="color: #10b981; font-weight: 600; font-size: 11px; background: rgba(16, 185, 129, 0.15); border-radius: 4px; padding: 1px 5px; white-space: nowrap;" title="This sentence stays in sync with character settings">Synced</span>
      </div>
      <div style="display: flex; gap: 5px; align-items: center; flex-shrink: 0;">
        <button type="button" class="btn btn-secondary" onclick="toggleBlockCustomEdited(true)" style="padding: 3px 8px; font-size: 11px; white-space: nowrap;" title="Change status: mark as Custom to protect this sentence from character updates">🔒 Make Custom</button>
        <button type="button" class="btn btn-secondary" onclick="openEditCharacterModal('${char.id}')" style="padding: 3px 8px; font-size: 11px;" title="Edit this character's voice & settings">✏️ Edit</button>
      </div>
    `;
  }
}

function toggleBlockCustomEdited(forceIsCustom) {
  if (!state.currentProject || !state.currentProject.blocks) return;

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [(typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0) ? state.activeBlockIndex : 0];

  const validTargets = targets.filter(i => {
    const b = state.currentProject.blocks[i];
    return b && b.type !== "heading" && b.is_spoken !== false;
  });

  if (validTargets.length === 0) {
    showToast("⚠️ Select a spoken sentence block first.");
    return;
  }

  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0) ? state.activeBlockIndex : validTargets[0];
  const activeBlock = state.currentProject.blocks[activeIdx];

  const nextIsCustom = (typeof forceIsCustom === "boolean")
    ? forceIsCustom
    : (activeBlock ? !activeBlock.is_custom_edited : false);

  recordHistory(nextIsCustom ? "Mark Sentence(s) as Custom" : "Mark Sentence(s) as Synced");

  validTargets.forEach(i => {
    const b = state.currentProject.blocks[i];
    b.is_custom_edited = nextIsCustom;
  });

  debouncedSave();
  renderBlocks();
  renderInspector();
  updateActiveCharacterStatusBanner();

  if (validTargets.length === 1) {
    showToast(nextIsCustom
      ? "🔒 Sentence marked as Custom (protected from character auto-updates)."
      : "🔗 Sentence marked as Synced (will update when character is saved).");
  } else {
    showToast(nextIsCustom
      ? `🔒 ${validTargets.length} sentences marked as Custom.`
      : `🔗 ${validTargets.length} sentences marked as Synced.`);
  }
}

function renameCharacter(charId) {
  const char = getCharacterById(charId);
  if (!char) return;
  const newName = prompt(`Enter new name for character "${char.name}":`, char.name);
  if (newName && newName.trim() && newName.trim() !== char.name) {
    char.name = newName.trim();
    char.badge = char.name.slice(0, 2).toUpperCase();
    saveSavedCharactersToStorage();
    autoSyncToUniverseMasterCast();
    renderSavedCharactersList();
    renderStudio();
    showToast(`✓ Renamed to "${char.name}"`);
  }
}

let pendingDeleteCharId = null;

function deleteCharacter(charId) {
  const char = getCharacterById(charId);
  if (!char) return;

  const isSeriesChapter = Boolean(state.currentProject?.folder_id || state.currentProject?.parent_series_id);

  if (isSeriesChapter) {
    // Open the Remove Character Modal
    pendingDeleteCharId = charId;
    const modal = document.getElementById("remove-character-modal");
    if (!modal) {
      if (confirm(`Remove character "${char.name}" from this chapter?`)) {
        removeCharFromCurrentChapter(charId);
      }
      return;
    }

    const titleEl = document.getElementById("remove-char-modal-title");
    const nameEl = document.getElementById("remove-char-name");
    const voiceEl = document.getElementById("remove-char-voice");
    const avatarEl = document.getElementById("remove-char-avatar");
    const usageEl = document.getElementById("remove-char-usage");
    const seriesEl = document.getElementById("remove-char-series-name");

    if (titleEl) titleEl.textContent = `Remove Character — ${char.name}`;
    if (nameEl) nameEl.textContent = char.name;
    if (avatarEl) {
      avatarEl.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
      avatarEl.style.backgroundColor = char.color || "#6366f1";
    }
    const voiceObj = getVoiceById(char.voice_id);
    if (voiceEl) voiceEl.textContent = voiceObj ? `${voiceObj.name} • ${voiceObj.sub || voiceObj.gender || ''}` : char.voice_id;

    // Count usage in current chapter
    const usageCount = (state.blocks || []).filter(b => b.assigned_character_id === charId || b.character_id === charId).length;
    if (usageEl) {
      usageEl.textContent = usageCount > 0 
        ? `Assigned to ${usageCount} sentence${usageCount === 1 ? '' : 's'} in this chapter` 
        : `Not assigned to any sentences in this chapter`;
    }

    if (seriesEl) {
      const folder = (state.folders || []).find(f => f.id === state.currentProject.folder_id);
      seriesEl.textContent = folder ? folder.title : "Series Collection";
    }

    modal.style.display = "flex";
  } else {
    // Standalone project: standard confirm
    if (confirm(`Delete character "${char.name}" from this story project?`)) {
      removeCharFromCurrentChapter(charId);
      showToast(`🗑️ Deleted character "${char.name}".`);
    }
  }
}

function closeRemoveCharacterModal() {
  const modal = document.getElementById("remove-character-modal");
  if (modal) modal.style.display = "none";
  pendingDeleteCharId = null;
}

function executeRemoveCharacterFromChapterOnly() {
  if (!pendingDeleteCharId) return;
  const char = getCharacterById(pendingDeleteCharId);
  const charName = char ? char.name : "Character";

  removeCharFromCurrentChapter(pendingDeleteCharId);
  closeRemoveCharacterModal();
  showToast(`✓ Removed "${charName}" from this chapter (preserved in Series Master Cast).`);
}

async function executeDeleteCharacterFromEntireSeries() {
  if (!pendingDeleteCharId) return;
  const char = getCharacterById(pendingDeleteCharId);
  const charName = char ? char.name : "Character";
  const folderId = state.currentProject?.folder_id;

  removeCharFromCurrentChapter(pendingDeleteCharId);

  if (folderId) {
    try {
      await fetch("/api/folder/master_cast/remove_character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder_id: folderId,
          char_id: pendingDeleteCharId,
          char_name: charName,
          remove_from_chapters: true
        })
      });
    } catch (e) {
      console.warn("Failed to delete character from master cast:", e);
    }
  }

  closeRemoveCharacterModal();
  showToast(`🗑️ Deleted "${charName}" from Entire Series & Unified Cast.`);
}

function removeCharFromCurrentChapter(charId) {
  state.savedCharacters = (state.savedCharacters || []).filter(c => c.id !== charId);
  saveSavedCharactersToStorage();
  renderSavedCharactersList();
  renderStudio();
}

// ---------------- UNIFIED UNIVERSE MASTER CAST AUTO-SYNC ---------------- //

async function autoSyncToUniverseMasterCast() {
  if (!state.currentProject?.folder_id || !Array.isArray(state.savedCharacters)) return;
  try {
    await fetch("/api/folder/master_cast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: state.currentProject.folder_id,
        characters: state.savedCharacters,
        mode: "merge"
      })
    });
  } catch(e) {
    console.warn("Auto-sync to universe master cast error:", e);
  }
}

// ---------------- IMPORT CAST MODAL (COLLECTION OR STANDALONE) ---------------- //

let currentImportSourceType = "collection"; // "collection" or "standalone"
let pendingImportCharacters = [];
let pendingImportSourceTitle = "";

async function handleOpenImportCastModal() {
  const modal = document.getElementById("import-cast-modal");
  if (!modal) return;

  if (!state.currentProject) {
    showToast("⚠️ Open a story project first to import a character cast.");
    return;
  }

  try {
    const [projRes, folderRes] = await Promise.all([
      fetch(`/api/projects?engine=fish_s2&t=${Date.now()}`),
      fetch(`/api/folders?engine=fish_s2&include_all=1&t=${Date.now()}`).catch(() => null)
    ]);
    if (projRes && projRes.ok) state.projects = await projRes.json();
    if (folderRes && folderRes.ok) state.folders = await folderRes.json();
  } catch (e) {}

  // Default to collection if we have folders, otherwise standalone
  const hasFolders = Boolean(state.folders && state.folders.length > 0);
  currentImportSourceType = hasFolders ? "collection" : "standalone";

  const radCol = document.getElementById("import-source-type-collection");
  const radStand = document.getElementById("import-source-type-standalone");
  if (radCol) radCol.checked = (currentImportSourceType === "collection");
  if (radStand) radStand.checked = (currentImportSourceType === "standalone");

  modal.style.display = "flex";
  handleImportSourceTypeChange(currentImportSourceType);
}

function closeImportCastModal() {
  const modal = document.getElementById("import-cast-modal");
  if (modal) modal.style.display = "none";
}

function handleImportSourceTypeChange(sourceType) {
  currentImportSourceType = sourceType || "collection";

  const lblCol = document.getElementById("lbl-import-source-collection");
  const lblStand = document.getElementById("lbl-import-source-standalone");
  if (lblCol && lblStand) {
    if (currentImportSourceType === "collection") {
      lblCol.style.borderColor = "#8b5cf6";
      lblCol.style.background = "rgba(139, 92, 246, 0.12)";
      lblStand.style.borderColor = "var(--border-color)";
      lblStand.style.background = "rgba(255, 255, 255, 0.03)";
    } else {
      lblStand.style.borderColor = "#8b5cf6";
      lblStand.style.background = "rgba(139, 92, 246, 0.12)";
      lblCol.style.borderColor = "var(--border-color)";
      lblCol.style.background = "rgba(255, 255, 255, 0.03)";
    }
  }

  const selectLabel = document.getElementById("import-source-select-label");
  const select = document.getElementById("import-cast-source-select");
  if (!select) return;
  select.innerHTML = "";

  if (currentImportSourceType === "collection") {
    if (selectLabel) selectLabel.textContent = "Select Series / Book Collection";
    const rawFolders = (state.folders || []).filter(f => !f.parent_id);
    if (rawFolders.length === 0) {
      select.innerHTML = `<option value="">No series collections found</option>`;
      renderImportCastPreview([]);
      return;
    }
    // Deduplicate by clean title: keep the folder with characters or more chapters
    const uniqueMap = new Map();
    rawFolders.forEach(f => {
      const titleKey = (f.title || "").trim().toLowerCase();
      const charCount = (f.characters?.length || f.master_cast?.length || f.character_count || 0);
      const chCount = f.chapter_count || f.chapter_order?.length || 0;
      if (!uniqueMap.has(titleKey)) {
        uniqueMap.set(titleKey, f);
      } else {
        const existing = uniqueMap.get(titleKey);
        const existingChars = (existing.characters?.length || existing.master_cast?.length || existing.character_count || 0);
        if (charCount > existingChars || (charCount === existingChars && chCount > (existing.chapter_count || 0))) {
          uniqueMap.set(titleKey, f);
        }
      }
    });

    const dedupedFolders = Array.from(uniqueMap.values());
    dedupedFolders.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.id;
      const charList = (Array.isArray(f.characters) && f.characters.length > 0)
        ? f.characters
        : (Array.isArray(f.master_cast) ? f.master_cast : []);
      const count = charList.length || f.character_count || 0;
      const chCount = f.chapter_count || f.chapter_order?.length || 0;
      opt.textContent = `${f.title} (${count} character${count === 1 ? '' : 's'}${chCount ? ` · ${chCount} ch.` : ''})`;
      select.appendChild(opt);
    });
  } else {
    if (selectLabel) selectLabel.textContent = "Select Standalone Story Project";
    // Collect all series chapter IDs to guarantee series chapters never appear as standalone
    const allSeriesChapterIds = new Set();
    (state.folders || []).forEach(f => {
      (f.chapter_order || []).forEach(id => allSeriesChapterIds.add(id));
      (f.subfolders || []).forEach(s => (s.chapter_order || []).forEach(id => allSeriesChapterIds.add(id)));
    });

    // ONLY true standalone projects: not inside any folder/series
    const standaloneProjects = (state.projects || []).filter(p => 
      p.id !== state.currentProject?.id &&
      !p.folder_id &&
      !p.parent_series_id &&
      !allSeriesChapterIds.has(p.id) &&
      p.id !== "kaggle_session" &&
      !p.is_stub
    );
    if (standaloneProjects.length === 0) {
      select.innerHTML = `<option value="">No standalone story projects found</option>`;
      renderImportCastPreview([]);
      return;
    }
    standaloneProjects.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      const count = (Array.isArray(p.characters) ? p.characters.length : (p.character_count || 0));
      opt.textContent = `${p.title} (${count} character${count === 1 ? '' : 's'})`;
      select.appendChild(opt);
    });
  }

  handleImportSourceProjectChange();
}

async function handleImportSourceProjectChange() {
  const select = document.getElementById("import-cast-source-select");
  const sourceId = select ? select.value : null;
  if (!sourceId) {
    renderImportCastPreview([]);
    return;
  }

  if (currentImportSourceType === "collection") {
    try {
      const res = await fetch(`/api/folder?id=${encodeURIComponent(sourceId)}&t=${Date.now()}`);
      if (!res.ok) throw new Error("Could not fetch folder");
      const data = await res.json();
      const folder = data.folder || data;
      pendingImportSourceTitle = folder.title || "Series Collection";
      const charList = (Array.isArray(folder.characters) && folder.characters.length > 0)
        ? folder.characters
        : (Array.isArray(folder.master_cast) ? folder.master_cast : []);
      pendingImportCharacters = charList;
      renderImportCastPreview(pendingImportCharacters);
    } catch (err) {
      console.warn("Could not load collection characters for preview:", err);
      pendingImportCharacters = [];
      renderImportCastPreview([]);
    }
  } else {
    try {
      const res = await fetch(`/api/project?id=${encodeURIComponent(sourceId)}&t=${Date.now()}`);
      if (!res.ok) throw new Error("Could not fetch project");
      const projData = await res.json();
      pendingImportSourceTitle = projData.title || "Project";
      let chars = Array.isArray(projData.characters) ? projData.characters : [];

      if (chars.length === 0) {
        try {
          const rawLocal = localStorage.getItem(`kss_chars_${sourceId}`);
          if (rawLocal) {
            const parsed = JSON.parse(rawLocal);
            if (Array.isArray(parsed)) chars = parsed;
          }
        } catch (e) {}
      }

      pendingImportCharacters = chars;
      renderImportCastPreview(chars);
    } catch (err) {
      console.warn("Could not load project characters for preview:", err);
      pendingImportCharacters = [];
      renderImportCastPreview([]);
    }
  }
}

function renderImportCastPreview(chars) {
  const listEl = document.getElementById("import-cast-preview-list");
  const confirmBtn = document.getElementById("btn-confirm-import-cast");
  if (!listEl) return;

  listEl.innerHTML = "";
  if (!chars || chars.length === 0) {
    listEl.innerHTML = `<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 16px;">This source has no saved character voices.</div>`;
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }

  if (confirmBtn) confirmBtn.disabled = false;

  chars.forEach((c, idx) => {
    const row = document.createElement("label");
    row.style.cssText = "display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 7px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; border: 1px solid rgba(255,255,255,0.07); cursor: pointer; transition: all 0.15s ease;";
    const badge = c.badge || (c.name ? c.name.slice(0, 2).toUpperCase() : "CH");
    const filterTag = (c.fx_filter && c.fx_filter !== "none") ? ` [${c.fx_filter.toUpperCase()}]` : "";
    const voiceObj = getVoiceById(c.voice_id);
    const personaSnippet = c.persona ? ` • ${c.persona.slice(0, 45)}${c.persona.length > 45 ? '...' : ''}` : '';

    row.innerHTML = `
      <input type="checkbox" class="import-char-checkbox" data-index="${idx}" data-char-id="${c.id}" checked style="accent-color: #8b5cf6; width: 16px; height: 16px; cursor: pointer; flex-shrink: 0;">
      <div style="background-color: ${c.color || '#6366f1'}; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; color: #fff; flex-shrink: 0;">
        ${escapeHtml(badge)}
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 600; font-size: 12px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(c.name)}</div>
        <div style="color: var(--text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          🎙️ ${escapeHtml(voiceObj.name)}${filterTag}<span style="opacity: 0.75;">${escapeHtml(personaSnippet)}</span>
        </div>
      </div>
    `;
    listEl.appendChild(row);
  });
}

function toggleAllImportCastCheckboxes(checked) {
  const checkboxes = document.querySelectorAll(".import-char-checkbox");
  checkboxes.forEach(cb => { cb.checked = Boolean(checked); });
}

function confirmImportCast() {
  const checkboxes = document.querySelectorAll(".import-char-checkbox:checked");
  if (checkboxes.length === 0) {
    showToast("⚠️ Please select at least one character to import.");
    return;
  }

  const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index, 10));
  const selectedChars = selectedIndices.map(i => pendingImportCharacters[i]).filter(Boolean);

  const mode = document.querySelector('input[name="import-cast-mode"]:checked')?.value || "append";

  if (!state.savedCharacters) state.savedCharacters = [];

  if (mode === "replace") {
    state.savedCharacters = JSON.parse(JSON.stringify(selectedChars));
  } else {
    const existingIds = new Set(state.savedCharacters.map(c => c.id));
    const existingNames = new Set(state.savedCharacters.map(c => (c.name || "").toLowerCase()));
    selectedChars.forEach(c => {
      const cloned = JSON.parse(JSON.stringify(c));
      if (existingIds.has(cloned.id) || existingNames.has((cloned.name || "").toLowerCase())) {
        cloned.id = "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000);
      }
      state.savedCharacters.push(cloned);
      existingIds.add(cloned.id);
      existingNames.add((cloned.name || "").toLowerCase());
    });
  }

  saveSavedCharactersToStorage();
  autoSyncToUniverseMasterCast();
  renderSavedCharactersList();
  renderStudio();
  closeImportCastModal();
  showToast(`🎭 Imported ${selectedChars.length} character(s) from "${pendingImportSourceTitle}"!`);
}

window.autoSyncToUniverseMasterCast = autoSyncToUniverseMasterCast;
window.handleOpenImportCastModal = handleOpenImportCastModal;
window.closeImportCastModal = closeImportCastModal;
window.handleImportSourceTypeChange = handleImportSourceTypeChange;
window.handleImportSourceProjectChange = handleImportSourceProjectChange;
window.toggleAllImportCastCheckboxes = toggleAllImportCastCheckboxes;
window.confirmImportCast = confirmImportCast;

function getProjectDefaultSettings() {
  let savedLocal = null;
  try {
    const raw = localStorage.getItem("kss_default_sentence_settings");
    if (raw) savedLocal = JSON.parse(raw);
  } catch (e) {}

  const p = state.currentProject || {};
  const projDefs = p.default_settings || {};

  return {
    voice_id: projDefs.voice_id || p.default_voice || savedLocal?.voice_id || "blend_fenrir_onyx",
    speed: projDefs.speed !== undefined ? Number(projDefs.speed) : (p.default_speed !== undefined ? Number(p.default_speed) : (savedLocal?.speed !== undefined ? Number(savedLocal.speed) : 0.90)),
    gain: projDefs.gain !== undefined ? Number(projDefs.gain) : (p.default_gain !== undefined ? Number(p.default_gain) : (savedLocal?.gain !== undefined ? Number(savedLocal.gain) : 1.0)),
    pause_after: projDefs.pause_after !== undefined ? Number(projDefs.pause_after) : (p.default_pause !== undefined ? Number(p.default_pause) : (savedLocal?.pause_after !== undefined ? Number(savedLocal.pause_after) : 0.6)),
    pitch_shift: projDefs.pitch_shift !== undefined ? Number(projDefs.pitch_shift) : (p.default_pitch !== undefined ? Number(p.default_pitch) : (savedLocal?.pitch_shift !== undefined ? Number(savedLocal.pitch_shift) : 0.0)),
    warmth: projDefs.warmth !== undefined ? Number(projDefs.warmth) : (p.default_warmth !== undefined ? Number(p.default_warmth) : (savedLocal?.warmth !== undefined ? Number(savedLocal.warmth) : 0.0)),
    clarity: projDefs.clarity !== undefined ? Number(projDefs.clarity) : (p.default_clarity !== undefined ? Number(p.default_clarity) : (savedLocal?.clarity !== undefined ? Number(savedLocal.clarity) : 0.0)),
    reverb: projDefs.reverb !== undefined ? Number(projDefs.reverb) : (p.default_reverb !== undefined ? Number(p.default_reverb) : (savedLocal?.reverb !== undefined ? Number(savedLocal.reverb) : 0.0)),
    fx_filter: (projDefs.fx_filter || p.default_filter || savedLocal?.fx_filter || "none").toLowerCase(),
    radio_fx: projDefs.radio_fx !== undefined ? Boolean(projDefs.radio_fx) : (savedLocal?.radio_fx !== undefined ? Boolean(savedLocal.radio_fx) : false),
    blend_weights: projDefs.blend_weights || savedLocal?.blend_weights || undefined
  };
}

function handleSetCurrentAsDefault() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const currentFilter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();
  const currentDefaults = {
    speed: activeBlock.speed !== undefined ? Number(activeBlock.speed) : 0.90,
    gain: activeBlock.gain !== undefined ? Number(activeBlock.gain) : 1.0,
    pause_after: activeBlock.pause_after !== undefined ? Number(activeBlock.pause_after) : 0.6,
    pitch_shift: Number(activeBlock.pitch_shift || 0.0),
    warmth: Number(activeBlock.warmth || 0.0),
    clarity: Number(activeBlock.clarity || 0.0),
    reverb: Number(activeBlock.reverb || 0.0),
    radio_fx: (currentFilter === "radio"),
    fx_filter: currentFilter,
    voice_id: activeBlock.voice_id || state.currentProject.default_voice || "blend_fenrir_onyx",
    blend_weights: activeBlock.blend_weights ? JSON.parse(JSON.stringify(activeBlock.blend_weights)) : undefined
  };

  // 1. Store on state.currentProject
  state.currentProject.default_settings = currentDefaults;
  state.currentProject.default_voice = currentDefaults.voice_id;
  state.currentProject.default_speed = currentDefaults.speed;
  state.currentProject.default_gain = currentDefaults.gain;
  state.currentProject.default_pause = currentDefaults.pause_after;
  state.currentProject.default_pitch = currentDefaults.pitch_shift;
  state.currentProject.default_warmth = currentDefaults.warmth;
  state.currentProject.default_clarity = currentDefaults.clarity;
  state.currentProject.default_reverb = currentDefaults.reverb;
  state.currentProject.default_filter = currentDefaults.fx_filter;

  // 2. Persist in localStorage across projects
  try {
    localStorage.setItem("kss_default_sentence_settings", JSON.stringify(currentDefaults));
  } catch (e) {
    console.warn("Could not save defaults to localStorage:", e);
  }

  // 3. Save to server
  debouncedSave();

  // 4. Temporary button feedback
  const btn1 = document.getElementById("btn-set-default-settings");
  const btn2 = document.getElementById("btn-set-default-settings-bulk");
  [btn1, btn2].forEach(btn => {
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = `✓ Defaults Saved!`;
      btn.style.borderColor = "var(--primary)";
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.style.borderColor = "";
      }, 1800);
    }
  });

  // 5. Toast notification
  const voiceObj = getVoiceById(currentDefaults.voice_id);
  const filterLabel = currentDefaults.fx_filter === "none" ? "Clean Studio" : currentDefaults.fx_filter.toUpperCase();
  showToast(`⭐ Defaults saved! New sentences will use: ${currentDefaults.speed.toFixed(2)}x speed, ${Math.round(currentDefaults.gain * 100)}% vol, ${currentDefaults.pause_after.toFixed(1)}s pause, voice: "${voiceObj.name}", filter: ${filterLabel}.`);
}

function handleSelectAudioFilter(filterName) {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : (state.selectedBlockIndices && state.selectedBlockIndices.size > 0 ? Array.from(state.selectedBlockIndices)[0] : 0);
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const curFilter = (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")).toLowerCase();
  // Toggle off if clicking the already active filter (unless selecting 'none')
  const targetFilter = (curFilter === filterName && filterName !== "none") ? "none" : filterName;

  recordHistory(`Acoustic Filter: ${targetFilter === "none" ? "Clean Studio" : targetFilter.toUpperCase()}`);

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([activeIdx]);

  targets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.fx_filter = targetFilter;
    b.radio_fx = (targetFilter === "radio");
    if (b.character_id) {
      b.is_custom_edited = true;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
    }
  });

  renderInspector();
  renderTimeline();
  debouncedSave();
  updateActiveCharacterStatusBanner();

  const labels = {
    "none": "Clean Studio",
    "radio": "Radio Transceiver Filter",
    "whisper": "Soft Whisper Filter",
    "scream": "Intense Scream Filter",
    "demon": "Deep Demon Filter",
    "youth": "Child / Youth Filter"
  };
  showToast(`✨ Acoustic Filter: ${labels[targetFilter] || targetFilter} (${targets.size} sentence${targets.size > 1 ? "s" : ""})`);
}

function handleToggleRadioFx() {
  handleSelectAudioFilter("radio");
}

async function handleAutoDirectStory() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ No sentences to direct.");
    return;
  }

  const btn = document.getElementById("btn-auto-direct");
  if (btn) {
    btn.textContent = "⏳ Directing...";
    btn.disabled = true;
  }

  showToast("🎭 Auto-analyzing story dialogues, character attribution, whispers, and tension...");

  try {
    const res = await fetch("/api/auto_direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        default_voice: state.currentProject.default_voice || "blend_fenrir_onyx",
        expand_dialogue: true,
        defaults: getProjectDefaultSettings()
      })
    });

    const directedBlocks = await res.json();
    if (!Array.isArray(directedBlocks) || directedBlocks.length === 0) {
      showToast("⚠️ No changes made to story blocks.");
      return;
    }

    recordHistory("Auto-Direct Story");

    let modifiedCount = 0;
    const oldBlocks = state.currentProject.blocks;

    // Check how many blocks changed in voice, speed, gain, or pause
    directedBlocks.forEach((b, idx) => {
      const oldB = oldBlocks[idx];
      if (!oldB || oldB.voice_id !== b.voice_id || oldB.speed !== b.speed || oldB.gain !== b.gain || oldB.pause_after !== b.pause_after) {
        modifiedCount++;
        delete b.cachedAudioUrl;
        delete b.cachedSig;
      }
    });

    state.currentProject.blocks = directedBlocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;

    renderStudio();
    debouncedSave();
    showToast(`🎭 Auto-directed! Cast character roles, whispers & tension across ${directedBlocks.length} sentences (${modifiedCount} updated).`);
  } catch (err) {
    console.error("Auto-direct error:", err);
    showToast("❌ Auto-direct error: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = "🎭 Auto-Direct Story";
      btn.disabled = false;
    }
  }
}

// ----------------- AI SCRIPT DIRECTOR (LLM) ----------------- //
let activeAIProvider = "gemini";
window._aiDirectedBlocks = null;

function handleAIDirectorModeChange(mode) {
  const isSingle = (mode === "single" || mode === "solo");
  const lblMulti = document.getElementById("lbl-ai-mode-multi");
  const lblSingle = document.getElementById("lbl-ai-mode-single");
  const radMulti = document.getElementById("ai-director-mode-multi");
  const radSingle = document.getElementById("ai-director-mode-single");
  const optCast = document.getElementById("ai-opt-cast");

  if (radMulti) radMulti.checked = !isSingle;
  if (radSingle) radSingle.checked = isSingle;

  if (lblMulti && lblSingle) {
    if (isSingle) {
      lblSingle.style.background = "rgba(139, 92, 246, 0.12)";
      lblSingle.style.borderColor = "#8b5cf6";
      lblSingle.style.borderWidth = "1.5px";
      lblMulti.style.background = "rgba(255, 255, 255, 0.03)";
      lblMulti.style.borderColor = "var(--border-color)";
      lblMulti.style.borderWidth = "1px";
    } else {
      lblMulti.style.background = "rgba(139, 92, 246, 0.12)";
      lblMulti.style.borderColor = "#8b5cf6";
      lblMulti.style.borderWidth = "1.5px";
      lblSingle.style.background = "rgba(255, 255, 255, 0.03)";
      lblSingle.style.borderColor = "var(--border-color)";
      lblSingle.style.borderWidth = "1px";
    }
  }

  if (optCast) {
    optCast.checked = !isSingle;
    optCast.disabled = isSingle;
    const parentSpan = optCast.parentElement ? optCast.parentElement.querySelector("span") : null;
    if (parentSpan) {
      parentSpan.textContent = isSingle ? "Solo voice (No multi-cast mapping)" : "Auto-cast voices from Library";
      parentSpan.style.color = isSingle ? "var(--text-muted)" : "#e2e8f0";
    }
  }
}
window.handleAIDirectorModeChange = handleAIDirectorModeChange;

async function openAIDirectorModal(focusKey = false) {
  const modal = document.getElementById("ai-director-modal");
  if (!modal) return;

  const resBox = document.getElementById("ai-director-results");
  if (resBox) resBox.style.display = "none";
  window._aiDirectedBlocks = null;

  modal.style.display = "flex";

  const currentMode = state.currentProject?.production_mode || "multi";
  handleAIDirectorModeChange(currentMode);

  const hasProject = Boolean(state.currentProject && state.currentProject.blocks && state.currentProject.blocks.length > 0);
  const runBtn = document.getElementById("btn-run-ai-director");
  const tipEl = document.getElementById("ai-project-status-tip");

  if (runBtn) {
    if (hasProject) {
      runBtn.innerHTML = `<span>🚀 Run AI Script Director</span>`;
    } else {
      runBtn.innerHTML = `<span>💾 Save Director Settings</span>`;
    }
  }

  if (tipEl) {
    if (hasProject) {
      tipEl.innerHTML = `<span>Story active: <strong>${escapeHtml(state.currentProject.title)}</strong> (${state.currentProject.blocks.length} blocks)</span>`;
      tipEl.style.color = "#10b981";
    } else {
      tipEl.innerHTML = `<span>💡 Tip: Open any project or import an EPUB chapter to auto-direct the script with AI.</span>`;
      tipEl.style.color = "var(--text-muted)";
    }
  }

  try {
    const res = await fetch("/api/ai_director/config");
    const cfg = await res.json();
    if (cfg && cfg.default_provider) {
      switchAIDirectorProvider(cfg.default_provider);
    } else {
      switchAIDirectorProvider("gemini");
    }
    const keyStatus = document.getElementById("ai-key-status");
    if (keyStatus) {
      if (cfg.gemini_key_is_fish) {
        keyStatus.style.display = "block";
        keyStatus.style.color = "#f59e0b";
        keyStatus.innerHTML = `⚠️ Fish Audio key detected in Gemini field! Please enter a valid <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color: #60a5fa; text-decoration: underline;">Google Gemini key</a> starting with <code>AIzaSy</code>.`;
      } else if (cfg.gemini_has_key && activeAIProvider === "gemini") {
        keyStatus.style.display = "block";
        keyStatus.style.color = "#10b981";
        keyStatus.textContent = `✓ Active Key configured (${cfg.gemini_masked_key})`;
      } else {
        keyStatus.style.display = "none";
      }
    }
  } catch (e) {
    switchAIDirectorProvider("gemini");
  }

  if (focusKey) {
    setTimeout(() => {
      const input = document.getElementById("ai-director-api-key");
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        input.style.borderColor = "#8b5cf6";
        input.style.boxShadow = "0 0 12px rgba(139, 92, 246, 0.6)";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
      }
    }, 120);
  }
}

async function handleVerifyAISaveKey() {
  const btn = document.getElementById("btn-verify-ai-key");
  const keyInput = document.getElementById("ai-director-api-key");
  const modelSelect = document.getElementById("ai-director-model-select");
  const statusEl = document.getElementById("ai-key-status");

  const apiKey = (keyInput ? keyInput.value : "").trim();
  const model = modelSelect ? modelSelect.value : "";

  if (activeAIProvider === "gemini" && apiKey.startsWith("sk-fish-")) {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.style.color = "#ef4444";
      statusEl.innerHTML = `⚠️ That is a <strong>Fish Audio API key</strong> (starts with <code>sk-fish-</code>). Google Gemini requires a Google Gemini key starting with <code>AIzaSy...</code> (free from <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color: #60a5fa; text-decoration: underline;">Google AI Studio</a>).`;
    }
    showToast("⚠️ You entered a Fish Audio key for Google Gemini. Please use a Gemini key starting with AIzaSy.", 5000);
    return;
  }

  if (!apiKey && activeAIProvider !== "ollama") {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.style.color = "#ef4444";
      statusEl.textContent = `⚠️ Please paste a valid ${activeAIProvider.toUpperCase()} API key first.`;
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Verifying...";
  }

  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.style.color = "#60a5fa";
    statusEl.textContent = `Connecting to ${activeAIProvider.toUpperCase()}...`;
  }

  try {
    const res = await fetch("/api/ai_director/test_key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: activeAIProvider,
        api_key: apiKey,
        model: model,
        save_key: true
      })
    });
    const data = await res.json();

    if (data.ok) {
      if (statusEl) {
        statusEl.style.color = "#10b981";
        statusEl.textContent = `✓ ${data.message || 'Key verified and saved successfully!'}`;
      }
      showToast(`✓ ${activeAIProvider.toUpperCase()} API Key verified and saved!`);
      const cfgRes = await fetch("/api/ai_director/config");
      const cfg = await cfgRes.json();
      if (keyInput) keyInput.placeholder = `Connected (${cfg[`${activeAIProvider}_masked_key`] || 'Saved'})`;
    } else {
      if (statusEl) {
        statusEl.style.color = "#ef4444";
        statusEl.textContent = `❌ ${data.error || 'Verification failed. Please check key.'}`;
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = "#ef4444";
      statusEl.textContent = `❌ Connection error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Save & Verify Key";
    }
  }
}

function handleRunOfflineDirectorFromModal() {
  closeAIDirectorModal();
  showToast("⚡ Running offline rule-based director...");
  handleAutoDirectStory();
}

function closeAIDirectorModal() {
  const modal = document.getElementById("ai-director-modal");
  if (modal) modal.style.display = "none";
}

function switchAIDirectorProvider(prov) {
  activeAIProvider = prov || "gemini";
  const tabs = ["gemini", "groq", "openai", "ollama"];
  tabs.forEach(t => {
    const tabEl = document.getElementById(`tab-llm-${t}`);
    if (tabEl) {
      if (t === activeAIProvider) {
        tabEl.classList.add("active");
        tabEl.style.background = "linear-gradient(135deg, rgba(139, 92, 246, 0.4), rgba(99, 102, 241, 0.4))";
        tabEl.style.borderColor = "#8b5cf6";
        tabEl.style.color = "#fff";
      } else {
        tabEl.classList.remove("active");
        tabEl.style.background = "";
        tabEl.style.borderColor = "";
        tabEl.style.color = "";
      }
    }
  });

  const keyLabel = document.getElementById("ai-key-label");
  const keyInput = document.getElementById("ai-director-api-key");
  const keyLink = document.getElementById("ai-key-link");
  const modelSelect = document.getElementById("ai-director-model-select");
  const keyContainer = document.getElementById("ai-key-container");
  const keyStatus = document.getElementById("ai-key-status");
  if (keyStatus) keyStatus.style.display = "none";

  if (activeAIProvider === "gemini") {
    if (keyContainer) keyContainer.style.display = "block";
    if (keyLabel) keyLabel.textContent = "Google Gemini API Key";
    if (keyInput) keyInput.placeholder = "AIzaSy...";
    if (keyLink) {
      keyLink.style.display = "inline";
      keyLink.href = "https://aistudio.google.com/app/apikey";
      keyLink.textContent = "Get Free Gemini Key (Instant) ↗";
    }
    if (modelSelect) {
      modelSelect.innerHTML = `
        <option value="gemini-3.5-flash-lite" selected>gemini-3.5-flash-lite (Recommended: Ultra Fast &amp; Free)</option>
        <option value="gemini-2.5-flash">gemini-2.5-flash (Balanced)</option>
        <option value="gemini-3.5-flash">gemini-3.5-flash (Frontier Quality)</option>
        <option value="gemini-flash-latest">gemini-flash-latest</option>
      `;
    }
  } else if (activeAIProvider === "groq") {
    if (keyContainer) keyContainer.style.display = "block";
    if (keyLabel) keyLabel.textContent = "Groq Cloud API Key";
    if (keyInput) keyInput.placeholder = "gsk_...";
    if (keyLink) {
      keyLink.style.display = "inline";
      keyLink.href = "https://console.groq.com/keys";
      keyLink.textContent = "Get Free Groq API Key ↗";
    }
    if (modelSelect) {
      modelSelect.innerHTML = `
        <option value="openai/gpt-oss-120b" selected>openai/gpt-oss-120b (Recommended: 300 T/s, High IQ)</option>
        <option value="openai/gpt-oss-20b">openai/gpt-oss-20b (Ultra Fast &amp; Free)</option>
        <option value="qwen/qwen3.8-27b">qwen/qwen3.8-27b (High Reasoning)</option>
      `;
    }
  } else if (activeAIProvider === "openai") {
    if (keyContainer) keyContainer.style.display = "block";
    if (keyLabel) keyLabel.textContent = "OpenAI API Key";
    if (keyInput) keyInput.placeholder = "sk-proj-...";
    if (keyLink) {
      keyLink.style.display = "inline";
      keyLink.href = "https://platform.openai.com/api-keys";
      keyLink.textContent = "Get OpenAI Key ↗";
    }
    if (modelSelect) {
      modelSelect.innerHTML = `
        <option value="gpt-4o-mini">gpt-4o-mini (Fast & Cost Effective)</option>
        <option value="gpt-4o">gpt-4o</option>
      `;
    }
  } else if (activeAIProvider === "ollama") {
    if (keyContainer) keyContainer.style.display = "none";
    if (modelSelect) {
      modelSelect.innerHTML = `
        <option value="llama3.2">llama3.2 (Local)</option>
        <option value="qwen2.5">qwen2.5</option>
        <option value="mistral">mistral</option>
      `;
    }
  }
}

function toggleAIKeyVisibility() {
  const inp = document.getElementById("ai-director-api-key");
  if (!inp) return;
  inp.type = (inp.type === "password") ? "text" : "password";
}

async function handleRunAIDirector() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    const keyInput = document.getElementById("ai-director-api-key");
    if (keyInput && keyInput.value.trim()) {
      await handleVerifyAISaveKey();
      showToast("✓ Key verified and saved! Open any story project to run AI directing.", 4500);
    } else {
      showToast("💡 Please open or create a chapter project to run AI directing on its manuscript.", 4500);
    }
    return;
  }

  const btn = document.getElementById("btn-run-ai-director");
  const keyInput = document.getElementById("ai-director-api-key");
  const modelSelect = document.getElementById("ai-director-model-select");
  const saveKeyCheck = document.getElementById("ai-director-save-key");
  const optCast = document.getElementById("ai-opt-cast");
  const optSplit = document.getElementById("ai-opt-split");
  const optEmotions = document.getElementById("ai-opt-emotions");
  const tagIntensitySelect = document.getElementById("ai-tag-intensity");
  const analysisTempSlider = document.getElementById("ai-analysis-temp");
  const optSplitBeats = document.getElementById("ai-opt-split-emotional-beats");
  const tagPlacementSelect = document.getElementById("ai-tag-placement");

  const apiKey = (keyInput ? keyInput.value : "").trim();
  const model = modelSelect ? modelSelect.value : "";
  const saveKey = saveKeyCheck ? saveKeyCheck.checked : true;
  const engine = state.currentProject.engine || "fish_s2";
  const defaultVoice = state.currentProject.default_voice || "";
  const actingIntensity = tagIntensitySelect ? tagIntensitySelect.value : "balanced";
  const analysisTemperature = analysisTempSlider ? parseFloat(analysisTempSlider.value) : 0.60;
  const splitLongEmotionalBlocks = optSplitBeats ? optSplitBeats.checked : true;
  const tagPlacement = tagPlacementSelect ? tagPlacementSelect.value : "pill";

  const originalBtnText = btn.innerHTML;

  if (activeAIProvider === "gemini" && apiKey.startsWith("sk-fish-")) {
    showToast("⚠️ You entered a Fish Audio key (starts with 'sk-fish-') for Google Gemini. Please use a Gemini key starting with 'AIzaSy'.", 6000);
    const keyStatus = document.getElementById("ai-key-status");
    if (keyStatus) {
      keyStatus.style.display = "block";
      keyStatus.style.color = "#ef4444";
      keyStatus.innerHTML = `⚠️ Fish Audio key entered! Google Gemini requires a free Gemini key starting with <code>AIzaSy</code> from <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color: #60a5fa; text-decoration: underline;">Google AI Studio</a>.`;
    }
    return;
  }

  const isSingle = document.getElementById("ai-director-mode-single")?.checked || false;
  const productionMode = isSingle ? "single" : "multi";

  btn.disabled = true;
  btn.innerHTML = `<span>⏳ AI Director analyzing manuscript & casting roles...</span>`;

  const jobId = "job_modal_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  const progressTracker = startLiveProgressTracker(jobId, {
    containerId: "modal-ai-progress-container",
    barId: "modal-ai-progress-bar",
    percentId: "modal-ai-progress-percent",
    stepId: "modal-ai-progress-step",
    msgId: "modal-ai-progress-msg",
    charsId: "modal-ai-progress-characters",
    initialStep: isSingle ? "🎙️ Phase 1: Directing Solo Narrator..." : "🎭 Phase 1: Casting Story Characters...",
    initialMsg: isSingle ? "Analyzing monologue and character acting beats..." : "Analyzing story text & matching library voices..."
  });

  try {
    const res = await fetch("/api/ai_director/direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        blocks: state.currentProject.blocks,
        provider: activeAIProvider,
        api_key: apiKey,
        model: model,
        save_key: saveKey,
        engine: engine,
        default_voice: defaultVoice,
        production_mode: productionMode,
        cast_voices: !isSingle && (optCast ? optCast.checked : true),
        split_dialogue: optSplit ? optSplit.checked : true,
        add_emotions: optEmotions ? optEmotions.checked : true,
        acting_intensity: actingIntensity,
        analysis_temperature: analysisTemperature,
        split_long_emotional_blocks: splitLongEmotionalBlocks,
        tag_placement: tagPlacement,
        existing_characters: (state.currentProject.characters && state.currentProject.characters.length > 0 ? state.currentProject.characters : null)
      })
    });

    const resText = await res.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch (parseErr) {
      if (progressTracker) progressTracker.hide();
      throw new Error(resText.slice(0, 180) || `Server returned error (${res.status})`);
    }

    if (!res.ok || !data.ok) {
      if (progressTracker) progressTracker.hide();
      throw new Error(data.error || "Failed to direct story with AI.");
    }

    if (progressTracker) {
      progressTracker.finish("✨ Directing Complete! Showing Cast...");
      setTimeout(() => progressTracker.hide(), 1200);
    }

    window._aiDirectedBlocks = data.blocks;
    window._aiDirectedCharacters = data.characters || [];

    // Display Results Container
    const resBox = document.getElementById("ai-director-results");
    const headline = document.getElementById("ai-results-headline");
    const countEl = document.getElementById("ai-results-count");
    const cardsEl = document.getElementById("ai-character-cards");

    if (resBox) resBox.style.display = "flex";
    if (headline) headline.textContent = `✨ Directing Complete! (${data.total_blocks} blocks)`;
    if (countEl) countEl.textContent = `${data.characters.length} characters identified`;

    if (cardsEl) {
      cardsEl.innerHTML = data.characters.map(c => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); border-radius: 6px; padding: 6px 10px; font-size: 12px;">
          <div>
            <span style="font-weight: 700; color: #fff;">${escapeHtml(c.name || 'Character')}</span>
            <span style="color: var(--text-muted); font-size: 11px; margin-left: 6px;">(${escapeHtml(c.persona || c.gender || '')})</span>
          </div>
          <span style="color: #a78bfa; font-family: monospace; font-size: 11px; background: rgba(139, 92, 246, 0.15); padding: 2px 6px; border-radius: 4px;">
            ${escapeHtml(c.assigned_voice_id || '')}
          </span>
        </div>
      `).join("");
    }

    showToast(`🎭 AI Directing complete! Identified ${data.characters.length} characters.`);

  } catch (err) {
    console.error("AI Director error:", err);
    showToast(`❌ AI Director failed: ${err.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnText;
  }
}

function applyAIDirectedBlocks() {
  if (!window._aiDirectedBlocks || !state.currentProject) {
    showToast("⚠️ No directed blocks to apply.");
    return;
  }

  recordHistory("AI Script Director");

  const directedChars = window._aiDirectedCharacters || [];
  const projId = state.currentProject.id;
  const defVoice = state.currentProject.default_voice || (state.voices && state.voices[0] ? state.voices[0].id : "voice_stanley_narrator");

  const PALETTE = [
    "#f59e0b", // Amber/Gold (Mentor/Rich Dad)
    "#10b981", // Emerald (Companion/Mike)
    "#ec4899", // Rose/Pink
    "#8b5cf6", // Purple
    "#06b6d4", // Cyan (Youth/Author)
    "#ef4444", // Red
    "#3b82f6", // Blue
    "#14b8a6", // Teal
    "#f97316"  // Orange
  ];

  if (!Array.isArray(state.savedCharacters)) {
    state.savedCharacters = [];
  }

  const charMapByName = {};
  state.savedCharacters.forEach(c => {
    if (c && c.name) charMapByName[c.name.trim().toLowerCase()] = c;
  });

  let paletteIdx = 0;
  directedChars.forEach((c, idx) => {
    const rawName = (c.name || "Character").trim();
    const key = rawName.toLowerCase();
    const isNarrator = key === "narrator" || key.includes("narrator");
    const assignedVoice = c.assigned_voice_id || c.voice_id || defVoice;

    if (!charMapByName[key]) {
      let badge = c.badge;
      if (!badge) {
        const words = rawName.split(/\s+/).filter(Boolean);
        badge = words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : rawName.slice(0, 2).toUpperCase();
      }

      const newChar = {
        id: c.id || `char_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 4)}`,
        name: rawName,
        voice_id: assignedVoice,
        badge: badge,
        color: c.color || (isNarrator ? "#6366f1" : PALETTE[paletteIdx % PALETTE.length]),
        speed: c.speed || 0.90,
        pitch_shift: c.pitch_shift || 0.0,
        fx_filter: "none",
        persona: c.persona || "",
        gender: c.gender || ""
      };
      if (!isNarrator) paletteIdx++;

      state.savedCharacters.push(newChar);
      charMapByName[key] = newChar;
    } else {
      if (assignedVoice) charMapByName[key].voice_id = assignedVoice;
      if (c.persona) charMapByName[key].persona = c.persona;
      if (c.badge) charMapByName[key].badge = c.badge;
      if (c.color) charMapByName[key].color = c.color;
    }
  });

  // Ensure primary Narrator character exists in project cast
  if (!charMapByName["narrator"]) {
    const narrChar = {
      id: `char_${Date.now()}_narrator`,
      name: "Narrator",
      voice_id: defVoice,
      badge: "NA",
      color: "#6366f1",
      speed: 0.90,
      pitch_shift: 0.0,
      fx_filter: "none",
      persona: "Primary Storyteller",
      gender: "neutral"
    };
    state.savedCharacters.unshift(narrChar);
    charMapByName["narrator"] = narrChar;
  }

  // Persist cast to current project and localStorage
  state.currentProject.characters = state.savedCharacters;
  const isSingleMode = document.getElementById("ai-director-mode-single")?.checked;
  state.currentProject.production_mode = isSingleMode ? "single" : "multi";
  try {
    localStorage.setItem(`kss_chars_${projId}`, JSON.stringify(state.savedCharacters));
  } catch (e) {}

  // Assign engine and map each block to its character id
  const eng = state.currentProject.engine || "fish_s2";
  window._aiDirectedBlocks.forEach(b => {
    b.engine = eng;
    if (!b.speed) b.speed = 0.9;
    if (!b.gain) b.gain = 1.0;

    const spk = (b.speaker || "Narrator").trim();
    let matchedChar = charMapByName[spk.toLowerCase()];
    if (!matchedChar) {
      for (const [k, c] of Object.entries(charMapByName)) {
        if (k.includes(spk.toLowerCase()) || spk.toLowerCase().includes(k)) {
          matchedChar = c;
          break;
        }
      }
    }
    if (!matchedChar) {
      matchedChar = charMapByName["narrator"] || state.savedCharacters[0];
    }

    if (matchedChar) {
      b.character_id = matchedChar.id;
      b.speaker = matchedChar.name;
      b.voice_id = matchedChar.voice_id;
    }
  });

  state.currentProject.blocks = window._aiDirectedBlocks;
  state.selectedBlockIndices = new Set([0]);
  state.activeBlockIndex = 0;
  state.lastClickedIndex = 0;

  // Immediate UI synchronization
  renderSavedCharactersList();
  renderStudio();
  saveCurrentProject();
  closeAIDirectorModal();
  showToast(`🎭 AI Cast Applied: ${state.savedCharacters.length} characters assigned across ${window._aiDirectedBlocks.length} speech blocks!`);
}

window.openAIDirectorModal = openAIDirectorModal;
window.closeAIDirectorModal = closeAIDirectorModal;
window.switchAIDirectorProvider = switchAIDirectorProvider;
window.toggleAIKeyVisibility = toggleAIKeyVisibility;
window.handleRunAIDirector = handleRunAIDirector;
window.applyAIDirectedBlocks = applyAIDirectedBlocks;

function applyDeliveryPreset(presetKey) {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex >= 0 ? state.activeBlockIndex : 0]);

  const defVoice = state.currentProject.default_voice || "blend_fenrir_onyx";

  let presetConfig = {
    name: "Narrator",
    voice_id: null,
    speed: 0.90,
    gain: 1.0,
    pause_after: 0.6,
    pitch_shift: 0.0,
    warmth: 0.0,
    clarity: 0.0,
    reverb: 0.0,
    radio_fx: false,
    clearBlend: false
  };

  switch (presetKey) {
    case "narrator": {
      const defs = getProjectDefaultSettings();
      presetConfig = {
        name: "Narrator",
        voice_id: defs.voice_id,
        speed: defs.speed,
        gain: defs.gain,
        pause_after: defs.pause_after,
        pitch_shift: defs.pitch_shift,
        warmth: defs.warmth,
        clarity: defs.clarity,
        reverb: defs.reverb,
        radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
        fx_filter: defs.fx_filter,
        clearBlend: false
      };
      break;
    }
    case "whisper":
      presetConfig = {
        name: "Soft Whisper",
        voice_id: null,
        speed: 0.82,
        gain: 0.75,
        pause_after: 0.9,
        pitch_shift: -0.5,
        warmth: 0.0,
        clarity: 3.0,
        reverb: 0.15,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "intense":
      presetConfig = {
        name: "Intense Scream",
        voice_id: null,
        speed: 1.06,
        gain: 1.20,
        pause_after: 0.8,
        pitch_shift: 2.0,
        warmth: 1.5,
        clarity: 1.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "demon":
      presetConfig = {
        name: "Deep Demon",
        voice_id: null,
        speed: 0.84,
        gain: 1.10,
        pause_after: 0.9,
        pitch_shift: -3.5,
        warmth: 4.5,
        clarity: -1.0,
        reverb: 0.22,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "youth":
      presetConfig = {
        name: "High Pitch / Youth",
        voice_id: null,
        speed: 0.98,
        gain: 0.95,
        pause_after: 0.6,
        pitch_shift: 3.5,
        warmth: -1.5,
        clarity: 2.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: false
      };
      break;
    case "radio":
      presetConfig = {
        name: "Radio Transceiver",
        voice_id: null,
        speed: 0.92,
        gain: 1.0,
        pause_after: 0.7,
        pitch_shift: 0.0,
        warmth: 0.0,
        clarity: 1.5,
        reverb: 0.0,
        radio_fx: true,
        clearBlend: false
      };
      break;
    case "female":
      presetConfig = {
        name: "Female Dialogue",
        voice_id: "af_heart",
        speed: 0.86,
        gain: 1.0,
        pause_after: 0.8,
        pitch_shift: 0.0,
        warmth: 0.0,
        clarity: 0.5,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: true
      };
      break;
    case "male":
      presetConfig = {
        name: "Male Dialogue",
        voice_id: "am_michael",
        speed: 0.88,
        gain: 1.0,
        pause_after: 0.8,
        pitch_shift: 0.0,
        warmth: 0.5,
        clarity: 0.0,
        reverb: 0.0,
        radio_fx: false,
        clearBlend: true
      };
      break;
  }

  recordHistory(`Delivery Preset: ${presetConfig.name}`);

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.voice_id = presetConfig.voice_id;
    block.speed = presetConfig.speed;
    block.gain = presetConfig.gain;
    block.pause_after = presetConfig.pause_after;
    block.pitch_shift = presetConfig.pitch_shift;
    block.warmth = presetConfig.warmth;
    block.clarity = presetConfig.clarity;
    block.reverb = presetConfig.reverb;
    block.radio_fx = presetConfig.radio_fx;
    if (presetConfig.clearBlend) {
      delete block.blend_weights;
    }
    delete block.cachedAudioUrl;
    delete block.cachedSig;
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`⚡ Set "${presetConfig.name}" on ${targets.size} sentence(s)!`);
}

async function handleBulkRender() {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) return;
  const selectedList = Array.from(state.selectedBlockIndices)
    .filter(idx => {
      const b = state.currentProject.blocks[idx];
      return b && b.type !== "heading" && b.is_spoken !== false;
    })
    .sort((a, b) => a - b);
  if (selectedList.length === 0) {
    showToast("ℹ️ Selected items contain no spoken sentences to render.");
    return;
  }

  const btnBulkRender = document.getElementById("btn-bulk-render");
  const isGPU = Boolean(state.config.active && state.config.remote_worker_url);
  const concurrencySelect = document.getElementById("batch-concurrency-select");
  let concurrency = concurrencySelect ? parseInt(concurrencySelect.value, 10) : 1;
  if (!concurrency || concurrency < 1) concurrency = isGPU ? 3 : 1;
  if (!isGPU && concurrency > 2) concurrency = 1;

  if (btnBulkRender) {
    btnBulkRender.disabled = true;
    btnBulkRender.textContent = `⏳ Rendering (0/${selectedList.length})...`;
  }

  const startTime = Date.now();
  let completed = 0;
  let taskIndex = 0;

  function updateBulkBtn() {
    if (!btnBulkRender) return;
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
    if (completed > 0) {
      const rate = completed / elapsedSec;
      const remaining = selectedList.length - completed;
      const etaSec = Math.round(remaining / rate);
      btnBulkRender.textContent = `⏳ (${completed}/${selectedList.length}) • ETA ${formatBatchDuration(etaSec)}`;
    } else {
      btnBulkRender.textContent = `⏳ Rendering (0/${selectedList.length})...`;
    }
  }

  async function renderSingleSelected(idx) {
    const block = state.currentProject.blocks[idx];
    if (!block || block.type === "heading" || block.is_spoken === false) return;
    const row = document.querySelector(`[data-index="${idx}"]`);
    const currentSig = getBlockSignature(block);

    if (block.cachedAudioUrl || block.audio_url) {
      if (row) row.classList.add("ready");
      return;
    }

    if (row) {
      row.classList.add("processing");
      row.classList.remove("ready");
    }

    const activeEng = block.engine || state.currentProject?.engine || state.activeEngine || "fish_s2";
    if (activeEng === "kokoro" && window.KokoroClient && window.KokoroClient.isClientKokoroEnabled()) {
      try {
        const char = getCharacterById(block.character_id || block.speaker);
        let chosenVoiceId = block.voice_id || (char && (char.voice_id || char.assigned_voice_id)) || "af_bella";
        if (!chosenVoiceId || chosenVoiceId.startsWith("fish_") || chosenVoiceId.includes("Neural")) {
          chosenVoiceId = "af_bella";
        }
        const clientRes = await window.KokoroClient.synthesizeOnClient(block.text, {
          voice: chosenVoiceId,
          speed: Number(block.speed || 1.0)
        });
        if (clientRes && clientRes.audioUrl) {
          const permanentUrl = `/api/audio/${clientRes.hash}.wav`;
          block.cachedAudioUrl = permanentUrl;
          block.audio_url = permanentUrl;
          block.cachedSig = currentSig;
          block.duration = clientRes.duration;
          block.hash = clientRes.hash;
          if (!block.take_cache) block.take_cache = {};
          block.take_cache[currentSig] = {
            audio_url: permanentUrl,
            duration: clientRes.duration,
            cachedSig: currentSig,
            timestamp: Date.now()
          };
          debouncedSave();
          if (row) {
            row.classList.remove("processing");
            row.classList.add("ready");
            const timeText = row.querySelector(".scrubber-time");
            if (timeText && clientRes.duration) timeText.textContent = `● ${clientRes.duration.toFixed(1)}s`;
          }
          window.KokoroClient.syncClientAudioToServer(clientRes.blob, clientRes.hash, {
            project_id: state.currentProject?.id,
            block_id: block.id,
            duration: clientRes.duration
          });
          return;
        }
      } catch (clientErr) {
        console.warn("[KokoroClient] Client synthesis fallback to server:", clientErr);
      }
    }

    try {
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBlockSynthesizePayload(block))
      });

      let data = null;
      const cType = res.headers.get("content-type") || "";
      if (cType.includes("application/json")) {
        data = await res.json().catch(() => null);
      }
      if (!data) {
        const rawText = await res.text().catch(() => "");
        throw new Error(`Server returned HTTP ${res.status}${rawText ? `: ${rawText.slice(0, 120)}` : ""}`);
      }

      if (data.audio_url) {
        if (data.tier_status) updateTierDisplay(data.tier_status);
        block.cachedAudioUrl = data.audio_url;
        block.cachedSig = currentSig;
        if (data.duration) block.duration = data.duration;
        debouncedSave();
        if (row) {
          row.classList.remove("processing");
          row.classList.add("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText && data.duration) timeText.textContent = `● ${data.duration.toFixed(1)}s`;
        }
      }
    } catch (err) {
      console.error("Bulk render error on block", idx, err);
      if (row) row.classList.remove("processing");
    }
  }

  async function worker() {
    while (taskIndex < selectedList.length) {
      const current = taskIndex++;
      const blockIdx = selectedList[current];
      if (blockIdx === undefined) break;
      await renderSingleSelected(blockIdx);
      completed++;
      updateBulkBtn();
    }
  }

  const workers = [];
  const actualConcurrency = Math.min(concurrency, selectedList.length);
  for (let c = 0; c < actualConcurrency; c++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (btnBulkRender) {
    btnBulkRender.disabled = false;
    btnBulkRender.textContent = `✓ Selected Rendered!`;
    setTimeout(() => {
      updateSelectionUI();
    }, 2500);
  }
  renderTimeline();
  updateStoryTimeDisplay();
  const totalElapsed = formatBatchDuration((Date.now() - startTime) / 1000);
  showToast(`✓ Rendered ${selectedList.length} sentence(s) in ${totalElapsed}!`);
}

function updateActiveSentenceHint(idx) {
  const hintEl = document.getElementById("player-active-sentence-hint");
  if (!hintEl || !state.currentProject || !state.currentProject.blocks) return;
  const block = state.currentProject.blocks[idx];
  if (!block) return;
  const total = state.currentProject.blocks.length;
  if (block.type === "heading" || block.is_spoken === false) {
    hintEl.textContent = `🎬 Item ${idx + 1}/${total}: "${block.text || 'Scene Heading'}" (Non-spoken divider • ${(block.pause_after || 1.0).toFixed(1)}s pause)`;
  } else {
    hintEl.textContent = `Sentence ${idx + 1}/${total}: "${block.text.slice(0, 55)}${block.text.length > 55 ? '...' : ''}"`;
  }
}

function renderInspector() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  
  if (typeof state.activeBlockIndex !== "number" || state.activeBlockIndex < 0 || state.activeBlockIndex >= state.currentProject.blocks.length) {
    state.activeBlockIndex = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
      ? Array.from(state.selectedBlockIndices)[0]
      : 0;
  }
  const block = state.currentProject.blocks[state.activeBlockIndex];
  if (!block) return;

  // Multi-Engine Contextual Adaptation - resolves block's character/engine cleanly
  const char = block.character_id ? getCharacterById(block.character_id) : (block.speaker ? getCharacterById(block.speaker) : null);
  const targetVoiceId = block.voice_id || (char && (char.voice_id || char.assigned_voice_id));
  const voice = getVoiceById(targetVoiceId);
  const blockEngine = block.engine || (char && char.engine) || (voice && voice.engine) || state.currentProject?.engine || "fish_s2";

  // Update Cast Tab Model Selection Dropdown Trigger & Tags
  const engineIcon = document.getElementById("selected-engine-icon");
  const engineName = document.getElementById("selected-engine-name");
  const engineSub = document.getElementById("selected-engine-sub");
  const castTierTag = document.getElementById("cast-engine-tier-tag");

  // Multi-Engine & Model Contextual Adaptation - resolves block's character/engine/model
  const defaultModels = {
    fish_s2: "drama3",
    elevenlabs: "v4",
    cartesia: "sonic_4",
    openai: "gpt-4o-mini-tts",
    edge_tts: "edge_neural",
    kokoro: "kokoro_webgpu"
  };

  let rawModel = block.model || (char && char.model) || state.currentProject?.model || defaultModels[blockEngine] || "drama3";
  if (rawModel === "gpt-4o-mini") rawModel = "gpt-4o-mini-tts";
  if (rawModel === "drama-3") rawModel = "drama3";
  if (rawModel === "s2-pro") rawModel = "s2_pro";
  const effectiveModel = rawModel;
  state.activeEngine = blockEngine;
  state.activeModel = effectiveModel;

  let engDisplayName = "Fish Speech (Drama 3)";
  let engSubName = "Cinema emotion acting • Voice cloning";
  let engTag = "Drama 3";
  let engTagBg = "rgba(245, 158, 11, 0.15)";
  let engTagColor = "#fcd34d";
  let engIcon = "🎭";

  if (blockEngine === "fish_s2") {
    engIcon = "🎭";
    engTagBg = "rgba(245, 158, 11, 0.15)";
    engTagColor = "#fcd34d";
    if (effectiveModel === "s2_pro") {
      engDisplayName = "Fish Speech (S2.1 Pro)";
      engSubName = "Multi-speaker dialogue acting";
      engTag = "S2.1 Pro";
    } else {
      engDisplayName = "Fish Speech (Drama 3)";
      engSubName = "Cinema emotion acting • Voice cloning";
      engTag = "Drama 3";
    }
  } else if (blockEngine === "elevenlabs") {
    engIcon = "🌟";
    engTagBg = "rgba(139, 92, 246, 0.2)";
    engTagColor = "#c4b5fd";
    if (effectiveModel === "v3") {
      engDisplayName = "ElevenLabs (v3 Multilingual)";
      engSubName = "Multilingual expressive narration";
      engTag = "v3";
    } else if (effectiveModel === "flash_v2.5") {
      engDisplayName = "ElevenLabs (Flash v2.5)";
      engSubName = "Fast commercial narration";
      engTag = "Flash";
    } else {
      engDisplayName = "ElevenLabs (v4 Cinematic)";
      engSubName = "Ultra-consistent studio narrative";
      engTag = "v4";
    }
  } else if (blockEngine === "cartesia") {
    engIcon = "⚡";
    engTagBg = "rgba(236, 72, 153, 0.2)";
    engTagColor = "#f472b6";
    if (effectiveModel === "sonic_3.6") {
      engDisplayName = "Cartesia Sonic (3.6)";
      engSubName = "Ultra-high-speed streaming speech";
      engTag = "Sonic 3.6";
    } else {
      engDisplayName = "Cartesia Sonic (Sonic 4)";
      engSubName = "Nuanced neural cadence";
      engTag = "Sonic 4";
    }
  } else if (blockEngine === "openai") {
    engIcon = "🤖";
    engTagBg = "rgba(16, 185, 129, 0.2)";
    engTagColor = "#6ee7b7";
    if (effectiveModel === "tts-1") {
      engDisplayName = "OpenAI Audio (tts-1)";
      engSubName = "High-definition neural audio";
      engTag = "tts-1";
    } else {
      engDisplayName = "OpenAI Audio (gpt-4o-mini)";
      engSubName = "Natural conversational speech";
      engTag = "gpt-4o";
    }
  } else if (blockEngine === "edge_tts") {
    engIcon = "🌐";
    engDisplayName = "Microsoft Edge TTS";
    engSubName = "300+ natural cloud voices • Free";
    engTag = "300+ Voices";
    engTagBg = "rgba(14, 165, 233, 0.15)";
    engTagColor = "#38bdf8";
  } else if (blockEngine === "kokoro") {
    engIcon = "⚡";
    engDisplayName = "Kokoro 82M";
    engSubName = "On-device WebGPU • 0s queue • Free";
    engTag = "WebGPU";
    engTagBg = "rgba(99, 102, 241, 0.15)";
    engTagColor = "#a5b4fc";
  }

  if (engineIcon) engineIcon.textContent = engIcon;
  if (engineName) engineName.textContent = engDisplayName;
  if (engineSub) engineSub.textContent = engSubName;
  if (castTierTag) {
    castTierTag.textContent = engTag;
    castTierTag.style.background = engTagBg;
    castTierTag.style.color = engTagColor;
  }

  // Update checkmarks and active states in #engine-model-dropdown: exactly ONE subitem matches
  document.querySelectorAll("#engine-model-dropdown .engine-model-subitem").forEach(item => {
    const itemEng = item.dataset.engine;
    const itemModel = item.dataset.model;
    const isThis = (itemEng === blockEngine) && (itemModel === effectiveModel);
    item.classList.toggle("active", isThis);
    const checkEl = item.querySelector(".engine-model-check");
    if (checkEl) checkEl.style.display = isThis ? "inline" : "none";
  });

  // Toggle Context-Sensitive Sections
  const isFish = blockEngine === "fish_s2";
  const emotionSec = document.getElementById("inspector-emotion-section");
  if (emotionSec) emotionSec.style.display = isFish ? "block" : "none";

  const zeroShotSec = document.getElementById("inspector-zero-shot-section");
  if (zeroShotSec) zeroShotSec.style.display = isFish ? "block" : "none";

  // Update Character Status Banner
  updateActiveCharacterStatusBanner();
  updateOverriddenCastButtonUI();

  const cardColor = (voice && voice.color) || (char && char.color) || "#6366f1";
  const cardBadge = (voice && voice.badge) || (voice && voice.name ? voice.name.slice(0, 2).toUpperCase() : (char && char.badge ? char.badge : "VO"));

  // Inspector voice card
  const avatar = document.getElementById("inspector-voice-avatar");
  if (avatar) {
    avatar.style.backgroundColor = cardColor;
    avatar.textContent = cardBadge;
  }

  const nameEl = document.getElementById("inspector-voice-name");
  if (nameEl) {
    if (char && (!voice.name || voice.name === voice.id || (typeof voice.name === 'string' && voice.name.startsWith("fish_")))) {
      nameEl.textContent = `${char.name} (${voice.timbre || 'Cast Voice'})`;
    } else {
      nameEl.textContent = voice.name || "Voice";
    }
  }

  const subEl = document.getElementById("inspector-voice-sub");
  if (subEl) {
    const engLabel = engDisplayName || blockEngine;
    const metaParts = [engLabel, voice.gender, voice.accent, voice.timbre].filter(Boolean);
    subEl.textContent = metaParts.join(" • ");
  }

  // Sliders
  const volSlider = document.getElementById("slider-volume");
  if (volSlider) {
    volSlider.value = Math.round((block.gain || 1.0) * 100);
    const valVol = document.getElementById("val-volume");
    if (valVol) valVol.textContent = volSlider.value + "%";
  }

  // Fish Audio S2 Pro Emotion & Hyperparameters
  const emotionInput = document.getElementById("input-emotion-tag");
  if (emotionInput) {
    emotionInput.value = block.emotion_tag || "";
  }
  const tempSlider = document.getElementById("slider-temperature");
  if (tempSlider) {
    const tVal = (block.temperature !== undefined ? Number(block.temperature) : 0.70).toFixed(2);
    tempSlider.value = tVal;
    const valTemp = document.getElementById("val-temperature");
    if (valTemp) valTemp.textContent = tVal;
  }
  document.querySelectorAll("#inspector-emotion-chips .emotion-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.tag === (block.emotion_tag || ""));
  });

  // Zero-Shot Reference Voice Info
  const refAudio = block.reference_audio || (char && char.reference_audio) || "";
  const refNameEl = document.getElementById("ref-voice-filename");
  const refMetaEl = document.getElementById("ref-voice-meta");
  const playRefBtn = document.getElementById("btn-play-ref-voice");
  if (refAudio) {
    const filename = refAudio.split("/").pop();
    if (refNameEl) refNameEl.textContent = filename;
    if (refMetaEl) refMetaEl.textContent = "Custom zero-shot reference voice";
    if (playRefBtn) {
      playRefBtn.style.display = "inline-flex";
      playRefBtn.dataset.url = refAudio.startsWith("/") ? refAudio : `/${refAudio}`;
    }
  } else {
    if (refNameEl) refNameEl.textContent = "Upload Reference Audio (.wav, .mp3)";
    if (refMetaEl) refMetaEl.textContent = "No reference clip assigned";
    if (playRefBtn) playRefBtn.style.display = "none";
  }

  const refTranscriptInput = document.getElementById("input-ref-transcript");
  if (refTranscriptInput) {
    refTranscriptInput.value = block.reference_text || (char && char.reference_text) || "";
  }

  const speedSlider = document.getElementById("slider-speed");
  if (speedSlider) {
    speedSlider.value = (block.speed || 0.90).toFixed(2);
    const valSpeed = document.getElementById("val-speed");
    if (valSpeed) valSpeed.textContent = speedSlider.value + "x";
  }

  const pauseSlider = document.getElementById("slider-pause");
  if (pauseSlider) {
    pauseSlider.value = (block.pause_after || 0.6).toFixed(1);
    const valPause = document.getElementById("val-pause");
    if (valPause) valPause.textContent = pauseSlider.value + "s";
  }

  // DSP Controls
  const pitchSlider = document.getElementById("slider-pitch");
  if (pitchSlider) {
    const pVal = Number(block.pitch_shift || 0.0);
    pitchSlider.value = pVal.toFixed(1);
    const valPitch = document.getElementById("val-pitch");
    if (valPitch) valPitch.textContent = (pVal > 0 ? `+${pVal.toFixed(1)}` : pVal.toFixed(1)) + " st";
  }

  const warmthSlider = document.getElementById("slider-warmth");
  if (warmthSlider) {
    const wVal = Number(block.warmth || 0.0);
    warmthSlider.value = wVal.toFixed(1);
    const valWarmth = document.getElementById("val-warmth");
    if (valWarmth) valWarmth.textContent = (wVal > 0 ? `+${wVal.toFixed(1)}` : wVal.toFixed(1)) + " dB";
  }

  const claritySlider = document.getElementById("slider-clarity");
  if (claritySlider) {
    const cVal = Number(block.clarity || 0.0);
    claritySlider.value = cVal.toFixed(1);
    const valClarity = document.getElementById("val-clarity");
    if (valClarity) valClarity.textContent = (cVal > 0 ? `+${cVal.toFixed(1)}` : cVal.toFixed(1)) + " dB";
  }

  const reverbSlider = document.getElementById("slider-reverb");
  if (reverbSlider) {
    const rVal = Math.round(Number(block.reverb || 0.0) * 100);
    reverbSlider.value = rVal;
    const valReverb = document.getElementById("val-reverb");
    if (valReverb) valReverb.textContent = rVal + "%";
  }

  // Acoustic FX Filter State
  const curFilter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();
  const filterNames = {
    "none": "Clean Studio",
    "radio": "Radio Transceiver",
    "whisper": "Soft Whisper",
    "scream": "Intense Scream",
    "demon": "Deep Demon",
    "youth": "Child / Youth"
  };
  const activeLabel = document.getElementById("val-active-filter");
  if (activeLabel) activeLabel.textContent = filterNames[curFilter] || "Clean Studio";

  ["none", "radio", "whisper", "scream", "demon", "youth"].forEach(f => {
    const btn = document.getElementById(`btn-fx-${f}`);
    if (btn) btn.classList.toggle("active", curFilter === f);
  });
}

function renderTimeline() {
  const container = document.getElementById("timeline-blocks");
  if (!container) return;
  container.innerHTML = "";

  if (!state.currentProject || !state.currentProject.blocks) return;

  state.currentProject.blocks.forEach((block, idx) => {
    if (block.type === "heading" || block.is_spoken === false) {
      const item = document.createElement("div");
      const isActive = state.activeBlockIndex === idx;
      const isPlaying = state.currentlyPlayingBlockIdx === idx;
      item.className = `timeline-block-item heading-item ${isActive ? "active" : ""} ${isPlaying ? "playing" : ""}`;
      item.textContent = `🎬 ${block.text || "Scene"}`;
      item.title = `Scene Divider: ${block.text} (Non-spoken • ${block.pause_after || 1.0}s pause)`;
      item.addEventListener("click", () => {
        selectBlock(idx);
        const r = document.querySelectorAll(".scene-divider-row, .block-row")[idx];
        if (r) r.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      container.appendChild(item);
      return;
    }

    const voice = getVoiceById(block.voice_id);
    const char = getCharacterById(block.character_id || block.speaker);
    const itemColor = (char && char.color) ? char.color : voice.color;
    const charLabel = char ? `${char.name}${block.is_custom_edited ? ' (Custom)' : ''}` : voice.name;
    const item = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isReady = Boolean(block.cachedAudioUrl || block.audio_url);
    const isActive = state.activeBlockIndex === idx;
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const row = document.querySelectorAll(".block-row")[idx];
    const isProcessing = row ? row.classList.contains("processing") : false;

    item.className = `timeline-block-item ${isReady ? "ready" : "pending"} ${isProcessing ? "processing" : ""} ${isActive ? "active" : ""} ${isPlaying ? "playing" : ""}`;
    item.style.backgroundColor = itemColor;
    item.textContent = block.text.slice(0, 25) + (block.text.length > 25 ? "..." : "");
    item.title = `Sentence ${idx + 1} [${isReady ? 'Ready' : 'Draft'} • ${charLabel}]: ${block.text}`;

    item.addEventListener("click", () => {
      selectBlock(idx);
      const r = document.querySelectorAll(".block-row")[idx];
      if (r) r.scrollIntoView({ behavior: "smooth", block: "center" });
      state.isPlayingStory = true;
      playBlockAudio(idx, 0, false);
    });

    container.appendChild(item);
  });

  updateStoryTimeDisplay();
}

// ---------------- BLOCK RENDERING PROGRESS TRACKER ---------------- //

const activeBlockProgressQueue = [];
const activeBlockProgressTrackers = new Map();
let _topBarPillTimer = null;

function updateTopBarRenderingPill(blockIdx, elapsedSec, pct) {
  clearTimeout(_topBarPillTimer);
  const btns = [
    document.getElementById("btn-engine-status"),
    document.getElementById("btn-dashboard-engine-status")
  ];
  btns.forEach(btn => {
    if (!btn) return;
    const label = btn.querySelector(".engine-label");
    if (label) {
      label.textContent = `⚡ Rendering #${blockIdx + 1} (${elapsedSec.toFixed(0)}s • ${pct}%)`;
    }
    btn.classList.add("gpu-rendering-pulse");
  });
}

function resetTopBarPill(tempFlashText = null) {
  const btns = [
    document.getElementById("btn-engine-status"),
    document.getElementById("btn-dashboard-engine-status")
  ];
  if (tempFlashText) {
    btns.forEach(btn => {
      if (!btn) return;
      btn.classList.remove("gpu-rendering-pulse");
      const label = btn.querySelector(".engine-label");
      if (label) label.textContent = tempFlashText;
    });
    clearTimeout(_topBarPillTimer);
    _topBarPillTimer = setTimeout(() => {
      updateEngineUI(state.config?.remote_worker_url, state.config?.remote_worker_enabled);
    }, 2800);
  } else {
    btns.forEach(btn => {
      if (!btn) return;
      btn.classList.remove("gpu-rendering-pulse");
    });
    updateEngineUI(state.config?.remote_worker_url, state.config?.remote_worker_enabled);
  }
}

function tickProgress(idx) {
  const tracker = activeBlockProgressTrackers.get(idx);
  if (!tracker || activeBlockProgressQueue[0] !== idx) return;

  const row = document.querySelector(`[data-index="${idx}"]`);
  if (!row) return;

  const fill = row.querySelector(".scrubber-fill");
  const timeText = row.querySelector(".scrubber-time");
  const elapsed = Math.max(0.1, (Date.now() - tracker.startTime) / 1000);

  let pct = 0;
  if (elapsed < tracker.expectedSec) {
    pct = Math.round((elapsed / tracker.expectedSec) * 88);
  } else {
    const overtime = elapsed - tracker.expectedSec;
    pct = Math.min(97, Math.round(88 + (9 * (1 - Math.exp(-overtime / 8)))));
  }
  pct = Math.max(4, Math.min(97, pct));

  if (fill) {
    fill.style.width = `${pct}%`;
  }

  let label = "⚡ Neural Speech Generating";
  if (tracker.mode === "dsp") {
    label = "⚡ Sculpting DSP Filters";
  } else if (elapsed < 1.6) {
    label = "🧠 Context & Voice Prompt";
  } else if (pct < 75) {
    label = "⚡ Dual-AR Neural Generating";
  } else if (pct < 90) {
    label = "🌊 HiFi-GAN Vocoder & Waveform";
  } else {
    label = "⏳ Finalizing Studio Master";
  }

  if (timeText) {
    timeText.innerHTML = `
      <span class="render-progress-label">
        ${label}
        <span class="render-progress-badge">${elapsed.toFixed(1)}s • ${pct}%</span>
      </span>
    `;
  }

  updateTopBarRenderingPill(idx, elapsed, pct);
}

function updateBlockQueueDisplay() {
  activeBlockProgressQueue.forEach((idx, qPos) => {
    const tracker = activeBlockProgressTrackers.get(idx);
    if (!tracker) return;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (!row) return;

    const track = row.querySelector(".scrubber-track");
    const fill = row.querySelector(".scrubber-fill");
    const timeText = row.querySelector(".scrubber-time");
    const playBtn = row.querySelector(".play-block-btn");
    const rerenderBtn = row.querySelector(".rerender-block-btn");

    row.classList.add("processing");
    row.classList.remove("ready", "playing");
    if (playBtn) playBtn.textContent = "⏳";
    if (rerenderBtn) rerenderBtn.textContent = "⏳";
    if (track) track.classList.add("processing-track");
    if (fill) fill.classList.add("processing-fill");

    const timelineItem = document.querySelectorAll(".timeline-block-item")[idx];
    if (timelineItem) timelineItem.classList.add("processing");

    if (qPos === 0) {
      // Actively running on GPU
      if (!tracker.startTime) {
        tracker.startTime = Date.now();
      }
      if (!tracker.timerId) {
        tracker.timerId = setInterval(() => tickProgress(idx), 100);
      }
      tickProgress(idx);
    } else {
      // Waiting in queue behind current GPU task
      if (tracker.timerId) {
        clearInterval(tracker.timerId);
        tracker.timerId = null;
      }
      if (fill) fill.style.width = "4%";
      if (timeText) {
        timeText.innerHTML = `
          <span class="render-progress-label">
            ⏳ In Queue (#${qPos})
            <span class="render-progress-badge">Waiting for GPU...</span>
          </span>
        `;
      }
    }
  });
}

function startBlockProgress(idx, options = {}) {
  if (idx === null || idx === undefined) return;
  const block = state.currentProject?.blocks?.[idx];
  const textLength = (block?.text || "").length;

  // Clean up any stale tracker
  if (activeBlockProgressTrackers.has(idx)) {
    const old = activeBlockProgressTrackers.get(idx);
    if (old.timerId) clearInterval(old.timerId);
    activeBlockProgressTrackers.delete(idx);
  }

  const qIdx = activeBlockProgressQueue.indexOf(idx);
  if (qIdx === -1) {
    activeBlockProgressQueue.push(idx);
  }

  // Realistic time estimation: baseline 4.5s + ~0.08s per character
  const isFish = (block?.engine === "fish_s2" || state.activeEngine === "fish_s2" || !state.isKokoroMode);
  const expectedSec = isFish
    ? Math.max(5, Math.min(50, Math.round(4.5 + (textLength * 0.08))))
    : Math.max(2, Math.min(20, Math.round(2.0 + (textLength * 0.025))));

  const tracker = {
    idx,
    mode: options.mode || "synthesize",
    startTime: null,
    expectedSec,
    timerId: null
  };
  activeBlockProgressTrackers.set(idx, tracker);
  updateBlockQueueDisplay();
}

function stopBlockProgress(idx, success = true, duration = null) {
  if (idx === null || idx === undefined) return;
  const tracker = activeBlockProgressTrackers.get(idx);
  let elapsedSec = null;

  if (tracker) {
    if (tracker.timerId) clearInterval(tracker.timerId);
    if (tracker.startTime) {
      elapsedSec = ((Date.now() - tracker.startTime) / 1000).toFixed(1);
    }
    activeBlockProgressTrackers.delete(idx);
  }

  const qIdx = activeBlockProgressQueue.indexOf(idx);
  if (qIdx !== -1) {
    activeBlockProgressQueue.splice(qIdx, 1);
  }

  const row = document.querySelector(`[data-index="${idx}"]`);
  const timelineItem = document.querySelectorAll(".timeline-block-item")[idx];
  if (timelineItem) timelineItem.classList.remove("processing");

  if (row) {
    row.classList.remove("processing");
    const track = row.querySelector(".scrubber-track");
    const fill = row.querySelector(".scrubber-fill");
    const timeText = row.querySelector(".scrubber-time");
    const playBtn = row.querySelector(".play-block-btn");
    const rerenderBtn = row.querySelector(".rerender-block-btn");

    if (track) track.classList.remove("processing-track");
    if (fill) {
      fill.classList.remove("processing-fill");
      fill.style.width = "0%";
    }
    if (rerenderBtn) rerenderBtn.textContent = "🔄";
    if (playBtn) playBtn.textContent = "▶";

    if (success) {
      row.classList.add("ready");
      if (timeText) {
        const durStr = duration ? `${duration.toFixed(1)}s` : "Ready";
        const speedBadge = elapsedSec ? `<span class="render-done-badge" title="Synthesized in ${elapsedSec}s">(${elapsedSec}s)</span>` : "";
        timeText.innerHTML = `● ${durStr} ${speedBadge}`;
      }
    } else {
      if (timeText) timeText.textContent = "Draft (click ▶ to retry)";
    }
  }

  if (activeBlockProgressQueue.length > 0) {
    updateBlockQueueDisplay();
  } else {
    resetTopBarPill(success && elapsedSec ? `✅ #${idx + 1} Ready (${elapsedSec}s)` : null);
  }
}

let _dspDebounceTimer = null;

function triggerInstantBlockDsp(targetIndices = null) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const rawList = targetIndices || (state.selectedBlockIndices && state.selectedBlockIndices.size > 0
    ? Array.from(state.selectedBlockIndices)
    : (typeof state.activeBlockIndex === "number" ? [state.activeBlockIndex] : []));
  const indices = Array.from(rawList).filter(idx => typeof idx === "number" && idx >= 0 && idx < state.currentProject.blocks.length);

  if (indices.length === 0) return;

  clearTimeout(_dspDebounceTimer);
  _dspDebounceTimer = setTimeout(async () => {
    const BATCH_SIZE = 6;
    for (let i = 0; i < indices.length; i += BATCH_SIZE) {
      const chunk = indices.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async idx => {
        const block = state.currentProject.blocks[idx];
        const audioSource = block?.cachedAudioUrl || block?.audio_url;
        if (!block || !audioSource) return;

        startBlockProgress(idx, { mode: "dsp" });

        try {
          const res = await fetch("/api/audio/apply_dsp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audio_url: audioSource,
              gain: block.gain || 1.0,
              speed: block.speed || 1.0,
              pitch_shift: block.pitch_shift || 0.0,
              warmth: block.warmth || 0.0,
              clarity: block.clarity || 0.0,
              reverb: block.reverb || 0.0,
              radio_fx: Boolean(block.radio_fx),
              fx_filter: block.fx_filter || (block.radio_fx ? "radio" : "none")
            })
          });

          const data = await res.json();
          if (data.ok && data.audio_url) {
            block.cachedAudioUrl = data.audio_url;
            block.audio_url = data.audio_url;
            block.duration = data.duration;
            block.cachedSig = getBlockSignature(block);
            stopBlockProgress(idx, true, data.duration);

            // If currently playing this block, update audio player seamlessly
            if (state.currentlyPlayingBlockIdx === idx && state.isPlayingStory && !state.storyAudioPlayer.paused) {
              const curTime = state.storyAudioPlayer.currentTime;
              state.storyAudioPlayer.src = data.audio_url;
              state.storyAudioPlayer.currentTime = Math.min(curTime, data.duration || curTime);
              state.storyAudioPlayer.play().catch(() => {});
            }
          } else {
            stopBlockProgress(idx, false);
          }
        } catch (err) {
          console.error("[InstantDSP] Error sculpting block:", err);
          stopBlockProgress(idx, false);
        }
      }));
    }
    debouncedSave();
    renderTimeline();
  }, 120);
}

function handleApplyInstantDspToActive() {
  triggerInstantBlockDsp();
}

async function handleResetActiveToRawVoice() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const rawList = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : [state.activeBlockIndex];
  const targets = rawList.filter(idx => typeof idx === "number" && idx >= 0 && idx < state.currentProject.blocks.length);

  let restoredCount = 0;
  for (const idx of targets) {
    const block = state.currentProject.blocks[idx];
    if (!block) continue;

    block.pitch_shift = 0.0;
    block.warmth = 0.0;
    block.clarity = 0.0;
    block.reverb = 0.0;
    block.radio_fx = false;
    block.fx_filter = "none";
    block.gain = 1.0;
    if (block.character_id) {
      block.is_custom_edited = true;
    }

    if (block.cachedAudioUrl) {
      try {
        const res = await fetch("/api/audio/reset_dsp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_url: block.cachedAudioUrl })
        });
        const data = await res.json();
        if (data.ok && data.audio_url) {
          block.cachedAudioUrl = data.audio_url;
          block.duration = data.duration;
          block.cachedSig = getBlockSignature(block);
          restoredCount++;
        }
      } catch (err) {
        console.error("[InstantDSP] Reset failed:", err);
      }
    }
  }

  // Sync sliders to 0
  const pitchSlider = document.getElementById("slider-pitch");
  if (pitchSlider) {
    pitchSlider.value = "0.0";
    const v = document.getElementById("val-pitch");
    if (v) v.textContent = "0.0 st";
  }
  const warmthSlider = document.getElementById("slider-warmth");
  if (warmthSlider) {
    warmthSlider.value = "0.0";
    const v = document.getElementById("val-warmth");
    if (v) v.textContent = "0.0 dB";
  }
  const claritySlider = document.getElementById("slider-clarity");
  if (claritySlider) {
    claritySlider.value = "0.0";
    const v = document.getElementById("val-clarity");
    if (v) v.textContent = "0.0 dB";
  }
  const reverbSlider = document.getElementById("slider-reverb");
  if (reverbSlider) {
    reverbSlider.value = "0";
    const v = document.getElementById("val-reverb");
    if (v) v.textContent = "0%";
  }

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`↺ Restored ${restoredCount || targets.length} sentence(s) to pure model speech!`);
}

function updateStoryTimeDisplay() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;

  let totalSec = 0;
  blocks.forEach(b => {
    if (b.type === "heading" || b.is_spoken === false) {
      totalSec += (b.pause_after || 1.0);
      return;
    }
    if (b.duration) {
      totalSec += b.duration;
    } else {
      const wc = (b.text || "").trim().split(/\s+/).filter(Boolean).length || 5;
      const speed = b.speed || 0.90;
      totalSec += (wc / 2.8) / speed + (b.pause_after || 0.6);
    }
  });

  let elapsedSec = 0;
  if (state.currentlyPlayingBlockIdx !== null) {
    for (let i = 0; i < state.currentlyPlayingBlockIdx; i++) {
      const b = blocks[i];
      if (b.type === "heading" || b.is_spoken === false) {
        elapsedSec += (b.pause_after || 1.0);
      } else {
        elapsedSec += b.duration || ((b.text || "").trim().split(/\s+/).length / 2.8 / (b.speed || 0.9));
      }
    }
    elapsedSec += state.storyAudioPlayer.currentTime || 0;
  }

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const displayEl = document.getElementById("master-time-display");
  if (displayEl) {
    displayEl.textContent = `${fmt(elapsedSec)} / ${fmt(totalSec)}`;
  }
}

function highlightTimelineBlock(idx) {
  document.querySelectorAll(".timeline-block-item").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    el.classList.toggle("playing", i === idx && state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused);
  });
}

// ---------------- AUDIO GENERATION & FULL STORY PLAYBACK ---------------- //

function prefetchNextBlock(idx) {
  const nextIdx = idx + 1;
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks[nextIdx]) return;
  const nextBlock = state.currentProject.blocks[nextIdx];
  if (nextBlock.type === "heading" || nextBlock.is_spoken === false) return;
  if (!nextBlock.text || !nextBlock.text.trim()) return;
  const sig = getBlockSignature(nextBlock);
  if (nextBlock.cachedAudioUrl && nextBlock.cachedSig === sig) {
    // Preload audio into memory cache so it plays instantly with zero delay on transition!
    const preloader = new Audio();
    preloader.preload = "auto";
    preloader.src = nextBlock.cachedAudioUrl;
    return;
  }

  const nextRow = document.querySelector(`[data-index="${nextIdx}"]`);

  fetch("/api/synthesize_block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBlockSynthesizePayload(nextBlock))
  })
    .then(r => {
      const cType = r.headers.get("content-type") || "";
      if (cType.includes("application/json")) {
        return r.json().catch(() => null);
      }
      return null;
    })
    .then(data => {
      if (data && data.audio_url) {
        if (data.tier_status) updateTierDisplay(data.tier_status);
        nextBlock.cachedAudioUrl = data.audio_url;
        nextBlock.cachedSig = sig;
        nextBlock.duration = data.duration;
        debouncedSave();
        if (nextRow) nextRow.classList.add("ready");
      }
    })
    .catch(() => {});
}

function updatePlaybackUI(idx, isPlaying) {
  const masterBtn = document.getElementById("master-play-btn");
  if (masterBtn) {
    masterBtn.textContent = isPlaying ? "⏸" : "▶";
    masterBtn.classList.toggle("playing", isPlaying);
  }
  const allRows = document.querySelectorAll(".block-row, .scene-divider-row");
  allRows.forEach((r, i) => {
    const pb = r.querySelector(".play-block-btn");
    if (i === idx) {
      r.classList.toggle("playing", isPlaying);
      if (pb) pb.textContent = isPlaying ? "🔊" : "▶";
    } else {
      r.classList.remove("playing");
      if (pb && pb.textContent !== "⏳") pb.textContent = "▶";
    }
  });
  if (idx !== null && idx !== undefined) {
    highlightTimelineBlock(idx);
    updateActiveSentenceHint(idx);
  }
}

async function playBlockAudio(idx, targetOffset = 0, isAutoContinuation = false, forceReload = false) {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }

  const block = state.currentProject?.blocks?.[idx];
  if (!block) {
    stopStoryPlayback();
    return;
  }

  // Non-spoken Scene Heading / Section Divider
  if (block.type === "heading" || block.is_spoken === false) {
    selectBlock(idx, "single");
    state.currentlyPlayingBlockIdx = idx;
    updatePlaybackUI(idx, true);

    if (state.isPlayingStory) {
      const pauseGap = Math.max((block.pause_after !== undefined ? block.pause_after : 1.0) * 1000, 300);
      state.nextSentenceTimer = setTimeout(() => {
        if (state.isPlayingStory) {
          if (idx + 1 < (state.currentProject?.blocks?.length || 0)) {
            playBlockAudio(idx + 1, 0, true);
          } else {
            stopStoryPlayback();
          }
        }
      }, pauseGap);
    } else {
      showToast(`🎬 Scene Divider: "${block.text || 'Section'}" (Non-spoken • ${(block.pause_after || 1.0).toFixed(1)}s pause)`);
      setTimeout(() => updatePlaybackUI(idx, false), 800);
    }
    return;
  }

  if (!block.text || !block.text.trim()) {
    if (state.isPlayingStory && idx + 1 < (state.currentProject?.blocks?.length || 0)) {
      playBlockAudio(idx + 1, 0, true);
    } else {
      stopStoryPlayback();
    }
    return;
  }

  // Stop any voice preview sample from the library
  if (!state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    document.querySelectorAll(".preview-voice-btn").forEach(b => b.textContent = "▶ Sample");
  }

  // If already playing this exact block and targetOffset provided, seek smoothly
  if (state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused && targetOffset > 0) {
    if (state.storyAudioPlayer.duration) {
      state.storyAudioPlayer.currentTime = targetOffset;
      return;
    }
  }

  selectBlock(idx, "single");
  state.currentlyPlayingBlockIdx = idx;

  const row = document.querySelector(`[data-index="${idx}"]`);
  const btnEl = row ? row.querySelector(".play-block-btn") : null;
  const currentSig = getBlockSignature(block);

  const startPlayback = (audioUrl, duration, forceFresh = false) => {
    if (duration) block.duration = duration;

    // Normalize target & current URLs
    const targetUrl = new URL(audioUrl, window.location.origin).href;
    const currentUrl = state.storyAudioPlayer.src ? new URL(state.storyAudioPlayer.src, window.location.origin).href : "";

    // Track is the same ONLY if not forced, exact URLs (including any query parameters) match, player has a source, and player is NOT in error state
    const isSameTrack = (!forceFresh && !forceReload && currentUrl === targetUrl && Boolean(state.storyAudioPlayer.src) && !state.storyAudioPlayer.error);

    if (row) {
      row.classList.remove("processing");
    }

    if (!isSameTrack) {
      try { state.storyAudioPlayer.pause(); } catch (_) {}
      state.storyAudioPlayer.src = targetUrl;
      state.storyAudioPlayer.load();
    }

    if (targetOffset > 0) {
      if (state.storyAudioPlayer.readyState >= 1) {
        try { state.storyAudioPlayer.currentTime = targetOffset; } catch (_) {}
      } else {
        const seekOnce = () => {
          try { state.storyAudioPlayer.currentTime = targetOffset; } catch (_) {}
        };
        state.storyAudioPlayer.addEventListener("loadedmetadata", seekOnce, { once: true });
      }
    }

    state.isPlayingStory = true;
    const playPromise = state.storyAudioPlayer.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        updatePlaybackUI(idx, true);
      }).catch(err => {
        if (err.name === "AbortError") {
          // AbortError is normal when switching tracks or pausing. Not a failure.
          return;
        }
        if (err.name === "NotSupportedError") {
          // Source was just set and browser media engine is still buffering.
          // Wait for canplay event to seamlessly start playback.
          const onCanPlay = () => {
            state.storyAudioPlayer.play().then(() => updatePlaybackUI(idx, true)).catch(() => {});
          };
          state.storyAudioPlayer.addEventListener("canplay", onCanPlay, { once: true });
          return;
        }
        console.warn("Audio play prevented:", err);
        updatePlaybackUI(idx, false);
      });
    }

    prefetchNextBlock(idx);

    state.storyAudioPlayer.ontimeupdate = () => {
      if (state.currentlyPlayingBlockIdx !== idx) return;
      const cur = state.storyAudioPlayer.currentTime || 0;
      const dur = state.storyAudioPlayer.duration || block.duration || 1;
      const pct = Math.min((cur / dur) * 100, 100);

      const curRow = document.querySelector(`[data-index="${idx}"]`);
      if (curRow) {
        const fill = curRow.querySelector(".scrubber-fill");
        const timeText = curRow.querySelector(".scrubber-time");
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
        if (timeText) timeText.textContent = `${cur.toFixed(1)}s / ${dur.toFixed(1)}s`;
      }
      updateStoryTimeDisplay();
    };

    state.storyAudioPlayer.onended = () => {
      const curRow = document.querySelector(`[data-index="${idx}"]`);
      if (curRow) {
        curRow.classList.remove("playing");
        const fill = curRow.querySelector(".scrubber-fill");
        if (fill) fill.style.width = "0%";
        const timeText = curRow.querySelector(".scrubber-time");
        if (timeText && block.duration) timeText.textContent = `● ${block.duration.toFixed(1)}s`;
        const pb = curRow.querySelector(".play-block-btn");
        if (pb) pb.textContent = "▶";
      }

      if (state.isPlayingStory) {
        if (idx + 1 < state.currentProject.blocks.length) {
          const pauseGap = Math.max((block.pause_after || 0.6) * 1000, 120);
          state.nextSentenceTimer = setTimeout(() => {
            if (state.isPlayingStory) {
              playBlockAudio(idx + 1, 0, true);
            }
          }, pauseGap);
        } else {
          stopStoryPlayback();
        }
      } else {
        stopStoryPlayback();
      }
    };
  };

  // Cached playback: if audio is already available, play it directly!
  // (forceReload forces the HTML5 audio element to reload from network instead of using old buffer)
  if (block.cachedAudioUrl || block.audio_url) {
    let audioUrl = block.cachedAudioUrl || block.audio_url;
    if (audioUrl && audioUrl.startsWith("blob:")) {
      audioUrl = block.hash ? `/api/audio/${block.hash}.wav` : "";
      if (audioUrl) {
        block.cachedAudioUrl = audioUrl;
        block.audio_url = audioUrl;
      } else {
        delete block.cachedAudioUrl;
        delete block.audio_url;
      }
    }
    if (audioUrl) {
      startPlayback(audioUrl, block.duration, forceReload);
      return;
    }
  }

  // Smart take cache fallback check: if take_cache has audio for this block's voice, play it directly!
  if (!block.cachedAudioUrl && !block.audio_url) {
    const matchingTake = (typeof findMatchingTake === "function") ? findMatchingTake(block) : null;
    if (matchingTake && matchingTake.audio_url) {
      let takeUrl = matchingTake.audio_url;
      if (takeUrl && takeUrl.startsWith("blob:")) {
        takeUrl = block.hash ? `/api/audio/${block.hash}.wav` : "";
        if (takeUrl) {
          matchingTake.audio_url = takeUrl;
        } else {
          delete matchingTake.audio_url;
        }
      }
      if (takeUrl) {
        block.cachedAudioUrl = takeUrl;
        block.audio_url = takeUrl;
        block.duration = matchingTake.duration;
        block.cachedSig = currentSig;
        startPlayback(takeUrl, matchingTake.duration, forceReload);
        return;
      }
    }
  }

  // Synthesize on demand
  startBlockProgress(idx, { mode: "synthesize" });

  const activeEng = block.engine || state.currentProject?.engine || state.activeEngine || "fish_s2";
  if (activeEng === "kokoro" && window.KokoroClient && window.KokoroClient.isClientKokoroEnabled()) {
    try {
      const char = getCharacterById(block.character_id || block.speaker);
      let chosenVoiceId = block.voice_id || (char && (char.voice_id || char.assigned_voice_id)) || "af_bella";
      if (!chosenVoiceId || chosenVoiceId.startsWith("fish_") || chosenVoiceId.includes("Neural")) {
        chosenVoiceId = "af_bella";
      }
      const clientRes = await window.KokoroClient.synthesizeOnClient(block.text, {
        voice: chosenVoiceId,
        speed: Number(block.speed || 1.0)
      });
      if (clientRes && clientRes.audioUrl) {
        const permanentUrl = `/api/audio/${clientRes.hash}.wav`;
        block.cachedAudioUrl = permanentUrl;
        block.audio_url = permanentUrl;
        block.cachedSig = currentSig;
        block.duration = clientRes.duration;
        block.hash = clientRes.hash;
        if (!block.take_cache) block.take_cache = {};
        block.take_cache[currentSig] = {
          audio_url: permanentUrl,
          duration: clientRes.duration,
          cachedSig: currentSig,
          timestamp: Date.now()
        };
        debouncedSave();
        renderTimeline();
        stopBlockProgress(idx, true, clientRes.duration);
        startPlayback(clientRes.audioUrl, clientRes.duration, false);
        window.KokoroClient.syncClientAudioToServer(clientRes.blob, clientRes.hash, {
          project_id: state.currentProject?.id,
          block_id: block.id,
          duration: clientRes.duration
        });
        return;
      }
    } catch (clientErr) {
      console.warn("[KokoroClient] Browser WebGPU synthesis fallback to server:", clientErr);
    }
  }

  try {
    const res = await fetch("/api/synthesize_block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBlockSynthesizePayload(block))
    });

    let data = null;
    const cType = res.headers.get("content-type") || "";
    if (cType.includes("application/json")) {
      data = await res.json().catch(() => null);
    }
    if (!data) {
      const rawText = await res.text().catch(() => "");
      throw new Error(`Server returned HTTP ${res.status}${rawText ? `: ${rawText.slice(0, 120)}` : ""}`);
    }

    if (data.audio_url) {
      if (data.tier_status) updateTierDisplay(data.tier_status);
      block.cachedAudioUrl = data.audio_url;
      block.audio_url = data.audio_url;
      block.cachedSig = currentSig;
      block.duration = data.duration;
      saveCurrentTakeToBlockCache(block);
      debouncedSave();
      renderTimeline();
      stopBlockProgress(idx, true, data.duration);
      startPlayback(data.audio_url, data.duration, false);
    } else {
      throw new Error(data.error || "Synthesis failed");
    }
  } catch (err) {
    stopBlockProgress(idx, false);
    if (btnEl) btnEl.textContent = "▶";
    updatePlaybackUI(idx, false);
    if (state.isPlayingStory) {
      stopStoryPlayback();
    }
    showToast(`⚠️ Could not synthesize Sentence #${idx + 1}: ${err.message || err}`, 6000);
  }
}


// Force re-render a single block with fresh neural take (bypasses cache)
async function handleReRenderBlock(idx) {
  if (idx === null || idx === undefined) return;
  const block = state.currentProject?.blocks?.[idx];
  if (!block) return;

  state.inFlightRerender = state.inFlightRerender || new Set();
  if (state.inFlightRerender.has(idx)) {
    console.warn(`[ReRender] Block #${idx + 1} is already rendering. Ignoring duplicate click.`);
    return;
  }
  state.inFlightRerender.add(idx);

  // Stop any active audio play on storyAudioPlayer first to prevent Chrome AbortError
  if (state.storyAudioPlayer) {
    try {
      state.storyAudioPlayer.pause();
      state.storyAudioPlayer.removeAttribute("src");
      state.storyAudioPlayer.load();
    } catch (_) {}
  }
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }

  selectBlock(idx, "single");

  // Explicitly purge previous take for this signature from memory take_cache
  const currentSig = getBlockSignature(block);
  if (block.take_cache) {
    delete block.take_cache[currentSig];
  }
  if (blockDiskCacheTimers.has(idx)) {
    clearTimeout(blockDiskCacheTimers.get(idx));
    blockDiskCacheTimers.delete(idx);
  }

  delete block.cachedAudioUrl;
  delete block.audio_url;
  delete block.cachedSig;
  delete block.duration;
  delete block.audio_hash;
  delete block.rawAudioUrl;
  delete block.raw_audio_url;

  const rowEl = document.querySelector(`[data-index="${idx}"]`);
  if (rowEl) {
    rowEl.classList.remove("ready", "playing");
    rowEl.classList.add("processing");
    const timeText = rowEl.querySelector(".scrubber-time");
    if (timeText) timeText.textContent = "Draft (re-rendering fresh take...)";
    const fill = rowEl.querySelector(".scrubber-fill");
    if (fill) fill.style.width = "0%";
    const playBtn = rowEl.querySelector(".play-block-btn");
    if (playBtn) playBtn.textContent = "▶";
  }

  startBlockProgress(idx, { mode: "rerender" });

  try {
    showToast(`🔄 Generating fresh take for Sentence #${idx + 1}...`);
    const res = await fetch("/api/synthesize_block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBlockSynthesizePayload(block, true))
    });

    let data = null;
    const cType = res.headers.get("content-type") || "";
    if (cType.includes("application/json")) {
      data = await res.json().catch(() => null);
    }
    if (!data) {
      const rawText = await res.text().catch(() => "");
      throw new Error(`Server returned HTTP ${res.status}${rawText ? `: ${rawText.slice(0, 120)}` : ""}`);
    }

    if (data.audio_url) {
      if (data.tier_status) updateTierDisplay(data.tier_status);
      block.cachedAudioUrl = data.audio_url;
      block.audio_url = data.audio_url;
      block.cachedSig = getBlockSignature(block);
      block.duration = data.duration;
      saveCurrentTakeToBlockCache(block);
      debouncedSave();
      renderTimeline();
      stopBlockProgress(idx, true, data.duration);
      showToast(`✨ Fresh take generated for Sentence #${idx + 1} (${data.duration.toFixed(1)}s)!`);
      
      // Auto-play the fresh take directly with forced reload
      playBlockAudio(idx, 0, false, true);
    } else {
      throw new Error(data.error || "Synthesis failed");
    }
  } catch (err) {
    console.error("Re-render error:", err);
    stopBlockProgress(idx, false);
    showToast("❌ Re-render failed: " + (err.message || err));
  } finally {
    state.inFlightRerender.delete(idx);
  }
}

function pauseStoryPlayback() {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }
  state.isPlayingStory = false;
  state.storyAudioPlayer.pause();
  updatePlaybackUI(state.currentlyPlayingBlockIdx, false);
}

function stopStoryPlayback() {
  if (state.nextSentenceTimer) {
    clearTimeout(state.nextSentenceTimer);
    state.nextSentenceTimer = null;
  }
  state.isPlayingStory = false;
  state.storyAudioPlayer.pause();
  state.storyAudioPlayer.currentTime = 0;
  const curIdx = state.currentlyPlayingBlockIdx;
  state.currentlyPlayingBlockIdx = null;

  updatePlaybackUI(curIdx, false);
  document.querySelectorAll(".block-row.playing").forEach(r => r.classList.remove("playing"));
  document.querySelectorAll(".play-block-btn").forEach(b => b.textContent = "▶");
  document.querySelectorAll(".timeline-block-item.playing").forEach(t => t.classList.remove("playing"));
  document.querySelectorAll(".scrubber-fill").forEach(f => f.style.width = "0%");
  updateStoryTimeDisplay();
}

function handleMasterStop() {
  stopStoryPlayback();
}

function handleMasterPlayToggle() {
  // If actively playing audio -> Pause
  if (!state.storyAudioPlayer.paused && state.storyAudioPlayer.currentTime > 0) {
    pauseStoryPlayback();
    return;
  }

  const total = state.currentProject?.blocks?.length || 0;
  if (total === 0) return;

  // Determine target block index
  const targetIdx = (typeof state.currentlyPlayingBlockIdx === "number" && state.currentlyPlayingBlockIdx >= 0 && state.currentlyPlayingBlockIdx < total)
    ? state.currentlyPlayingBlockIdx
    : ((typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < total)
      ? state.activeBlockIndex
      : 0);

  // If paused mid-track on this target, resume from current position
  if (state.currentlyPlayingBlockIdx === targetIdx && state.storyAudioPlayer.src && !state.storyAudioPlayer.ended && state.storyAudioPlayer.currentTime > 0) {
    state.isPlayingStory = true;
    state.storyAudioPlayer.play().then(() => {
      updatePlaybackUI(targetIdx, true);
    }).catch(() => {
      playBlockAudio(targetIdx, 0, false);
    });
    return;
  }

  // Otherwise start block playback from beginning
  state.isPlayingStory = true;
  playBlockAudio(targetIdx, 0, false);
}

function handleMasterPrev() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  if (state.storyAudioPlayer.currentTime > 1.5) {
    state.storyAudioPlayer.currentTime = 0;
    return;
  }
  const cur = (typeof state.currentlyPlayingBlockIdx === "number")
    ? state.currentlyPlayingBlockIdx
    : (typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0);
  const prevIdx = Math.max(0, cur - 1);
  selectBlock(prevIdx, "single");
  state.isPlayingStory = true;
  playBlockAudio(prevIdx, 0, false);
}

function handleMasterNext() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  const total = state.currentProject.blocks.length;
  const cur = (typeof state.currentlyPlayingBlockIdx === "number")
    ? state.currentlyPlayingBlockIdx
    : (typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0);
  const nextIdx = Math.min(total - 1, cur + 1);
  selectBlock(nextIdx, "single");
  state.isPlayingStory = true;
  playBlockAudio(nextIdx, 0, false);
}

// ---------------- PARALLEL GPU BATCH GENERATOR & LIVE ETA ---------------- //

function formatBatchDuration(totalSec) {
  if (isNaN(totalSec) || totalSec <= 0) return "00:00";
  const sec = Math.floor(totalSec % 60);
  const min = Math.floor((totalSec / 60) % 60);
  const hrs = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}h ${pad(min)}m ${pad(sec)}s`;
  }
  return `${pad(min)}:${pad(sec)}`;
}

let batchTimerInterval = null;

async function toggleBatchRender() {
  const batchBtn = document.getElementById("btn-batch-generate");
  const banner = document.getElementById("batch-progress-banner");
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) return;

  // STOPPING IF ALREADY RUNNING
  if (state.isBatchRunning) {
    state.isBatchRunning = false;
    clearInterval(batchTimerInterval);
    if (batchBtn) {
      batchBtn.classList.remove("stopping");
      const isOnline = Boolean(state.config.active && state.config.remote_worker_url);
      batchBtn.textContent = isOnline ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }
    if (banner) banner.style.display = "none";
    showToast("⏹ Batch rendering stopped.");
    return;
  }

  // STARTING BATCH RENDER
  state.isBatchRunning = true;
  const blocks = state.currentProject.blocks;
  const total = blocks.length;

  // Concurrency: strictly 1-by-1 for Fish Speech S2 Pro GPU
  const isGPU = Boolean(state.config.active && state.config.remote_worker_url);
  const concurrency = 1;

  // Filter tasks that actually need rendering (skip already cached)
  const tasksToRender = [];
  let alreadyCachedCount = 0;

  for (let i = 0; i < total; i++) {
    const block = blocks[i];
    if (block.type === "heading" || block.is_spoken === false) {
      alreadyCachedCount++;
      continue;
    }
    if (block.cachedAudioUrl || block.audio_url) {
      alreadyCachedCount++;
      const row = document.querySelector(`[data-index="${i}"]`);
      if (row) {
        row.classList.add("ready");
        row.classList.remove("processing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText && block.duration) timeText.textContent = `● ${block.duration.toFixed(1)}s`;
      }
    } else {
      tasksToRender.push(i);
    }
  }

  if (tasksToRender.length === 0) {
    state.isBatchRunning = false;
    showToast("✓ All sentences are already rendered!");
    if (batchBtn) batchBtn.textContent = "✓ All Rendered";
    setTimeout(() => {
      batchBtn.textContent = isGPU ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }, 2000);
    return;
  }

  // Setup UI HUD
  if (batchBtn) batchBtn.classList.add("stopping");
  if (banner) banner.style.display = "flex";

  const bannerTitle = document.getElementById("batch-banner-title");
  const concurrencyTag = document.getElementById("batch-banner-concurrency-tag");
  const countsEl = document.getElementById("batch-banner-counts");
  const elapsedEl = document.getElementById("batch-stat-elapsed");
  const etaEl = document.getElementById("batch-stat-eta");
  const speedEl = document.getElementById("batch-stat-speed");
  const progressFill = document.getElementById("batch-progress-bar-fill");

  if (bannerTitle) bannerTitle.textContent = `Batch Synthesizing ${total} Sentences`;
  if (concurrencyTag) {
    concurrencyTag.textContent = "🚀 Sequential (Fish S2 Pro GPU)";
  }

  // State trackers
  const startTime = Date.now();
  let newlyRenderedCount = 0;
  let taskIndex = 0;

  function updateHUD() {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
    const completedTotal = alreadyCachedCount + newlyRenderedCount;
    const pct = Math.min(100, (completedTotal / total) * 100).toFixed(1);

    if (elapsedEl) elapsedEl.textContent = formatBatchDuration(elapsedSec);
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (countsEl) {
      countsEl.textContent = `${completedTotal} / ${total} completed (${pct}%) • ${tasksToRender.length - newlyRenderedCount} remaining`;
    }

    if (newlyRenderedCount >= 1) {
      const rate = newlyRenderedCount / elapsedSec; // sentences per second
      const remainingTasks = Math.max(0, tasksToRender.length - newlyRenderedCount);
      const etaSec = Math.round(remainingTasks / rate);
      const etaFormatted = formatBatchDuration(etaSec);

      if (etaEl) etaEl.textContent = `~${etaFormatted} left`;
      if (speedEl) speedEl.textContent = `${rate.toFixed(1)} sent/s (${(1 / rate).toFixed(2)}s/sent)`;
      if (batchBtn) batchBtn.textContent = `⏹ Stop (${completedTotal}/${total}) • ETA ${etaFormatted}`;
    } else {
      if (etaEl) etaEl.textContent = "Calculating...";
      if (speedEl) speedEl.textContent = "Warming up...";
      if (batchBtn) batchBtn.textContent = `⏹ Stop (${completedTotal}/${total})`;
    }
  }

  updateHUD();
  clearInterval(batchTimerInterval);
  batchTimerInterval = setInterval(() => {
    if (state.isBatchRunning) updateHUD();
  }, 1000);

  // Single sentence render function
  async function renderBlockByIndex(idx) {
    const block = blocks[idx];
    const currentSig = getBlockSignature(block);

    startBlockProgress(idx, { mode: "batch" });

    try {
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBlockSynthesizePayload(block))
      });

      let data = null;
      const cType = res.headers.get("content-type") || "";
      if (cType.includes("application/json")) {
        data = await res.json().catch(() => null);
      }
      if (!data) {
        const rawText = await res.text().catch(() => "");
        throw new Error(`Server returned HTTP ${res.status}${rawText ? `: ${rawText.slice(0, 120)}` : ""}`);
      }

      if (data.audio_url) {
        if (data.tier_status) updateTierDisplay(data.tier_status);
        block.cachedAudioUrl = data.audio_url;
        block.audio_url = data.audio_url;
        block.cachedSig = currentSig;
        if (data.duration) block.duration = data.duration;
        saveCurrentTakeToBlockCache(block);
        debouncedSave();
        stopBlockProgress(idx, true, data.duration);
        return true;
      } else {
        console.error(`Synthesis error for block ${idx}:`, data.error);
        stopBlockProgress(idx, false);
        if (data.needs_worker || (data.error && data.error.includes("worker"))) {
          showToast(`⚠️ Cloud GPU Worker offline: ${data.error}`, 5000);
          state.isBatchRunning = false;
        }
        return false;
      }
    } catch (err) {
      console.error(`Error rendering sentence ${idx}:`, err);
      stopBlockProgress(idx, false);
      return false;
    }
  }

  // Concurrent worker loop
  async function runWorker(workerId) {
    while (taskIndex < tasksToRender.length && state.isBatchRunning) {
      const currentTaskIndex = taskIndex++;
      const blockIdx = tasksToRender[currentTaskIndex];
      if (blockIdx === undefined) break;

      const ok = await renderBlockByIndex(blockIdx);
      if (ok) newlyRenderedCount++;
      updateHUD();
      renderTimeline();
      updateStoryTimeDisplay();
    }
  }

  // Launch parallel worker pool
  const activeWorkers = [];
  const actualConcurrency = Math.min(concurrency, tasksToRender.length);
  for (let c = 0; c < actualConcurrency; c++) {
    activeWorkers.push(runWorker(c + 1));
  }

  await Promise.all(activeWorkers);

  // Completion
  clearInterval(batchTimerInterval);
  const wasStopped = !state.isBatchRunning;
  state.isBatchRunning = false;

  if (batchBtn) {
    batchBtn.classList.remove("stopping");
    batchBtn.textContent = wasStopped ? "⏹ Stopped" : "✓ All Rendered!";
    setTimeout(() => {
      const isOnline = Boolean(state.config.active && state.config.remote_worker_url);
      batchBtn.textContent = isOnline ? "⚡ Render All (GPU)" : "⚡ Render All (1 by 1)";
    }, 3000);
  }

  if (banner) {
    if (!wasStopped) {
      if (progressFill) progressFill.style.width = "100%";
      if (countsEl) countsEl.textContent = `✓ All ${total} sentences successfully synthesized and cached!`;
      if (etaEl) etaEl.textContent = "Done! (0s)";
      setTimeout(() => {
        banner.style.display = "none";
      }, 4000);
    } else {
      banner.style.display = "none";
    }
  }

  renderTimeline();
  updateStoryTimeDisplay();
  if (!wasStopped) {
    const totalDurationStr = formatBatchDuration((Date.now() - startTime) / 1000);
    showToast(`✓ All ${tasksToRender.length} sentences rendered in ${totalDurationStr}!`);
  }
}

// ---------------- VOICE LIBRARY SIDEBAR DRAWER & FISH AUDIO DISCOVERY ---------------- //

let _drawerCurrentMode = "fish"; // "fish", "browse", "create", "cast", "edit"
let _fishSearchDebounce = null;

function openVoiceDrawer(targetBlockIdx = null, preferredMode = null) {
  state.targetBlockForVoice = targetBlockIdx !== null ? targetBlockIdx : state.activeBlockIndex;
  const drawer = document.getElementById("voice-drawer");
  const win = document.getElementById("voice-drawer-window");
  if (drawer) {
    drawer.classList.add("active");
  }

  // Auto-expand on desktop screens for full Voice Discovery portal layout
  const isExp = localStorage.getItem("fish_drawer_expanded") !== "false";
  if (isExp && window.innerWidth >= 1024) {
    if (drawer) drawer.classList.add("expanded");
    if (win) win.classList.add("expanded");
    updateDrawerSizeBtn(true);
  } else {
    if (drawer) drawer.classList.remove("expanded");
    if (win) win.classList.remove("expanded");
    updateDrawerSizeBtn(false);
  }

  // Auto-detect engine for target block or character
  if (!preferredMode) {
    const targetIdx = state.targetBlockForVoice !== null && state.targetBlockForVoice !== undefined
      ? state.targetBlockForVoice
      : state.activeBlockIndex;
    const targetBlock = state.currentProject?.blocks?.[targetIdx];
    const eng = targetBlock?.engine || state.currentProject?.engine || state.activeEngine || "fish_s2";
    if (eng === "kokoro") {
      preferredMode = "kokoro";
    } else if (eng === "edge_tts") {
      preferredMode = "edge";
    } else if (eng === "elevenlabs") {
      preferredMode = "elevenlabs";
    } else if (eng === "cartesia") {
      preferredMode = "cartesia";
    } else if (eng === "openai") {
      preferredMode = "openai";
    } else {
      preferredMode = "fish_speech";
    }
  }

  // Ensure all drawer tabs are visible and accessible
  document.querySelectorAll(".drawer-tab-btn").forEach(el => {
    el.style.display = "inline-flex";
  });

  switchDrawerMode(preferredMode);
}

function openVoiceDrawerForCharacter(preferredMode = null) {
  state.selectingVoiceForChar = true;
  if (!preferredMode) {
    const eng = state.editingCharModalEngine || state.activeEngine || "fish_s2";
    if (eng === "kokoro") preferredMode = "kokoro";
    else if (eng === "edge_tts") preferredMode = "edge";
    else if (eng === "elevenlabs") preferredMode = "elevenlabs";
    else if (eng === "cartesia") preferredMode = "cartesia";
    else if (eng === "openai") preferredMode = "openai";
    else preferredMode = "fish_speech";
  }
  openVoiceDrawer(null, preferredMode);
}
window.openVoiceDrawerForCharacter = openVoiceDrawerForCharacter;

function closeVoiceDrawer() {
  const drawer = document.getElementById("voice-drawer");
  if (drawer) {
    drawer.classList.remove("active");
  }
  state.selectingVoiceForChar = false;
  if (state.sampleAudioPlayer && !state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    state.playingVoiceSampleId = null;
  }
  if (state.fishLibrary && state.fishLibrary.activePlayingId) {
    const playBtn = document.getElementById(`fish-play-btn-${state.fishLibrary.activePlayingId}`);
    if (playBtn) {
      playBtn.classList.remove("playing");
      playBtn.innerHTML = "▶ Sample";
    }
    state.fishLibrary.activePlayingId = null;
  }
}

function toggleDrawerExpanded() {
  const drawer = document.getElementById("voice-drawer");
  const win = document.getElementById("voice-drawer-window");
  if (!drawer) return;
  const willExpand = !drawer.classList.contains("expanded");
  drawer.classList.toggle("expanded", willExpand);
  if (win) win.classList.toggle("expanded", willExpand);
  localStorage.setItem("fish_drawer_expanded", willExpand ? "true" : "false");
  updateDrawerSizeBtn(willExpand);
}

function updateDrawerSizeBtn(isExpanded) {
  const icon = document.getElementById("drawer-size-icon");
  const text = document.getElementById("drawer-size-text");
  if (icon) icon.textContent = isExpanded ? "⤡" : "⤢";
  if (text) text.textContent = isExpanded ? "Sidebar" : "Wide";
}

function handleVoiceDrawerBackdropClick(event) {
  if (event && event.target && event.target.id === "voice-drawer") {
    closeVoiceDrawer();
  }
}

function switchDrawerMode(mode = "fish") {
  _drawerCurrentMode = mode;
  const viewFish = document.getElementById("drawer-view-fish");
  const viewBrowse = document.getElementById("drawer-view-browse");
  const viewCreate = document.getElementById("drawer-view-create");
  const viewEdit = document.getElementById("drawer-view-edit");
  const backBtn = document.getElementById("drawer-btn-back");
  const titleEl = document.getElementById("drawer-main-title");
  const countBadge = document.getElementById("drawer-voices-count");

  // Update tabs active state
  document.querySelectorAll(".drawer-tab-btn").forEach(b => b.classList.remove("active"));
  const tabBtn = document.getElementById(`tab-nav-${mode}`);
  if (tabBtn) {
    tabBtn.classList.add("active");
    try {
      tabBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    } catch (e) {}
  }

  // Deactivate all subviews first
  [viewFish, viewBrowse, viewCreate, viewEdit].forEach(v => {
    if (v) {
      v.classList.remove("active");
      v.style.removeProperty("display");
      v.style.removeProperty("flex-direction");
    }
  });

  // Reset secondary attribute filter & search when switching tabs
  state.activeFilter = "all";
  document.querySelectorAll("#drawer-filter-pills .filter-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.filter === "all");
  });
  const searchInput = document.getElementById("drawer-search");
  if (searchInput) searchInput.value = "";
  state.searchQuery = "";

  if (mode === "edge") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🌐 Microsoft Edge TTS Library";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "kokoro") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "⚡ Kokoro 82M Voice Library";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "fish_speech") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🎭 Fish Speech Drama 3 Library";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "elevenlabs") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🌟 ElevenLabs Premier Voices (v4 / Flash)";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "cartesia") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "⚡ Cartesia Sonic Ultra-Fast Voices (Sonic 3.6/4)";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "openai") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🤖 OpenAI Audio Voices (gpt-4o-mini / tts-1)";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "fish") {
    if (viewFish) viewFish.classList.add("active");
    if (titleEl) titleEl.textContent = "🌟 Fish Audio Discovery";
    if (countBadge) countBadge.textContent = "2M+ Voices";
    if (backBtn) backBtn.style.display = "none";
    loadFishLibraryExplore();
  } else if (mode === "browse") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "💾 My Saved Library";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "cast") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🎭 Project Cast";
    if (backBtn) backBtn.style.display = "none";
    renderVoiceList();
  } else if (mode === "create") {
    if (viewCreate) viewCreate.classList.add("active");
    if (titleEl) titleEl.textContent = "✨ Create / Clone Voice";
    if (countBadge) countBadge.textContent = "Clone Studio";
    if (backBtn) {
      backBtn.style.display = "inline-flex";
      backBtn.onclick = () => switchDrawerMode("fish");
    }
  } else if (mode === "edit") {
    if (viewEdit) viewEdit.classList.add("active");
    if (titleEl) titleEl.textContent = "✏️ Edit Voice";
    if (backBtn) {
      backBtn.style.display = "inline-flex";
      backBtn.onclick = () => switchDrawerMode("browse");
    }
  }
}

// ---------------- FISH AUDIO 2M+ DISCOVERY PORTAL FUNCTIONS ---------------- //

async function loadFishLibraryExplore() {
  const container = document.getElementById("fish-discovery-content");
  if (!container) return;

  if (state.fishLibrary.exploreData && !state.fishLibrary.query && state.fishLibrary.tag === "all") {
    renderFishExploreRails(state.fishLibrary.exploreData);
    return;
  }

  container.innerHTML = `
    <div class="fish-loading-state">
      <div class="spinner"></div>
      <div style="margin-top: 14px; font-size: 13.5px; color: var(--text-muted); font-weight: 500;">
        Connecting to Fish Audio Cloud (2M+ Models)...
      </div>
    </div>
  `;

  try {
    const res = await fetch("/api/fish_library/explore");
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to load Fish Audio discovery voices");
    }
    state.fishLibrary.exploreData = data;
    renderFishExploreRails(data);
  } catch (err) {
    console.error("Fish Audio Explore error:", err);
    container.innerHTML = `
      <div class="fish-empty-state">
        <div style="font-size: 32px; margin-bottom: 8px;">🌐</div>
        <div style="font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">Could not connect to Fish Audio Cloud</div>
        <div style="font-size: 12px; color: var(--text-muted); max-width: 440px; line-height: 1.4; margin-bottom: 14px;">
          ${escapeHtml(err.message)}
        </div>
        <button class="btn btn-secondary" onclick="loadFishLibraryExplore()">↻ Retry Connection</button>
      </div>
    `;
  }
}

function renderFishExploreRails(data) {
  const container = document.getElementById("fish-discovery-content");
  if (!container) return;
  container.innerHTML = "";

  const rails = [
    { key: "trending", title: "🌟 Trending This Week", badge: "Live Community Trending", items: data.trending || [] },
    { key: "recommended", title: "🔥 Most Popular Community Clones", badge: "Top Cloned Voices", items: data.recommended || [] },
    { key: "narration", title: "📖 Storytellers & Audiobooks", badge: "Narration & Lore", items: data.narration || [] },
    { key: "anime", title: "⚔️ Anime & Iconic Characters", badge: "Anime / Fiction", items: data.anime || [] },
    { key: "cinematic", title: "🎬 Cinematic & Dramatic Baritones", badge: "Trailers & Cinema", items: data.cinematic || [] },
    { key: "gaming", title: "🎮 Gaming & Fantasy NPCs", badge: "Games & RP", items: data.gaming || [] }
  ];

  rails.forEach(rail => {
    if (!rail.items || rail.items.length === 0) return;
    const sec = document.createElement("div");
    sec.className = "fish-rail-section";

    sec.innerHTML = `
      <div class="fish-rail-header">
        <div class="fish-rail-title-group">
          <span class="fish-rail-title">${rail.title}</span>
          <span class="fish-rail-badge">${rail.badge}</span>
        </div>
        <button type="button" class="action-pill-btn secondary" style="font-size: 11px; padding: 3px 10px;" onclick="quickFilterFishTag('${rail.key}')">
          View All →
        </button>
      </div>
      <div class="fish-voice-grid">
        ${rail.items.map(m => renderFishVoiceCardHtml(m)).join("")}
      </div>
    `;
    container.appendChild(sec);
  });
}

function quickFilterFishTag(tagKey) {
  const tagMap = {
    trending: "all",
    recommended: "all",
    narration: "narration",
    anime: "anime",
    cinematic: "cinematic",
    gaming: "gaming"
  };
  const targetTag = tagMap[tagKey] || tagKey;
  selectFishTag(targetTag);
}

function handleFishSearchInput(val) {
  const clearBtn = document.getElementById("fish-search-clear");
  if (clearBtn) clearBtn.style.display = val ? "flex" : "none";
  state.fishLibrary.query = (val || "").trim();

  clearTimeout(_fishSearchDebounce);
  _fishSearchDebounce = setTimeout(() => {
    if (!state.fishLibrary.query && state.fishLibrary.tag === "all") {
      loadFishLibraryExplore();
    } else {
      state.fishLibrary.page = 1;
      searchFishLibrary(false);
    }
  }, 320);
}

function clearFishSearch() {
  const input = document.getElementById("fish-search-input");
  const clearBtn = document.getElementById("fish-search-clear");
  if (input) input.value = "";
  if (clearBtn) clearBtn.style.display = "none";
  state.fishLibrary.query = "";
  if (state.fishLibrary.tag === "all") {
    loadFishLibraryExplore();
  } else {
    state.fishLibrary.page = 1;
    searchFishLibrary(false);
  }
}

function selectFishTag(tag) {
  state.fishLibrary.tag = tag;
  document.querySelectorAll("#fish-tags-chips .fish-tag-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.tag === tag);
  });
  if (tag === "all" && !state.fishLibrary.query) {
    loadFishLibraryExplore();
  } else {
    state.fishLibrary.page = 1;
    searchFishLibrary(false);
  }
}

function handleFishFilterChange() {
  const langSel = document.getElementById("fish-lang-select");
  const sortSel = document.getElementById("fish-sort-select");
  if (langSel) state.fishLibrary.language = langSel.value;
  if (sortSel) state.fishLibrary.sortBy = sortSel.value;
  state.fishLibrary.page = 1;
  searchFishLibrary(false);
}

async function searchFishLibrary(isLoadMore = false) {
  const container = document.getElementById("fish-discovery-content");
  if (!container) return;

  if (!isLoadMore) {
    container.innerHTML = `
      <div class="fish-loading-state">
        <div class="spinner"></div>
        <div style="margin-top: 14px; font-size: 13.5px; color: var(--text-muted); font-weight: 500;">
          Searching 2M+ Fish Audio voice models...
        </div>
      </div>
    `;
  }

  const q = state.fishLibrary.query || "";
  const tag = state.fishLibrary.tag || "all";
  const lang = state.fishLibrary.language || "all";
  const sortBy = state.fishLibrary.sortBy || "score";
  const page = state.fishLibrary.page || 1;

  const url = `/api/fish_library/search?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&language=${encodeURIComponent(lang)}&sort_by=${encodeURIComponent(sortBy)}&page_size=24&page_number=${page}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Search request failed");
    }

    const items = data.items || [];
    state.fishLibrary.total = data.total || items.length;
    state.fishLibrary.hasMore = data.has_more || false;

    if (!isLoadMore) {
      if (items.length === 0) {
        container.innerHTML = `
          <div class="fish-empty-state">
            <div style="font-size: 36px; margin-bottom: 8px;">🔍</div>
            <div style="font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">No matching voices found</div>
            <div style="font-size: 12.5px; color: var(--text-muted); max-width: 440px; line-height: 1.4; margin-bottom: 14px;">
              Try searching with another name or style (e.g. "adam", "narrator", "deep"), selecting "All Languages", or clearing filters.
            </div>
            <button class="btn btn-secondary" onclick="clearFishSearch()">Clear All Filters</button>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
          <div style="font-size: 13.5px; font-weight: 600; color: var(--text-muted);">
            Found <span style="color: #f8fafc; font-weight: 700;">${state.fishLibrary.total.toLocaleString()}</span> voices matching your criteria
          </div>
        </div>
        <div class="fish-voice-grid" id="fish-search-grid">
          ${items.map(m => renderFishVoiceCardHtml(m)).join("")}
        </div>
        <div class="fish-load-more-container" id="fish-load-more-wrap" style="display: ${state.fishLibrary.hasMore ? 'flex' : 'none'};">
          <button class="fish-load-more-btn" onclick="loadMoreFishSearchResults()">Load More Voices (${items.length}+)</button>
        </div>
      `;
    } else {
      const grid = document.getElementById("fish-search-grid");
      if (grid) {
        const temp = document.createElement("div");
        temp.innerHTML = items.map(m => renderFishVoiceCardHtml(m)).join("");
        while (temp.firstChild) {
          grid.appendChild(temp.firstChild);
        }
      }
      const wrap = document.getElementById("fish-load-more-wrap");
      if (wrap) wrap.style.display = state.fishLibrary.hasMore ? "flex" : "none";
    }
  } catch (err) {
    console.error("Search error:", err);
    if (!isLoadMore) {
      container.innerHTML = `
        <div class="fish-empty-state">
          <div style="font-size: 32px; margin-bottom: 8px;">⚠️</div>
          <div style="font-size: 14px; font-weight: 700; color: #ef4444; margin-bottom: 4px;">Search Failed</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">${escapeHtml(err.message)}</div>
          <button class="btn btn-secondary" onclick="searchFishLibrary(false)">Try Again</button>
        </div>
      `;
    }
  }
}

function loadMoreFishSearchResults() {
  state.fishLibrary.page = (state.fishLibrary.page || 1) + 1;
  searchFishLibrary(true);
}

function formatFishCount(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + " M";
  if (n >= 1000) return (n / 1000).toFixed(1) + " K";
  return String(n);
}

function getGradientForName(str) {
  const gradients = [
    "linear-gradient(135deg, #6366f1, #8b5cf6)",
    "linear-gradient(135deg, #ec4899, #f43f5e)",
    "linear-gradient(135deg, #10b981, #059669)",
    "linear-gradient(135deg, #f59e0b, #d97706)",
    "linear-gradient(135deg, #3b82f6, #1d4ed8)",
    "linear-gradient(135deg, #8b5cf6, #d946ef)",
    "linear-gradient(135deg, #06b6d4, #0891b2)",
    "linear-gradient(135deg, #14b8a6, #0d9488)"
  ];
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) hash += str.charCodeAt(i);
  return gradients[Math.abs(hash) % gradients.length];
}

function renderFishVoiceCardHtml(item) {
  const isPlaying = state.fishLibrary.activePlayingId === item.id;
  const isSaved = state.fishLibrary.savedModelIds.has(item.id) || (state.voices || []).some(v => v.id === `fish_${item.id}` || v.source_model_id === item.id);
  const jsonPayload = JSON.stringify(item).replace(/"/g, "&quot;");
  const avatarInitials = (item.title || "VO").slice(0, 2).toUpperCase();

  return `
    <div class="fish-voice-card" id="fish-card-${item.id}">
      <div class="fish-card-top">
        ${item.cover_url ? `
          <img src="${item.cover_url}" class="fish-card-avatar" alt="${escapeHtml(item.title)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="fish-card-avatar-fallback" style="display: none; background: ${getGradientForName(item.title)};">${escapeHtml(avatarInitials)}</div>
        ` : `
          <div class="fish-card-avatar-fallback" style="background: ${getGradientForName(item.title)};">${escapeHtml(avatarInitials)}</div>
        `}
        <div class="fish-card-info">
          <div class="fish-card-title-row">
            <span class="fish-card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
            ${item.is_official ? '<span class="fish-official-badge" title="Official Fish Audio Model">✓</span>' : ''}
            <span class="fish-card-author" title="${escapeHtml(item.author || item.author_name || '')}">· ${escapeHtml(item.author || item.author_name || 'Community')}</span>
          </div>
          <div class="fish-card-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description || 'Expressive AI voice clone on Fish Audio')}</div>
          <div class="fish-card-tags">
            <span class="fish-tag-pill-sm lang">${item.languages && item.languages[0] ? item.languages[0].toUpperCase() : 'EN'}</span>
            <span class="fish-tag-pill-sm gender">${escapeHtml(item.gender || 'Custom')}</span>
            ${(item.tags || []).slice(0, 2).map(t => `<span class="fish-tag-pill-sm">${escapeHtml(t)}</span>`).join('')}
            ${(item.tags || []).length > 2 ? `<span class="fish-tag-pill-sm">+${(item.tags || []).length - 2}</span>` : ''}
          </div>
          <div class="fish-card-stats">
            <span>▶ ${formatFishCount(item.task_count)}</span>
            <span>❤️ ${formatFishCount(item.like_count)}</span>
          </div>
        </div>
      </div>

      <div class="fish-card-actions">
        <button type="button" class="fish-btn-sample ${isPlaying ? 'playing' : ''}" id="fish-play-btn-${item.id}" onclick="toggleFishAudioSample('${item.id}', '${item.sample_audio || ''}', this)">
          ${isPlaying ? '⏸ Pause' : '▶ Sample'}
        </button>
        <button type="button" class="fish-btn-use" onclick="useFishVoiceModel(${jsonPayload}, this)" title="Instantly clone & assign to selected sentence block">
          ⚡ Use Voice
        </button>
        <button type="button" class="fish-btn-save ${isSaved ? 'saved' : ''}" onclick="saveFishVoiceModel(${jsonPayload}, this)" title="${isSaved ? 'Saved in My Library' : 'Save to My Library'}">
          ${isSaved ? '✓ Saved' : '💾'}
        </button>
      </div>
    </div>
  `;
}

function toggleFishAudioSample(id, sampleUrl, btnEl) {
  if (!sampleUrl) {
    showToast("No playable audio sample available for this model", "warning");
    return;
  }

  // If already playing this ID, pause it
  if (state.fishLibrary.activePlayingId === id && state.sampleAudioPlayer && !state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    state.fishLibrary.activePlayingId = null;
    if (btnEl) {
      btnEl.classList.remove("playing");
      btnEl.innerHTML = "▶ Sample";
    }
    return;
  }

  // Reset any other play button
  if (state.fishLibrary.activePlayingId) {
    const prevBtn = document.getElementById(`fish-play-btn-${state.fishLibrary.activePlayingId}`);
    if (prevBtn) {
      prevBtn.classList.remove("playing");
      prevBtn.innerHTML = "▶ Sample";
    }
  }

  state.fishLibrary.activePlayingId = id;
  if (btnEl) {
    btnEl.classList.add("playing");
    btnEl.innerHTML = "⏸ Pause";
  }

  if (state.storyAudioPlayer && !state.storyAudioPlayer.paused) {
    state.storyAudioPlayer.pause();
  }

  state.sampleAudioPlayer.src = sampleUrl;
  state.sampleAudioPlayer.play().catch(e => {
    console.error("Audio playback error:", e);
    if (btnEl) {
      btnEl.classList.remove("playing");
      btnEl.innerHTML = "▶ Sample";
    }
    state.fishLibrary.activePlayingId = null;
  });

  state.sampleAudioPlayer.onended = () => {
    if (btnEl) {
      btnEl.classList.remove("playing");
      btnEl.innerHTML = "▶ Sample";
    }
    state.fishLibrary.activePlayingId = null;
  };
}

async function useFishVoiceModel(item, btnEl) {
  if (!item || !item.id) return;
  const originalText = btnEl ? btnEl.innerHTML : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<span class="spinner-inline"></span> Cloning...`;
  }

  try {
    const res = await fetch("/api/fish_library/install_voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: item.id,
        title: item.title,
        sample_audio: item.sample_audio,
        sample_text: item.sample_text,
        description: item.description,
        gender: item.gender,
        tags: item.tags
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to clone voice reference");
    }

    const newVoice = data.voice;
    const vIdx = (state.voices || []).findIndex(v => v.id === newVoice.id);
    if (vIdx >= 0) {
      state.voices[vIdx] = newVoice;
    } else {
      state.voices.push(newVoice);
    }
    state.fishLibrary.savedModelIds.add(item.id);

    assignVoiceToTarget(newVoice);

    if (btnEl) {
      btnEl.innerHTML = `✓ Active`;
      setTimeout(() => {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerHTML = `⚡ Use Voice`;
        }
      }, 1500);
    }
  } catch (err) {
    console.error("Error using fish voice:", err);
    showToast(`Error cloning voice: ${err.message}`, "error");
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = originalText;
    }
  }
}

async function saveFishVoiceModel(item, btnEl) {
  if (!item || !item.id) return;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `⏳`;
  }

  try {
    const res = await fetch("/api/fish_library/install_voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: item.id,
        title: item.title,
        sample_audio: item.sample_audio,
        sample_text: item.sample_text,
        description: item.description,
        gender: item.gender,
        tags: item.tags
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to save voice");
    }

    const newVoice = data.voice;
    const vIdx = (state.voices || []).findIndex(v => v.id === newVoice.id);
    if (vIdx >= 0) {
      state.voices[vIdx] = newVoice;
    } else {
      state.voices.push(newVoice);
    }
    state.fishLibrary.savedModelIds.add(item.id);

    if (state.selectingVoiceForChar) {
      const select = document.getElementById("char-modal-voice-select");
      if (select) {
        let opt = Array.from(select.options).find(o => o.value === newVoice.id);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = newVoice.id;
          opt.textContent = `${newVoice.name} (${newVoice.gender || ''} ${newVoice.accent || ''})`;
          select.appendChild(opt);
        }
        select.value = newVoice.id;
      }
      updateCharModalVoiceDetails(newVoice.id);
      closeVoiceDrawer();
      showToast(`✓ Assigned "${newVoice.name}" to character!`, "success");
      return;
    }

    showToast(`💾 "${newVoice.name}" saved to your permanent Voice Library!`, "success");
    if (btnEl) {
      btnEl.classList.add("saved");
      btnEl.innerHTML = `✓ Saved`;
      btnEl.disabled = false;
    }
  } catch (err) {
    console.error("Error saving fish voice:", err);
    showToast(`Error saving voice: ${err.message}`, "error");
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = `💾`;
    }
  }
}

function toggleDrawerCreateView() {
  if (_drawerCurrentMode === "create") {
    switchDrawerMode("browse");
  } else {
    switchDrawerMode("create");
  }
}

function handleDrawerSearch(query) {
  state.searchQuery = query || "";
  renderVoiceList();
}

function handleDrawerSort(sortVal) {
  state.activeSort = sortVal || "recommended";
  renderVoiceList();
}

function setDrawerFilter(filterVal) {
  state.activeFilter = filterVal || "all";
  document.querySelectorAll("#drawer-filter-pills .filter-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.filter === filterVal);
  });
  renderVoiceList();
}

function renderVoiceList() {
  const container = document.getElementById("voice-list-body");
  if (!container) return;
  container.innerHTML = "";

  const query = (state.searchQuery || "").toLowerCase().trim();
  const filter = state.activeFilter || "all";
  const sort = state.activeSort || "recommended";
  const countBadge = document.getElementById("drawer-voices-count");

  // 1. Chapter Cast Tab Mode
  if (_drawerCurrentMode === "cast") {
    let charList = (state.savedCharacters || []).filter(c => {
      const v = getVoiceById(c.voice_id);
      const vGender = (v?.gender || "").toLowerCase();
      if (filter === "female" && vGender !== "female") return false;
      if (filter === "male" && vGender !== "male") return false;
      if (!query) return true;
      return c.name.toLowerCase().includes(query) || (v && v.name.toLowerCase().includes(query));
    });

    if (countBadge) countBadge.textContent = `${charList.length} Cast`;

    if (charList.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-subtle); padding: 40px;">
          No saved characters match your filter.<br>
          <span style="font-size: 12px; opacity: 0.8; margin-top: 8px; display: inline-block;">
            Save character voices in the Cast panel to access them here!
          </span>
        </div>
      `;
      return;
    }

    charList.forEach(char => {
      const v = getVoiceById(char.voice_id);
      const card = document.createElement("div");
      card.className = "voice-card";
      const speedStr = `${Number(char.speed || 0.90).toFixed(2)}x`;
      const pitchStr = char.pitch_shift ? ` • ${(char.pitch_shift > 0 ? '+' : '') + Number(char.pitch_shift).toFixed(1)}st` : "";
      const filterStr = (char.fx_filter && char.fx_filter !== "none") ? ` • ${char.fx_filter.toUpperCase()}` : "";

      card.innerHTML = `
        <div class="voice-card-left">
          <div class="voice-avatar-badge" style="background-color: ${char.color || (v ? v.color : '#6366f1')}">
            ${escapeHtml(char.badge || char.name.slice(0, 2).toUpperCase())}
          </div>
          <div class="voice-info">
            <div class="voice-name">🎭 ${escapeHtml(char.name)}</div>
            <div class="voice-sub">${escapeHtml(v ? v.name : 'Voice')} • ${speedStr}${pitchStr}${filterStr}</div>
            <div class="voice-tags-row">
              <span class="voice-tag" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc;">Character Preset</span>
              ${char.fx_filter && char.fx_filter !== 'none' ? `<span class="voice-tag" style="background: rgba(234, 88, 12, 0.2); color: #fb923c;">${char.fx_filter.toUpperCase()}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="voice-card-actions">
          <button class="btn btn-primary assign-voice-btn">Apply Character</button>
        </div>
      `;

      card.querySelector(".assign-voice-btn").addEventListener("click", () => {
        applyCharacterToSelected(char.id);
        closeVoiceDrawer();
      });

      container.appendChild(card);
    });
    return;
  }

  // 2. Select base voices STRICTLY for the selected tab (_drawerCurrentMode):
  let baseVoices = [];
  if (_drawerCurrentMode === "edge") {
    baseVoices = (state.voices || []).filter(v => (v.engine === "edge_tts") || (v.id && v.id.includes("Neural")));
  } else if (_drawerCurrentMode === "kokoro") {
    baseVoices = (state.voices || []).filter(v => (v.engine === "kokoro") || (v.id && (v.id.startsWith("am_") || v.id.startsWith("af_") || v.id.startsWith("bm_") || v.id.startsWith("bf_") || v.id.startsWith("blend_") || v.id.startsWith("jf_") || v.id.startsWith("jm_") || v.id.startsWith("zf_") || v.id.startsWith("zm_"))));
  } else if (_drawerCurrentMode === "fish_speech" || _drawerCurrentMode === "fish_drama") {
    baseVoices = (state.voices || []).filter(v => (v.engine === "fish_s2") || (!v.engine && !v.id?.startsWith("am_") && !v.id?.startsWith("af_") && !v.id?.startsWith("bm_") && !v.id?.startsWith("bf_") && !v.id?.includes("Neural") && !v.is_custom));
  } else if (_drawerCurrentMode === "elevenlabs") {
    baseVoices = (state.voices || []).filter(v => v.engine === "elevenlabs");
  } else if (_drawerCurrentMode === "cartesia") {
    baseVoices = (state.voices || []).filter(v => v.engine === "cartesia");
  } else if (_drawerCurrentMode === "openai") {
    baseVoices = (state.voices || []).filter(v => v.engine === "openai");
  } else if (_drawerCurrentMode === "browse") {
    // Saved / Custom Library voices
    baseVoices = (state.voices || []).filter(v => v.is_custom || v.is_custom_ref || (v.id && (v.id.startsWith("custom_") || v.id.startsWith("custom_lib_"))) || (v.genre && v.genre.includes("Library")));
  } else {
    // Fallback default
    baseVoices = (state.voices || []).filter(v => (v.engine === "edge_tts") || (v.id && v.id.includes("Neural")));
  }

  // 3. Filter base voices using the selected attribute filter & search query:
  let list = baseVoices.filter(v => {
    // Search query matching
    const matchQuery = !query || 
      (v.name && v.name.toLowerCase().includes(query)) ||
      (v.timbre && v.timbre.toLowerCase().includes(query)) ||
      (v.accent && v.accent.toLowerCase().includes(query)) ||
      (v.locale && v.locale.toLowerCase().includes(query)) ||
      (v.genre && Array.isArray(v.genre) && v.genre.some(g => g.toLowerCase().includes(query))) ||
      (v.reference_text && v.reference_text.toLowerCase().includes(query));

    if (!matchQuery) return false;

    const gender = (v.gender || "").toLowerCase();
    if (filter === "female") return gender === "female";
    if (filter === "male") return gender === "male";

    // Locale / Accent matching for the selected tab
    const locale = (v.locale || "").toLowerCase();
    const accent = (v.accent || "").toLowerCase();
    const name = (v.name || "").toLowerCase();
    const vid = (v.id || "").toLowerCase();

    const isUS = accent.includes("american") || locale.startsWith("en-us") || name.includes("united states") || vid.startsWith("am_") || vid.startsWith("af_") || (v.blend_weights && Object.keys(v.blend_weights).some(k => k.startsWith("am_") || k.startsWith("af_")));
    const isUK = accent.includes("british") || locale.startsWith("en-gb") || locale.startsWith("en-uk") || name.includes("united kingdom") || vid.startsWith("bm_") || vid.startsWith("bf_") || (v.blend_weights && Object.keys(v.blend_weights).some(k => k.startsWith("bm_") || k.startsWith("bf_")));

    if (filter === "american") return isUS;
    if (filter === "british") return isUK;
    if (filter === "international") return !isUS && !isUK;

    return true; // "all"
  });

  // 4. Sort
  list.sort((a, b) => {
    if (sort === "newest") {
      const aTime = a.created_at || (a.id && a.id.startsWith("custom_lib_") ? parseInt(a.id.split("_").pop()) || 0 : 0);
      const bTime = b.created_at || (b.id && b.id.startsWith("custom_lib_") ? parseInt(b.id.split("_").pop()) || 0 : 0);
      return bTime - aTime;
    }
    if (sort === "name_asc") {
      return a.name.localeCompare(b.name);
    }
    if (sort === "name_desc") {
      return b.name.localeCompare(a.name);
    }
    if (sort === "female_first") {
      const aF = (a.gender || "").toLowerCase() === "female" ? 1 : 0;
      const bF = (b.gender || "").toLowerCase() === "female" ? 1 : 0;
      return bF - aF;
    }
    if (sort === "male_first") {
      const aM = (a.gender || "").toLowerCase() === "male" ? 1 : 0;
      const bM = (b.gender || "").toLowerCase() === "male" ? 1 : 0;
      return bM - aM;
    }
    if (sort === "deep_first") {
      const aDeep = a.timbre && (a.timbre.includes("Bass") || a.timbre.includes("Deep") || a.timbre.includes("Baritone"));
      const bDeep = b.timbre && (b.timbre.includes("Bass") || b.timbre.includes("Deep") || b.timbre.includes("Baritone"));
      return (bDeep ? 1 : 0) - (aDeep ? 1 : 0);
    }
    // Default: prioritize famous/standard
    const aFam = a.id && a.id.startsWith("voice_");
    const bFam = b.id && b.id.startsWith("voice_");
    if (aFam !== bFam) return (bFam ? 1 : 0) - (aFam ? 1 : 0);
    return 0;
  });

  // 5. Update total count badge for the current tab
  if (countBadge) {
    if (_drawerCurrentMode === "edge") {
      countBadge.textContent = `${list.length} Neural Voices`;
    } else if (_drawerCurrentMode === "kokoro") {
      countBadge.textContent = `${list.length} WebGPU Voices`;
    } else if (_drawerCurrentMode === "fish_speech") {
      countBadge.textContent = `${list.length} Drama Voices`;
    } else if (_drawerCurrentMode === "elevenlabs") {
      countBadge.textContent = `${list.length} ElevenLabs Voices`;
    } else if (_drawerCurrentMode === "cartesia") {
      countBadge.textContent = `${list.length} Cartesia Sonic Voices`;
    } else if (_drawerCurrentMode === "openai") {
      countBadge.textContent = `${list.length} OpenAI Voices`;
    } else if (_drawerCurrentMode === "browse") {
      countBadge.textContent = `${list.length} Saved Voices`;
    } else {
      countBadge.textContent = `${list.length} Voices`;
    }
  }

  if (list.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-subtle); padding: 40px;">No voices match your search or filter.</div>`;
    return;
  }

  list.forEach(v => {
    const card = document.createElement("div");
    card.className = "voice-card";
    const sampleUrl = v.sample_url || (v.reference_audio ? (v.reference_audio.startsWith("/") ? v.reference_audio : "/" + v.reference_audio) : `/api/audio/sample_${v.id}.wav`);
    const isCustomVoice = v.is_custom || v.is_custom_ref || (v.id && (v.id.startsWith("custom_") || v.id.startsWith("custom_lib_")));

    const isEleven = (v.engine === "elevenlabs");
    const isCartesia = (v.engine === "cartesia");
    const isOpenAI = (v.engine === "openai");
    const isEdge = (v.engine === "edge_tts") || (v.id && v.id.includes("Neural"));
    const isKokoro = (v.engine === "kokoro") || (v.id && (v.id.startsWith("am_") || v.id.startsWith("af_") || v.id.startsWith("bm_") || v.id.startsWith("bf_") || v.id.startsWith("blend_")));
    const engineBadge = isEleven
      ? `<span class="badge-mini" style="background: rgba(139, 92, 246, 0.2); color: #c4b5fd; font-size: 10px; margin-left: 5px; font-weight: 700;">🌟 ELEVENLABS</span>`
      : (isCartesia
        ? `<span class="badge-mini" style="background: rgba(236, 72, 153, 0.2); color: #f472b6; font-size: 10px; margin-left: 5px; font-weight: 700;">⚡ CARTESIA</span>`
        : (isOpenAI
          ? `<span class="badge-mini" style="background: rgba(16, 185, 129, 0.2); color: #6ee7b7; font-size: 10px; margin-left: 5px; font-weight: 700;">🤖 OPENAI</span>`
          : (isEdge
            ? `<span class="badge-mini" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; font-size: 10px; margin-left: 5px; font-weight: 700;">🌐 EDGE TTS</span>`
            : (isKokoro
              ? `<span class="badge-mini" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; font-size: 10px; margin-left: 5px; font-weight: 700;">⚡ KOKORO 82M</span>`
              : `<span class="badge-mini" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; font-size: 10px; margin-left: 5px; font-weight: 700;">🎭 FISH DRAMA 3</span>`))));

    card.innerHTML = `
      <div class="voice-card-left">
        <div class="voice-avatar-badge" style="background-color: ${v.color || '#6366f1'}">
          ${escapeHtml(v.badge || (v.name ? v.name.slice(0, 2).toUpperCase() : 'VO'))}
        </div>
        <div class="voice-info">
          <div class="voice-name">
            ${v.flag || ""} ${escapeHtml(v.name)}
            ${engineBadge}
            ${isCustomVoice ? `<span class="badge-mini" style="background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 10px; margin-left: 5px;">CUSTOM</span>` : ''}
          </div>
          <div class="voice-sub">${escapeHtml(v.timbre || `${v.gender || 'Neutral'} • ${v.accent || 'Natural'}`)}</div>
          <div class="voice-tags-row">
            ${(v.genre || []).map(g => `<span class="voice-tag">${escapeHtml(g)}</span>`).join("")}
          </div>
        </div>
      </div>
      <div class="voice-card-actions">
        <button class="btn btn-secondary preview-voice-btn" title="Instant sample playback">▶ Sample</button>
        <button class="btn btn-primary assign-voice-btn" title="Use voice">Use Voice</button>
        <button class="icon-btn edit-voice-btn" title="Edit voice metadata">✏️</button>
        ${isCustomVoice ? `<button class="icon-btn delete-btn delete-voice-btn" title="Delete voice from library">🗑️</button>` : ''}
      </div>
    `;

    // Instant Sample Playback
    const previewBtn = card.querySelector(".preview-voice-btn");
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreRenderedSample(sampleUrl, previewBtn, v);
    });

    // Use Voice
    card.querySelector(".assign-voice-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      assignVoiceToTarget(v);
    });

    // Edit Voice
    const editBtn = card.querySelector(".edit-voice-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawerEditVoice(v.id);
      });
    }

    // Delete Voice
    const delBtn = card.querySelector(".delete-voice-btn");
    if (delBtn) {
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleDeleteVoiceFromLibrary(v.id, e);
      });
    }

    container.appendChild(card);
  });
}

async function playPreRenderedSample(sampleUrl, btnEl, voiceObj = null) {
  // If story is currently playing, pause it so samples don't conflict
  if (state.isPlayingStory || (state.storyAudioPlayer && !state.storyAudioPlayer.paused)) {
    pauseStoryPlayback();
  }

  const voiceKey = voiceObj ? voiceObj.id : sampleUrl;
  if (state.playingVoiceSampleId === voiceKey && state.sampleAudioPlayer && !state.sampleAudioPlayer.paused) {
    state.sampleAudioPlayer.pause();
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
    return;
  }

  // Stop any other voice sample that might be playing
  if (state.sampleAudioPlayer) {
    state.sampleAudioPlayer.pause();
  }
  document.querySelectorAll(".preview-voice-btn").forEach(b => b.textContent = "▶ Sample");

  state.playingVoiceSampleId = voiceKey;
  btnEl.textContent = "⏳ Loading...";
  if (!state.sampleAudioPlayer) {
    state.sampleAudioPlayer = new Audio();
  }

  const isEdge = voiceObj && (voiceObj.engine === "edge_tts" || (voiceObj.id && voiceObj.id.includes("Neural")));
  const isKokoro = voiceObj && (voiceObj.engine === "kokoro" || (voiceObj.id && (voiceObj.id.startsWith("af_") || voiceObj.id.startsWith("am_") || voiceObj.id.startsWith("bf_") || voiceObj.id.startsWith("bm_"))));

  // Kokoro Client In-Browser Sample
  if (isKokoro && window.KokoroClient && window.KokoroClient.isClientKokoroEnabled()) {
    try {
      const sampleText = `Hello, I'm ${voiceObj.name}, ready to bring your characters to life.`;
      const clientRes = await window.KokoroClient.synthesizeOnClient(sampleText, {
        voice: voiceObj.id,
        speed: 1.0
      });
      if (clientRes && clientRes.audioUrl) {
        state.sampleAudioPlayer.src = clientRes.audioUrl;
        btnEl.textContent = "🔊 Playing";
        await state.sampleAudioPlayer.play();
        state.sampleAudioPlayer.onended = () => {
          btnEl.textContent = "▶ Sample";
          state.playingVoiceSampleId = null;
        };
        return;
      }
    } catch (kErr) {
      console.warn("[KokoroClient] Sample preview fallback:", kErr);
    }
  }

  // Edge TTS or Server Kokoro sample synthesis
  if (isEdge || isKokoro) {
    try {
      const sampleText = `Hello, I am ${voiceObj.name}. Ready to voice your story.`;
      const res = await fetch("/api/synthesize_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sampleText,
          voice_id: voiceObj.id,
          engine: isEdge ? "edge_tts" : "kokoro"
        })
      });
      const data = await res.json();
      if (data && data.audio_url) {
        state.sampleAudioPlayer.src = data.audio_url;
        btnEl.textContent = "🔊 Playing";
        await state.sampleAudioPlayer.play();
        state.sampleAudioPlayer.onended = () => {
          btnEl.textContent = "▶ Sample";
          state.playingVoiceSampleId = null;
        };
        return;
      }
    } catch (sErr) {
      console.warn("Sample synthesis fallback:", sErr);
    }
  }

  // Pre-rendered WAV / reference audio
  state.sampleAudioPlayer.src = sampleUrl;
  state.sampleAudioPlayer.play().then(() => {
    btnEl.textContent = "🔊 Playing";
  }).catch(err => {
    console.warn("Audio play issue, attempting fallback", err);
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
  });

  state.sampleAudioPlayer.onended = () => {
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
  };
}

function assignVoiceToTarget(voice) {
  if (state.selectingVoiceForChar) {
    const vEngine = voice.engine || (voice.id?.includes("Neural") ? "edge_tts" : (voice.id?.startsWith("af_") || voice.id?.startsWith("am_") ? "kokoro" : "fish_s2"));
    if (typeof handleCharModalEngineChange === "function") {
      handleCharModalEngineChange(vEngine);
    }
    const select = document.getElementById("char-modal-voice-select");
    if (select) {
      let opt = Array.from(select.options).find(o => o.value === voice.id);
      if (!opt) {
        opt = document.createElement("option");
        opt.value = voice.id;
        opt.textContent = `${voice.name} (${voice.gender || ''} ${voice.accent || ''})`;
        select.appendChild(opt);
      }
      select.value = voice.id;
    }
    updateCharModalVoiceDetails(voice.id);
    closeVoiceDrawer();
    showToast(`✓ Selected "${voice.name}" (${vEngine}) for character!`);
    return;
  }

  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) {
    showToast(`✅ Selected voice "${voice.name}" as active default!`);
    state.defaultNarratorVoiceId = voice.id;
    closeVoiceDrawer();
    return;
  }

  recordHistory(`Change Voice: ${voice.name}`);

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 1)
    ? Array.from(state.selectedBlockIndices)
    : [(state.targetBlockForVoice !== null && state.targetBlockForVoice !== undefined ? state.targetBlockForVoice : state.activeBlockIndex)];

  targets.forEach(idx => {
    const block = state.currentProject.blocks ? state.currentProject.blocks[idx] : null;
    if (!block) return;

    // Preserve character info & story speaker identity!
    const char = block.character_id
      ? getCharacterById(block.character_id)
      : (block.overridden_character_id
        ? getCharacterById(block.overridden_character_id)
        : (block.speaker ? getCharacterById(block.speaker) : null));

    if (char) {
      block.character_id = char.id;
      block.speaker = char.name;
      block.overridden_character_id = char.id;
      block.overridden_speaker = char.name;
      block.is_custom_edited = true;
    }
    block.voice_id = voice.id;

    // Auto-align block engine to match the newly selected voice
    if (voice.engine) {
      block.engine = voice.engine;
    } else if (voice.id && voice.id.includes("Neural")) {
      block.engine = "edge_tts";
    } else if (voice.id && (voice.id.startsWith("af_") || voice.id.startsWith("am_") || voice.id.startsWith("bf_") || voice.id.startsWith("bm_"))) {
      block.engine = "kokoro";
    }
    const defaultModels = {
      fish_s2: "drama3",
      elevenlabs: "v4",
      cartesia: "sonic_4",
      openai: "gpt-4o-mini-tts",
      edge_tts: "edge_neural",
      kokoro: "kokoro_webgpu"
    };
    if (block.engine && (!block.model || (block.engine === "fish_s2" && !["drama3", "s2_pro"].includes(block.model)))) {
      block.model = defaultModels[block.engine] || "";
    }

    if (voice.reference_audio) {
      block.reference_audio = voice.reference_audio;
      block.reference_text = voice.reference_text || "";
    } else {
      delete block.reference_audio;
      delete block.reference_text;
    }

    if (voice.blend_weights) {
      block.blend_weights = JSON.parse(JSON.stringify(voice.blend_weights));
    } else {
      delete block.blend_weights;
    }

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (typeof invalidateBlockAudio === "function") {
      invalidateBlockAudio(block, row);
    } else {
      delete block.audio_url;
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      delete block.duration;
      delete block.audio_hash;
      delete block.rawAudioUrl;
      delete block.raw_audio_url;
    }
  });

  state.targetBlockForVoice = null;
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  updateActiveCharacterStatusBanner();
  updateOverriddenCastButtonUI();
  updateSelectionUI();
  closeVoiceDrawer();
  syncProjectAudioCache();
  showToast(`✓ Changed ${targets.length} sentence(s) to standalone voice "${voice.name}"!`, "success");
}

function openDrawerEditVoice(voiceId) {
  const v = getVoiceById(voiceId);
  if (!v) {
    showToast("⚠️ Voice not found", "error");
    return;
  }
  window._editingVoiceId = voiceId;
  window._editSelectedRefPath = v.reference_audio || "";

  const nameEl = document.getElementById("ev-name");
  if (nameEl) nameEl.value = v.name || "";

  const genderEl = document.getElementById("ev-gender");
  if (genderEl) genderEl.value = v.gender || "Custom";

  const accentEl = document.getElementById("ev-accent");
  if (accentEl) accentEl.value = v.accent || "Custom";

  const timbreEl = document.getElementById("ev-timbre");
  if (timbreEl) timbreEl.value = v.timbre || "";

  const emotionEl = document.getElementById("ev-emotion");
  if (emotionEl) emotionEl.value = v.default_emotion_tag || "";

  const transEl = document.getElementById("ev-transcript");
  if (transEl) transEl.value = v.reference_text || "";

  const audioLabel = document.getElementById("ev-ref-filename-label");
  if (audioLabel) {
    audioLabel.textContent = v.reference_audio ? v.reference_audio.split("/").pop() : "No reference audio";
  }

  const playBtn = document.getElementById("btn-play-ev-ref");
  if (playBtn) {
    playBtn.style.display = v.reference_audio ? "inline-flex" : "none";
    playBtn.dataset.url = v.reference_audio || "";
  }

  switchDrawerMode("edit");
}

async function handleSaveEditedVoice() {
  const voiceId = window._editingVoiceId;
  if (!voiceId) return;

  const name = document.getElementById("ev-name")?.value?.trim();
  if (!name) {
    showToast("⚠️ Voice Name is required", "warning");
    return;
  }

  const gender = document.getElementById("ev-gender")?.value || "Custom";
  const accent = document.getElementById("ev-accent")?.value || "Custom";
  const timbre = document.getElementById("ev-timbre")?.value?.trim() || "";
  const emotion = document.getElementById("ev-emotion")?.value?.trim() || "";
  const transcript = document.getElementById("ev-transcript")?.value?.trim() || "";
  const refPath = window._editSelectedRefPath || "";

  showToast("⏳ Saving voice updates...");
  try {
    const res = await fetch("/api/voices/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: voiceId,
        name,
        gender,
        accent,
        timbre,
        default_emotion_tag: emotion,
        reference_text: transcript,
        reference_audio: refPath
      })
    });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || "Update failed");

    await loadVoices();
    switchDrawerMode("browse");
    renderVoiceList();
    showToast(`✅ Voice "${name}" updated successfully!`);
  } catch (err) {
    showToast(`❌ Update failed: ${err.message}`, "error");
  }
}

async function handleDeleteVoiceFromLibrary(voiceId, event) {
  if (event) event.stopPropagation();
  const v = getVoiceById(voiceId);
  const name = v ? v.name : voiceId;

  if (!confirm(`Are you sure you want to delete voice "${name}" from your library?`)) {
    return;
  }

  showToast(`⏳ Deleting voice "${name}"...`);
  try {
    const res = await fetch("/api/voices/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: voiceId })
    });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || "Delete failed");

    await loadVoices();
    renderVoiceList();
    showToast(`🗑️ Voice "${name}" deleted from library.`);
  } catch (err) {
    showToast(`❌ Delete failed: ${err.message}`, "error");
  }
}

async function handleEvRefFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("audio", file);

  showToast(`⏳ Uploading "${file.name}"...`);
  try {
    const res = await fetch("/api/voices/upload_reference", {
      method: "POST",
      body: fd
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

    window._editSelectedRefPath = data.relative_path || data.url;
    const label = document.getElementById("ev-ref-filename-label");
    if (label) label.textContent = data.filename;

    const playBtn = document.getElementById("btn-play-ev-ref");
    if (playBtn) {
      playBtn.style.display = "inline-flex";
      playBtn.dataset.url = data.url;
    }
    showToast(`✅ Reference audio clip "${file.name}" attached!`);
  } catch (err) {
    showToast(`❌ Upload failed: ${err.message}`, "error");
  }
}

function handlePlayEvRefAudio(event) {
  if (event) event.stopPropagation();
  const btn = document.getElementById("btn-play-ev-ref");
  const url = btn?.dataset?.url || window._editSelectedRefPath;
  if (!url) return;

  if (!window._evRefAudio) window._evRefAudio = new Audio();
  const a = window._evRefAudio;
  if (a.src.includes(url) && !a.paused) {
    a.pause();
    if (btn) btn.textContent = "▶ Play Audio Clip";
  } else {
    a.src = url.startsWith("/") ? url : `/${url}`;
    a.play().catch(() => {});
    if (btn) btn.textContent = "⏸ Pause Audio Clip";
    a.onended = () => { if (btn) btn.textContent = "▶ Play Audio Clip"; };
  }
}

// ---------------- CREATE VOICE IN DRAWER ---------------- //

function switchCreateVoiceMode(mode = "ref") {
  const btnRef = document.getElementById("btn-create-mode-ref");
  const btnPrompt = document.getElementById("btn-create-mode-prompt");
  const paneRef = document.getElementById("create-voice-pane-ref");
  const panePrompt = document.getElementById("create-voice-pane-prompt");

  if (mode === "prompt") {
    if (btnRef) btnRef.classList.remove("active");
    if (btnPrompt) btnPrompt.classList.add("active");
    if (paneRef) paneRef.style.display = "none";
    if (panePrompt) panePrompt.style.display = "flex";
  } else {
    if (btnRef) btnRef.classList.add("active");
    if (btnPrompt) btnPrompt.classList.remove("active");
    if (paneRef) paneRef.style.display = "flex";
    if (panePrompt) panePrompt.style.display = "none";
  }
}
window.switchCreateVoiceMode = switchCreateVoiceMode;

let _cvUploadedRefAudioPath = "";
let _cvPromptSampleAudioUrl = "";

async function handleCvRefFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("audio", file);

  showToast(`⏳ Uploading reference audio "${file.name}"...`);
  try {
    const res = await fetch("/api/voices/upload_reference", {
      method: "POST",
      body: fd
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

    _cvUploadedRefAudioPath = data.relative_path || data.url;
    const label = document.getElementById("cv-ref-filename-label");
    if (label) label.textContent = data.filename || file.name;

    const sub = document.getElementById("cv-ref-file-sub");
    if (sub) sub.textContent = "Audio attached successfully";

    const playBtn = document.getElementById("btn-play-cv-ref");
    if (playBtn) {
      playBtn.style.display = "inline-flex";
      playBtn.dataset.url = data.url || data.relative_path;
    }

    const nameInput = document.getElementById("cv-ref-name");
    if (nameInput && !nameInput.value.trim()) {
      let cleanName = (file.name || "").replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ").trim();
      if (cleanName) {
        nameInput.value = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      }
    }

    showToast(`✅ Reference audio "${file.name}" ready!`);
  } catch (err) {
    showToast(`❌ Reference upload failed: ${err.message}`, "error");
  }
}
window.handleCvRefFileUpload = handleCvRefFileUpload;

function handlePlayCvRefAudio(event) {
  if (event) event.stopPropagation();
  const btn = document.getElementById("btn-play-cv-ref");
  const url = btn?.dataset?.url || _cvUploadedRefAudioPath;
  if (!url) return;

  if (!window._cvRefAudio) window._cvRefAudio = new Audio();
  const a = window._cvRefAudio;
  if (a.src.includes(url) && !a.paused) {
    a.pause();
    if (btn) btn.textContent = "▶";
  } else {
    a.src = url.startsWith("/") ? url : `/${url}`;
    a.play().catch(() => {});
    if (btn) btn.textContent = "⏸";
    a.onended = () => { if (btn) btn.textContent = "▶"; };
  }
}
window.handlePlayCvRefAudio = handlePlayCvRefAudio;

async function handleSaveCreatedVoiceRef() {
  const name = document.getElementById("cv-ref-name")?.value?.trim();
  if (!name) {
    showToast("⚠️ Voice Name is required", "warning");
    document.getElementById("cv-ref-name")?.focus();
    return;
  }

  if (!_cvUploadedRefAudioPath) {
    showToast("⚠️ Please upload a 3–8s reference audio clip first", "warning");
    return;
  }

  const gender = document.getElementById("cv-ref-gender")?.value || "Custom";
  const accent = document.getElementById("cv-ref-accent")?.value || "Custom";
  const transcript = document.getElementById("cv-ref-transcript")?.value?.trim() || "";
  const timbre = document.getElementById("cv-ref-timbre")?.value?.trim() || "";
  const emotion = document.getElementById("cv-ref-emotion")?.value?.trim() || "";

  showToast(`⏳ Saving voice "${name}" to library...`);
  try {
    const res = await fetch("/api/voices/save_to_library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        gender,
        accent,
        timbre: timbre || `${gender} ${accent} Voice`,
        default_emotion_tag: emotion || "[clear, natural]",
        reference_text: transcript,
        reference_audio: _cvUploadedRefAudioPath
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Save failed");

    await loadVoices();
    const createdVoice = data.voice;

    if (state.selectingVoiceForChar) {
      const select = document.getElementById("char-modal-voice-select");
      if (select && createdVoice) {
        let opt = Array.from(select.options).find(o => o.value === createdVoice.id);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = createdVoice.id;
          opt.textContent = `${createdVoice.name} (${createdVoice.gender || ''} ${createdVoice.accent || ''})`;
          select.appendChild(opt);
        }
        select.value = createdVoice.id;
      }
      if (createdVoice) updateCharModalVoiceDetails(createdVoice.id);
      closeVoiceDrawer();
      showToast(`✓ Created & selected "${name}" for character!`, "success");
    } else {
      switchDrawerMode("browse");
      renderVoiceList();
      showToast(`✅ Created voice "${name}" and added to your library!`, "success");
    }
  } catch (err) {
    showToast(`❌ Save failed: ${err.message}`, "error");
  }
}
window.handleSaveCreatedVoiceRef = handleSaveCreatedVoiceRef;

async function handleForgeVoicePreview() {
  const name = document.getElementById("cv-prompt-name")?.value?.trim();
  const desc = document.getElementById("cv-prompt-desc")?.value?.trim();
  const sampleText = document.getElementById("cv-prompt-sample-text")?.value?.trim() || "In the deepest shadows of the corridor, something moved.";
  const btn = document.getElementById("btn-forge-voice-preview");

  if (!desc) {
    showToast("⚠️ Please enter a voice description prompt", "warning");
    document.getElementById("cv-prompt-desc")?.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span> Synthesizing voice sample...`;
  }

  try {
    const res = await fetch("/api/render_block", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: sampleText,
        voice_id: "blend_fenrir_onyx",
        prompt: `[${desc}]`,
        speed: 0.90,
        pause_after: 0.5
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Synthesis failed");

    _cvPromptSampleAudioUrl = data.audio_url;
    const card = document.getElementById("cv-prompt-preview-card");
    const durSpan = document.getElementById("cv-prompt-preview-dur");
    const timbreSpan = document.getElementById("cv-prompt-preview-timbre");
    const saveBtn = document.getElementById("btn-save-prompt-to-library");

    if (card) card.style.display = "block";
    if (durSpan) durSpan.textContent = data.duration ? `${data.duration.toFixed(1)}s` : "Audition";
    if (timbreSpan) timbreSpan.textContent = desc.slice(0, 50) + (desc.length > 50 ? "..." : "");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = "1";
      saveBtn.style.cursor = "pointer";
    }

    handlePlayCvPromptPreview();
    showToast("✅ Voice sample synthesized! Click Play to listen.");
  } catch (err) {
    showToast(`❌ Forge preview failed: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `⚡ Generate & Test Voice Preview`;
    }
  }
}
window.handleForgeVoicePreview = handleForgeVoicePreview;

function handlePlayCvPromptPreview() {
  const btn = document.getElementById("btn-play-prompt-preview");
  if (!_cvPromptSampleAudioUrl) return;

  if (!window._cvPromptAudio) window._cvPromptAudio = new Audio();
  const a = window._cvPromptAudio;
  if (a.src.includes(_cvPromptSampleAudioUrl) && !a.paused) {
    a.pause();
    if (btn) btn.textContent = "▶ Play Sample";
  } else {
    a.src = _cvPromptSampleAudioUrl;
    a.play().catch(() => {});
    if (btn) btn.textContent = "⏸ Pause";
    a.onended = () => { if (btn) btn.textContent = "▶ Play Sample"; };
  }
}
window.handlePlayCvPromptPreview = handlePlayCvPromptPreview;

async function handleSaveCreatedVoicePrompt() {
  const name = document.getElementById("cv-prompt-name")?.value?.trim() || "Forged AI Voice";
  const desc = document.getElementById("cv-prompt-desc")?.value?.trim() || "";

  showToast(`⏳ Saving voice "${name}"...`);
  try {
    const res = await fetch("/api/voices/save_to_library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        gender: "Custom",
        accent: "Custom",
        timbre: desc.slice(0, 60),
        default_emotion_tag: `[${desc}]`,
        reference_audio: _cvPromptSampleAudioUrl,
        reference_text: document.getElementById("cv-prompt-sample-text")?.value?.trim() || ""
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Save failed");

    await loadVoices();
    const createdVoice = data.voice;

    if (state.selectingVoiceForChar) {
      const select = document.getElementById("char-modal-voice-select");
      if (select && createdVoice) {
        let opt = Array.from(select.options).find(o => o.value === createdVoice.id);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = createdVoice.id;
          opt.textContent = `${createdVoice.name} (${createdVoice.gender || ''} ${createdVoice.accent || ''})`;
          select.appendChild(opt);
        }
        select.value = createdVoice.id;
      }
      if (createdVoice) updateCharModalVoiceDetails(createdVoice.id);
      closeVoiceDrawer();
      showToast(`✓ Created & selected "${name}" for character!`, "success");
    } else {
      switchDrawerMode("browse");
      renderVoiceList();
      showToast(`✅ Created voice "${name}" and added to your library!`, "success");
    }
  } catch (err) {
    showToast(`❌ Save failed: ${err.message}`, "error");
  }
}
window.handleSaveCreatedVoicePrompt = handleSaveCreatedVoicePrompt;

// ---------------- PROJECT CREATION & FILE IMPORT MODAL ---------------- //

function cleanTitleFromFilename(filename) {
  if (!filename) return "New Story Project";
  let base = filename.replace(/\.[^/.]+$/, "");
  base = base.replace(/[_]/g, " ").trim();
  if (base.length > 0 && (base === base.toUpperCase() || base === base.toLowerCase())) {
    base = base.replace(/\b\w/g, l => l.toUpperCase());
  }
  return base || "New Story Project";
}

function openNewProjectModal() {
  const modal = document.getElementById("new-project-modal");
  if (!modal) return;
  modal.classList.add("active");
  handleNewProjectTierChange(currentNewProjectTier || "standard");
  const input = document.getElementById("new-project-title-input");
  if (input && !input.value.trim()) {
    input.value = "New Story Project";
    input.focus();
  }
}

function closeNewProjectModal() {
  const modal = document.getElementById("new-project-modal");
  if (modal) modal.classList.remove("active");
  clearNewProjectFile();
}

function clearNewProjectFile() {
  const fileInput = document.getElementById("new-project-file-input");
  if (fileInput) fileInput.value = "";
  const badge = document.getElementById("new-project-file-badge");
  if (badge) badge.style.display = "none";
}

function handleDashboardFileImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  processImportedFile(file, "dashboard");
  e.target.value = "";
}

function handleNewProjectFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  processImportedFile(file, "new_project_modal");
  e.target.value = "";
}

function handleImportModalFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    const textarea = document.getElementById("import-textarea");
    if (textarea) textarea.value = text;
    showToast(`✓ Loaded "${file.name}" (${(text.length / 1024).toFixed(1)} KB)`);
  };
  reader.readAsText(file, "UTF-8");
  e.target.value = "";
}

async function loadSampleIntoNewProject() {
  try {
    showToast("📚 Loading sample story...");
    const res = await fetch("/api/sample_story");
    if (!res.ok) throw new Error("Could not fetch sample story");
    const data = await res.json();

    const titleInput = document.getElementById("new-project-title-input");
    const textInput = document.getElementById("new-project-text-input");
    const badge = document.getElementById("new-project-file-badge");
    const nameSpan = document.getElementById("new-project-file-name");

    if (titleInput) titleInput.value = data.title || "The Endless Eclipse - Sample";
    if (textInput) textInput.value = data.text || "";
    if (badge && nameSpan) {
      nameSpan.textContent = "📚 THE ENDLESS ECLIPSE - Sample.txt";
      badge.style.display = "flex";
    }
    showToast("✓ Loaded sample story: The Endless Eclipse");
  } catch (err) {
    showToast("❌ Failed to load sample story: " + err.message);
  }
}

let isImportingProjectJson = false;
let currentEpubData = null;

function processImportedFile(file, targetContext) {
  if (isImportingProjectJson) return;

  if (file.name.toLowerCase().endsWith(".epub")) {
    handleEpubFileUpload(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = async (event) => {
    const content = event.target.result;
    const isJson = file.name.toLowerCase().endsWith(".json");

    if (isJson) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.blocks && Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
          isImportingProjectJson = true;
          showToast(`📥 Importing project JSON "${parsed.title || file.name}"...`);
          const title = parsed.title || cleanTitleFromFilename(file.name);
          const defaultVoice = parsed.default_voice || "blend_fenrir_onyx";
          try {
            const res = await fetch("/api/projects/new", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: title,
                default_voice: defaultVoice,
                blocks: parsed.blocks
              })
            });
            const newProj = await res.json();
            if (newProj && newProj.id) {
              closeNewProjectModal();
              window.open(`/studio?project=${encodeURIComponent(newProj.id)}`, "_blank");
              loadProjectsList();
              showToast(`✓ Project "${title}" imported with ${parsed.blocks.length} sentences!`);
              return;
            }
          } finally {
            isImportingProjectJson = false;
          }
        } else if (parsed.text) {
          applyTextToFileModal(parsed.title || cleanTitleFromFilename(file.name), parsed.text, file.name);
          return;
        }
      } catch (jsonErr) {
        console.warn("JSON parse error, falling back to raw text:", jsonErr);
      } finally {
        isImportingProjectJson = false;
      }
    }

    const inferredTitle = cleanTitleFromFilename(file.name);
    applyTextToFileModal(inferredTitle, content, file.name);
  };
  reader.readAsText(file, "UTF-8");
}

function applyTextToFileModal(title, text, fileName) {
  const titleInput = document.getElementById("new-project-title-input");
  const textInput = document.getElementById("new-project-text-input");
  const badge = document.getElementById("new-project-file-badge");
  const nameSpan = document.getElementById("new-project-file-name");

  if (titleInput) titleInput.value = title;
  if (textInput) textInput.value = text;
  if (badge && nameSpan) {
    nameSpan.textContent = `📄 ${fileName}`;
    badge.style.display = "flex";
  }

  const modal = document.getElementById("new-project-modal");
  if (modal && !modal.classList.contains("active")) {
    modal.classList.add("active");
    populateVoiceSelects();
  }
  showToast(`✓ Loaded "${fileName}" (${(text.length / 1024).toFixed(1)} KB)`);
}

async function handleEpubFileUpload(file) {
  showToast("📚 Inspecting EPUB ebook chapters...");
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/epub/inspect", {
      method: "POST",
      body: formData
    });
    if (!res.ok) throw new Error("Could not parse EPUB file");
    const data = await res.json();
    if (!data.ok || !data.books || data.books.length === 0) {
      throw new Error(data.error || "No readable chapters found in this EPUB");
    }

    currentEpubData = data;
    openEpubModal(data);
  } catch (err) {
    showToast("❌ EPUB Error: " + err.message, 5000);
  }
}

function openEpubModal(data) {
  const modal = document.getElementById("epub-import-modal");
  if (!modal) return;

  const subtitle = document.getElementById("epub-modal-subtitle");
  if (subtitle) {
    subtitle.textContent = `${data.file_name} (${data.total_books} volume${data.total_books > 1 ? 's' : ''})`;
  }

  const bookPickerRow = document.getElementById("epub-book-picker-row");
  const bookSelect = document.getElementById("epub-book-select");

  if (data.total_books > 1) {
    if (bookPickerRow) bookPickerRow.style.display = "block";
    if (bookSelect) {
      bookSelect.innerHTML = data.books.map(b => 
        `<option value="${b.book_index}">Book ${b.book_index}: ${escapeHtml(b.title)} (${b.chapters_count} chs, ${b.total_words.toLocaleString()} words)</option>`
      ).join("");
    }
  } else {
    if (bookPickerRow) bookPickerRow.style.display = "none";
  }

  populateEpubChapters();
  modal.classList.add("active");
}

function closeEpubModal() {
  const modal = document.getElementById("epub-import-modal");
  if (modal) modal.classList.remove("active");
}

function handleEpubBookChange() {
  populateEpubChapters();
}

function populateEpubChapters() {
  if (!currentEpubData) return;
  const bookSelect = document.getElementById("epub-book-select");
  const bIdx = (bookSelect && currentEpubData.total_books > 1) ? parseInt(bookSelect.value, 10) : 1;
  const book = currentEpubData.books.find(b => b.book_index === bIdx) || currentEpubData.books[0];
  if (!book) return;

  const chSelect = document.getElementById("epub-chapter-select");
  if (chSelect) {
    chSelect.innerHTML = book.chapters.map(c => 
      `<option value="${c.chapter_index}" data-file="${c.file_path}" data-words="${c.word_count}" data-mins="${c.estimated_minutes}">
        ${escapeHtml(c.title)} (${c.word_count.toLocaleString()} words • ~${c.estimated_minutes} min)
      </option>`
    ).join("");
  }

  handleEpubChapterChange();
}

function handleEpubChapterChange() {
  if (!currentEpubData) return;
  const bookSelect = document.getElementById("epub-book-select");
  const bIdx = (bookSelect && currentEpubData.total_books > 1) ? parseInt(bookSelect.value, 10) : 1;
  const book = currentEpubData.books.find(b => b.book_index === bIdx) || currentEpubData.books[0];
  if (!book) return;

  const chSelect = document.getElementById("epub-chapter-select");
  const chIdx = chSelect ? parseInt(chSelect.value, 10) : 1;
  const ch = book.chapters.find(c => c.chapter_index === chIdx) || book.chapters[0];
  if (!ch) return;

  const statsTitle = document.getElementById("epub-stats-title");
  const statsDesc = document.getElementById("epub-stats-desc");

  if (statsTitle) {
    statsTitle.textContent = `${book.title} - ${ch.title}`;
  }
  if (statsDesc) {
    statsDesc.textContent = `~${ch.word_count.toLocaleString()} words • Estimated Audio: ${ch.estimated_minutes} mins (~${Math.ceil(ch.word_count / 35)} speech blocks)`;
  }
}

function startLiveProgressTracker(jobId, options) {
  const {
    containerId,
    barId,
    percentId,
    stepId,
    msgId,
    charsId,
    initialStep = "AI Director Working...",
    initialMsg = "Discovering characters & casting library voices...",
    onComplete
  } = options;

  const container = document.getElementById(containerId);
  const bar = document.getElementById(barId);
  const percentEl = document.getElementById(percentId);
  const stepEl = document.getElementById(stepId);
  const msgEl = document.getElementById(msgId);
  const charsEl = document.getElementById(charsId);

  if (container) container.style.display = "block";
  if (bar) bar.style.width = "10%";
  if (percentEl) percentEl.textContent = "10%";
  if (stepEl) stepEl.textContent = initialStep;
  if (msgEl) msgEl.textContent = initialMsg;
  if (charsEl) {
    charsEl.innerHTML = "";
    charsEl.style.display = "none";
  }

  let currentDisplayPct = 10;
  let targetPct = 15;
  let isDone = false;
  let knownCharIds = new Set();

  const animInterval = setInterval(() => {
    if (isDone) {
      currentDisplayPct = 100;
      if (bar) bar.style.width = "100%";
      if (percentEl) percentEl.textContent = "100%";
      clearInterval(animInterval);
      return;
    }
    if (currentDisplayPct < targetPct) {
      currentDisplayPct += Math.max(0.4, Math.min(2.5, (targetPct - currentDisplayPct) * 0.25));
    }
    const rounded = Math.min(99, Math.round(currentDisplayPct));
    if (bar) bar.style.width = `${rounded}%`;
    if (percentEl) percentEl.textContent = `${rounded}%`;
  }, 100);

  const pollInterval = setInterval(async () => {
    if (isDone) {
      clearInterval(pollInterval);
      return;
    }
    try {
      const res = await fetch(`/api/job_progress?job_id=${encodeURIComponent(jobId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !data.job) return;

      const job = data.job;
      if (typeof job.percent === "number" && job.percent > targetPct) {
        targetPct = job.percent;
      }
      if (job.step && stepEl) {
        if (job.step === "casting") stepEl.textContent = "🎭 Phase 1: Casting Story Characters...";
        else if (job.step === "cast_ready") stepEl.textContent = "✨ Phase 1 Complete: Cast Established";
        else if (job.step === "directing") stepEl.textContent = "✍️ Phase 2: Directing Script & Dialogue...";
        else if (job.step === "done") stepEl.textContent = "✨ Directing Complete! Opening Studio...";
      }
      if (job.message && msgEl) {
        msgEl.textContent = job.message;
      }

      if (Array.isArray(job.characters) && job.characters.length > 0 && charsEl) {
        charsEl.style.display = "flex";
        job.characters.forEach(c => {
          const cid = c.id || c.name;
          if (!knownCharIds.has(cid)) {
            knownCharIds.add(cid);
            const badge = document.createElement("span");
            badge.style.cssText = `background: ${c.color || '#8b5cf6'}22; color: ${c.color || '#c4b5fd'}; border: 1px solid ${c.color || '#8b5cf6'}55; border-radius: 4px; padding: 2px 7px; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;`;
            badge.innerHTML = `🎭 ${escapeHtml(c.name || 'Character')} <span style="opacity: 0.7; font-size: 9.5px; font-family: monospace;">(${escapeHtml(c.assigned_voice_id || c.voice_id || '')})</span>`;
            charsEl.appendChild(badge);
          }
        });
      }

      if (job.status === "done" || job.percent >= 100) {
        isDone = true;
        clearInterval(pollInterval);
        clearInterval(animInterval);
        if (bar) bar.style.width = "100%";
        if (percentEl) percentEl.textContent = "100%";
        if (stepEl) stepEl.textContent = "✨ Directing Complete! Loading Workspace...";
        if (typeof onComplete === "function") {
          onComplete(job);
        }
      }
    } catch (e) {
      console.warn("Progress poll error:", e);
    }
  }, 400);

  return {
    finish(msg) {
      isDone = true;
      clearInterval(pollInterval);
      clearInterval(animInterval);
      if (bar) bar.style.width = "100%";
      if (percentEl) percentEl.textContent = "100%";
      if (stepEl) stepEl.textContent = msg || "✨ Complete! Loading Project...";
    },
    hide() {
      isDone = true;
      clearInterval(pollInterval);
      clearInterval(animInterval);
      if (container) container.style.display = "none";
    }
  };
}

function toggleEpubCastMode(mode) {
  const lblMulti = document.getElementById("lbl-epub-mode-multi");
  const lblSingle = document.getElementById("lbl-epub-mode-single");
  const opts = document.getElementById("epub-multi-options");
  const btn = document.getElementById("btn-confirm-epub-import");
  const pill = document.getElementById("epub-ai-status-pill");
  const heading = document.getElementById("epub-ai-options-heading");
  const subtitle = document.getElementById("epub-ai-options-subtitle");

  if (opts) opts.style.display = "flex";

  if (mode === "multi") {
    if (lblMulti) {
      lblMulti.style.border = "1.5px solid #8b5cf6";
      lblMulti.style.background = "rgba(139, 92, 246, 0.12)";
    }
    if (lblSingle) {
      lblSingle.style.border = "1px solid var(--border-color)";
      lblSingle.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (pill) {
      pill.textContent = "✨ AI Director: Multi-Cast Drama";
      pill.style.background = "rgba(139, 92, 246, 0.15)";
      pill.style.color = "#c4b5fd";
      pill.style.borderColor = "rgba(139, 92, 246, 0.3)";
    }
    if (heading) heading.innerHTML = `🎭 AI Multi-Cast Drama Direction`;
    if (subtitle) subtitle.textContent = "Multi-Voice Cast & Dialogue Split";
    if (btn) {
      btn.innerHTML = `🎭 Create &amp; AI Direct Chapter`;
      btn.style.background = "linear-gradient(135deg, #8b5cf6, #10b981)";
    }
  } else {
    if (lblMulti) {
      lblMulti.style.border = "1px solid var(--border-color)";
      lblMulti.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (lblSingle) {
      lblSingle.style.border = "1.5px solid #10b981";
      lblSingle.style.background = "rgba(16, 185, 129, 0.12)";
    }
    if (pill) {
      pill.textContent = '✨ AI Director: Solo Narrator (Split & Tagged "")';
      pill.style.background = "rgba(16, 185, 129, 0.15)";
      pill.style.color = "#6ee7b7";
      pill.style.borderColor = "rgba(16, 185, 129, 0.3)";
    }
    if (heading) heading.innerHTML = `🎙️ AI Solo Narrator Direction`;
    if (subtitle) subtitle.textContent = 'Solo Voice Actor with Spoken "" Split & Acting Tags';
    if (btn) {
      btn.innerHTML = `🎙️ Create &amp; AI Direct Solo Chapter`;
      btn.style.background = "linear-gradient(135deg, #10b981, #059669)";
    }
  }
}

function toggleNewProjMode(mode) {
  const lblMulti = document.getElementById("lbl-new-proj-multi");
  const lblSingle = document.getElementById("lbl-new-proj-single");
  const btn = document.getElementById("btn-create-project-submit");
  const heading = document.getElementById("new-proj-ai-options-heading");
  const subtitle = document.getElementById("new-proj-ai-options-subtitle");

  if (mode === "multi") {
    if (lblMulti) {
      lblMulti.style.border = "1.5px solid #8b5cf6";
      lblMulti.style.background = "rgba(139, 92, 246, 0.12)";
    }
    if (lblSingle) {
      lblSingle.style.border = "1px solid var(--border-color)";
      lblSingle.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (heading) heading.innerHTML = `🎭 AI Multi-Cast Drama Direction`;
    if (subtitle) subtitle.textContent = "Multi-Voice Cast & Dialogue Split";
    if (btn) {
      btn.innerHTML = `🎭 Create &amp; AI Direct Studio`;
      btn.style.background = "linear-gradient(135deg, #8b5cf6, #10b981)";
    }
  } else {
    if (lblMulti) {
      lblMulti.style.border = "1px solid var(--border-color)";
      lblMulti.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (lblSingle) {
      lblSingle.style.border = "1.5px solid #10b981";
      lblSingle.style.background = "rgba(16, 185, 129, 0.12)";
    }
    if (heading) heading.innerHTML = `🎙️ AI Solo Narrator Direction`;
    if (subtitle) subtitle.textContent = 'Solo Voice Actor with Spoken "" Split & Acting Tags';
    if (btn) {
      btn.innerHTML = `🎙️ Create &amp; AI Direct Solo Story`;
      btn.style.background = "linear-gradient(135deg, #10b981, #059669)";
    }
  }
}

async function confirmEpubChapterImport() {
  if (!currentEpubData) return;
  const bookSelect = document.getElementById("epub-book-select");
  const bIdx = (bookSelect && currentEpubData.total_books > 1) ? parseInt(bookSelect.value, 10) : 1;
  const chSelect = document.getElementById("epub-chapter-select");
  const chIdx = chSelect ? parseInt(chSelect.value, 10) : 1;
  const book = currentEpubData.books.find(b => b.book_index === bIdx) || currentEpubData.books[0];
  const ch = (book && book.chapters) ? (book.chapters.find(c => c.chapter_index === chIdx) || book.chapters[0]) : null;
  const voiceSelect = document.getElementById("epub-voice-select");
  const voiceId = voiceSelect ? voiceSelect.value : "voice_stanley_narrator";

  const isMulti = document.getElementById("epub-mode-multi")?.checked ?? true;
  const castMode = isMulti ? "multi" : "single";
  const aiModel = document.getElementById("epub-ai-model")?.value || "gemini-3.5-flash-lite";
  const splitDial = document.getElementById("epub-split-dialogue")?.checked ?? true;
  const addEmotions = document.getElementById("epub-acting-tags")?.checked ?? true;
  const tagIntensity = document.getElementById("epub-tag-intensity")?.value || "balanced";
  const analysisTemp = parseFloat(document.getElementById("epub-analysis-temp")?.value || "0.60");
  const splitLongEmotional = document.getElementById("epub-split-emotional-beats")?.checked ?? true;
  const tagPlacement = document.getElementById("epub-tag-placement")?.value || "pill";

  const confirmBtn = document.getElementById("btn-confirm-epub-import");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = isMulti
      ? `<span>⏳ Casting Characters & Directing Script with AI...</span>`
      : `<span>⏳ Directing Solo Narrator Dialogue Beats & Tags with AI...</span>`;
  }

  const jobId = "job_epub_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  const progressTracker = startLiveProgressTracker(jobId, {
    containerId: "epub-progress-container",
    barId: "epub-progress-bar",
    percentId: "epub-progress-percent",
    stepId: "epub-progress-step",
    msgId: "epub-progress-msg",
    charsId: "epub-progress-characters",
    initialStep: isMulti ? "🎭 Phase 1: Casting Story Characters..." : "🎙️ Phase 1: Analyzing Story & Dialogue Beats...",
    initialMsg: isMulti ? "Analyzing manuscript & matching distinct library voices..." : "Analyzing manuscript & preparing solo narrator dialogue beats..."
  });

  try {
    showToast(isMulti ? "🎭 AI Director: Discovering characters, casting voices & injecting acting tags..." : '🎙️ AI Director: Slicing spoken "" into dialogue beats & applying narrator tags...');
    const res = await fetch("/api/epub/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        epub_path: currentEpubData.epub_path,
        book_index: bIdx,
        chapter_index: chIdx,
        title: (book && ch) ? `${book.title} - ${ch.title}` : undefined,
        folder_id: (document.getElementById("epub-folder-select")?.value === "__new__" ? null : (document.getElementById("epub-folder-select")?.value || null)),
        new_folder_title: (document.getElementById("epub-folder-select")?.value === "__new__" ? (book?.title || "New Audiobook Series") : null),
        engine: (state.activeEngine || "fish_s2"),
        default_voice: voiceId,
        ai_direct: true,
        cast_mode: castMode,
        ai_model: aiModel,
        split_dialogue: splitDial,
        add_emotions: addEmotions,
        acting_intensity: tagIntensity,
        analysis_temperature: analysisTemp,
        split_long_emotional_blocks: splitLongEmotional,
        tag_placement: tagPlacement
      })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to import chapter");

    if (progressTracker) {
      progressTracker.finish("✨ Audiobook Chapter Ready! Opening Studio...");
    }

    showToast(`✓ Created Audiobook Chapter: "${data.title}" with ${data.blocks_count} sentences!`);
    loadProjectsList();

    setTimeout(() => {
      closeEpubModal();
      if (progressTracker) progressTracker.hide();
      if (data.url) {
        window.location.href = data.url;
      }
    }, 600);
  } catch (err) {
    if (progressTracker) progressTracker.hide();
    showToast("❌ Import failed: " + err.message, 5000);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = isMulti ? `🎭 Create &amp; AI Direct Chapter` : `🎙️ Create &amp; AI Direct Solo Chapter`;
    }
  }
}

let isCreatingProject = false;
let currentNewProjectDirectorMode = "ai"; // "ai" or "manual"

function handleNewProjectDirectorModeChange(mode) {
  currentNewProjectDirectorMode = mode || "ai";
  const lblAi = document.getElementById("lbl-proj-mode-ai");
  const lblManual = document.getElementById("lbl-proj-mode-manual");
  const aiSettingsContainer = document.getElementById("new-project-ai-settings-container");
  const submitBtn = document.getElementById("btn-create-project-submit");

  if (currentNewProjectDirectorMode === "ai") {
    if (lblAi) {
      lblAi.style.borderColor = "#8b5cf6";
      lblAi.style.background = "rgba(139, 92, 246, 0.12)";
    }
    if (lblManual) {
      lblManual.style.borderColor = "var(--border-color)";
      lblManual.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (aiSettingsContainer) aiSettingsContainer.style.display = "block";
    if (submitBtn) {
      submitBtn.innerHTML = `🎭 Create &amp; AI Direct Studio`;
      submitBtn.style.background = "linear-gradient(135deg, #8b5cf6, #10b981)";
    }
  } else {
    if (lblManual) {
      lblManual.style.borderColor = "#8b5cf6";
      lblManual.style.background = "rgba(139, 92, 246, 0.12)";
    }
    if (lblAi) {
      lblAi.style.borderColor = "var(--border-color)";
      lblAi.style.background = "rgba(255, 255, 255, 0.03)";
    }
    if (aiSettingsContainer) aiSettingsContainer.style.display = "none";
    if (submitBtn) {
      submitBtn.innerHTML = `⚡ Create Project (Fast Split)`;
      submitBtn.style.background = "linear-gradient(135deg, #3b82f6, #10b981)";
    }
  }
}

async function handleCreateProjectManualFastSplit() {
  await handleCreateProjectSubmit(false);
}

async function handleCreateProjectSubmit(overrideAiDirect = null) {
  if (isCreatingProject) return;

  const submitBtn = document.getElementById("btn-create-project-submit");
  const title = (document.getElementById("new-project-title-input")?.value || "").trim() || "Untitled Project";
  const text = (document.getElementById("new-project-text-input")?.value || "").trim();
  const folderId = document.getElementById("new-project-folder-select")?.value || "";
  const selectedTier = document.querySelector('input[name="new-project-tier"]:checked')?.value || currentNewProjectTier || "standard";
  const selectedVoiceSelect = document.getElementById("new-project-voice-select");
  const selectedVoiceOpt = selectedVoiceSelect?.selectedOptions?.[0];
  const selectedVoiceEngine = selectedVoiceOpt?.getAttribute("data-engine") || (selectedTier === "cinema_pro" ? "fish_s2" : "edge_tts");

  const isFish = selectedVoiceEngine === "fish_s2";
  const fallbackVoice = isFish ? "fish_narrator_dark" : (selectedVoiceEngine === "edge_tts" ? "en-US-GuyNeural" : "blend_fenrir_onyx");
  const defaultVoice = selectedVoiceSelect?.value || fallbackVoice;
  const isMulti = document.getElementById("new-proj-mode-multi")?.checked ?? true;
  const castMode = isMulti ? "multi" : "single";
  const aiModel = document.getElementById("new-proj-ai-model")?.value || "gemini-3.5-flash-lite";
  const splitDial = document.getElementById("new-proj-split-dialogue")?.checked ?? true;
  const addEmotions = document.getElementById("new-proj-acting-tags")?.checked ?? true;
  const tagIntensity = document.getElementById("new-proj-tag-intensity")?.value || "balanced";
  const analysisTemp = parseFloat(document.getElementById("new-proj-analysis-temp")?.value || "0.60");
  const splitLongEmotional = document.getElementById("new-proj-split-emotional-beats")?.checked ?? true;
  const tagPlacement = document.getElementById("new-proj-tag-placement")?.value || "pill";

  const selectedMode = document.querySelector('input[name="new-project-director-mode"]:checked')?.value || currentNewProjectDirectorMode || "ai";
  const shouldAiDirect = (overrideAiDirect !== null) ? Boolean(overrideAiDirect) : (selectedMode === "ai" && Boolean(text));

  isCreatingProject = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    if (shouldAiDirect) {
      submitBtn.innerHTML = isMulti
        ? `<span>⏳ AI Director: Casting & Directing Script...</span>`
        : `<span>⏳ AI Director: Directing Solo Script & Tags...</span>`;
    } else {
      submitBtn.innerHTML = `<span>⚡ Fast Splitting & Creating...</span>`;
    }
  }

  const jobId = "job_proj_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  let progressTracker = null;
  if (shouldAiDirect) {
    progressTracker = startLiveProgressTracker(jobId, {
      containerId: "new-proj-progress-container",
      barId: "new-proj-progress-bar",
      percentId: "new-proj-progress-percent",
      stepId: "new-proj-progress-step",
      msgId: "new-proj-progress-msg",
      charsId: "new-proj-progress-characters",
      initialStep: isMulti ? "🎭 Phase 1: Casting Characters..." : "🎙️ Phase 1: Analyzing Story & Dialogue Beats...",
      initialMsg: isMulti ? "Analyzing text & casting library voices..." : "Analyzing text & preparing solo narrator dialogue beats..."
    });
  }

  const defs = getProjectDefaultSettings();
  try {
    if (shouldAiDirect) {
      showToast(isMulti ? "🎭 AI Director: Discovering characters & directing story..." : '🎙️ AI Director: Slicing spoken "" into dialogue beats & applying narrator tags...');
    } else {
      showToast("⚡ Fast Split: Creating project blocks directly...");
    }
    const res = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        job_id: jobId,
        title, 
        text, 
        tier: selectedTier,
        engine: selectedVoiceEngine,
        folder_id: folderId || undefined,
        default_voice: defaultVoice, 
        defaults: defs,
        ai_direct: shouldAiDirect,
        cast_mode: castMode,
        ai_provider: state.aiAgent?.provider || (aiModel.includes("gemini") ? "gemini" : (aiModel.includes("gpt-4") ? "openai" : "groq")),
        ai_model: aiModel,
        ai_api_key: state.aiAgent?.apiKey || "",
        split_dialogue: splitDial,
        add_emotions: addEmotions,
        acting_intensity: tagIntensity,
        analysis_temperature: analysisTemp,
        split_long_emotional_blocks: splitLongEmotional,
        tag_placement: tagPlacement
      })
    });

    const resText = await res.text();
    let newProj;
    try {
      newProj = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Server returned status ${res.status}: ${resText.slice(0, 160)}`);
    }

    if (!res.ok || (newProj && newProj.ok === false)) {
      throw new Error((newProj && newProj.error) || `Server failed with status ${res.status}`);
    }

    if (progressTracker) {
      progressTracker.finish("✨ Story Directed! Opening Workspace...");
    }

    setTimeout(() => {
      closeNewProjectModal();
      if (progressTracker) progressTracker.hide();
      window.location.href = `/studio?project=${encodeURIComponent(newProj.id)}`;
      loadProjectsList();
    }, 400);
  } catch (err) {
    if (progressTracker) progressTracker.hide();
    alert("Could not create project: " + err);
  } finally {
    isCreatingProject = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = shouldAiDirect ? `🎭 Create &amp; AI Direct Studio` : `⚡ Create Project (Fast Split)`;
    }
  }
}

// ---------------- IMPORT TEXT MODAL ---------------- //

function openImportModal() {
  const modal = document.getElementById("import-modal");
  if (!modal) return;
  modal.classList.add("active");
  populateVoiceSelects();
  const select = document.getElementById("import-voice-select");
  if (select && state.currentProject?.default_voice) {
    select.value = state.currentProject.default_voice;
  }
  const textarea = document.getElementById("import-textarea");
  if (textarea) {
    textarea.value = "";
    textarea.focus();
  }
}

function closeImportModal() {
  const modal = document.getElementById("import-modal");
  if (modal) modal.classList.remove("active");
}

async function handleDoImport() {
  const text = (document.getElementById("import-textarea")?.value || "").trim();
  if (!text) {
    showToast("⚠️ Paste some text to import first.");
    return;
  }
  const defaultVoice = document.getElementById("import-voice-select")?.value || state.currentProject?.default_voice || "blend_fenrir_onyx";
  const defs = getProjectDefaultSettings();
  const cleanPauses = document.getElementById("import-clean-pauses") ? document.getElementById("import-clean-pauses").checked : true;
  const inlineEllipsis = document.getElementById("import-inline-pause-ellipsis") ? document.getElementById("import-inline-pause-ellipsis").checked : true;
  try {
    const res = await fetch("/api/split_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        default_voice: defaultVoice,
        defaults: defs,
        clean_pauses: cleanPauses,
        inline_ellipsis: inlineEllipsis
      })
    });
    const blocks = await res.json();
    if (!state.currentProject) {
      state.currentProject = { id: "proj_default", title: "Story Project", blocks: [] };
    }
    state.currentProject.blocks = blocks;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;
    renderStudio();
    closeImportModal();
    debouncedSave();
    showToast(`✓ Imported and split into ${blocks.length} sentence blocks!`);
  } catch (err) {
    alert("Import error: " + err);
  }
}


// ================= KAGGLE 1-CLICK CLOUD GPU AUTOMATION ================= //
let kagglePollInterval = null;

function switchCloudSection(sec) {
  const gpuBtn = document.getElementById("sec-btn-gpu");
  const apiBtn = document.getElementById("sec-btn-api");
  const gpuSec = document.getElementById("cloud-section-gpu");
  const apiSec = document.getElementById("cloud-section-api");

  if (sec === "api") {
    if (gpuBtn) gpuBtn.classList.remove("active");
    if (apiBtn) apiBtn.classList.add("active");
    if (gpuSec) {
      gpuSec.classList.remove("active");
      gpuSec.style.display = "none";
    }
    if (apiSec) {
      apiSec.classList.add("active");
      apiSec.style.display = "flex";
    }
  } else {
    if (apiBtn) apiBtn.classList.remove("active");
    if (gpuBtn) gpuBtn.classList.add("active");
    if (apiSec) {
      apiSec.classList.remove("active");
      apiSec.style.display = "none";
    }
    if (gpuSec) {
      gpuSec.classList.add("active");
      gpuSec.style.display = "flex";
    }
  }

  const kaggleTab = document.getElementById("tab-content-kaggle");
  const saveBtn = document.getElementById("btn-save-colab");
  if (saveBtn) {
    const isKaggle = (sec === "gpu" && kaggleTab && kaggleTab.classList.contains("active"));
    saveBtn.style.display = isKaggle ? "none" : "inline-block";
  }
}

function switchCloudTab(tabName) {
  if (tabName === "fish" || tabName === "api") {
    switchCloudSection("api");
    return;
  }
  switchCloudSection("gpu");

  document.querySelectorAll("#cloud-section-gpu .cloud-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll("#cloud-section-gpu .cloud-tab-content").forEach(c => c.classList.remove("active"));
  const btn = document.getElementById(`tab-btn-${tabName}`);
  const content = document.getElementById(`tab-content-${tabName}`);
  if (btn) btn.classList.add("active");
  if (content) content.classList.add("active");

  const saveBtn = document.getElementById("btn-save-colab");
  if (saveBtn) {
    saveBtn.style.display = (tabName === "kaggle") ? "none" : "inline-block";
  }

  if (tabName === "custom") {
    detectLocalGpu();
  }
}

function toggleKaggleCredentialsForm() {
  const creds = document.getElementById("kaggle-credentials-section");
  const btn = document.getElementById("btn-toggle-credentials");
  if (!creds) return;
  const isHidden = creds.style.display === "none" || !creds.style.display;
  creds.style.display = isHidden ? "block" : "none";
  if (btn) btn.textContent = isHidden ? "🔼 Collapse" : "✏️ Edit Token";
}

function handleKaggleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("kaggle-dropzone");
  if (dz) dz.classList.add("dragover");
}

function handleKaggleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("kaggle-dropzone");
  if (dz) dz.classList.remove("dragover");
}

function handleKaggleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const dz = document.getElementById("kaggle-dropzone");
  if (dz) dz.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    processKaggleJsonFile(e.dataTransfer.files[0]);
  }
}

function handleKaggleFileSelect(e) {
  if (e.target.files && e.target.files.length) {
    processKaggleJsonFile(e.target.files[0]);
  }
}

function processKaggleJsonFile(file) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.username && data.key) {
        const uInput = document.getElementById("kaggle-username-input");
        const kInput = document.getElementById("kaggle-key-input");
        if (uInput) uInput.value = data.username;
        if (kInput) kInput.value = data.key;
        showToast("📄 Loaded credentials from kaggle.json! Verifying with Kaggle...");
        await handleVerifyKaggle();
      } else {
        showToast("⚠️ Invalid kaggle.json: Must contain 'username' and 'key' fields.");
      }
    } catch (err) {
      showToast("❌ Error reading JSON file: " + err.message);
    }
  };
  reader.readAsText(file);
}

async function handleVerifyKaggle() {
  const uInput = document.getElementById("kaggle-username-input");
  const kInput = document.getElementById("kaggle-key-input");
  const statusEl = document.getElementById("kaggle-verify-status");
  const btn = document.getElementById("btn-verify-kaggle");

  const username = (uInput?.value || "").trim();
  const key = (kInput?.value || "").trim();

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = `<span style="color: var(--text-muted);">⏳ Verifying credentials with Kaggle API...</span>`;

  try {
    const res = await fetch("/api/cloud/kaggle/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, key })
    });
    const data = await res.json();
    if (data.ok) {
      if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">✓ Verified: @${data.username} • GPU Quota: ${data.quota}</span>`;
      
      // Auto-collapse credentials into compact account badge
      const badge = document.getElementById("kaggle-account-badge");
      const badgeUser = document.getElementById("badge-username");
      const creds = document.getElementById("kaggle-credentials-section");
      if (badge && badgeUser) {
        badgeUser.textContent = `@${data.username}`;
        badge.style.display = "flex";
      }
      if (creds) creds.style.display = "none";
      const editBtn = document.getElementById("btn-toggle-credentials");
      if (editBtn) editBtn.textContent = "✏️ Edit Token";

      showToast(`✨ Kaggle account @${data.username} verified! Ready to launch.`);
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger); font-weight: 500;">❌ ${data.error}</span>`;
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">Network error verifying with Kaggle: ${err.message}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================= COLDSTART MASTERCLASS GUIDE ================= //

function toggleColdstartGuideCollapse() {
  const guide = document.getElementById("kaggle-coldstart-guide");
  const btn = document.getElementById("btn-toggle-coldstart-guide");
  if (!guide) return;
  guide.classList.toggle("collapsed");
  const isCollapsed = guide.classList.contains("collapsed");
  if (btn) btn.textContent = isCollapsed ? "Show Tips +" : "Hide Tips —";
}

let coldstartSlideIdx = 0;
let coldstartSlideInterval = null;
let coldstartBootStartTime = null;
let coldstartBootTimerInterval = null;

function startColdstartGuide() {
  const guide = document.getElementById("kaggle-coldstart-guide");
  if (!guide) return;
  guide.style.display = "block";

  if (!coldstartBootStartTime) {
    coldstartBootStartTime = Date.now();
  }

  // Update boot timer & progress bar
  clearInterval(coldstartBootTimerInterval);
  coldstartBootTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - coldstartBootStartTime) / 1000);
    const timerPill = document.getElementById("coldstart-timer-pill");
    const barFill = document.getElementById("coldstart-boot-bar-fill");

    if (timerPill) {
      timerPill.textContent = `⏳ Booting: ${elapsed}s`;
    }
    if (barFill) {
      // Progress over typical 75s
      const pct = Math.min(94, Math.round((elapsed / 75) * 90));
      barFill.style.width = `${pct}%`;
    }
  }, 1000);

  // Auto-advance slides every 7 seconds
  clearInterval(coldstartSlideInterval);
  coldstartSlideInterval = setInterval(() => {
    nextColdstartSlide();
  }, 7000);
}

function stopColdstartGuide(success = true) {
  const guide = document.getElementById("kaggle-coldstart-guide");
  clearInterval(coldstartSlideInterval);
  clearInterval(coldstartBootTimerInterval);

  if (success && guide) {
    const barFill = document.getElementById("coldstart-boot-bar-fill");
    const timerPill = document.getElementById("coldstart-timer-pill");
    if (barFill) barFill.style.width = "100%";
    if (timerPill && coldstartBootStartTime) {
      const elapsed = Math.floor((Date.now() - coldstartBootStartTime) / 1000);
      timerPill.textContent = `✅ Ready in ${elapsed}s!`;
      timerPill.style.color = "#10b981";
      timerPill.style.borderColor = "rgba(16, 185, 129, 0.4)";
      timerPill.style.background = "rgba(16, 185, 129, 0.2)";
    }
  } else if (!success && guide) {
    guide.style.display = "none";
    const timerPill = document.getElementById("coldstart-timer-pill");
    if (timerPill) {
      timerPill.textContent = "⏳ Booting: 0s";
      timerPill.style.color = "";
      timerPill.style.borderColor = "";
      timerPill.style.background = "";
    }
    const barFill = document.getElementById("coldstart-boot-bar-fill");
    if (barFill) barFill.style.width = "0%";
  }
  coldstartBootStartTime = null;
}

function goToColdstartSlide(idx) {
  const totalSlides = 6;
  coldstartSlideIdx = ((idx % totalSlides) + totalSlides) % totalSlides;

  // Update tabs
  document.querySelectorAll(".coldstart-tab").forEach(tab => {
    const sIdx = Number(tab.dataset.slide);
    tab.classList.toggle("active", sIdx === coldstartSlideIdx);
  });

  // Update slides
  document.querySelectorAll(".coldstart-slide").forEach((slide, i) => {
    slide.classList.toggle("active", i === coldstartSlideIdx);
  });

  // Counter
  const counter = document.getElementById("coldstart-slide-counter");
  if (counter) counter.textContent = `${coldstartSlideIdx + 1}/${totalSlides}`;

  // Reset auto-advance timer on manual interaction
  clearInterval(coldstartSlideInterval);
  coldstartSlideInterval = setInterval(() => {
    nextColdstartSlide();
  }, 7000);
}

function nextColdstartSlide() {
  goToColdstartSlide(coldstartSlideIdx + 1);
}

function prevColdstartSlide() {
  goToColdstartSlide(coldstartSlideIdx - 1);
}

window.goToColdstartSlide = goToColdstartSlide;
window.nextColdstartSlide = nextColdstartSlide;
window.prevColdstartSlide = prevColdstartSlide;

let trafficAlertDismissed = false;

function formatQueueTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function dismissTrafficAlert() {
  trafficAlertDismissed = true;
  const trafficBox = document.getElementById("kaggle-traffic-alert");
  if (trafficBox) trafficBox.style.display = "none";
  showToast("Waiting for Kaggle queue. We will activate the moment your container wakes up!");
}

async function handleSwitchToColabFast() {
  try {
    const res = await fetch(`/api/colab_script?engine=fish_s2`);
    const scriptText = await res.text();
    await navigator.clipboard.writeText(scriptText);
    showToast("📋 1-cell Fish Speech S2 Pro worker script copied to clipboard!");
  } catch (err) {
    console.warn("Clipboard copy notice:", err);
  }

  // Cancel Kaggle queue immediately so it does not linger in Kaggle's queue
  fetch("/api/cloud/kaggle/stop", { method: "POST" }).catch(() => {});
  clearInterval(kagglePollInterval);
  stopColdstartGuide(false);
  const trafficBox = document.getElementById("kaggle-traffic-alert");
  if (trafficBox) trafficBox.style.display = "none";
  trafficAlertDismissed = false;
  const stopBtn = document.getElementById("btn-stop-kaggle");
  if (stopBtn) stopBtn.style.display = "none";
  const stepper = document.getElementById("kaggle-stepper-box");
  if (stepper) stepper.style.display = "none";
  const launchBtn = document.getElementById("btn-launch-kaggle");
  if (launchBtn) {
    launchBtn.disabled = false;
    launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
    launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
  }

  showToast("📋 1-Cell Worker Script copied to clipboard! Opening Google Colab...", 4500);
  setTimeout(() => {
    window.open("https://colab.research.google.com", "_blank");
  }, 250);
  switchCloudSection("gpu");
  switchCloudTab("colab");
}

function handleSwitchToFishProFast() {
  // Cancel Kaggle queue immediately so it does not linger in Kaggle's queue
  fetch("/api/cloud/kaggle/stop", { method: "POST" }).catch(() => {});
  clearInterval(kagglePollInterval);
  stopColdstartGuide(false);
  const trafficBox = document.getElementById("kaggle-traffic-alert");
  if (trafficBox) trafficBox.style.display = "none";
  trafficAlertDismissed = false;
  const stopBtn = document.getElementById("btn-stop-kaggle");
  if (stopBtn) stopBtn.style.display = "none";
  const stepper = document.getElementById("kaggle-stepper-box");
  if (stepper) stepper.style.display = "none";
  const launchBtn = document.getElementById("btn-launch-kaggle");
  if (launchBtn) {
    launchBtn.disabled = false;
    launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
    launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
  }

  switchCloudTab("fish");
  const keyInput = document.getElementById("fish-api-key-input");
  if (keyInput) {
    keyInput.focus();
    keyInput.select();
  }
  showToast("🔑 Switched to Fish Audio Pro API! Kaggle queue cancelled.");
}

async function handleCancelKaggleAndDirectLocal() {
  clearInterval(kagglePollInterval);
  stopColdstartGuide(false);
  const trafficBox = document.getElementById("kaggle-traffic-alert");
  if (trafficBox) trafficBox.style.display = "none";
  trafficAlertDismissed = false;

  try {
    await fetch("/api/cloud/kaggle/stop", { method: "POST" });
  } catch (e) {
    console.warn("Cancel Kaggle notice:", e);
  }

  const stopBtn = document.getElementById("btn-stop-kaggle");
  if (stopBtn) stopBtn.style.display = "none";
  const stepper = document.getElementById("kaggle-stepper-box");
  if (stepper) stepper.style.display = "none";
  const launchBtn = document.getElementById("btn-launch-kaggle");
  if (launchBtn) {
    launchBtn.disabled = false;
    launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
    launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
  }

  closeColabModal();
  showToast("🎨 Kaggle queue cancelled. Directing story with Local CPU!");
}

function handleContinueInBackground() {
  closeColabModal();
  showToast("🎨 Directing with Local CPU. Kaggle is queuing in background — we'll switch to GPU automatically once ready!", 5500);
}

async function handleLaunchKaggle() {
  const uInput = document.getElementById("kaggle-username-input");
  const kInput = document.getElementById("kaggle-key-input");
  const launchBtn = document.getElementById("btn-launch-kaggle");
  const stopBtn = document.getElementById("btn-stop-kaggle");
  const stepper = document.getElementById("kaggle-stepper-box");
  const statusEl = document.getElementById("kaggle-verify-status");
  const warnEl = document.getElementById("kaggle-key-warning");

  const username = (uInput?.value || "").trim();
  const key = (kInput?.value || "").trim();

  if (key.startsWith("sk-fish-")) {
    if (warnEl) {
      warnEl.style.display = "block";
      warnEl.innerHTML = "⚠️ That's a Fish Audio API key! Please use the 'Fish Audio Pro API' tab above. For Kaggle GPU, use your 32-character token from kaggle.json.";
    }
    return;
  }

  if (!username && !key) {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    if (!cfg.kaggle_username && !cfg.kaggle_has_key) {
      showToast("⚠️ Please provide your Kaggle Username & API Key or drop your kaggle.json file first.");
      return;
    }
  }

  // De-congest credentials form on launch
  const creds = document.getElementById("kaggle-credentials-section");
  if (creds) creds.style.display = "none";
  const badge = document.getElementById("kaggle-account-badge");
  const badgeUser = document.getElementById("badge-username");
  if (badge && badgeUser && username) {
    badgeUser.textContent = `@${username}`;
    badge.style.display = "flex";
  }
  const editBtn = document.getElementById("btn-toggle-credentials");
  if (editBtn) editBtn.textContent = "✏️ Edit Token";
  trafficAlertDismissed = false;

  if (launchBtn) {
    launchBtn.disabled = true;
    launchBtn.textContent = "⏳ Launching GPU...";
  }
  if (stepper) stepper.style.display = "flex";
  setKaggleStep(1, "active");
  setKaggleStep(2, "idle");
  setKaggleStep(3, "idle");
  startColdstartGuide();

  try {
    const res = await fetch("/api/cloud/kaggle/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, key })
    });
    const data = await res.json();
    if (data.ok) {
      showToast("🚀 Kaggle GPU kernel pushed! Container is booting up...");
      setKaggleStep(1, "completed");
      setKaggleStep(2, "active");
      if (stopBtn) stopBtn.style.display = "inline-block";
      startKagglePolling();
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color: var(--danger);">❌ ${data.error}</span>`;
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
      }
      setKaggleStep(1, "error");
    }
  } catch (err) {
    showToast("❌ Launch request failed: " + err.message, 5000);
    if (launchBtn) {
      launchBtn.disabled = false;
      launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
    }
  }
}

function setKaggleStep(stepNum, state) {
  const item = document.getElementById(`k-step-${stepNum}`);
  const dot = document.getElementById(`k-step-dot-${stepNum}`);
  if (!item || !dot) return;
  item.classList.remove("active", "completed");
  if (state === "active") {
    item.classList.add("active");
    dot.textContent = "⏳";
  } else if (state === "completed") {
    item.classList.add("completed");
    dot.textContent = "✓";
  } else {
    dot.textContent = stepNum.toString();
  }
}

function startKagglePolling() {
  clearInterval(kagglePollInterval);
  kagglePollInterval = setInterval(checkKaggleStatus, 4000);
  checkKaggleStatus();
}

async function checkKaggleStatus() {
  try {
    const res = await fetch("/api/cloud/kaggle/status");
    const data = await res.json();
    const terminal = document.getElementById("kaggle-log-terminal");
    const launchBtn = document.getElementById("btn-launch-kaggle");
    const stopBtn = document.getElementById("btn-stop-kaggle");
    const trafficBox = document.getElementById("kaggle-traffic-alert");
    const queueTimer = document.getElementById("traffic-queue-timer");
    const step2Text = document.getElementById("k-step-text-2");

    if (terminal && data.last_log) {
      terminal.textContent = data.last_log;
      terminal.scrollTop = terminal.scrollHeight;
    }

    if (data.status === "queued") {
      setKaggleStep(1, "completed");
      setKaggleStep(2, "active");
      if (step2Text) {
        step2Text.innerHTML = `Allocating Tesla T4 GPU container &bull; <span style="color: #fbbf24; font-weight: 600;">Queued in Kaggle cluster (${formatQueueTime(data.elapsed_seconds || 0)})</span>`;
      }
      startColdstartGuide();
      if (launchBtn) launchBtn.textContent = `⏳ Queued (${formatQueueTime(data.elapsed_seconds || 0)})...`;

      // Trigger High Traffic Alert if queued for 45s or more and not dismissed
      if ((data.elapsed_seconds || 0) >= 45 && !trafficAlertDismissed) {
        if (trafficBox) trafficBox.style.display = "block";
        if (queueTimer) queueTimer.textContent = `Queued: ${formatQueueTime(data.elapsed_seconds || 0)}`;
      }
    } else if (data.status === "booting") {
      setKaggleStep(1, "completed");
      setKaggleStep(2, "active");
      if (step2Text) {
        step2Text.innerHTML = `Tesla T4 allocated! Mounting weights & neural engine (~45-60s)`;
      }
      startColdstartGuide();
      if (trafficBox) trafficBox.style.display = "none";
      if (launchBtn) launchBtn.textContent = `⏳ Booting GPU & Weights (${data.elapsed_seconds}s)...`;
    } else if (data.status === "ready" && data.tunnel_url) {
      setKaggleStep(1, "completed");
      setKaggleStep(2, "completed");
      setKaggleStep(3, "completed");
      if (step2Text) {
        step2Text.innerHTML = `Tesla T4 GPU container active & S2 Pro weights mounted`;
      }
      stopColdstartGuide(true);
      if (trafficBox) trafficBox.style.display = "none";
      trafficAlertDismissed = false;
      clearInterval(kagglePollInterval);
      if (launchBtn) {
        launchBtn.textContent = "🟢 GPU Active & Connected!";
        launchBtn.style.background = "#10b981";
        launchBtn.disabled = true;
      }
      if (stopBtn) stopBtn.style.display = "inline-block";
      showToast("🎉 Kaggle Tesla T4 GPU connected! Studio is ready for ultra-fast generation!");
      
      state.config.remote_worker_url = data.tunnel_url;
      state.config.active = true;
      localStorage.setItem("fish_speech_remote_url", data.tunnel_url);
      updateEngineBadges();
      const colabBanner = document.getElementById("colab-status-banner");
      if (colabBanner) {
        colabBanner.className = "colab-status-banner online";
        const bt = document.getElementById("banner-title");
        if (bt) bt.textContent = "Active Mode: Kaggle GPU (Tesla T4)";
        const bd = document.getElementById("banner-desc");
        if (bd) bd.textContent = `Connected securely to Kaggle worker via ${data.tunnel_url}`;
      }
      setTimeout(() => {
        closeColabModal();
      }, 1600);
    } else if (data.status === "stopped" || data.status === "idle") {
      clearInterval(kagglePollInterval);
      stopColdstartGuide(false);
      const guide = document.getElementById("kaggle-coldstart-guide");
      if (guide) guide.style.display = "none";
      if (trafficBox) trafficBox.style.display = "none";
      trafficAlertDismissed = false;
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      if (stopBtn) stopBtn.style.display = "none";
      const stepper = document.getElementById("kaggle-stepper-box");
      if (stepper) stepper.style.display = "none";
    } else if (data.status === "error") {
      clearInterval(kagglePollInterval);
      stopColdstartGuide(false);
      const guide = document.getElementById("kaggle-coldstart-guide");
      if (guide) guide.style.display = "none";
      if (trafficBox) trafficBox.style.display = "none";
      trafficAlertDismissed = false;
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      showToast("❌ Kaggle GPU container error: " + (data.error || "Execution failed"), 6000);
    }
  } catch (e) {
    console.warn("Poll status notice:", e);
  }
}

async function handleStopKaggle() {
  const confirmed = await showMessageCard({
    icon: "⏹",
    title: "Stop Kaggle GPU Session?",
    subtitle: "Conserve your weekly quota",
    body: "<p style='margin:0; color:#cbd5e1;'>This terminates the cloud container and immediately stops charging your free weekly GPU hours. You can relaunch anytime.</p>",
    primaryText: "Stop GPU Session",
    secondaryText: "Cancel",
    showSecondary: true,
    danger: true
  });
  if (!confirmed) return;
  clearInterval(kagglePollInterval);
  const stopBtn = document.getElementById("btn-stop-kaggle");
  const launchBtn = document.getElementById("btn-launch-kaggle");
  const trafficBox = document.getElementById("kaggle-traffic-alert");
  if (trafficBox) trafficBox.style.display = "none";
  trafficAlertDismissed = false;

  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = "⏳ Stopping...";
  }

  try {
    const res = await fetch("/api/cloud/kaggle/stop", { method: "POST" });
    const data = await res.json();
    showToast("⏹ Kaggle GPU session terminated. Quota conserved!");
    if (stopBtn) {
      stopBtn.style.display = "none";
      stopBtn.disabled = false;
      stopBtn.textContent = "⏹ Stop GPU Session";
    }
    if (launchBtn) {
      launchBtn.disabled = false;
      launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
      launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
    }
    const stepper = document.getElementById("kaggle-stepper-box");
    if (stepper) stepper.style.display = "none";
    stopColdstartGuide(false);

    // Clean up local state & banner
    localStorage.removeItem("fish_speech_remote_url");
    if (state.config) {
      state.config.remote_worker_url = "";
      state.config.fish_remote_worker_url = "";
      state.config.active = false;
    }
    updateEngineBadges();
    const colabBanner = document.getElementById("colab-status-banner");
    if (colabBanner) {
      colabBanner.className = "colab-status-banner offline";
      const bt = document.getElementById("banner-title");
      if (bt) bt.textContent = "Current Mode: Local CPU Engine";
      const bd = document.getElementById("banner-desc");
      if (bd) bd.textContent = "Generating on laptop CPU. Click '🚀 Launch Cloud GPU' whenever you're ready to start again!";
    }
    const terminal = document.getElementById("kaggle-log-terminal");
    if (terminal) terminal.textContent = "Session stopped. Ready to launch again.";
  } catch (err) {
    showToast("⚠️ Could not stop session: " + err.message, 5000);
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
}

// ---------------- CLOUD GPU / COLAB MODAL ---------------- //

function openColabModal() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.style.display = "none";
  const modal = document.getElementById("colab-modal");
  if (!modal) return;
  modal.classList.add("active");
  fetch("/api/tier/status").then(r => r.json()).then(data => updateTierDisplay(data)).catch(() => {});
  const testRes = document.getElementById("colab-test-result");
  if (testRes) testRes.innerHTML = "";
  const keyRes = document.getElementById("fish-key-test-result");
  if (keyRes) keyRes.innerHTML = "";
  const urlInput = document.getElementById("colab-url-input");
  if (urlInput) {
    urlInput.value = (state.config && state.config.remote_worker_url) || "";
  }
  const customInput = document.getElementById("custom-gpu-url-input");
  if (customInput) {
    customInput.value = (state.config && state.config.remote_worker_url) || "";
  }
  const keyInput = document.getElementById("fish-api-key-input");
  if (keyInput) {
    keyInput.value = (state.config && state.config.fish_api_key) || "";
  }

  // De-congest: ensure Kaggle tab does not show redundant Save & Activate
  const saveBtn = document.getElementById("btn-save-colab");
  const kaggleTab = document.getElementById("tab-content-kaggle");
  if (saveBtn && kaggleTab && kaggleTab.classList.contains("active")) {
    saveBtn.style.display = "none";
  }

  // Pre-load local GPU hardware detection
  detectLocalGpu();

  // Route to the tab matching active provider!
  const provider = state.config?.remote_worker_provider || (state.config?.remote_worker_url ? "colab" : "kaggle");
  const remoteUrl = (state.config && state.config.remote_worker_url) || "";
  const hasApi = Boolean(state.config && state.config.fish_api_key);

  if (hasApi && !remoteUrl) {
    switchCloudSection("api");
  } else if (provider === "colab") {
    switchCloudSection("gpu");
    switchCloudTab("colab");
  } else if (provider === "custom" || provider === "local") {
    switchCloudSection("gpu");
    switchCloudTab("custom");
  } else {
    switchCloudSection("gpu");
    switchCloudTab("kaggle");
  }

  // Update Active Mode Banner dynamically based on provider
  const colabBanner = document.getElementById("colab-status-banner");
  const bt = document.getElementById("banner-title");
  const bd = document.getElementById("banner-desc");

  if (remoteUrl && state.remoteWorkerHealthy !== false) {
    if (colabBanner) colabBanner.className = "colab-status-banner online";
    if (bt) {
      if (provider === "colab") {
        bt.textContent = "Active Mode: Google Colab GPU (Tesla T4) 🟢";
      } else if (provider === "kaggle") {
        bt.textContent = "Active Mode: 1-Click Kaggle GPU (Tesla T4) 🟢";
      } else if (provider === "local" || provider === "custom") {
        bt.textContent = "Active Mode: Local / Custom GPU 🟢";
      } else {
        bt.textContent = "Active Mode: Cloud GPU (Tesla T4) 🟢";
      }
    }
    if (bd) bd.textContent = `Connected securely to remote worker via ${remoteUrl}`;
  }

  // Live test configured remote worker upon opening modal
  if (state.config && state.config.remote_worker_url) {
    checkRemoteWorkerHealth(true);
  }

  // Auto-populate Kaggle credentials if present and de-congest modal
  fetch("/api/config").then(r => r.json()).then(cfg => {
    if (cfg.kaggle_username) {
      const ku = document.getElementById("kaggle-username-input");
      if (ku && !ku.value) ku.value = cfg.kaggle_username;
      const statusEl = document.getElementById("kaggle-verify-status");
      if (statusEl && !statusEl.innerHTML) {
        statusEl.innerHTML = `<span style="color: #10b981;">✓ Detected Kaggle account @${cfg.kaggle_username}</span>`;
      }
      const badge = document.getElementById("kaggle-account-badge");
      const badgeUser = document.getElementById("badge-username");
      const creds = document.getElementById("kaggle-credentials-section");
      if (badge && badgeUser) {
        badgeUser.textContent = `@${cfg.kaggle_username}`;
        badge.style.display = "flex";
      }
      if (creds) creds.style.display = "none";
      const editBtn = document.getElementById("btn-toggle-credentials");
      if (editBtn) editBtn.textContent = "✏️ Edit Token";
    }
  }).catch(() => {});

  // Check if Kaggle worker is currently running in background
  fetch("/api/cloud/kaggle/status").then(r => r.json()).then(st => {
    const stepper = document.getElementById("kaggle-stepper-box");
    const stopBtn = document.getElementById("btn-stop-kaggle");
    const launchBtn = document.getElementById("btn-launch-kaggle");

    // ONLY show Kaggle as active if current provider is Kaggle!
    const isKaggleActive = (provider === "kaggle") && (st.status === "ready" && st.tunnel_url);

    if (isKaggleActive) {
      if (stepper) stepper.style.display = "flex";
      setKaggleStep(1, "completed");
      setKaggleStep(2, "completed");
      setKaggleStep(3, "completed");
      if (stopBtn) stopBtn.style.display = "inline-block";
      if (launchBtn) {
        launchBtn.textContent = "🟢 GPU Active & Connected";
        launchBtn.style.background = "#10b981";
        launchBtn.disabled = true;
      }
      if (colabBanner) {
        colabBanner.className = "colab-status-banner online";
        if (bt) bt.textContent = "Active Mode: Kaggle GPU (Tesla T4) 🟢";
        if (bd) bd.textContent = `Connected securely to Kaggle worker via ${st.tunnel_url}`;
      }
    } else if (provider === "kaggle" && (st.status === "queued" || st.status === "booting")) {
      if (stepper) stepper.style.display = "flex";
      if (stopBtn) stopBtn.style.display = "inline-block";
      if (launchBtn) {
        launchBtn.disabled = true;
        launchBtn.textContent = st.status === "queued" ? `⏳ Queued (${st.elapsed_seconds || 0}s)...` : `⏳ Booting GPU (${st.elapsed_seconds || 0}s)...`;
      }
      startKagglePolling();
    } else {
      // Stopped or idle Kaggle
      if (stepper) stepper.style.display = "none";
      if (stopBtn) stopBtn.style.display = "none";
      const guide = document.getElementById("kaggle-coldstart-guide");
      if (guide) guide.style.display = "none";
      const trafficBox = document.getElementById("kaggle-traffic-alert");
      if (trafficBox) trafficBox.style.display = "none";
      stopColdstartGuide(false);
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      if (!remoteUrl || state.remoteWorkerHealthy === false) {
        if (colabBanner) {
          if (remoteUrl && state.remoteWorkerHealthy === false) {
            colabBanner.className = "colab-status-banner stopped";
            if (bt) bt.textContent = "⚠️ Mode: Cloud GPU Stopped / Offline 🔴";
            if (bd) bd.textContent = `Remote worker at ${remoteUrl} stopped or is unreachable.`;
          } else {
            colabBanner.className = "colab-status-banner offline";
            if (bt) bt.textContent = "Current Mode: Local CPU Engine";
            if (bd) bd.textContent = "Generating on laptop CPU (~14s per sentence). Connect Cloud GPU for 100x speed!";
          }
        }
      }
    }
  }).catch(() => {});
}

function closeColabModal() {
  const modal = document.getElementById("colab-modal");
  if (modal) modal.classList.remove("active");
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.style.display = "none";
}

function toggleCustomComputeAccordion() {
  const drawer = document.getElementById("custom-compute-drawer");
  const arrow = document.getElementById("custom-compute-arrow");
  if (!drawer) return;
  const isHidden = drawer.style.display === "none" || !drawer.style.display;
  drawer.style.display = isHidden ? "block" : "none";
  if (arrow) arrow.textContent = isHidden ? "▲" : "▼";
}

async function selectPlanTier(tier) {
  try {
    const res = await fetch("/api/tier/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier })
    });
    if (res.ok) {
      const data = await res.json();
      state.tierStatus = data;
      updateTierDisplay(data);
      const tierNames = {
        free: "Free Trial ($0)",
        creator: "Creator Plan ($14/mo)",
        author: "Author Plan ($29/mo)",
        byok: "BYOK (Personal API Key)",
        tunnel: "Custom GPU Worker"
      };
      showToast(`✓ Switched plan to ${tierNames[tier] || tier}`, 3500);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Failed to switch plan", 4000);
    }
  } catch (err) {
    console.error("selectPlanTier error:", err);
    showToast("Network error switching plan", 4000);
  }
}

function updateTierDisplay(tierStatus) {
  if (!tierStatus) return;
  state.tierStatus = tierStatus;
  const tier = tierStatus.active_tier || "author";

  let label = "⭐ Author Plan";
  let quotaTag = "100K words";
  let bannerIcon = "⭐";
  let bannerTitle = "Author Plan";
  let quotaText = "100,000 / 100,000 words remaining";
  let barPercent = 100;

  if (tier === "free") {
    const remainingTakes = tierStatus.trial_renders_remaining !== undefined ? tierStatus.trial_renders_remaining : 5;
    label = "🆓 Free Trial";
    quotaTag = `${remainingTakes} takes left`;
    bannerIcon = "🆓";
    bannerTitle = "Free Trial Plan";
    quotaText = `${remainingTakes} Drama 3 trial takes remaining (Unlimited Kokoro CPU)`;
    barPercent = Math.max(0, Math.min(100, (remainingTakes / 5) * 100));
  } else if (tier === "creator") {
    const used = tierStatus.monthly_words_used || 0;
    const limit = tierStatus.monthly_words_limit || 35000;
    const remaining = tierStatus.words_remaining !== undefined ? tierStatus.words_remaining : Math.max(0, limit - used);
    label = "🎙️ Creator Plan";
    quotaTag = `${Math.round(remaining / 1000)}K words`;
    bannerIcon = "🎙️";
    bannerTitle = "Creator Plan ($14/mo)";
    quotaText = `${remaining.toLocaleString()} / ${limit.toLocaleString()} words remaining`;
    barPercent = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  } else if (tier === "author") {
    const used = tierStatus.monthly_words_used || 0;
    const limit = tierStatus.monthly_words_limit || 100000;
    const remaining = tierStatus.words_remaining !== undefined ? tierStatus.words_remaining : Math.max(0, limit - used);
    label = "⭐ Author Plan";
    quotaTag = `${Math.round(remaining / 1000)}K words`;
    bannerIcon = "⭐";
    bannerTitle = "Author Plan ($29/mo)";
    quotaText = `${remaining.toLocaleString()} / ${limit.toLocaleString()} words remaining`;
    barPercent = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
  } else if (tier === "byok") {
    label = "🔑 Custom API (BYOK)";
    quotaTag = "Unlimited";
    bannerIcon = "🔑";
    bannerTitle = "Personal Fish API Key (BYOK)";
    quotaText = "Unlimited synthesis via your personal API key";
    barPercent = 100;
  } else if (tier === "tunnel") {
    label = "🚀 Custom GPU Worker";
    quotaTag = "Unlimited";
    bannerIcon = "🚀";
    bannerTitle = "Custom GPU Worker (Tunnel)";
    quotaText = "Unlimited synthesis via Kaggle/Colab/Local GPU";
    barPercent = 100;
  }

  // Update navbar badges on Dashboard and Studio
  const dashLabel = document.getElementById("dashboard-engine-label");
  if (dashLabel) dashLabel.textContent = label;
  const dashQuota = document.getElementById("dashboard-quota-tag");
  if (dashQuota) dashQuota.textContent = quotaTag;

  const studioLabel = document.getElementById("studio-engine-label");
  if (studioLabel) studioLabel.textContent = label;
  const studioQuota = document.getElementById("studio-quota-tag");
  if (studioQuota) studioQuota.textContent = quotaTag;

  // Update Plan Modal Banner
  const iconEl = document.getElementById("plan-badge-icon");
  if (iconEl) iconEl.textContent = bannerIcon;
  const titleEl = document.getElementById("plan-badge-title");
  if (titleEl) titleEl.textContent = bannerTitle;
  const pillEl = document.getElementById("plan-tier-pill");
  if (pillEl) pillEl.textContent = tier.toUpperCase();
  const quotaTextEl = document.getElementById("plan-quota-text");
  if (quotaTextEl) quotaTextEl.textContent = quotaText;
  const barEl = document.getElementById("plan-quota-bar");
  if (barEl) {
    barEl.style.width = `${barPercent}%`;
    if (barPercent < 15) {
      barEl.style.background = "linear-gradient(90deg, #ef4444, #f59e0b)";
    } else {
      barEl.style.background = "linear-gradient(90deg, #10b981, #3b82f6)";
    }
  }

  // Update CTA buttons on ChatGPT-style pricing cards
  const btnFree = document.getElementById("btn-cta-free");
  const btnCreator = document.getElementById("btn-cta-creator");
  const btnAuthor = document.getElementById("btn-cta-author");
  const btnByok = document.getElementById("btn-cta-byok");

  if (btnFree) {
    if (tier === "free") {
      btnFree.textContent = "Your current plan";
      btnFree.style.background = "rgba(255,255,255,0.08)";
      btnFree.style.color = "#cbd5e1";
      btnFree.style.border = "1px solid rgba(255,255,255,0.15)";
    } else {
      btnFree.textContent = "Switch to Free";
      btnFree.style.background = "transparent";
      btnFree.style.color = "#94a3b8";
      btnFree.style.border = "1px solid rgba(255,255,255,0.2)";
    }
  }

  if (btnCreator) {
    if (tier === "creator") {
      btnCreator.textContent = "Your current plan";
      btnCreator.style.background = "rgba(56, 189, 248, 0.15)";
      btnCreator.style.color = "#38bdf8";
      btnCreator.style.border = "1px solid rgba(56, 189, 248, 0.4)";
    } else {
      btnCreator.textContent = "Upgrade to Creator";
      btnCreator.style.background = "#ffffff";
      btnCreator.style.color = "#000000";
      btnCreator.style.border = "none";
    }
  }

  if (btnAuthor) {
    if (tier === "author") {
      btnAuthor.textContent = "Your current plan";
      btnAuthor.style.background = "rgba(59, 130, 246, 0.2)";
      btnAuthor.style.color = "#60a5fa";
      btnAuthor.style.border = "1px solid rgba(59, 130, 246, 0.5)";
      btnAuthor.style.boxShadow = "none";
    } else {
      btnAuthor.textContent = "✨ Upgrade to Author";
      btnAuthor.style.background = "#3b82f6";
      btnAuthor.style.color = "#ffffff";
      btnAuthor.style.border = "none";
      btnAuthor.style.boxShadow = "0 4px 14px rgba(59, 130, 246, 0.4)";
    }
  }

  if (btnByok) {
    if (tier === "byok" || tier === "tunnel") {
      btnByok.textContent = "Active (BYOK)";
      btnByok.style.background = "rgba(234, 179, 8, 0.15)";
      btnByok.style.color = "#eab308";
      btnByok.style.border = "1px solid rgba(234, 179, 8, 0.4)";
    } else {
      btnByok.textContent = "Configure BYOK";
      btnByok.style.background = "rgba(255,255,255,0.08)";
      btnByok.style.color = "#cbd5e1";
      btnByok.style.border = "1px solid rgba(255,255,255,0.15)";
    }
  }

  // Highlight active tier card
  ["free", "creator", "author", "byok"].forEach(t => {
    const card = document.getElementById(`tier-card-${t}`);
    if (card) {
      if (tier === t || (t === "byok" && tier === "tunnel")) {
        if (t === "author") {
          card.style.borderColor = "#3b82f6";
          card.style.background = "linear-gradient(180deg, rgba(30, 41, 59, 0.9) 0%, rgba(15, 23, 42, 0.98) 100%)";
          card.style.boxShadow = "0 0 35px rgba(59, 130, 246, 0.35)";
        } else {
          card.style.borderColor = "#10b981";
          card.style.background = "rgba(16, 185, 129, 0.08)";
          card.style.boxShadow = "0 0 20px rgba(16, 185, 129, 0.2)";
        }
      } else {
        if (t === "author") {
          card.style.borderColor = "rgba(59, 130, 246, 0.4)";
          card.style.background = "linear-gradient(180deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.9) 100%)";
          card.style.boxShadow = "0 0 20px rgba(59, 130, 246, 0.15)";
        } else {
          card.style.borderColor = "rgba(255, 255, 255, 0.08)";
          card.style.background = "rgba(18, 24, 38, 0.7)";
          card.style.boxShadow = "none";
        }
      }
    }
  });
}

// ================= USER ACCOUNTS & AUTHENTICATION ================= //

async function initAuth() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    if (data.logged_in && data.user) {
      state.currentUser = data.user;
      const u = data.user;
      const avatarEl = document.getElementById("nav-user-avatar");
      if (avatarEl) avatarEl.textContent = u.name ? u.name.slice(0, 1).toUpperCase() : "👤";
      const labelEl = document.getElementById("nav-user-label");
      if (labelEl) labelEl.textContent = u.name || u.email.split("@")[0];
      document.querySelectorAll(".nav-user-label-tag").forEach(el => el.textContent = u.name || u.email.split("@")[0]);
      document.querySelectorAll(".nav-user-avatar-tag").forEach(el => el.textContent = u.name ? u.name.slice(0, 1).toUpperCase() : "👤");
      const dName = document.getElementById("dropdown-user-name");
      if (dName) dName.textContent = u.name || "Author";
      const dEmail = document.getElementById("dropdown-user-email");
      if (dEmail) dEmail.textContent = u.email;
      const dTier = document.getElementById("dropdown-user-tier");
      if (dTier) dTier.textContent = `${(u.active_tier || "free").toUpperCase()} PLAN`;
      
      const logoutBtn = document.getElementById("btn-dropdown-logout");
      if (logoutBtn) logoutBtn.style.display = "block";

      updateTierDisplay(u);
    } else {
      state.currentUser = null;
      const avatarEl = document.getElementById("nav-user-avatar");
      if (avatarEl) avatarEl.textContent = "👤";
      const labelEl = document.getElementById("nav-user-label");
      if (labelEl) labelEl.textContent = "Sign In";
      document.querySelectorAll(".nav-user-label-tag").forEach(el => el.textContent = "Sign In");
      document.querySelectorAll(".nav-user-avatar-tag").forEach(el => el.textContent = "👤");
      const dName = document.getElementById("dropdown-user-name");
      if (dName) dName.textContent = "Guest / Local Admin";
      const dEmail = document.getElementById("dropdown-user-email");
      if (dEmail) dEmail.textContent = "Click to sign in or register";
      const dTier = document.getElementById("dropdown-user-tier");
      if (dTier) dTier.textContent = "FREE TRIAL";

      const logoutBtn = document.getElementById("btn-dropdown-logout");
      if (logoutBtn) logoutBtn.style.display = "none";
    }
  } catch (err) {
    console.warn("[Auth] Failed to initialize auth:", err);
  }
}

function toggleUserDropdown(force) {
  const menu = document.getElementById("user-dropdown-menu");
  if (!menu) return;

  if (force === false) {
    menu.style.display = "none";
    return;
  }

  if (!state.currentUser) {
    menu.style.display = "none";
    const modal = document.getElementById("colab-modal");
    if (modal) modal.classList.remove("active");
    switchToView("auth", true);
    return;
  }

  const isShown = force !== undefined ? force : menu.style.display === "flex";
  menu.style.display = isShown ? "none" : "flex";
}

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("user-header-wrap");
  const menu = document.getElementById("user-dropdown-menu");
  if (wrap && menu && !wrap.contains(e.target)) {
    menu.style.display = "none";
  }
});

function openAuthModal(tab = "login") {
  const modal = document.getElementById("colab-modal");
  if (modal) modal.classList.remove("active");
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.style.display = "none";
  switchToView("auth", true);
  if (tab === "register" && gateAuthMode !== "register") {
    toggleGateAuthMode();
  } else if (tab === "login" && gateAuthMode !== "login") {
    toggleGateAuthMode();
  }
}

function closeAuthModal() {
  // Legacy modal replaced by front-door auth gate view
}

async function handleLogout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (e) {}
  state.currentUser = null;
  toggleUserDropdown(false);
  showToast("Signed out successfully.", 3000);
  await initAuth();
  switchToView("auth", true);
}

// ---------------- FRONT-DOOR AUTH GATE HANDLERS ---------------- //

let gateAuthMode = "login"; // "login" or "register"

function toggleGateAuthMode() {
  gateAuthMode = (gateAuthMode === "login") ? "register" : "login";
  const titleEl = document.getElementById("gate-title");
  const nameWrap = document.getElementById("gate-name-wrap");
  const submitBtn = document.getElementById("gate-auth-submit-btn");
  const promptEl = document.getElementById("gate-toggle-prompt");
  const toggleLink = document.getElementById("gate-auth-toggle-link");
  const errEl = document.getElementById("gate-auth-error");
  if (errEl) errEl.style.display = "none";

  if (gateAuthMode === "register") {
    if (titleEl) titleEl.textContent = "Create your account";
    if (nameWrap) nameWrap.style.display = "block";
    if (submitBtn) submitBtn.textContent = "Create Account";
    if (promptEl) promptEl.textContent = "Already have an account?";
    if (toggleLink) toggleLink.textContent = "Sign in";
  } else {
    if (titleEl) titleEl.textContent = "Welcome back";
    if (nameWrap) nameWrap.style.display = "none";
    if (submitBtn) submitBtn.textContent = "Sign In";
    if (promptEl) promptEl.textContent = "Don't have an account?";
    if (toggleLink) toggleLink.textContent = "Sign up";
  }
}

function toggleGatePasswordVisibility() {
  const pwd = document.getElementById("gate-input-password");
  if (!pwd) return;
  pwd.type = pwd.type === "password" ? "text" : "password";
}

async function handleGateSubmit() {
  const emailInput = document.getElementById("gate-input-email");
  const pwdInput = document.getElementById("gate-input-password");
  const nameInput = document.getElementById("gate-input-name");
  const errEl = document.getElementById("gate-auth-error");
  const submitBtn = document.getElementById("gate-auth-submit-btn");

  const email = (emailInput?.value || "").trim();
  const password = (pwdInput?.value || "").trim();
  const name = (nameInput?.value || "").trim();
  const isRegister = gateAuthMode === "register";

  if (!email || !password) {
    if (errEl) {
      errEl.textContent = "Please enter both email and password.";
      errEl.style.display = "block";
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Please wait...";
  }
  if (errEl) errEl.style.display = "none";

  try {
    const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
    const payload = isRegister ? { email, password, name } : { email, password };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (errEl) {
        errEl.textContent = data.error || "Authentication failed.";
        errEl.style.display = "block";
      }
      return;
    }

    state.currentUser = data.user;
    if (window.google?.accounts?.id) {
      try {
        google.accounts.id.cancel();
      } catch (e) {}
    }
    showToast(`✓ Welcome, ${data.user.name || data.user.email}!`, 3500);
    await initAuth();
    await loadProjectsList();
    
    // Check if deep link project was requested in URL
    const urlParams = new URLSearchParams(window.location.search);
    const pid = urlParams.get("project") || urlParams.get("id");
    if (pid) {
      await openProject(pid, true);
    } else {
      switchToView("dashboard", true);
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = "Network error. Please try again.";
      errEl.style.display = "block";
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = isRegister ? "Create Account" : "Sign In";
    }
  }
}

function initGoogleAuth(retries = 10) {
  // If already logged in, cancel any One-Tap prompt and exit
  if (state.currentUser) {
    if (window.google?.accounts?.id) {
      try {
        google.accounts.id.cancel();
      } catch (e) {}
    }
    return;
  }

  const clientId = state.config?.google_client_id;
  const container = document.getElementById("google-btn-container");
  const fallbackBtn = document.getElementById("btn-gate-google");

  if (!clientId) {
    if (fallbackBtn) fallbackBtn.style.display = "flex";
    return;
  }

  if (window.google?.accounts?.id) {
    try {
      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleJwtResponse,
        auto_select: false,
        cancel_on_tap_outside: true
      });
      if (container) {
        container.innerHTML = "";
        google.accounts.id.renderButton(container, {
          theme: "outline",
          size: "large",
          width: 380,
          text: "signin_with",
          shape: "rectangular"
        });
        if (fallbackBtn) fallbackBtn.style.display = "none";
      }
      // Only show One-Tap prompt if user is unauthenticated on the auth screen
      if (!state.currentUser && state.currentView === "auth") {
        google.accounts.id.prompt();
      }
    } catch (e) {
      console.warn("[Google Auth] Init error:", e);
    }
  } else if (retries > 0) {
    setTimeout(() => initGoogleAuth(retries - 1), 300);
  }
}

async function handleGoogleSignIn() {
  const errEl = document.getElementById("gate-auth-error");
  if (errEl) errEl.style.display = "none";

  const clientId = state.config?.google_client_id;
  if (clientId && window.google?.accounts?.id) {
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        console.log("[Google Auth] One-tap prompt not displayed:", notification.getNotDisplayedReason());
      }
    });
    return;
  }

  // Clear in-page guidance without popup prompts
  if (errEl) {
    errEl.innerHTML = `<strong>Google Sign-In:</strong> To enable One-Tap Google Sign-In, add <code>"google_client_id": "your-id.apps.googleusercontent.com"</code> to <code>projects/config.json</code>.<br>You can sign in or register instantly with <strong>Email & Password</strong> below.`;
    errEl.style.display = "block";
    const emailInput = document.getElementById("gate-input-email");
    if (emailInput) emailInput.focus();
  }
}

async function handleGoogleJwtResponse(response) {
  const errEl = document.getElementById("gate-auth-error");
  if (errEl) errEl.style.display = "none";

  if (!response || !response.credential) {
    if (errEl) {
      errEl.textContent = "Google sign-in was not completed.";
      errEl.style.display = "block";
    }
    return;
  }

  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (errEl) {
        errEl.textContent = data.error || "Google authentication failed.";
        errEl.style.display = "block";
      }
      return;
    }

    state.currentUser = data.user;
    if (window.google?.accounts?.id) {
      try {
        google.accounts.id.cancel();
      } catch (e) {}
    }
    showToast(`✓ Welcome, ${data.user.name || data.user.email}!`, 3500);
    await initAuth();
    await loadProjectsList();

    const urlParams = new URLSearchParams(window.location.search);
    const pid = urlParams.get("project") || urlParams.get("id");
    if (pid) {
      await openProject(pid, true);
    } else {
      switchToView("dashboard", true);
    }
  } catch (err) {
    console.error("[Google Auth] Error:", err);
    if (errEl) {
      errEl.textContent = "Network error during Google authentication.";
      errEl.style.display = "block";
    }
  }
}

function handleSelectPlan(tier) {
  if (tier === "byok") {
    const drawer = document.getElementById("custom-compute-drawer");
    const arrow = document.getElementById("custom-compute-arrow");
    if (drawer) drawer.style.display = "block";
    if (arrow) arrow.textContent = "▲";
    selectPlanTier("byok");
    drawer?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (!state.currentUser) {
    state.pendingPlanUpgrade = tier;
    closeColabModal();
    showToast("Please sign in or create an account to upgrade to " + tier.toUpperCase(), 4000);
    switchToView("auth", true);
    return;
  }

  selectPlanTier(tier);
}

async function handleTestColab() {
  const urlInput = document.getElementById("colab-url-input");
  const testRes = document.getElementById("colab-test-result");
  const btn = document.getElementById("btn-test-colab");
  const url = (urlInput?.value || "").trim();

  if (!url) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">⚠️ Please paste your Colab tunnel URL first.</span>`;
    return;
  }

  if (btn) {
    btn.textContent = "⏳ Testing...";
    btn.disabled = true;
  }
  if (testRes) testRes.innerHTML = `<span style="color: var(--text-muted);">Pinging ${url}/health...</span>`;

  try {
    const res = await fetch("/api/test_remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.ok) {
      state.remoteWorkerHealthy = true;
      const hw = data.details?.hardware || "Cloud GPU";
      if (testRes) testRes.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ Connected! Hardware: ${hw} — Ready for instant synthesis!</span>`;
      if (url === state.config?.remote_worker_url) {
        state.config.active = true;
        updateEngineUI(url, true);
      }
    } else {
      state.remoteWorkerHealthy = false;
      if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${data.error || "Could not reach remote worker"}</span>`;
      if (url === state.config?.remote_worker_url) {
        state.config.active = false;
        updateEngineUI(url, false);
      }
      const colabBanner = document.getElementById("colab-status-banner");
      if (colabBanner) {
        colabBanner.className = "colab-status-banner stopped";
        const bt = document.getElementById("banner-title");
        if (bt) bt.textContent = "⚠️ Mode: Cloud GPU Stopped / Offline 🔴";
        const bd = document.getElementById("banner-desc");
        if (bd) bd.textContent = `Remote worker at ${url} stopped or is unreachable. Click 'Launch Cloud GPU' to start a new session.`;
      }
    }
  } catch (err) {
    state.remoteWorkerHealthy = false;
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${err.message}</span>`;
    if (url === state.config?.remote_worker_url) {
      state.config.active = false;
      updateEngineUI(url, false);
    }
    const colabBanner = document.getElementById("colab-status-banner");
    if (colabBanner) {
      colabBanner.className = "colab-status-banner stopped";
      const bt = document.getElementById("banner-title");
      if (bt) bt.textContent = "⚠️ Mode: Cloud GPU Stopped / Offline 🔴";
      const bd = document.getElementById("banner-desc");
      if (bd) bd.textContent = `Remote worker at ${url} is unreachable.`;
    }
  } finally {
    if (btn) {
      btn.textContent = "⚡ Test Connection";
      btn.disabled = false;
    }
  }
}

async function handleTestFishKey() {
  const keyInput = document.getElementById("fish-api-key-input");
  const testRes = document.getElementById("fish-key-test-result");
  const btn = document.getElementById("btn-test-fish-key");
  const apiKey = (keyInput?.value || "").trim();

  if (!apiKey) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">⚠️ Please paste your Fish API key first.</span>`;
    return;
  }

  if (btn) {
    btn.textContent = "⏳ Testing...";
    btn.disabled = true;
  }
  if (testRes) testRes.innerHTML = `<span style="color: var(--text-muted);">Authenticating with api.fish.audio...</span>`;

  try {
    const res = await fetch("/api/test_fish_key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey })
    });
    const data = await res.json();
    if (data.ok) {
      const bal = Number(data.credit || 0).toFixed(2);
      if (Number(data.credit || 0) > 0) {
        if (testRes) testRes.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ Authenticated! Balance: $${bal} — Ready for Cloud API synthesis!</span>`;
      } else {
        if (testRes) testRes.innerHTML = `<span style="color: #f59e0b; font-weight: 600;">⚠️ Authenticated! Account Balance: $${bal} (0 credits). Top up on fish.audio or use the free 1-Click Colab GPU!</span>`;
      }
    } else {
      if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ ${data.error || "Fish Audio API key verification failed."}</span>`;
    }
  } catch (err) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection error: ${err.message}</span>`;
  } finally {
    if (btn) {
      btn.textContent = "🔑 Test Key";
      btn.disabled = false;
    }
  }
}

function handleClearTunnelInput() {
  const urlInput = document.getElementById("colab-url-input");
  if (urlInput) urlInput.value = "";
  const testRes = document.getElementById("colab-test-result");
  if (testRes) testRes.innerHTML = "";
  showToast("Cleared tunnel URL input.");
}

function handleClearApiKeyInput() {
  const keyInput = document.getElementById("fish-api-key-input");
  if (keyInput) keyInput.value = "";
  const testRes = document.getElementById("fish-key-test-result");
  if (testRes) testRes.innerHTML = "";
  showToast("Cleared API key input.");
}

async function handleSaveColab() {
  const urlInput = document.getElementById("colab-url-input");
  const customInput = document.getElementById("custom-gpu-url-input");
  const url = (urlInput?.value || customInput?.value || "").trim();
  const apiKeyInput = document.getElementById("fish-api-key-input");
  const apiKey = (apiKeyInput?.value || "").trim();

  const customTab = document.getElementById("tab-content-custom");
  const colabTab = document.getElementById("tab-content-colab");
  let provider = "colab";
  if (customTab && customTab.classList.contains("active")) {
    provider = "custom";
  } else if (colabTab && colabTab.classList.contains("active")) {
    provider = "colab";
  }

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_worker_url: url,
        fish_api_key: apiKey,
        active_engine: state.activeEngine || "fish_s2",
        remote_worker_provider: provider
      })
    });
    const data = await res.json();
    state.config = data;
    closeColabModal();
    if (url) {
      localStorage.setItem("fish_speech_remote_url", url);
      checkRemoteWorkerHealth(false);
    } else {
      localStorage.removeItem("fish_speech_remote_url");
      updateEngineUI("", data.active);
      showToast(data.active ? "🔑 Fish API key configured." : "⚡ Switched to Local CPU Engine.");
    }
  } catch (err) {
    showToast("⚠️ Failed to save configuration: " + err.message, 5000);
  }
}

async function handleClearColab() {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remote_worker_url: "", fish_api_key: "" })
    });
    const data = await res.json();
    state.config = data;
    state.remoteWorkerHealthy = null;
    localStorage.removeItem("fish_speech_remote_url");
    updateEngineUI("", false);
    const urlInput = document.getElementById("colab-url-input");
    if (urlInput) urlInput.value = "";
    const customInput = document.getElementById("custom-gpu-url-input");
    if (customInput) customInput.value = "";
    const apiKeyInput = document.getElementById("fish-api-key-input");
    if (apiKeyInput) apiKeyInput.value = "";
    const testRes = document.getElementById("colab-test-result");
    if (testRes) testRes.innerHTML = "";
    const customTestRes = document.getElementById("custom-gpu-test-result");
    if (customTestRes) customTestRes.innerHTML = "";
    closeColabModal();
    showToast("⚡ Remote worker disconnected. Switched to Local CPU.");
  } catch (err) {
    showToast("⚠️ Failed to disconnect: " + err.message, 5000);
  }
}

function syncCustomUrlToColabUrl(val) {
  const colabInput = document.getElementById("colab-url-input");
  if (colabInput) colabInput.value = val;
}

// ==========================================
// LOCAL GPU AUTO-DETECTION & 1-CLICK LAUNCHER
// ==========================================

let _localGpuPollInterval = null;

async function detectLocalGpu(force = false) {
  const nameEl = document.getElementById("local-gpu-name");
  const vramEl = document.getElementById("local-gpu-vram-badge");
  const descEl = document.getElementById("local-gpu-desc");
  const compatBadge = document.getElementById("local-gpu-compat-badge");
  const capableSec = document.getElementById("local-gpu-capable-section");
  const incompSec = document.getElementById("local-gpu-incompatible-section");
  const autoCheckbox = document.getElementById("local-gpu-auto-launch-checkbox");

  if (!nameEl) return;

  try {
    const res = await fetch(`/api/gpu/local/detect?force=${force ? "1" : "0"}`);
    const data = await res.json();

    nameEl.textContent = data.gpu_name || "Unknown Display Adapter";
    if (vramEl) vramEl.textContent = `${data.vram_gb || 0} GB VRAM`;
    if (descEl) descEl.textContent = data.message || "";
    if (autoCheckbox) autoCheckbox.checked = !!data.auto_launch;

    const iconEl = document.getElementById("local-gpu-icon");
    if (iconEl) {
      iconEl.textContent = data.is_nvidia ? "⚡" : "🖥️";
    }

    if (data.is_capable) {
      if (compatBadge) {
        compatBadge.textContent = "✅ Capable (1-Click Ready)";
        compatBadge.style.background = "rgba(16, 185, 129, 0.15)";
        compatBadge.style.color = "#34d399";
        compatBadge.style.border = "1px solid rgba(16, 185, 129, 0.3)";
      }
      if (capableSec) capableSec.style.display = "block";
      if (incompSec) incompSec.style.display = "none";
    } else {
      if (compatBadge) {
        compatBadge.textContent = data.is_nvidia ? "⚠️ Low VRAM" : "⚠️ Incompatible";
        compatBadge.style.background = "rgba(239, 68, 68, 0.15)";
        compatBadge.style.color = "#f87171";
        compatBadge.style.border = "1px solid rgba(239, 68, 68, 0.3)";
      }
      if (capableSec) capableSec.style.display = "none";
      if (incompSec) incompSec.style.display = "block";

      const warnTitle = document.getElementById("local-gpu-warning-title");
      const warnMsg = document.getElementById("local-gpu-warning-msg");
      if (warnTitle) {
        warnTitle.textContent = data.is_nvidia 
          ? `Low VRAM: ${data.gpu_name} (${data.vram_gb} GB)`
          : `Dedicated NVIDIA GPU Not Found`;
      }
      if (warnMsg) {
        warnMsg.textContent = data.message;
      }
    }

    // Check worker status
    await checkLocalGpuWorkerStatus();
  } catch (err) {
    console.warn("Local GPU detect error:", err);
  }
}

async function checkLocalGpuWorkerStatus() {
  try {
    const res = await fetch("/api/gpu/local/status");
    const data = await res.json();
    updateLocalGpuStatusUI(data);
  } catch (e) {}
}

function updateLocalGpuStatusUI(data) {
  const statusText = document.getElementById("local-gpu-status-text");
  const launchBtn = document.getElementById("btn-local-gpu-launch");
  const stopBtn = document.getElementById("btn-local-gpu-stop");
  const logPanel = document.getElementById("local-gpu-log-panel");

  if (!statusText) return;

  if (data.status === "ready") {
    statusText.innerHTML = `<span style="color: #34d399; font-weight: 600;">🟢 Online & Accelerated (${data.url || "127.0.0.1:8080"})</span>`;
    if (launchBtn) {
      launchBtn.textContent = "⚡ Running on Local GPU";
      launchBtn.disabled = true;
      launchBtn.style.opacity = "0.7";
    }
    if (stopBtn) stopBtn.style.display = "inline-block";
    clearInterval(_localGpuPollInterval);
    _localGpuPollInterval = null;
  } else if (data.status === "booting") {
    statusText.innerHTML = `<span style="color: #fbbf24; font-weight: 600;">⏳ Booting worker & allocating VRAM...</span>`;
    if (launchBtn) {
      launchBtn.textContent = "⏳ Loading Weights...";
      launchBtn.disabled = true;
    }
    if (stopBtn) stopBtn.style.display = "inline-block";
    if (!_localGpuPollInterval) {
      _localGpuPollInterval = setInterval(checkLocalGpuWorkerStatus, 2000);
    }
  } else if (data.status === "error") {
    statusText.innerHTML = `<span style="color: #f87171; font-weight: 600;">❌ Error: ${data.error || "Worker exited unexpectedly"}</span>`;
    if (launchBtn) {
      launchBtn.textContent = "⚡ Launch Local GPU Worker";
      launchBtn.disabled = false;
      launchBtn.style.opacity = "1";
    }
    if (stopBtn) stopBtn.style.display = "none";
    clearInterval(_localGpuPollInterval);
    _localGpuPollInterval = null;
  } else {
    statusText.innerHTML = `Status: <span style="color: #94a3b8;">Offline</span>`;
    if (launchBtn) {
      launchBtn.textContent = "⚡ Launch Local GPU Worker";
      launchBtn.disabled = false;
      launchBtn.style.opacity = "1";
    }
    if (stopBtn) stopBtn.style.display = "none";
    clearInterval(_localGpuPollInterval);
    _localGpuPollInterval = null;
  }

  if (logPanel && data.logs && data.logs.length > 0) {
    logPanel.textContent = data.logs.join("\n");
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

async function handleLaunchLocalGpuWorker() {
  const launchBtn = document.getElementById("btn-local-gpu-launch");
  const statusText = document.getElementById("local-gpu-status-text");
  if (launchBtn) {
    launchBtn.textContent = "⏳ Starting Worker...";
    launchBtn.disabled = true;
  }
  if (statusText) {
    statusText.innerHTML = `<span style="color: #fbbf24;">⏳ Spawning background worker...</span>`;
  }

  try {
    const res = await fetch("/api/gpu/local/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "fish_s2", port: 8080 })
    });
    const data = await res.json();
    if (data.ok) {
      showToast("🚀 Starting Local GPU Worker in background...");
      updateLocalGpuStatusUI(data);
      if (!_localGpuPollInterval) {
        _localGpuPollInterval = setInterval(checkLocalGpuWorkerStatus, 2000);
      }
    } else {
      showToast("⚠️ Could not start worker: " + (data.error || "Unknown error"), 5000);
      updateLocalGpuStatusUI({ status: "error", error: data.error });
    }
  } catch (err) {
    showToast("⚠️ Connection error: " + err.message, 5000);
  }
}

async function handleStopLocalGpuWorker() {
  try {
    const res = await fetch("/api/gpu/local/stop", { method: "POST" });
    const data = await res.json();
    showToast("🛑 Local GPU Worker stopped.");
    clearInterval(_localGpuPollInterval);
    _localGpuPollInterval = null;
    await checkLocalGpuWorkerStatus();
  } catch (err) {
    showToast("⚠️ Error stopping worker: " + err.message, 5000);
  }
}

async function handleToggleLocalGpuAutoLaunch(enabled) {
  try {
    await fetch("/api/gpu/local/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_launch: enabled })
    });
    showToast(enabled ? "✅ Local GPU will auto-launch when Studio starts." : "Local GPU auto-launch disabled.");
  } catch (e) {
    console.warn("Error saving auto-launch config:", e);
  }
}

function toggleLocalGpuLogs(e) {
  if (e) e.preventDefault();
  const panel = document.getElementById("local-gpu-log-panel");
  const toggle = document.getElementById("local-gpu-log-toggle");
  if (!panel) return;
  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "block" : "none";
  if (toggle) toggle.textContent = isHidden ? "Hide Logs ▴" : "View Logs ▾";
}

function toggleCustomManualUrl() {
  const container = document.getElementById("custom-manual-container");
  const arrow = document.getElementById("custom-manual-arrow");
  if (!container) return;
  const isHidden = container.style.display === "none";
  container.style.display = isHidden ? "block" : "none";
  if (arrow) arrow.textContent = isHidden ? "▾ Hide" : "▸ Show";
}

function handleClearCustomGpuInput() {
  const input = document.getElementById("custom-gpu-url-input");
  if (input) input.value = "";
  const colabInput = document.getElementById("colab-url-input");
  if (colabInput) colabInput.value = "";
  const res = document.getElementById("custom-gpu-test-result");
  if (res) res.innerHTML = "";
  showToast("Cleared Custom GPU URL.");
}

async function handleTestCustomGpu() {
  const input = document.getElementById("custom-gpu-url-input");
  const testRes = document.getElementById("custom-gpu-test-result");
  const btn = document.getElementById("btn-test-custom-gpu");
  const url = (input?.value || "").trim();

  if (!url) {
    if (testRes) testRes.innerHTML = `<span style="color: var(--danger);">⚠️ Please enter your custom worker or local GPU URL (e.g. http://localhost:8080 or https://...trycloudflare.com).</span>`;
    return;
  }

  const colabInput = document.getElementById("colab-url-input");
  if (colabInput) colabInput.value = url;

  if (btn) {
    btn.textContent = "⏳ Testing...";
    btn.disabled = true;
  }
  if (testRes) testRes.innerHTML = `<span style="color: var(--text-muted);">Pinging ${url}/health...</span>`;

  try {
    const res = await fetch(`/api/remote_worker/health?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (data.ok) {
      const hw = data.gpu_name || data.device || (data.cuda_available ? "NVIDIA CUDA GPU" : "CPU");
      testRes.innerHTML = `<span style="color: var(--success); font-weight: 600;">✅ Connected! Hardware: ${hw} — Ready for instant synthesis!</span>`;
      if (url === state.config?.remote_worker_url) {
        state.config.active = true;
        updateEngineUI(url, true);
      }
    } else {
      testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${data.error || "Could not reach remote worker"}</span>`;
    }
  } catch (err) {
    testRes.innerHTML = `<span style="color: var(--danger);">❌ Connection failed: ${err.message}</span>`;
  } finally {
    if (btn) {
      btn.textContent = "⚡ Test Connection";
      btn.disabled = false;
    }
  }
}

async function handleCopyColabScriptAndOpen(engineChoice = "fish_s2") {
  const btn = document.getElementById("btn-copy-colab-fish") || document.getElementById("btn-copy-colab-code");
  const origHtml = btn ? btn.innerHTML : "📋 Copy 1-Cell Worker Script & Open Colab ↗";

  let scriptText = "";
  try {
    const res = await fetch(`/api/colab_script?engine=${encodeURIComponent(engineChoice)}`);
    scriptText = await res.text();
  } catch (err) {
    console.warn("Colab script fetch error:", err);
  }

  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(scriptText);
      copied = true;
    } catch (e) {
      console.warn("navigator.clipboard failed:", e);
    }
  }
  if (!copied) {
    try {
      const ta = document.createElement("textarea");
      ta.value = scriptText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copied = true;
    } catch (e) {
      console.error("Copy fallback error:", e);
    }
  }

  if (btn) {
    btn.classList.add("copied");
    btn.innerHTML = `✅ Copied to Clipboard! Opening Colab...`;
  }

  showToast("📋 1-Cell Worker Script copied! Opening Google Colab in a new tab...", 4500);

  setTimeout(() => {
    window.open("https://colab.research.google.com", "_blank");
  }, 350);

  setTimeout(() => {
    if (btn) {
      btn.classList.remove("copied");
      btn.innerHTML = origHtml;
    }
  }, 3200);
}

async function handleCopyColabScript(engineChoice = "fish_s2") {
  return handleCopyColabScriptAndOpen(engineChoice);
}

// ---------------- FISH AUDIO S2 PRO ENGINE & CONTROLS ---------------- //

async function switchGlobalActiveEngine(engineChoice = "fish_s2") {
  state.activeEngine = "fish_s2";
  const dashLabel = document.getElementById("dashboard-engine-label");
  if (dashLabel) dashLabel.textContent = "🐟 Fish Audio S2 Pro";
  const studioLabel = document.getElementById("studio-engine-label");
  if (studioLabel) studioLabel.textContent = "🐟 Fish Audio S2 Pro";

  const emotionSection = document.getElementById("inspector-emotion-section");
  if (emotionSection) emotionSection.style.display = "block";
  const zeroShotSection = document.getElementById("inspector-zero-shot-section");
  if (zeroShotSection) zeroShotSection.style.display = "block";
}

function toggleEngineModelDropdown(force) {
  const dd = document.getElementById("engine-model-dropdown");
  if (!dd) return;
  const isCurrentlyOpen = dd.style.display === "block";
  const shouldOpen = typeof force === "boolean" ? force : !isCurrentlyOpen;
  dd.style.display = shouldOpen ? "block" : "none";
}

function selectEngineOption(newEngine, newModel = null) {
  if (!state.currentProject) return;

  // Close the dropdown immediately
  toggleEngineModelDropdown(false);

  const defaultModels = {
    fish_s2: "drama3",
    elevenlabs: "v4",
    cartesia: "sonic_4",
    openai: "gpt-4o-mini-tts",
    edge_tts: "edge_neural",
    kokoro: "kokoro_webgpu"
  };

  const chosenModel = newModel || defaultModels[newEngine] || "";

  // Update active tracking in state
  state.activeEngine = newEngine;
  state.activeModel = chosenModel;

  // Ensure Kokoro is strictly client-side on user's device
  if (newEngine === "kokoro" && window.KokoroClient) {
    window.KokoroClient.setClientKokoroEnabled(true);
  }

  // Target active block or selected blocks rather than blindly mutating character or chapter!
  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? Array.from(state.selectedBlockIndices)
    : (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 ? [state.activeBlockIndex] : []);

  if (targets.length > 0) {
    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block || block.type === "heading" || block.is_spoken === false) return;

      // 1. Isolate changes to this sentence block only - NEVER mutate char.engine / char.model
      block.engine = newEngine;
      block.model = chosenModel;
      block.is_custom_edited = true;

      const char = block.character_id ? getCharacterById(block.character_id) : (block.speaker ? getCharacterById(block.speaker) : null);
      if (char) {
        // Track the original character identity for revert purposes, but do NOT mutate character definition
        if (!block.overridden_character_id) block.overridden_character_id = char.id;
        if (!block.overridden_speaker) block.overridden_speaker = char.name;
      }

      const currentVoice = getVoiceById(block.voice_id);
      if (!currentVoice || (currentVoice.engine || "fish_s2") !== newEngine) {
        const isFemale = Boolean(
          (currentVoice && (currentVoice.gender === "female" || (currentVoice.name && currentVoice.name.toLowerCase().includes("female")))) ||
          /lucy|bella|she|her|girl|mother|woman/i.test(block.speaker || "")
        );
        if (newEngine === "edge_tts") {
          block.voice_id = isFemale ? "en-US-JennyNeural" : "en-US-GuyNeural";
        } else if (newEngine === "kokoro") {
          block.voice_id = isFemale ? "af_bella" : "am_adam";
        } else if (newEngine === "elevenlabs") {
          block.voice_id = isFemale ? "EXAVITQu4vr4xnSDxMaL" : "pNInz6obpgDQGcFmaJgB";
        } else if (newEngine === "cartesia") {
          block.voice_id = isFemale ? "79a125e8-cd45-4c13-8a67-188112f4dd22" : "a0e99841-438c-4a64-b679-ae501e7d6091";
        } else if (newEngine === "openai") {
          block.voice_id = isFemale ? "nova" : "onyx";
        } else {
          block.voice_id = isFemale ? "fish_9f508743280b46788d64de199cbb5093" : "fish_71804f0aa9e8457e92e9e49c26691514";
        }
      }

      // 2. Check and manage audio cache for this specific block & model
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (typeof invalidateBlockAudio === "function") {
        invalidateBlockAudio(block, row);
      } else {
        delete block.cachedAudioUrl;
        delete block.audio_url;
        delete block.cachedSig;
        delete block.duration;
        delete block.audio_hash;
        delete block.rawAudioUrl;
        delete block.raw_audio_url;
      }
    });

    const modelLabel = chosenModel ? ` (${chosenModel})` : "";
    showToast(`⚡ Set ${newEngine.toUpperCase()}${modelLabel} for ${targets.length} sentence${targets.length > 1 ? 's' : ''}`);
  } else {
    // Only set project default if NO sentence blocks were selected/active
    if (state.currentProject) {
      state.currentProject.engine = newEngine;
      if (chosenModel) state.currentProject.model = chosenModel;
    }
    showToast(`⚡ Set default engine to ${newEngine.toUpperCase()}${chosenModel ? ' (' + chosenModel + ')' : ''}`);
  }

  renderBlocks();
  renderInspector();
  renderSavedCharactersList();
  renderTimeline();
  syncProjectAudioCache();
  debouncedSave();
}

function handleBlockEngineChange(newEngine) {
  selectEngineOption(newEngine);
}

function handleToggleClientKokoro(checked) {
  if (window.KokoroClient) {
    window.KokoroClient.setClientKokoroEnabled(true);
  }
}

// Global outside-click listener for Engine Model Dropdown
document.addEventListener("click", (e) => {
  const dd = document.getElementById("engine-model-dropdown");
  const btn = document.getElementById("btn-engine-model-picker");
  if (dd && dd.style.display === "block") {
    if (!dd.contains(e.target) && !btn?.contains(e.target)) {
      dd.style.display = "none";
    }
  }
});

function handleQuickEmotionClick(tag) {
  const input = document.getElementById("input-emotion-tag");
  if (input) input.value = tag;
  applyEmotionTagToActiveBlocks(tag);
}

function handleEmotionTagInput(val) {
  applyEmotionTagToActiveBlocks(val);
}

function clearBlockEmotionTag() {
  const input = document.getElementById("input-emotion-tag");
  if (input) input.value = "";
  applyEmotionTagToActiveBlocks("");
}

function handleEmbedEmotionTagIntoText() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex >= 0 ? state.activeBlockIndex : 0]);

  let count = 0;
  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block || !block.emotion_tag) return;
    let tag = block.emotion_tag.trim().replace(/\]\s+\[/g, '][');
    if (!tag.startsWith("[")) tag = `[${tag}]`;
    let txt = (block.text || "").trim();
    if (!txt.startsWith("[")) {
      block.text = `${tag}${txt}`;
      invalidateBlockAudio(block);
      count++;
    }
  });

  if (count > 0) {
    recordHistory("Embed Emotion Tags into Text");
    renderStudio();
    debouncedSave();
    showToast(`📝 Embedded tags directly into text for ${count} sentence${count > 1 ? 's' : ''}!`);
  } else {
    showToast("⚠️ Active sentence has no emotion tag to embed.");
  }
}

function handleExtractEmotionTagFromText() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex >= 0 ? state.activeBlockIndex : 0]);

  let count = 0;
  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block || !block.text) return;
    const m = block.text.match(/^((?:\[[^\]]+\]\s*)*\[[^\]]+\])(\s*)(.*)$/);
    if (m) {
      block.emotion_tag = m[1].replace(/\]\s+\[/g, '][').trim();
      block.text = (m[2] + m[3]).trim();
      invalidateBlockAudio(block);
      count++;
    }
  });

  if (count > 0) {
    recordHistory("Extract Inline Tags to Pill");
    renderStudio();
    debouncedSave();
    showToast(`🏷️ Extracted inline tags to Green Pills for ${count} sentence${count > 1 ? 's' : ''}!`);
  } else {
    showToast("⚠️ No leading [tag] found in active sentence text.");
  }
}

function applyEmotionTagToActiveBlocks(tag) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex]);

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.emotion_tag = tag;
    const row = document.querySelector(`[data-index="${idx}"]`);
    invalidateBlockAudio(block, row);
    if (row) {
      let pill = row.querySelector(".block-emotion-pill");
      if (tag) {
        if (!pill) {
          pill = document.createElement("span");
          pill.className = "block-emotion-pill";
          pill.onclick = () => handleFocusEmotionInput(idx);
          const contentCol = row.querySelector(".block-content-col");
          if (contentCol) contentCol.prepend(pill);
        }
        pill.textContent = tag;
        pill.title = `Fish S2 Pro Emotion Tag: ${tag}`;
      } else if (pill) {
        pill.remove();
      }
    }
  });

  // Highlight active chip
  document.querySelectorAll("#inspector-emotion-chips .emotion-chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.tag === tag);
  });

  debouncedSave();
}

function handleFocusEmotionInput(idx) {
  selectBlock(idx, "single");
  switchInspectorTab("audio");
  const input = document.getElementById("input-emotion-tag");
  if (input) {
    input.focus();
    input.select();
  }
}

async function handleReferenceVoiceFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("audio", file);

  showToast("⏳ Uploading reference audio clip...");
  try {
    const res = await fetch("/api/voices/upload_reference", {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Reference voice uploaded (${data.duration}s)!`);
      const refPath = data.relative_path || data.url;

      // Assign to current block
      if (state.currentProject?.blocks?.[state.activeBlockIndex]) {
        const block = state.currentProject.blocks[state.activeBlockIndex];
        block.reference_audio = refPath;
        delete block.cachedAudioUrl;
        delete block.cachedSig;
      }

      // Update UI
      const nameEl = document.getElementById("ref-voice-filename");
      if (nameEl) nameEl.textContent = file.name;
      const metaEl = document.getElementById("ref-voice-meta");
      if (metaEl) metaEl.textContent = `Custom clip (${data.duration}s)`;
      const playBtn = document.getElementById("btn-play-ref-voice");
      if (playBtn) {
        playBtn.style.display = "inline-flex";
        playBtn.dataset.url = data.url;
      }

      await loadVoices();
      debouncedSave();
    } else {
      showToast("❌ Upload failed: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    showToast("❌ Upload error: " + err.message);
  }
}

function handleRefTranscriptInput(val) {
  if (!state.currentProject?.blocks?.[state.activeBlockIndex]) return;
  const block = state.currentProject.blocks[state.activeBlockIndex];
  block.reference_text = val;
  delete block.cachedAudioUrl;
  delete block.cachedSig;
  debouncedSave();
}

function handlePlayReferenceVoice(event) {
  event.stopPropagation();
  const playBtn = document.getElementById("btn-play-ref-voice");
  const url = playBtn?.dataset?.url;
  if (!url) return;

  if (state.refAudioPlayer.src.includes(url) && !state.refAudioPlayer.paused) {
    state.refAudioPlayer.pause();
    playBtn.textContent = "▶";
  } else {
    state.refAudioPlayer.src = url;
    state.refAudioPlayer.play();
    playBtn.textContent = "⏸";
    state.refAudioPlayer.onended = () => {
      playBtn.textContent = "▶";
    };
  }
}

// ---------------- UNIFIED EXPORT SYSTEM ---------------- //

function toggleExportDropdown(e) {
  if (e) e.stopPropagation();
  const wrapper = document.getElementById("export-dropdown-wrapper");
  const menu = document.getElementById("export-dropdown-menu");
  if (!menu) return;

  const isHidden = (menu.style.display === "none" || !menu.style.display);
  menu.style.display = isHidden ? "flex" : "none";
  if (wrapper) wrapper.classList.toggle("open", isHidden);

  if (isHidden) {
    updateExportDropdownUI();
    if (typeof closeHistoryDropdown === "function") {
      closeHistoryDropdown();
    }
  }
}

function closeExportDropdown() {
  const wrapper = document.getElementById("export-dropdown-wrapper");
  const menu = document.getElementById("export-dropdown-menu");
  if (menu) menu.style.display = "none";
  if (wrapper) wrapper.classList.remove("open");
}

function updateExportDropdownUI() {
  const scopeTag = document.getElementById("export-menu-scope-tag");
  const itemSelected = document.getElementById("export-item-selected");
  const itemIcon = document.getElementById("export-item-selected-icon");
  const itemTitle = document.getElementById("export-item-selected-title");
  const itemBadge = document.getElementById("export-item-selected-badge");
  const itemDesc = document.getElementById("export-item-selected-desc");

  if (!itemSelected) return;

  const count = state.selectedBlockIndices ? state.selectedBlockIndices.size : 0;

  if (count === 1) {
    const idx = Array.from(state.selectedBlockIndices)[0];
    const block = state.currentProject?.blocks ? state.currentProject.blocks[idx] : null;
    let snippet = "";
    if (block && block.text) {
      snippet = block.text.trim();
      if (snippet.length > 24) snippet = snippet.slice(0, 23) + "…";
      snippet = ` ("${snippet}")`;
    }

    if (scopeTag) scopeTag.textContent = `Sentence #${idx + 1}`;
    if (itemIcon) itemIcon.textContent = "🎵";
    if (itemTitle) itemTitle.textContent = `Export Selected Sentence (.wav)`;
    if (itemBadge) {
      itemBadge.textContent = "WAV";
      itemBadge.className = "export-item-badge purple";
    }
    if (itemDesc) itemDesc.textContent = `Download direct audio file for Sentence #${idx + 1}${snippet}`;
    itemSelected.classList.remove("disabled");
    itemSelected.title = `Export audio file for Sentence #${idx + 1}`;
  } else if (count > 1) {
    if (scopeTag) scopeTag.textContent = `${count} Selected`;
    if (itemIcon) itemIcon.textContent = "📦";
    if (itemTitle) itemTitle.textContent = `Export Selected Sentences (.zip)`;
    if (itemBadge) {
      itemBadge.textContent = `ZIP (${count})`;
      itemBadge.className = "export-item-badge blue";
    }
    if (itemDesc) itemDesc.textContent = `Package ${count} selected sentences as separate audio files in a ZIP`;
    itemSelected.classList.remove("disabled");
    itemSelected.title = `Export ${count} selected sentences into a ZIP archive`;
  } else {
    if (scopeTag) scopeTag.textContent = `0 Selected`;
    if (itemIcon) itemIcon.textContent = "🎯";
    if (itemTitle) itemTitle.textContent = `Export Selected Audio`;
    if (itemBadge) {
      itemBadge.textContent = "SELECT";
      itemBadge.className = "export-item-badge";
    }
    if (itemDesc) itemDesc.textContent = `Check sentence checkboxes in canvas to export selection`;
    itemSelected.classList.add("disabled");
    itemSelected.title = `Select one or more sentence checkboxes to export selection`;
  }
}

async function exportSelectedAudio() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Project has no sentences to export.");
    return;
  }

  const selectedIndices = Array.from(state.selectedBlockIndices || []).sort((a, b) => a - b);
  if (selectedIndices.length === 0) {
    showToast("⚠️ Please select one or more sentences to export.");
    return;
  }

  const titleSlug = (state.currentProject.title || "story")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "story";

  const exportTriggerBtn = document.getElementById("btn-export-dropdown");

  // CASE 1: Single sentence selected -> Export directly as .wav file
  if (selectedIndices.length === 1) {
    const idx = selectedIndices[0];
    const block = state.currentProject.blocks[idx];
    if (!block) return;

    if (block.type === "heading" || block.is_spoken === false) {
      showToast("⚠️ Scene headings have no audio to export.");
      return;
    }

    if (exportTriggerBtn) {
      exportTriggerBtn.innerHTML = `<span>⏳ Synthesizing...</span> <span class="dropdown-caret">▾</span>`;
      exportTriggerBtn.disabled = true;
    }

    // Check if rendered, if not synthesize on demand
    let audioUrl = block.cachedAudioUrl;
    if (!audioUrl) {
      showToast(`⚡ Rendering audio for sentence #${idx + 1}...`);
      try {
        const res = await fetch("/api/synthesize_block", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBlockSynthesizePayload(block))
        });
        let data = null;
        const cType = res.headers.get("content-type") || "";
        if (cType.includes("application/json")) {
          data = await res.json().catch(() => null);
        }
        if (!data) {
          const rawText = await res.text().catch(() => "");
          throw new Error(`Server returned HTTP ${res.status}${rawText ? `: ${rawText.slice(0, 120)}` : ""}`);
        }
        if (data.audio_url) {
          block.cachedAudioUrl = data.audio_url;
          block.duration = data.duration;
          audioUrl = data.audio_url;
          debouncedSave();
          renderTimeline();
          const row = document.querySelector(`[data-index="${idx}"]`);
          if (row) {
            row.classList.add("ready");
            const timeText = row.querySelector(".scrubber-time");
            if (timeText) timeText.textContent = `${data.duration.toFixed(1)}s`;
          }
        } else {
          throw new Error(data.error || "Synthesis returned no audio URL");
        }
      } catch (err) {
        showToast("❌ Synthesis failed: " + err.message);
        if (exportTriggerBtn) {
          exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
          exportTriggerBtn.disabled = false;
        }
        return;
      }
    }

    const cleanSnippet = (block.text || "")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("_")
      .toLowerCase();
    const downloadFilename = `${titleSlug}_sentence_${String(idx + 1).padStart(2, "0")}${cleanSnippet ? "_" + cleanSnippet : ""}.wav`;

    showToast(`⏳ Downloading Sentence #${idx + 1}...`);
    try {
      const res = await fetch(`${audioUrl}?download=1&filename=${encodeURIComponent(downloadFilename)}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      showToast(`✓ Exported: ${downloadFilename}`);
    } catch (err) {
      const a = document.createElement("a");
      a.href = `${audioUrl}?download=1&filename=${encodeURIComponent(downloadFilename)}`;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`✓ Downloading ${downloadFilename}`);
    } finally {
      if (exportTriggerBtn) {
        exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportTriggerBtn.disabled = false;
      }
    }
    return;
  }

  // CASE 2: Multiple sentences selected -> Export as .zip archive
  const selectedBlocks = selectedIndices
    .map(i => state.currentProject.blocks[i])
    .filter(b => b && b.text && b.text.trim() && b.type !== "heading" && b.is_spoken !== false);

  if (selectedBlocks.length === 0) {
    showToast("⚠️ None of the selected items are spoken sentences.");
    return;
  }

  const zipFilename = `${titleSlug}_selected_${selectedBlocks.length}_sentences.zip`;
  showToast(`📦 Packaging ${selectedBlocks.length} selected sentences into ZIP...`);

  if (exportTriggerBtn) {
    exportTriggerBtn.innerHTML = `<span>⏳ Packaging (${selectedBlocks.length})...</span> <span class="dropdown-caret">▾</span>`;
    exportTriggerBtn.disabled = true;
  }

  try {
    const res = await fetch("/api/export_zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: selectedBlocks,
        filename: zipFilename
      })
    });
    const data = await res.json();
    if (data.error) {
      showToast("❌ ZIP export failed: " + data.error);
    } else if (data.zip_url) {
      const a = document.createElement("a");
      a.href = `${data.zip_url}?download=1&filename=${encodeURIComponent(zipFilename)}`;
      a.download = data.filename || zipFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`📦 Exported ZIP with ${data.file_count || selectedBlocks.length} selected sentences!`);
    }
  } catch (err) {
    showToast("❌ Export failed: " + err.message);
  } finally {
    if (exportTriggerBtn) {
      exportTriggerBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
      exportTriggerBtn.disabled = false;
    }
  }
}

async function exportMasterAudio() {
  const exportBtn = document.getElementById("btn-export-dropdown");
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Project has no sentences to export.");
    return;
  }
  if (exportBtn) {
    exportBtn.innerHTML = `<span>⏳ Stitching Master...</span> <span class="dropdown-caret">▾</span>`;
    exportBtn.disabled = true;
  }

  try {
    const filename = `${state.currentProject.id || 'story'}_master.wav`;
    const res = await fetch("/api/export_master", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        filename: filename
      })
    });

    const data = await res.json();
    if (data.error) {
      showToast("❌ Export failed: " + data.error);
      return;
    }
    if (data.master_url) {
      state.storyAudioPlayer.src = `${data.master_url}?t=${Date.now()}`;
      state.storyAudioPlayer.play().catch(() => {});

      const a = document.createElement("a");
      a.href = `${data.master_url}?download=1&filename=${encodeURIComponent(data.filename || filename)}`;
      a.download = data.filename || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast("🎬 Master WAV compiled and download started!");
    }
  } catch (err) {
    showToast("Export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportBtn.disabled = false;
      }
    }, 2000);
  }
}

async function exportZipAudio() {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) {
    showToast("⚠️ No sentences to export.");
    return;
  }

  const exportBtn = document.getElementById("btn-export-dropdown");
  if (exportBtn) {
    exportBtn.innerHTML = `<span>⏳ Packaging All ZIP...</span> <span class="dropdown-caret">▾</span>`;
    exportBtn.disabled = true;
  }

  try {
    const titleSlug = (state.currentProject.title || "story")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "story";
    const filename = `${titleSlug}_sentences.zip`;

    showToast("📦 Packaging all sentence audio files into ZIP...");

    const res = await fetch("/api/export_zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: state.currentProject.blocks,
        filename: filename
      })
    });

    const data = await res.json();
    if (data.error) {
      showToast("❌ ZIP export failed: " + data.error);
    } else if (data.zip_url) {
      const a = document.createElement("a");
      a.href = `${data.zip_url}?download=1&filename=${encodeURIComponent(filename)}`;
      a.download = data.filename || filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast(`📦 Downloaded ZIP with ${data.file_count} individual sentence audio files!`);
    }
  } catch (err) {
    showToast("ZIP export failed: " + err);
  } finally {
    setTimeout(() => {
      if (exportBtn) {
        exportBtn.innerHTML = `<span>🎬 Export</span> <span class="dropdown-caret">▾</span>`;
        exportBtn.disabled = false;
      }
    }, 2000);
  }
}

function handleExportSelectedFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportSelectedAudio();
}

function handleExportMasterFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportMasterAudio();
}

function handleExportZipFromMenu(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  exportZipAudio();
}

function handleExportProjectJson(e) {
  if (e) e.stopPropagation();
  closeExportDropdown();
  if (!state.currentProject) {
    showToast("⚠️ No project open to export.");
    return;
  }
  try {
    const titleSlug = (state.currentProject.title || "story")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "story";
    const filename = `${titleSlug}_backup.json`;
    const jsonStr = JSON.stringify(state.currentProject, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast(`✓ Exported project JSON: ${filename}`);
  } catch (err) {
    showToast("❌ Failed to export project JSON: " + err.message);
  }
}

// ---------------- EVENT LISTENERS ---------------- //

function setupEventListeners() {
  // Navigation: Back to Dashboard
  document.getElementById("btn-back-to-dashboard")?.addEventListener("click", () => {
    switchToView("dashboard");
  });

  // Kaggle API Key auto-validation against Fish Audio key cross-paste
  const kaggleKeyInput = document.getElementById("kaggle-key-input");
  const kaggleKeyWarn = document.getElementById("kaggle-key-warning");
  if (kaggleKeyInput) {
    kaggleKeyInput.addEventListener("input", () => {
      const val = (kaggleKeyInput.value || "").trim();
      if (val.startsWith("sk-fish-") || val.length > 42) {
        if (kaggleKeyWarn) {
          kaggleKeyWarn.style.display = "block";
          kaggleKeyWarn.innerHTML = "⚠️ <strong>Notice:</strong> This looks like a Fish Audio API key (starts with <code>sk-fish-</code>). We have automatically moved it under the <strong>🔑 Fish Audio Pro API</strong> tab! For Kaggle GPU, please paste your 32-character token from <code>kaggle.json</code>.";
        }
        const fishInput = document.getElementById("fish-api-key-input");
        if (fishInput) fishInput.value = val;
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fish_api_key: val })
        }).catch(() => {});
      } else {
        if (kaggleKeyWarn) kaggleKeyWarn.style.display = "none";
      }
    });
  }

  // Regular 25s heartbeat while Studio tab is alive
  setInterval(() => {
    if (!document.hidden) {
      fetch("/api/cloud/kaggle/heartbeat", { method: "POST" }).catch(() => {});
    }
  }, 25000);

  // Dashboard Hero Dropzone drag & drop
  const dashDropzone = document.getElementById("dashboard-dropzone");
  if (dashDropzone) {
    dashDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dashDropzone.classList.add("drag-over");
    });
    dashDropzone.addEventListener("dragleave", () => {
      dashDropzone.classList.remove("drag-over");
    });
    dashDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dashDropzone.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        processImportedFile(e.dataTransfer.files[0], "dashboard");
      }
    });
  }

  // Project title rename in Studio
  document.getElementById("project-title")?.addEventListener("input", (e) => {
    if (state.currentProject) {
      state.currentProject.title = e.target.value;
      document.title = `${e.target.value || "Story Studio"} — Kashva Studio TTS`;
      debouncedSave();
    }
  });

  // Add Block button
  document.getElementById("btn-add-block")?.addEventListener("click", () => {
    if (!state.currentProject) return;
    recordHistory("Add Sentence Block");
    const defs = getProjectDefaultSettings();
    const newIdx = state.currentProject.blocks.length;
    const newBlock = {
      id: "b_" + (newIdx + 1) + "_" + Date.now().toString().slice(-4),
      text: "",
      voice_id: defs.voice_id,
      speed: defs.speed,
      gain: defs.gain,
      pause_after: defs.pause_after,
      pitch_shift: defs.pitch_shift,
      warmth: defs.warmth,
      clarity: defs.clarity,
      reverb: defs.reverb,
      radio_fx: (defs.fx_filter === "radio" || Boolean(defs.radio_fx)),
      fx_filter: defs.fx_filter
    };
    if (defs.blend_weights) {
      newBlock.blend_weights = JSON.parse(JSON.stringify(defs.blend_weights));
    }
    state.currentProject.blocks.push(newBlock);
    renderStudio();
    selectBlock(newIdx, "single");
    debouncedSave();

    // Auto-scroll directly to the new block and immediately focus its textarea for typing
    setTimeout(() => {
      const rows = document.querySelectorAll(".block-row");
      const targetRow = rows[newIdx] || rows[rows.length - 1];
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
        const ta = targetRow.querySelector(".block-textarea");
        if (ta) {
          ta.focus();
        }
      }
    }, 40);
  });

  // Inspector voice trigger
  document.getElementById("inspector-voice-card")?.addEventListener("click", () => {
    openVoiceDrawer(state.activeBlockIndex);
  });

  // Slider events - Bulk Aware (Updates all selected blocks)
  document.getElementById("slider-volume")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    document.getElementById("val-volume").textContent = val + "%";
    if (!state.currentProject || !state.currentProject.blocks) return;
    const gainVal = val / 100;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.gain = gainVal;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-volume")?.addEventListener("change", () => recordHistory("Adjust Volume"));

  document.getElementById("slider-speed")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-speed").textContent = val.toFixed(2) + "x";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.speed = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-speed")?.addEventListener("change", () => recordHistory("Adjust Speed"));

  document.getElementById("slider-pause")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-pause").textContent = val.toFixed(1) + "s";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.pause_after = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
  });
  document.getElementById("slider-pause")?.addEventListener("change", () => recordHistory("Adjust Pause"));

  document.getElementById("slider-pitch")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-pitch").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " st";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.pitch_shift = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-pitch")?.addEventListener("change", () => recordHistory("Adjust Pitch"));

  document.getElementById("slider-warmth")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-warmth").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.warmth = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-warmth")?.addEventListener("change", () => recordHistory("Adjust Warmth"));

  document.getElementById("slider-clarity")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("val-clarity").textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.clarity = val;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-clarity")?.addEventListener("change", () => recordHistory("Adjust Clarity"));

  document.getElementById("slider-reverb")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    document.getElementById("val-reverb").textContent = val + "%";
    if (!state.currentProject || !state.currentProject.blocks) return;
    const revRatio = val / 100.0;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.reverb = revRatio;
      if (block.character_id) {
        block.is_custom_edited = true;
      }
      if (!block.cachedAudioUrl) {
        delete block.cachedSig;
        const row = document.querySelector(`[data-index="${idx}"]`);
        if (row) {
          row.classList.remove("ready");
          const timeText = row.querySelector(".scrubber-time");
          if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        }
      }
    });
    debouncedSave();
    updateActiveCharacterStatusBanner();
    triggerInstantBlockDsp(targets);
  });
  document.getElementById("slider-reverb")?.addEventListener("change", () => recordHistory("Adjust Reverb"));

  // Fish S2 Pro Temperature Slider
  document.getElementById("slider-temperature")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const valEl = document.getElementById("val-temperature");
    if (valEl) valEl.textContent = val.toFixed(2);
    if (!state.currentProject || !state.currentProject.blocks) return;

    const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
      ? state.selectedBlockIndices
      : new Set([state.activeBlockIndex]);

    targets.forEach(idx => {
      const block = state.currentProject.blocks[idx];
      if (!block) return;
      block.temperature = val;
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      }
    });
    debouncedSave();
  });
  document.getElementById("slider-temperature")?.addEventListener("change", () => recordHistory("Adjust S2 Temperature"));

  // Character Modal Voice Select
  document.getElementById("char-modal-voice-select")?.addEventListener("change", (e) => {
    updateCharModalVoiceDetails(e.target.value);
  });

  // Character Modal Name Input live preview
  document.getElementById("char-modal-name-input")?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const avatar = document.getElementById("char-modal-avatar-preview");
    if (avatar) {
      avatar.textContent = val ? val.slice(0, 2).toUpperCase() : "CH";
    }
  });

  // Character Modal Sliders live label updates
  document.getElementById("char-slider-speed")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-speed");
    if (label) label.textContent = val.toFixed(2) + "x";
  });

  document.getElementById("char-slider-pause")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-pause");
    if (label) label.textContent = val.toFixed(1) + "s";
  });

  document.getElementById("char-slider-pitch")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-pitch");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " st";
  });

  document.getElementById("char-slider-warmth")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-warmth");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
  });

  document.getElementById("char-slider-clarity")?.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const label = document.getElementById("char-val-clarity");
    if (label) label.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)) + " dB";
  });

  document.getElementById("char-slider-reverb")?.addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    const label = document.getElementById("char-val-reverb");
    if (label) label.textContent = val + "%";
  });

  // Drawer Search, Sort & Filters
  document.getElementById("drawer-search")?.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderVoiceList();
  });

  document.getElementById("drawer-sort")?.addEventListener("change", (e) => {
    state.activeSort = e.target.value;
    renderVoiceList();
  });

  document.querySelectorAll(".filter-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      state.activeFilter = pill.dataset.filter;
      renderVoiceList();
    });
  });

  document.getElementById("drawer-close-btn")?.addEventListener("click", closeVoiceDrawer);
  document.getElementById("voice-drawer")?.addEventListener("click", (e) => {
    if (e.target.id === "voice-drawer") closeVoiceDrawer();
  });

  document.getElementById("rail-voices-btn")?.addEventListener("click", () => openVoiceDrawer());

  // Keyboard shortcuts: Space toggles playback, Ctrl+Z undos, Ctrl+Y redos
  window.addEventListener("keydown", (e) => {
    // Undo: Ctrl+Z or Cmd+Z (when not typing inside an active input/textarea)
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      if (e.shiftKey) {
        // Redo: Ctrl+Shift+Z
        e.preventDefault();
        handleRedo();
        return;
      } else {
        if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          handleUndo();
          return;
        }
      }
    }

    // Redo: Ctrl+Y or Cmd+Y
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
      if (!["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        handleRedo();
        return;
      }
    }

    // Reorder shortcuts: Alt+ArrowUp to move up, Alt+ArrowDown to move down
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const currentIdx = typeof state.activeBlockIndex === "number" ? state.activeBlockIndex : 0;
      if (e.key === "ArrowUp") {
        moveBlockUp(currentIdx);
      } else {
        moveBlockDown(currentIdx);
      }
      return;
    }

    // Escape: Deselect multiple sentences when not typing in an input/textarea
    if (e.key === "Escape" && state.selectedBlockIndices && state.selectedBlockIndices.size > 1) {
      const activeModal = document.querySelector(".modal-backdrop:not([style*='display: none'])");
      const activeDrawer = document.querySelector(".voice-drawer.open");
      if (!activeModal && !activeDrawer) {
        clearBlockSelection();
        return;
      }
    }

    if (["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) return;
    if (e.code === "Space" && state.currentView === "studio") {
      e.preventDefault();
      handleMasterPlayToggle();
    }
  });

  // Close dropdowns on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#history-dropdown-wrapper")) {
      closeHistoryDropdown();
    }
    if (!e.target.closest("#export-dropdown-wrapper")) {
      closeExportDropdown();
    }
  });

  // Blocks container drop handler (for dropping below all blocks)
  const blocksContainer = document.getElementById("blocks-container");
  if (blocksContainer) {
    blocksContainer.addEventListener("dragover", (e) => {
      if (state.draggedBlockIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    blocksContainer.addEventListener("drop", (e) => {
      if (e.target === blocksContainer && state.draggedBlockIndex !== null) {
        e.preventDefault();
        const fromIdx = state.draggedBlockIndex;
        const toIdx = state.currentProject?.blocks?.length || 0;
        reorderBlock(fromIdx, toIdx);
      }
    });
  }

  // Modal Backdrop Clicks
  const colabModal = document.getElementById("colab-modal");
  if (colabModal) {
    colabModal.addEventListener("click", (e) => {
      if (e.target.id === "colab-modal") closeColabModal();
    });
  }

  const newProjModal = document.getElementById("new-project-modal");
  if (newProjModal) {
    newProjModal.addEventListener("click", (e) => {
      if (e.target.id === "new-project-modal") closeNewProjectModal();
    });
  }

  const importModal = document.getElementById("import-modal");
  if (importModal) {
    importModal.addEventListener("click", (e) => {
      if (e.target.id === "import-modal") closeImportModal();
    });
  }

  const saveCharModal = document.getElementById("save-character-modal");
  if (saveCharModal) {
    saveCharModal.addEventListener("click", (e) => {
      if (e.target.id === "save-character-modal") closeSaveCharacterModal();
    });
  }

  document.getElementById("char-modal-name-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmSaveCharacter();
    }
  });

  // Drag and drop for new project textarea
  const newProjTextarea = document.getElementById("new-project-text-input");
  if (newProjTextarea) {
    newProjTextarea.addEventListener("dragover", (e) => {
      e.preventDefault();
      newProjTextarea.classList.add("drag-over");
    });
    newProjTextarea.addEventListener("dragleave", () => {
      newProjTextarea.classList.remove("drag-over");
    });
    newProjTextarea.addEventListener("drop", (e) => {
      e.preventDefault();
      newProjTextarea.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        processImportedFile(e.dataTransfer.files[0], "new_project_modal");
      }
    });
  }

  // Drag and drop for studio import textarea
  const importTextarea = document.getElementById("import-textarea");
  if (importTextarea) {
    importTextarea.addEventListener("dragover", (e) => {
      e.preventDefault();
      importTextarea.classList.add("drag-over");
    });
    importTextarea.addEventListener("dragleave", () => {
      importTextarea.classList.remove("drag-over");
    });
    importTextarea.addEventListener("drop", (e) => {
      e.preventDefault();
      importTextarea.classList.remove("drag-over");
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const reader = new FileReader();
        reader.onload = (evt) => {
          importTextarea.value = evt.target.result;
          showToast(`✓ Loaded "${file.name}"`);
        };
        reader.readAsText(file, "UTF-8");
      }
    });
  }
}

function isPauseTag(tagStr) {
  const content = tagStr.replace(/[\[\]\s]/g, "").toLowerCase();
  return content.startsWith("pause");
}

function splitTextIntoSentences(text) {
  if (!text) return [];
  const raw = text.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const rawLines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const results = [];

  const ABBREVIATIONS = [
    /\bMr\./gi, /\bMrs\./gi, /\bMs\./gi, /\bDr\./gi, /\bProf\./gi,
    /\bSr\./gi, /\bJr\./gi, /\bvs\./gi, /\betc\./gi, /\be\.g\./gi,
    /\bi\.e\./gi, /\bU\.S\./gi, /\bNo\./gi, /\bVol\./gi, /\bCh\./gi
  ];

  rawLines.forEach(line => {
    let marked = line.replace(/\[[^\]]+\]/g, (tag, offset) => {
      if (isPauseTag(tag)) return tag;
      if (offset === 0) return tag;
      return `\u0000${tag}`;
    });

    const tagChunks = marked.split("\u0000").map(c => c.trim()).filter(Boolean);

    tagChunks.forEach(chunk => {
      let cleanChunk = chunk.replace(/^(\[[^\]]+\])([A-Za-z0-9])/g, "$1 $2").trim();
      if (!cleanChunk) return;

      let cardPauseAfter = 0.5;
      const trailingMatch = cleanChunk.match(/\[pause(?:\s*[:=]?\s*([\d.]+)\s*s?)?\]\s*$/i);
      if (trailingMatch) {
        if (trailingMatch[1]) cardPauseAfter = parseFloat(trailingMatch[1]);
        cleanChunk = cleanChunk.replace(/\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*$/i, "").trim();
      }
      cleanChunk = cleanChunk.replace(/^\s*\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*/i, "").trim();
      if (!cleanChunk) return;

      // Protect abbreviations & decimals
      let protectedText = cleanChunk;
      ABBREVIATIONS.forEach((abbr, idx) => {
        protectedText = protectedText.replace(abbr, `__ABBR_${idx}__`);
      });
      protectedText = protectedText.replace(/(\d+)\.(\d+)/g, "$1__DOT__$2");

      // Sentence boundary split: (. ! ?) followed by quotes/spaces and capital/quote/tag
      const sentenceRegex = /(?<=[.!?])(?:['"’”\s]+)(?=[A-Z“"‘'\[0-9])/;
      const rawSentences = protectedText.split(sentenceRegex).map(s => s.trim()).filter(Boolean);

      const restored = rawSentences.map(s => {
        ABBREVIATIONS.forEach((abbr, idx) => {
          const sample = abbr.source.replace(/\\b/g, "").replace(/\\./g, ".");
          s = s.replaceAll(`__ABBR_${idx}__`, sample);
        });
        return s.replaceAll("__DOT__", ".");
      });

      restored.forEach(s => {
        if (s.length <= 180) {
          results.push({ text: s, pause_after: cardPauseAfter });
          return;
        }

        const clauses = s.split(/(?<=[;—:])\s+/).map(c => c.trim()).filter(Boolean);
        if (clauses.length > 1 && clauses.every(c => c.length <= 180)) {
          clauses.forEach(c => results.push({ text: c, pause_after: cardPauseAfter }));
          return;
        }

        const commaParts = s.split(/(?<=,)\s+(?=(?:and|but|or|so|yet|because|although|while|where|which|as|with|who|whom)\b)/i).map(c => c.trim()).filter(Boolean);
        if (commaParts.length > 1) {
          let curr = "";
          commaParts.forEach(cp => {
            if (!curr) curr = cp;
            else if (curr.length + cp.length + 1 <= 180) curr += " " + cp;
            else {
              results.push({ text: curr, pause_after: cardPauseAfter });
              curr = cp;
            }
          });
          if (curr) results.push({ text: curr, pause_after: cardPauseAfter });
          return;
        }

        const words = s.split(/\s+/);
        let curr = "";
        words.forEach(w => {
          if (!curr) curr = w;
          else if (curr.length + w.length + 1 <= 180) curr += " " + w;
          else {
            results.push({ text: curr, pause_after: cardPauseAfter });
            curr = w;
          }
        });
        if (curr) results.push({ text: curr, pause_after: cardPauseAfter });
      });
    });
  });

  return results;
}

function splitBlock(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const block = state.currentProject.blocks[idx];
  if (!block || !block.text) return;

  const items = splitTextIntoSentences(block.text);
  if (items.length <= 1) {
    showToast("ℹ️ This block has no additional emotion tags to split.");
    return;
  }

  recordHistory(`Split Block ${idx + 1}`);

  const defs = getProjectDefaultSettings();
  const baseVoice = block.voice_id || defs.voice_id;
  const baseSpeed = block.speed !== undefined ? block.speed : defs.speed;
  const baseGain = block.gain !== undefined ? block.gain : defs.gain;
  const basePause = block.pause_after !== undefined ? block.pause_after : defs.pause_after;
  const basePitch = block.pitch_shift !== undefined ? block.pitch_shift : defs.pitch_shift;
  const baseWarmth = block.warmth !== undefined ? block.warmth : defs.warmth;
  const baseClarity = block.clarity !== undefined ? block.clarity : defs.clarity;
  const baseReverb = block.reverb !== undefined ? block.reverb : defs.reverb;
  const baseFilter = block.fx_filter || (block.radio_fx ? "radio" : defs.fx_filter);
  const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

  const newBlocks = items.map((item, sIdx) => {
    const itemText = (typeof item === "string") ? item : item.text;
    const itemPause = (typeof item === "object" && item.pause_after !== undefined) ? item.pause_after : basePause;
    const newB = {
      id: `${block.id || "b"}_s${sIdx + 1}_${Date.now()}`,
      text: itemText,
      voice_id: baseVoice,
      speed: baseSpeed,
      gain: baseGain,
      pause_after: itemPause,
      pitch_shift: basePitch,
      warmth: baseWarmth,
      clarity: baseClarity,
      reverb: baseReverb,
      radio_fx: (baseFilter === "radio"),
      fx_filter: baseFilter
    };
    if (baseBlend) newB.blend_weights = JSON.parse(JSON.stringify(baseBlend));
    return newB;
  });

  state.currentProject.blocks.splice(idx, 1, ...newBlocks);

  state.selectedBlockIndices = new Set([idx]);
  state.activeBlockIndex = idx;
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`✂️ Split into ${newBlocks.length} sentence blocks!`);
}

function handleAutoSplitAll() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;

  const defs = getProjectDefaultSettings();
  let totalSplits = 0;
  const newBlocksList = [];

  state.currentProject.blocks.forEach((block) => {
    if (block.type === "heading" || block.is_spoken === false) {
      newBlocksList.push(block);
      return;
    }
    const items = splitTextIntoSentences(block.text || "");
    const baseVoice = block.voice_id || defs.voice_id;
    const baseSpeed = block.speed !== undefined ? block.speed : defs.speed;
    const baseGain = block.gain !== undefined ? block.gain : defs.gain;
    const basePause = block.pause_after !== undefined ? block.pause_after : defs.pause_after;
    const basePitch = block.pitch_shift !== undefined ? block.pitch_shift : defs.pitch_shift;
    const baseWarmth = block.warmth !== undefined ? block.warmth : defs.warmth;
    const baseClarity = block.clarity !== undefined ? block.clarity : defs.clarity;
    const baseReverb = block.reverb !== undefined ? block.reverb : defs.reverb;
    const baseFilter = block.fx_filter || (block.radio_fx ? "radio" : defs.fx_filter);
    const baseBlend = block.blend_weights ? JSON.parse(JSON.stringify(block.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

    if (items.length > 1) {
      totalSplits += (items.length - 1);
      items.forEach((item, sIdx) => {
        const itemText = (typeof item === "string") ? item : item.text;
        const itemPause = (typeof item === "object" && item.pause_after !== undefined) ? item.pause_after : basePause;
        const nb = {
          id: `${block.id || "b"}_s${sIdx + 1}_${Date.now()}`,
          text: itemText,
          voice_id: baseVoice,
          speed: baseSpeed,
          gain: baseGain,
          pause_after: itemPause,
          pitch_shift: basePitch,
          warmth: baseWarmth,
          clarity: baseClarity,
          reverb: baseReverb,
          radio_fx: (baseFilter === "radio"),
          fx_filter: baseFilter
        };
        if (baseBlend) nb.blend_weights = JSON.parse(JSON.stringify(baseBlend));
        newBlocksList.push(nb);
      });
    } else {
      newBlocksList.push(block);
    }
  });

  if (totalSplits > 0) {
    recordHistory(`Auto-Split (${totalSplits} new blocks)`);
    state.currentProject.blocks = newBlocksList;
    state.selectedBlockIndices = new Set([0]);
    state.activeBlockIndex = 0;
    state.lastClickedIndex = 0;
    renderStudio();
    debouncedSave();
    showToast(`✂️ Auto-split into ${newBlocksList.length} blocks!`);
  } else {
    showToast("ℹ️ All blocks are already individual emotion beats.");
  }
}

function handleCleanPauses() {
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) {
    showToast("⚠️ Open a project with story blocks first.");
    return;
  }
  recordHistory("Clean [pause] Tags");
  let cleanedCount = 0;
  state.currentProject.blocks.forEach((block) => {
    if (!block.text) return;
    const originalText = block.text;
    let t = block.text;

    // 1. Check for trailing [pause] or [pause: Xs]
    const trailingMatch = t.match(/\[pause(?:\s*[:=]?\s*([\d.]+)\s*s?)?\]\s*$/i);
    if (trailingMatch) {
      if (trailingMatch[1]) {
        block.pause_after = parseFloat(trailingMatch[1]);
      } else if (block.pause_after === undefined || block.pause_after === null) {
        block.pause_after = 0.5;
      }
      t = t.replace(/\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*$/i, "").trim();
    }

    // 2. Strip leading [pause]
    t = t.replace(/^\s*\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]\s*/i, "").trim();

    // 3. Convert any mid-sentence [pause] to natural breath ellipsis "..."
    if (/\[pause(?:\s*[:=]?\s*[\d.]+\s*s?)?\]/i.test(t)) {
      t = t.replace(/\s*\[pause(?:\s*[:=]?\s*([\d.]+)\s*s?)?\]\s*/gi, "... ");
    }

    t = t.replace(/\s{2,}/g, " ").trim();

    if (t !== originalText) {
      cleanedCount++;
      block.text = t;
      block.cachedAudioUrl = null;
      block.audio_hash = null;
      block.rawAudioUrl = null;
      block.duration = 0;
    }
  });

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  if (cleanedCount > 0) {
    showToast(`🧹 Cleaned [pause] tags from ${cleanedCount} card(s)! Trailing gaps converted to Card Spacing.`);
  } else {
    showToast("ℹ️ All cards are already clean — no redundant [pause] tags found.");
  }
}

function deleteBlock(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  if (state.currentProject.blocks.length <= 1) {
    showToast("⚠️ Project must have at least one block.");
    return;
  }
  const deletedItem = state.currentProject.blocks[idx];
  const itemType = (deletedItem?.type === "heading" || deletedItem?.is_spoken === false) ? "Scene Heading" : "Sentence";

  recordHistory(`Delete ${itemType} (Row ${idx + 1})`);

  state.currentProject.blocks.splice(idx, 1);
  const nextSelected = new Set();
  state.selectedBlockIndices.forEach(i => {
    if (i < idx) nextSelected.add(i);
    else if (i > idx) nextSelected.add(i - 1);
  });
  if (nextSelected.size === 0) {
    nextSelected.add(Math.min(idx, state.currentProject.blocks.length - 1));
  }
  state.selectedBlockIndices = nextSelected;
  state.activeBlockIndex = Math.min(state.activeBlockIndex, state.currentProject.blocks.length - 1);
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast(`✓ ${itemType} deleted.`);
}

// ---------------- DRAG & DROP REORDERING ENGINE ---------------- //

function attachBlockDragAndDrop(row, idx) {
  const handle = row.querySelector(".block-drag-handle");
  if (!handle) return;

  // Make row draggable only when user interacts with the grip handle
  handle.addEventListener("mouseenter", () => {
    row.setAttribute("draggable", "true");
  });
  handle.addEventListener("mouseleave", () => {
    if (!row.classList.contains("is-dragging")) {
      row.removeAttribute("draggable");
    }
  });

  row.addEventListener("dragstart", (e) => {
    state.draggedBlockIndex = idx;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
    row.classList.add("is-dragging");

    if (!state.selectedBlockIndices.has(idx)) {
      selectBlock(idx, "single");
    }
  });

  row.addEventListener("dragend", () => {
    row.removeAttribute("draggable");
    row.classList.remove("is-dragging");
    state.draggedBlockIndex = null;
    document.querySelectorAll(".drop-indicator-above, .drop-indicator-below").forEach(el => {
      el.classList.remove("drop-indicator-above", "drop-indicator-below");
    });
  });

  row.addEventListener("dragover", (e) => {
    if (state.draggedBlockIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const rect = row.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isUpper = relY < rect.height / 2;

    if (isUpper) {
      row.classList.add("drop-indicator-above");
      row.classList.remove("drop-indicator-below");
    } else {
      row.classList.add("drop-indicator-below");
      row.classList.remove("drop-indicator-above");
    }
  });

  row.addEventListener("dragleave", (e) => {
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove("drop-indicator-above", "drop-indicator-below");
    }
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-indicator-above", "drop-indicator-below");
    if (state.draggedBlockIndex === null) return;

    const fromIdx = state.draggedBlockIndex;
    const rect = row.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isUpper = relY < rect.height / 2;
    const toIdx = isUpper ? idx : idx + 1;

    reorderBlock(fromIdx, toIdx);
  });
}

function reorderBlock(fromIdx, toIdx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  if (fromIdx < 0 || fromIdx >= blocks.length) return;

  const isMultiDrag = Boolean(
    state.selectedBlockIndices &&
    state.selectedBlockIndices.size > 1 &&
    state.selectedBlockIndices.has(fromIdx)
  );

  let finalTargetIndex = 0;

  if (!isMultiDrag) {
    let target = toIdx;
    if (target > fromIdx) target -= 1;
    if (target === fromIdx) return; // Same position, no-op

    target = Math.max(0, Math.min(target, blocks.length - 1));

    const item = blocks[fromIdx];
    const itemLabel = (item.type === "heading" || item.is_spoken === false) ? "Scene Heading" : "Sentence";
    recordHistory(`Move ${itemLabel} to Row ${target + 1}`);

    const [moved] = blocks.splice(fromIdx, 1);
    blocks.splice(target, 0, moved);

    state.activeBlockIndex = target;
    state.selectedBlockIndices = new Set([target]);
    finalTargetIndex = target;
  } else {
    const sortedIndices = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    const targetBlockRef = (toIdx >= 0 && toIdx < blocks.length) ? blocks[toIdx] : null;

    recordHistory(`Reorder ${sortedIndices.length} Blocks`);

    const selectedBlocks = sortedIndices.map(i => blocks[i]);

    // Remove in reverse order
    for (let i = sortedIndices.length - 1; i >= 0; i--) {
      blocks.splice(sortedIndices[i], 1);
    }

    let insertPos = targetBlockRef ? blocks.indexOf(targetBlockRef) : blocks.length;
    if (insertPos === -1) insertPos = blocks.length;

    blocks.splice(insertPos, 0, ...selectedBlocks);

    const newSelection = new Set();
    for (let i = 0; i < selectedBlocks.length; i++) {
      newSelection.add(insertPos + i);
    }
    state.selectedBlockIndices = newSelection;
    state.activeBlockIndex = insertPos;
    finalTargetIndex = insertPos;
  }

  renderStudio();
  debouncedSave();
  renderSavedCharactersList();

  setTimeout(() => {
    const rows = document.querySelectorAll(".block-row, .scene-divider-row");
    const targetRow = rows[finalTargetIndex];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, 30);

  showToast(`↕️ Reordered: position ${finalTargetIndex + 1} of ${state.currentProject.blocks.length}`);
}

function moveBlockUp(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  const targetIdx = (typeof idx === "number" && idx >= 0 && idx < blocks.length) ? idx : state.activeBlockIndex;
  if (targetIdx <= 0) {
    showToast("ℹ️ Already at the top of the story.");
    return;
  }

  if (state.selectedBlockIndices && state.selectedBlockIndices.size > 1 && state.selectedBlockIndices.has(targetIdx)) {
    const sorted = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    if (sorted[0] <= 0) {
      showToast("ℹ️ Selected sentences are already at the very top.");
      return;
    }
    reorderBlock(targetIdx, sorted[0] - 1);
    return;
  }

  reorderBlock(targetIdx, targetIdx - 1);
}

function moveBlockDown(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const blocks = state.currentProject.blocks;
  const targetIdx = (typeof idx === "number" && idx >= 0 && idx < blocks.length) ? idx : state.activeBlockIndex;
  if (targetIdx >= blocks.length - 1) {
    showToast("ℹ️ Already at the bottom of the story.");
    return;
  }

  if (state.selectedBlockIndices && state.selectedBlockIndices.size > 1 && state.selectedBlockIndices.has(targetIdx)) {
    const sorted = Array.from(state.selectedBlockIndices).sort((a, b) => a - b);
    if (sorted[sorted.length - 1] >= blocks.length - 1) {
      showToast("ℹ️ Selected sentences are already at the very bottom.");
      return;
    }
    reorderBlock(targetIdx, sorted[sorted.length - 1] + 2);
    return;
  }

  reorderBlock(targetIdx, targetIdx + 2);
}

function insertBlockAfter(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const defs = getProjectDefaultSettings();
  const insertIdx = idx + 1;
  const currentBlock = state.currentProject.blocks[idx] || {};

  recordHistory(`Insert Sentence Block`);

  // Inherit voice actor and settings from the adjacent block if available
  const targetVoice = currentBlock.voice_id || defs.voice_id;
  const targetBlend = currentBlock.blend_weights ? JSON.parse(JSON.stringify(currentBlock.blend_weights)) : (defs.blend_weights ? JSON.parse(JSON.stringify(defs.blend_weights)) : undefined);

  const newBlock = {
    id: "b_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    text: "",
    voice_id: targetVoice,
    speed: currentBlock.speed !== undefined ? currentBlock.speed : defs.speed,
    gain: currentBlock.gain !== undefined ? currentBlock.gain : defs.gain,
    pause_after: currentBlock.pause_after !== undefined ? currentBlock.pause_after : defs.pause_after,
    pitch_shift: currentBlock.pitch_shift !== undefined ? currentBlock.pitch_shift : defs.pitch_shift,
    warmth: currentBlock.warmth !== undefined ? currentBlock.warmth : defs.warmth,
    clarity: currentBlock.clarity !== undefined ? currentBlock.clarity : defs.clarity,
    reverb: currentBlock.reverb !== undefined ? currentBlock.reverb : defs.reverb,
    radio_fx: currentBlock.radio_fx !== undefined ? Boolean(currentBlock.radio_fx) : Boolean(defs.radio_fx),
    fx_filter: currentBlock.fx_filter || defs.fx_filter || "none"
  };
  if (targetBlend) {
    newBlock.blend_weights = targetBlend;
  }

  state.currentProject.blocks.splice(insertIdx, 0, newBlock);
  renderStudio();
  selectBlock(insertIdx, "single");
  debouncedSave();

  // Scroll smoothly to the newly inserted block and focus its textarea
  setTimeout(() => {
    const rows = document.querySelectorAll(".block-row, .scene-divider-row");
    const targetRow = rows[insertIdx];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const ta = targetRow.querySelector(".block-textarea");
      if (ta) {
        ta.focus();
      }
    }
  }, 40);

  showToast(`＋ Inserted new sentence block at position ${insertIdx + 1}!`);
}

function addNewSceneHeading() {
  if (!state.currentProject) return;
  recordHistory("Add Scene Heading");
  const newIdx = state.currentProject.blocks.length;
  const headingBlock = {
    id: "h_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    type: "heading",
    text: "Scene " + (countHeadings() + 1),
    is_spoken: false,
    pause_after: 1.0
  };
  state.currentProject.blocks.push(headingBlock);
  renderStudio();
  selectBlock(newIdx, "single");
  debouncedSave();

  setTimeout(() => {
    const rows = document.querySelectorAll(".scene-divider-row, .block-row");
    const targetRow = rows[newIdx] || rows[rows.length - 1];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const inp = targetRow.querySelector(".scene-title-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }, 40);
  showToast("🎬 Added Scene Heading (non-spoken divider)!");
}

function insertHeadingAfter(idx) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  recordHistory(`Insert Scene Heading (Row ${idx + 1})`);
  const insertIdx = idx + 1;
  const headingBlock = {
    id: "h_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
    type: "heading",
    text: "Scene " + (countHeadings() + 1),
    is_spoken: false,
    pause_after: 1.0
  };
  state.currentProject.blocks.splice(insertIdx, 0, headingBlock);
  renderStudio();
  selectBlock(insertIdx, "single");
  debouncedSave();

  setTimeout(() => {
    const rows = document.querySelectorAll(".scene-divider-row, .block-row");
    const targetRow = rows[insertIdx];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      const inp = targetRow.querySelector(".scene-title-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }, 40);
  showToast(`🎬 Inserted Scene Heading at position ${insertIdx + 1}!`);
}

function convertHeadingToSpeech(idx) {
  if (!state.currentProject?.blocks?.[idx]) return;
  recordHistory("Convert Divider to Speech");
  const b = state.currentProject.blocks[idx];
  const defs = getProjectDefaultSettings();
  b.type = "speech";
  b.is_spoken = true;
  b.voice_id = b.voice_id || defs.voice_id;
  b.speed = b.speed !== undefined ? b.speed : defs.speed;
  b.gain = b.gain !== undefined ? b.gain : defs.gain;
  b.pause_after = b.pause_after !== undefined ? b.pause_after : defs.pause_after;
  b.pitch_shift = b.pitch_shift !== undefined ? b.pitch_shift : defs.pitch_shift;
  b.warmth = b.warmth !== undefined ? b.warmth : defs.warmth;
  b.clarity = b.clarity !== undefined ? b.clarity : defs.clarity;
  b.reverb = b.reverb !== undefined ? b.reverb : defs.reverb;
  b.fx_filter = b.fx_filter || defs.fx_filter;
  b.radio_fx = Boolean(b.fx_filter === "radio");
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast("🎙️ Converted divider to spoken sentence block!");
}

function convertSpeechToHeading(idx) {
  if (!state.currentProject?.blocks?.[idx]) return;
  recordHistory("Convert Sentence to Divider");
  const b = state.currentProject.blocks[idx];
  b.type = "heading";
  b.is_spoken = false;
  b.pause_after = b.pause_after !== undefined ? b.pause_after : 1.0;
  delete b.cachedAudioUrl;
  delete b.cachedSig;
  delete b.duration;
  renderStudio();
  debouncedSave();
  renderSavedCharactersList();
  showToast("🎬 Converted to non-spoken Scene Heading!");
}

// ---------------- GLOBAL WINDOW EXPORTS FOR INLINE ONCLICK ---------------- //
window.toggleSelectAll = toggleSelectAll;
window.clearBlockSelection = clearBlockSelection;
window.openVoiceDrawer = openVoiceDrawer;
window.closeVoiceDrawer = closeVoiceDrawer;
window.handleBulkRender = handleBulkRender;
window.handleBulkDelete = handleBulkDelete;
window.handleMakeDefaultVoice = handleMakeDefaultVoice;
window.handleApplyVoiceToAll = handleApplyVoiceToAll;
window.handleApplyPacingToAll = handleApplyPacingToAll;
window.handleSetCurrentAsDefault = handleSetCurrentAsDefault;
window.getProjectDefaultSettings = getProjectDefaultSettings;
window.handleToggleRadioFx = handleToggleRadioFx;
window.handleSelectAudioFilter = handleSelectAudioFilter;
window.splitBlock = splitBlock;
window.handleCleanPauses = handleCleanPauses;
window.handleReRenderBlock = handleReRenderBlock;
window.insertBlockAfter = insertBlockAfter;
window.handleAutoSplitAll = handleAutoSplitAll;
window.handleAutoDirectStory = handleAutoDirectStory;
window.handleMergeShortBlocks = handleMergeShortBlocks;
window.handleBulkMergeSelected = handleBulkMergeSelected;
window.applyDeliveryPreset = applyDeliveryPreset;
window.splitTextIntoSentences = splitTextIntoSentences;
window.deleteBlock = deleteBlock;
window.switchToView = switchToView;
window.openProject = openProject;
window.saveCurrentProject = saveCurrentProject;
window.showToast = showToast;
window.openColabModal = openColabModal;
window.closeColabModal = closeColabModal;
window.handleTestColab = handleTestColab;
window.handleSaveColab = handleSaveColab;
window.handleClearColab = handleClearColab;
window.handleCopyColabScript = handleCopyColabScript;
window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.handleDoImport = handleDoImport;
window.openNewProjectModal = openNewProjectModal;
window.closeNewProjectModal = closeNewProjectModal;
window.handleCreateProjectSubmit = handleCreateProjectSubmit;
window.toggleBatchRender = toggleBatchRender;
window.exportMasterAudio = exportMasterAudio;
window.exportZipAudio = exportZipAudio;
window.handleMasterPlayToggle = handleMasterPlayToggle;
window.handleMasterPrev = handleMasterPrev;
window.handleMasterNext = handleMasterNext;
window.handleMasterStop = handleMasterStop;
window.playBlockAudio = playBlockAudio;
window.handleDashboardFileImport = handleDashboardFileImport;
window.handleNewProjectFile = handleNewProjectFile;
window.loadSampleIntoNewProject = loadSampleIntoNewProject;
window.clearNewProjectFile = clearNewProjectFile;
window.handleImportModalFile = handleImportModalFile;
window.processImportedFile = processImportedFile;
window.cleanTitleFromFilename = cleanTitleFromFilename;
window.handleUndo = handleUndo;
window.handleRedo = handleRedo;
window.toggleHistoryDropdown = toggleHistoryDropdown;
window.revertToHistoryStep = revertToHistoryStep;
window.addNewSceneHeading = addNewSceneHeading;
window.insertHeadingAfter = insertHeadingAfter;
window.convertHeadingToSpeech = convertHeadingToSpeech;
window.convertSpeechToHeading = convertSpeechToHeading;
window.handleApplyVoiceToSelected = handleApplyVoiceToSelected;
window.handleApplyVoiceToOverriddenCast = handleApplyVoiceToOverriddenCast;
window.handleRevertToOverriddenCast = handleRevertToOverriddenCast;
window.updateOverriddenCastButtonUI = updateOverriddenCastButtonUI;
window.handleApplySettingsToSelected = handleApplySettingsToSelected;
window.handleOpenSaveCharacterModal = handleOpenSaveCharacterModal;
window.closeSaveCharacterModal = closeSaveCharacterModal;
window.confirmSaveCharacter = confirmSaveCharacter;
window.applyCharacterToSelected = applyCharacterToSelected;
window.updateCharacterWithCurrent = updateCharacterWithCurrent;
window.makeActiveSentenceSyncedToCharacter = makeActiveSentenceSyncedToCharacter;
window.renameCharacter = renameCharacter;
window.deleteCharacter = deleteCharacter;
window.renderSavedCharactersList = renderSavedCharactersList;

// ---------------- INSPECTOR TAB NAVIGATION & CONTROLS ---------------- //

function switchInspectorTab(tabName) {
  if (!tabName) tabName = "audio";
  state.currentInspectorTab = tabName;

  // Uncollapse panel if collapsed
  const panel = document.getElementById("inspector-panel") || document.querySelector(".inspector-panel");
  if (panel && panel.classList.contains("collapsed")) {
    toggleInspectorCollapse(false);
  }

  // On compact/smaller screens (< 1440px), auto-collapse agent when opening inspector tabs
  if (window.innerWidth < 1440 && state.aiAgent?.isOpen) {
    toggleAIAgentPanel(false);
  }

  // Update tabs & rail buttons
  ["audio", "cast", "fx"].forEach(tab => {
    const railBtn = document.getElementById(`rail-tab-${tab}`);
    if (railBtn) railBtn.classList.toggle("active", tab === tabName);

    const tabPill = document.getElementById(`tab-btn-${tab}`);
    if (tabPill) tabPill.classList.toggle("active", tab === tabName);

    const pane = document.getElementById(`inspector-tab-pane-${tab}`);
    if (pane) pane.classList.toggle("active", tab === tabName);
  });

  updateActiveCharacterStatusBanner();
  if (tabName === "cast") {
    renderSavedCharactersList();
  }
}

function toggleInspectorCollapse(forceState = null) {
  const panel = document.getElementById("inspector-panel") || document.querySelector(".inspector-panel");
  if (!panel) return;
  const isCollapsed = forceState !== null ? forceState : !panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed", isCollapsed);
  const btn = document.getElementById("btn-toggle-inspector-collapse");
  if (btn) {
    btn.textContent = isCollapsed ? "▶" : "◀";
    btn.title = isCollapsed ? "Expand Inspector Panel" : "Collapse Inspector Panel";
  }
}

function resetDspToNeutral() {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 0)
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex]);

  targets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;
    b.pitch_shift = 0.0;
    b.warmth = 0.0;
    b.clarity = 0.0;
    b.reverb = 0.0;
    if (b.character_id) {
      b.is_custom_edited = true;
    }
  });
  renderInspector();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  recordHistory("Reset Tone to Neutral");
  showToast("↺ Voice tone reset to neutral");
}

window.switchInspectorTab = switchInspectorTab;
window.toggleInspectorCollapse = toggleInspectorCollapse;
window.resetDspToNeutral = resetDspToNeutral;
window.openEditCharacterModal = openEditCharacterModal;
window.handleApplyVoiceAndSettingsToSelected = handleApplyVoiceAndSettingsToSelected;
window.revertActiveBlockToCharacter = revertActiveBlockToCharacter;
window.pullActiveSentenceToCharModal = pullActiveSentenceToCharModal;
window.selectCharModalFilter = selectCharModalFilter;
window.updateActiveCharacterStatusBanner = updateActiveCharacterStatusBanner;
window.reorderBlock = reorderBlock;
window.moveBlockUp = moveBlockUp;
window.moveBlockDown = moveBlockDown;
window.handleDashboardSearch = handleDashboardSearch;
window.clearDashboardSearch = clearDashboardSearch;
window.setDashboardFilter = setDashboardFilter;
window.handleDashboardSort = handleDashboardSort;
window.setDashboardLayout = setDashboardLayout;
window.loadSampleStoryIntoProject = loadSampleStoryIntoProject;
window.toggleDashboardPreview = toggleDashboardPreview;
window.handleDuplicateProject = handleDuplicateProject;
window.handleRenameProject = handleRenameProject;
window.toggleExportDropdown = toggleExportDropdown;
window.closeExportDropdown = closeExportDropdown;
window.updateExportDropdownUI = updateExportDropdownUI;
window.exportSelectedAudio = exportSelectedAudio;
window.handleExportSelectedFromMenu = handleExportSelectedFromMenu;
window.handleExportMasterFromMenu = handleExportMasterFromMenu;
window.handleExportZipFromMenu = handleExportZipFromMenu;
window.handleExportProjectJson = handleExportProjectJson;
window.toggleBlockCustomEdited = toggleBlockCustomEdited;
window.markAllBlocksOfCharacter = markAllBlocksOfCharacter;
window.switchGlobalActiveEngine = switchGlobalActiveEngine;
window.toggleEngineModelDropdown = toggleEngineModelDropdown;
window.selectEngineOption = selectEngineOption;
window.handleBlockEngineChange = handleBlockEngineChange;
window.handleToggleClientKokoro = handleToggleClientKokoro;
window.handleCopyColabScript = handleCopyColabScript;
window.handleQuickEmotionClick = handleQuickEmotionClick;
window.clearBlockEmotionTag = clearBlockEmotionTag;
window.handleEmbedEmotionTagIntoText = handleEmbedEmotionTagIntoText;
window.handleExtractEmotionTagFromText = handleExtractEmotionTagFromText;
window.handleEmotionTagInput = handleEmotionTagInput;
window.handleFocusEmotionInput = handleFocusEmotionInput;
window.handleReferenceVoiceFileUpload = handleReferenceVoiceFileUpload;
window.handleTestFishKey = handleTestFishKey;
window.handleClearTunnelInput = handleClearTunnelInput;
window.handleClearApiKeyInput = handleClearApiKeyInput;
window.switchCloudSection = switchCloudSection;
window.handleCopyColabScriptAndOpen = handleCopyColabScriptAndOpen;
window.syncCustomUrlToColabUrl = syncCustomUrlToColabUrl;
window.handleClearCustomGpuInput = handleClearCustomGpuInput;
window.handleTestCustomGpu = handleTestCustomGpu;
window.detectLocalGpu = detectLocalGpu;
window.handleLaunchLocalGpuWorker = handleLaunchLocalGpuWorker;
window.handleStopLocalGpuWorker = handleStopLocalGpuWorker;
window.handleToggleLocalGpuAutoLaunch = handleToggleLocalGpuAutoLaunch;
window.toggleLocalGpuLogs = toggleLocalGpuLogs;
window.toggleCustomManualUrl = toggleCustomManualUrl;




window.switchCloudTab = switchCloudTab;
window.handleKaggleDragOver = handleKaggleDragOver;
window.handleKaggleDragLeave = handleKaggleDragLeave;
window.handleKaggleDrop = handleKaggleDrop;
window.handleKaggleFileSelect = handleKaggleFileSelect;
window.handleVerifyKaggle = handleVerifyKaggle;
window.handleLaunchKaggle = handleLaunchKaggle;
window.handleStopKaggle = handleStopKaggle;
window.toggleKaggleCredentialsForm = toggleKaggleCredentialsForm;
window.toggleColdstartGuideCollapse = toggleColdstartGuideCollapse;
window.dismissTrafficAlert = dismissTrafficAlert;
window.handleSwitchToColabFast = handleSwitchToColabFast;
window.handleSwitchToFishProFast = handleSwitchToFishProFast;
window.handleContinueInBackground = handleContinueInBackground;
window.handleCancelKaggleAndDirectLocal = handleCancelKaggleAndDirectLocal;


// Fish Audio Discovery exports
window.toggleDrawerExpanded = toggleDrawerExpanded;
window.handleFishSearchInput = handleFishSearchInput;
window.clearFishSearch = clearFishSearch;
window.selectFishTag = selectFishTag;
window.handleFishFilterChange = handleFishFilterChange;
window.loadFishLibraryExplore = loadFishLibraryExplore;
window.searchFishLibrary = searchFishLibrary;
window.loadMoreFishSearchResults = loadMoreFishSearchResults;
window.quickFilterFishTag = quickFilterFishTag;
window.toggleFishAudioSample = toggleFishAudioSample;
window.useFishVoiceModel = useFishVoiceModel;
window.saveFishVoiceModel = saveFishVoiceModel;
window.switchDrawerMode = switchDrawerMode;
window.handleCharModalEngineChange = handleCharModalEngineChange;
window.handleVoiceDrawerBackdropClick = handleVoiceDrawerBackdropClick;
window.openDrawerEditVoice = openDrawerEditVoice;
window.handleSaveEditedVoice = handleSaveEditedVoice;
window.handleDeleteVoiceFromLibrary = handleDeleteVoiceFromLibrary;
window.handleEvRefFileUpload = handleEvRefFileUpload;
window.handlePlayEvRefAudio = handlePlayEvRefAudio;
window.handleCopyProjectToOtherEngine = handleCopyProjectToOtherEngine;
window.handleCopyCurrentProjectToOther = handleCopyCurrentProjectToOther;
window.showMessageCard = showMessageCard;
window.closeEpubModal = closeEpubModal;
window.handleEpubBookChange = handleEpubBookChange;
window.handleEpubChapterChange = handleEpubChapterChange;
window.confirmEpubChapterImport = confirmEpubChapterImport;
window.toggleEpubCastMode = toggleEpubCastMode;
window.toggleNewProjMode = toggleNewProjMode;

window.openFolderView = openFolderView;
window.exitFolderView = exitFolderView;
window.openNewFolderModal = openNewFolderModal;
window.closeCreateFolderModal = closeCreateFolderModal;
window.handleCreateFolderSubmit = handleCreateFolderSubmit;
window.handleDeleteFolder = handleDeleteFolder;
window.openMasterCastModal = openMasterCastModal;
window.closeMasterCastModal = closeMasterCastModal;
window.handleAddMasterCastCharacter = handleAddMasterCastCharacter;
window.handleDeleteMasterCastCharacter = handleDeleteMasterCastCharacter;
window.updateMasterCastField = updateMasterCastField;
window.saveMasterCastSubmit = saveMasterCastSubmit;
window.openMoveToFolderModal = openMoveToFolderModal;
window.closeMoveToFolderModal = closeMoveToFolderModal;
window.handleMoveToFolderSubmit = handleMoveToFolderSubmit;
window.handleReorderChapter = handleReorderChapter;
window.handleSortFolderChapters = handleSortFolderChapters;
window.handleExportFullAudiobook = handleExportFullAudiobook;
window.populateFolderSelects = populateFolderSelects;
window.handleFolderEbookSelected = handleFolderEbookSelected;
window.handleFolderEbookDrop = handleFolderEbookDrop;
window.clearFolderEbookSelection = clearFolderEbookSelection;
window.openStubDirectModal = openStubDirectModal;
window.closeStubDirectModal = closeStubDirectModal;
window.handleStubDirectSubmit = handleStubDirectSubmit;
window.handleStubFastSplit = handleStubFastSplit;
window.retryStubDirectModal = retryStubDirectModal;
window.toggleAllEbookBooks = toggleAllEbookBooks;
window.toggleAllEbookChapters = toggleAllEbookChapters;
window.filterFluffEbookChapters = filterFluffEbookChapters;
window.toggleEbookBookExpand = toggleEbookBookExpand;
window.toggleEbookBookChapters = toggleEbookBookChapters;
window.updateEbookBookSelectionCount = updateEbookBookSelectionCount;
window.isFluffChapter = isFluffChapter;
window.updateStubTempDisplay = updateStubTempDisplay;
window.toggleStubDefaultsMode = toggleStubDefaultsMode;
window.openSeriesSettingsModal = openSeriesSettingsModal;
window.closeSeriesSettingsModal = closeSeriesSettingsModal;
window.handleSaveSeriesSettingsSubmit = handleSaveSeriesSettingsSubmit;
window.handleRemoveFluffChapters = handleRemoveFluffChapters;
window.selectBlocksByCharacter = selectBlocksByCharacter;
window.toggleCharacterFilter = toggleCharacterFilter;
window.clearCharacterFilter = clearCharacterFilter;
window.changeCharacterVoice = changeCharacterVoice;
window.syncWithUniverseCast = syncWithUniverseCast;
window.closeRemoveCharacterModal = closeRemoveCharacterModal;
window.executeRemoveCharacterFromChapterOnly = executeRemoveCharacterFromChapterOnly;
window.executeDeleteCharacterFromEntireSeries = executeDeleteCharacterFromEntireSeries;
window.handleNewProjectDirectorModeChange = handleNewProjectDirectorModeChange;
window.handleNewProjectTierChange = handleNewProjectTierChange;
window.handleCreateProjectManualFastSplit = handleCreateProjectManualFastSplit;
window.handleStubMethodChange = handleStubMethodChange;

// ==========================================================================
// AI DIRECTOR AGENT CONTROLLER (Interactive Chat & Instant Action Engine)
// ==========================================================================

state.aiAgent = {
  isOpen: false,
  isExpanded: false,
  isThinking: false,
  messages: [],
  provider: "gemini",
  model: "gemini-3.5-flash-lite",
  apiKey: "",
  temperature: 0.50
};

async function initAIAgentConfig() {
  try {
    const savedProv = localStorage.getItem("ai_director_agent_provider");
    const savedModel = localStorage.getItem("ai_director_agent_model");
    const savedTemp = localStorage.getItem("ai_director_agent_temperature");
    if (savedProv) state.aiAgent.provider = savedProv;
    if (savedModel) state.aiAgent.model = savedModel;
    if (savedTemp) state.aiAgent.temperature = parseFloat(savedTemp) || 0.5;

    const res = await fetch("/api/ai_director/config");
    if (res.ok) {
      const cfg = await res.json();
      if (!savedProv && cfg.default_llm_provider) {
        state.aiAgent.provider = cfg.default_llm_provider;
      }
      const prov = state.aiAgent.provider || "gemini";
      state.aiAgent.apiKey = cfg[`${prov}_api_key`] || "";
    }
  } catch(e) {
    console.warn("[AIAgent] Config load notice:", e);
  }
  updateAIAgentModelBadge();
}

function updateAIAgentModelBadge() {
  const badge = document.getElementById("agent-model-name-label") || document.getElementById("agent-model-badge");
  if (badge) {
    const p = state.aiAgent.provider || "gemini";
    const provName = p === "gemini" ? "Gemini" : (p === "groq" ? "Groq" : (p === "openai" ? "OpenAI" : "Ollama"));
    badge.textContent = `${provName} (${state.aiAgent.model || 'Auto'})`;
  }
}

function toggleAIAgentPanel(forceOpen = null) {
  const panel = document.getElementById("ai-agent-panel");
  if (!panel) return;

  const shouldOpen = (forceOpen !== null) ? Boolean(forceOpen) : panel.classList.contains("collapsed");
  panel.classList.toggle("collapsed", !shouldOpen);
  state.aiAgent.isOpen = shouldOpen;

  // On compact / laptop screens (< 1650px), auto-collapse left inspector when opening agent panel
  if (shouldOpen && window.innerWidth < 1650) {
    const insp = document.getElementById("inspector-panel");
    if (insp && !insp.classList.contains("collapsed")) {
      toggleInspectorCollapse(true);
      state._autoCollapsedInspectorForAgent = true;
    }
  } else if (!shouldOpen && state._autoCollapsedInspectorForAgent) {
    toggleInspectorCollapse(false);
    state._autoCollapsedInspectorForAgent = false;
  }

  const toggleBtn = document.getElementById("btn-ai-agent-toggle");
  if (toggleBtn) {
    toggleBtn.classList.toggle("active", shouldOpen);
    if (shouldOpen) {
      toggleBtn.style.boxShadow = "0 0 16px rgba(139, 92, 246, 0.6)";
      toggleBtn.style.borderColor = "#a78bfa";
    } else {
      toggleBtn.style.boxShadow = "";
      toggleBtn.style.borderColor = "";
    }
  }

  const railTab = document.getElementById("rail-tab-agent");
  if (railTab) {
    railTab.classList.toggle("active", shouldOpen);
  }

  if (shouldOpen) {
    updateAIAgentContextUI();
    if (state.aiAgent.messages.length === 0) {
      const storyTitle = state.currentProject?.title || "your story";
      const blockCount = state.currentProject?.blocks?.length || 0;
      const charCount = (state.savedCharacters || state.currentProject?.characters || []).length;
      state.aiAgent.messages.push({
        role: "assistant",
        content: `👋 **Hello! I'm your AI Director Agent.**\n\nI have full visibility into **${storyTitle}** (${blockCount} sentences, ${charCount} cast members).\n\nTell me what you'd like to do in plain English — for example:\n- *"Make the dialogue in sentences 2–5 more dramatic and whispery"*\n- *"Create a character named The Fog Entity with deep reverb and pitch -2.0"*\n- *"Split line 3 where Lucy gasps"*\n- *"Set the narrator pace to 1.10x with 0.2s trailing pause"*`
      });
      renderAIAgentMessages();
    }
    setTimeout(() => {
      const input = document.getElementById("ai-agent-input");
      if (input) input.focus();
    }, 150);
  }
}

function toggleAIAgentWidth() {
  const panel = document.getElementById("ai-agent-panel");
  if (!panel) return;
  const isExp = panel.classList.toggle("expanded");
  state.aiAgent.isExpanded = isExp;
  const btn = document.getElementById("btn-agent-expand");
  if (btn) {
    btn.innerHTML = isExp ? "⊡" : "⊞";
    btn.title = isExp ? "Normal Width" : "Expand Width";
  }
}

function updateAIAgentContextUI() {
  const metaSentences = document.getElementById("agent-meta-sentences");
  const metaCast = document.getElementById("agent-meta-cast");
  const totalCount = state.currentProject?.blocks?.length || 0;
  const charCount = (state.savedCharacters || state.currentProject?.characters || []).length;
  if (metaSentences) metaSentences.textContent = `${totalCount} Sentences`;
  if (metaCast) metaCast.textContent = `${charCount} Cast`;

  const bar = document.getElementById("agent-selection-context-bar");
  const textEl = document.getElementById("agent-selection-context-text");
  const selCount = (state.selectedBlockIndices && state.selectedBlockIndices.size) || 0;

  if (bar && textEl) {
    if (selCount === 1) {
      const idx = Array.from(state.selectedBlockIndices)[0];
      const b = state.currentProject?.blocks?.[idx];
      const spk = b?.speaker || "Narrator";
      textEl.innerHTML = `Sentence #${idx + 1} (${escapeHtml(spk)})`;
      bar.style.display = "flex";
    } else if (selCount > 1) {
      textEl.innerHTML = `${selCount} sentences selected`;
      bar.style.display = "flex";
    } else if (typeof state.activeBlockIndex === "number" && state.currentProject?.blocks?.[state.activeBlockIndex]) {
      const idx = state.activeBlockIndex;
      const b = state.currentProject.blocks[idx];
      const spk = b?.speaker || "Narrator";
      textEl.innerHTML = `Sentence #${idx + 1} (${escapeHtml(spk)})`;
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  }
}

function autoResizeAgentInput(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(140, Math.max(38, el.scrollHeight)) + "px";
}

function handleAIAgentInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSendAIAgentMessage();
  }
}

function applyAIAgentStarter(promptText) {
  const input = document.getElementById("ai-agent-input");
  if (!input) return;
  input.value = promptText;
  autoResizeAgentInput(input);
  input.focus();
}

function clearAIAgentChat() {
  startNewAIAgentSession(true);
}

// ---------------- AI DIRECTOR SESSIONS & CHAT HISTORY ---------------- //

function getAIAgentSessionsStorageKey() {
  const projId = state.currentProject?.id || "global";
  return `ai_director_sessions_${projId}`;
}

function getAIAgentSessions() {
  try {
    const raw = localStorage.getItem(getAIAgentSessionsStorageKey());
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch(e) {}
  return [];
}

function saveAIAgentSessions(sessionsList) {
  try {
    localStorage.setItem(getAIAgentSessionsStorageKey(), JSON.stringify(sessionsList));
  } catch(e) {}
}

function initAIAgentSessions() {
  const sessions = getAIAgentSessions();
  if (sessions.length > 0) {
    const recent = sessions[0];
    state.aiAgent.currentSessionId = recent.id;
    state.aiAgent.messages = recent.messages || [];
  } else {
    startNewAIAgentSession(false);
  }
}

function saveCurrentAIAgentSession() {
  const projId = state.currentProject?.id || "global";
  let sessions = getAIAgentSessions();
  let currentId = state.aiAgent.currentSessionId;

  // Determine an intelligent title from first user query
  let title = "New Conversation";
  const firstUserMsg = (state.aiAgent.messages || []).find(m => m.role === "user");
  if (firstUserMsg && firstUserMsg.content) {
    title = firstUserMsg.content.trim().slice(0, 36);
    if (firstUserMsg.content.trim().length > 36) title += "...";
  }

  let existing = sessions.find(s => s.id === currentId);
  if (existing) {
    if (!existing.title || existing.title === "New Conversation") {
      existing.title = title;
    }
    existing.messages = state.aiAgent.messages;
    existing.updatedAt = Date.now();
  } else {
    currentId = "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4);
    state.aiAgent.currentSessionId = currentId;
    sessions.unshift({
      id: currentId,
      projectId: projId,
      title: title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: state.aiAgent.messages
    });
  }

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveAIAgentSessions(sessions);
}

function startNewAIAgentSession(notify = true) {
  const projId = state.currentProject?.id || "global";
  const storyTitle = state.currentProject?.title || "your story";
  const blockCount = state.currentProject?.blocks?.length || 0;
  const charCount = (state.savedCharacters || state.currentProject?.characters || []).length;

  const newId = "session_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4);
  state.aiAgent.currentSessionId = newId;
  state.aiAgent.messages = [
    {
      role: "assistant",
      content: `👋 **Hello! I'm your AI Director Agent.**\n\nI have full visibility into **${storyTitle}** (${blockCount} sentences, ${charCount} cast members).\n\nTell me what you'd like to do in plain English — for example:\n- *"Make the dialogue in sentences 2–5 more dramatic and whispery"*\n- *"Create a character named The Fog Entity with deep reverb and pitch -2.0"*\n- *"Split line 3 where Lucy gasps"*\n- *"Set the narrator pace to 1.10x with 0.2s trailing pause"*`
    }
  ];

  let sessions = getAIAgentSessions();
  sessions.unshift({
    id: newId,
    projectId: projId,
    title: "New Conversation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: state.aiAgent.messages
  });
  saveAIAgentSessions(sessions);

  toggleAIAgentSessionsDrawer(false);
  renderAIAgentMessages();

  setTimeout(() => {
    const input = document.getElementById("ai-agent-input");
    if (input) input.focus();
  }, 100);

  if (notify) {
    showToast("✨ Started fresh AI Director chat");
  }
}

function loadAIAgentSession(sessionId) {
  const sessions = getAIAgentSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  state.aiAgent.currentSessionId = session.id;
  state.aiAgent.messages = session.messages || [];

  toggleAIAgentSessionsDrawer(false);
  renderAIAgentMessages();
  showToast(`💬 Loaded chat: "${session.title}"`);
}

function deleteAIAgentSession(sessionId, ev) {
  if (ev) ev.stopPropagation();
  let sessions = getAIAgentSessions();
  sessions = sessions.filter(s => s.id !== sessionId);
  saveAIAgentSessions(sessions);

  if (state.aiAgent.currentSessionId === sessionId) {
    if (sessions.length > 0) {
      loadAIAgentSession(sessions[0].id);
    } else {
      startNewAIAgentSession(false);
    }
  } else {
    renderAIAgentSessionsList();
  }
  showToast("🗑️ Chat deleted");
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function renderAIAgentSessionsList() {
  const listEl = document.getElementById("agent-sessions-list");
  if (!listEl) return;

  const sessions = getAIAgentSessions();
  const projTitle = state.currentProject?.title || "Story Project";
  const activeId = state.aiAgent.currentSessionId;

  if (sessions.length === 0) {
    listEl.innerHTML = `
      <div style="padding: 24px 12px; text-align: center; color: #64748b; font-size: 12px;">
        No saved chats for this story yet.<br>Click <strong>+ New Chat</strong> above to start!
      </div>
    `;
    return;
  }

  let html = `
    <div style="font-size: 11px; font-weight: 700; color: #818cf8; padding: 4px 6px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
      <span>📁</span>
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(projTitle)}</span>
    </div>
  `;

  sessions.forEach(sess => {
    const isActive = (sess.id === activeId);
    const msgCount = (sess.messages || []).filter(m => m.role === "user").length;
    const timeStr = formatRelativeTime(sess.updatedAt || sess.createdAt);

    html += `
      <div class="agent-session-item ${isActive ? 'active' : ''}" onclick="loadAIAgentSession('${sess.id}')">
        <div class="agent-session-main">
          <div class="agent-session-title">${escapeHtml(sess.title || "New Conversation")}</div>
          <div class="agent-session-meta">
            <span>${timeStr}</span>
            <span>•</span>
            <span>${msgCount} prompt${msgCount !== 1 ? 's' : ''}</span>
            ${isActive ? '<span style="color:#34d399; font-weight:700;">● Active</span>' : ''}
          </div>
        </div>
        <button type="button" class="agent-session-delete-btn" onclick="deleteAIAgentSession('${sess.id}', event)" title="Delete this conversation">
          ✕
        </button>
      </div>
    `;
  });

  listEl.innerHTML = html;
}

function toggleAIAgentSessionsDrawer(forceOpen = null) {
  const drawer = document.getElementById("agent-sessions-drawer");
  if (!drawer) return;

  const shouldOpen = (forceOpen !== null) ? Boolean(forceOpen) : (drawer.style.display === "none" || !drawer.style.display);
  drawer.style.display = shouldOpen ? "flex" : "none";
  const btn = document.getElementById("btn-agent-sessions");
  if (btn) btn.classList.toggle("active", shouldOpen);

  if (shouldOpen) {
    renderAIAgentSessionsList();
  }
}

// ---------------- SENTENCE NAVIGATION & PILLS (#127) ---------------- //

function jumpToSentence(num) {
  if (!state.currentProject || !Array.isArray(state.currentProject.blocks)) {
    showToast("⚠️ No active story blocks loaded.");
    return;
  }
  const blocks = state.currentProject.blocks;
  if (blocks.length === 0) return;

  const targetNum = parseInt(num, 10);
  if (isNaN(targetNum)) return;

  let targetIdx = -1;
  const idMatch = blocks.findIndex(b => b.id === `b_${targetNum}` || b.id === String(targetNum));
  if (idMatch !== -1) {
    targetIdx = idMatch;
  } else if (targetNum >= 1 && targetNum <= blocks.length) {
    targetIdx = targetNum - 1;
  } else if (targetNum >= 0 && targetNum < blocks.length) {
    targetIdx = targetNum;
  }

  if (targetIdx < 0 || targetIdx >= blocks.length) {
    showToast(`⚠️ Sentence #${num} is out of bounds (1 to ${blocks.length}).`);
    return;
  }

  selectBlock(targetIdx, "single");

  const row = document.querySelector(`[data-index="${targetIdx}"]`);
  if (row) {
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.remove("highlight-flash");
    void row.offsetWidth; // trigger reflow
    row.classList.add("highlight-flash");
    setTimeout(() => {
      row.classList.remove("highlight-flash");
    }, 2400);
  }

  updateAIAgentContextUI();

  const preview = (blocks[targetIdx].text || "").slice(0, 48);
  showToast(`🎯 Selected Sentence #${targetIdx + 1}: "${preview}..."`);
}

function formatAIAgentMessageContent(rawText) {
  if (!rawText) return "";
  // Strip any stray action block so internal JSON never leaks into chat
  if (rawText.includes("<agent_actions>")) {
    rawText = rawText.split("<agent_actions>")[0].trim();
  }
  const trimmed = String(rawText).trim();
  if ((trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.includes('"action"')) {
    rawText = "I've reviewed the script and applied the requested character casting, emotional acting tags, and block adjustments.";
  }
  let str = String(rawText)
    .replace(/&amp;#0*39;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"');

  let formatted = str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08); padding:1px 4px; border-radius:3px; font-family:monospace; font-size:11px;">$1</code>')
    .replace(/\n/g, '<br>');

  // Automatically replace #127, sentence #127, sentences #127, #128, line 127 into clickable sentence pills!
  // Guard with negative lookbehind (?<!&#) and negative lookahead (?!;) so HTML entities like &#039; are NEVER matched!
  formatted = formatted.replace(/(?:sentence[s]?\s*|line[s]?\s*)?(?<!&#)#(\d+)\b(?!;)/gi, (match, numStr) => {
    const num = parseInt(numStr, 10);
    return `<a href="javascript:void(0)" class="agent-sentence-ref-pill" onclick="jumpToSentence(${num}); event.stopPropagation();" title="Jump directly to sentence #${num}">#${num}</a>`;
  });

  return formatted;
}

function scrollAgentMessagesToBottom() {
  const feed = document.getElementById("agent-messages-container") || document.getElementById("agent-message-feed");
  if (feed) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function renderAIAgentMessages() {
  const feed = document.getElementById("agent-messages-container") || document.getElementById("agent-message-feed");
  if (!feed) return;

  const welcome = document.getElementById("agent-empty-welcome");
  if (welcome) {
    welcome.style.display = (state.aiAgent.messages.length === 0) ? "flex" : "none";
  }

  const starters = document.getElementById("agent-starters-section");
  if (starters) {
    starters.style.display = (state.aiAgent.messages.length > 1) ? "none" : "block";
  }

  feed.innerHTML = "";

  state.aiAgent.messages.forEach((msg) => {
    const isUser = (msg.role === "user");
    const bubble = document.createElement("div");
    bubble.className = `agent-chat-bubble agent-msg-row ${isUser ? 'user' : 'assistant'}`;

    if (isUser) {
      bubble.innerHTML = `<div class="agent-bubble-text agent-msg-bubble">${formatAIAgentMessageContent(msg.content)}</div>`;
    } else {
      const formatted = formatAIAgentMessageContent(msg.content);

      let actionsHtml = "";
      if (msg.actionsSummary) {
        actionsHtml = `
          <div class="agent-action-card" style="margin-top: 8px; padding: 8px 10px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px;">
            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; color: #34d399; margin-bottom: 4px;">
              <span>⚡ Actions Executed (${msg.actionsSummary.count})</span>
              <button onclick="undo()" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #e2e8f0; border-radius: 4px; padding: 2px 6px; font-size: 10px; cursor: pointer;">↩ Undo</button>
            </div>
            <div style="font-size: 11px; color: #cbd5e1; line-height: 1.4;">${escapeHtml(msg.actionsSummary.details)}</div>
          </div>
        `;
      }

      bubble.innerHTML = `
        <div class="agent-bubble-header" style="margin-bottom: 4px;">
          <span style="font-size: 11px; font-weight: 700; color: #c4b5fd;">✨ AI Director</span>
        </div>
        <div class="agent-bubble-text agent-msg-bubble">${formatted}</div>
        ${actionsHtml}
      `;
    }

    feed.appendChild(bubble);
  });

  if (state.aiAgent.isThinking) {
    const thinkingBubble = document.createElement("div");
    thinkingBubble.className = "agent-chat-bubble agent-msg-row assistant agent-bubble-thinking";
    thinkingBubble.innerHTML = `
      <div class="agent-bubble-text agent-msg-bubble" style="display: flex; align-items: center; gap: 8px; color: #94a3b8; font-size: 12px;">
        <span class="agent-spinner">⏳</span>
        <span>Director analyzing script & acoustic parameters...</span>
        <div class="agent-typing-dots"><span></span><span></span><span></span></div>
      </div>
    `;
    feed.appendChild(thinkingBubble);
  }

  scrollAgentMessagesToBottom();
}

async function handleSendAIAgentMessage() {
  const input = document.getElementById("ai-agent-input");
  if (!input) return;
  const userText = (input.value || "").trim();
  if (!userText || state.aiAgent.isThinking) return;

  input.value = "";
  autoResizeAgentInput(input);

  state.aiAgent.messages.push({
    role: "user",
    content: userText
  });
  saveCurrentAIAgentSession();
  state.aiAgent.isThinking = true;
  renderAIAgentMessages();

  const selectedIndices = [];
  if (state.selectedBlockIndices && state.selectedBlockIndices.size > 0) {
    selectedIndices.push(...Array.from(state.selectedBlockIndices));
  } else if (typeof state.activeBlockIndex === "number") {
    selectedIndices.push(state.activeBlockIndex);
  }

  const blocksSummary = (state.currentProject?.blocks || []).map((b, idx) => ({
    index: idx,
    id: b.id,
    speaker: b.speaker || "Narrator",
    character_id: b.character_id,
    voice_id: b.voice_id,
    emotion_tag: b.emotion_tag || "",
    speed: b.speed || 1.0,
    pitch_shift: b.pitch_shift || 0.0,
    warmth: b.warmth || 0.0,
    clarity: b.clarity || 0.0,
    reverb: b.reverb || 0.0,
    fx_filter: b.fx_filter || (b.radio_fx ? "radio" : "none"),
    pause_after: b.pause_after || 0.6,
    text: b.text,
    has_audio: Boolean(b.cachedAudioUrl)
  }));

  const projectContext = {
    title: state.currentProject?.title || "Untitled Project",
    engine: state.activeEngine || "fish_s2",
    total_blocks: blocksSummary.length,
    selected_indices: selectedIndices,
    active_index: state.activeBlockIndex,
    characters: state.savedCharacters || state.currentProject?.characters || [],
    blocks: blocksSummary
  };

  const availableVoices = (state.voices || []).map(v => ({
    id: v.id,
    name: v.name,
    gender: v.gender,
    accent: v.accent,
    tags: v.tags,
    description: v.description
  }));

  try {
    // Sanitize past messages so API error alerts or token notices never pollute the LLM prompt
    const sanitizedHistory = (state.aiAgent.messages || [])
      .filter(m => !m.content || (!m.content.includes("Director Error") && !m.content.includes("⚠️") && !m.content.includes("HTTP 413")))
      .slice(-8);

    const res = await fetch("/api/ai_director/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: sanitizedHistory,
        project_context: projectContext,
        available_voices: availableVoices,
        provider: state.aiAgent.provider || "gemini",
        api_key: state.aiAgent.apiKey || "",
        model: state.aiAgent.model || "",
        temperature: state.aiAgent.temperature || 0.5
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server returned HTTP ${res.status}: ${errText.slice(0, 160)}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "AI Director call failed");
    }

    let actionsSummary = null;
    if (Array.isArray(data.actions) && data.actions.length > 0) {
      actionsSummary = executeAIAgentActions(data.actions);
    }

    state.aiAgent.messages.push({
      role: "assistant",
      content: data.reply || "Done! I have applied the requested changes.",
      actionsSummary: actionsSummary
    });
    saveCurrentAIAgentSession();
  } catch (err) {
    console.error("[AIAgent] Chat error:", err);
    state.aiAgent.messages.push({
      role: "assistant",
      content: `⚠️ **Director Error**: ${err.message}\n\n*Check your API key in Agent Settings (⚙️ icon above).*`
    });
    saveCurrentAIAgentSession();
  } finally {
    state.aiAgent.isThinking = false;
    renderAIAgentMessages();
  }
}

function executeAIAgentActions(actions) {
  if (!state.currentProject || !Array.isArray(state.currentProject.blocks)) {
    return { count: 0, details: "No active project." };
  }

  const actionTypes = actions.map(a => a.action || "EDIT").join(", ");
  recordHistory(`AI Director: ${actionTypes}`);

  let updatedBlockCount = 0;
  let dspIndices = new Set();
  const logs = [];

  for (const act of actions) {
    const type = (act.action || "").toUpperCase();

    if (type === "BATCH_TAGS" || type === "APPLY_TAGS" || type === "TAG_BLOCKS") {
      const tagsMap = act.tags || act.updates || {};
      let tagCount = 0;
      if (Array.isArray(tagsMap)) {
        tagsMap.forEach(item => {
          const idx = (typeof item.index === "number") ? item.index : parseInt(item.index, 10);
          if (idx >= 0 && idx < state.currentProject.blocks.length) {
            const b = state.currentProject.blocks[idx];
            const tag = item.tag || item.emotion_tag || "";
            if (tag) {
              b.emotion_tag = tag;
              delete b.cachedAudioUrl;
              delete b.cachedSig;
              delete b.duration;
              tagCount++;
            }
            if (item.speed) b.speed = Number(item.speed);
            if (item.speaker) b.speaker = item.speaker;
            updatedBlockCount++;
          }
        });
      } else if (typeof tagsMap === "object" && tagsMap !== null) {
        Object.entries(tagsMap).forEach(([idxStr, tagVal]) => {
          const idx = parseInt(idxStr, 10);
          if (!isNaN(idx) && idx >= 0 && idx < state.currentProject.blocks.length) {
            const b = state.currentProject.blocks[idx];
            const tag = (typeof tagVal === "string") ? tagVal : (tagVal.tag || tagVal.emotion_tag || "");
            if (tag) {
              b.emotion_tag = tag;
              delete b.cachedAudioUrl;
              delete b.cachedSig;
              delete b.duration;
              tagCount++;
            }
            if (typeof tagVal === "object" && tagVal !== null) {
              if (tagVal.speed) b.speed = Number(tagVal.speed);
              if (tagVal.speaker) b.speaker = tagVal.speaker;
            }
            updatedBlockCount++;
          }
        });
      }
      logs.push(`Applied tags to ${tagCount} sentences`);

    } else if (type === "UPDATE_BLOCKS") {
      const indices = Array.isArray(act.indices) ? act.indices : (typeof act.index === "number" ? [act.index] : []);
      indices.forEach(idx => {
        if (idx < 0 || idx >= state.currentProject.blocks.length) return;
        const b = state.currentProject.blocks[idx];

        let textOrVoiceChanged = false;
        let dspChanged = false;

        if (act.speaker !== undefined && act.speaker !== b.speaker) {
          b.speaker = act.speaker;
        }
        if (act.character_id !== undefined) {
          b.character_id = act.character_id;
        }
        if (act.voice_id !== undefined && act.voice_id !== b.voice_id) {
          b.voice_id = act.voice_id;
          textOrVoiceChanged = true;
        }
        if (act.emotion_tag !== undefined && act.emotion_tag !== b.emotion_tag) {
          b.emotion_tag = act.emotion_tag;
          textOrVoiceChanged = true;
        }
        if (act.text !== undefined && act.text !== b.text) {
          b.text = act.text;
          textOrVoiceChanged = true;
        }
        if (act.speed !== undefined && act.speed !== b.speed) {
          b.speed = Number(act.speed);
          dspChanged = true;
        }
        if (act.pitch_shift !== undefined && act.pitch_shift !== b.pitch_shift) {
          b.pitch_shift = Number(act.pitch_shift);
          dspChanged = true;
        }
        if (act.warmth !== undefined && act.warmth !== b.warmth) {
          b.warmth = Number(act.warmth);
          dspChanged = true;
        }
        if (act.clarity !== undefined && act.clarity !== b.clarity) {
          b.clarity = Number(act.clarity);
          dspChanged = true;
        }
        if (act.reverb !== undefined && act.reverb !== b.reverb) {
          b.reverb = Number(act.reverb);
          dspChanged = true;
        }
        if (act.fx_filter !== undefined) {
          b.fx_filter = act.fx_filter;
          b.radio_fx = (act.fx_filter === "radio");
          dspChanged = true;
        }
        if (act.pause_after !== undefined) {
          b.pause_after = Number(act.pause_after);
        }

        if (textOrVoiceChanged) {
          delete b.cachedAudioUrl;
          delete b.cachedSig;
          delete b.duration;
        } else if (dspChanged && b.cachedAudioUrl) {
          dspIndices.add(idx);
        }

        updatedBlockCount++;
      });
      logs.push(`Updated ${indices.length} sentences`);

    } else if (type === "SPLIT_BLOCK") {
      let idx = (typeof act.index === "number") ? act.index : act.block_index;
      const newSegments = act.new_segments || [];
      if (newSegments.length > 1) {
        // Smart match: if text of candidate at idx doesn't match, search across blocks
        if (typeof idx !== "number" || idx < 0 || idx >= state.currentProject.blocks.length) {
          const seg0 = (newSegments[0] && newSegments[0].text) || "";
          if (seg0) {
            const foundIdx = state.currentProject.blocks.findIndex(b => b.text && (b.text.includes(seg0.slice(0, 20)) || seg0.includes(b.text.slice(0, 20))));
            if (foundIdx !== -1) idx = foundIdx;
          }
        }
        if (typeof idx === "number" && idx >= 0 && idx < state.currentProject.blocks.length) {
          const orig = state.currentProject.blocks[idx];
          const replacementBlocks = newSegments.map((seg, sIdx) => ({
            ...orig,
            id: `b_${Date.now()}_${sIdx}_${Math.random().toString(36).substr(2, 4)}`,
            text: seg.text || "",
            speaker: seg.speaker || orig.speaker,
            character_id: seg.character_id !== undefined ? seg.character_id : orig.character_id,
            voice_id: seg.voice_id !== undefined ? seg.voice_id : orig.voice_id,
            emotion_tag: seg.emotion_tag !== undefined ? seg.emotion_tag : orig.emotion_tag,
            speed: (seg.speed !== undefined) ? Number(seg.speed) : (orig.speed || 1.0),
            pause_after: (seg.pause_after !== undefined) ? Number(seg.pause_after) : (orig.pause_after || 0.6),
            cachedAudioUrl: undefined,
            cachedSig: undefined,
            duration: undefined
          }));
          state.currentProject.blocks.splice(idx, 1, ...replacementBlocks);
          logs.push(`Split sentence #${idx + 1} into ${newSegments.length} parts`);
        }
      }

    } else if (type === "MERGE_BLOCKS") {
      const indices = (act.indices || []).sort((a, b) => a - b);
      if (indices.length >= 2) {
        const firstIdx = indices[0];
        const targetBlock = state.currentProject.blocks[firstIdx];
        if (targetBlock) {
          const mergedTexts = [];
          for (let i = indices.length - 1; i >= 0; i--) {
            const curIdx = indices[i];
            const b = state.currentProject.blocks[curIdx];
            if (b) {
              mergedTexts.unshift(b.text);
              if (curIdx !== firstIdx) {
                state.currentProject.blocks.splice(curIdx, 1);
              }
            }
          }
          targetBlock.text = mergedTexts.join(" ");
          delete targetBlock.cachedAudioUrl;
          delete targetBlock.cachedSig;
          delete targetBlock.duration;
          logs.push(`Merged ${indices.length} sentences into sentence ${firstIdx + 1}`);
        }
      }

    } else if (type === "DELETE_BLOCKS") {
      const indices = (act.indices || []).sort((a, b) => b - a);
      indices.forEach(idx => {
        if (idx >= 0 && idx < state.currentProject.blocks.length) {
          state.currentProject.blocks.splice(idx, 1);
        }
      });
      logs.push(`Deleted ${indices.length} sentences`);

    } else if (type === "INSERT_BLOCK") {
      const afterIdx = typeof act.after_index === "number" ? act.after_index : state.currentProject.blocks.length - 1;
      const defs = getProjectDefaultSettings();
      const newB = {
        id: `b_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        text: act.text || "New sentence",
        speaker: act.speaker || "Narrator",
        voice_id: act.voice_id || defs.voice_id || "voice_stanley_narrator",
        emotion_tag: act.emotion_tag || "",
        speed: act.speed || 1.0,
        pause_after: act.pause_after || 0.6,
        pitch_shift: act.pitch_shift || 0.0,
        warmth: act.warmth || 0.0,
        clarity: act.clarity || 0.0,
        reverb: act.reverb || 0.0
      };
      state.currentProject.blocks.splice(afterIdx + 1, 0, newB);
      logs.push(`Inserted sentence at ${afterIdx + 2}`);

    } else if (type === "CREATE_CHARACTER") {
      const newChar = {
        id: "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
        name: act.name || "New Character",
        voice_id: act.voice_id || "voice_stanley_narrator",
        speed: Number(act.speed || 1.0),
        pitch_shift: Number(act.pitch_shift || 0.0),
        warmth: Number(act.warmth || 0.0),
        clarity: Number(act.clarity || 0.0),
        reverb: Number(act.reverb || 0.0),
        fx_filter: act.fx_filter || "none",
        radio_fx: (act.fx_filter === "radio"),
        color: act.color || "#8b5cf6",
        badge: act.badge || (act.name || "CH").slice(0, 2).toUpperCase()
      };
      if (!state.savedCharacters) state.savedCharacters = [];
      state.savedCharacters.push(newChar);
      if (!state.currentProject.characters) state.currentProject.characters = [];
      state.currentProject.characters.push(newChar);
      saveSavedCharactersToStorage();
      logs.push(`Created cast character "${newChar.name}"`);

    } else if (type === "ASSIGN_CHARACTER") {
      const charId = act.character_id;
      const char = (state.savedCharacters || []).find(c => c.id === charId || c.name.toLowerCase() === String(charId).toLowerCase()) ||
                   (state.currentProject.characters || []).find(c => c.id === charId || c.name.toLowerCase() === String(charId).toLowerCase());
      if (char) {
        const indices = Array.isArray(act.indices) ? act.indices : [];
        indices.forEach(idx => {
          if (idx >= 0 && idx < state.currentProject.blocks.length) {
            const b = state.currentProject.blocks[idx];
            const voiceObj = getVoiceById(char.voice_id || char.assigned_voice_id);
            b.character_id = char.id;
            b.speaker = char.name;
            b.voice_id = char.voice_id || char.assigned_voice_id;
            b.reference_audio = char.reference_audio || voiceObj?.reference_audio || "";
            b.reference_text = char.reference_text || voiceObj?.reference_text || "";
            delete b.cachedAudioUrl;
            delete b.audio_url;
            delete b.cachedSig;
            delete b.duration;
          }
        });
        logs.push(`Assigned "${char.name}" to ${indices.length} sentences`);
      }

    } else if (type === "CLEAN_PAUSES") {
      (state.currentProject.blocks || []).forEach(b => {
        b.pause_after = 0.2;
      });
      logs.push("Cleaned trailing breath pauses across all sentences to 0.2s");

    } else if (type === "MERGE_SHORT" || type === "CONSOLIDATE_NARRATION") {
      handleMergeShortBlocks();
      logs.push("Executed Merge Short / Consolidated Narration");

    } else if (type === "RUN_AUTO_DIRECT") {
      setTimeout(() => {
        handleAutoDirectStory();
      }, 100);
      logs.push("Triggered auto-direction across entire story");
    }
  }

  if (dspIndices.size > 0) {
    triggerInstantBlockDsp(Array.from(dspIndices));
    logs.push(`⚡ Instant DSP applied to ${dspIndices.size} rendered sentences`);
  }

  saveSavedCharactersToStorage();
  debouncedSave();
  renderBlocks();
  renderSavedCharactersList();
  renderInspector();
  renderTimeline();
  updateAIAgentContextUI();

  return {
    count: actions.length,
    details: logs.join(" • ") || "Changes applied successfully."
  };
}

// Agent Settings Modal
function openAgentSettingsModal() {
  const modal = document.getElementById("agent-settings-modal");
  if (!modal) return;

  const prov = state.aiAgent.provider || "gemini";
  selectAgentProvider(prov);

  const keyInput = document.getElementById("agent-api-key-input") || document.getElementById("agent-modal-api-key");
  if (keyInput) keyInput.value = state.aiAgent.apiKey || "";

  const tempSlider = document.getElementById("slider-agent-temp") || document.getElementById("agent-modal-temp");
  const tempVal = document.getElementById("val-agent-temp") || document.getElementById("agent-modal-temp-val");
  if (tempSlider) {
    tempSlider.value = state.aiAgent.temperature || 0.5;
    if (tempVal) tempVal.textContent = Number(tempSlider.value).toFixed(2);
  }

  modal.classList.add("active");
  modal.style.display = "flex";
}

function closeAgentSettingsModal(e) {
  if (e && e.target && e.target.id !== "agent-settings-modal" && !e.target.classList.contains("modal-backdrop") && !e.target.classList.contains("drawer-backdrop")) {
    return;
  }
  const modal = document.getElementById("agent-settings-modal");
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

function selectAgentProvider(prov) {
  state.aiAgent.provider = prov;
  document.querySelectorAll(".agent-prov-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-prov") === prov);
  });

  const keyGroup = document.getElementById("agent-key-input-group") || document.getElementById("agent-modal-key-row");
  const modelSelect = document.getElementById("agent-model-select") || document.getElementById("agent-modal-model-select");
  const keyLabel = document.getElementById("agent-key-label");
  const keyLink = document.getElementById("agent-key-link");

  if (keyLabel) {
    keyLabel.textContent = prov === "gemini" ? "Google Gemini API Key" : (prov === "groq" ? "Groq Cloud API Key" : (prov === "openai" ? "OpenAI API Key" : "API Key"));
  }
  if (keyLink) {
    keyLink.href = prov === "gemini" ? "https://aistudio.google.com/app/apikey" : (prov === "groq" ? "https://console.groq.com/keys" : "https://platform.openai.com/api-keys");
  }

  if (prov === "ollama") {
    if (keyGroup) keyGroup.style.display = "none";
  } else {
    if (keyGroup) keyGroup.style.display = "block";
  }

  if (modelSelect) {
    modelSelect.innerHTML = "";
    const modelOptions = {
      gemini: [
        { id: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite (Ultra Fast & Free - Recommended)" },
        { id: "gemini-3.5-flash", name: "gemini-3.5-flash (High IQ Creative Director)" },
        { id: "gemini-2.5-flash", name: "gemini-2.5-flash (Balanced)" },
        { id: "gemini-2.5-pro", name: "gemini-2.5-pro (Flagship Deep Director)" }
      ],
      groq: [
        { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile (Fastest 300 T/s)" },
        { id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant" }
      ],
      openai: [
        { id: "gpt-4o-mini", name: "gpt-4o-mini (Fast & Intelligent)" },
        { id: "gpt-4o", name: "gpt-4o (Flagship Director)" }
      ],
      ollama: [
        { id: "llama3.2", name: "llama3.2 (Local)" },
        { id: "mistral", name: "mistral (Local)" },
        { id: "qwen2.5:7b", name: "qwen2.5:7b (Local)" }
      ]
    };

    const list = modelOptions[prov] || [];
    list.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === state.aiAgent.model) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }
}

function toggleAgentKeyVisibility() {
  const input = document.getElementById("agent-api-key-input") || document.getElementById("agent-modal-api-key");
  if (input) {
    input.type = (input.type === "password") ? "text" : "password";
  }
}

async function saveAgentSettings() {
  const prov = state.aiAgent.provider || "gemini";
  const model = (document.getElementById("agent-model-select") || document.getElementById("agent-modal-model-select"))?.value || "";
  const key = ((document.getElementById("agent-api-key-input") || document.getElementById("agent-modal-api-key"))?.value || "").trim();
  const temp = parseFloat((document.getElementById("slider-agent-temp") || document.getElementById("agent-modal-temp"))?.value || "0.5");

  state.aiAgent.model = model;
  state.aiAgent.apiKey = key;
  state.aiAgent.temperature = temp;

  localStorage.setItem("ai_director_agent_provider", prov);
  localStorage.setItem("ai_director_agent_model", model);
  localStorage.setItem("ai_director_agent_temperature", temp.toString());

  try {
    const payload = {
      default_llm_provider: prov
    };
    if (key) {
      payload[`${prov}_api_key`] = key;
    }
    await fetch("/api/ai_director/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.warn("Could not save agent config to server:", e);
  }

  updateAIAgentModelBadge();
  closeAgentSettingsModal();
  showToast(`✓ AI Director Agent configured (${prov} / ${model})!`);
}

window.initAIAgentConfig = initAIAgentConfig;
window.toggleAIAgentPanel = toggleAIAgentPanel;
window.toggleAIAgentWidth = toggleAIAgentWidth;
window.updateAIAgentContextUI = updateAIAgentContextUI;
window.autoResizeAgentInput = autoResizeAgentInput;
window.handleAIAgentInputKeydown = handleAIAgentInputKeydown;
window.applyAIAgentStarter = applyAIAgentStarter;
window.clearAIAgentChat = clearAIAgentChat;
window.scrollAgentMessagesToBottom = scrollAgentMessagesToBottom;
window.renderAIAgentMessages = renderAIAgentMessages;
window.handleSendAIAgentMessage = handleSendAIAgentMessage;
window.executeAIAgentActions = executeAIAgentActions;
window.openAgentSettingsModal = openAgentSettingsModal;
window.closeAgentSettingsModal = closeAgentSettingsModal;
window.selectAgentProvider = selectAgentProvider;
window.toggleAgentKeyVisibility = toggleAgentKeyVisibility;
window.saveAgentSettings = saveAgentSettings;
window.jumpToSentence = jumpToSentence;
window.toggleAIAgentSessionsDrawer = toggleAIAgentSessionsDrawer;
window.startNewAIAgentSession = startNewAIAgentSession;
window.loadAIAgentSession = loadAIAgentSession;
window.deleteAIAgentSession = deleteAIAgentSession;
window.renderAIAgentSessionsList = renderAIAgentSessionsList;
window.initAIAgentSessions = initAIAgentSessions;
window.updatePlaybackBar = function() {
  if (typeof renderTimeline === 'function') renderTimeline();
  if (typeof updatePlaybackUI === 'function') updatePlaybackUI(state.currentlyPlayingBlockIdx, false);
};
window.toggleCustomComputeAccordion = toggleCustomComputeAccordion;
window.selectPlanTier = selectPlanTier;
window.updateTierDisplay = updateTierDisplay;
window.initAuth = initAuth;
window.toggleUserDropdown = toggleUserDropdown;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.handleLogout = handleLogout;
window.handleSelectPlan = handleSelectPlan;
window.toggleGateAuthMode = toggleGateAuthMode;
window.toggleGatePasswordVisibility = toggleGatePasswordVisibility;
window.handleGateSubmit = handleGateSubmit;
window.handleGoogleSignIn = handleGoogleSignIn;
window.handleGoogleJwtResponse = handleGoogleJwtResponse;
window.initGoogleAuth = initGoogleAuth;

