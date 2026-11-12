// robot-avatar.js — Hình robot MTD vẽ bằng SVG + CSS animation
// 8 trạng thái: idle, greeting, talking, singing, calculating, comforting, sleeping, shy (xấu hổ).
// 4 dạng biến hình (data-form): normal (bình thường), battle (chiến binh mặc giáp), car (xe đua), cat (mèo máy).
// Dạng mèo máy là thiết kế RIÊNG của MTD (tai LED, ria LED, đuôi máy, đệm chân) — không mô phỏng nhân vật có bản quyền.
// Hình dạng mắt/miệng và màu LED được đổi bằng thuộc tính data-state (xem styles.css).

export const STATES = ["idle", "greeting", "talking", "singing", "calculating", "comforting", "sleeping", "shy"];

const EYE_LEFT = { x: 160, y: 148 };
const EYE_RIGHT = { x: 240, y: 148 };

/** Tạo tất cả các kiểu mắt cho một bên; CSS sẽ chỉ hiện kiểu hợp với trạng thái hiện tại. */
function eyeShapes({ x, y }, side) {
  // Mắt xấu hổ kiểu "> <": bên trái mũi nhọn chỉ vào giữa, bên phải ngược lại.
  const dir = side === "left" ? 1 : -1;
  return `
    <path class="eye eye-shy led-stroke" d="M ${x - 12 * dir} ${y - 13} L ${x + 12 * dir} ${y} L ${x - 12 * dir} ${y + 13}"/>
    <g class="eye eye-round">
      <ellipse class="led-fill" cx="${x}" cy="${y}" rx="17" ry="21"/>
      <circle cx="${x + 6}" cy="${y - 8}" r="5" fill="#ffffff" opacity="0.85"/>
    </g>
    <path class="eye eye-happy led-stroke" d="M ${x - 18} ${y + 8} Q ${x} ${y - 20} ${x + 18} ${y + 8}"/>
    <path class="eye eye-heart led-fill"
      d="M ${x} ${y + 16} C ${x - 26} ${y}, ${x - 14} ${y - 22}, ${x} ${y - 8} C ${x + 14} ${y - 22}, ${x + 26} ${y}, ${x} ${y + 16} Z"/>
    <path class="eye eye-sleep led-stroke" d="M ${x - 18} ${y + 2} Q ${x} ${y + 12} ${x + 18} ${y + 2}"/>
    <g class="eye eye-calc">
      <circle class="calc-ring led-stroke" cx="${x}" cy="${y}" r="16"/>
      <circle class="led-fill" cx="${x}" cy="${y}" r="4"/>
    </g>`;
}

function mouthBars() {
  let bars = "";
  for (let i = 0; i < 7; i++) {
    bars += `<rect class="mouth-bar led-fill" x="${169 + i * 9}" y="190" width="6" height="4" rx="2"/>`;
  }
  return bars;
}

function arm(side) {
  // Tay phải là ảnh gương của tay trái qua trục x = 200.
  const sx = side === "left" ? 114 : 286;
  return `
    <g class="arm arm-${side}">
      <rect x="${sx - 14}" y="322" width="28" height="80" rx="14" fill="url(#metal)" stroke="#5d6a80" stroke-width="3"/>
      <circle cx="${sx}" cy="402" r="11" fill="#39445a" stroke="#5d6a80" stroke-width="2"/>
      <rect x="${sx - 12}" y="402" width="24" height="48" rx="12" fill="url(#metal)" stroke="#5d6a80" stroke-width="3"/>
      <path d="M ${sx - 9} 448 q -7 16 5 24 M ${sx + 9} 448 q 7 16 -5 24" stroke="#4b5870" stroke-width="6" fill="none" stroke-linecap="round"/>
      <circle cx="${sx}" cy="322" r="17" fill="url(#metalDark)" stroke="#5d6a80" stroke-width="3"/>
      <circle class="led-fill joint-light" cx="${sx}" cy="322" r="4"/>
      <g class="cat-part">
        <circle cx="${sx}" cy="466" r="15" fill="#e8edf5" stroke="#5d6a80" stroke-width="3"/>
        <circle class="led-fill" cx="${sx}" cy="470" r="5"/>
        <circle class="led-fill" cx="${sx - 8}" cy="459" r="3"/>
        <circle class="led-fill" cx="${sx}" cy="455" r="3"/>
        <circle class="led-fill" cx="${sx + 8}" cy="459" r="3"/>
      </g>
      <path class="armor-part" d="M ${sx - 27} 336 Q ${sx - 25} 296 ${sx} 294 Q ${sx + 25} 296 ${sx + 27} 336 Q ${sx} 326 ${sx - 27} 336 Z" fill="url(#armor)" stroke="#ff4d6d" stroke-width="2"/>
      ${side === "right" ? `
      <g class="armor-part cannon">
        <rect x="${sx - 15}" y="436" width="30" height="44" rx="7" fill="url(#armor)" stroke="#ff4d6d" stroke-width="2"/>
        <rect x="${sx - 9}" y="474" width="18" height="12" rx="3" fill="#1a0b10" stroke="#ff4d6d" stroke-width="2"/>
        <circle class="led-fill" cx="${sx}" cy="480" r="4"/>
      </g>
      <circle class="tip" data-tip="shoulder-r" cx="${sx}" cy="322" r="1" fill="none"/>
      <circle class="tip" data-tip="hand-r" cx="${sx}" cy="486" r="1" fill="none"/>` : ""}
    </g>`;
}

