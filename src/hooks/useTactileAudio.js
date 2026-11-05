import { useCallback, useEffect, useRef, useState } from "react";
import { saveAudioChunk } from "../services/indexedDbService";
import { emitSystemLog } from "../services/systemEventLogger";

const VAD_SILENCE_DURATION_MS = 4000;
const DEFAULT_VAD_THRESHOLD = 0.025;
const RECORDER_TIMESLICE_MS = 1000;

function createId() {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function chooseAudioMimeType() {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }

  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/webm;codecs=opus",
    "audio/ogg",
    "audio/webm",
  ];

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

export function useTactileAudio({ silenceThreshold = DEFAULT_VAD_THRESHOLD } = {}) {
  if (
    !Number.isFinite(silenceThreshold) ||
    silenceThreshold < 0 ||
    silenceThreshold > 1
  ) {
    throw new RangeError("silenceThreshold debe estar entre 0 y 1.");
  }

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [latestAudioBlob, setLatestAudioBlob] = useState(null);

  const mountedRef = useRef(false);
  const startingRef = useRef(false);
  const recordingRef = useRef(false);
  const pauseInProgressRef = useRef(false);
  const pauseOperationRef = useRef(null);
  const sessionIdRef = useRef(null);
  const sequenceRef = useRef(0);
  const persistenceQueueRef = useRef(Promise.resolve());
  const persistenceErrorRef = useRef(null);
  const previewPartsRef = useRef([]);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const analyserRef = useRef(null);
  const vadFrameRef = useRef(null);
  const vadSamplesRef = useRef(null);
  const lastVoiceAtRef = useRef(null);
  const pauseForSilenceRef = useRef(null);

  const publishError = useCallback((nextError) => {
    const normalizedError =
      nextError instanceof Error ? nextError : new Error(String(nextError));

    if (mountedRef.current) {
      setError(normalizedError);
    }
  }, []);

  const vibrate = useCallback(
    (pattern) => {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.vibrate === "function"
      ) {
        try {
          navigator.vibrate(pattern);
        } catch (vibrationError) {
          publishError(vibrationError);
        }
      }
    },
    [publishError]
  );

  const stopVad = useCallback(() => {
    if (vadFrameRef.current !== null) {
      cancelAnimationFrame(vadFrameRef.current);
      vadFrameRef.current = null;
    }
    lastVoiceAtRef.current = null;
  }, []);

  const releaseAudioResources = useCallback(async () => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.disconnect();
    }

    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    analyserRef.current = null;
    vadSamplesRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  }, []);

  const enqueueAudioChunk = useCallback(
    (blob, activeSessionId, sequence, recorderMimeType) => {
      if (!blob || blob.size === 0) {
        return;
      }

      const mimeType =
        blob.type ||
        recorderMimeType ||
        (recorderRef.current && recorderRef.current.mimeType);
      if (!mimeType) {
        publishError(new Error("El navegador no informó el tipo MIME del audio."));
        return;
      }

      persistenceQueueRef.current = persistenceQueueRef.current
        .then(() =>
          saveAudioChunk({
            id: createId(),
            sessionId: activeSessionId,
            sequence,
            audio: blob,
            mimeType,
          })
        )
        .catch((saveError) => {
          persistenceErrorRef.current = saveError;
          publishError(saveError);
        });
    },
    [publishError]
  );

  const waitForRecorderStop = useCallback((recorder) => {
    if (recorder.state === "inactive") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const handleStop = () => resolve();
      recorder.addEventListener("stop", handleStop, { once: true });

      try {
        recorder.stop();
      } catch (stopError) {
        recorder.removeEventListener("stop", handleStop);
        reject(stopError);
      }
    });
  }, []);

  const runVad = useCallback(() => {
    const analyser = analyserRef.current;
    const samples = vadSamplesRef.current;
    if (!recordingRef.current || !analyser || !samples) {
      return;
    }

    analyser.getByteTimeDomainData(samples);
    let squaredTotal = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const amplitude = (samples[index] - 128) / 128;
      squaredTotal += amplitude * amplitude;
    }

    const rms = Math.sqrt(squaredTotal / samples.length);
    const now = Date.now();

    if (rms >= silenceThreshold) {
      lastVoiceAtRef.current = now;
    } else if (
      lastVoiceAtRef.current !== null &&
      now - lastVoiceAtRef.current >= VAD_SILENCE_DURATION_MS
    ) {
      stopVad();
      emitSystemLog("VAD");
      if (pauseForSilenceRef.current) {
        void pauseForSilenceRef.current();
      }
      return;
    }

    vadFrameRef.current = requestAnimationFrame(runVad);
  }, [silenceThreshold, stopVad]);

  const prepareAudioAnalysis = useCallback(async (stream) => {
    const AudioContextConstructor =
      window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("Este navegador no permite analizar el audio para VAD.");
    }

    const audioContext = new AudioContextConstructor();
    audioContextRef.current = audioContext;
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    sourceRef.current = source;
    analyserRef.current = analyser;
    vadSamplesRef.current = new Uint8Array(analyser.fftSize);
  }, []);

  const pauseCapture = useCallback(async () => {
    if (!recordingRef.current || pauseInProgressRef.current) {
      return;
    }

    pauseInProgressRef.current = true;
    recordingRef.current = false;
    setIsRecording(false);
    stopVad();

    try {
      const recorder = recorderRef.current;
      if (recorder) {
        await waitForRecorderStop(recorder);
        recorderRef.current = null;
      }

      await releaseAudioResources();
      await persistenceQueueRef.current;
      setIsPaused(true);
      if (persistenceErrorRef.current) {
        throw persistenceErrorRef.current;
      }
    } catch (pauseError) {
      publishError(pauseError);
    } finally {
      pauseInProgressRef.current = false;
    }
  }, [
    publishError,
    releaseAudioResources,
    stopVad,
    waitForRecorderStop,
  ]);

  const requestPause = useCallback(() => {
    if (pauseOperationRef.current) {
      return pauseOperationRef.current;
    }

    const operation = pauseCapture();
    pauseOperationRef.current = operation;
    void operation.finally(() => {
      if (pauseOperationRef.current === operation) {
        pauseOperationRef.current = null;
      }
    });
    return operation;
  }, [pauseCapture]);
  pauseForSilenceRef.current = requestPause;

  const startCapture = useCallback(
    async (createSession) => {
      if (recordingRef.current || startingRef.current) {
        return sessionIdRef.current;
      }

      startingRef.current = true;
      setError(null);
      let stream;
      let recorder;

      try {
        if (pauseOperationRef.current) {
          await pauseOperationRef.current;
        }
        if (createSession && sessionIdRef.current) {
          throw new Error(
            "Ya existe una sesión abierta; reanúdala o ciérrala antes de iniciar otra."
          );
        }
        if (!createSession && !sessionIdRef.current) {
          throw new Error("No hay una sesión pausada para reanudar.");
        }

        if (
          typeof navigator === "undefined" ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== "function"
        ) {
          throw new Error("La captura de micrófono no está disponible.");
        }
        if (typeof MediaRecorder === "undefined") {
          throw new Error("MediaRecorder no está disponible en este navegador.");
        }

        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        await prepareAudioAnalysis(stream);

        const mimeType = chooseAudioMimeType();
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorderRef.current = recorder;

        if (createSession) {
          sessionIdRef.current = createId();
          sequenceRef.current = 0;
          persistenceQueueRef.current = Promise.resolve();
          persistenceErrorRef.current = null;
          previewPartsRef.current = [];
          setLatestAudioBlob(null);
          setSessionId(sessionIdRef.current);
        }

        const activeSessionId = sessionIdRef.current;
        previewPartsRef.current = [];
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) {
            previewPartsRef.current.push(event.data);
            if (mountedRef.current) {
              setLatestAudioBlob(
                new Blob(previewPartsRef.current, {
                  type: recorder.mimeType || event.data.type,
                })
              );
            }

            const sequence = sequenceRef.current;
            sequenceRef.current += 1;
            enqueueAudioChunk(
              event.data,
              activeSessionId,
              sequence,
              recorder.mimeType
            );
          }
        });
        recorder.addEventListener("error", (event) => {
          publishError(
            event.error || new Error("Ocurrió un error durante la grabación.")
          );
          void requestPause();
        });

        recorder.start(RECORDER_TIMESLICE_MS);
        recordingRef.current = true;
        setIsRecording(true);
        setIsPaused(false);
        lastVoiceAtRef.current = Date.now();
        vadFrameRef.current = requestAnimationFrame(runVad);

        if (createSession) {
          vibrate(100);
        }

        return activeSessionId;
      } catch (startError) {
        recordingRef.current = false;
        setIsRecording(false);
        recorderRef.current = null;
        if (recorder && recorder.state !== "inactive") {
          try {
            await waitForRecorderStop(recorder);
          } catch (stopError) {
            publishError(stopError);
          }
        }

        try {
          await releaseAudioResources();
          await persistenceQueueRef.current;
        } catch (cleanupError) {
          publishError(cleanupError);
        }

        if (stream && !streamRef.current) {
          stream.getTracks().forEach((track) => track.stop());
        }
        publishError(startError);
        throw startError;
      } finally {
        startingRef.current = false;
      }
    },
    [
      enqueueAudioChunk,
      prepareAudioAnalysis,
      publishError,
      requestPause,
      releaseAudioResources,
      runVad,
      vibrate,
      waitForRecorderStop,
    ]
  );

  const startRecording = useCallback(
    () => startCapture(true),
    [startCapture]
  );

  const resumeRecording = useCallback(
    () => startCapture(false),
    [startCapture]
  );

  const closeRecording = useCallback(async () => {
    if (!sessionIdRef.current && !startingRef.current) {
      return null;
    }

    vibrate([100, 50, 100]);
    recordingRef.current = false;
    setIsRecording(false);
    stopVad();

    try {
      if (startingRef.current) {
        throw new Error("Espera a que la captura termine de inicializarse antes de cerrar.");
      }
      if (pauseOperationRef.current) {
        await pauseOperationRef.current;
      }

      const recorder = recorderRef.current;
      if (recorder) {
        await waitForRecorderStop(recorder);
        recorderRef.current = null;
      }

      await releaseAudioResources();
      await persistenceQueueRef.current;
      if (persistenceErrorRef.current) {
        throw persistenceErrorRef.current;
      }
      const closedSessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      setSessionId(null);
      setIsPaused(false);
      return closedSessionId;
    } catch (closeError) {
      publishError(closeError);
      throw closeError;
    }
  }, [
    publishError,
    releaseAudioResources,
    stopVad,
    vibrate,
    waitForRecorderStop,
  ]);

  const clearAudioPreview = useCallback(() => {
    previewPartsRef.current = [];
    setLatestAudioBlob(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      recordingRef.current = false;
      stopVad();

      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch (stopError) {
          publishError(stopError);
        }
      }

      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      const source = sourceRef.current;
      sourceRef.current = null;
      if (source) {
        source.disconnect();
      }

      const audioContext = audioContextRef.current;
      audioContextRef.current = null;
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch(publishError);
      }
    };
  }, [publishError, stopVad]);

  return {
    closeRecording,
    clearAudioPreview,
    error,
    isPaused,
    isRecording,
    latestAudioBlob,
    resumeRecording,
    sessionId,
    startRecording,
  };
}
