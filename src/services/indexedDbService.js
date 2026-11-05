const DATABASE_NAME = "validator-of-the-trade";
const DATABASE_VERSION = 1;
const AUDIO_CHUNKS_STORE = "audioChunks";

export function openAudioDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB no está disponible en este entorno.")
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(AUDIO_CHUNKS_STORE)) {
        const store = database.createObjectStore(AUDIO_CHUNKS_STORE, {
          keyPath: "id",
        });

        store.createIndex("by_status", "status", { unique: false });
        store.createIndex("by_session_id", "sessionId", { unique: false });
        store.createIndex("by_created_at", "createdAt", { unique: false });
      }
    };

    request.onerror = () => {
      settled = true;
      reject(request.error || new Error("No se pudo abrir IndexedDB."));
    };

    request.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "La actualización de IndexedDB está bloqueada por otra pestaña abierta."
          )
        );
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();

      if (settled) {
        database.close();
        return;
      }

      settled = true;
      resolve(database);
    };
  });
}
