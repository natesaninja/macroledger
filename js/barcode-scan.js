/**
 * MacroLedger barcode scanner — rear camera + digital zoom + ZXing 1D decode.
 * Built for iPhone Safari (html5-qrcode alone is poor at UPC/EAN + ultra-wide).
 */

let mediaStream = null;
let scanTimer = null;
let zxingReader = null;
let cameraList = [];
let cameraIndex = 0;
let busy = false;
let running = false;

const ZOOM = 2.2; // center-crop digital zoom (fixes "zoomed way out")

function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

export async function ensureZXing() {
  if (window.ZXing?.BrowserMultiFormatReader) return window.ZXing;
  // UMD build exposes global ZXing
  await loadScript("https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js");
  if (!window.ZXing) throw new Error("ZXing failed to load");
  return window.ZXing;
}

function scoreCamera(label, index, total) {
  const l = (label || "").toLowerCase();
  let score = 0;
  // Prefer back
  if (/back|rear|environment/i.test(l)) score += 50;
  // Ultra-wide = "zoomed out" — heavily penalize
  if (/ultra\s*wide|ultrawide/i.test(l)) score -= 80;
  // Prefer standard / dual wide (main lens)
  if (/dual\s*wide|triple|telephoto|wide(?!\s*ultra)/i.test(l)) score += 20;
  if (/front|face|user|true.?depth|continuity/i.test(l)) score -= 100;
  // iOS often lists front first; later non-front devices are better
  score += index * 2;
  // If unlabeled, prefer later indices (often back)
  if (!l && total > 1) score += index * 5;
  return score;
}

export async function listRankedCameras() {
  // Permission first so labels appear on iOS
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  stream.getTracks().forEach((t) => t.stop());

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  const ranked = videos
    .map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      score: scoreCamera(d.label, i, videos.length),
    }))
    .sort((a, b) => b.score - a.score);

  cameraList = ranked;
  // Default to best non-front
  cameraIndex = 0;
  return ranked;
}

function makeHints(ZXing) {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.CODE_128,
    ZXing.BarcodeFormat.CODE_39,
    ZXing.BarcodeFormat.ITF,
    ZXing.BarcodeFormat.CODABAR,
    ZXing.BarcodeFormat.RSS_14,
  ]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  // Important for product codes with thin bars
  try {
    hints.set(ZXing.DecodeHintType.ALSO_INVERTED, true);
  } catch {
    /* older builds */
  }
  return hints;
}

