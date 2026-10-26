/**
 * Widevine DRM API Server
 * =======================
 * Minimal Express server with 2 endpoints:
 *
 *   GET  /api/wv?processurl=<MPD_URL>   → Extract Widevine keys
 *   GET  /api/wv?play=<session_id>      → Play video in Shaka Player
 *   POST /api/wv  body: {processurl, license_url, pssh}
 *
 * Usage:
 *   node server.js                      # starts on port 3000
 *   PORT=8080 node server.js            # custom port
 */

const express = require("express");
const { execFileSync } = require("child_process");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// ─── Python path ────────────────────────────────────────────────────
const PYTHON3 = process.env.PYTHON3_PATH || "python3";
const WV_SCRIPT = path.join(__dirname, "scripts", "wv_process.py");

// ─── In-memory session store ────────────────────────────────────────
const sessions = {};

// ─── Shaka Player HTML ──────────────────────────────────────────────
function playerHtml(mpdUrl, clearkeys) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Widevine Player</title>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@4.11/dist/shaka-player.compiled.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; font-family: system-ui, -apple-system, sans-serif; }
  video { width: 100vw; height: 100vh; display: block; }
  #error { color: #ff4444; padding: 20px; font-size: 14px; white-space: pre-wrap; display: none; }
</style>
</head>
<body>
<video id="v" controls autoplay></video>
<pre id="error"></pre>
<script>
(async () => {
  try {
    shaka.polyfill.installAll();
    const player = new shaka.Player();
    await player.attach(document.getElementById('v'));
    player.configure({
      drm: { clearKeys: ${JSON.stringify(clearkeys)} },
      streaming: { bufferingGoal: 30, bufferBehind: 10 }
    });
    await player.load("${mpdUrl}");
  } catch (e) {
    const errEl = document.getElementById('error');
    errEl.style.display = 'block';
    errEl.textContent = 'Player Error: ' + (e.message || e);
  }
})();
</script>
</body>
</html>`;
}

// ─── GET /api/wv ────────────────────────────────────────────────────
app.get("/api/wv", (req, res) => {
  // Play endpoint
  const playId = req.query.play;
  if (playId && sessions[playId]) {
    const s = sessions[playId];
    return res.type("html").send(playerHtml(s.mpd_url, s.clearkeys));
  }

  // Process endpoint
  const processurl = (req.query.processurl || "").trim();
  const license_url = (req.query.license_url || "").trim();

  if (!processurl) {
    return res.status(400).json({
      error: "processurl is required",
      usage: "/api/wv?processurl=<MPD_URL or preset>",
      presets: ["bitmovin", "tears", "tears_vp9", "axinom_cbcs"],
      play_usage: "/api/wv?play=<session_id>"
    });
  }

  try {
    const args = JSON.stringify({ processurl, license_url: license_url || undefined });
    const result = execFileSync(PYTHON3, [WV_SCRIPT, args], {
      timeout: 60000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(result);

    if (data.status === "success" && data.session_id) {
      const origin = getOrigin(req);
      data.play_url = `${origin}/api/wv?play=${data.session_id}`;
      sessions[data.session_id] = {
        mpd_url: data.mpd_url,
        clearkeys: data.clearkeys,
        keys: data.keys,
        created: Date.now()
      };
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message || "Unknown error" });
  }
});

// ─── POST /api/wv ───────────────────────────────────────────────────
app.post("/api/wv", (req, res) => {
  const processurl = (req.body.processurl || "").trim();
  const license_url = (req.body.license_url || "").trim();

  if (!processurl) {
    return res.status(400).json({ error: "processurl is required" });
  }

  try {
    const args = JSON.stringify({
      processurl,
      license_url: license_url || undefined,
      pssh: req.body.pssh || undefined
    });

    const result = execFileSync(PYTHON3, [WV_SCRIPT, args], {
      timeout: 60000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(result);

    if (data.status === "success" && data.session_id) {
      const origin = getOrigin(req);
      data.play_url = `${origin}/api/wv?play=${data.session_id}`;
      sessions[data.session_id] = {
        mpd_url: data.mpd_url,
        clearkeys: data.clearkeys,
        keys: data.keys,
        created: Date.now()
      };
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message || "Unknown error" });
  }
});

// ─── Health check ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name: "Widevine DRM API",
    version: "1.0.0",
    endpoints: {
      process: "GET/POST /api/wv?processurl=<MPD_URL>",
      play: "GET /api/wv?play=<session_id>",
      health: "GET /"
    },
    presets: ["bitmovin", "tears", "tears_vp9", "axinom_cbcs"]
  });
});

// ─── Helpers ────────────────────────────────────────────────────────
function getOrigin(req) {
  const fwdHost = req.headers["x-forwarded-host"];
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto = fwdProto || (req.secure ? "https" : "http");
  const host = fwdHost || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ─── Start ──────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Widevine DRM API running on http://0.0.0.0:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  GET  /api/wv?processurl=<MPD_URL>  → Extract keys`);
  console.log(`  GET  /api/wv?play=<session_id>     → Play video`);
  console.log(`  POST /api/wv  {processurl, license_url, pssh}`);
});
