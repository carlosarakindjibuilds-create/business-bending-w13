const WHISPER_MODEL = "@cf/openai/whisper";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_FORM_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
]);

function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return {};
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!allowedOrigins.includes(origin)) {
    return null;
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function readBoundedBody(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return { error: "Content-Length inválido.", status: 400 };
    }
    if (declaredLength > MAX_AUDIO_BYTES) {
      return { error: "El audio excede el tamaño máximo permitido.", status: 413 };
    }
  }

  if (!request.body) {
    return { error: "La petición no contiene audio.", status: 400 };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_AUDIO_BYTES) {
        await reader.cancel();
        return {
          error: "El audio excede el tamaño máximo permitido.",
          status: 413,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { error: "La petición no contiene audio.", status: 400 };
  }

  const audio = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { audio };
}

function isSupportedAudioSignature(audio, mediaType) {
  if (mediaType === "audio/ogg" || mediaType === "audio/opus") {
    return (
      audio.length >= 4 &&
      audio[0] === 0x4f &&
      audio[1] === 0x67 &&
      audio[2] === 0x67 &&
      audio[3] === 0x53
    );
  }

  if (mediaType === "audio/webm") {
    return (
      audio.length >= 4 &&
      audio[0] === 0x1a &&
      audio[1] === 0x45 &&
      audio[2] === 0xdf &&
      audio[3] === 0xa3
    );
  }

  if (mediaType === "audio/wav" || mediaType === "audio/x-wav") {
    return (
      audio.length >= 12 &&
      audio[0] === 0x52 &&
      audio[1] === 0x49 &&
      audio[2] === 0x46 &&
      audio[3] === 0x46 &&
      audio[8] === 0x57 &&
      audio[9] === 0x41 &&
      audio[10] === 0x56 &&
      audio[11] === 0x45
    );
  }

  return true;
}

async function readBoundedRequest(request, maxBytes) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return { error: "Content-Length inválido.", status: 400 };
    }
    if (declaredLength > maxBytes) {
      return { error: "La petición excede el tamaño máximo permitido.", status: 413 };
    }
  }

  if (!request.body) {
    return { error: "La petición no contiene datos.", status: 400 };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return {
          error: "La petición excede el tamaño máximo permitido.",
          status: 413,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    );
  }
  return btoa(binary);
}

function getDriveFileExtension(mediaType) {
  const extensions = {
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
  };
  return extensions[mediaType];
}