/** Dạng XE ĐUA: cùng khung 400x540 để thay chỗ robot. Màn hình LED thành kính chắn gió có đôi mắt. */
const CAR_SVG = `
<svg class="car-svg" viewBox="0 0 400 540" aria-hidden="true">
  <defs>
    <linearGradient id="carBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eef3f9"/>
      <stop offset="0.5" stop-color="#9aa7ba"/>
      <stop offset="1" stop-color="#4f5b70"/>
    </linearGradient>
    <radialGradient id="carHub" cx="0.4" cy="0.4" r="0.7">
      <stop offset="0" stop-color="#c9d2df"/>
      <stop offset="1" stop-color="#4b5870"/>
    </radialGradient>
    <filter id="carGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <ellipse class="robot-shadow" cx="205" cy="522" rx="170" ry="10"/>
  <g class="car-body">
    <path class="car-flame" d="M 34 452 Q 0 446 -14 458 Q 0 470 34 466 Z" fill="#ffb03d" filter="url(#carGlow)"/>
    <path d="M 46 392 L 30 352 L 92 352 L 100 392 Z" fill="url(#carBody)" stroke="#5d6a80" stroke-width="3"/>
    <path d="M 40 472 Q 28 422 72 406 L 124 396 Q 156 344 214 340 L 270 342 Q 312 350 338 396 L 362 404 Q 384 422 374 472 Z" fill="url(#carBody)" stroke="#5d6a80" stroke-width="3"/>
    <path d="M 142 396 Q 162 356 214 352 L 264 354 Q 296 362 314 396 Z" fill="#050a14" stroke="#2f3b52" stroke-width="3"/>
    <g filter="url(#carGlow)">
      <ellipse class="led-fill car-eye" cx="232" cy="378" rx="7" ry="10"/>
      <ellipse class="led-fill car-eye" cx="268" cy="378" rx="7" ry="10"/>
    </g>
    <path class="led-fill" d="M 60 428 L 364 428 L 362 436 L 58 436 Z" opacity="0.55"/>
    <ellipse class="led-fill car-headlight" cx="364" cy="420" rx="9" ry="6" filter="url(#carGlow)"/>
    <ellipse cx="42" cy="420" rx="6" ry="5" fill="#ff3b5c" filter="url(#carGlow)"/>
    <circle class="tip" data-tip="car-front" cx="372" cy="420" r="1" fill="none"/>
    <circle class="tip" data-tip="car-back" cx="40" cy="420" r="1" fill="none"/>
    ${[112, 298].map((cx) => `
    <g class="wheel">
      <circle cx="${cx}" cy="478" r="34" fill="#11161f" stroke="#6d7a8f" stroke-width="5"/>
      <circle cx="${cx}" cy="478" r="15" fill="url(#carHub)"/>
      <path d="M ${cx - 26} 478 H ${cx + 26} M ${cx} 452 V 504" stroke="#6d7a8f" stroke-width="4" stroke-linecap="round"/>
    </g>`).join("")}
  </g>
</svg>`;