function drawZoomedFrame(video, canvas) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;

  // Output canvas size (decoder resolution)
  const outW = 1280;
  const outH = 720;
  if (canvas.width !== outW) canvas.width = outW;
  if (canvas.height !== outH) canvas.height = outH;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  // Center crop = digital zoom
  const cropW = vw / ZOOM;
  const cropH = vh / ZOOM;
  const sx = (vw - cropW) / 2;
  const sy = (vh - cropH) / 2;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);

  // Slight contrast boost helps thin UPC bars
  try {
    const img = ctx.getImageData(0, 0, outW, outH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // grayscale + contrast
      const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const c = Math.max(0, Math.min(255, (g - 128) * 1.35 + 128));
      d[i] = d[i + 1] = d[i + 2] = c;
    }
    ctx.putImageData(img, 0, 0);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * @param {object} opts
 * @param {HTMLVideoElement} opts.video
 * @param {HTMLCanvasElement} opts.canvas
 * @param {(code: string) => void} opts.onCode
 * @param {(msg: string, kind?: string) => void} opts.onStatus
 * @param {string|null} opts.deviceId
 */
export async function startScanner({ video, canvas, onCode, onStatus, deviceId = null }) {
  await stopScanner();
  busy = false;
  running = true;

  const ZXing = await ensureZXing();
  const hints = makeHints(ZXing);
  zxingReader = new ZXing.BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: 80,
    delayBetweenScanSuccess: 1500,
  });

  if (!cameraList.length) {
    try {
      await listRankedCameras();
    } catch (e) {
      onStatus?.(cameraHelp(e), "error");
      throw e;
    }
  }

  let chosenId = deviceId;
  if (!chosenId && cameraList.length) {
    chosenId = cameraList[0].id;
    cameraIndex = 0;
  }

  const constraints = {
    audio: false,
    video: chosenId
      ? {
          deviceId: { exact: chosenId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    // fallback: any camera
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  }

  video.srcObject = mediaStream;
  video.setAttribute("playsinline", "true");
  video.muted = true;
  await video.play();

  const label =
    cameraList.find((c) => c.id === chosenId)?.label ||
    mediaStream.getVideoTracks()[0]?.label ||
    "camera";
  const front = /front|face|user/i.test(label);
  const ultra = /ultra\s*wide/i.test(label);
  onStatus?.(
    front
      ? "Front camera — tap Flip for the back camera."
      : ultra
        ? "Ultra-wide lens — tap Flip to try the main back camera (less zoomed out)."
        : "Back camera · zoomed in on center. Fill the box with the barcode bars.",
    front || ultra ? "error" : "ok"
  );

  // Preview: CSS zoom to match decode crop
  video.style.transform = `scale(${Math.min(ZOOM, 1.85)})`;
  video.style.transformOrigin = "center center";
  video.style.objectFit = "cover";

  const multi = new ZXing.MultiFormatReader();
  multi.setHints(hints);

  const tryDecode = () => {
    if (!running || busy || video.readyState < 2) return;
    if (!drawZoomedFrame(video, canvas)) return;

    let result = null;
    try {
      if (typeof zxingReader.decodeFromCanvas === "function") {
        result = zxingReader.decodeFromCanvas(canvas);
      }
    } catch {
      /* try other path */
    }
    if (!result) {
      try {
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
        const binary = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
        result = multi.decodeWithState
          ? multi.decodeWithState(binary)
          : multi.decode(binary);
      } catch {
        /* NotFoundException every frame is normal */
        return;
      }
    }
    const text = result?.getText?.() || result?.text;
    if (text && !busy) {
      busy = true;
      onCode(String(text));
    }
  };

  scanTimer = setInterval(tryDecode, 150);
}

export async function flipScanner(opts) {
  if (!cameraList.length) await listRankedCameras();
  if (cameraList.length < 2) {
    opts.onStatus?.("Only one camera found on this device.", "error");
    return;
  }
  cameraIndex = (cameraIndex + 1) % cameraList.length;
  const next = cameraList[cameraIndex];
  opts.onStatus?.(`Switching to ${next.label}…`, "");
  await startScanner({ ...opts, deviceId: next.id });
}

export async function stopScanner() {
  running = false;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  try {
    zxingReader?.reset?.();
  } catch {
    /* ok */
  }
  zxingReader = null;
  busy = false;
}

export async function decodeBarcodeFromFile(file) {
  const ZXing = await ensureZXing();
  const hints = makeHints(ZXing);
  const reader = new ZXing.BrowserMultiFormatReader(hints);
  const url = URL.createObjectURL(file);
  try {
    // decodeFromImageUrl works well for still photos
    const result = await reader.decodeFromImageUrl(url);
    return result?.getText?.() || result?.text || String(result);
  } finally {
    URL.revokeObjectURL(url);
    try {
      reader.reset();
    } catch {
      /* ok */
    }
  }
}

export function cameraHelp(err) {
  const name = err?.name || "";
  const msg = (err?.message || String(err || "")).toLowerCase();
  if (name === "NotAllowedError" || msg.includes("permission") || msg.includes("denied")) {
    return isIos()
      ? "Camera blocked. Settings → Safari → Camera → Allow, then reopen. Or use Photo of barcode."
      : "Camera permission denied. Or use Photo of barcode.";
  }
  if (name === "NotFoundError") return "No camera found. Use Photo of barcode or type the UPC.";
  if (name === "NotReadableError") return "Camera busy in another app. Close it and try again.";
  return `Camera error (${name || "unknown"}). Try Flip camera, Photo of barcode, or type the numbers.`;
}

export function getCameraList() {
  return cameraList.slice();
}