async function handleDriveSync(request, env, headers) {
  if (!env.GOOGLE_DRIVE_SCRIPT_URL || !env.GOOGLE_DRIVE_UPLOAD_TOKEN) {
    return jsonResponse(
      { error: "La integración segura con Google Drive no está configurada." },
      503,
      headers
    );
  }

  let scriptUrl;
  try {
    scriptUrl = new URL(env.GOOGLE_DRIVE_SCRIPT_URL);
  } catch {
    return jsonResponse(
      { error: "La URL del endpoint de Google Drive no es válida." },
      503,
      headers
    );
  }
  if (
    scriptUrl.protocol !== "https:" ||
    scriptUrl.hostname !== "script.google.com"
  ) {
    return jsonResponse(
      { error: "El endpoint de Google Drive debe ser una URL HTTPS de Apps Script." },
      503,
      headers
    );
  }

  const requestBody = await readBoundedRequest(request, MAX_FORM_BYTES);
  if (requestBody.error) {
    return jsonResponse(
      { error: requestBody.error },
      requestBody.status,
      headers
    );
  }

  let formData;
  try {
    const bufferedRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: requestBody.bytes,
    });
    formData = await bufferedRequest.formData();
  } catch {
    return jsonResponse({ error: "El formulario de audio está mal formado." }, 400, headers);
  }

  const sessionId = formData.get("sessionId");
  const audioFile = formData.get("audio");
  if (
    typeof sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
    !audioFile ||
    typeof audioFile === "string" ||
    typeof audioFile.arrayBuffer !== "function"
  ) {
    return jsonResponse(
      { error: "La sesión o el archivo de audio no son válidos." },
      400,
      headers
    );
  }

  const mediaType = (audioFile.type || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(mediaType)) {
    return jsonResponse({ error: "Tipo de audio no admitido." }, 415, headers);
  }
  if (audioFile.size === 0) {
    return jsonResponse({ error: "El audio está vacío." }, 400, headers);
  }
  if (audioFile.size > MAX_AUDIO_BYTES) {
    return jsonResponse(
      { error: "El audio excede el tamaño máximo de 8 MiB." },
      413,
      headers
    );
  }

  const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
  if (!isSupportedAudioSignature(audioBytes, mediaType)) {
    return jsonResponse(
      { error: "El contenido no coincide con el tipo de audio declarado." },
      415,
      headers
    );
  }

  const extension = getDriveFileExtension(mediaType);
  if (!extension) {
    return jsonResponse({ error: "Formato de audio no compatible." }, 415, headers);
  }

  let driveResponse;
  try {
    driveResponse = await fetch(scriptUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        fileName: `session-${sessionId}.${extension}`,
        mimeType: mediaType,
        audioBase64: bytesToBase64(audioBytes),
        uploadToken: env.GOOGLE_DRIVE_UPLOAD_TOKEN,
      }),
      redirect: "follow",
    });
  } catch {
    return jsonResponse(
      { error: "No se pudo contactar el servicio de Google Drive." },
      502,
      headers
    );
  }

  let driveResult;
  try {
    driveResult = await driveResponse.json();
  } catch {
    return jsonResponse(
      { error: "Apps Script devolvió una respuesta inválida." },
      502,
      headers
    );
  }

  if (
    !driveResponse.ok ||
    !driveResult ||
    driveResult.ok !== true ||
    typeof driveResult.fileId !== "string"
  ) {
    return jsonResponse(
      { error: "Google Drive no confirmó que el audio se guardó." },
      502,
      headers
    );
  }

  return jsonResponse(
    {
      ok: true,
      fileId: driveResult.fileId,
      fileName:
        typeof driveResult.fileName === "string"
          ? driveResult.fileName
          : `session-${sessionId}.${extension}`,
      size:
        Number.isFinite(driveResult.size) && driveResult.size >= 0
          ? driveResult.size
          : audioBytes.byteLength,
    },
    200,
    headers
  );
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (headers === null) {
      return jsonResponse({ error: "Origen no permitido." }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          allow: "POST, OPTIONS",
        },
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Método no permitido." },
        405,
        { ...headers, allow: "POST, OPTIONS" }
      );
    }

    const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
    if (pathname === "/drive-sync") {
      return handleDriveSync(request, env, headers);
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return jsonResponse(
        { error: "Workers AI no está configurado para este Worker." },
        503,
        headers
      );
    }

    const mediaType = (request.headers.get("Content-Type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(mediaType)) {
      return jsonResponse(
        { error: "Tipo de audio no admitido." },
        415,
        headers
      );
    }

    let body;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      return jsonResponse(
        { error: "No se pudo leer el audio recibido." },
        400,
        headers
      );
    }

    if (body.error) {
      return jsonResponse({ error: body.error }, body.status, headers);
    }

    if (!isSupportedAudioSignature(body.audio, mediaType)) {
      return jsonResponse(
        { error: "El contenido no coincide con el tipo de audio declarado." },
        415,
        headers
      );
    }

    try {
      const result = await env.AI.run(WHISPER_MODEL, {
        audio: Array.from(body.audio),
      });

      if (!result || typeof result.text !== "string") {
        return jsonResponse(
          { error: "Workers AI devolvió una respuesta de transcripción inválida." },
          502,
          headers
        );
      }

      const transcript = result.text.trim();
      if (!transcript) {
        return jsonResponse(
          { error: "No se pudo obtener una transcripción del audio." },
          422,
          headers
        );
      }

      return jsonResponse(
        {
          model: WHISPER_MODEL,
          transcript,
          wordCount:
            Number.isInteger(result.word_count) && result.word_count >= 0
              ? result.word_count
              : null,
          processing: {
            noiseReduction: false,
            slangNormalization: false,
          },
        },
        200,
        headers
      );
    } catch (error) {
      return jsonResponse(
        { error: "Falló la transcripción en Workers AI." },
        502,
        headers
      );
    }
  },
};