const ROBOT_SVG = `
<svg class="robot-svg" viewBox="0 0 400 540" role="img" aria-label="Robot MTD">
  <defs>
    <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eef3f9"/>
      <stop offset="0.45" stop-color="#b4bfce"/>
      <stop offset="1" stop-color="#6b788d"/>
    </linearGradient>
    <linearGradient id="metalDark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8d99ad"/>
      <stop offset="1" stop-color="#3f4a5e"/>
    </linearGradient>
    <radialGradient id="screenGrad" cx="0.5" cy="0.4" r="0.75">
      <stop offset="0" stop-color="#0d1a33"/>
      <stop offset="1" stop-color="#03060d"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="1.4" fill="#ffffff" opacity="0.05"/>
    </pattern>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="screenClip"><rect x="108" y="96" width="184" height="128" rx="34"/></clipPath>
    <linearGradient id="armor" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8a2a3f"/>
      <stop offset="1" stop-color="#2a0d17"/>
    </linearGradient>
    <linearGradient id="visor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff3b3b" stop-opacity="0.35"/>
      <stop offset="0.55" stop-color="#ff3b3b" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ff3b3b" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <ellipse class="robot-shadow" cx="200" cy="522" rx="118" ry="11"/>

  <g class="robot-sway">
    <g class="robot-breath">
      <!-- Bánh xích -->
      <rect x="122" y="462" width="156" height="46" rx="23" fill="#252d3c" stroke="#4b5870" stroke-width="3"/>
      <g class="wheels">
        ${[148, 200, 252].map((cx) => `
        <g class="wheel">
          <circle cx="${cx}" cy="485" r="14" fill="#11161f" stroke="#6d7a8f" stroke-width="3"/>
          <path d="M ${cx - 9} 485 H ${cx + 9} M ${cx} 476 V 494" stroke="#6d7a8f" stroke-width="2.5" stroke-linecap="round"/>
        </g>`).join("")}
      </g>
      <rect x="168" y="446" width="64" height="22" rx="6" fill="url(#metalDark)"/>

      <!-- Đuôi mèo máy (sau lưng, chỉ hiện ở dạng mèo) -->
      <g class="cat-part cat-tail">
        <path d="M 262 432 C 330 432 352 380 334 330" stroke="#8d99ad" stroke-width="14" fill="none" stroke-linecap="round"/>
        <path d="M 262 432 C 330 432 352 380 334 330" stroke="#c9d2df" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="6 10"/>
        <circle class="led-fill" cx="334" cy="326" r="9" filter="url(#glow)"/>
      </g>

      <!-- Thân -->
      <rect x="118" y="292" width="164" height="164" rx="44" fill="url(#metal)" stroke="#5d6a80" stroke-width="3"/>
      <path d="M 130 420 Q 200 440 270 420" stroke="#8792a6" stroke-width="2" fill="none" opacity="0.6"/>
      <circle cx="134" cy="308" r="3" fill="#6b788d"/><circle cx="266" cy="308" r="3" fill="#6b788d"/>
      <circle cx="134" cy="440" r="3" fill="#6b788d"/><circle cx="266" cy="440" r="3" fill="#6b788d"/>

      <!-- Giáp ngực (chỉ hiện ở dạng chiến binh) -->
      <path class="armor-part" d="M 132 306 L 268 306 L 276 404 L 200 440 L 124 404 Z" fill="url(#armor)" stroke="#ff4d6d" stroke-width="3"/>

      <!-- Bảng điều khiển ngực -->
      <rect x="150" y="320" width="100" height="80" rx="18" fill="#0b1220" stroke="#2f3b52" stroke-width="3"/>
      <circle class="chest-ring led-stroke" cx="200" cy="352" r="20"/>
      <circle class="chest-core led-fill" cx="200" cy="352" r="11" filter="url(#glow)"/>
      <rect class="chest-bit led-fill" x="176" y="382" width="10" height="6" rx="2"/>
      <rect class="chest-bit led-fill" x="195" y="382" width="10" height="6" rx="2"/>
      <rect class="chest-bit led-fill" x="214" y="382" width="10" height="6" rx="2"/>

      ${arm("left")}
      ${arm("right")}

      <!-- Cổ -->
      <rect x="178" y="252" width="44" height="46" rx="8" fill="url(#metalDark)"/>
      <path d="M 182 266 H 218 M 182 278 H 218 M 182 290 H 218" stroke="#2c3546" stroke-width="3"/>

      <!-- Đầu: #head-tilt do JS điều khiển (nghiêng theo ánh nhìn), .head do CSS điều khiển -->
      <g id="head-tilt">
        <g class="head">
          <g class="cat-part cat-ears">
            <path d="M 98 104 L 112 14 L 176 70 Z M 302 104 L 288 14 L 224 70 Z" fill="url(#metal)" stroke="#5d6a80" stroke-width="3" stroke-linejoin="round"/>
            <path class="led-fill" d="M 112 86 L 120 40 L 156 70 Z M 288 86 L 280 40 L 244 70 Z" opacity="0.75"/>
          </g>
          <path class="armor-part" d="M 112 84 L 86 26 L 140 66 Z M 288 84 L 314 26 L 260 66 Z" fill="url(#armor)" stroke="#ff4d6d" stroke-width="3" stroke-linejoin="round"/>
          <line x1="200" y1="62" x2="200" y2="28" stroke="#8b97ab" stroke-width="5" stroke-linecap="round"/>
          <circle class="antenna-bulb led-fill" cx="200" cy="20" r="10" filter="url(#glow)"/>

          <rect x="56" y="122" width="28" height="76" rx="12" fill="url(#metalDark)" stroke="#5d6a80" stroke-width="2"/>
          <rect x="316" y="122" width="28" height="76" rx="12" fill="url(#metalDark)" stroke="#5d6a80" stroke-width="2"/>
          <rect class="led-fill ear-light" x="64" y="146" width="12" height="28" rx="5"/>
          <rect class="led-fill ear-light" x="324" y="146" width="12" height="28" rx="5"/>

          <rect x="76" y="58" width="248" height="202" rx="66" fill="url(#metal)" stroke="#5d6a80" stroke-width="3"/>
          <path d="M 110 76 Q 150 64 200 66" stroke="#ffffff" stroke-width="6" fill="none" opacity="0.45" stroke-linecap="round"/>

          <!-- Màn hình LED -->
          <rect x="100" y="88" width="200" height="144" rx="40" fill="#1a2232"/>
          <rect x="108" y="96" width="184" height="128" rx="34" fill="url(#screenGrad)"/>
          <g clip-path="url(#screenClip)">
            <g id="matrix" class="matrix"></g>
            <g class="cheeks">
              <ellipse cx="130" cy="184" rx="13" ry="6" fill="#ff7aa8"/>
              <ellipse cx="270" cy="184" rx="13" ry="6" fill="#ff7aa8"/>
              <path class="blush-lines" d="M 122 189 l 5 -10 M 130 189 l 5 -10 M 138 189 l 5 -10 M 258 189 l 5 -10 M 266 189 l 5 -10 M 274 189 l 5 -10"/>
            </g>
            <rect class="armor-part" x="108" y="96" width="184" height="128" fill="url(#visor)"/>
            <g class="cat-part cat-face" filter="url(#glow)">
              <path class="led-stroke whisker" d="M 150 178 L 116 170 M 150 186 L 114 188 M 150 194 L 118 206 M 250 178 L 284 170 M 250 186 L 286 188 M 250 194 L 282 206"/>
              <path class="led-fill" d="M 192 172 L 208 172 L 200 181 Z"/>
            </g>
            <g id="gaze" filter="url(#glow)">
              <circle class="tip" data-tip="eye-l" cx="160" cy="148" r="1" fill="none"/>
              <circle class="tip" data-tip="eye-r" cx="240" cy="148" r="1" fill="none"/>
              <path class="armor-part led-stroke thin" d="M 136 118 L 182 130 M 264 118 L 218 130"/>
              <g class="eyes">
                ${eyeShapes(EYE_LEFT, "left")}
                ${eyeShapes(EYE_RIGHT, "right")}
              </g>
            </g>
            <g id="mouth-move" filter="url(#glow)">
              <path class="mouth mouth-smile led-stroke thin" d="M 178 186 Q 200 204 222 186"/>
              <path class="mouth mouth-flat led-stroke thin" d="M 189 194 L 211 194"/>
              <path class="mouth mouth-cat led-stroke thin" d="M 184 188 q 8 9 16 0 q 8 9 16 0"/>
              <path class="mouth mouth-wavy led-stroke thin" d="M 182 194 q 4.5 -6 9 0 t 9 0 t 9 0 t 9 0"/>
              <g class="mouth mouth-bars">${mouthBars()}</g>
            </g>
            <rect x="108" y="96" width="184" height="128" fill="url(#scan)"/>
          </g>
          <path d="M 124 106 Q 150 98 176 100" stroke="#ffffff" stroke-width="3" fill="none" opacity="0.18" stroke-linecap="round"/>
        </g>
      </g>
    </g>
  </g>
</svg>`;

