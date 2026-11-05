import { useCallback, useEffect, useRef, useState } from "react";
import { recoverPendingAudioSessions } from "../services/indexedDbService";

export function useAudioRecovery() {
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(false);

  const recover = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const recoveredSessions = await recoverPendingAudioSessions();
      if (mountedRef.current) {
        setSessions(recoveredSessions);
      }
      return recoveredSessions;
    } catch (recoveryError) {
      if (mountedRef.current) {
        setError(
          recoveryError instanceof Error
            ? recoveryError
            : new Error(String(recoveryError))
        );
      }
      throw recoveryError;
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void recover().catch((recoveryError) => {
      if (mountedRef.current) {
        setError(
          recoveryError instanceof Error
            ? recoveryError
            : new Error(String(recoveryError))
        );
      }
    });

    return () => {
      mountedRef.current = false;
    };
  }, [recover]);

  return {
    error,
    isLoading,
    recover,
    sessions,
  };
}
