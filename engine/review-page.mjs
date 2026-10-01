// review-page.mjs — writes the review page: board, rendered preview (when there is one) and feedback.
// Plain English: the page shows clearly whether it is a PROPOSED plan or a RENDERED preview. Under
// the video there is a note box tied to the playhead: "Add note at 0:12.4". Notes can be saved into
// the project (only when the page is served by `video-loop review`, and only claimed as saved after
// the project confirms), downloaded as a file, or copied to paste into your agent chat. Notes kept
// only in this browser are labelled as such.

import { esc, page } from "./html.mjs";
import { tc } from "./util.mjs";

const card = (c) => `<div class="card"><div class="t">${tc(c.start)}–${tc(c.end)} · ${esc(c.kind === "cover" ? (c.mediaKind === "image" ? "still" : "clip") : c.kind)}</div>
${c.img ? `<div style="position:relative"><img class="thumb" loading="lazy" src="${c.img}" alt="">${c.play ? `<button class="play" data-src="${c.play.src}" data-t0="${c.play.t0}" data-t1="${c.play.t1}">▶ play clip</button>` : ""}</div>` : c.kind === "gap" ? `<p class="pill bad">no picture</p>` : ""}
<p class="said">“${esc(c.said)}”</p>${c.media ? `<p class="note">${esc(c.media)}${c.lowres ? ` · low resolution ${esc(c.lowres)}` : ""}</p>` : ""}
${c.note ? `<p class="note"><b>Why:</b> ${esc(c.note)}</p>` : ""}${c.sound ? `<p class="note">Sound: ${esc(c.sound)}</p>` : ""}</div>`;