const PARTICLE = {
  heart: { chars: ["❤", "💗", "❥"], cls: "p-heart" },
  note: { chars: ["♪", "♫", "♬", "♩"], cls: "p-note" },
  z: { chars: ["Z", "z", "Z"], cls: "p-z" },
  spark: { chars: ["✦", "✧", "⚡", "✦"], cls: "p-spark" },
};

const clamp = (v, min = -1, max = 1) => Math.max(min, Math.min(max, v));

// Động tác mà tay phải phải nằm phía trước đầu/thân.
const FRONT_GESTURES = new Set(["pat-head", "salute", "think"]);

export class RobotAvatar {
  constructor(stage) {
    this.stage = stage;
    stage.innerHTML = `<div class="mover"><div class="flipper"><div class="robot" data-state="idle" data-speaking="false" data-form="normal">${ROBOT_SVG}${CAR_SVG}</div></div></div>`;
    this.root = stage.querySelector(".robot");
    this.mover = stage.querySelector(".mover");
    this.flipper = stage.querySelector(".flipper");
    // Di chuyển ngang: vị trí chuẩn hoá -1 (mép trái) .. 0 (giữa) .. 1 (mép phải)
    this.pos = 0;
    this.targetPos = 0;
    this.speed = 0.012; // quãng đường mỗi khung hình
    this.moveResolve = null;
    this.acrobatics = false; // đang nhào lộn
    this.form = "normal";
    this.transforming = false;
    this.gaze = stage.querySelector("#gaze");
    this.mouthMove = stage.querySelector("#mouth-move");
    this.headTilt = stage.querySelector("#head-tilt");
    this.bars = [...stage.querySelectorAll(".mouth-bar")];
    this.matrix = stage.querySelector("#matrix");
    this.state = "idle";
    this.speaking = false;
    this.target = { x: 0, y: 0 };
    this.current = { x: 0, y: 0 };
    this.lastLookAt = 0;
    this.lastMouth = 0;
    this.levelSource = null; // hàm trả về âm lượng 0..1 (hoặc null) để nhép miệng theo giọng thật
    // Chế độ bắt chước
    this.mimic = false;
    this.mimicTarget = { headRoll: 0, leftArm: 0, rightArm: 0, mouthOpen: 0, blink: 0, smile: 0 };
    this.mimicNow = { headRoll: 0, leftArm: 0, rightArm: 0 };
    this.armLeft = stage.querySelector(".arm-left");
    this.armRight = stage.querySelector(".arm-right");
    this.armRightNext = this.armRight.nextSibling; // vị trí gốc trong thứ tự vẽ
    this.buildMatrix();
    this.startLoops();
  }

