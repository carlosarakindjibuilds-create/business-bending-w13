const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_FORMATS = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

function doPost(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonOutput({ ok: false, error: "Upload ocupado; intenta de nuevo." });
  }

  try {
    if (!event || !event.postData || typeof event.postData.contents !== "string") {
      return jsonOutput({ ok: false, error: "Falta el payload JSON." });
    }

    const payload = JSON.parse(event.postData.contents);
    const expectedToken = PropertiesService.getScriptProperties()
      .getProperty("GOOGLE_DRIVE_UPLOAD_TOKEN");
    if (
      !expectedToken ||
      typeof payload.uploadToken !== "string" ||
      payload.uploadToken !== expectedToken
    ) {
      return jsonOutput({ ok: false, error: "No autorizado." });
    }

    if (
      typeof payload.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sessionId) ||
      typeof payload.audioBase64 !== "string" ||
      payload.audioBase64.length === 0 ||
      payload.audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4
    ) {
      return jsonOutput({ ok: false, error: "El payload de audio no es válido." });
    }

    const mimeType =
      typeof payload.mimeType === "string"
        ? payload.mimeType.split(";")[0].trim().toLowerCase()
        : "";
    const extension = AUDIO_FORMATS[mimeType];
    if (!extension) {
      return jsonOutput({ ok: false, error: "Formato de audio no admitido." });
    }

    const bytes = Utilities.base64Decode(payload.audioBase64);
    if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
      return jsonOutput({ ok: false, error: "Tamaño de audio inválido." });
    }
    if (!hasValidAudioSignature(bytes, mimeType)) {
      return jsonOutput({
        ok: false,
        error: "El contenido no coincide con el tipo de audio declarado.",
      });
    }

    const fileName = "session-" + payload.sessionId + "." + extension;
    const folderId = PropertiesService.getScriptProperties().getProperty(
      "GOOGLE_DRIVE_FOLDER_ID"
    );
    const folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    const existing = folder.getFilesByName(fileName);
    if (existing.hasNext()) {
      const existingFile = existing.next();
      if (existingFile.getSize() !== bytes.length) {
        return jsonOutput({
          ok: false,
          error: "Ya existe un archivo con ese nombre y distinto tamaño.",
        });
      }

      return jsonOutput({
        ok: true,
        fileId: existingFile.getId(),
        fileName: existingFile.getName(),
        size: existingFile.getSize(),
      });
    }

    const blob = Utilities.newBlob(bytes, mimeType, fileName);
    const file = folder.createFile(blob);
    return jsonOutput({
      ok: true,
      fileId: file.getId(),
      fileName: file.getName(),
      size: file.getSize(),
    });
  } catch (error) {
    return jsonOutput({ ok: false, error: "No se pudo guardar el audio en Drive." });
  } finally {
    lock.releaseLock();
  }
}

function hasValidAudioSignature(bytes, mimeType) {
  if (mimeType === "audio/ogg" || mimeType === "audio/opus") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x4f &&
      bytes[1] === 0x67 &&
      bytes[2] === 0x67 &&
      bytes[3] === 0x53
    );
  }

  if (mimeType === "audio/webm") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }

  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    );
  }

  return true;
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON
  );
}
