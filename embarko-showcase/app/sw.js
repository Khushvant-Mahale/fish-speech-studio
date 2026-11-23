/**
 * Kashva Voice — Static Audio Mock Service Worker
 * Intercepts audio requests so that any missing audio file or newly rendered take
 * is seamlessly served without 404 errors.
 */

function createDummyWav(durationSeconds = 2.0, sampleRate = 24000) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + numSamples * 2, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * i) / numSamples);
    const sample = (Math.sin(2 * Math.PI * 340 * t) * 0.12 + Math.sin(2 * Math.PI * 510 * t) * 0.06) * env;
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
  }
  return buffer;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes("/api/audio/") || url.pathname.endsWith(".wav")) {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res.ok) return res;
        // If file not found (404), return gentle in-memory chime rather than hijacking with demo_clip.wav
        return new Response(createDummyWav(1.8), {
          headers: { "Content-Type": "audio/wav", "Content-Length": "86444" }
        });
      }).catch(() => {
        return new Response(createDummyWav(1.8), {
          headers: { "Content-Type": "audio/wav", "Content-Length": "86444" }
        });
      })
    );
  }
});