  setState(state) {
    if (!STATES.includes(state)) state = "idle";
    if (state === this.state) return;
    this.state = state;
    this.root.dataset.state = state;
  }

  setSpeaking(on) {
    this.speaking = on;
    this.root.dataset.speaking = String(on);
  }

  /** Diễn một động tác (xem các data-gesture trong styles.css) trong `ms` mili-giây. */
  playGesture(name, ms = 3000) {
    clearTimeout(this.gestureTimer);
    this.root.dataset.gesture = name;
    // SVG không có z-index: phần tử vẽ SAU sẽ nằm TRÊN. Các động tác đưa tay lên trước mặt/đầu
    // cần chuyển tay phải xuống cuối để không bị đầu che mất.
    if (FRONT_GESTURES.has(name)) this.armRight.parentNode.appendChild(this.armRight);
    else this.restoreArmOrder();
    this.gestureTimer = setTimeout(() => {
      delete this.root.dataset.gesture;
      this.restoreArmOrder();
    }, ms);
  }

  /**
   * Chế độ nhảy: bật data-gesture="hiphop" và đặt độ dài một phách cho CSS.
   * Gọi setMove(tên) ở mỗi phách để đổi động tác (xem các data-move trong styles.css).
   */
  startDance(beatSeconds) {
    clearTimeout(this.gestureTimer);
    this.restoreArmOrder();
    this.root.style.setProperty("--beat", `${beatSeconds}s`);
    this.root.dataset.gesture = "hiphop";
  }

  setMove(name) {
    this.root.dataset.move = name;
  }

  stopDance() {
    if (this.root.dataset.gesture === "hiphop") delete this.root.dataset.gesture;
    delete this.root.dataset.move;
  }

  // ------------------------------------------------------------------
  // DI CHUYỂN & NHÀO LỘN
  // ------------------------------------------------------------------

  /** Quãng đường tối đa (px) robot được đi từ giữa sang mỗi bên, tính theo khung sân khấu. */
  moveRange() {
    const wrap = this.stage.parentElement;
    if (!wrap) return 0;
    return Math.max(0, (wrap.clientWidth - this.stage.clientWidth) / 2 - 8);
  }

  /** Lăn bánh tới vị trí x (-1..1). `speed` nhỏ = đi chậm. Trả về Promise khi tới nơi. */
  moveTo(x, speed = 0.012) {
    this.targetPos = Math.max(-1, Math.min(1, x));
    this.speed = speed;
    this.moveResolve?.();
    return new Promise((resolve) => (this.moveResolve = resolve));
  }

  /** Đi theo một vị trí (ví dụ khuôn mặt người dùng) thật chậm — dùng khi rảnh. */
  follow(x) {
    if (this.moveResolve || this.acrobatics) return; // đang thực hiện lệnh di chuyển khác
    const target = Math.max(-0.7, Math.min(0.7, x));
    // Vùng chết: vị trí mặt từ camera luôn dao động nhẹ (nhiễu). Chỉ lăn theo khi người dùng
    // dịch chuyển rõ ràng, nếu không robot sẽ nhích qua nhích lại liên tục trông như bị rung.
    if (Math.abs(target - this.targetPos) < 0.2) return;
    this.targetPos = target;
    this.speed = 0.0035;
  }

