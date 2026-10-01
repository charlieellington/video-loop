// server.mjs — the small local web server behind `video-loop review`.
// Plain English: serves ONE project folder to your own browser on this computer only (127.0.0.1),
// with proper video seeking (HTTP range requests), and accepts feedback notes, which it saves into
// the revision's feedback folder. Nothing outside the project folder is reachable and nothing
// leaves the machine.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, extname, sep, relative } from "node:path";
import { revisionPaths, listRevisions, currentRevision } from "./state.mjs";
import { writeJson } from "./util.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mov": "video/quicktime", ".srt": "text/plain; charset=utf-8", ".css": "text/css", ".ttf": "font/ttf" };

export function startReviewServer({ projectDir, stateDir, outputDir, port = 0, host = "127.0.0.1" }) {
  const root = resolve(projectDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      if (req.method === "POST" && url.pathname === "/api/feedback") return saveFeedback(req, res, stateDir);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
      if (url.pathname === "/") {
        const rev = currentRevision(stateDir, { create: false });
        const page = rev && join(outputDir, rev.id, "review.html");
        if (!page || !existsSync(page)) return send(res, 404, "no review page yet — run `video-loop board <project>` first");
        res.writeHead(302, { location: `/${relative(root, page).split(sep).map(encodeURIComponent).join("/")}` }); return res.end();
      }
      const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + sep)) return send(res, 403, "outside the project folder");
      if (/(^|\/)\.env/.test(url.pathname)) return send(res, 403, "not served");
      if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "not found");
      const size = statSync(file).size; const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
        let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : size - 1;
        if (!(start >= 0 && start < size && end >= start)) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
        end = Math.min(end, size - 1);
        res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "cache-control": "no-store" });
        if (req.method === "HEAD") return res.end();
        return createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "cache-control": "no-store" });
      if (req.method === "HEAD") return res.end();
      createReadStream(file).pipe(res);
    } catch (e) { send(res, 500, e.message); }
  });
  return new Promise((ok, bad) => { server.on("error", bad); server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}/` })); });
}

function send(res, code, msg) { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); }

function saveFeedback(req, res, stateDir) {
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => {
    try {
      const doc = JSON.parse(body);
      if (doc.contract !== "video-loop/feedback@1" || !Array.isArray(doc.notes)) throw new Error("not a video-loop feedback document");
      if (!listRevisions(stateDir).includes(doc.revision)) throw new Error(`unknown revision ${doc.revision}`);
      const rp = revisionPaths(stateDir, doc.revision);
      const file = join(rp.feedbackDir, `feedback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeJson(file, { ...doc, saved_at: new Date().toISOString() });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ saved: file.slice(file.indexOf(".video-loop")) }));
    } catch (e) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
  });
}
