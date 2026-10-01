// compare-page.mjs — the original-vs-cleaned narration page.
// Plain English: two players at the same loudness, so the choice is about clarity and naturalness,
// not "the louder one sounds better". It lists the timing and noise measurements and the things
// to listen for, and tells the user the exact command for each choice.

import { esc, page, urlPath } from "./html.mjs";

export function comparePage({ title, items, result }) {
  const c = result.checks;
  const rows = c ? [
    ["Background level", `${c.background_db.original} dB → ${c.background_db.cleaned} dB (${c.background_db.reduction} dB quieter)`],
    ["Speech still present", `${(c.speech_retained * 100).toFixed(1)}% of the original's speech moments`],
    ["Start/end alignment", `shift ${c.offset_ms} ms, drift ${c.drift_ms} ms (start ${c.start.lag_ms} ms r=${c.start.r}, end ${c.end.lag_ms} ms r=${c.end.r})`],
    ["Length", `${c.duration_ms.original} ms → ${c.duration_ms.cleaned} ms`],
  ] : [];
  const status = result.status === "ok" ? `<span class="pill rendered">checks passed</span>` : `<span class="pill bad">${esc(result.status)}</span>`;
  const body = `<h1>Narration: original or cleaned?</h1><p class="muted">${esc(title)} · both players are matched to the same loudness (−20 LUFS) ${status}</p>
<div class="grid">${items.map((x) => `<div class="card"><h2 style="margin-top:0">${esc(x.label)}</h2><audio controls preload="metadata" style="width:100%" src="${urlPath(x.file)}"></audio><p class="note">measured ${x.measured_lufs} LUFS, played at ${x.gain_db >= 0 ? "+" : ""}${x.gain_db} dB</p></div>`).join("")}</div>
${result.error ? `<p class="card" style="color:var(--bad)">${esc(result.error)}</p>` : ""}
${rows.length ? `<h2>Measurements</h2><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>` : ""}
${c?.problems?.length ? `<h2>Problems</h2><ul>${c.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
<h2>Listen for</h2><ul><li>lost or clipped syllables, especially word endings and quiet words</li><li>breaths that sound cut off or unnatural</li><li>a metallic, watery or robotic edge on the voice</li><li>noise that is still there, or pumping as the noise comes and goes</li></ul>
<h2>Choose</h2><p><code>video-loop voice select &lt;project&gt; cleaned</code> or <code>video-loop voice select &lt;project&gt; original</code></p>
<p class="note">Only the narration recording was sent for cleanup. The original file is never changed. Switching later means the transcript is redone and the edit is reviewed again.</p>`;
  return page(`Narration comparison — ${title}`, body);
}