  /** Chạy các khung hình nhào lộn (Web Animations API) trên lớp .flipper. */
  async acrobat(keyframes, duration) {
    this.acrobatics = true;
    try {
      await this.flipper.animate(keyframes, { duration, easing: "ease-in-out" }).finished;
    } catch {
      // bị huỷ giữa chừng
    }
    this.acrobatics = false;
  }

  /** Lộn vòng ra sau (xoay quanh trục ngang, có phối cảnh 3D): ngồi xuống lấy đà -> bật lên lộn -> tiếp đất nhún. */
  flip() {
    return this.acrobat(
      [
        { transform: "perspective(900px) translateY(0) rotateX(0deg) scaleY(1)" },
        { transform: "perspective(900px) translateY(6%) rotateX(0deg) scaleY(0.82)", offset: 0.15 },
        { transform: "perspective(900px) translateY(-45%) rotateX(-170deg) scaleY(1)", offset: 0.5 },
        { transform: "perspective(900px) translateY(-12%) rotateX(-340deg) scaleY(1)", offset: 0.75 },
        { transform: "perspective(900px) translateY(5%) rotateX(-360deg) scaleY(0.86)", offset: 0.88 },
        { transform: "perspective(900px) translateY(0) rotateX(-360deg) scaleY(1)" },
      ],
      1500
    );
  }

  /** Lộn ngang kiểu bánh xe: vừa xoay tròn vừa lăn sang một bên. */
  async cartwheel(direction = 1) {
    const to = Math.abs(this.pos + direction * 0.8) <= 1 ? this.pos + direction * 0.8 : this.pos - direction * 0.8;
    const sign = to > this.pos ? 1 : -1;
    this.moveTo(to, 0.016);
    await this.acrobat(
      [
        { transform: "translateY(0) rotate(0deg)" },
        { transform: `translateY(-30%) rotate(${sign * 180}deg)`, offset: 0.5 },
        { transform: `translateY(0) rotate(${sign * 360}deg)` },
      ],
      1100
    );
  }

  /** Xoay người một vòng (quay lưng lại rồi quay mặt ra). */
  spinAround() {
    return this.acrobat(
      [
        { transform: "perspective(900px) rotateY(0deg)" },
        { transform: "perspective(900px) rotateY(180deg) scale(0.96)", offset: 0.5 },
        { transform: "perspective(900px) rotateY(360deg)" },
      ],
      1300
    );
  }

  /** Nhảy lên cao rồi tiếp đất. */
  jump() {
    return this.acrobat(
      [
        { transform: "translateY(0) scaleY(1)" },
        { transform: "translateY(5%) scaleY(0.84)", offset: 0.18 },
        { transform: "translateY(-38%) scaleY(1.06)", offset: 0.5 },
        { transform: "translateY(4%) scaleY(0.88)", offset: 0.85 },
        { transform: "translateY(0) scaleY(1)" },
      ],
      900
    );
  }

  /** Chạy một vòng quanh sân khấu: sang trái, sang phải, rồi về giữa. */
  async patrol() {
    await this.moveTo(-1, 0.018);
    await this.moveTo(1, 0.018);
    await this.jump();
    await this.moveTo(0, 0.018);
  }

  /** Lăn lại gần (về giữa và phóng to một chút như đang tiến về phía người dùng). */
  async comeCloser() {
    await this.moveTo(0, 0.02);
    await this.acrobat(
      [{ transform: "scale(1)" }, { transform: "scale(1.12)", offset: 0.3 }, { transform: "scale(1.12)", offset: 0.8 }, { transform: "scale(1)" }],
      2600
    );
  }

  // ------------------------------------------------------------------
  // BIẾN HÌNH
  // ------------------------------------------------------------------

