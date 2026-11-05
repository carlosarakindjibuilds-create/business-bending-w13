import { emitSystemLog } from "./systemEventLogger";

const DATABASE_NAME = "validator-of-the-trade";
const DATABASE_VERSION = 1;
const AUDIO_CHUNKS_STORE = "audioChunks";
const MAX_SYNC_AUDIO_BYTES = 8 * 1024 * 1024;
const DRIVE_SYNC_PROXY_URL = import.meta.env.VITE_GOOGLE_DRIVE_SCRIPT_URL;

let databasePromise;
let recoveryPromise;

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

    transaction.oncomplete = () => {
      emitSystemLog("INDEXEDDB");
      resolve(id);
    };
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

export async function clearAudioChunks() {
  const database = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = database.transaction(AUDIO_CHUNKS_STORE, "readwrite");
      transaction.objectStore(AUDIO_CHUNKS_STORE).clear();
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => {
      emitSystemLog("SESSIONS_CLEARED");
      resolve();
    };
    transaction.onerror = () => {
      reject(
        transaction.error ||
          new Error("Falló la transacción al limpiar IndexedDB.")
      );
    };
    transaction.onabort = () => {
      reject(
        transaction.error ||
          new Error("Se abortó la transacción al limpiar IndexedDB.")
      );
    };
  });
}

