import React, { useEffect, useState } from 'react';
import { createRoot } from "react-dom/client";
import ConsoleLogger from "./components/ConsoleLogger.jsx";
import { useAudioRecovery } from "./hooks/useAudioRecovery.js";
import { useTactileAudio } from "./hooks/useTactileAudio.js";
import {
  clearAudioChunks,
  syncPendingAudioSession,
} from "./services/indexedDbService.js";
import "./styles.css";

function App() {
  const {
    closeRecording,
    clearAudioPreview,
    error: audioError,
    isPaused,
    isRecording,
    latestAudioBlob,
    resumeRecording,
    sessionId,
    startRecording,
  } = useTactileAudio();
  const {
    error: recoveryError,
    isLoading: isRecovering,
    recover,
    sessions: recoveredSessions,
  } = useAudioRecovery();
  const [actionError, setActionError] = useState(null);
  const [isActionPending, setIsActionPending] = useState(false);
  const [isClearingSessions, setIsClearingSessions] = useState(false);
  const [syncingSessionId, setSyncingSessionId] = useState(null);
  const [syncedTranscripts, setSyncedTranscripts] = useState([]);
  const [audioUrl, setAudioUrl] = useState(null);

  useEffect(() => {
    if (!latestAudioBlob) {
      setAudioUrl(null);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(latestAudioBlob);
    setAudioUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [latestAudioBlob]);

  const handleAudioAction = async () => {
    if (isActionPending) {
      return;
    }

    setIsActionPending(true);
    setActionError(null);
    try {
      if (isRecording) {
        await closeRecording();
        await recover();
      } else if (sessionId) {
        await resumeRecording();
      } else {
        await startRecording();
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "No se pudo completar la acción."
      );
    } finally {
      setIsActionPending(false);
    }
  };

  const handleClearSessions = async () => {
    if (
      isRecording ||
      isRecovering ||
      isActionPending ||
      isClearingSessions ||
      syncingSessionId
    ) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Se eliminarán permanentemente todas las sesiones de audio guardadas en este dispositivo. ¿Deseas continuar?"
      )
    ) {
      return;
    }

    setIsClearingSessions(true);
    setActionError(null);
    try {
      if (sessionId) {
        await closeRecording();
      }
      await clearAudioChunks();
      clearAudioPreview();
      await recover();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "No se pudieron limpiar las sesiones."
      );
    } finally {
      setIsClearingSessions(false);
    }
  };

  const handleSyncSession = async (recoveredSession) => {
    if (
      isRecording ||
      isRecovering ||
      isActionPending ||
      isClearingSessions ||
      syncingSessionId
    ) {
      return;
    }

    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        `Se enviarán ${recoveredSession.chunks.length} fragmentos guardados a Cloudflare para transcripción. Como la sesión fue recuperada, podría faltar audio que no alcanzó a guardarse. ¿Deseas continuar?`
      );
    if (!confirmed) {
      return;
    }

    setSyncingSessionId(recoveredSession.sessionId);
    setActionError(null);
    try {
      const result = await syncPendingAudioSession(recoveredSession.sessionId);
      setSyncedTranscripts((current) => [
        { sessionId: result.sessionId, transcript: result.transcript },
        ...current.filter((item) => item.sessionId !== result.sessionId),
      ]);
      await recover();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "No se pudo sincronizar la sesión."
      );
    } finally {
      setSyncingSessionId(null);
    }
  };

  const buttonLabel = isRecording
    ? "Finalizar sesión"
    : sessionId
      ? "Reanudar captura"
      : "Iniciar captura";
  const statusLabel = isRecording
    ? "Escuchando"
    : isPaused
      ? "En pausa"
      : "Listo para empezar";
  const displayedError = actionError || audioError?.message || recoveryError?.message;

  return (
    <main className="app-shell">
      <section className="audio-card" aria-labelledby="app-title">
        <p className="eyebrow">Validator of the Trade</p>
        <h1 id="app-title">Tu puesto, a tu ritmo</h1>
        <p className="intro">
          Inicia la captura cuando estés lista. Si necesitas atender a alguien,
          el sistema resguarda lo grabado hasta ese momento.
        </p>

        <div className="status-row" aria-live="polite">
          <span
            className={`status-light ${
              isRecording ? "status-light--active" : "status-light--waiting"
            }`}
            aria-hidden="true"
          />
          <span>{statusLabel}</span>
        </div>

        <button
          className="audio-button"
          type="button"
          onClick={handleAudioAction}
          disabled={isRecovering || isActionPending}
        >
          {isRecovering
            ? "Revisando audio guardado..."
            : isActionPending
              ? "Procesando..."
              : buttonLabel}
        </button>

        <button
          className="clear-sessions-button"
          type="button"
          onClick={handleClearSessions}
          disabled={
            isRecording ||
            isRecovering ||
            isActionPending ||
            isClearingSessions ||
            syncingSessionId
            }
        >
          {isClearingSessions
            ? "Limpiando sesiones..."
            : "Limpiar Sesiones Anteriores"}
        </button>

        <div className="audio-preview">
              <label htmlFor="audio-preview">Último audio capturado</label>
              <audio
                id="audio-preview"
                controls
                preload="metadata"
                src={audioUrl || undefined}
              >
                Tu navegador no admite la reproducción de audio.
              </audio>
              {!latestAudioBlob && (
                <p className="audio-preview-note">
                  El audio estará disponible aquí mientras grabas.
                </p>
              )}
        </div>

        {sessionId && (
          <p className="session-note">
            La sesión activa se guarda localmente mientras capturas.
          </p>
        )}

        {recoveredSessions.length > 0 && (
          <section className="recovery-note" aria-live="polite">
            <h2>Audio guardado para revisar</h2>
            <p>
              Se encontraron {recoveredSessions.length} sesión
              {recoveredSessions.length === 1 ? "" : "es"} pendiente
              {recoveredSessions.length === 1 ? "" : "s"}. No se enviará sin
              tu confirmación. El envío inicia la transcripción en Cloudflare.
            </p>
            <ul className="recovered-session-list">
              {recoveredSessions.map((recoveredSession) => (
                <li key={recoveredSession.sessionId}>
                  <span>
                    Sesión con {recoveredSession.chunks.length} fragmento
                    {recoveredSession.chunks.length === 1 ? "" : "s"} guardado
                    {recoveredSession.chunks.length === 1 ? "" : "s"}
                  </span>
                  <button
                    className="sync-session-button"
                    type="button"
                    onClick={() => handleSyncSession(recoveredSession)}
                    disabled={
                      isRecording ||
                      isRecovering ||
                      isActionPending ||
                      isClearingSessions ||
                      syncingSessionId !== null
                    }
                  >
                    {syncingSessionId === recoveredSession.sessionId
                      ? "Enviando..."
                      : "Revisar y Sincronizar"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {syncedTranscripts.length > 0 && (
          <section className="transcript-note" aria-live="polite">
            <h2>Transcripción recibida</h2>
            {syncedTranscripts.map((item) => (
              <p key={item.sessionId}>{item.transcript}</p>
            ))}
          </section>
        )}

        {displayedError && (
          <p className="error-message" role="alert">
            {displayedError}
          </p>
        )}
      </section>
      <ConsoleLogger />
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('No se encontró el elemento raíz "#root" en index.html.');
}

createRoot(rootElement).render(<App />);