export function reviewHtml(d, { preview = null, approved = false } = {}) {
  const state = preview ? `<span class="pill rendered">rendered ${esc(preview.kind ?? "preview")}</span>` : `<span class="pill proposed">proposed — not rendered yet</span>`;
  const head = `<h1>${esc(d.title)}</h1><p class="muted">Revision <b>${esc(d.revision)}</b> · profile ${esc(d.profile || "none")} · ${esc(d.canvas)} · ${tc(d.total_ms)} long · ${state} ${approved ? `<span class="pill rendered">approved</span>` : `<span class="pill proposed">not approved</span>`}</p>`;
  const problems = d.problems.length ? `<div class="card" style="border-color:var(--bad)"><b style="color:var(--bad)">Must fix before approval</b><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";
  const player = preview ? `<h2>Preview</h2><div class="card"><video id="pv" controls playsinline preload="metadata" style="max-height:70vh;max-width:100%;background:#000" src="${preview.src}"></video>
<p class="note">Rendered features: ${esc(preview.features)}</p>
<h2 style="margin-top:12px">Feedback</h2><textarea id="note" placeholder="What should change at this moment? e.g. swap this clip, fix a caption word, music quieter"></textarea>
<p><button class="primary" id="add">Add note at <span id="at">0:00.0</span></button> <button id="dl">Download notes</button> <button id="cp">Copy notes</button> <button id="save" hidden>Save notes to project</button></p>
<p class="note" id="status">Notes so far are kept in this browser only — not saved to the project.</p><ol id="notes"></ol></div>` : "";
  const sound = d.music.source === "none" ? "No music." : `${d.music.source === "file" ? `Your file <code>${esc(d.music.file)}</code>` : `Generated with ElevenLabs from the brief: “${esc(d.music.prompt)}”`} · ${esc(d.music.placement)} · ${d.music.level_db} dB under the voice${d.music.ducking ? " · dips while you speak" : ""}`;
  const body = `${head}${problems}${player}
<h2>Shots (${d.cards.length})</h2><div class="grid">${d.cards.map(card).join("")}</div>
<h2>Narration and words</h2><p class="muted">${esc(d.narration.which)} narration · ${esc(d.narration.language)} · ${d.narration.words} words · <s>struck</s> words are cut${d.transcript.some((w) => w.fixed) ? " · <u>underlined</u> words have a caption correction" : ""}</p>
<div class="card" style="line-height:1.9">${d.transcript.map((w) => (w.kept ? (w.fixed ? `<u title="heard: ${esc(w.fixed)}">${esc(w.text)}</u>` : esc(w.text)) : `<s class="muted">${esc(w.text)}</s>`) + `<sub class="t">${w.i}</sub>`).join(" ")}</div>
<table><tr><th>Kept words</th><th>Starts</th><th>Why</th></tr>${d.segReasons.map((s) => `<tr><td>${s.words}</td><td class="t">${tc(s.start)}</td><td>${esc(s.reason)}</td></tr>`).join("")}</table>
<h2>Captions</h2><div class="card">${esc(d.captions.preset)} · ${esc(d.captions.position)}${d.captions.sample ? `<br><img src="${d.captions.sample.img}" style="max-width:300px;margin-top:8px;border-radius:6px" alt="caption sample"><p class="note">Sample: “${esc(d.captions.sample.text)}” (a real rendered frame)</p>` : ""}</div>
<h2>Soundtrack</h2><div class="card">${sound}<br>Hook: ${esc(d.presentation.hook)} · interludes: ${d.presentation.interludes ? "on" : "off"} · grade: ${esc(d.presentation.grade)}</div>
${d.editorial_notes ? `<h2>Editorial notes</h2><div class="card">${esc(d.editorial_notes)}</div>` : ""}${d.notes.length ? `<p class="note">${d.notes.map(esc).join("<br>")}</p>` : ""}
<p class="note">Approve this plan with <code>video-loop approve &lt;project&gt;</code>. Feedback goes back to your agent; it writes the next revision.</p>`;
  return page(`${d.title} — ${d.revision}`, body + script(d, preview), `<style>.play{position:absolute;left:8px;bottom:8px;background:#000c;color:#fff;border:0}</style>`);   // script last: it needs the player
}

function script(d, preview) {
  return `<script>
document.addEventListener("click",(e)=>{const b=e.target.closest(".play");if(!b)return;const box=b.parentElement;const old=box.querySelector("video");if(old){old.remove();b.textContent="▶ play clip";return}
const v=document.createElement("video");v.controls=true;v.playsInline=true;v.style.cssText="position:absolute;inset:0;width:100%;height:100%;background:#000;border-radius:6px";
v.src=b.dataset.src+"#t="+b.dataset.t0+","+b.dataset.t1;v.onerror=()=>{b.textContent="clip not available"};box.appendChild(v);v.play().catch(()=>{});b.textContent="■ stop"});
${preview ? `const REV=${JSON.stringify(d.revision)},VID=${JSON.stringify(preview.name)},KEY="video-loop-notes:"+location.pathname;
const pv=document.getElementById("pv"),list=document.getElementById("notes"),st=document.getElementById("status");
let notes=JSON.parse(localStorage.getItem(KEY)||"[]");const tcf=(s)=>Math.floor(s/60)+":"+(s%60).toFixed(1).padStart(4,"0");
const draw=()=>{list.innerHTML="";notes.forEach((n,i)=>{const li=document.createElement("li");const a=document.createElement("a");a.href="#";a.textContent=n.timecode;a.onclick=(e)=>{e.preventDefault();pv.currentTime=n.t_ms/1000};li.append(a," — "+n.text+" ");const x=document.createElement("button");x.textContent="remove";x.onclick=()=>{notes.splice(i,1);keep()};li.append(x);list.append(li)})};
const keep=()=>{localStorage.setItem(KEY,JSON.stringify(notes));draw();st.textContent="Notes so far are kept in this browser only — not saved to the project."};
pv.addEventListener("timeupdate",()=>{document.getElementById("at").textContent=tcf(pv.currentTime)});
document.getElementById("add").onclick=()=>{const t=document.getElementById("note");if(!t.value.trim())return;notes.push({t_ms:Math.round(pv.currentTime*1000),timecode:tcf(pv.currentTime),text:t.value.trim(),created_at:new Date().toISOString()});t.value="";keep()};
const doc=()=>({contract:"video-loop/feedback@1",revision:REV,video:VID,exported_at:new Date().toISOString(),notes});
document.getElementById("dl").onclick=()=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(doc(),null,1)],{type:"application/json"}));a.download="feedback-"+REV+".json";a.click()};
document.getElementById("cp").onclick=async()=>{const txt="Feedback on "+REV+" ("+VID+"):\\n"+notes.map(n=>"- "+n.timecode+" "+n.text).join("\\n");try{await navigator.clipboard.writeText(txt);st.textContent="Copied — paste it to your agent."}catch{st.textContent="Could not copy; use Download instead."}};
const sv=document.getElementById("save");if(location.protocol.startsWith("http")){sv.hidden=false;sv.onclick=async()=>{try{const r=await fetch("/api/feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(doc())});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);st.textContent="Saved to the project: "+j.saved}catch(e){st.textContent="NOT saved: "+e.message+" — use Download instead."}}};
draw();` : ""}
</script>`;
}
