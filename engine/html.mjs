// html.mjs — shared bits for the local pages (voice comparison, board, review).
// Plain English: one escaping rule and one plain stylesheet, so every page the tool writes is
// safe to open and looks the same. No external fonts, scripts or trackers: pages work offline.

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** URL-encode each path segment (spaces, accents) but keep the slashes. */
export const urlPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");

export const CSS = `
:root{--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--bg:#fafafa;--accent:#2457d6;--warn:#b25b00;--bad:#b3261e;--ok:#1d7a3d}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:1100px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}
.muted{color:var(--muted)}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:#fff}
.pill.proposed{border-color:var(--warn);color:var(--warn)}.pill.rendered{border-color:var(--ok);color:var(--ok)}.pill.bad{border-color:var(--bad);color:var(--bad)}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.said{font-size:16px}.note{font-size:13px;color:var(--muted)}.t{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
img.thumb{width:100%;max-height:220px;object-fit:contain;background:#222;border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
textarea{width:100%;min-height:70px;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line)}
code{background:#f0f0f2;padding:1px 5px;border-radius:4px}`;

export const page = (title, body, extraHead = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style>${extraHead}</head><body><main>${body}</main></body></html>`;