  /**
   * Biến hình sang `form` ("normal" | "battle" | "car"):
   * 1) thu gọn các bộ phận + xoay tít + sáng loá, 2) đổi dạng, 3) bung ra trong ánh chớp.
   */
  async transformTo(form) {
    if (form === this.form || this.transforming) return;
    this.transforming = true;
    this.acrobatics = true;
    this.root.classList.add("transforming"); // CSS: đầu thụt xuống, tay gập lại
    this.spawn("spark", 6);
    const fold = [
      { transform: "perspective(900px) scale(1) rotateY(0deg)", filter: "brightness(1)" },
      { transform: "perspective(900px) scale(0.55) rotateY(360deg)", filter: "brightness(2.4)" },
    ];
    await this.flipper.animate(fold, { duration: 900, easing: "ease-in" }).finished.catch(() => {});
    this.form = form;
    this.root.dataset.form = form;
    this.flash();
    this.spawn("spark", 8);
    await this.flipper
      .animate(
        [
          { transform: "perspective(900px) scale(0.55) rotateY(360deg)", filter: "brightness(2.4)" },
          { transform: "perspective(900px) scale(1.12) rotateY(720deg)", filter: "brightness(1.4)", offset: 0.7 },
          { transform: "perspective(900px) scale(1) rotateY(720deg)", filter: "brightness(1)" },
        ],
        { duration: 900, easing: "ease-out" }
      )
      .finished.catch(() => {});
    this.root.classList.remove("transforming"); // các bộ phận bung ra lại (có hiệu ứng chuyển tiếp)
    this.acrobatics = false;
    this.transforming = false;
  }

  /** Chớp sáng toàn sân khấu. */
  flash() {
    const el = document.createElement("div");
    el.className = "stage-flash";
    el.addEventListener("animationend", () => el.remove());
    this.stage.appendChild(el);
  }

