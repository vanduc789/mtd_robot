// fx.js — Hiệu ứng LAZE của MTD (laze đồ chơi, chỉ là ánh sáng trên màn hình 😄)
// Tia laze là một thẻ <div> dài, xoay theo góc bắn. Mỗi khung hình tính lại điểm đầu (mắt / tay / đèn xe)
// nên tia vẫn bám đúng chỗ khi robot đang di chuyển hay nhào lộn.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Góc (độ) và độ dài (px) của đoạn thẳng từ a tới b. Hàm thuần — kiểm thử được bằng Node. */
export function beamGeometry(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { length: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/** Kéo dài tia từ `from` theo hướng `dir` (từ điểm `back` tới `from`) thêm `distance` px. */
export function extend(back, from, distance) {
  const dx = from.x - back.x;
  const dy = from.y - back.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / len) * distance, y: from.y + (dy / len) * distance };
}

export class LaserFX {
  constructor(robot) {
    this.robot = robot;
    this.layer = document.createElement("div");
    this.layer.className = "fx-layer";
    document.body.appendChild(this.layer);
    this.firing = false;
  }

  makeBeam(color, thickness) {
    const beam = document.createElement("div");
    beam.className = "laser-beam";
    beam.style.setProperty("--laser", color);
    beam.style.height = `${thickness}px`;
    const hit = document.createElement("div");
    hit.className = "laser-hit";
    hit.style.setProperty("--laser", color);
    this.layer.append(beam, hit);
    return { beam, hit };
  }

  placeBeam({ beam, hit }, from, to) {
    const { length, angle } = beamGeometry(from, to);
    beam.style.left = `${from.x}px`;
    beam.style.top = `${from.y}px`;
    beam.style.width = `${length}px`;
    beam.style.transform = `translateY(-50%) rotate(${angle}deg)`;
    hit.style.left = `${to.x}px`;
    hit.style.top = `${to.y}px`;
  }

  /** Tia lửa văng ra ở điểm trúng. */
  sparks(at, color, count = 3) {
    for (let i = 0; i < count; i++) {
      const s = document.createElement("div");
      s.className = "laser-spark";
      s.style.setProperty("--laser", color);
      s.style.left = `${at.x}px`;
      s.style.top = `${at.y}px`;
      s.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
      s.style.setProperty("--dy", `${-20 - Math.random() * 70}px`);
      s.addEventListener("animationend", () => s.remove());
      this.layer.appendChild(s);
    }
  }

  /** Vết cháy xém để lại trên "mặt sàn", mờ dần. */
  scorch(at) {
    const el = document.createElement("div");
    el.className = "laser-scorch";
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    el.addEventListener("animationend", () => el.remove());
    this.layer.appendChild(el);
  }

  /**
   * Bắn laze trong `duration` ms.
   * - "eyes": hai tia từ mắt quét dọc mặt sàn trước mặt robot.
   * - "cannon": một tia lớn từ pháo tay phải, bắn thẳng theo hướng cánh tay.
   * - "car": tia từ đèn pha xe, bắn thẳng về phía trước.
   */
  async fire({ mode = "eyes", color = "#3de8ff", duration = 1600 } = {}) {
    if (this.firing) return;
    this.firing = true;
    const stage = this.robot.stage.getBoundingClientRect();
    const floorY = Math.min(window.innerHeight - 20, stage.bottom + 10);
    const beams = mode === "eyes" ? [this.makeBeam(color, 7), this.makeBeam(color, 7)] : [this.makeBeam(color, mode === "cannon" ? 18 : 12)];
    const start = performance.now();
    let lastSpark = 0;

    await new Promise((resolve) => {
      const frame = (now) => {
        const t = Math.min(1, (now - start) / duration);
        if (mode === "eyes") {
          // Điểm trúng quét từ trái sang phải dọc mặt sàn.
          const sweepX = stage.left - 80 + (stage.width + 160) * t;
          const targets = [{ x: sweepX - 30, y: floorY }, { x: sweepX + 30, y: floorY }];
          ["eye-l", "eye-r"].forEach((name, i) => {
            const from = this.robot.tip(name);
            if (from) this.placeBeam(beams[i], from, targets[i]);
          });
          if (now - lastSpark > 70) {
            lastSpark = now;
            this.sparks(targets[0], color, 2);
            this.scorch({ x: sweepX, y: floorY });
          }
        } else {
          const [back, from] = mode === "cannon" ? [this.robot.tip("shoulder-r"), this.robot.tip("hand-r")] : [this.robot.tip("car-back"), this.robot.tip("car-front")];
          if (back && from) {
            const to = extend(back, from, Math.max(window.innerWidth, 900));
            // Điểm trúng: chỗ tia ra khỏi mép màn hình (kẹp vào trong để thấy được vụ nổ).
            const hitPoint = { x: Math.max(12, Math.min(window.innerWidth - 12, to.x)), y: Math.max(12, Math.min(window.innerHeight - 12, to.y)) };
            this.placeBeam(beams[0], from, hitPoint);
            if (now - lastSpark > 60) {
              lastSpark = now;
              this.sparks(hitPoint, color, 4);
            }
          }
        }
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });

    // Tắt tia: mờ dần rồi xoá.
    for (const { beam, hit } of beams) {
      beam.classList.add("off");
      hit.classList.add("off");
    }
    await wait(250);
    for (const { beam, hit } of beams) {
      beam.remove();
      hit.remove();
    }
    this.firing = false;
  }
}
