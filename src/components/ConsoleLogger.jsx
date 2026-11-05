import { useEffect, useRef, useState } from "react";
import { subscribeSystemLogs } from "../services/systemEventLogger";

const MAX_LOG_ENTRIES = 100;

function formatTimestamp(date) {
  const time = new Intl.DateTimeFormat("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${time}.${milliseconds}`;
}

export default function ConsoleLogger() {
  const [entries, setEntries] = useState([]);
  const listRef = useRef(null);

  useEffect(() => {
    return subscribeSystemLogs((history) => {
      const entriesWithFormattedTime = history.map((entry) => ({
        ...entry,
        timestamp: formatTimestamp(entry.timestamp),
      }));
      setEntries(entriesWithFormattedTime.slice(-MAX_LOG_ENTRIES));
    });
  }, []);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <aside
      aria-label="Registro de eventos del sistema"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 1000,
        width: "min(420px, calc(100vw - 24px))",
        color: "#e5e7eb",
        background: "rgba(17, 24, 39, 0.94)",
        border: "1px solid rgba(148, 163, 184, 0.35)",
        borderRadius: 8,
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.28)",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: 12,
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid rgba(148, 163, 184, 0.25)",
          fontWeight: 700,
        }}
      >
        Eventos del sistema
      </div>
      <ol
        aria-live="polite"
        aria-relevant="additions"
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 220,
          overflowY: "auto",
          listStyle: "none",
          margin: 0,
          padding: 10,
        }}
      >
        {entries.length === 0 ? (
          <li style={{ color: "#9ca3af" }}>Esperando eventos...</li>
        ) : (
          entries.map((entry) => (
            <li
              key={entry.id}
              style={{
                display: "grid",
                gridTemplateColumns: "88px minmax(0, 1fr)",
                gap: 8,
                lineHeight: 1.45,
                overflowWrap: "anywhere",
              }}
            >
              <time style={{ color: "#9ca3af" }}>{entry.timestamp}</time>
              <span>{entry.message}</span>
            </li>
          ))
        )}
      </ol>
    </aside>
  );
}
