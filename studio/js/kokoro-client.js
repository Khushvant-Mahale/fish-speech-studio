/**
 * Kokoro Client-Side In-Browser Synthesis Engine
 * Uses kokoro-js (ONNX Runtime Web / WebGPU / WASM) to run Kokoro 82M
 * directly on the client's device with $0 server CPU cost and 0 latency.
 */

let kokoroInstance = null;
let modelLoadingPromise = null;
let isModelReady = false;
let clientKokoroEnabled = localStorage.getItem("use_client_kokoro") === "true";

export function isClientKokoroEnabled() {
  return clientKokoroEnabled && isModelReady;
}

export function isModelLoaded() {
  return isModelReady;
}

export function setClientKokoroEnabled(enabled) {
  clientKokoroEnabled = Boolean(enabled);
  localStorage.setItem("use_client_kokoro", clientKokoroEnabled ? "true" : "false");
}

export async function checkDeviceCapabilities() {
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  let webgpuAdapter = null;
  if (hasWebGPU) {
    try {
      webgpuAdapter = await navigator.gpu.requestAdapter();
    } catch (e) {
      console.warn("[KokoroClient] WebGPU check failed:", e);
    }
  }
  return {
    hasWebGPU: Boolean(webgpuAdapter),
    hasWASM: typeof WebAssembly !== "undefined",
    recommendedMode: webgpuAdapter ? "webgpu" : "wasm",
    deviceType: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop"
  };
}

/**
 * Initializes and caches the Kokoro 82M model in browser CacheStorage.
 */
export async function initKokoroModel(onProgress = null) {
  if (isModelReady && kokoroInstance) {
    return kokoroInstance;
  }
  if (modelLoadingPromise) {
    return modelLoadingPromise;
  }

  modelLoadingPromise = (async () => {
    try {
      const caps = await checkDeviceCapabilities();
      console.log(`[KokoroClient] Initializing Kokoro-82M on ${caps.recommendedMode.toUpperCase()}...`);

      // Dynamically import kokoro-js from CDN
      const { KokoroTTS } = await import("https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js");

      // Load quantized 80MB model with cache
      kokoroInstance = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: caps.hasWebGPU ? "fp32" : "q8",
        device: caps.hasWebGPU ? "webgpu" : "wasm",
        progress_callback: (p) => {
          if (typeof onProgress === "function") {
            onProgress(p);
          }
        }
      });

      isModelReady = true;
      console.log("[KokoroClient] Kokoro-82M is ready for client synthesis!");
      return kokoroInstance;
    } catch (err) {
      console.error("[KokoroClient] Failed to load in-browser Kokoro model:", err);
      kokoroInstance = null;
      isModelReady = false;
      throw err;
    } finally {
      modelLoadingPromise = null;
    }
  })();

  return modelLoadingPromise;
}

/**
 * Synthesizes text directly in the browser using the client's GPU/CPU.
 * Returns { blob, audioUrl, duration, sampleRate, hash }
 */
export async function synthesizeOnClient(text, options = {}) {
  const cleanText = (text || "").trim();
  if (!cleanText) throw new Error("Empty text");

  let voice = options.voice || "af_bella";
  if (!voice || voice.startsWith("fish_") || voice.includes("Neural")) {
    voice = "af_bella";
  }
  const speed = Number(options.speed || 1.0);

  const model = await initKokoroModel(options.onProgress);
  console.log(`[KokoroClient] Synthesizing "${cleanText.slice(0, 30)}..." with voice "${voice}"`);

  const startTime = performance.now();
  const rawAudio = await model.generate(cleanText, {
    voice: voice,
    speed: speed
  });
  const elapsedMs = Math.round(performance.now() - startTime);
  console.log(`[KokoroClient] Synthesized in ${elapsedMs}ms!`);

  const blob = rawAudio.toBlob();
  const audioUrl = URL.createObjectURL(blob);
  const sampleRate = rawAudio.sampling_rate || 24000;
  const duration = rawAudio.audio ? (rawAudio.audio.length / sampleRate) : (blob.size / (sampleRate * 2));

  // Compute a deterministic client hash
  const hashKey = `client_kokoro::${cleanText}::${voice}::${speed}`;
  const hash = await computeSha256(hashKey);

  return {
    blob,
    audioUrl,
    duration: Number(duration.toFixed(2)),
    sampleRate,
    hash,
    elapsedMs,
    isClient: true
  };
}

/**
 * Syncs the client-rendered audio blob to the server cache
 * so chapter and master audiobook exports have the audio on disk.
 */
export async function syncClientAudioToServer(blob, hash, metadata = {}) {
  try {
    const formData = new FormData();
    formData.append("audio", blob, `${hash}.wav`);
    formData.append("hash", hash);
    if (metadata.project_id) formData.append("project_id", metadata.project_id);
    if (metadata.block_id) formData.append("block_id", metadata.block_id);
    if (metadata.duration) formData.append("duration", metadata.duration);

    const res = await fetch("/api/project/cache_audio", {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      console.warn("[KokoroClient] Server audio cache sync HTTP status:", res.status);
    } else {
      console.log(`[KokoroClient] Cached audio synced to server: /api/audio/${hash}.wav`);
    }
  } catch (err) {
    console.warn("[KokoroClient] Background sync to server cache failed (non-blocking):", err);
  }
}

async function computeSha256(str) {
  const enc = new TextEncoder();
  const data = enc.encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
