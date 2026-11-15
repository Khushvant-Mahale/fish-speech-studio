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
  updateUndoRedoUI();
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
  updateUndoRedoUI();
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
  updateUndoRedoUI();
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
    loadSavedCharacters();
    await loadVoices();
    await loadProjectsList();
    await loadConfig();
    setupEventListeners();

    // Check URL parameters for direct studio deep-linking
    const urlParams = new URLSearchParams(window.location.search);
    const projectId = urlParams.get("project") || urlParams.get("id");
    const isStudioPath = window.location.pathname.startsWith("/studio");

    if (projectId) {
      await openProject(projectId, false);
    } else if (isStudioPath && state.projects && state.projects.length > 0) {
      await openProject(state.projects[0].id, false);
    } else {
      switchToView("dashboard", false);
    }

    // Handle browser back/forward buttons
    window.addEventListener("popstate", (e) => {
      const params = new URLSearchParams(window.location.search);
      const pid = params.get("project") || params.get("id");
      const isStudio = window.location.pathname.startsWith("/studio");
      if (pid && (!state.currentProject || state.currentProject.id !== pid)) {
        openProject(pid, false);
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
    const res = await fetch(`/api/voices?engine=${state.activeEngine || 'fish_s2'}`);
    state.voices = await res.json();
    populateVoiceSelects();
  } catch (err) {
    console.error("Failed to load voices", err);
  }
}

function populateVoiceSelects() {
  const newProjSelect = document.getElementById("new-project-voice-select");
  const importSelect = document.getElementById("import-voice-select");
  if (!state.voices || state.voices.length === 0) return;

  const html = state.voices.map(v => {
    const isDefault = v.id === "fish_narrator_dark" || v.id === "blend_fenrir_onyx";
    return `<option value="${v.id}" ${isDefault ? 'selected' : ''}>${v.flag || '🎙️'} ${v.name} (${v.accent || 'EN'} • ${v.gender || 'Actor'})</option>`;
  }).join("");

  if (newProjSelect) newProjSelect.innerHTML = html;
  if (importSelect) importSelect.innerHTML = html;
}

async function loadProjectsList() {
  try {
    const res = await fetch("/api/projects?engine=fish_s2");
    state.projects = await res.json();
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
    if (label) label.textContent = badgeText;
    
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
      
      const launchBtn = document.getElementById("btn-launch-kaggle");
      const stopBtn = document.getElementById("btn-stop-kaggle");
      if (launchBtn) {
        launchBtn.textContent = "🟢 GPU Active & Connected";
        launchBtn.style.background = "#10b981";
        launchBtn.disabled = true;
      }
      if (stopBtn) stopBtn.style.display = "inline-block";

      if (wasOffline && !silent) {
        showToast("🟢 Cloud GPU reconnected successfully!");
      }
    } else {
      const wasOnline = (state.remoteWorkerHealthy === true);
      state.remoteWorkerHealthy = false;
      state.config.active = false;
      updateEngineUI(remoteUrl, false, { error: data.error });

      const launchBtn = document.getElementById("btn-launch-kaggle");
      const stopBtn = document.getElementById("btn-stop-kaggle");
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      if (stopBtn) stopBtn.style.display = "none";

      if (wasOnline && !silent) {
        showToast("⚠️ Cloud GPU disconnected or stopped. Studio reverted to Local CPU.", 5000);
      }
    }
  } catch (err) {
    state.remoteWorkerHealthy = false;
    state.config.active = false;
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
    if (!res.ok) throw new Error("Project not found");
    state.currentProject = await res.json();
    if (state.currentProject && state.currentProject.engine === "kokoro") {
      window.location.href = `/kokoro/studio?project=${encodeURIComponent(state.currentProject.id)}`;
      return;
    }
    state.activeBlockIndex = 0;
    state.selectedBlockIndices = new Set([0]);
    state.lastClickedIndex = 0;
    state.undoStack = [];
    state.redoStack = [];
    updateUndoRedoUI();
    loadSavedCharactersForCurrentProject();
    if (state.currentProject && state.currentProject.blocks) {
      state.currentProject.blocks.forEach(block => {
        const sig = getBlockSignature(block);
        if (block.cachedAudioUrl) {
          if (!block.cachedSig) {
            block.cachedSig = sig;
          } else if (block.cachedSig !== sig) {
            delete block.cachedAudioUrl;
            delete block.cachedSig;
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
    renderStudio();
  } catch (err) {
    console.error("Failed to load project: " + err);
    showToast("⚠️ Could not load project. Returning to dashboard.");
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
  const activeEng = block.engine || state.activeEngine || "fish_s2";
  return {
    text: block.text,
    voice_id: block.voice_id,
    engine: activeEng,
    emotion_tag: block.emotion_tag || "",
    reference_audio: block.reference_audio || "",
    reference_text: block.reference_text || "",
    temperature: block.temperature !== undefined ? Number(block.temperature) : 0.70,
    top_p: block.top_p !== undefined ? Number(block.top_p) : 0.85,
    blend_weights: block.blend_weights,
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

function getBlockSignature(block) {
  const text = (block.text || "").trim();
  const voice = block.voice_id || "";
  const engine = block.engine || state.activeEngine || "fish_s2";
  const emotion = block.emotion_tag || "";
  const refAudio = block.reference_audio || "";
  const speed = Number(block.speed || (engine === "fish_s2" ? 1.0 : 0.90)).toFixed(2);
  const gain = Number(block.gain || 1.0).toFixed(2);
  const temp = Number(block.temperature || 0.70).toFixed(2);
  const topP = Number(block.top_p || 0.85).toFixed(2);
  const pitch = Number(block.pitch_shift || 0.0).toFixed(1);
  const warmth = Number(block.warmth || 0.0).toFixed(1);
  const clarity = Number(block.clarity || 0.0).toFixed(1);
  const reverb = Number(block.reverb || 0.0).toFixed(2);
  const filter = (block.fx_filter || (block.radio_fx ? "radio" : "none")).toLowerCase();
  let blendStr = "";
  if (block.blend_weights) {
    blendStr = Object.entries(block.blend_weights).sort().map(([k, v]) => `${k}:${Number(v).toFixed(2)}`).join(",");
  }
  return `${engine}__${text}__${voice}__${emotion}__${refAudio}__${temp}__${topP}__${blendStr}__${speed}__${gain}__${pitch}__${warmth}__${clarity}__${reverb}__${filter}`;
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
  const dashEl = document.getElementById("view-dashboard");
  const studioEl = document.getElementById("view-studio");

  if (viewName === "dashboard") {
    dashEl.style.display = "flex";
    studioEl.style.display = "none";
    document.title = "Story Projects — Kashva Studio TTS";
    if (updateUrl) {
      history.pushState({ view: "dashboard" }, "", "/");
    }
    loadProjectsList();
  } else {
    dashEl.style.display = "none";
    studioEl.style.display = "flex";
    const projTitle = state.currentProject?.title || "Story Studio";
    document.title = `${projTitle} — Kashva Studio TTS`;
    if (updateUrl && state.currentProject?.id) {
      const studioUrl = `/studio?project=${encodeURIComponent(state.currentProject.id)}`;
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
  const targetName = targetEngine === "kokoro" ? "Kokoro Studio" : "Fish Audio Studio";
  const icon = targetEngine === "kokoro" ? "⚡" : "🐟";
  const targetUrlBase = targetEngine === "kokoro" ? "/kokoro" : "";
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
    const destUrl = `${targetUrlBase}/studio?project=${encodeURIComponent(newProj.id)}`;
    showToast(`✅ Copied to ${targetName} as "${newProj.title}"!`);

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

function renderDashboard() {
  const grid = document.getElementById("projects-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const projects = state.projects || [];
  state.activeEngine = "fish_s2";

  // Update header branding badge & title to match Fish Speech S2 Pro Studio
  const brandBadge = document.getElementById("dashboard-brand-badge");
  const brandTitle = document.getElementById("dashboard-brand-title");
  if (brandBadge) {
    brandBadge.textContent = "Fish Speech";
    brandBadge.style.background = "linear-gradient(135deg, #10b981, #059669)";
  }
  if (brandTitle) {
    brandTitle.textContent = "S2 Pro Studio";
  }

  // 1. Calculate top metrics strip stats (all projects together)
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

  // 4. Filter projects
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

  // 5. Sort projects
  if (dashboardSort === "recent") {
    filtered.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  } else if (dashboardSort === "sentences") {
    filtered.sort((a, b) => (b.block_count || 0) - (a.block_count || 0));
  } else if (dashboardSort === "duration") {
    filtered.sort((a, b) => (b.total_duration || 0) - (a.total_duration || 0));
  } else if (dashboardSort === "title") {
    filtered.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  // 6. Empty state handling
  if (filtered.length === 0) {
    const isSearching = Boolean(dashboardSearchQuery);
    const hasFilter = dashboardFilter !== "all";
    grid.innerHTML = `
      <div class="dashboard-empty-state">
        <div class="empty-icon">${isSearching ? "🔍" : "📂"}</div>
        <div class="empty-title">${isSearching ? `No stories match "${escapeHtml(dashboardSearchQuery)}"` : (hasFilter ? `No projects in this category` : "No projects yet")}</div>
        <div class="empty-desc">${isSearching ? "Check spelling or search by a different story title." : (hasFilter ? "Try selecting 'All' or a different filter tab above." : "Create your first story project or load a sample manuscript to get started.")}</div>
        <div style="display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; justify-content: center;">
          ${isSearching ? `<button class="btn btn-secondary" onclick="clearDashboardSearch()">Clear Search</button>` : ''}
          ${hasFilter ? `<button class="btn btn-secondary" onclick="setDashboardFilter('all')">View All Projects</button>` : ''}
          ${!isSearching && !hasFilter ? `
            <button class="btn btn-primary" onclick="openNewProjectModal()">＋ Create Story Project</button>
            <button class="btn btn-secondary" onclick="loadSampleStoryIntoProject()">📖 Load Sample</button>
          ` : ''}
        </div>
      </div>
    `;
    return;
  }

  // 7. Render project cards
  filtered.forEach(p => {
    const card = document.createElement("div");
    card.className = "project-card";

    const total = p.block_count || 0;
    const rendered = p.rendered_count || 0;
    const percent = total > 0 ? Math.min(100, Math.round((rendered / total) * 100)) : 0;

    let statusBadgeClass = "draft";
    let statusText = "Draft";
    if (total > 0 && rendered >= total) {
      statusBadgeClass = "ready";
      statusText = "✓ Ready";
    } else if (rendered > 0) {
      statusBadgeClass = "progress";
      statusText = `⚡ ${percent}%`;
    }

    const durationStr = formatAudioDuration(p.total_duration);
    const dateStr = formatTimeAgo(p.updated_at ? p.updated_at * 1000 : null);
    const studioUrl = `/studio?project=${encodeURIComponent(p.id)}`;
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

    card.innerHTML = `
      <div class="project-card-header">
        <div class="project-card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
        <span class="proj-status-badge ${statusBadgeClass}">${statusText}</span>
      </div>

      <div class="project-render-bar" title="${rendered} of ${total} sentences rendered (${percent}%)">
        <div class="project-render-fill" style="width: ${percent}%;"></div>
      </div>

      <div class="project-meta-grid">
        <div class="project-meta-pill"><span>📝</span> <strong>${total}</strong> <span>sentences</span> <span style="opacity: 0.6; font-size: 10.5px;">(${rendered}✓)</span></div>
        <div class="project-meta-pill pill-duration"><span>⏱️</span> <strong>${durationStr}</strong></div>
        <div class="project-meta-pill"><span>🕒</span> <span>${dateStr}</span></div>
      </div>

      <div class="project-voices-wrap">
        <span class="meta-label" style="font-size: 11px; color: var(--text-subtle); margin-right: 4px;">Cast:</span>
        <div class="project-voices-pills">${voicePillsHtml}</div>
      </div>

      <div class="project-card-footer">
        <div class="footer-left-actions">
          <a href="${studioUrl}" target="_blank" class="open-proj-btn">Open in Studio ↗</a>
          ${p.preview_audio ? `<button class="preview-audio-btn ${isPlaying ? 'playing' : ''}" title="Quick audition of rendered dialogue">${isPlaying ? '⏸ Pause' : '▶ Preview'}</button>` : `<button class="preview-audio-btn disabled" disabled title="Render sentences in studio to audition audio">🔇 No Audio</button>`}
        </div>
        <div class="footer-right-actions">
          <button class="card-icon-btn copy-to-other-btn" title="⚡ Copy to Kokoro Studio">⚡</button>
          <button class="card-icon-btn duplicate-proj-btn" title="Duplicate project">📋</button>
          <button class="card-icon-btn rename-proj-btn" title="Rename project">✏️</button>
          <button class="card-icon-btn delete-proj-btn" title="Delete project">🗑️</button>
        </div>
      </div>
    `;

    // Click card body to open in studio (unless clicked on a button or link)
    card.addEventListener("click", (e) => {
      if (e.target.closest(".open-proj-btn") ||
          e.target.closest(".preview-audio-btn") ||
          e.target.closest(".copy-to-other-btn") ||
          e.target.closest(".duplicate-proj-btn") ||
          e.target.closest(".rename-proj-btn") ||
          e.target.closest(".delete-proj-btn")) {
        return;
      }
      window.open(studioUrl, "_blank");
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

    grid.appendChild(card);
  });
}

// ---------------- VIEW 2: STUDIO RENDERING ---------------- //

function renderStudio() {
  if (!state.currentProject) return;

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

function getCharacterById(charId) {
  if (!charId || !state.savedCharacters) return null;
  return state.savedCharacters.find(c => c.id === charId) || null;
}

function renderBlocks() {
  const container = document.getElementById("story-container");
  const canvas = document.querySelector(".editor-canvas");
  const savedScrollTop = canvas ? canvas.scrollTop : 0;
  container.innerHTML = "";

  state.currentProject.blocks.forEach((block, idx) => {
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
    const isReady = !isProcessing && !!(block.cachedAudioUrl && block.cachedSig === currentSig);
    const isPlaying = state.currentlyPlayingBlockIdx === idx && !state.storyAudioPlayer.paused;
    const isSelected = state.selectedBlockIndices.has(idx);
    const isActive = state.activeBlockIndex === idx;

    row.className = `block-row ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${isReady ? "ready" : ""} ${isPlaying ? "playing" : ""} ${isProcessing ? "processing" : ""}`;
    row.dataset.index = idx;

    const durText = isProcessing ? "⏳ Synthesizing..." : (isReady ? (block.duration ? `● ${block.duration.toFixed(1)}s` : "● Ready") : "Draft (click ▶ to render)");

    const char = getCharacterById(block.character_id);
    const blockColor = (char && char.color) ? char.color : voice.color;
    const blockBadge = (char && char.badge) ? char.badge : (voice.badge || voice.id.slice(0, 2).toUpperCase());
    const isCustom = Boolean(char && block.is_custom_edited);
    const blockTitle = char
      ? `Character: ${char.name} (${voice.name})${isCustom ? ' • Customized for this sentence' : ' • Synced'}`
      : `Voice: ${voice.name} (Click to change)`;

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
      <div class="block-content-col" style="flex-direction: column; align-items: stretch; justify-content: center; gap: 2px;">
        ${block.emotion_tag ? `<span class="block-emotion-pill" onclick="handleFocusEmotionInput(${idx})" title="Fish S2 Pro Emotion: ${escapeHtml(block.emotion_tag)}">${escapeHtml(block.emotion_tag)}</span>` : ''}
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
      delete block.cachedAudioUrl;
      delete block.cachedSig;
      delete block.duration;
      row.classList.remove("ready", "playing");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      autoResizeTextarea(textarea);
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

  if (btnVoice) {
    btnVoice.style.display = count > 1 ? "inline-flex" : "none";
    btnVoice.textContent = `👥 Voice (${count})`;
  }
  if (btnMerge) {
    btnMerge.style.display = count > 1 ? "inline-flex" : "none";
    btnMerge.textContent = `🔗 Merge (${count})`;
  }
  if (btnRender) {
    btnRender.style.display = count > 1 ? "inline-flex" : "none";
    btnRender.textContent = `⚡ Render (${count})`;
  }
  if (btnDelete) {
    btnDelete.style.display = count > 1 ? "inline-flex" : "none";
    btnDelete.textContent = `🗑️ Delete (${count})`;
  }

  const btnExport = document.getElementById("btn-bulk-export");
  if (btnExport) {
    if (count === 1) {
      btnExport.style.display = "inline-flex";
      btnExport.innerHTML = `🎵 Export WAV`;
      btnExport.title = "Export selected sentence as WAV audio file";
    } else if (count > 1) {
      btnExport.style.display = "inline-flex";
      btnExport.innerHTML = `📦 Export ZIP (${count})`;
      btnExport.title = `Export ${count} selected sentences into a ZIP archive`;
    } else {
      btnExport.style.display = "none";
    }
  }

  const btnCustomToggle = document.getElementById("btn-bulk-custom-toggle");
  if (btnCustomToggle) {
    if (count > 1) {
      btnCustomToggle.style.display = "inline-flex";
      btnCustomToggle.textContent = `🔄 Custom/Sync (${count})`;
    } else {
      btnCustomToggle.style.display = "none";
    }
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

  updateDefaultVoiceButtonUI();
}

function updateDefaultVoiceButtonUI() {
  const btn = document.getElementById("btn-make-default-voice");
  const indicator = document.getElementById("default-voice-indicator");
  if (!state.currentProject || !state.currentProject.blocks || state.currentProject.blocks.length === 0) return;
  
  const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
    ? state.activeBlockIndex
    : 0;
  const activeBlock = state.currentProject.blocks[activeIdx];
  if (!activeBlock) return;

  const defVoiceId = state.currentProject.default_voice || "blend_fenrir_onyx";
  const isDefault = (activeBlock.voice_id === defVoiceId);

  if (indicator) {
    indicator.textContent = isDefault ? "👑 Default Narrator" : "";
  }

  if (btn) {
    if (isDefault) {
      btn.textContent = "✓ Active Default Narrator";
      btn.classList.add("primary");
      btn.title = "This voice is currently the story's default narrator";
    } else {
      btn.textContent = "★ Make Default Story Narrator";
      btn.classList.remove("primary");
      btn.title = "Make this voice the default narrator and apply across all sentences";
    }
  }
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
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;
    changedCount++;
  });

  renderStudio();
  debouncedSave();
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
        max_chars: 35,
        max_words: 5
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

  if (spokenTargets.length <= 1) {
    showToast("ℹ️ Use checkboxes or Select All to select multiple sentences to apply this voice to.");
    return;
  }

  const voice = getVoiceById(activeBlock.voice_id);
  recordHistory(`Apply Voice to Selected (${spokenTargets.length})`);

  let changedCount = 0;
  let preservedCount = 0;

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    const hasSameVoice = (b.voice_id === activeBlock.voice_id);
    const hasSameBlend = JSON.stringify(b.blend_weights || null) === JSON.stringify(activeBlock.blend_weights || null);

    if (hasSameVoice && hasSameBlend) {
      // Same voice & blend: preserve existing audio cache completely!
      preservedCount++;
      return;
    }

    b.voice_id = activeBlock.voice_id;
    if (activeBlock.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(activeBlock.blend_weights));
    } else {
      delete b.blend_weights;
    }
    if (activeBlock.character_id) {
      b.character_id = activeBlock.character_id;
      b.is_custom_edited = Boolean(activeBlock.is_custom_edited);
    } else if (b.character_id) {
      b.is_custom_edited = true;
    }
    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;
    changedCount++;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      const avatar = row.querySelector(".block-avatar");
      if (avatar) {
        avatar.style.backgroundColor = voice.color;
        avatar.textContent = voice.badge || voice.id.slice(0, 2).toUpperCase();
      }
    }
  });

  renderStudio();
  debouncedSave();
  if (changedCount > 0) {
    showToast(`🎭 Applied voice "${voice.name}" (${changedCount} updated, ${preservedCount} preserved)!`);
  } else {
    showToast(`🎭 All selected sentences already have "${voice.name}" (${preservedCount} preserved)!`);
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

    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;
    changedCount++;
  });

  renderStudio();
  debouncedSave();
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

  // 1. If current project object from server has a characters array, use it
  if (Array.isArray(state.currentProject.characters) && state.currentProject.characters.length > 0) {
    state.savedCharacters = state.currentProject.characters;
    try {
      localStorage.setItem(`kss_chars_${projId}`, JSON.stringify(state.savedCharacters));
    } catch (e) {}
    renderSavedCharactersList();
    return;
  }

  // 2. Check project-specific localStorage cache
  try {
    const rawProj = localStorage.getItem(`kss_chars_${projId}`);
    if (rawProj) {
      const parsedProj = JSON.parse(rawProj);
      if (Array.isArray(parsedProj) && parsedProj.length > 0) {
        state.savedCharacters = parsedProj;
        state.currentProject.characters = state.savedCharacters;
        debouncedSave();
        renderSavedCharactersList();
        return;
      }
    }
  } catch (e) {
    console.warn("Could not load project-specific characters:", e);
  }

  // 3. One-time migration for existing project that had legacy global characters
  // If proj_248b7cf9 is opened and has no characters, migrate legacy kss_saved_characters
  if (projId === "proj_248b7cf9") {
    try {
      const legacyRaw = localStorage.getItem("kss_saved_characters");
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        if (Array.isArray(legacy) && legacy.length > 0) {
          state.savedCharacters = legacy;
          state.currentProject.characters = state.savedCharacters;
          saveSavedCharactersToStorage();
          renderSavedCharactersList();
          return;
        }
      }
    } catch (e) {}
  }

  // 4. Any other project starts with its own clean empty character set
  state.savedCharacters = [];
  state.currentProject.characters = [];
  renderSavedCharactersList();
}

function saveSavedCharactersToStorage() {
  if (!state.savedCharacters) state.savedCharacters = [];

  if (state.currentProject) {
    state.currentProject.characters = state.savedCharacters;
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

  const total = state.savedCharacters ? state.savedCharacters.length : 0;
  if (countBadge) countBadge.textContent = total;
  if (drawerBadge) {
    drawerBadge.textContent = total;
    drawerBadge.style.display = total > 0 ? "inline-flex" : "none";
  }

  if (!container) return;
  container.innerHTML = "";

  if (total === 0) {
    container.innerHTML = `
      <div class="saved-char-empty">
        No character voices in this project cast.<br>
        <span style="font-size: 11px; opacity: 0.75;">Click "＋ Save Current" to add active voice or click "📥 Import" to copy from another project.</span>
      </div>
    `;
    return;
  }

  const activeBlock = (state.currentProject?.blocks && typeof state.activeBlockIndex === "number")
    ? state.currentProject.blocks[state.activeBlockIndex]
    : null;

  state.savedCharacters.forEach(char => {
    const card = document.createElement("div");
    const voiceObj = getVoiceById(char.voice_id);
    const isMatching = Boolean(
      activeBlock &&
      activeBlock.voice_id === char.voice_id &&
      (activeBlock.fx_filter || (activeBlock.radio_fx ? "radio" : "none")) === char.fx_filter
    );

    card.className = `saved-char-card ${isMatching ? "active-char" : ""}`;
    card.dataset.charId = char.id;
    card.title = `Click to apply ${char.name} to selected sentence(s)`;

    const badgeText = char.badge || char.name.slice(0, 2).toUpperCase();
    const filterTag = (char.fx_filter && char.fx_filter !== "none")
      ? `<span class="saved-char-filter-pill">${char.fx_filter.toUpperCase()}</span>`
      : "";

    const speedStr = `${Number(char.speed || 0.90).toFixed(2)}x`;
    const pitchStr = char.pitch_shift ? ` • ${(char.pitch_shift > 0 ? '+' : '') + Number(char.pitch_shift).toFixed(1)}st` : "";
    const filterStr = (char.fx_filter && char.fx_filter !== "none") ? ` • ${char.fx_filter}` : "";

    card.innerHTML = `
      <div class="saved-char-left">
        <div class="saved-char-avatar" style="background-color: ${char.color || '#6366f1'}">
          ${escapeHtml(badgeText)}
        </div>
        <div class="saved-char-info">
          <div class="saved-char-name-row">
            <span class="saved-char-name">${escapeHtml(char.name)}</span>
            ${filterTag}
          </div>
          <span class="saved-char-details">${escapeHtml(voiceObj.name)} • ${speedStr}${pitchStr}${filterStr}</span>
        </div>
      </div>
      <div class="saved-char-actions">
        <button type="button" class="saved-char-btn" title="Apply character to selected sentence(s)">Apply</button>
        <button type="button" class="saved-char-icon-btn" title="Update character with current panel settings" data-action="update">🔄</button>
        <button type="button" class="saved-char-icon-btn" title="Edit character voice & settings" data-action="edit">✏️</button>
        <button type="button" class="saved-char-icon-btn danger" title="Delete character" data-action="delete">✕</button>
      </div>
    `;

    // Click on name allows quick rename via double-click
    const nameEl = card.querySelector(".saved-char-name");
    if (nameEl) {
      nameEl.title = "Double-click to quick rename";
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        renameCharacter(char.id);
      });
    }

    card.addEventListener("click", () => {
      applyCharacterToSelected(char.id);
    });

    const updateBtn = card.querySelector('[data-action="update"]');
    if (updateBtn) {
      updateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        updateCharacterWithCurrent(char.id);
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

function populateCharModalVoiceSelect() {
  const select = document.getElementById("char-modal-voice-select");
  if (!select || !state.voices || state.voices.length === 0) return;

  const html = state.voices.map(v => {
    return `<option value="${v.id}">${v.flag || "🎙️"} ${v.name} (${v.accent} ${v.gender}) - ${v.timbre || 'Voice'}</option>`;
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
  if (nameEl) nameEl.textContent = voice.name;
  if (subEl) subEl.textContent = voice.timbre ? `${voice.gender.toUpperCase()} • ${voice.timbre}` : voice.gender.toUpperCase();
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
  populateCharModalVoiceSelect();

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
  populateCharModalVoiceSelect();

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

    char.name = charName;
    char.voice_id = voiceId;
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

    const voiceObj = getVoiceById(voiceId);
    if (voiceObj.blend_weights) {
      char.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    } else {
      delete char.blend_weights;
    }

    saveSavedCharactersToStorage();
    const overwriteCheckbox = document.getElementById("char-modal-overwrite-custom");
    const shouldOverwrite = Boolean(overwriteCheckbox && overwriteCheckbox.checked);
    const syncRes = syncCharacterToBlocks(char.id, shouldOverwrite);
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
    const newChar = {
      id: "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000),
      name: charName,
      voice_id: voiceId,
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

    const voiceObj = getVoiceById(voiceId);
    if (voiceObj.blend_weights) {
      newChar.blend_weights = JSON.parse(JSON.stringify(voiceObj.blend_weights));
    }

    if (!state.savedCharacters) state.savedCharacters = [];
    state.savedCharacters.push(newChar);
    saveSavedCharactersToStorage();

    // Assign this character to active sentence if unassigned
    const activeIdx = (typeof state.activeBlockIndex === "number" && state.activeBlockIndex >= 0 && state.activeBlockIndex < state.currentProject.blocks.length)
      ? state.activeBlockIndex
      : 0;
    const activeBlock = state.currentProject.blocks[activeIdx];
    if (activeBlock && !activeBlock.character_id && activeBlock.type !== "heading") {
      activeBlock.character_id = newChar.id;
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
  if (!char || !state.currentProject || !state.currentProject.blocks) return { updatedCount: 0, skippedCustomCount: 0 };

  let updatedCount = 0;
  let skippedCustomCount = 0;

  state.currentProject.blocks.forEach((b, idx) => {
    if (b.character_id === charId) {
      if (b.is_custom_edited === true && !overwriteCustom) {
        skippedCustomCount++;
        return; // PRESERVE CUSTOM EDITED SENTENCES!
      }

      if (overwriteCustom) {
        b.is_custom_edited = false;
      }

      b.voice_id = char.voice_id;
      if (char.blend_weights) {
        b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
      } else {
        delete b.blend_weights;
      }
      b.speed = char.speed;
      b.pause_after = char.pause_after;
      b.pitch_shift = char.pitch_shift;
      b.warmth = char.warmth;
      b.clarity = char.clarity;
      b.reverb = char.reverb;
      b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
      b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

      delete b.cachedAudioUrl;
      delete b.cachedSig;
      delete b.duration;

      const row = document.querySelector(`[data-index="${idx}"]`);
      if (row) {
        row.classList.remove("ready", "playing");
        const timeText = row.querySelector(".scrubber-time");
        if (timeText) timeText.textContent = "Draft (click ▶ to render)";
        const avatar = row.querySelector(".block-avatar");
        if (avatar) {
          avatar.style.backgroundColor = char.color || getVoiceById(char.voice_id).color;
          avatar.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
          if (overwriteCustom) {
            const dot = avatar.querySelector(".custom-tweak-dot");
            if (dot) dot.remove();
          }
        }
      }
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    renderStudio();
    debouncedSave();
  }
  return { updatedCount, skippedCustomCount };
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

  spokenTargets.forEach(idx => {
    const b = state.currentProject.blocks[idx];
    if (!b) return;

    b.character_id = char.id;
    b.is_custom_edited = false;
    b.voice_id = char.voice_id;
    if (char.blend_weights) {
      b.blend_weights = JSON.parse(JSON.stringify(char.blend_weights));
    } else {
      delete b.blend_weights;
    }

    b.speed = char.speed;
    b.gain = char.gain !== undefined ? char.gain : 1.0;
    b.pause_after = char.pause_after !== undefined ? char.pause_after : 0.6;
    b.pitch_shift = char.pitch_shift;
    b.warmth = char.warmth;
    b.clarity = char.clarity;
    b.reverb = char.reverb;
    b.fx_filter = char.fx_filter || (char.radio_fx ? "radio" : "none");
    b.radio_fx = Boolean(char.radio_fx || char.fx_filter === "radio");

    delete b.cachedAudioUrl;
    delete b.cachedSig;
    delete b.duration;

    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready", "playing");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
      const avatar = row.querySelector(".block-avatar");
      if (avatar) {
        avatar.style.backgroundColor = char.color || getVoiceById(char.voice_id).color;
        avatar.textContent = char.badge || char.name.slice(0, 2).toUpperCase();
      }
    }
  });

  renderStudio();
  debouncedSave();
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

  delete b.cachedAudioUrl;
  delete b.cachedSig;
  delete b.duration;

  renderStudio();
  debouncedSave();
  showToast(`↺ Reverted sentence to "${char.name}" character settings!`);
}

function updateActiveCharacterStatusBanner() {
  const banner = document.getElementById("inspector-character-link-banner");
  if (!banner) return;

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
        <button type="button" class="btn btn-secondary" onclick="toggleBlockCustomEdited(false)" style="padding: 3px 8px; font-size: 11px; white-space: nowrap;" title="Change status: mark sentence as Synced so character updates apply to it">🔗 Make Synced</button>
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
    renderSavedCharactersList();
    renderStudio();
    showToast(`✓ Renamed to "${char.name}"`);
  }
}

function deleteCharacter(charId) {
  const char = getCharacterById(charId);
  if (!char) return;
  if (confirm(`Delete character "${char.name}"?`)) {
    state.savedCharacters = state.savedCharacters.filter(c => c.id !== charId);
    saveSavedCharactersToStorage();
    renderSavedCharactersList();
    renderStudio();
    showToast(`🗑️ Deleted character "${char.name}".`);
  }
}

// ---------------- IMPORT CAST FROM OTHER PROJECT ---------------- //

let pendingImportCharacters = [];
let pendingImportProjectTitle = "";

async function handleOpenImportCastModal() {
  const modal = document.getElementById("import-cast-modal");
  if (!modal) return;

  if (!state.currentProject) {
    showToast("⚠️ Open a story project first to import a character cast.");
    return;
  }

  try {
    const res = await fetch("/api/projects?engine=fish_s2");
    if (res.ok) {
      state.projects = await res.json();
    }
  } catch (e) {}

  const otherProjects = (state.projects || []).filter(p => p.id !== state.currentProject.id);
  const select = document.getElementById("import-cast-source-select");
  if (!select) return;

  select.innerHTML = "";

  if (otherProjects.length === 0) {
    select.innerHTML = `<option value="">No other projects available</option>`;
    renderImportCastPreview([]);
    modal.style.display = "flex";
    return;
  }

  otherProjects.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    const charCountText = (p.character_count !== undefined && p.character_count > 0) ? `(${p.character_count} characters)` : "";
    opt.textContent = `${p.title} ${charCountText}`;
    select.appendChild(opt);
  });

  modal.style.display = "flex";
  handleImportSourceProjectChange();
}

function closeImportCastModal() {
  const modal = document.getElementById("import-cast-modal");
  if (modal) modal.style.display = "none";
}

async function handleImportSourceProjectChange() {
  const select = document.getElementById("import-cast-source-select");
  const sourceProjId = select ? select.value : null;
  if (!sourceProjId) {
    renderImportCastPreview([]);
    return;
  }

  try {
    const res = await fetch(`/api/project?id=${encodeURIComponent(sourceProjId)}&t=${Date.now()}`);
    if (!res.ok) throw new Error("Could not fetch project");
    const projData = await res.json();
    pendingImportProjectTitle = projData.title || "Project";
    let chars = Array.isArray(projData.characters) ? projData.characters : [];

    if (chars.length === 0) {
      try {
        const rawLocal = localStorage.getItem(`kss_chars_${sourceProjId}`);
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

function renderImportCastPreview(chars) {
  const listEl = document.getElementById("import-cast-preview-list");
  const confirmBtn = document.getElementById("btn-confirm-import-cast");
  if (!listEl) return;

  listEl.innerHTML = "";
  if (!chars || chars.length === 0) {
    listEl.innerHTML = `<div style="font-size: 11.5px; color: var(--text-muted); text-align: center; padding: 12px;">This project has no saved characters.</div>`;
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }

  if (confirmBtn) confirmBtn.disabled = false;

  chars.forEach(c => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; border: 1px solid rgba(255,255,255,0.05);";
    const badge = c.badge || c.name.slice(0, 2).toUpperCase();
    const filterTag = (c.fx_filter && c.fx_filter !== "none") ? ` [${c.fx_filter.toUpperCase()}]` : "";
    const voiceObj = getVoiceById(c.voice_id);
    row.innerHTML = `
      <div style="background-color: ${c.color || '#6366f1'}; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0;">
        ${escapeHtml(badge)}
      </div>
      <span style="font-weight: 600; color: var(--text-main);">${escapeHtml(c.name)}</span>
      <span style="color: var(--text-muted); font-size: 11px;">(${escapeHtml(voiceObj.name)}${filterTag})</span>
    `;
    listEl.appendChild(row);
  });
}

function confirmImportCast() {
  if (!pendingImportCharacters || pendingImportCharacters.length === 0) {
    showToast("⚠️ No characters to import from selected project.");
    return;
  }

  const mode = document.querySelector('input[name="import-cast-mode"]:checked')?.value || "append";

  if (!state.savedCharacters) state.savedCharacters = [];

  if (mode === "replace") {
    state.savedCharacters = JSON.parse(JSON.stringify(pendingImportCharacters));
  } else {
    const existingIds = new Set(state.savedCharacters.map(c => c.id));
    pendingImportCharacters.forEach(c => {
      const cloned = JSON.parse(JSON.stringify(c));
      if (existingIds.has(cloned.id)) {
        cloned.id = "char_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1000);
      }
      state.savedCharacters.push(cloned);
      existingIds.add(cloned.id);
    });
  }

  saveSavedCharactersToStorage();
  renderSavedCharactersList();
  renderStudio();
  closeImportCastModal();
  showToast(`🎭 Imported ${pendingImportCharacters.length} character(s) from "${pendingImportProjectTitle}"!`);
}

window.handleOpenImportCastModal = handleOpenImportCastModal;
window.closeImportCastModal = closeImportCastModal;
window.handleImportSourceProjectChange = handleImportSourceProjectChange;
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

    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
      if (row) row.classList.add("ready");
      return;
    }

    if (row) {
      row.classList.add("processing");
      row.classList.remove("ready");
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
  const voice = getVoiceById(block.voice_id);

  // Update Character Status Banner
  updateActiveCharacterStatusBanner();

  const char = getCharacterById(block.character_id);
  const cardColor = (char && char.color) ? char.color : (voice.color || "#6366f1");
  const cardBadge = (char && char.badge) ? char.badge : (voice.badge || (voice.id ? voice.id.slice(0, 2).toUpperCase() : "VO"));

  // Inspector voice card
  const avatar = document.getElementById("inspector-voice-avatar");
  if (avatar) {
    avatar.style.backgroundColor = cardColor;
    avatar.textContent = cardBadge;
  }

  const nameEl = document.getElementById("inspector-voice-name");
  if (nameEl) nameEl.textContent = voice.name || "Voice";

  const subEl = document.getElementById("inspector-voice-sub");
  if (subEl) subEl.textContent = `${voice.gender || ''} • ${voice.accent || ''} • ${voice.timbre || ''}`;

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
    const char = getCharacterById(block.character_id);
    const itemColor = (char && char.color) ? char.color : voice.color;
    const charLabel = char ? `${char.name}${block.is_custom_edited ? ' (Custom)' : ''}` : voice.name;
    const item = document.createElement("div");
    const currentSig = getBlockSignature(block);
    const isReady = !!(block.cachedAudioUrl && block.cachedSig === currentSig);
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
    for (const idx of indices) {
      const block = state.currentProject.blocks[idx];
      const audioSource = block?.cachedAudioUrl || block?.audio_url;
      if (!block || !audioSource) continue;

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
          debouncedSave();
          renderTimeline();
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
    }
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

async function playBlockAudio(idx, targetOffset = 0, isAutoContinuation = false) {
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

  const startPlayback = (audioUrl, duration) => {
    if (duration) block.duration = duration;

    // Check if the audio player is ALREADY loaded on this exact URL
    const currentSrcClean = (state.storyAudioPlayer.src || "").split("?")[0];
    const targetSrcClean = new URL(audioUrl, window.location.origin).href.split("?")[0];
    const isSameTrack = (currentSrcClean === targetSrcClean && Boolean(state.storyAudioPlayer.src));

    if (row) {
      row.classList.remove("processing");
    }

    if (!isSameTrack) {
      state.storyAudioPlayer.src = audioUrl;
    }

    if (targetOffset > 0) {
      state.storyAudioPlayer.currentTime = targetOffset;
    } else if (!isSameTrack || state.storyAudioPlayer.ended) {
      state.storyAudioPlayer.currentTime = 0;
    }

    state.isPlayingStory = true;
    state.storyAudioPlayer.play().then(() => {
      updatePlaybackUI(idx, true);
    }).catch(err => {
      console.warn("Audio play prevented:", err);
      updatePlaybackUI(idx, false);
    });

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

  // Cached playback
  if (block.cachedAudioUrl && block.cachedSig === currentSig) {
    startPlayback(block.cachedAudioUrl, block.duration);
    return;
  }

  // Synthesize on demand
  startBlockProgress(idx, { mode: "synthesize" });

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
      block.cachedSig = currentSig;
      block.duration = data.duration;
      debouncedSave();
      renderTimeline();
      stopBlockProgress(idx, true, data.duration);
      startPlayback(data.audio_url, data.duration);
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

  selectBlock(idx, "single");
  delete block.cachedAudioUrl;
  delete block.cachedSig;
  delete block.duration;

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
      block.cachedAudioUrl = data.audio_url;
      block.cachedSig = getBlockSignature(block);
      block.duration = data.duration;
      debouncedSave();
      renderTimeline();
      stopBlockProgress(idx, true, data.duration);
      showToast(`✨ Fresh take generated for Sentence #${idx + 1} (${data.duration.toFixed(1)}s)!`);
      playBlockAudio(idx, 0, false, false);
    } else {
      throw new Error(data.error || "Synthesis failed");
    }
  } catch (err) {
    console.error("Re-render error:", err);
    stopBlockProgress(idx, false);
    showToast("❌ Re-render failed: " + (err.message || err));
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
    const currentSig = getBlockSignature(block);
    if (block.cachedAudioUrl && block.cachedSig === currentSig) {
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
        block.cachedAudioUrl = data.audio_url;
        block.cachedSig = currentSig;
        if (data.duration) block.duration = data.duration;
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

function openVoiceDrawer(targetBlockIdx = null, preferredMode = "fish") {
  state.targetBlockForVoice = targetBlockIdx !== null ? targetBlockIdx : state.activeBlockIndex;
  const drawer = document.getElementById("voice-drawer");
  const win = document.getElementById("voice-drawer-window");
  if (drawer) {
    drawer.classList.add("active");
  }

  // Auto-expand on desktop screens for full Fish Audio Discovery portal layout
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

  switchDrawerMode(preferredMode);
}

function closeVoiceDrawer() {
  const drawer = document.getElementById("voice-drawer");
  if (drawer) {
    drawer.classList.remove("active");
  }
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
  if (tabBtn) tabBtn.classList.add("active");

  // Deactivate all subviews first
  [viewFish, viewBrowse, viewCreate, viewEdit].forEach(v => {
    if (v) {
      v.classList.remove("active");
      v.style.removeProperty("display");
      v.style.removeProperty("flex-direction");
    }
  });

  if (mode === "fish") {
    if (viewFish) viewFish.classList.add("active");
    if (titleEl) titleEl.textContent = "🎙️ Voice Library";
    if (countBadge) countBadge.textContent = "2M+ Voices";
    if (backBtn) backBtn.style.display = "none";
    loadFishLibraryExplore();
  } else if (mode === "browse") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "💾 My Saved Library";
    if (countBadge) countBadge.textContent = `${(state.voices || []).length} Voices`;
    if (backBtn) backBtn.style.display = "none";
    setDrawerFilter("all");
    renderVoiceList();
  } else if (mode === "cast") {
    if (viewBrowse) viewBrowse.classList.add("active");
    if (titleEl) titleEl.textContent = "🎭 Project Cast";
    if (countBadge) countBadge.textContent = `${(state.savedCharacters || []).length} Cast`;
    if (backBtn) backBtn.style.display = "none";
    setDrawerFilter("characters");
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

    const targetIdx = state.targetBlockForVoice !== null && state.targetBlockForVoice !== undefined 
      ? state.targetBlockForVoice 
      : state.activeBlockIndex;

    if (state.currentProject && state.currentProject.blocks && state.currentProject.blocks[targetIdx]) {
      state.currentProject.blocks[targetIdx].voice_id = newVoice.id;
      saveCurrentProjectDebounced();
      renderScriptBlocks();
      updateInspectorForBlock(targetIdx);
    }

    showToast(`⚡ Voice "${newVoice.name}" cloned & assigned to Block #${targetIdx + 1}!`, "success");
    if (btnEl) {
      btnEl.innerHTML = `✓ Active`;
      setTimeout(() => {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerHTML = `⚡ Use Voice`;
        }
      }, 2000);
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

  // Update total count badge
  const countBadge = document.getElementById("drawer-voices-count");

  // Characters tab in Voice Drawer
  if (filter === "characters") {
    const charList = (state.savedCharacters || []).filter(c => {
      if (!query) return true;
      const v = getVoiceById(c.voice_id);
      return c.name.toLowerCase().includes(query) || (v && v.name.toLowerCase().includes(query));
    });

    if (countBadge) countBadge.textContent = `${charList.length} Cast`;

    if (charList.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: var(--text-subtle); padding: 40px;">
          No saved characters match your search.<br>
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

  // 1. Filter Voices
  let list = (state.voices || []).filter(v => {
    const matchQuery = !query || 
      v.name.toLowerCase().includes(query) ||
      (v.timbre && v.timbre.toLowerCase().includes(query)) ||
      (v.accent && v.accent.toLowerCase().includes(query)) ||
      (v.genre && v.genre.some(g => g.toLowerCase().includes(query))) ||
      (v.reference_text && v.reference_text.toLowerCase().includes(query));

    if (!matchQuery) return false;

    if (filter === "famous") {
      return v.id && (v.id.startsWith("voice_") || !v.is_custom_ref);
    }
    if (filter === "library") {
      return v.is_custom || v.is_custom_ref || (v.id && (v.id.startsWith("custom_") || v.id.startsWith("custom_lib_"))) || (v.genre && v.genre.includes("Library"));
    }
    if (filter === "mystery") {
      return (v.genre && (v.genre.includes("Mystery") || v.genre.includes("Horror") || v.genre.includes("Thriller") || v.genre.includes("Narrative") || v.genre.includes("Drama") || v.genre.includes("Cinematic")));
    }
    if (filter === "blends") return v.is_blend === true;
    if (filter === "female") return v.gender === "Female";
    if (filter === "male") return v.gender === "Male";
    if (filter === "american") return v.accent === "American";
    if (filter === "british") return v.accent === "British";
    if (filter === "hindi") return v.accent === "Hindi";
    if (filter === "international") return !["American", "British"].includes(v.accent);

    return true;
  });

  // 2. Sort
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
      return (b.gender === "Female" ? 1 : 0) - (a.gender === "Female" ? 1 : 0);
    }
    if (sort === "male_first") {
      return (b.gender === "Male" ? 1 : 0) - (a.gender === "Male" ? 1 : 0);
    }
    if (sort === "deep_first") {
      const aDeep = a.timbre && (a.timbre.includes("Bass") || a.timbre.includes("Deep") || a.timbre.includes("Baritone"));
      const bDeep = b.timbre && (b.timbre.includes("Bass") || b.timbre.includes("Deep") || b.timbre.includes("Baritone"));
      return (bDeep ? 1 : 0) - (aDeep ? 1 : 0);
    }
    // Recommended famous defaults first
    const aFam = a.id && a.id.startsWith("voice_");
    const bFam = b.id && b.id.startsWith("voice_");
    if (aFam !== bFam) return (bFam ? 1 : 0) - (aFam ? 1 : 0);
    return 0;
  });

  if (countBadge) countBadge.textContent = `${list.length} Voices`;

  if (list.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-subtle); padding: 40px;">No voices match your search or filter.</div>`;
    return;
  }

  list.forEach(v => {
    const card = document.createElement("div");
    card.className = "voice-card";
    const sampleUrl = v.sample_url || (v.reference_audio ? (v.reference_audio.startsWith("/") ? v.reference_audio : "/" + v.reference_audio) : `/api/audio/sample_${v.id}.wav`);
    const isCustomVoice = v.is_custom || v.is_custom_ref || (v.id && (v.id.startsWith("custom_") || v.id.startsWith("custom_lib_")));

    card.innerHTML = `
      <div class="voice-card-left">
        <div class="voice-avatar-badge" style="background-color: ${v.color || '#6366f1'}">
          ${escapeHtml(v.badge || (v.name ? v.name.slice(0, 2).toUpperCase() : 'VO'))}
        </div>
        <div class="voice-info">
          <div class="voice-name">
            ${v.flag || ""} ${escapeHtml(v.name)}
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
        <button class="btn btn-primary assign-voice-btn" title="Use voice">Use</button>
        <button class="icon-btn edit-voice-btn" title="Edit voice metadata">✏️</button>
        ${isCustomVoice ? `<button class="icon-btn delete-btn delete-voice-btn" title="Delete voice from library">🗑️</button>` : ''}
      </div>
    `;

    // Instant Sample Playback
    const previewBtn = card.querySelector(".preview-voice-btn");
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreRenderedSample(sampleUrl, previewBtn);
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

function playPreRenderedSample(sampleUrl, btnEl) {
  // If story is currently playing, pause it so samples don't conflict
  if (state.isPlayingStory || (state.storyAudioPlayer && !state.storyAudioPlayer.paused)) {
    pauseStoryPlayback();
  }

  if (state.playingVoiceSampleId === sampleUrl && state.sampleAudioPlayer && !state.sampleAudioPlayer.paused) {
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

  state.playingVoiceSampleId = sampleUrl;
  btnEl.textContent = "🔊 Playing";
  if (!state.sampleAudioPlayer) {
    state.sampleAudioPlayer = new Audio();
  }
  state.sampleAudioPlayer.src = sampleUrl;
  state.sampleAudioPlayer.play().catch(err => {
    console.warn("Audio play issue, attempting fallback", err);
  });

  state.sampleAudioPlayer.onended = () => {
    btnEl.textContent = "▶ Sample";
    state.playingVoiceSampleId = null;
  };
}

function assignVoiceToTarget(voice) {
  if (!state.currentProject || !state.currentProject.blocks || !state.currentProject.blocks.length) {
    showToast(`✅ Selected voice "${voice.name}" as active default!`);
    state.defaultNarratorVoiceId = voice.id;
    closeVoiceDrawer();
    return;
  }

  recordHistory(`Change Voice: ${voice.name}`);

  const targets = (state.selectedBlockIndices && state.selectedBlockIndices.size > 1)
    ? Array.from(state.selectedBlockIndices)
    : [(state.targetBlockForVoice !== null ? state.targetBlockForVoice : state.activeBlockIndex)];

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.voice_id = voice.id;
    delete block.cachedAudioUrl;
    delete block.cachedSig;
    if (voice.reference_audio) {
      block.reference_audio = voice.reference_audio;
      block.reference_text = voice.reference_text || "";
    }
    if (voice.blend_weights) {
      block.blend_weights = JSON.parse(JSON.stringify(voice.blend_weights));
    } else {
      delete block.blend_weights;
    }
    if (block.character_id) {
      block.is_custom_edited = true;
    }
  });

  renderStudio();
  debouncedSave();
  updateActiveCharacterStatusBanner();
  closeVoiceDrawer();
  showToast(`✓ Applied voice "${voice.name}" to ${targets.length} sentence(s)!`);
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
  populateVoiceSelects();
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
        Ch ${c.chapter_index}: ${escapeHtml(c.title)} (${c.word_count.toLocaleString()} words • ~${c.estimated_minutes} min)
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
    statsTitle.textContent = `${book.title} - Ch ${ch.chapter_index}: ${ch.title}`;
  }
  if (statsDesc) {
    statsDesc.textContent = `~${ch.word_count.toLocaleString()} words • Estimated Audio: ${ch.estimated_minutes} mins (~${Math.ceil(ch.word_count / 35)} speech blocks)`;
  }
}

async function confirmEpubChapterImport() {
  if (!currentEpubData) return;
  const bookSelect = document.getElementById("epub-book-select");
  const bIdx = (bookSelect && currentEpubData.total_books > 1) ? parseInt(bookSelect.value, 10) : 1;
  const chSelect = document.getElementById("epub-chapter-select");
  const chIdx = chSelect ? parseInt(chSelect.value, 10) : 1;
  const voiceSelect = document.getElementById("epub-voice-select");
  const voiceId = voiceSelect ? voiceSelect.value : "voice_stanley_narrator";

  const confirmBtn = document.getElementById("btn-confirm-epub-import");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "⏳ Extracting & Splitting Chapter...";
  }

  try {
    showToast("📚 Processing chapter text & dialogue quotes...");
    const res = await fetch("/api/epub/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        epub_path: currentEpubData.epub_path,
        book_index: bIdx,
        chapter_index: chIdx,
        engine: "fish_s2",
        default_voice: voiceId
      })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to import chapter");

    closeEpubModal();
    showToast(`✓ Created Audiobook Chapter: "${data.title}" with ${data.blocks_count} sentences!`);
    loadProjectsList();

    if (data.url) {
      window.open(data.url, "_blank");
    }
  } catch (err) {
    showToast("❌ Import failed: " + err.message, 5000);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "🚀 Create Chapter Project & Open";
    }
  }
}

let isCreatingProject = false;

async function handleCreateProjectSubmit() {
  if (isCreatingProject) return;

  const submitBtn = document.getElementById("btn-create-project-submit");
  const title = (document.getElementById("new-project-title-input")?.value || "").trim() || "Untitled Project";
  const text = (document.getElementById("new-project-text-input")?.value || "").trim();
  const isFish = (state.activeEngine || "fish_s2") === "fish_s2";
  const fallbackVoice = isFish ? "fish_narrator_dark" : "blend_fenrir_onyx";
  const defaultVoice = document.getElementById("new-project-voice-select")?.value || fallbackVoice;

  isCreatingProject = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "⏳ Creating Project...";
  }

  const defs = getProjectDefaultSettings();
  try {
    const res = await fetch("/api/projects/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        title, 
        text, 
        default_voice: defaultVoice, 
        defaults: defs 
      })
    });

    const newProj = await res.json();
    closeNewProjectModal();
    window.open(`/studio?project=${encodeURIComponent(newProj.id)}`, "_blank");
    loadProjectsList();
  } catch (err) {
    alert("Could not create project: " + err);
  } finally {
    isCreatingProject = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create & Open Studio";
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

function switchCloudTab(tabName) {
  document.querySelectorAll(".cloud-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".cloud-tab-content").forEach(c => c.classList.remove("active"));
  const btn = document.getElementById(`tab-btn-${tabName}`);
  const content = document.getElementById(`tab-content-${tabName}`);
  if (btn) btn.classList.add("active");
  if (content) content.classList.add("active");

  // De-congest footer: on Kaggle tab, Launch/Stop is in the tab itself, so hide redundant Save & Activate
  const saveBtn = document.getElementById("btn-save-colab");
  if (saveBtn) {
    saveBtn.style.display = (tabName === "kaggle") ? "none" : "inline-block";
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
  window.open("https://colab.research.google.com", "_blank");
  switchCloudTab("custom");
  showToast("⚡ Colab opened! Paste the script into a T4 GPU notebook, click Run, then paste the tunnel URL here.", 6500);
}

function handleSwitchToFishProFast() {
  switchCloudTab("fish");
  const keyInput = document.getElementById("fish-api-key-input");
  if (keyInput) {
    keyInput.focus();
    keyInput.select();
  }
  showToast("🔑 Switched to Fish Audio Pro API for instant synthesis with zero queue.");
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
    } else if (data.status === "stopped") {
      clearInterval(kagglePollInterval);
      stopColdstartGuide(false);
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
  const modal = document.getElementById("colab-modal");
  if (!modal) return;
  modal.classList.add("active");
  const testRes = document.getElementById("colab-test-result");
  if (testRes) testRes.innerHTML = "";
  const keyRes = document.getElementById("fish-key-test-result");
  if (keyRes) keyRes.innerHTML = "";
  const urlInput = document.getElementById("colab-url-input");
  if (urlInput) {
    urlInput.value = (state.config && state.config.remote_worker_url) || "";
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
    const colabBanner = document.getElementById("colab-status-banner");

    if (st.status === "ready" && st.tunnel_url) {
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
        const bt = document.getElementById("banner-title");
        if (bt) bt.textContent = "Active Mode: Kaggle GPU (Tesla T4)";
        const bd = document.getElementById("banner-desc");
        if (bd) bd.textContent = `Connected securely to Kaggle worker via ${st.tunnel_url}`;
      }
    } else if (st.status === "queued" || st.status === "booting") {
      if (stepper) stepper.style.display = "flex";
      if (stopBtn) stopBtn.style.display = "inline-block";
      if (launchBtn) {
        launchBtn.disabled = true;
        launchBtn.textContent = st.status === "queued" ? `⏳ Queued (${st.elapsed_seconds || 0}s)...` : `⏳ Booting GPU (${st.elapsed_seconds || 0}s)...`;
      }
      startKagglePolling();
    } else {
      // Stopped or idle
      if (stepper) stepper.style.display = "none";
      if (stopBtn) stopBtn.style.display = "none";
      if (launchBtn) {
        launchBtn.disabled = false;
        launchBtn.textContent = "🚀 Launch Cloud GPU (Tesla T4)";
        launchBtn.style.background = "linear-gradient(135deg, #4f46e5, #7c3aed)";
      }
      if (!state.config?.remote_worker_url || state.remoteWorkerHealthy === false) {
        if (colabBanner) {
          if (state.config?.remote_worker_url && state.remoteWorkerHealthy === false) {
            colabBanner.className = "colab-status-banner stopped";
            const bt = document.getElementById("banner-title");
            if (bt) bt.textContent = "⚠️ Mode: Cloud GPU Stopped / Offline 🔴";
            const bd = document.getElementById("banner-desc");
            if (bd) bd.textContent = `Remote worker at ${state.config.remote_worker_url} stopped or is unreachable. Click 'Launch Cloud GPU' to start a new session.`;
          } else {
            colabBanner.className = "colab-status-banner offline";
            const bt = document.getElementById("banner-title");
            if (bt) bt.textContent = "Current Mode: Local CPU Engine";
            const bd = document.getElementById("banner-desc");
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
  const url = (urlInput?.value || "").trim();
  const apiKeyInput = document.getElementById("fish-api-key-input");
  const apiKey = (apiKeyInput?.value || "").trim();

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remote_worker_url: url,
        fish_api_key: apiKey,
        active_engine: state.activeEngine || "fish_s2"
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
    const apiKeyInput = document.getElementById("fish-api-key-input");
    if (apiKeyInput) apiKeyInput.value = "";
    const testRes = document.getElementById("colab-test-result");
    if (testRes) testRes.innerHTML = "";
    closeColabModal();
    showToast("⚡ Remote worker disconnected. Switched to Local CPU.");
  } catch (err) {
    showToast("⚠️ Failed to disconnect: " + err.message, 5000);
  }
}

async function handleCopyColabScript(engineChoice = "fish_s2") {
  try {
    const res = await fetch(`/api/colab_script?engine=fish_s2`);
    const scriptText = await res.text();
    await navigator.clipboard.writeText(scriptText);
    showToast(`📋 Copied 1-Click Fish Audio S2 Pro Worker Script!`);
  } catch (err) {
    alert("Copy failed: " + err);
  }
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

function applyEmotionTagToActiveBlocks(tag) {
  if (!state.currentProject || !state.currentProject.blocks) return;
  const targets = state.selectedBlockIndices && state.selectedBlockIndices.size > 0
    ? state.selectedBlockIndices
    : new Set([state.activeBlockIndex]);

  targets.forEach(idx => {
    const block = state.currentProject.blocks[idx];
    if (!block) return;
    block.emotion_tag = tag;
    delete block.cachedAudioUrl;
    delete block.cachedSig;
    const row = document.querySelector(`[data-index="${idx}"]`);
    if (row) {
      row.classList.remove("ready");
      const timeText = row.querySelector(".scrubber-time");
      if (timeText) timeText.textContent = "Draft (click ▶ to render)";
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
  showToast("🎬 Converted to non-spoken Scene Heading!");
}

// ---------------- GLOBAL WINDOW EXPORTS FOR INLINE ONCLICK ---------------- //
window.toggleSelectAll = toggleSelectAll;
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
window.handleApplySettingsToSelected = handleApplySettingsToSelected;
window.handleOpenSaveCharacterModal = handleOpenSaveCharacterModal;
window.closeSaveCharacterModal = closeSaveCharacterModal;
window.confirmSaveCharacter = confirmSaveCharacter;
window.applyCharacterToSelected = applyCharacterToSelected;
window.updateCharacterWithCurrent = updateCharacterWithCurrent;
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

  // Update tabs & rail buttons
  ["audio", "cast", "fx"].forEach(tab => {
    const railBtn = document.getElementById(`rail-tab-${tab}`);
    if (railBtn) railBtn.classList.toggle("active", tab === tabName);

    const tabPill = document.getElementById(`tab-btn-${tab}`);
    if (tabPill) tabPill.classList.toggle("active", tab === tabName);

    const pane = document.getElementById(`inspector-tab-pane-${tab}`);
    if (pane) pane.classList.toggle("active", tab === tabName);
  });
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
window.handleCopyColabScript = handleCopyColabScript;
window.handleQuickEmotionClick = handleQuickEmotionClick;
window.clearBlockEmotionTag = clearBlockEmotionTag;
window.handleEmotionTagInput = handleEmotionTagInput;
window.handleFocusEmotionInput = handleFocusEmotionInput;
window.handleReferenceVoiceFileUpload = handleReferenceVoiceFileUpload;
window.handleTestFishKey = handleTestFishKey;
window.handleClearTunnelInput = handleClearTunnelInput;
window.handleClearApiKeyInput = handleClearApiKeyInput;




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