export async function syncPendingAudioSessionToDrive(sessionId) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new TypeError("Se requiere una sesión válida para sincronizar.");
  }
  if (!DRIVE_SYNC_PROXY_URL) {
    throw new Error(
      "Falta configurar VITE_GOOGLE_DRIVE_SCRIPT_URL con la URL del proxy de Cloudflare."
    );
  }

  let endpoint;
  try {
    endpoint = new URL(DRIVE_SYNC_PROXY_URL);
  } catch {
    throw new Error("VITE_GOOGLE_DRIVE_SCRIPT_URL no es una URL válida.");
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
    throw new Error("El endpoint de sincronización debe usar HTTPS.");
  }
  if (!endpoint.pathname.replace(/\/+$/, "").endsWith("/drive-sync")) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/drive-sync`;
  }

  const database = await openAudioDatabase();
  const chunks = await readPendingSessionChunks(database, sessionId);
  if (chunks.length === 0) {
    throw new Error("No hay fragmentos pendientes para esta sesión.");
  }

  chunks.sort((left, right) => left.sequence - right.sequence);
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index - 1].sequence === chunks[index].sequence) {
      throw new Error("La sesión contiene secuencias de audio duplicadas.");
    }
  }

  const mimeType = chunks[0].mimeType;
  if (chunks.some((chunk) => chunk.mimeType !== mimeType)) {
    throw new Error("La sesión contiene formatos de audio incompatibles.");
  }

  const audio = new Blob(chunks.map((chunk) => chunk.audio), { type: mimeType });
  if (audio.size > MAX_SYNC_AUDIO_BYTES) {
    throw new Error("La sesión excede el límite de 8 MiB para sincronización.");
  }

  const formData = new FormData();
  formData.append("sessionId", sessionId);
  formData.append("audio", audio, `${sessionId}.${getAudioExtension(mimeType)}`);

  emitSystemLog("DRIVE_SYNC");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      body: formData,
      credentials: "omit",
    });
  } catch {
    throw new Error(
      "No se pudo conectar con el proxy de Google Drive; la sesión sigue pendiente."
    );
  }
  if (!response.ok) {
    throw new Error(
      `El proxy de Google Drive respondió con HTTP ${response.status}; la sesión sigue pendiente.`
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "El proxy de Google Drive devolvió una respuesta inválida; la sesión sigue pendiente."
    );
  }
  if (
    !result ||
    result.ok !== true ||
    typeof result.fileId !== "string" ||
    result.fileId.length === 0
  ) {
    throw new Error(
      "Google Drive no confirmó el almacenamiento; la sesión sigue pendiente."
    );
  }

  await markAudioChunksSynced(database, chunks);
  return {
    sessionId,
    fileId: result.fileId,
    fileName: typeof result.fileName === "string" ? result.fileName : null,
    size: Number.isFinite(result.size) ? result.size : audio.size,
  };
}

function getAudioExtension(mimeType) {
  const normalizedType = mimeType.split(";")[0].trim().toLowerCase();
  const extensions = {
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
  };
  const extension = extensions[normalizedType];
  if (!extension) {
    throw new Error("El formato de audio no es compatible con Google Drive.");
  }
  return extension;
}

function readPendingSessionChunks(database, sessionId) {
  return new Promise((resolve, reject) => {
    let transaction;
    let chunks = [];

    try {
      transaction = database.transaction(AUDIO_CHUNKS_STORE, "readonly");
      const request = transaction
        .objectStore(AUDIO_CHUNKS_STORE)
        .index("by_session_id")
        .getAll(sessionId);

      request.onsuccess = () => {
        chunks = request.result.filter(
          (chunk) => chunk && chunk.status === "pending_upload"
        );
        if (
          chunks.some(
            (chunk) =>
              !(chunk.audio instanceof Blob) ||
              chunk.audio.size === 0 ||
              !Number.isInteger(chunk.sequence) ||
              chunk.sequence < 0 ||
              typeof chunk.mimeType !== "string"
          )
        ) {
          reject(new Error("La sesión contiene fragmentos inválidos."));
        }
      };
      request.onerror = () => {
        reject(
          request.error || new Error("No se pudieron leer los fragmentos de la sesión.")
        );
      };
      transaction.oncomplete = () => resolve(chunks);
      transaction.onerror = () => {
        reject(transaction.error || new Error("Falló la lectura de IndexedDB."));
      };
      transaction.onabort = () => {
        reject(transaction.error || new Error("Se abortó la lectura de IndexedDB."));
      };
    } catch (error) {
      reject(error);
    }
  });
}

function markAudioChunksSynced(database, chunks) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = database.transaction(AUDIO_CHUNKS_STORE, "readwrite");
      const store = transaction.objectStore(AUDIO_CHUNKS_STORE);
      chunks.forEach((chunk) => {
        store.put({ ...chunk, status: "synced", syncedAt: Date.now() });
      });
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = resolve;
    transaction.onerror = () => {
      reject(
        transaction.error ||
          new Error("Falló la actualización del estado sincronizado.")
      );
    };
    transaction.onabort = () => {
      reject(
        transaction.error ||
          new Error("Se abortó la actualización del estado sincronizado.")
      );
    };
  });
}

export function recoverPendingAudioSessions() {
  if (recoveryPromise) {
    return recoveryPromise;
  }

  const pendingRecovery = scanPendingAudioSessions();
  recoveryPromise = pendingRecovery;
  const clearRecoveryPromise = () => {
    if (recoveryPromise === pendingRecovery) {
      recoveryPromise = undefined;
    }
  };
  pendingRecovery.then(clearRecoveryPromise, clearRecoveryPromise);

  return pendingRecovery;
}

async function scanPendingAudioSessions() {
  const database = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    let transaction;
    let hasSettled = false;
    let invalidRecord = false;
    const chunks = [];

    const fail = (error) => {
      if (!hasSettled) {
        hasSettled = true;
        reject(error);
      }
    };

    try {
      transaction = database.transaction(AUDIO_CHUNKS_STORE, "readonly");
      const store = transaction.objectStore(AUDIO_CHUNKS_STORE);
      const statusIndex = store.index("by_status");
      const range =
        typeof IDBKeyRange !== "undefined"
          ? IDBKeyRange.only("pending_upload")
          : (() => {
              throw new Error("IDBKeyRange no está disponible en este entorno.");
            })();
      const request = statusIndex.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || hasSettled) {
          return;
        }

        const chunk = cursor.value;
        if (
          !chunk ||
          typeof chunk.id !== "string" ||
          typeof chunk.sessionId !== "string" ||
          !Number.isInteger(chunk.sequence) ||
          chunk.sequence < 0 ||
          typeof Blob === "undefined" ||
          !(chunk.audio instanceof Blob) ||
          chunk.audio.size === 0 ||
          typeof chunk.mimeType !== "string" ||
          !Number.isFinite(chunk.createdAt) ||
          chunk.status !== "pending_upload"
        ) {
          invalidRecord = true;
          transaction.abort();
          fail(
            new Error(
              "Se encontró un fragmento pendiente inválido en IndexedDB; se conserva sin sincronizar."
            )
          );
          return;
        }

        chunks.push(chunk);
        cursor.continue();
      };

      request.onerror = () => {
        fail(
          request.error ||
            new Error("No se pudieron leer los fragmentos pendientes de IndexedDB.")
        );
      };

      transaction.oncomplete = () => {
        if (hasSettled) {
          return;
        }

        const sessions = new Map();
        chunks.forEach((chunk) => {
          let session = sessions.get(chunk.sessionId);
          if (!session) {
            session = {
              sessionId: chunk.sessionId,
              chunks: [],
              status: "pending_upload",
              recovered: true,
              complete: false,
              requiresReview: true,
            };
            sessions.set(chunk.sessionId, session);
          }
          session.chunks.push(chunk);
        });

        const recoveredSessions = Array.from(sessions.values());
        recoveredSessions.forEach((session) => {
          session.chunks.sort((left, right) => left.sequence - right.sequence);
          for (let index = 1; index < session.chunks.length; index += 1) {
            if (
              session.chunks[index - 1].sequence ===
              session.chunks[index].sequence
            ) {
              fail(
                new Error(
                  `La sesión ${session.sessionId} contiene fragmentos con secuencia duplicada.`
                )
              );
              return;
            }
          }
        });

        if (!hasSettled) {
          hasSettled = true;
          resolve(recoveredSessions);
        }
      };

      transaction.onerror = () => {
        if (!invalidRecord) {
          fail(
            transaction.error ||
              new Error("Falló la lectura de IndexedDB durante la recuperación.")
          );
        }
      };

      transaction.onabort = () => {
        if (!invalidRecord) {
          fail(
            transaction.error ||
              new Error("Se abortó la recuperación de IndexedDB.")
          );
        }
      };
    } catch (error) {
      fail(error);
    }
  });
}
