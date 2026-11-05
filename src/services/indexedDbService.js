const DATABASE_NAME = "validator-of-the-trade";
const DATABASE_VERSION = 1;
const AUDIO_CHUNKS_STORE = "audioChunks";

let databasePromise;

export function openAudioDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB no está disponible en este entorno.")
    );
  }

  if (databasePromise) {
    return databasePromise;
  }

  const pendingDatabase = new Promise((resolve, reject) => {
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
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };

      if (settled) {
        database.close();
        return;
      }

      settled = true;
      resolve(database);
    };
  });

  databasePromise = pendingDatabase;
  pendingDatabase.catch(() => {
    if (databasePromise === pendingDatabase) {
      databasePromise = undefined;
    }
  });

  return pendingDatabase;
}

export async function saveAudioChunk({
  id,
  sessionId,
  sequence,
  audio,
  mimeType,
  createdAt = Date.now(),
}) {
  if (!id || !sessionId || !Number.isInteger(sequence) || sequence < 0) {
    throw new TypeError("El fragmento requiere id, sessionId y sequence válidos.");
  }
  if (
    typeof Blob === "undefined" ||
    !(audio instanceof Blob) ||
    audio.size === 0
  ) {
    throw new TypeError("El fragmento debe contener un Blob de audio no vacío.");
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw new TypeError("El fragmento requiere un tipo MIME de audio válido.");
  }
  if (!Number.isFinite(createdAt)) {
    throw new TypeError("createdAt debe ser una marca de tiempo válida.");
  }

  const database = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = database.transaction(AUDIO_CHUNKS_STORE, "readwrite");
      transaction.objectStore(AUDIO_CHUNKS_STORE).put({
        id,
        sessionId,
        sequence,
        audio,
        mimeType,
        status: "pending_upload",
        createdAt,
      });
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(id);
    transaction.onerror = () => {
      reject(
        transaction.error || new Error("Falló la transacción de audio en IndexedDB.")
      );
    };
    transaction.onabort = () => {
      reject(
        transaction.error || new Error("Se abortó la transacción de audio en IndexedDB.")
      );
    };
  });
}
