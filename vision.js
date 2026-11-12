// vision.js — "Đôi mắt" của MTD
// Dùng MediaPipe Face Landmarker (tải qua CDN) để:
//   - phát hiện người có mặt trước camera,
//   - lấy vị trí khuôn mặt để mắt robot liếc theo,
//   - đọc biểu cảm (cười / buồn / mệt) từ các "blendshape".
// Nếu không tải được mô hình (mất mạng, máy yếu) sẽ chuyển sang chế độ dự phòng: phát hiện chuyển động.

const MP_VERSION = "0.10.14";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const FRAME_INTERVAL_MS = 66; // ~15 khung hình/giây là đủ, đỡ tốn CPU
const FACE_LOST_MS = 1500; // mất mặt quá 1,5 giây mới coi là "vắng"
const MOTION_LOST_MS = 20000; // chế độ dự phòng: không có chuyển động 20 giây = vắng
const MOOD_WINDOW = 45; // ~3 giây dữ liệu để quyết định cảm xúc

const MOOD_TEXT = { happy: "VUI VẺ", sad: "BUỒN", tired: "MỆT MỎI", neutral: "BÌNH THƯỜNG" };

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

export class Vision {
  constructor({ video, canvas, onPresence, onFace, onMood, onStatus, onMimic }) {
    this.onMimic = onMimic || (() => {});
    this.poseOn = false; // chế độ bắt chước: bật thêm nhận diện tư thế cơ thể
    this.pose = null;
    this.faceMimic = null; // dữ liệu khuôn mặt mới nhất cho chế độ bắt chước
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onPresence = onPresence || (() => {});
    this.onFace = onFace || (() => {});
    this.onMood = onMood || (() => {});
    this.onStatus = onStatus || (() => {});
    this.mode = "none"; // face | motion
    this.present = false;
    this.lastSeen = 0;
    this.lastTick = 0;
    this.moodWindow = [];
    this.mood = "neutral";
    this.scanY = 0;
    this.identity = ""; // tên người đang thấy (vẽ lên khung HUD)
  }

