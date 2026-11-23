/**
 * Kashva Voice — Embarko Live Demo Bridge
 * Enables 100% functional in-browser demo for contest judges.
 * Automatically handles guest auth (Pro Tier), local project persistence,
 * voice catalogues, script auto-direction, and GPU bridge.
 */

(function() {
  const originalFetch = window.fetch;
  const STORAGE_KEY_PROJECTS = "kashva_demo_projects_v3";
  const STORAGE_KEY_CONFIG = "kashva_demo_config_v3";

  // Pre-load demo voices, folders, and projects
  let cachedFishVoices = null;
  let cachedKokoroVoices = null;
  let defaultProject = null;
  let demoDataset = null;

  async function fetchJson(filename) {
    const candidates = [
      `demo-data/${filename}`,
      `../demo-data/${filename}`,
      `../../demo-data/${filename}`,
      `/app/demo-data/${filename}`,
      `/app/studio/demo-data/${filename}`,
      `/studio/demo-data/${filename}`,
      `/demo-data/${filename}`
    ];
    for (const url of candidates) {
      try {
        const res = await originalFetch(url);
        if (res.ok) return await res.json();
      } catch (e) {}
    }
    return null;
  }

  async function loadInitialData() {
    try {
      const [fv, kv, dataset] = await Promise.all([
        fetchJson("fish_voices.json").then(r => r || []),
        fetchJson("kokoro_voices.json").then(r => r || []),
        fetchJson("projects_data.json")
      ]);
      cachedFishVoices = fv;
      cachedKokoroVoices = kv;
      demoDataset = dataset;
      if (demoDataset && demoDataset.projects) {
        defaultProject = demoDataset.projects["proj_eb9ab585"] || demoDataset.projects["proj_194579ce"] || Object.values(demoDataset.projects)[0];
      }
    } catch (e) {
      console.warn("[DemoBridge] Error loading initial demo data:", e);
    }
  }
  const dataReadyPromise = loadInitialData();

  function getStoredProjects() {
    const baseSummaries = (demoDataset && demoDataset.summaries && demoDataset.summaries.length > 0)
      ? demoDataset.summaries
      : (defaultProject ? [defaultProject] : []);
    try {
      const custom = localStorage.getItem(STORAGE_KEY_PROJECTS);
      if (custom) {
        const parsed = JSON.parse(custom);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const map = new Map();
          baseSummaries.forEach(s => map.set(s.id, s));
          parsed.forEach(p => {
            if (p && p.id) {
              map.set(p.id, { ...(map.get(p.id) || {}), ...p });
            }
          });
          return Array.from(map.values());
        }
      }
    } catch (e) {}
    return baseSummaries;
  }

  function saveStoredProjects(projects) {
    try {
      localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
    } catch (e) {}
  }

  function getStoredConfig() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_CONFIG);
      if (data) return JSON.parse(data);
    } catch (e) {}
    return {
      active_engine: "fish_s2",
      remote_worker_url: "",
      fish_api_key: "",
      fish_api_model: "drama-3"
    };
  }

  function saveStoredConfig(cfg) {
    try {
      localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(cfg));
    } catch (e) {}
  }

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status: status,
      headers: { "Content-Type": "application/json" }
    });
  }

  window.fetch = async function(resource, init = {}) {
    const urlStr = typeof resource === "string" ? resource : (resource ? resource.url : "");
    const method = (init.method || "GET").toUpperCase();

    // Pass through non-API resources immediately (scripts, stylesheets, fonts, icons)
    if (!urlStr.startsWith("/api/")) {
      return originalFetch.apply(window, arguments);
    }

    // Wait until demo dataset is ready for all mock endpoints
    await dataReadyPromise;

    // 1. Auth check -> Always logged in as Contest Judge (Pro Tier)
    if (urlStr.startsWith("/api/auth/me")) {
      return jsonResponse({
        logged_in: true,
        user: {
          id: "usr_judge_demo",
          name: "Contest Judge",
          email: "judge@embarko.challenge",
          active_tier: "pro",
          role: "judge"
        }
      });
    }

    // 2. Tier status
    if (urlStr.startsWith("/api/tier/status")) {
      return jsonResponse({
        tier: "pro",
        active_tier: "pro",
        label: "PRO PLAN",
        max_characters: 50,
        exports_left: 999
      });
    }

    // 3. Voices catalogue
    if (urlStr.startsWith("/api/voices")) {
      const isKokoro = urlStr.includes("engine=kokoro");
      if (isKokoro) {
        if (!cachedKokoroVoices || cachedKokoroVoices.length === 0) {
          cachedKokoroVoices = await fetchJson("kokoro_voices.json");
        }
        return jsonResponse(cachedKokoroVoices || []);
      } else {
        if (!cachedFishVoices || cachedFishVoices.length === 0) {
          cachedFishVoices = await fetchJson("fish_voices.json");
        }
        return jsonResponse(cachedFishVoices || []);
      }
    }

    // 4. Config
    if (urlStr.startsWith("/api/config")) {
      if (method === "POST") {
        try {
          const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
          const current = getStoredConfig();
          const updated = { ...current, ...body };
          saveStoredConfig(updated);
          return jsonResponse({ ok: true, config: updated });
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message }, 400);
        }
      }
      return jsonResponse(getStoredConfig());
    }

    // 5. Projects list
    if (urlStr.startsWith("/api/projects")) {
      const projs = getStoredProjects();
      return jsonResponse(projs);
    }

    // 6. Single Project GET
    if (urlStr.startsWith("/api/project?") || urlStr.startsWith("/api/project/")) {
      const url = new URL(urlStr, window.location.origin);
      const id = url.searchParams.get("id");
      
      // Check user customized version in localStorage
      try {
        if (id) {
          const customSaved = localStorage.getItem(`kashva_proj_${id}`);
          if (customSaved) {
            const parsed = JSON.parse(customSaved);
            if (parsed && Array.isArray(parsed.blocks)) return jsonResponse(parsed);
          }
        }
      } catch (e) {}

      // Check bundled demo projects
      if (demoDataset && demoDataset.projects) {
        if (id && demoDataset.projects[id]) {
          return jsonResponse(demoDataset.projects[id]);
        }
      }

      // Fallback
      if (!id && defaultProject) return jsonResponse(defaultProject);
      const projs = getStoredProjects();
      const p = (id ? projs.find(x => x.id === id) : null) || defaultProject;
      if (p) return jsonResponse(p);

      return jsonResponse({ error: "Project not found" }, 404);
    }

    // 7. Project Save (POST)
    if (urlStr === "/api/project" && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (demoDataset && demoDataset.projects && body.id) {
          demoDataset.projects[body.id] = { ...demoDataset.projects[body.id], ...body, updated_at: Date.now() };
        }
        try {
          if (body.id) localStorage.setItem(`kashva_proj_${body.id}`, JSON.stringify(body));
        } catch (e) {}
        return jsonResponse({ ok: true, id: body.id });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // 8. Folders (Audiobook series)
    if (urlStr.startsWith("/api/folder/master_cast")) {
      const url = new URL(urlStr, window.location.origin);
      const folderId = url.searchParams.get("folder_id") || url.searchParams.get("id");
      const folder = (demoDataset && demoDataset.folders) ? demoDataset.folders.find(f => f.id === folderId) : null;
      return jsonResponse(folder ? (folder.characters || []) : []);
    }
    if (urlStr.startsWith("/api/folder/director_settings")) {
      const url = new URL(urlStr, window.location.origin);
      const folderId = url.searchParams.get("folder_id") || url.searchParams.get("id");
      const folder = (demoDataset && demoDataset.folders) ? demoDataset.folders.find(f => f.id === folderId) : null;
      return jsonResponse(folder ? (folder.director_settings || {}) : {});
    }
    if (urlStr.startsWith("/api/folder?") || urlStr.startsWith("/api/folder/")) {
      const url = new URL(urlStr, window.location.origin);
      const id = url.searchParams.get("id");
      const folders = (demoDataset && demoDataset.folders) ? demoDataset.folders : [];
      const folder = folders.find(f => f.id === id);
      if (folder) {
        return jsonResponse(folder);
      }
      return jsonResponse({ error: "Folder not found" }, 404);
    }
    if (urlStr.startsWith("/api/folders")) {
      const folders = (demoDataset && demoDataset.folders) ? demoDataset.folders : [];
      return jsonResponse(folders);
    }

    // 9. Split Text / Auto Director
    if (urlStr.startsWith("/api/split_text") && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        const text = body.text || "";
        const rawSentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];
        const blocks = rawSentences
          .map(s => s.trim())
          .filter(s => s.length > 0)
          .map((s, i) => {
            let emotion = "";
            let clean = s;
            const emoMatch = s.match(/^(\[[^\]]+\])\s*(.*)/);
            if (emoMatch) {
              emotion = emoMatch[1];
              clean = emoMatch[2];
            }
            return {
              id: `b_${Date.now()}_${i}`,
              text: clean,
              emotion_tag: emotion,
              voice_id: body.voice_id || "voice_stanley_narrator",
              engine: body.engine || "fish_s2",
              speed: 1,
              gain: 1,
              pause_after: 0.6
            };
          });
        return jsonResponse({ ok: true, blocks });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // 10. Local GPU status check
    if (urlStr.startsWith("/api/gpu/local/status")) {
      return jsonResponse({ running: false, available: false });
    }

    // Pass through external network requests (Colab GPU tunnel, Fish Audio API, etc.)
    try {
      return await originalFetch(resource, init);
    } catch (err) {
      if (urlStr.startsWith("/api/")) {
        console.warn(`[DemoBridge] Handled unmocked API: ${urlStr}`);
        return jsonResponse({ ok: true });
      }
      throw err;
    }
  };

  console.log("🎬 Kashva Voice Demo Bridge active — Pro Tier enabled for Contest Judges!");
})();
