// face-id.js — "Trí nhớ khuôn mặt" của MTD
// Dùng thư viện mã nguồn mở @vladmandic/face-api (MIT, tải qua CDN) để:
//   - biến mỗi khuôn mặt thành một "dấu vân tay số" gồm 128 con số (descriptor),
//   - so sánh với các khuôn mặt đã nhớ để biết đó là Đức, bạn của Đức hay người lạ,
//   - đọc biểu cảm chi tiết hơn: giận, ngạc nhiên, sợ hãi...
// Hai khuôn mặt càng giống nhau thì khoảng cách giữa hai descriptor càng nhỏ.

const FACEAPI_VERSION = "1.7.14";
const FACEAPI_BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACEAPI_VERSION}`;
const STORE_KEY = "mtd.faces.v1";

/** Khoảng cách nhỏ hơn ngưỡng này = cùng một người (face-api khuyên 0.6; để 0.5 cho chắc chắn hơn). */
export const MATCH_THRESHOLD = 0.5;
const MAX_SAMPLES = 25; // số mẫu tối đa lưu cho mỗi người

// Biểu cảm của face-api -> tên cảm xúc dùng trong MTD.
const EXPRESSION_MAP = {
  neutral: "neutral",
  happy: "happy",
  sad: "sad",
  angry: "angry",
  disgusted: "angry",
  fearful: "scared",
  surprised: "surprised",
};

/** Khoảng cách Euclid giữa hai descriptor. */
export function faceDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Sổ ghi nhớ khuôn mặt (không phụ thuộc trình duyệt nên kiểm thử được bằng Node).
 * Mỗi người: { id, name, isOwner, descriptors: number[][] }
 */
export class FaceBook {
  constructor(people = []) {
    this.people = people;
  }

  static load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return new FaceBook(Array.isArray(data.people) ? data.people : []);
    } catch {
      return new FaceBook();
    }
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ people: this.people }));
    } catch {
      // trình duyệt chặn lưu trữ -> chỉ nhớ trong phiên này
    }
  }

  owner() {
    return this.people.find((p) => p.isOwner) || null;
  }

  friends() {
    return this.people.filter((p) => !p.isOwner);
  }

  /** Tìm người giống nhất. Trả về { person, distance } hoặc null nếu là người lạ. */
  match(descriptor, threshold = MATCH_THRESHOLD) {
    let best = null;
    for (const person of this.people) {
      for (const sample of person.descriptors) {
        const distance = faceDistance(descriptor, sample);
        if (!best || distance < best.distance) best = { person, distance };
      }
    }
    return best && best.distance < threshold ? best : null;
  }

  /** Lưu một người mới (hoặc ghi đè chủ nhân nếu isOwner). Trả về người vừa lưu. */
  addPerson(name, descriptors, isOwner = false) {
    const clean = descriptors.map(compact);
    if (isOwner) {
      this.people = this.people.filter((p) => !p.isOwner);
    } else {
      // Đã có người trùng tên -> gộp mẫu vào người đó.
      const same = this.people.find((p) => !p.isOwner && p.name.toLowerCase() === name.toLowerCase());
      if (same) {
        same.descriptors = [...same.descriptors, ...clean].slice(-MAX_SAMPLES);
        return same;
      }
    }
    const person = { id: `p${Date.now().toString(36)}`, name, isOwner, descriptors: clean.slice(-MAX_SAMPLES) };
    this.people.push(person);
    return person;
  }

  /** Thêm mẫu mới cho người đã quen (giúp nhận ra trong nhiều điều kiện ánh sáng khác nhau). */
  addSample(person, descriptor) {
    person.descriptors.push(compact(descriptor));
    if (person.descriptors.length > MAX_SAMPLES) person.descriptors.shift();
  }

  renameOwner(name) {
    const owner = this.owner();
    if (owner) owner.name = name;
  }

  clear() {
    this.people = [];
  }
}

/** Làm tròn 4 chữ số để lưu gọn trong localStorage. */
function compact(descriptor) {
  return Array.from(descriptor, (v) => Math.round(v * 10000) / 10000);
}

/** Bộ nhận diện chạy trên khung hình video. */
export class FaceID {
  constructor(video) {
    this.video = video;
    this.api = null;
    this.ready = false;
    this.busy = false;
  }

  async load() {
    const api = await import(/* @vite-ignore */ `${FACEAPI_BASE}/dist/face-api.esm.js`);
    try {
      await api.tf.setBackend("webgl");
    } catch {
      // không có WebGL -> để tfjs tự chọn (CPU/wasm)
    }
    await api.tf.ready();
    const models = `${FACEAPI_BASE}/model`;
    await Promise.all([
      api.nets.tinyFaceDetector.loadFromUri(models),
      api.nets.faceLandmark68Net.loadFromUri(models),
      api.nets.faceRecognitionNet.loadFromUri(models),
      api.nets.faceExpressionNet.loadFromUri(models),
    ]);
    this.api = api;
    this.options = new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    this.ready = true;
  }

  /**
   * Quét khung hình hiện tại. Trả về danh sách khuôn mặt:
   * { descriptor: Float32Array, expression: "happy" | "angry" | ..., expressionScore, box, size }
   */
  async scan() {
    if (!this.ready || this.busy || this.video.readyState < 2) return [];
    this.busy = true;
    try {
      const results = await this.api
        .detectAllFaces(this.video, this.options)
        .withFaceLandmarks()
        .withFaceExpressions()
        .withFaceDescriptors();
      return results.map((r) => {
        let label = "neutral";
        let score = 0;
        for (const [name, value] of Object.entries(r.expressions)) {
          if (value > score) {
            label = name;
            score = value;
          }
        }
        const box = r.detection.box;
        return {
          descriptor: r.descriptor,
          expression: EXPRESSION_MAP[label] || "neutral",
          expressionScore: score,
          box,
          size: box.width * box.height,
        };
      });
    } finally {
      this.busy = false;
    }
  }
}