  /** Bắt đầu quan sát. Có thể truyền sẵn một MediaStream (đã xin quyền ở app.js). */
  async start(stream) {
    this.onStatus("Đang mở camera...");
    this.stream =
      stream ||
      (await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      }));
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    this.onStatus("Đang nạp mô hình nhận diện khuôn mặt...");
    try {
      await withTimeout(this.loadLandmarker(), 25000, "Hết thời gian tải mô hình");
      this.mode = "face";
      this.onStatus("Nhận diện khuôn mặt: sẵn sàng");
    } catch (err) {
      console.warn("[MTD] Không tải được Face Landmarker, chuyển sang phát hiện chuyển động:", err);
      this.mode = "motion";
      this.prepareMotion();
      this.onStatus("Chế độ dự phòng: phát hiện chuyển động");
    }
    this.loop();
  }

  async loadLandmarker() {
    const vision = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    this.mp = vision; // giữ lại để tạo PoseLandmarker khi cần
    this.fileset = fileset;
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    try {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      // Máy không hỗ trợ WebGL tốt -> chạy bằng CPU.
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options("CPU"));
    }
  }

  /** Bật/tắt chế độ bắt chước. Mô hình tư thế (~6 MB) chỉ tải ở lần bật đầu tiên. */
  async enablePose(on) {
    if (on && this.mode !== "face") throw new Error("Cần mô hình nhận diện khuôn mặt (đang ở chế độ dự phòng)");
    if (on && !this.pose) {
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
      });
      try {
        this.pose = await this.mp.PoseLandmarker.createFromOptions(this.fileset, options("GPU"));
      } catch {
        this.pose = await this.mp.PoseLandmarker.createFromOptions(this.fileset, options("CPU"));
      }
    }
    this.poseOn = on;
  }

  /**
   * Góc xoay cho tay robot (độ) từ vai -> cổ tay, nhìn như soi gương.
   * Tay robot buông thẳng xuống là 0°. SVG xoay theo chiều kim đồng hồ khi góc dương,
   * và rotate(θ) biến vector (0, 1) thành (-sinθ, cosθ) => θ = atan2(-dx_gương, dy).
   * Vì ảnh gương có x' = 1 - x nên -dx_gương = (x_cổtay - x_vai).
   */
  armAngle(shoulder, wrist) {
    if (!shoulder || !wrist || (wrist.visibility ?? 1) < 0.5 || (shoulder.visibility ?? 1) < 0.5) return 0;
    return (Math.atan2(wrist.x - shoulder.x, wrist.y - shoulder.y) * 180) / Math.PI;
  }

  detectPose(now) {
    let leftArm = 0;
    let rightArm = 0;
    if (this.pose) {
      const result = this.pose.detectForVideo(this.video, now);
      const lm = result.landmarks?.[0];
      if (lm) {
        // Ảnh gương: tay TRÁI của người dùng hiện ở bên TRÁI màn hình -> điều khiển tay trái robot.
        leftArm = this.armAngle(lm[11], lm[15]);
        rightArm = this.armAngle(lm[12], lm[16]);
        this.drawSkeleton(lm);
      }
    }
    this.onMimic({ ...(this.faceMimic || {}), leftArm, rightArm });
  }

  drawSkeleton(lm) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const pt = (p) => [(1 - p.x) * w, p.y * h];
    ctx.strokeStyle = "#d77bff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (const [a, b] of [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12]]) {
      if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) continue;
      ctx.moveTo(...pt(lm[a]));
      ctx.lineTo(...pt(lm[b]));
    }
    ctx.stroke();
  }

  loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastTick < FRAME_INTERVAL_MS) return;
    this.lastTick = now;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;

    if (this.canvas.width !== this.video.videoWidth) {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
    }

    try {
      if (this.mode === "face") this.detectFace(now);
      else if (this.mode === "motion") this.detectMotion();
      if (this.poseOn) this.detectPose(now);
    } catch (err) {
      console.warn("[MTD] Lỗi xử lý khung hình:", err);
    }
    this.updatePresence();
  };

  updatePresence() {
    const limit = this.mode === "face" ? FACE_LOST_MS : MOTION_LOST_MS;
    const present = Date.now() - this.lastSeen < limit;
    if (present !== this.present) {
      this.present = present;
      if (!present) {
        this.moodWindow = [];
        this.mood = "neutral";
      }
      this.onPresence(present);
    }
  }

  // ------------------------------------------------------------------
  // CHẾ ĐỘ KHUÔN MẶT
  // ------------------------------------------------------------------

  detectFace(now) {
    const result = this.landmarker.detectForVideo(this.video, now);
    const { width: w, height: h } = this.canvas;
    this.ctx.clearRect(0, 0, w, h);
    this.drawScanLine(w, h);

    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks) {
      this.faceMimic = null;
      return;
    }

    this.lastSeen = Date.now();
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of landmarks) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Ảnh camera chưa lật: người dùng nghiêng sang TRÁI của họ thì mặt nằm bên PHẢI ảnh (cx > 0.5).
    // Vì vậy hướng nhìn ngang = (0.5 - cx) để mắt robot liếc đúng về phía trái màn hình.
    this.onFace((0.5 - cx) * 2.4, (cy - 0.5) * 2.4);

    const shapes = {};
    for (const c of result.faceBlendshapes?.[0]?.categories || []) shapes[c.categoryName] = c.score;
    const frameMood = this.classify(shapes, cy);
    this.pushMood(frameMood);

    // Dữ liệu cho chế độ bắt chước. Điểm 33 = khóe ngoài mắt phải, 263 = khóe ngoài mắt trái của người dùng.
    // Tính góc nghiêng đầu trong ảnh GƯƠNG (x' = 1 - x): dx' = x263 - x33, dy' = y33 - y263.
    const r = landmarks[33];
    const l = landmarks[263];
    this.faceMimic = {
      headRoll: (Math.atan2(r.y - l.y, l.x - r.x) * 180) / Math.PI,
      mouthOpen: shapes.jawOpen || 0,
      blink: ((shapes.eyeBlinkLeft || 0) + (shapes.eyeBlinkRight || 0)) / 2,
      smile: ((shapes.mouthSmileLeft || 0) + (shapes.mouthSmileRight || 0)) / 2,
    };

    this.drawFace(landmarks, { minX, minY, maxX, maxY }, frameMood);
  }

  /** Phân loại cảm xúc của MỘT khung hình dựa trên blendshape. */
  classify(s, faceCenterY) {
    const avg = (a, b) => ((s[a] || 0) + (s[b] || 0)) / 2;
    const smile = avg("mouthSmileLeft", "mouthSmileRight");
    const frown = avg("mouthFrownLeft", "mouthFrownRight");
    const browUp = s.browInnerUp || 0;
    const blink = avg("eyeBlinkLeft", "eyeBlinkRight");
    const jaw = s.jawOpen || 0;

    if (smile > 0.5) return "happy";
    // Mắt lim dim, ngáp, hoặc gục đầu xuống thấp trong khung hình -> mệt.
    if (blink > 0.55 || (jaw > 0.65 && smile < 0.2) || faceCenterY > 0.78) return "tired";
    if (frown > 0.25 || (browUp > 0.45 && smile < 0.12)) return "sad";
    return "neutral";
  }

  /** Gom nhiều khung hình: chỉ đổi cảm xúc khi một trạng thái chiếm ≥ 65% trong ~3 giây. */
  pushMood(label) {
    this.moodWindow.push(label);
    if (this.moodWindow.length > MOOD_WINDOW) this.moodWindow.shift();
    if (this.moodWindow.length < MOOD_WINDOW * 0.6) return;

    const counts = {};
    for (const m of this.moodWindow) counts[m] = (counts[m] || 0) + 1;
    let stable = "neutral";
    for (const [mood, count] of Object.entries(counts)) {
      if (count / this.moodWindow.length >= 0.65) stable = mood;
    }
    if (stable !== this.mood) {
      this.mood = stable;
      this.onMood(stable);
    }
  }

  drawScanLine(w, h) {
    this.scanY = (this.scanY + h / 60) % h;
    const g = this.ctx.createLinearGradient(0, this.scanY - 20, 0, this.scanY);
    g.addColorStop(0, "rgba(61,232,255,0)");
    g.addColorStop(1, "rgba(61,232,255,0.35)");
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, this.scanY - 20, w, 20);
  }

  /** Vẽ khung HUD quanh khuôn mặt. Video được lật gương bằng CSS nên toạ độ x ở đây cũng phải lật. */
  drawFace(landmarks, box, mood) {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const mx = (x) => (1 - x) * w;
    const color = mood === "happy" ? "#5cffb0" : mood === "sad" || mood === "tired" ? "#ff9a6b" : "#3de8ff";

    // Điểm mốc khuôn mặt (vẽ thưa cho nhẹ)
    ctx.fillStyle = color;
    for (let i = 0; i < landmarks.length; i += 9) {
      const p = landmarks[i];
      ctx.fillRect(mx(p.x) - 1, p.y * h - 1, 2, 2);
    }

    // Khung ngoặc góc
    const pad = 0.04;
    const x1 = mx(box.maxX + pad);
    const x2 = mx(box.minX - pad);
    const y1 = (box.minY - pad) * h;
    const y2 = (box.maxY + pad) * h;
    const len = Math.min(x2 - x1, y2 - y1) * 0.22;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1]]) {
      ctx.moveTo(x, y + dy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * len, y);
    }
    ctx.stroke();

    // Nhãn
    ctx.font = "bold 16px Orbitron, monospace";
    ctx.fillStyle = color;
    // identity do app.js đặt sau khi nhận diện khuôn mặt (ví dụ "ĐỨC", "NGƯỜI LẠ").
    ctx.fillText(`${this.identity || "TARGET LOCK"} · ${MOOD_TEXT[mood]}`, x1, Math.max(18, y1 - 8));
  }

  // ------------------------------------------------------------------
  // CHẾ ĐỘ DỰ PHÒNG: PHÁT HIỆN CHUYỂN ĐỘNG
  // ------------------------------------------------------------------

  prepareMotion() {
    this.small = document.createElement("canvas");
    this.small.width = 64;
    this.small.height = 48;
    this.smallCtx = this.small.getContext("2d", { willReadFrequently: true });
    this.prevGray = null;
  }

  detectMotion() {
    const sw = 64;
    const sh = 48;
    this.smallCtx.drawImage(this.video, 0, 0, sw, sh);
    const pixels = this.smallCtx.getImageData(0, 0, sw, sh).data;
    const gray = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      gray[i] = (pixels[i * 4] * 0.3 + pixels[i * 4 + 1] * 0.59 + pixels[i * 4 + 2] * 0.11) | 0;
    }

    const { width: w, height: h } = this.canvas;
    this.ctx.clearRect(0, 0, w, h);
    this.drawScanLine(w, h);

    if (this.prevGray) {
      let count = 0, sumX = 0, sumY = 0;
      for (let i = 0; i < gray.length; i++) {
        if (Math.abs(gray[i] - this.prevGray[i]) > 28) {
          count++;
          sumX += i % sw;
          sumY += (i / sw) | 0;
        }
      }
      if (count > gray.length * 0.015) {
        this.lastSeen = Date.now();
        const cx = sumX / count / sw;
        const cy = sumY / count / sh;
        this.onFace((0.5 - cx) * 2, (cy - 0.5) * 2);
        // Vẽ tâm chuyển động
        const x = (1 - cx) * w;
        const y = cy * h;
        this.ctx.strokeStyle = "#3de8ff";
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 28, 0, Math.PI * 2);
        this.ctx.moveTo(x - 40, y);
        this.ctx.lineTo(x + 40, y);
        this.ctx.moveTo(x, y - 40);
        this.ctx.lineTo(x, y + 40);
        this.ctx.stroke();
        this.ctx.font = "bold 14px Orbitron, monospace";
        this.ctx.fillStyle = "#3de8ff";
        this.ctx.fillText("MOTION TRACK", 10, 22);
      }
    }
    this.prevGray = gray;
  }
}
