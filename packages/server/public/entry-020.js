// The grill page entry. `?session=2` marks a persistent interview session (0.2.0, see
// docs/SESSION-PROTOCOL.md); every other route keeps the unchanged 0.1 app.
//
// The session app is loaded as its own module graph: it imports the new /core/session.js
// directly, never the 0.1 /app.js or a previously cached /core/index.js (which predates the
// session exports). The changed/new modules — this entry, /session-app.js, /core/session.js —
// are URLs the 0.1 tree never served, so the warm 0.1 cache cannot satisfy them with stale
// bytes; unchanged dependencies (the /ui modules, legacy /core helpers) may correctly reuse
// their warm cached copies. A new query alone would not be enough: relative imports of changed
// modules would still hit stale cache entries.
const params = new URLSearchParams(location.search);
if (params.get("session") === "2") await import("/session-app.js?v=terminal-1");
else await import("/app.js");