  /** Toạ độ màn hình (px) của một điểm mốc trên robot, ví dụ "eye-l", "hand-r", "car-front". */
  tip(name) {
    const el = this.root.querySelector(`[data-tip="${name}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** Cập nhật vị trí ngang mỗi khung hình (gọi trong vòng lặp hoạt ảnh). */
  updateMovement() {
    const dx = this.targetPos - this.pos;
    const step = Math.sign(dx) * Math.min(Math.abs(dx), this.speed);
    this.pos += step;
    this.mover.style.transform = `translateX(${(this.pos * this.moveRange()).toFixed(1)}px)`;
    // Đang lăn đủ nhanh -> bánh quay, thân nghiêng theo hướng đi.
    // Chỉ bật hiệu ứng lăn (bánh quay + ngả thân) khi chạy nhanh theo lệnh; đi theo chậm thì lăn êm.
    const rolling = this.speed >= 0.01 && Math.abs(step) > 0.002 ? (step > 0 ? "right" : "left") : null;
    if (rolling) {
      this.root.dataset.rolling = rolling;
      this.root.dataset.facing = rolling; // dạng xe: quay đầu theo hướng chạy
    }
    else delete this.root.dataset.rolling;
    if (Math.abs(this.targetPos - this.pos) < 0.001 && this.moveResolve) {
      const resolve = this.moveResolve;
      this.moveResolve = null;
      resolve();
    }
  }

  restoreArmOrder() {
    if (this.armRight.nextSibling !== this.armRightNext) {
      this.armRight.parentNode.insertBefore(this.armRight, this.armRightNext);
    }
  }

  /** Bật/tắt chế độ bắt chước. Khi bật, hoạt ảnh tay mặc định bị tắt để tay đi theo người dùng. */
  setMimic(on) {
    this.mimic = on;
    this.root.dataset.mimic = String(on);
    if (!on) {
      this.armLeft.style.transform = "";
      this.armRight.style.transform = "";
      this.root.classList.remove("blink");
      this.mimicNow = { headRoll: 0, leftArm: 0, rightArm: 0 };
    }
  }

  /** Nhận dữ liệu từ camera: { headRoll, leftArm, rightArm (độ), mouthOpen, blink, smile (0..1) }. */
  applyMimic(data) {
    this.mimicTarget = { ...this.mimicTarget, ...data };
  }

  /** x, y trong khoảng [-1, 1]: hướng mắt liếc tới (âm = trái / lên). */
  lookAt(x, y) {
    // Lọc nhiễu: trộn 25% vị trí mới với 75% vị trí cũ để mắt và đầu không giật theo từng khung hình camera.
    this.target = {
      x: this.target.x * 0.75 + clamp(x) * 0.25,
      y: this.target.y * 0.75 + clamp(y) * 0.25,
    };
    this.lastLookAt = performance.now();
  }

  /** Thả hiệu ứng bay lên: "heart" | "note" | "z". */
  spawn(type, count = 1) {
    const def = PARTICLE[type];
    if (!def) return;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const el = document.createElement("span");
        el.className = `particle ${def.cls}`;
        el.textContent = def.chars[Math.floor(Math.random() * def.chars.length)];
        const fromHead = type === "z";
        el.style.left = `${(fromHead ? 62 : 30) + Math.random() * (fromHead ? 20 : 40)}%`;
        el.style.top = `${fromHead ? 12 : 30 + Math.random() * 20}%`;
        el.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
        el.style.fontSize = `${18 + Math.random() * 18}px`;
        el.addEventListener("animationend", () => el.remove());
        this.stage.appendChild(el);
      }, i * 180);
    }
  }

  buildMatrix() {
    const ns = "http://www.w3.org/2000/svg";
    this.matrixRows = [];
    for (let i = 0; i < 9; i++) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", "112");
      t.setAttribute("y", String(110 + i * 14));
      t.setAttribute("class", "matrix-row");
      this.matrix.appendChild(t);
      this.matrixRows.push(t);
    }
  }

  startLoops() {
    // Vòng lặp hoạt ảnh: mắt liếc mượt, miệng nhép, ma trận số.
    const frame = (now) => {
      requestAnimationFrame(frame);
      this.updateMovement();

      // Không có ai để nhìn trong 4 giây -> mắt tự đảo nhẹ cho sinh động.
      if (now - this.lastLookAt > 4000 && Math.random() < 0.01) {
        this.target = { x: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 0.6 };
      }
      const target = this.state === "sleeping" ? { x: 0, y: 0.4 } : this.state === "shy" ? { x: -0.7, y: 0.55 } : this.target;
      this.current.x += (target.x - this.current.x) * 0.12;
      this.current.y += (target.y - this.current.y) * 0.12;
      const gx = this.current.x;
      const gy = this.current.y;
      this.gaze.setAttribute("transform", `translate(${(gx * 16).toFixed(2)} ${(gy * 10).toFixed(2)})`);
      this.mouthMove.setAttribute("transform", `translate(${(gx * 7).toFixed(2)} ${(gy * 4).toFixed(2)})`);
      if (this.mimic) {
        // Làm mượt chuyển động để robot không bị giật theo từng khung hình camera.
        const t = this.mimicTarget;
        const n = this.mimicNow;
        n.headRoll += (Math.max(-28, Math.min(28, t.headRoll)) - n.headRoll) * 0.25;
        n.leftArm += (Math.max(-20, Math.min(175, t.leftArm)) - n.leftArm) * 0.3;
        n.rightArm += (Math.max(-175, Math.min(20, t.rightArm)) - n.rightArm) * 0.3;
        this.headTilt.setAttribute("transform", `rotate(${n.headRoll.toFixed(2)} 200 250)`);
        this.armLeft.style.transform = `rotate(${n.leftArm.toFixed(1)}deg)`;
        this.armRight.style.transform = `rotate(${n.rightArm.toFixed(1)}deg)`;
        this.root.classList.toggle("blink", t.blink > 0.5);
        if (!this.speaking) this.setState(t.smile > 0.45 ? "greeting" : "idle");
      } else {
        this.headTilt.setAttribute("transform", `rotate(${(gx * 4).toFixed(2)} 200 250)`);
      }

      if (now - this.lastMouth > 85) {
        this.lastMouth = now;
        // Có âm lượng thật (giọng Piper) thì nhép theo âm lượng, không thì giả lập ngẫu nhiên.
        const real = this.levelSource ? this.levelSource() : null;
        this.bars.forEach((bar, i) => {
          // Thanh giữa cao hơn hai bên, giống hình sóng âm.
          const center = 1 - Math.abs(i - 3) / 4;
          const level = real ?? Math.random();
          const jitter = real === null ? 1 : 0.75 + Math.random() * 0.5;
          let h = this.speaking ? 4 + level * jitter * 24 * (0.45 + center * 0.55) : 4;
          // Bắt chước: há miệng thì miệng LED mở theo.
          if (this.mimic && !this.speaking) h = 4 + Math.min(1, this.mimicTarget.mouthOpen * 1.6) * 26 * (0.5 + center * 0.5);
          bar.setAttribute("height", h.toFixed(1));
          bar.setAttribute("y", (192 - h / 2).toFixed(1));
        });
        if (this.state === "calculating") {
          for (const row of this.matrixRows) {
            let s = "";
            for (let k = 0; k < 22; k++) s += Math.random() < 0.5 ? Math.floor(Math.random() * 10) : " ";
            row.textContent = s;
          }
        }
      }
    };
    requestAnimationFrame(frame);

    // Chớp mắt ngẫu nhiên.
    const blink = () => {
      if (this.state === "idle" || this.state === "talking") {
        this.root.classList.add("blink");
        setTimeout(() => this.root.classList.remove("blink"), 170);
      }
      setTimeout(blink, 2500 + Math.random() * 3500);
    };
    setTimeout(blink, 2000);

    // Hiệu ứng bay theo trạng thái.
    setInterval(() => {
      if (document.hidden) return;
      if (this.state === "sleeping") this.spawn("z");
      else if (this.state === "singing") this.spawn("note", 2);
      else if (this.state === "comforting") this.spawn("heart");
    }, 1100);
  }
}
