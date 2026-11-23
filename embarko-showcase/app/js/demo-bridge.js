/**
 * Kashva Voice — Embarko Live Demo Bridge
 * Enables 100% functional in-browser demo for contest judges.
 * Automatically handles guest auth (Pro Tier), local project persistence,
 * voice catalogues, script auto-direction, and GPU bridge.
 */

(function() {
  const originalFetch = window.fetch;
  const STORAGE_KEY_PROJECTS = "kashva_demo_projects_v2";
  const STORAGE_KEY_CONFIG = "kashva_demo_config_v2";

  // Pre-load demo voices and default project
  let cachedFishVoices = null;
  let cachedKokoroVoices = null;
  let defaultProject = null;

  async function loadInitialData() {
    try {
      const fetchJson = async (filename) => {
        const candidates = [`demo-data/${filename}`, `/app/demo-data/${filename}`, `/studio/demo-data/${filename}`];
        for (const url of candidates) {
          try {
            const res = await originalFetch(url);
            if (res.ok) return await res.json();
          } catch (e) {}
        }
        return null;
      };

      const [fv, kv, dp] = await Promise.all([
        fetchJson("fish_voices.json").then(r => r || []),
        fetchJson("kokoro_voices.json").then(r => r || []),
        fetchJson("default_project.json")
      ]);
      cachedFishVoices = fv;
      cachedKokoroVoices = kv;
      defaultProject = dp;

      // Seed local storage with default project if empty
      if (!localStorage.getItem(STORAGE_KEY_PROJECTS) && defaultProject) {
        localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify([defaultProject]));
      }
    } catch (e) {
      console.warn("[DemoBridge] Error loading initial demo data:", e);
    }
  }
  loadInitialData();

  function getStoredProjects() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_PROJECTS);
      if (data) return JSON.parse(data);
    } catch (e) {}
    return defaultProject ? [defaultProject] : [];
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
    const urlStr = typeof resource === "string" ? resource : resource.url;
    const method = (init.method || "GET").toUpperCase();

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
        if (!cachedKokoroVoices) {
          cachedKokoroVoices = await originalFetch("/studio/demo-data/kokoro_voices.json").then(r => r.json()).catch(() => []);
        }
        return jsonResponse(cachedKokoroVoices || []);
      } else {
        if (!cachedFishVoices) {
          cachedFishVoices = await originalFetch("/studio/demo-data/fish_voices.json").then(r => r.json()).catch(() => []);
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
      const summaries = projs.map(p => ({
        id: p.id,
        title: p.title || "Untitled Drama",
        engine: p.engine || "fish_s2",
        updated_at: p.updated_at || Date.now(),
        block_count: (p.blocks || []).length,
        character_count: (p.characters || []).length
      }));
      return jsonResponse(summaries);
    }

    // 6. Single Project GET
    if (urlStr.startsWith("/api/project?") || urlStr.startsWith("/api/project/")) {
      const url = new URL(urlStr, window.location.origin);
      const id = url.searchParams.get("id");
      const projs = getStoredProjects();
      const p = projs.find(x => x.id === id) || projs[0] || defaultProject;
      if (p) return jsonResponse(p);
      return jsonResponse({ error: "Project not found" }, 404);
    }

    // 7. Project Save (POST)
    if (urlStr === "/api/project" && method === "POST") {
      try {
        const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
        const projs = getStoredProjects();
        const existingIdx = projs.findIndex(x => x.id === body.id);
        if (existingIdx >= 0) {
          projs[existingIdx] = { ...projs[existingIdx], ...body, updated_at: Date.now() };
        } else {
          projs.unshift({ ...body, updated_at: Date.now() });
        }
        saveStoredProjects(projs);
        return jsonResponse({ ok: true, id: body.id });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // 8. Folders (Stub)
    if (urlStr.startsWith("/api/folders")) {
      return jsonResponse([]);
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
      // In static demo mode, prevent network crash for missing backend endpoints
      if (urlStr.startsWith("/api/")) {
        console.warn(`[DemoBridge] Handled unmocked API: ${urlStr}`);
        return jsonResponse({ ok: true });
      }
      throw err;
    }
  };

  console.log("🎬 Kashva Voice Demo Bridge active — Pro Tier enabled for Contest Judges!");
})();
