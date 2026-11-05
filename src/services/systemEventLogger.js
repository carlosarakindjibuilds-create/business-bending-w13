export const SYSTEM_LOG_EVENT = "validator:system-log";
const MAX_LOG_ENTRIES = 100;
const listeners = new Set();
const history = [];
let nextEntryId = 0;

const SYSTEM_LOG_MESSAGES = Object.freeze({
  VAD: "[VAD] Silencio detectado (> 4s) - Pausando stream y resguardando fragmento.",
  INDEXEDDB:
    "[INDEXEDDB] Transacción exitosa - Fragmento de audio guardado de forma persistente en disco.",
  APP_INIT:
    "[APP_INIT] Pestaña recuperada - Se encontraron fragmentos huérfanos en IndexedDB. Reanudando cola de sincronización.",
  EDGE_AI:
    "[EDGE_AI] Payload comprimido OGG/OPUS enviado a Cloudflare - Invocando Workers AI (Whisper).",
  API_SUCCESS:
    "[API_SUCCESS] JSON de confianza técnica estructurado por el LLM corporativo con éxito.",
  SESSIONS_CLEARED:
    "[INDEXEDDB] Sesiones anteriores eliminadas - Almacén de audio vaciado correctamente.",
});

export function emitSystemLog(type) {
  const message = SYSTEM_LOG_MESSAGES[type];
  if (!message) {
    throw new TypeError(`Tipo de evento de sistema desconocido: ${type}`);
  }

  const entry = {
    id: `${Date.now()}-${nextEntryId}`,
    message,
    timestamp: new Date(),
    type,
  };
  history.push(entry);
  nextEntryId += 1;
  if (history.length > MAX_LOG_ENTRIES) {
    history.shift();
  }

  listeners.forEach((listener) => listener([...history]));
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(SYSTEM_LOG_EVENT, {
        detail: entry,
      })
    );
  }
}

export function subscribeSystemLogs(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("El suscriptor de eventos debe ser una función.");
  }

  listeners.add(listener);
  listener([...history]);
  return () => listeners.delete(listener);
}
