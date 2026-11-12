// app.js — Bộ điều phối trung tâm: nối Thị giác + Giọng nói + Bộ não + Avatar thành một robot "rảnh tay".

import { RobotAvatar } from "./robot-avatar.js";
import { SoundEngine, Voice, Listener, fitNotes, isEchoOf } from "./audio-voice.js";
import { Vision } from "./vision.js";
import {
  Brain,
  loadSettings,
  saveSettings,
  timeGreeting,
  faceComfortLine,
  happyFaceLine,
  MOOD_LABELS,
  DEFAULT_MODELS,
  KEYLESS_PROVIDERS,
  STORIES,
  extractName,
} from "./brain.js";
import { LOCAL_MODELS, webgpuSupported } from "./local-llm.js";
import { NeuralVoice } from "./neural-voice.js";
import { FaceBook, FaceID, MATCH_THRESHOLD } from "./face-id.js";
import { NLP, MemoryStore, isMemorable, isKnowledgeQuestion, searchWikipedia } from "./nlp.js";
import { LaserFX } from "./fx.js";
import { WhisperListener } from "./stt.js";

const $ = (selector) => document.querySelector(selector);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ABSENT_LIMIT_MS = 3 * 60 * 1000; // vắng 3 phút -> ngủ gật
const COMFORT_COOLDOWN_MS = 2 * 60 * 1000; // không an ủi liên tục
const HAPPY_COOLDOWN_MS = 5 * 60 * 1000;
const HISTORY_KEY = "mtd.chat.v1";

// ----------------------------------------------------------------------
// KHỞI TẠO CÁC MODULE
// ----------------------------------------------------------------------

const settings = loadSettings();
const robot = new RobotAvatar($("#robot-stage"));
const sound = new SoundEngine();
const voice = new Voice();
// Hai bộ nhận dạng giọng nói:
//  - webListener: của trình duyệt (Edge/Chrome, cần mạng) — dùng ngay khi khởi động;
//  - whisperListener: PhoWhisper chạy trong server.py trên máy — chính xác hơn với tiếng Việt,
//    tải xong thì MTD tự chuyển sang dùng nó.
// `listener` là "công tắc" trỏ tới bộ đang dùng, các phần khác của app chỉ gọi listener.pause()/resume().
const webListener = new Listener("vi-VN");
const whisperListener = new WhisperListener();
const listener = {
  engine: webListener,
  get supported() {
    return this.engine.supported;
  },
  start() {
    this.engine.start();
  },
  pause() {
    this.engine.pause();
  },
  resume() {
    this.engine.resume();
  },
};
const brain = new Brain(settings);
let vision = null;
const nlp = new NLP(); // embedding + bộ phân loại học máy (chạy trong trình duyệt)
const memory = new MemoryStore(); // trí nhớ dài hạn (RAG)

voice.rate = settings.rate;
voice.pitch = settings.pitch;
voice.selectVoice(settings.voiceURI);
voice.engine = settings.voiceEngine || "auto";

// Giọng AI Piper dùng chung AudioContext với nhạc/hiệu ứng.
const neuralVoice = new NeuralVoice(() => {
  sound.unlock();
  return sound.ctx;
});
voice.useNeural(neuralVoice);
robot.levelSource = () => voice.getLevel();

// Giọng Piper luôn được tải (kể cả khi nói bằng giọng Edge) vì cần nó để HÁT đúng nốt nhạc.
function loadNeuralVoice() {
  if (neuralVoice.ready) {
    setChip("#st-voice", `Giọng: ${voice.engineLabel()}`, "ok");
    return;
  }
  if (neuralVoice.status === "loading") return;
  neuralVoice.onProgress = (p) => setChip("#st-voice", `Giọng AI: đang tải ${Math.round(p * 100)}%`, "info");
  neuralVoice
    .load()
    .then(() => setChip("#st-voice", `Giọng: ${voice.engineLabel()}`, "ok"))
    .catch((err) => {
      console.warn(err);
      setChip("#st-voice", `Giọng: ${voice.engineLabel()}`, "info");
      addSystemNote(`⚠ Không tải được giọng AI Piper (${err.message}). MTD dùng giọng của trình duyệt.`);
    });
}

const app = {
  booted: false,
  mode: "normal", // normal | singing | lullaby
  present: false,
  everSeen: false,
  lastSeen: Date.now(),
  dozing: false,
  cameraOk: false,
  faceMood: "neutral",
  lastComfortAt: 0,
  lastHappyAt: 0,
  sayToken: 0,
  requestId: 0, // mỗi câu người dùng nói có một số thứ tự; câu cũ hơn thì bỏ kết quả
  songAbort: false,
  warmTimer: null,
  subtitleTimer: null,
  shownNotices: new Set(),
  mimic: false,
  lastPetAt: 0,
  danceAbort: false,
  // Nhận diện khuôn mặt
  faceIdReady: false,
  viewer: null, // { kind: "owner" | "friend" | "stranger" | "group", names: [...] }
  enroll: null, // đang ghi nhớ khuôn mặt: { target, samples, until, auto }
  askingName: null, // vừa hỏi tên người lạ: { descriptors, until }
  pendingGreet: null, // chờ nhận ra là ai rồi mới chào: { returning, timer }
  strangerStreak: 0,
  lastStrangerGreetAt: 0,
  sessionStrangers: [], // người lạ đã chào trong phiên này (để không chào lặp lại)
  greetedAt: new Map(), // tên -> thời điểm chào gần nhất
  lastEnrichAt: 0,
  faceExpr: "neutral", // biểu cảm chi tiết từ face-api (giận, ngạc nhiên, sợ...)
  exprStreak: { label: "neutral", count: 0 },
  lastExprAt: {},
};

// ----------------------------------------------------------------------
// KHUNG CHAT + LỊCH SỬ (localStorage)
// ----------------------------------------------------------------------

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

let chatHistory = loadHistory();

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory.slice(-40)));
  } catch {
    // bỏ qua nếu trình duyệt chặn lưu trữ
  }
}

function renderMessage({ role, text, t }) {
  const log = $("#chat-log");
  const row = document.createElement("div");
  row.className = `msg msg-${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const meta = document.createElement("div");
  meta.className = "meta";
  const time = new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  meta.textContent = role === "user" ? `Cậu · ${time}` : role === "mtd" ? `MTD · ${time}` : time;
  row.append(bubble, meta);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function addMessage(role, text) {
  const message = { role, text, t: Date.now() };
  renderMessage(message);
  if (role !== "system") {
    chatHistory.push(message);
    chatHistory = chatHistory.slice(-40);
    persistHistory();
  }
}

function addSystemNote(text) {
  addMessage("system", text);
}

/** Bong bóng chat "đang viết" — chữ hiện dần trong lúc AI suy nghĩ. */
function createLiveMessage() {
  const log = $("#chat-log");
  const row = document.createElement("div");
  row.className = "msg msg-mtd live";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  row.appendChild(bubble);
  log.appendChild(row);
  return {
    update(text) {
      bubble.textContent = text;
      log.scrollTop = log.scrollHeight;
    },
    remove() {
      row.remove();
    },
  };
}

chatHistory.forEach(renderMessage);
brain.seedHistory(chatHistory);

// ----------------------------------------------------------------------
// TRẠNG THÁI GIAO DIỆN
// ----------------------------------------------------------------------

function setChip(id, text, level = "ok") {
  const chip = $(id);
  chip.querySelector(".chip-text").textContent = text;
  chip.dataset.level = level;
}

function refreshBrainChip() {
  if (settings.provider === "local" && brain.local.status === "loading") return; // đang hiện % tải
  setChip("#st-brain", `Não: ${brain.providerLabel()}`, brain.hasAI() ? "ok" : "info");
}

// ----------------------------------------------------------------------
// NÃO AI CỤC BỘ — tải ngay khi mở trang (không cần chờ người dùng nhấn)
// ----------------------------------------------------------------------

brain.local.onProgress = (progress, text) => {
  const percent = Math.round(progress * 100);
  setChip("#st-brain", `Não AI: đang tải ${percent}%`, "info");
  $("#brain-progress").style.width = `${percent}%`;
  $("#brain-progress").parentElement.title = text;
};

function startLocalBrain() {
  if (settings.provider !== "local") return;
  if (!webgpuSupported()) {
    addSystemNote("⚠ Trình duyệt không hỗ trợ WebGPU nên không chạy được não AI cục bộ. Hãy dùng Edge/Chrome bản mới, hoặc chọn nhà cung cấp khác trong ⚙.");
    refreshBrainChip();
    return;
  }
  $("#brain-loader").classList.add("show");
  const cached = brain.local.ready;
  brain
    .warmUp()
    .then(() => {
      $("#brain-loader").classList.remove("show");
      refreshBrainChip();
      if (cached) return;
      addSystemNote("🧠 Não AI cục bộ đã sẵn sàng — giờ cậu nói gì MTD cũng hiểu và trò chuyện tự do được rồi!");
      if (app.booted && app.mode === "normal" && !voice.speaking) {
        say("Bíp bíp! Tớ vừa nâng cấp bộ não xong. Giờ cậu muốn nói chuyện gì cũng được, tớ nghe hết!", { state: "greeting", show: false });
      }
    })
    .catch((err) => {
      console.error(err);
      $("#brain-loader").classList.remove("show");
      addSystemNote(`⚠ Không tải được não AI cục bộ (${err.message}). MTD dùng bộ kịch bản. Thử chọn mô hình nhẹ hơn trong ⚙.`);
      refreshBrainChip();
    });
}

function setSubtitle(text) {
  clearTimeout(app.subtitleTimer);
  const el = $("#subtitle");
  if (text) {
    el.textContent = text;
    el.classList.add("show");
  } else {
    // Giữ phụ đề thêm 2 giây cho người dùng đọc kịp.
    app.subtitleTimer = setTimeout(() => el.classList.remove("show"), 2000);
  }
}

/** Cảm xúc khuôn mặt tổng hợp: ưu tiên biểu cảm mạnh (giận, ngạc nhiên, sợ) từ face-api. */
function currentFaceMood() {
  return ["angry", "surprised", "scared"].includes(app.faceExpr) ? app.faceExpr : app.faceMood;
}

/** Tên hiển thị của người đang đứng trước camera. */
function viewerLabel() {
  const v = app.viewer;
  if (!v) return "CÓ NGƯỜI";
  if (v.kind === "stranger") return "NGƯỜI LẠ";
  return v.names.join(" + ").toUpperCase();
}

function updateHud() {
  $("#hud-presence").textContent = app.cameraOk ? (app.present ? `● ${viewerLabel()}` : "○ KHÔNG THẤY AI") : "○ CAMERA TẮT";
  $("#hud-presence").dataset.on = String(app.present);
  $("#hud-mood").textContent = `Cảm xúc: ${MOOD_LABELS[currentFaceMood()] || "—"}`;
}

function warmMode(ms = 20000) {
  document.body.classList.add("warm");
  clearTimeout(app.warmTimer);
  app.warmTimer = setTimeout(() => document.body.classList.remove("warm"), ms);
}

function restingState() {
  return app.mode === "lullaby" || app.dozing ? "sleeping" : "idle";
}

// Bộ sóng âm giả lập dưới chân robot
const visualizer = $("#visualizer");
for (let i = 0; i < 32; i++) visualizer.appendChild(document.createElement("span"));
const vizBars = [...visualizer.children];
let lastViz = 0;
function animateVisualizer(now) {
  requestAnimationFrame(animateVisualizer);
  if (now - lastViz < 70) return;
  lastViz = now;
  const active = voice.speaking || app.mode === "singing";
  const real = voice.getLevel(); // âm lượng thật nếu đang dùng giọng Piper
  vizBars.forEach((bar, i) => {
    const idle = 0.08 + 0.05 * Math.sin(now / 600 + i / 2);
    const shape = 0.85 - Math.abs(i - 16) / 40;
    const amount = real === null ? Math.random() : real * (0.6 + Math.random() * 0.4);
    const level = active ? 0.12 + amount * shape : idle;
    bar.style.transform = `scaleY(${level.toFixed(2)})`;
  });
}
requestAnimationFrame(animateVisualizer);

// Bầu trời sao cho chế độ ngủ đông
(function buildStarfield() {
  const field = $("#starfield");
  for (let i = 0; i < 140; i++) {
    const star = document.createElement("i");
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    const size = Math.random() < 0.85 ? 1 + Math.random() * 1.5 : 2.5 + Math.random() * 1.5;
    star.style.width = star.style.height = `${size}px`;
    star.style.animationDelay = `${Math.random() * 4}s`;
    star.style.animationDuration = `${2.5 + Math.random() * 3}s`;
    field.appendChild(star);
  }
})();

// ----------------------------------------------------------------------
// NÓI — trung tâm của mọi phản hồi
// ----------------------------------------------------------------------

/**
 * MTD nói một câu: hiện tin nhắn, đổi trạng thái, TẠM NGƯNG nghe (tránh tự nghe giọng mình),
 * đọc xong thì bật nghe lại.
 */
async function say(text, { state = "talking", rate, pitch, show = true, speech, keepState = false } = {}) {
  const token = ++app.sayToken;
  if (show) addMessage("mtd", text);
  robot.setState(state);
  robot.setSpeaking(true);
  setSubtitle(text);
  listener.pause();

  await voice.speak(speech || text, { rate, pitch });
  app.lastSpoken = { text: speech || text, at: Date.now() }; // để lọc tiếng vọng

  // Có câu khác chen ngang trong lúc đang nói -> câu mới sẽ tự lo phần còn lại.
  if (token !== app.sayToken) return;
  robot.setSpeaking(false);
  setSubtitle("");
  if (!keepState) robot.setState(restingState());
  if (app.mode !== "singing") listener.resume();
}

voice.onSpeakingChange = (on) => {
  robot.setSpeaking(on);
};

// ----------------------------------------------------------------------
// XỬ LÝ LỜI NGƯỜI DÙNG
// ----------------------------------------------------------------------

async function handleUserText(raw) {
  const text = raw.trim();
  if (!text) return;
  if (!app.booted) await boot();
  const requestId = ++app.requestId;

  // Người dùng đang tương tác = đang có mặt.
  app.lastSeen = Date.now();
  if (app.dozing) app.dozing = false;

  addMessage("user", text);

  // Đang hát / nhảy mà người dùng nói gì đó -> dừng ngay.
  if (app.mode === "singing") stopSong();
  if (app.mode === "dancing") stopDance();
  // Tăng token trước khi ngắt giọng, để câu cũ bị ngắt không "dọn dẹp" đè lên trạng thái mới.
  app.sayToken++;
  voice.stop();

  // MTD vừa hỏi tên một người lạ -> câu này có thể là câu trả lời.
  if (app.askingName && Date.now() < app.askingName.until) {
    const name = extractName(text, true);
    if (name) return meetNewPerson(name, text);
  }

  if (app.mode !== "lullaby") robot.setState("calculating"); // mắt xoay = đang suy nghĩ

  // NLP + RAG: hiểu câu bằng học máy, tìm ký ức liên quan, tra Wikipedia nếu là câu hỏi kiến thức.
  const who = memoryOwner();
  const [analysis, knowledge] = await Promise.all([
    nlp.ready ? nlp.analyze(text).catch(() => null) : null,
    isKnowledgeQuestion(text) ? searchWikipedia(text, { timeoutMs: 2500 }) : [], // tối đa 2,5 giây
  ]);
  let memories = [];
  if (analysis && who) {
    const recent = new Set(brain.history.slice(-16).map((m) => m.content));
    memories = memory.search(analysis.vector, who, { exclude: recent });
    if (isMemorable(text) && memory.add(text, who, analysis.vector)) memory.save();
  }

  let result;
  let live = null;
  const streamer = createReplyStreamer(requestId);
  const onToken = (partial) => {
    if (!live) live = createLiveMessage();
    live.update(partial);
    streamer.feed(partial); // đọc ngay từng câu AI vừa viết xong
  };
  // Não chính lỗi giữa chừng, chuyển sang não dự phòng -> bỏ phần đang đọc dở.
  const onReset = () => {
    live?.update("");
    streamer.cancel();
  };
  try {
    result = await brain.respond(text, {
      faceMood: app.cameraOk ? currentFaceMood() : null,
      viewer: app.faceIdReady && app.present ? app.viewer : null,
      nlp: analysis,
      memories,
      knowledge,
      form: robot.form,
      onToken,
      onReset,
    });
  } catch (err) {
    console.error(err);
    result = { text: "Bíp... bộ xử lý của tớ vừa gặp trục trặc nhỏ. Cậu nói lại giúp tớ nhé?", state: "talking" };
  }
  live?.remove(); // thay bằng tin nhắn hoàn chỉnh bên dưới
  // Người dùng đã nói câu mới trong lúc AI đang nghĩ -> bỏ câu trả lời cũ, không đọc chồng.
  if (requestId !== app.requestId) {
    streamer.cancel();
    return;
  }
  if (result.error) addSystemNote(`⚠ Não AI gặp lỗi (${result.error}). MTD tạm trả lời bằng kịch bản.`);
  // Mỗi loại thông báo chỉ hiện một lần cho đỡ phiền.
  if (result.notice && !app.shownNotices.has(result.notice.slice(0, 30))) {
    app.shownNotices.add(result.notice.slice(0, 30));
    addSystemNote(result.notice);
  }
  // Ghi nguồn tham khảo (Wikipedia yêu cầu ghi công tác giả — giấy phép CC BY-SA).
  if (knowledge.length && result.text && !result.action) {
    for (const doc of knowledge) addLinkNote("📚 Tham khảo (Wikipedia, CC BY-SA):", doc.title, doc.url);
  }
  if (memories.length) console.info("[MTD] Ký ức liên quan:", memories.map((m) => `${m.text} (${m.score.toFixed(2)})`));
  // Đã đọc dần trong lúc AI viết -> chỉ đọc nốt phần còn lại.
  if (streamer.started && result.text && !result.action && (await streamer.finish(result))) return;
  streamer.cancel();
  await runResponse(result);
}

/**
 * Đọc câu trả lời trong lúc AI còn đang viết: mỗi khi có một câu hoàn chỉnh (kết thúc bằng . ! ? …)
 * thì đưa ngay cho bộ đọc. Nhờ vậy MTD bắt đầu nói sau ~1 giây thay vì đợi AI viết xong cả đoạn.
 */
function createReplyStreamer(requestId) {
  let stream = null;
  let spoken = ""; // phần văn bản đã đưa cho bộ đọc
  let token = 0;
  return {
    get started() {
      return Boolean(stream);
    },
    feed(partial) {
      if (app.mode !== "normal") return; // ru ngủ / đang hát: giữ cách đọc cũ (chậm, nhẹ)
      if (requestId !== app.requestId) return; // người dùng đã nói câu khác
      if (!partial.startsWith(spoken)) return;
      // Lấy tất cả các câu đã hoàn chỉnh trong phần mới (dấu kết câu + khoảng trắng phía sau).
      const complete = /^[\s\S]*[.!?…](?=\s)/.exec(partial.slice(spoken.length));
      if (!complete || complete[0].trim().length < 2) return;
      if (!stream) {
        token = ++app.sayToken;
        listener.pause();
        robot.setState("talking");
        robot.setSpeaking(true);
        stream = voice.startStream();
      }
      stream.push(complete[0]);
      spoken += complete[0];
      setSubtitle(spoken.trim());
    },
    cancel() {
      if (!stream) return;
      stream = null;
      spoken = "";
      // Chỉ tắt giọng nếu giọng đang phát là của chính câu trả lời này (không tắt nhầm câu mới hơn).
      if (token === app.sayToken) voice.stop();
    },
    /** Đọc nốt phần còn lại. Trả về false nếu văn bản cuối khác phần đã đọc (để đọc lại từ đầu theo cách thường). */
    async finish(result) {
      const tail = spoken.trim().slice(-40);
      const at = result.text.indexOf(tail);
      if (!tail || at === -1) return false;
      addMessage("mtd", result.text);
      const state = result.state === "calculating" ? "talking" : result.state || "talking";
      if (state === "comforting") {
        warmMode();
        sound.bleep("heart");
        robot.spawn("heart", 5);
      } else if (state === "shy") {
        sound.bleep("heart");
        robot.spawn("heart", 3);
      }
      robot.setState(state);
      setSubtitle(result.text);
      stream.push(result.text.slice(at + tail.length));
      await stream.end();
      app.lastSpoken = { text: result.text, at: Date.now() }; // để lọc tiếng vọng
      if (token !== app.sayToken) return true; // bị ngắt bởi câu mới
      robot.setSpeaking(false);
      setSubtitle("");
      robot.setState(restingState());
      listener.resume();
      return true;
    },
  };
}

/** Trí nhớ dài hạn lưu riêng cho từng người. Người lạ chưa biết tên thì không lưu. */
function memoryOwner() {
  const v = app.faceIdReady && app.present ? app.viewer : null;
  if (v?.kind === "stranger") return null;
  if (v?.kind === "friend") return v.names[0];
  return "owner";
}

async function runResponse(result) {
  switch (result.action) {
    case "sing":
      return result.song ? singSong(result.song) : composeAndSing(result.request);
    case "lullaby":
      return startLullaby();
    case "story":
      return tellStory(result.story);
    case "wake":
      return wakeUp();
    case "gesture":
      return doGesture(result.gesture);
    case "mimic_on":
      return startMimic();
    case "mimic_off":
      return stopMimic(true);
    case "move":
      return doMove(result.move);
    case "face_learn":
      return startFaceLearning();
    case "face_forget":
      return forgetFaces();
    case "who_am_i":
      return tellWhoYouAre();
    case "stop":
      stopEverything();
      return say(result.text, { state: "idle" });
    default:
      break;
  }

  // Đang ở chế độ ngủ đông: trả lời khẽ, chậm.
  if (app.mode === "lullaby") {
    return say(result.text, { state: "sleeping", rate: 0.8, pitch: 0.9, speech: result.speech });
  }

  if (result.state === "calculating") {
    sound.bleep("calc");
    robot.setState("calculating");
    await wait(1200);
    return say(result.text, { state: "talking", speech: result.speech });
  }
  if (result.state === "comforting") {
    warmMode();
    sound.bleep("heart");
    robot.spawn("heart", 5);
    return say(result.text, { state: "comforting", rate: voice.rate * 0.92, pitch: 1.0, speech: result.speech });
  }
  if (result.state === "shy") {
    // Được khen -> đỏ mặt, mắt "> <", gãi đầu ngượng ngùng.
    sound.bleep("heart");
    robot.spawn("heart", 3);
    return say(result.text, { state: "shy", speech: result.speech });
  }
  return say(result.text, { state: result.state || "talking", speech: result.speech });
}

function stopEverything() {
  stopMimic();
  if (app.mode === "singing") stopSong();
  if (app.mode === "dancing") stopDance();
  if (app.mode === "lullaby") exitLullaby();
  voice.stop();
}

// ----------------------------------------------------------------------
// KỸ NĂNG: HÁT
// ----------------------------------------------------------------------

function showKaraoke(title) {
  $("#karaoke-title").textContent = `♫ ${title}`;
  $("#karaoke").classList.add("show");
}

function hideKaraoke() {
  $("#karaoke").classList.remove("show");
}

function renderKaraokeLine(words) {
  const lyric = $("#karaoke-lyric");
  lyric.innerHTML = "";
  words.forEach((w) => {
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w;
    lyric.append(span, " ");
  });
}

function highlightWord(index) {
  $("#karaoke-lyric").querySelectorAll(".word").forEach((el, i) => el.classList.toggle("on", i <= index));
}

/** Thêm một dòng thông báo có đường link bấm được vào khung chat. */
function addLinkNote(text, linkText, url) {
  const log = $("#chat-log");
  const row = document.createElement("div");
  row.className = "msg msg-system";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = linkText;
  bubble.append(`${text} `, link);
  row.appendChild(bubble);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

/** Yêu cầu hát bất kỳ: não AI sáng tác lời, MTD tự phổ nhạc rồi hát. */
async function composeAndSing(request) {
  if (app.mode === "lullaby") exitLullaby();
  app.mode = "singing";
  app.songAbort = false;
  loadNeuralVoice();
  robot.setState("calculating");
  sound.bleep("calc");
  const composing = brain.composeSong(request);
  await say("Bíp bíp! Để tớ sáng tác một bài ngay bây giờ, cậu chờ tớ vài giây nhé.", { state: "calculating", keepState: true });
  const { song, originalSong, error } = await composing;
  if (app.songAbort) return;
  if (error) addSystemNote(`⚠ Chưa sáng tác được bài mới (${error}). MTD hát bài có sẵn.`);
  if (originalSong) {
    addLinkNote(`🎵 Bài "${originalSong}" là tác phẩm có bản quyền nên MTD không hát lại lời gốc.`, "▶ Nghe bản gốc trên YouTube", `https://www.youtube.com/results?search_query=${encodeURIComponent(originalSong)}`);
    await say(`Bài ${originalSong} là của các nghệ sĩ khác, tớ không hát lại lời gốc được. Nên tớ tự sáng tác một bài cùng cảm hứng tặng cậu nhé!`, { state: "talking", keepState: true });
    if (app.songAbort) return;
  }
  addMessage("mtd", `🎶 ${song.title}\n\n${song.lines.map((l) => l.text).join("\n")}`);
  return singSong(song, { announce: true });
}

async function singSong(song, { announce = true } = {}) {
  if (app.mode === "lullaby") exitLullaby();
  app.mode = "singing";
  app.songAbort = false;
  loadNeuralVoice();

  // Kiểu hát (chọn trong ⚙):
  //  - "clear" (mặc định): giọng tự nhiên (Hoài My / Nam Minh của Edge) hát rõ lời theo nhịp nhạc;
  //  - "notes": giọng AI Piper hát đúng cao độ từng nốt (giai điệu rõ hơn nhưng giọng máy, kém rõ lời).
  const realSinging = neuralVoice.ready && settings.singStyle === "notes";
  const lineWords = song.lines.map((line) => line.text.split(/\s+/).filter(Boolean));
  let prepared = realSinging ? neuralVoice.prepareLine(lineWords[0]) : null;

  if (announce) {
    await say(`Bài hát: ${song.title}. Cậu nghe nhé!`, { state: "singing", keepState: true });
  }
  if (app.songAbort) return;

  listener.pause();
  showKaraoke(song.title);
  robot.setState("singing");
  robot.setSpeaking(true);

  const beat = 60 / song.bpm;
  for (let index = 0; index < song.lines.length; index++) {
    if (app.songAbort) break;
    const words = lineWords[index];
    const notes = fitNotes(song.lines[index].notes, words.length);
    let singing;
    if (realSinging) {
      const syllables = await prepared;
      if (app.songAbort) break;
      // Chuẩn bị dòng tiếp theo trong lúc đang hát dòng này.
      if (index + 1 < song.lines.length) prepared = neuralVoice.prepareLine(lineWords[index + 1]);
      singing = neuralVoice.singLine(syllables, notes, beat);
    } else {
      singing = voice.speak(song.lines[index].text, { rate: 1.0, pitch: 1.2 });
    }
    renderKaraokeLine(words);
    const timers = words.map((_, i) => setTimeout(() => highlightWord(i), i * beat * 1000));
    // Nhạc đệm: hát thật thì nhạc nhỏ và mềm hơn để nghe rõ giọng.
    // Nhạc đệm nhỏ và mềm (sóng tam giác) để không lấn át giọng hát.
    const music = sound.playLine(notes, beat, { melodyVolume: realSinging ? 0.025 : 0.03, melodyType: "triangle" });
    await Promise.all([music, singing]);
    timers.forEach(clearTimeout);
    robot.setSpeaking(true);
  }

  hideKaraoke();
  robot.setSpeaking(false);
  if (app.songAbort) return;
  app.mode = "normal";
  await say(song.outro, { state: "greeting" });
}

function stopSong() {
  app.songAbort = true;
  sound.stopMusic();
  neuralVoice.stopSinging();
  voice.stop();
  hideKaraoke();
  robot.setSpeaking(false);
  app.mode = "normal";
  robot.setState("idle");
  listener.resume();
}

// ----------------------------------------------------------------------
// KỸ NĂNG: ĐỘNG TÁC THEO LỆNH + XOA ĐẦU TRÊN MÀN HÌNH
// ----------------------------------------------------------------------

async function doGesture(gesture) {
  if (app.mode === "lullaby") exitLullaby();
  if (gesture.name === "hiphop") return doHipHop(gesture);
  robot.playGesture(gesture.name, gesture.ms);
  if (gesture.name === "hug") robot.spawn("heart", 6);
  if (gesture.name === "clap" || gesture.name === "high-five") sound.bleep("hello");
  if (gesture.name === "dance") robot.spawn("note", 6);
  await say(gesture.line, { state: gesture.state });
}

// Bấm/chạm vào robot trên màn hình: đầu -> thích thú như được xoa đầu, ngực -> bấm "nút nguồn".
$("#robot-stage").addEventListener("pointerdown", (e) => {
  if (!app.booted) return;
  const now = Date.now();
  if (now - app.lastPetAt < 2500) return; // chống bấm liên tục
  app.lastPetAt = now;
  if (e.target.closest(".head")) {
    robot.spawn("heart", 4);
    sound.bleep("heart");
    // Thỉnh thoảng được xoa đầu thì... ngượng đỏ mặt.
    if (Math.random() < 0.4) {
      say(["Á... cậu xoa đầu tớ trước mặt mọi người, tớ ngại quá à!", "Hihi, nhột quá... má tớ đỏ hết lên rồi nè!"][Math.floor(Math.random() * 2)], { state: "shy" });
      return;
    }
    robot.playGesture("nod", 1500);
    say(["Hihi, nhột quá! Cậu xoa đầu tớ à?", "Ôi, được xoa đầu thích ghê! Đèn LED của tớ sáng rực luôn.", "Bíp! Cảm biến trên đầu tớ vừa phát hiện một cái xoa đầu rất dễ thương."][Math.floor(Math.random() * 3)], { state: "greeting" });
  } else if (e.target.closest(".chest-core, .chest-ring")) {
    sound.bleep("calc");
    say("Á, đó là lõi năng lượng của tớ! Đừng bấm mạnh quá nhé, hihi.", { state: "greeting" });
  }
});

// ----------------------------------------------------------------------
// KỸ NĂNG: DI CHUYỂN & NHÀO LỘN
// ----------------------------------------------------------------------

const laser = new LaserFX(robot);
const FORM_CYCLE = { normal: "battle", battle: "car", car: "cat", cat: "normal" }; // "biến hình" -> dạng kế tiếp
const FORM_LABEL = { normal: "bình thường", battle: "chiến binh", car: "xe đua", cat: "mèo máy" };
const TRANSFORM_LINES = {
  battle: "Biến hình! Chế độ chiến binh: lắp giáp, khóa khớp, nạp năng lượng... Hoàn tất!",
  car: "Biến hình! Gập tay, thu đầu, lắp bánh xe... Chế độ xe đua, brừm brừm!",
  cat: "Biến hình! Mọc tai, gắn ria, lắp đuôi... Chế độ mèo máy, meo meo!",
  normal: "Biến hình trở lại! Tháo giáp, bung tay, ngóc đầu lên... Tớ về dạng bình thường rồi!",
};

/** Bắn laze theo dạng hiện tại: thường = mắt, chiến binh = mắt rồi pháo tay, xe = đèn pha. */
async function fireLaser() {
  const battle = robot.form === "battle";
  const color = battle ? "#ff3b3b" : getComputedStyle(robot.root).getPropertyValue("--led").trim() || "#3de8ff";
  // 1) Nạp năng lượng
  robot.root.classList.add("charging");
  sound.laserCharge();
  await wait(650);
  robot.root.classList.remove("charging");
  // 2) Bắn
  if (robot.form === "car") {
    sound.laserBeam(1.4);
    await laser.fire({ mode: "car", color, duration: 1400 });
    return;
  }
  sound.laserBeam(1.5);
  await laser.fire({ mode: "eyes", color, duration: 1500 });
  if (battle) {
    // Chiến binh: thêm một phát pháo tay thật lớn
    robot.playGesture("cannon", 2600);
    await wait(350);
    robot.root.classList.add("charging");
    sound.laserCharge();
    await wait(600);
    robot.root.classList.remove("charging");
    sound.laserBeam(1.3, true);
    await laser.fire({ mode: "cannon", color, duration: 1300 });
  }
}

async function transformRobot(form) {
  if (form === robot.form) return;
  sound.transformSound();
  await robot.transformTo(form);
  if (form === "cat") sound.meow();
}

/** Thực hiện một động tác di chuyển. Trả về Promise khi xong. */
async function performMove(name) {
  if (name === "laser") return fireLaser();
  if (name.startsWith("transform-")) return transformRobot(name.slice("transform-".length));
  sound.bleep("wake");
  switch (name) {
    case "flip":
      await robot.flip();
      robot.spawn("heart", 2);
      return sound.bleep("hello");
    case "cartwheel":
      return robot.cartwheel(Math.random() < 0.5 ? -1 : 1);
    case "spin":
      return robot.spinAround();
    case "jump":
      return robot.jump();
    case "left":
      return robot.moveTo(-0.95, 0.016);
    case "right":
      return robot.moveTo(0.95, 0.016);
    case "come":
      return robot.comeCloser();
    case "patrol":
      return robot.patrol();
    default:
      return undefined;
  }
}

async function doMove(move) {
  // "Biến hình" chung chung -> chuyển sang dạng kế tiếp và nói đúng tên dạng đó.
  if (move.name === "transform") {
    const next = FORM_CYCLE[robot.form];
    move = { name: `transform-${next}`, line: TRANSFORM_LINES[next] };
  }
  if (move.name.startsWith("transform-") && move.name.slice("transform-".length) === robot.form) {
    return say(`Tớ đang ở dạng ${FORM_LABEL[robot.form]} rồi mà! Muốn đổi thì nói biến hình nhé.`, { state: "greeting" });
  }
  if (app.mimic) return say("Tớ đang bắt chước cậu nên phải đứng yên. Nói thôi bắt chước rồi tớ chạy nhảy tiếp nhé!", { state: "talking" });
  if (app.mode === "lullaby") exitLullaby();
  // Vừa nói vừa làm cho tự nhiên.
  await Promise.all([say(move.line, { state: "greeting" }), performMove(move.name)]);
}

// Đi theo người dùng: khuôn mặt lệch về bên nào thì robot từ từ lăn về bên đó.
function followFace(x) {
  if (app.mode === "normal" && !app.mimic && !app.dozing) robot.follow(x * 0.55);
}

// Không có ai: thỉnh thoảng tự đi dạo cho đỡ chán (ngủ gật thì đứng yên).
setInterval(() => {
  if (!app.booted || app.present || app.dozing || app.mode !== "normal" || voice.speaking || app.mimic) return;
  if (Math.random() < 0.5) {
    robot.moveTo((Math.random() - 0.5) * 1.6, 0.005);
    if (Math.random() < 0.15) setTimeout(() => robot.jump(), 1500);
  }
}, 15000);

// ----------------------------------------------------------------------
// KỸ NĂNG: NHẢY HIP-HOP THEO NHẠC
// ----------------------------------------------------------------------

// Vũ đạo 32 phách (8 ô nhịp). Mỗi phần tử là động tác của một phách (xem data-move trong styles.css).
const HIPHOP_ROUTINE = [
  "bob", "bob", "bob", "bob",
  "pop-left", "pop-right", "pop-left", "pop-right", "cross", "cross", "flex", "flex",
  "point-left", "point-right", "point-left", "point-right", "wave-arms", "wave-arms", "wave-arms", "wave-arms",
  "drop", "drop", "pop-left", "pop-right", "spin", "cross", "spin", "flex",
  "wave-arms", "drop", "freeze", "freeze",
];
const HYPE_WORDS = {
  bob: "YO!", "pop-left": "POP!", "pop-right": "LOCK!", cross: "CHILL~", flex: "FLEX!",
  "point-left": "UP!", "point-right": "UP!", "wave-arms": "WAVE~", drop: "DROP IT!", spin: "SPIN!", freeze: "FREEZE!",
};

async function doHipHop(gesture) {
  if (app.mode === "singing") stopSong();
  await stopMimic();
  await say(gesture.line, { state: "singing", keepState: true });
  if (app.mode !== "normal") return; // bị ngắt trong lúc đang nói

  app.mode = "dancing";
  app.danceAbort = false;
  listener.pause(); // tránh micro nghe nhầm tiếng nhạc thành lời nói
  const bpm = 96;
  robot.setState("singing");
  robot.startDance(60 / bpm);
  showKaraoke("HIP-HOP MODE · DJ MTD");
  await sound.playHipHop({
    bpm,
    bars: 8,
    onBeat: (i) => {
      const move = HIPHOP_ROUTINE[i % HIPHOP_ROUTINE.length];
      robot.setMove(move);
      renderKaraokeLine([HYPE_WORDS[move] || "YO!"]);
      highlightWord(0);
      if (i % 4 === 0) robot.spawn("note", 2);
      if (i === 12) robot.moveTo(-0.6, 0.02); // trượt sang trái
      if (i === 16) robot.moveTo(0.6, 0.02); // trượt sang phải
      if (i === 20) robot.moveTo(0, 0.02);
      if (i === 24) robot.flip(); // cú lộn vòng ăn tiền ở cuối bài
    },
  });
  if (app.danceAbort) return;
  robot.stopDance();
  hideKaraoke();
  app.mode = "normal";
  await say(
    ["Bíp! Hết bài! Cậu thấy tớ quẩy có ngầu không?", "Phù... động cơ của tớ nóng ran rồi! Nhảy hip-hop vui ghê, lần sau mình nhảy cùng nhau nhé!"][Math.floor(Math.random() * 2)],
    { state: "greeting" }
  );
}

function stopDance() {
  app.danceAbort = true;
  sound.stopMusic();
  robot.stopDance();
  hideKaraoke();
  app.mode = "normal";
  robot.setState("idle");
  listener.resume();
}

// ----------------------------------------------------------------------
// KỸ NĂNG: BẮT CHƯỚC (soi gương)
// ----------------------------------------------------------------------

async function startMimic() {
  if (app.mimic) return say("Tớ đang bắt chước cậu rồi mà! Cậu cứ làm động tác đi.", { state: "greeting" });
  if (!vision || !app.cameraOk || vision.mode !== "face") {
    return say("Bíp... để bắt chước được, tớ cần nhìn thấy cậu qua camera với mô hình nhận diện đầy đủ. Cậu kiểm tra lại camera giúp tớ nhé.", { state: "talking" });
  }
  if (app.mode === "lullaby") exitLullaby();
  robot.setState("calculating");
  setChip("#st-cam", "Camera: đang tải nhận diện tư thế...", "info");
  try {
    await vision.enablePose(true);
  } catch (err) {
    console.error(err);
    setChip("#st-cam", "Camera: đang quan sát", "ok");
    return say("Ối, tớ chưa tải được bộ nhận diện tư thế. Cậu thử lại sau nhé.", { state: "talking" });
  }
  app.mimic = true;
  robot.setMimic(true);
  setChip("#st-cam", "Camera: chế độ bắt chước", "ok");
  $("#vision-hud").classList.remove("collapsed");
  await say("Chế độ bắt chước đã bật! Cậu nghiêng đầu, giơ tay, há miệng hay cười, tớ đều làm theo. Muốn dừng thì nói thôi bắt chước nhé.", { state: "greeting" });
}

async function stopMimic(announce = false) {
  if (!app.mimic) return announce ? say("Tớ đâu có đang bắt chước đâu nè.", { state: "talking" }) : undefined;
  app.mimic = false;
  robot.setMimic(false);
  vision?.enablePose(false);
  robot.setState("idle");
  setChip("#st-cam", "Camera: đang quan sát", "ok");
  if (announce) await say("Đã tắt chế độ bắt chước. Vui ghê, lần sau mình chơi tiếp nhé!", { state: "greeting" });
}

// ----------------------------------------------------------------------
// KỸ NĂNG: KỂ CHUYỆN
// ----------------------------------------------------------------------

async function tellStory(story) {
  const intro = {
    fairy: "Tải dữ liệu truyện cổ tích... Hoàn tất!",
    funny: "Mở kho chuyện vui... Chuẩn bị cười nhé!",
    bedtime: "Tớ sẽ kể thật chậm và nhẹ nhàng nhé.",
  }[story.kind];
  const slow = story.kind === "bedtime" || app.mode === "lullaby";
  addMessage("mtd", `📖 ${story.title}\n\n${story.text}`);
  await say(`${intro} Câu chuyện có tên: ${story.title}. ${story.text}`, {
    state: app.mode === "lullaby" ? "sleeping" : "talking",
    show: false,
    rate: slow ? 0.85 : undefined,
    pitch: slow ? 0.95 : undefined,
  });
}

// ----------------------------------------------------------------------
// KỸ NĂNG: RU NGỦ (CHẾ ĐỘ NGỦ ĐÔNG)
// ----------------------------------------------------------------------

async function startLullaby() {
  if (app.mode === "singing") stopSong();
  app.mode = "lullaby";
  document.body.classList.add("hibernate");
  robot.setState("sleeping");
  sound.startSleepAmbience();

  const slow = { state: "sleeping", rate: 0.78, pitch: 0.85 };
  await say("Đã kích hoạt chế độ ngủ đông. Tớ giảm độ sáng màn hình, bật tiếng mưa và hộp nhạc cho cậu nhé. Nhắm mắt lại, hít thở thật chậm nào.", slow);
  if (app.mode !== "lullaby") return;

  const story = brain.pickStory("bedtime");
  addMessage("mtd", `📖 ${story.title}\n\n${story.text}`);
  await say(`Tớ kể cậu nghe chuyện ${story.title} nhé. ${story.text}`, { ...slow, show: false });
  if (app.mode !== "lullaby") return;

  await say('Chúc cậu ngủ thật ngon. Tớ sẽ canh giấc cho cậu. Khi nào muốn dậy, chỉ cần nói "MTD dậy đi" nhé.', slow);
}

function exitLullaby() {
  if (app.mode !== "lullaby") return;
  app.mode = "normal";
  document.body.classList.remove("hibernate");
  sound.stopAmbient();
  robot.setState("idle");
}

async function wakeUp() {
  if (app.mode === "lullaby") {
    exitLullaby();
    sound.bleep("wake");
    return say("Bíp bíp! Hệ thống khởi động lại hoàn tất. Chào mừng cậu trở lại! Cậu ngủ có ngon không?", { state: "greeting" });
  }
  app.dozing = false;
  return say("Tớ tỉnh táo một trăm phần trăm rồi đây! Cậu cần gì nào?", { state: "greeting" });
}

// ----------------------------------------------------------------------
// THỊ GIÁC: CÓ MẶT / VẮNG MẶT / CẢM XÚC KHUÔN MẶT
// ----------------------------------------------------------------------

/** Chào chủ nhân theo giờ, có gọi tên (giơ tay vẫy chào nhờ trạng thái "greeting"). */
async function greet(returning, name = settings.userName) {
  if (app.mode !== "normal") return;
  app.greetedAt.set("owner", Date.now());
  sound.bleep(returning ? "wake" : "hello");
  robot.spawn("heart", returning ? 3 : 1);
  robot.playGesture("wave", 3500);
  await say(timeGreeting(new Date(), returning, name), { state: "greeting" });
}

function onPresence(present) {
  app.present = present;
  if (!present) {
    app.viewer = null;
    app.strangerStreak = 0;
    if (vision) vision.identity = "";
  }
  updateHud();
  if (!present) return;
  app.lastSeen = Date.now();
  if (!app.everSeen) {
    app.everSeen = true;
    requestGreet(false);
  } else if (app.dozing) {
    // Đang ngủ gật mà thấy người quay lại -> giật mình tỉnh dậy, mừng rỡ chào.
    app.dozing = false;
    robot.setState("greeting");
    requestGreet(true);
  }
}

// ----------------------------------------------------------------------
// NHẬN DIỆN KHUÔN MẶT: Đức, bạn của Đức hay người lạ?
// ----------------------------------------------------------------------

const faceBook = FaceBook.load();
let faceId = null;
const FACE_SCAN_MS = 1200; // quét danh tính ~1 lần/giây là đủ, đỡ nặng máy
const REGREET_MS = 10 * 60 * 1000; // cùng một người: 10 phút mới chào lại
const STRANGER_GREET_COOLDOWN_MS = 2 * 60 * 1000;
const EXPRESSION_COOLDOWN_MS = 3 * 60 * 1000;

function hostName() {
  return settings.userName || "";
}

/** Danh sách khuôn mặt đã nhớ (hiện trong ⚙). */
function refreshFaceList() {
  const owner = faceBook.owner();
  const parts = [];
  if (owner) parts.push(`${owner.name} (chủ nhân)`);
  for (const f of faceBook.friends()) parts.push(f.name);
  $("#face-list").textContent = parts.length ? parts.join(", ") : "chưa có";
}

/** Chờ MTD nói xong rồi mới nói câu mới (để không cắt ngang lời chào). */
async function sayWhenFree(text, options) {
  for (let i = 0; i < 60 && (voice.speaking || app.mode !== "normal"); i++) await wait(500);
  if (app.mode === "normal") await say(text, options);
}

function startFaceId() {
  faceId = new FaceID($("#hud-video"));
  faceId
    .load()
    .then(() => {
      app.faceIdReady = true;
      const owner = faceBook.owner();
      const friends = faceBook.friends().map((f) => f.name);
      addSystemNote(
        owner
          ? `🧑 Nhận diện khuôn mặt sẵn sàng — MTD nhớ mặt ${owner.name}${friends.length ? ` và ${friends.join(", ")}` : ""}.`
          : `🧑 Nhận diện khuôn mặt sẵn sàng. Lần đầu nhìn thấy, MTD sẽ tự ghi nhớ khuôn mặt của ${hostName() || "cậu"}.`
      );
      scanFaces();
    })
    .catch((err) => {
      console.warn("[MTD] Không tải được nhận diện khuôn mặt:", err);
      addSystemNote(`⚠ Không tải được bộ nhận diện khuôn mặt (${err.message}). MTD vẫn thấy cậu nhưng chưa phân biệt được ai với ai.`);
      if (app.pendingGreet) finishPendingGreet(null);
    });
}

/** Thấy người -> đợi tối đa 4 giây để biết là ai rồi mới chào. */
function requestGreet(returning) {
  if (!faceId) return greet(returning);
  clearTimeout(app.pendingGreet?.timer);
  const timer = setTimeout(() => finishPendingGreet(null), 4000);
  app.pendingGreet = { returning, timer };
}

/** Chào theo danh tính. Không biết là ai (chưa tải xong mô hình) -> chào như chủ nhân. */
function finishPendingGreet(scene) {
  const pending = app.pendingGreet;
  if (!pending) return;
  clearTimeout(pending.timer);
  app.pendingGreet = null;
  if (!scene || scene.hasOwner) {
    if (scene?.strangerFace) return greetStranger(scene.strangerFace, true);
    return greet(pending.returning);
  }
  if (scene.strangerFace) return greetStranger(scene.strangerFace, false);
  if (scene.friends.length) return greetFriends(scene.friends);
  return greet(pending.returning);
}

async function greetFriends(names) {
  if (app.mode !== "normal") return;
  const now = Date.now();
  names.forEach((n) => app.greetedAt.set(n, now));
  const list = names.join(" và ");
  const host = hostName();
  sound.bleep("hello");
  robot.playGesture("wave", 3500);
  await say(
    host
      ? `A, ${list}! Bạn của ${host} đây mà. Chào ${list} nhé, tớ nhớ mặt bạn đấy! Hôm nay bạn đến chơi với ${host} à?`
      : `A, ${list}! Chào bạn nhé, tớ vẫn nhớ mặt bạn đấy!`,
    { state: "greeting" }
  );
}

async function greetStranger(face, withOwner) {
  if (app.mode !== "normal") return;
  app.lastStrangerGreetAt = Date.now();
  app.sessionStrangers.push(face.descriptor);
  app.askingName = { descriptors: [face.descriptor], until: Date.now() + 90 * 1000 };
  const host = hostName();
  sound.bleep("hello");
  robot.playGesture("wave", 3500);
  let text;
  if (!host) text = "Xin chào bạn mới! Tớ là MTD, một robot bạn đồng hành. Bạn tên là gì thế?";
  else if (withOwner) text = `${host} ơi, cậu dẫn bạn đến chơi à? Xin chào bạn mới! Tớ là MTD, robot bạn thân của ${host}. Bạn tên là gì thế?`;
  else text = `Ơ, xin chào! Hình như tớ chưa gặp bạn bao giờ. Tớ là MTD, robot bạn thân của ${host}. Bạn là bạn của ${host} phải không? Bạn tên là gì vậy?`;
  await say(text, { state: "greeting" });
}

/** Người lạ vừa nói tên -> ghi nhớ khuôn mặt + tên. */
async function meetNewPerson(name, rawText) {
  const asking = app.askingName;
  app.askingName = null;
  const host = hostName();
  brain.remember("user", rawText);
  if (host && name.toLowerCase() === host.toLowerCase()) {
    const line = `Ơ, cậu là ${host} à? Xin lỗi nhé, chắc ánh sáng làm tớ chưa nhận ra. Nếu đúng là ${host}, cậu nói "nhớ mặt tớ" để tớ quét lại khuôn mặt nhé.`;
    brain.remember("assistant", line);
    return say(line, { state: "talking" });
  }
  faceBook.addPerson(name, asking.descriptors);
  faceBook.save();
  refreshFaceList();
  app.greetedAt.set(name, Date.now());
  robot.playGesture("handshake", 3500);
  robot.spawn("heart", 3);
  sound.bleep("heart");
  const line = host
    ? `Rất vui được làm quen với ${name}! Tớ đã ghi nhớ khuôn mặt của ${name} rồi. Bạn của ${host} thì cũng là bạn của tớ. Bắt tay nào!`
    : `Rất vui được làm quen với ${name}! Tớ đã ghi nhớ khuôn mặt của bạn rồi. Bắt tay nào!`;
  addSystemNote(`🧑 MTD đã ghi nhớ khuôn mặt mới: ${name}.`);
  brain.remember("assistant", line);
  return say(line, { state: "greeting" });
}

/** Một vòng quét danh tính (chạy nền liên tục). */
async function scanFaces() {
  try {
    if (app.present && !document.hidden && !app.mimic) {
      const faces = await faceId.scan();
      if (faces.length) processFaces(faces);
    }
  } catch (err) {
    console.warn("[MTD] Lỗi nhận diện khuôn mặt:", err);
  }
  setTimeout(scanFaces, FACE_SCAN_MS);
}

function processFaces(faces) {
  const now = Date.now();
  faces.sort((a, b) => b.size - a.size); // mặt to nhất = người đứng gần nhất, đang nói chuyện với MTD

  // 1) Đang ghi nhớ khuôn mặt theo lệnh "nhớ mặt tớ".
  if (app.enroll) {
    collectEnrollSample(faces);
    return;
  }

  // 2) Chưa nhớ mặt chủ nhân -> người đầu tiên đứng một mình trước camera chính là chủ nhân.
  if (!faceBook.owner()) {
    if (faces.length === 1) {
      app.enroll = { target: "owner", samples: [], until: now + 20000, auto: true };
      collectEnrollSample(faces);
    }
    app.viewer = { kind: "owner", names: [hostName() || "Cậu"] };
    if (app.pendingGreet) finishPendingGreet(null);
    return;
  }

  // 3) So khớp từng khuôn mặt với sổ ghi nhớ.
  const people = faces.map((face) => {
    const match = faceBook.match(face.descriptor);
    return { face, person: match?.person || null, distance: match?.distance ?? 1 };
  });
  const ownerEntry = people.find((p) => p.person?.isOwner);
  const friends = [...new Set(people.filter((p) => p.person && !p.person.isOwner).map((p) => p.person.name))];
  const unknown = people.filter((p) => !p.person);
  // Người lạ phải xuất hiện 2 lần quét liên tiếp mới tính (tránh nhầm khi quay mặt nghiêng).
  app.strangerStreak = unknown.length ? app.strangerStreak + 1 : 0;
  const strangerFace = app.strangerStreak >= 2 ? unknown[0].face : null;

  // Người lạ vừa được hỏi tên -> gom thêm mẫu khuôn mặt của họ.
  if (app.askingName && unknown.length && app.askingName.descriptors.length < 8) {
    app.askingName.descriptors.push(unknown[0].face.descriptor);
  }

  // Làm giàu dữ liệu chủ nhân: thêm mẫu mới (ánh sáng, góc mặt khác) khi chắc chắn là chủ nhân.
  if (ownerEntry && people.length === 1 && ownerEntry.distance < MATCH_THRESHOLD * 0.8 && now - app.lastEnrichAt > 60000) {
    app.lastEnrichAt = now;
    faceBook.addSample(ownerEntry.person, ownerEntry.face.descriptor);
    faceBook.save();
  }

  // 4) Xác định "người xem" để báo cho bộ não AI và hiện lên HUD.
  const host = hostName() || faceBook.owner().name;
  const primary = people[0];
  if (people.length === 1) {
    if (primary.person?.isOwner) app.viewer = { kind: "owner", names: [host] };
    else if (primary.person) app.viewer = { kind: "friend", names: [primary.person.name] };
    else if (strangerFace) app.viewer = { kind: "stranger", names: ["người lạ"] };
  } else {
    const names = [...(ownerEntry ? [host] : []), ...friends, ...(unknown.length ? [`${unknown.length} người lạ`] : [])];
    app.viewer = { kind: "group", names };
  }
  if (vision) {
    vision.identity = primary.person ? primary.person.name.toUpperCase() : strangerFace ? "NGƯỜI LẠ" : "ĐANG QUÉT...";
  }
  updateHud();

  // 5) Biểu cảm chi tiết của người gần nhất (giận, ngạc nhiên, sợ).
  trackExpression(primary.face);

  // 6) Chào hỏi.
  const scene = { hasOwner: Boolean(ownerEntry), friends, strangerFace };
  if (app.pendingGreet) {
    const decided = primary.person || strangerFace;
    if (decided) finishPendingGreet(scene);
    return;
  }
  if (!app.booted || app.mode !== "normal" || voice.speaking || app.dozing || app.enroll) return;

  const newFriends = friends.filter((n) => now - (app.greetedAt.get(n) || 0) > REGREET_MS);
  if (strangerFace && now - app.lastStrangerGreetAt > STRANGER_GREET_COOLDOWN_MS && !seenStrangerBefore(strangerFace)) {
    greetStranger(strangerFace, Boolean(ownerEntry));
  } else if (newFriends.length) {
    greetFriends(newFriends);
  } else if (ownerEntry && now - (app.greetedAt.get("owner") || 0) > REGREET_MS && people.length > 1) {
    // Chủ nhân vừa tới trong lúc MTD đang tiếp bạn của cậu ấy.
    app.greetedAt.set("owner", now);
    robot.playGesture("wave", 3000);
    say(`A, ${host} tới rồi! Tớ đang trò chuyện với bạn của cậu đây.`, { state: "greeting" });
  }
}

/** Người lạ này MTD đã chào trong phiên này chưa? */
function seenStrangerBefore(face) {
  return app.sessionStrangers.some((d) => {
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += (d[i] - face.descriptor[i]) ** 2;
    return Math.sqrt(sum) < MATCH_THRESHOLD;
  });
}

function collectEnrollSample(faces) {
  const enroll = app.enroll;
  if (Date.now() > enroll.until) {
    app.enroll = null;
    if (!enroll.auto) {
      say('Bíp... tớ chưa quét rõ được khuôn mặt. Cậu đứng một mình trước camera, nhìn thẳng vào tớ rồi nói lại "nhớ mặt tớ" nhé.', { state: "talking" });
    }
    return;
  }
  if (faces.length !== 1) return; // chỉ quét khi có đúng một người, tránh lẫn mặt người khác
  enroll.samples.push(faces[0].descriptor);
  if (enroll.samples.length >= 5) finishEnroll();
}

function finishEnroll() {
  const enroll = app.enroll;
  app.enroll = null;
  const isOwner = enroll.target === "owner";
  const name = isOwner ? hostName() || "Chủ nhân" : enroll.target;
  faceBook.addPerson(name, enroll.samples, isOwner);
  faceBook.save();
  refreshFaceList();
  addSystemNote(`🧑 MTD đã ghi nhớ khuôn mặt của ${name}${isOwner ? " (chủ nhân)" : ""}.`);
  const line = isOwner
    ? `Bíp bíp! Tớ đã ghi nhớ khuôn mặt của ${name} rồi. Từ giờ gặp người lạ, tớ vẫn nhận ra ${name} ngay!`
    : `Xong rồi! Tớ đã nhớ khuôn mặt của ${name}.`;
  robot.spawn("heart", 3);
  if (enroll.auto) sayWhenFree(line, { state: "greeting" });
  else say(line, { state: "greeting" });
}

async function startFaceLearning() {
  if (!app.faceIdReady) {
    return say("Bộ nhận diện khuôn mặt của tớ chưa tải xong. Cậu đợi một chút rồi nói lại nhé.", { state: "talking" });
  }
  // Người lạ nói "nhớ mặt tớ" -> hỏi tên rồi lưu như bạn mới, không ghi đè chủ nhân.
  if (faceBook.owner() && app.viewer?.kind === "stranger") {
    app.askingName = { descriptors: [], until: Date.now() + 90 * 1000 };
    return say("Được chứ! Nhưng tớ chưa biết bạn là ai. Bạn tên là gì thế?", { state: "greeting" });
  }
  const target = app.viewer?.kind === "friend" ? app.viewer.names[0] : "owner";
  app.enroll = { target, samples: [], until: Date.now() + 15000, auto: false };
  robot.setState("calculating");
  sound.bleep("calc");
  await say("Được! Cậu nhìn thẳng vào camera và đứng yên vài giây nhé. Bíp... đang quét khuôn mặt.", { state: "calculating" });
}

async function forgetFaces() {
  faceBook.clear();
  faceBook.save();
  refreshFaceList();
  app.viewer = null;
  await say(`Đã xoá toàn bộ khuôn mặt tớ từng ghi nhớ. Lần tới gặp, tớ sẽ học lại khuôn mặt của ${hostName() || "cậu"} nhé.`, { state: "talking" });
}

async function tellWhoYouAre() {
  const host = hostName();
  if (!app.faceIdReady || !app.present || !app.viewer) {
    return say(`Tớ chưa nhìn rõ mặt cậu qua camera. Nhưng nghe giọng thì tớ đoán cậu là ${host || "bạn thân của tớ"}! Cậu đứng trước camera để tớ nhìn kỹ hơn nhé.`, { state: "talking" });
  }
  const v = app.viewer;
  if (v.kind === "owner") {
    robot.spawn("heart", 4);
    return say(`Cậu là ${host || "chủ nhân của tớ"}, người bạn thân nhất của tớ! Khuôn mặt này tớ nhận ra ngay mà.`, { state: "greeting" });
  }
  if (v.kind === "friend") {
    return say(`Bạn là ${v.names[0]}${host ? `, bạn của ${host}` : ""}! Tớ nhớ mặt bạn mà.`, { state: "greeting" });
  }
  if (v.kind === "group") {
    return say(`Tớ đang thấy ${v.names.join(", ")}. Đông vui ghê!`, { state: "greeting" });
  }
  app.askingName = { descriptors: [], until: Date.now() + 90 * 1000 };
  return say(`Tớ chưa gặp bạn bao giờ. Tớ là MTD${host ? `, robot bạn thân của ${host}` : ""}. Bạn tên là gì thế?`, { state: "greeting" });
}

/** Biểu cảm mạnh phải giữ ít nhất 2 lần quét (~2,5 giây) mới tính, tránh phản ứng nhầm. */
function trackExpression(face) {
  const label = face.expressionScore > 0.7 ? face.expression : "neutral";
  const streak = app.exprStreak;
  streak.count = streak.label === label ? streak.count + 1 : 1;
  streak.label = label;
  const stable = streak.count >= 2 ? label : app.faceExpr;
  if (stable === app.faceExpr) return;
  app.faceExpr = stable;
  updateHud();
  onFaceExpression(stable);
}

function onFaceExpression(label) {
  if (!["angry", "surprised", "scared"].includes(label)) return;
  if (!app.booted || app.mimic || app.mode !== "normal" || app.dozing || voice.speaking) return;
  const now = Date.now();
  if (now - (app.lastExprAt[label] || 0) < EXPRESSION_COOLDOWN_MS) return;
  app.lastExprAt[label] = now;
  if (label === "angry") {
    warmMode();
    sound.bleep("heart");
    say("Ơ, trông cậu có vẻ đang bực mình. Mình cùng hít thật sâu nào: hít vào... thở ra... Có chuyện gì làm cậu khó chịu, kể tớ nghe được không?", { state: "comforting", rate: voice.rate * 0.92 });
  } else if (label === "scared") {
    warmMode();
    robot.playGesture("hug", 3500);
    say("Đừng sợ nhé, có tớ ở đây rồi. Mọi chuyện sẽ ổn thôi. Cậu muốn tớ kể một chuyện vui cho đỡ sợ không?", { state: "comforting", rate: voice.rate * 0.92 });
  } else if (label === "surprised") {
    say("Ồ! Có chuyện gì mà cậu ngạc nhiên thế? Kể tớ nghe với!", { state: "greeting" });
  }
}

// Kiểm tra vắng mặt mỗi 2 giây.
setInterval(() => {
  if (app.present) app.lastSeen = Date.now();
  const away = Date.now() - app.lastSeen;
  if (app.booted && app.cameraOk && app.everSeen && !app.dozing && app.mode === "normal" && !voice.speaking && away > ABSENT_LIMIT_MS) {
    app.dozing = true;
    robot.setState("sleeping");
    addSystemNote("💤 Không thấy cậu hơn 3 phút, MTD chuyển sang chế độ chờ (ngủ gật).");
  }
}, 2000);

function onFaceMood(mood) {
  app.faceMood = mood;
  updateHud();
  // Đang chơi bắt chước thì nét mặt là "diễn", không phải cảm xúc thật -> không an ủi.
  if (!app.booted || app.mimic || app.mode !== "normal" || app.dozing || voice.speaking || !app.present) return;
  const now = Date.now();
  if ((mood === "sad" || mood === "tired") && now - app.lastComfortAt > COMFORT_COOLDOWN_MS) {
    app.lastComfortAt = now;
    warmMode();
    sound.bleep("heart");
    robot.spawn("heart", 6);
    say(faceComfortLine(mood), { state: "comforting", rate: voice.rate * 0.92, pitch: 1.0 });
  } else if (mood === "happy" && now - app.lastHappyAt > HAPPY_COOLDOWN_MS && now - app.lastComfortAt > 20000) {
    app.lastHappyAt = now;
    robot.jump(); // thấy cậu cười -> nhảy cẫng lên
    say(happyFaceLine(), { state: "greeting" });
  }
}

// ----------------------------------------------------------------------
// KHỞI ĐỘNG (mở khoá âm thanh + xin quyền camera/micro trong cùng một cú nhấn)
// ----------------------------------------------------------------------

async function requestMedia() {
  const video = { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" };
  try {
    // Xin camera + micro cùng lúc để chỉ hiện một hộp thoại cấp quyền.
    return await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({ video });
    } catch {
      return null;
    }
  }
}

async function boot() {
  if (app.booted) return;
  app.booted = true;

  // 1) Mở khoá âm thanh — BẮT BUỘC nằm trong sự kiện click/phím của người dùng.
  sound.unlock();
  voice.unlock();
  sound.bleep("boot");

  const screen = $("#boot-screen");
  screen.classList.add("powering");
  setTimeout(() => screen.remove(), 1200);

  loadNeuralVoice();
  if (voice.engine === "browser" && voice.supported && voice.voices.length && !voice.hasVietnamese) {
    addSystemNote("⚠ Máy chưa có giọng đọc tiếng Việt của trình duyệt. Chọn \"Giọng AI Piper\" trong ⚙ hoặc dùng Microsoft Edge.");
  }

  // 2) Camera + micro
  const stream = navigator.mediaDevices?.getUserMedia ? await requestMedia() : null;
  // Micro chỉ cần xin quyền; SpeechRecognition tự mở micro riêng nên tắt track âm thanh này đi.
  stream?.getAudioTracks().forEach((t) => t.stop());

  // 3) Lắng nghe liên tục (giọng trình duyệt trước, PhoWhisper tải xong thì chuyển sang)
  listener.start();
  if (settings.sttEngine !== "browser") startWhisper();

  // 4) Thị giác
  if (stream && stream.getVideoTracks().length) {
    vision = new Vision({
      video: $("#hud-video"),
      canvas: $("#hud-canvas"),
      onPresence,
      onFace: (x, y) => {
        robot.lookAt(x, y);
        followFace(x);
      },
      onMood: onFaceMood,
      onMimic: (data) => robot.applyMimic(data),
      onStatus: (s) => ($("#hud-status").textContent = s),
    });
    try {
      await vision.start(stream);
      app.cameraOk = true;
      setChip("#st-cam", "Camera: đang quan sát", "ok");
      startFaceId(); // tải nền bộ nhận diện danh tính (~8 MB, lần sau trình duyệt nhớ sẵn)
    } catch (err) {
      console.error(err);
      setChip("#st-cam", "Camera: lỗi", "bad");
    }
  } else {
    setChip("#st-cam", "Camera: không có quyền", "bad");
    $("#hud-status").textContent = "Không truy cập được camera";
  }
  updateHud();

  // Không có camera thì chào luôn, không đợi "thấy người".
  if (!app.cameraOk) {
    app.everSeen = true;
    await wait(600);
    greet(false);
  }
}

/** Chuyển sang nhận dạng bằng PhoWhisper khi server sẵn sàng; lỗi thì giữ giọng trình duyệt. */
async function startWhisper() {
  try {
    await whisperListener.load();
    await whisperListener.start();
    const paused = webListener.paused;
    webListener.stop();
    listener.engine = whisperListener;
    if (paused) whisperListener.pause();
    addSystemNote(`🎙 Đã bật nhận dạng giọng nói PhoWhisper (VinAI) chạy trên máy: ${whisperListener.modelName}.`);
  } catch (err) {
    console.warn("[MTD] Không bật được PhoWhisper:", err);
    // Bản công khai không có server PhoWhisper -> dùng giọng trình duyệt, không cần báo.
    if (!IS_HOSTED) addSystemNote(`ℹ Nhận dạng giọng nói dùng dịch vụ của trình duyệt (PhoWhisper: ${err.message}). Mở MTD bằng start-mtd.bat để dùng PhoWhisper.`);
  }
}

function onHeardInterim(text) {
  $("#heard").textContent = text ? `🎙 ${text}` : "";
}
function onHeardFinal(text) {
  if (voice.speaking || text.length < 2) return;
  // Micro bắt lại đuôi câu MTD vừa nói (loa vọng vào) -> không phải người dùng nói.
  if (app.lastSpoken && Date.now() - app.lastSpoken.at < 4000 && isEchoOf(text, app.lastSpoken.text)) {
    console.info("[MTD] Bỏ qua tiếng vọng:", text);
    return;
  }
  handleUserText(text);
}
function onMicStatus(status) {
  const engineName = listener.engine === whisperListener ? "PhoWhisper" : "trình duyệt";
  const map = {
    listening: [`Micro: đang nghe (${engineName})`, "ok"],
    paused: ["Micro: tạm dừng (MTD đang nói)", "info"],
    denied: ["Micro: bị chặn quyền", "bad"],
    unsupported: ["Micro: trình duyệt không hỗ trợ", "bad"],
    error: ["Micro: lỗi mạng, thử lại...", "bad"],
  };
  const [text, level] = map[status] || ["Micro: —", "info"];
  setChip("#st-mic", text, level);
}
for (const engine of [webListener, whisperListener]) {
  engine.onInterim = onHeardInterim;
  engine.onFinal = onHeardFinal;
  engine.onStatus = onMicStatus;
}

// Nhấn bất kỳ đâu / bấm phím bất kỳ trên màn hình chờ để khởi động.
$("#boot-screen").addEventListener("pointerdown", () => boot());
window.addEventListener("keydown", (e) => {
  if (!app.booted) {
    e.preventDefault();
    boot();
  }
});

// ----------------------------------------------------------------------
// Ô NHẬP VĂN BẢN (dự phòng khi ồn ào)
// ----------------------------------------------------------------------

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value;
  input.value = "";
  handleUserText(text);
});

// ----------------------------------------------------------------------
// HUD CAMERA: thu nhỏ / mở rộng
// ----------------------------------------------------------------------

$("#hud-toggle").addEventListener("click", () => {
  $("#vision-hud").classList.toggle("collapsed");
});

// ----------------------------------------------------------------------
// CÀI ĐẶT (menu ẩn: bánh răng hoặc Ctrl + , / Alt + S)
// ----------------------------------------------------------------------

const modal = $("#settings");

function fillVoiceList() {
  const select = $("#set-voice");
  const vi = voice.vietnameseVoices();
  const others = voice.voices.filter((v) => !vi.includes(v));
  select.innerHTML = '<option value="">Tự động (ưu tiên tiếng Việt)</option>';
  for (const v of [...vi, ...others]) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${vi.includes(v) ? "🇻🇳 " : ""}${v.name} (${v.lang})`;
    select.appendChild(opt);
  }
  select.value = settings.voiceURI || "";
}
voice.onVoicesChanged = fillVoiceList;

// Gợi ý tên model cho từng nhà cung cấp
const MODEL_SUGGESTIONS = {
  local: LOCAL_MODELS.map((m) => [m.id, m.label]),
  ollama: [["qwen2.5:7b", "Qwen2.5 7B (~4.7 GB)"], ["qwen2.5:3b", "Qwen2.5 3B"], ["gemma2:9b", "Gemma 2 9B"], ["llama3.1:8b", "Llama 3.1 8B"]],
  claude: [["claude-opus-5-5", "Claude Opus 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude-haiku-5-5", "Claude Haiku 5.5"]],
  openai: [["gpt-4o-mini", "GPT-4o mini"]],
  gemini: [["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite (nhanh, khuyên dùng)"], ["gemini-3.8-flash", "Gemini 3.8 Flash (thông minh hơn, hay quá tải)"]],
};

function syncProviderFields() {
  const provider = $("#set-provider").value;
  const hasProvider = provider !== "offline";
  $("#ai-fields").hidden = !hasProvider;
  if (!hasProvider) return;
  $("#key-field").hidden = KEYLESS_PROVIDERS.has(provider);
  $("#ollama-field").hidden = provider !== "ollama";
  $("#local-note").hidden = provider !== "local";
  $("#key-note").hidden = KEYLESS_PROVIDERS.has(provider);
  $("#set-key").value = settings.keys[provider] || "";
  $("#set-model").value = settings.models[provider] || DEFAULT_MODELS[provider];
  $("#set-model").placeholder = DEFAULT_MODELS[provider];
  $("#set-ollama").value = settings.ollamaUrl;
  $("#model-list").innerHTML = (MODEL_SUGGESTIONS[provider] || [])
    .map(([id, label]) => `<option value="${id}">${label}</option>`)
    .join("");
}

function openSettings() {
  $("#set-provider").value = settings.provider;
  syncProviderFields();
  $("#set-engine").value = settings.voiceEngine || "auto";
  $("#set-stt").value = settings.sttEngine || "auto";
  $("#set-sing").value = settings.singStyle || "clear";
  $("#set-name").value = settings.userName || "";
  $("#set-about").value = settings.aboutUser || "";
  $("#set-rate").value = settings.rate;
  $("#set-pitch").value = settings.pitch;
  $("#rate-val").textContent = settings.rate;
  $("#pitch-val").textContent = settings.pitch;
  fillVoiceList();
  modal.classList.add("show");
}

function closeSettings() {
  modal.classList.remove("show");
}

function applySettings() {
  const provider = $("#set-provider").value;
  const before = `${settings.provider}|${settings.models.local}`;
  settings.provider = provider;
  if (provider !== "offline") {
    if (!KEYLESS_PROVIDERS.has(provider)) settings.keys[provider] = $("#set-key").value.trim();
    settings.models[provider] = $("#set-model").value.trim() || DEFAULT_MODELS[provider];
    if (provider === "ollama") settings.ollamaUrl = $("#set-ollama").value.trim() || "http://localhost:11434";
  }
  if (provider === "local") settings.ollamaChecked = true; // người dùng chủ động chọn -> không tự đổi nữa
  settings.providerChosen = true;
  settings.userName = $("#set-name").value.trim();
  settings.aboutUser = $("#set-about").value.trim();
  if (settings.userName) {
    faceBook.renameOwner(settings.userName);
    faceBook.save();
    refreshFaceList();
  }
  // Đổi sang não cục bộ hoặc đổi mô hình -> tải lại.
  if (provider === "local" && before !== `${settings.provider}|${settings.models.local}`) {
    if (brain.local.status === "error") brain.local.status = "idle";
    setTimeout(startLocalBrain, 0);
  }
  settings.rate = Number($("#set-rate").value);
  settings.pitch = Number($("#set-pitch").value);
  settings.voiceURI = $("#set-voice").value;
  settings.voiceEngine = $("#set-engine").value;
  const stt = $("#set-stt").value;
  if (stt !== (settings.sttEngine || "auto")) addSystemNote("🎙 Đã đổi bộ nhận dạng giọng nói — tải lại trang (F5) để áp dụng.");
  settings.sttEngine = stt;
  settings.singStyle = $("#set-sing").value;
  voice.engine = settings.voiceEngine;
  loadNeuralVoice();
  voice.rate = settings.rate;
  voice.pitch = settings.pitch;
  voice.selectVoice(settings.voiceURI);
  saveSettings(settings);
  refreshBrainChip();
}

$("#gear").addEventListener("click", openSettings);
$("#set-provider").addEventListener("change", syncProviderFields);
$("#set-rate").addEventListener("input", (e) => ($("#rate-val").textContent = e.target.value));
$("#set-pitch").addEventListener("input", (e) => ($("#pitch-val").textContent = e.target.value));
$("#set-close").addEventListener("click", closeSettings);
$("#set-save").addEventListener("click", () => {
  applySettings();
  closeSettings();
  addSystemNote(`⚙ Đã lưu cài đặt. Bộ não: ${brain.providerLabel()}.`);
  // Gemini: kiểm tra key ngay và tự chọn mô hình phù hợp.
  if (settings.provider === "gemini" && settings.keys.gemini) {
    brain
      .pickGeminiModel()
      .then((model) => addSystemNote(`✅ Key Gemini hợp lệ — dùng mô hình ${model}.`))
      .catch((err) => addSystemNote(`⚠ Key Gemini chưa dùng được: ${err.message}`));
  }
});
$("#set-test").addEventListener("click", () => {
  applySettings();
  say("Xin chào, tớ là MTD. Đây là giọng nói hiện tại của tớ.", { state: "greeting", show: false });
});
$("#set-memory-clear").addEventListener("click", () => {
  memory.forget();
  addSystemNote("🧠 Đã xoá trí nhớ dài hạn của MTD.");
});
$("#set-faces-clear").addEventListener("click", () => {
  faceBook.clear();
  faceBook.save();
  refreshFaceList();
  app.viewer = null;
  addSystemNote("🧑 Đã xoá mọi khuôn mặt MTD từng ghi nhớ. Lần tới MTD sẽ học lại mặt chủ nhân.");
});
$("#set-clear").addEventListener("click", () => {
  chatHistory = [];
  persistHistory();
  brain.history = [];
  $("#chat-log").innerHTML = "";
  addSystemNote("🧹 Đã xoá lịch sử trò chuyện.");
});
modal.addEventListener("pointerdown", (e) => {
  if (e.target === modal) closeSettings();
});
window.addEventListener("keydown", (e) => {
  if (!app.booted) return;
  const shortcut = (e.ctrlKey && e.key === ",") || (e.altKey && (e.key === "s" || e.key === "S"));
  if (shortcut) {
    e.preventDefault();
    modal.classList.contains("show") ? closeSettings() : openSettings();
  } else if (e.key === "Escape") {
    closeSettings();
  }
});

// ----------------------------------------------------------------------
// TRẠNG THÁI BAN ĐẦU
// ----------------------------------------------------------------------

/**
 * Nếu máy đã cài Ollama và có sẵn mô hình -> tự chuyển sang Ollama (thông minh hơn, khỏi tải 2 GB vào trình duyệt).
 * Chỉ tự chuyển một lần; nếu người dùng chọn lại "AI cục bộ" trong cài đặt thì tôn trọng lựa chọn đó.
 */
/**
 * File cấu hình trên máy (tùy chọn): config.local.js
 *   export const MTD_CONFIG = { provider: "gemini", keys: { gemini: "..." } };
 * Dùng để đặt sẵn API key mà không cần vào ⚙. Không có file thì bỏ qua.
 */
async function loadLocalConfig() {
  try {
    const res = await fetch("./config.local.js", { method: "HEAD" });
    if (!res.ok) return;
    const { MTD_CONFIG } = await import("./config.local.js");
    if (!MTD_CONFIG) return;
    let changed = false;
    for (const [provider, key] of Object.entries(MTD_CONFIG.keys || {})) {
      if (key && settings.keys[provider] !== key) {
        settings.keys[provider] = key;
        changed = true;
      }
    }
    for (const [provider, model] of Object.entries(MTD_CONFIG.models || {})) {
      if (model && !settings.configApplied && settings.models[provider] !== model) {
        settings.models[provider] = model;
        changed = true;
      }
    }
    // Tên chủ nhân đặt sẵn trong file cấu hình (ví dụ "Đức").
    if (MTD_CONFIG.userName && settings.configName !== MTD_CONFIG.userName) {
      settings.userName = MTD_CONFIG.userName;
      settings.configName = MTD_CONFIG.userName;
      faceBook.renameOwner(MTD_CONFIG.userName);
      faceBook.save();
      refreshFaceList();
      changed = true;
    }
    if (MTD_CONFIG.provider && !settings.configApplied) {
      settings.provider = MTD_CONFIG.provider;
      settings.configApplied = true; // chỉ áp dụng một lần, sau đó tôn trọng lựa chọn trong ⚙
      changed = true;
    }
    if (changed) {
      saveSettings(settings);
      addSystemNote(`🔑 Đã nạp cấu hình từ config.local.js — bộ não: ${brain.providerLabel()}.`);
      if (settings.provider === "gemini") {
        brain
          .pickGeminiModel()
          .then((model) => addSystemNote(`✅ Key Gemini hợp lệ — dùng mô hình ${model}.`))
          .catch((err) => addSystemNote(`⚠ Key Gemini chưa dùng được: ${err.message}`));
      }
    }
  } catch (err) {
    console.warn("[MTD] Không đọc được config.local.js:", err);
  }
}

/** Đang chạy bản đăng công khai (GitHub Pages...) chứ không phải trên máy chủ nhân. */
const IS_HOSTED = !["localhost", "127.0.0.1", ""].includes(location.hostname) && !location.hostname.endsWith("trycloudflare.com");

async function initBrain() {
  await loadLocalConfig();
  // Bản công khai: người mới vào KHÔNG tự tải não AI 2 GB. Dùng kịch bản trước và hướng dẫn lấy key Gemini miễn phí.
  if (IS_HOSTED && settings.provider === "local" && !settings.providerChosen) {
    settings.provider = "offline";
    addSystemNote(
      "👋 Chào mừng đến với MTD! Hiện MTD dùng bộ kịch bản có sẵn. Để MTD trò chuyện thông minh như người: " +
        "vào ⚙ → Bộ não AI → Google Gemini, dán API key MIỄN PHÍ lấy tại aistudio.google.com/apikey " +
        "(key chỉ lưu trong trình duyệt của bạn). Hoặc chọn \"AI cục bộ trong trình duyệt\" (tải ~2 GB, cần máy có GPU)."
    );
  }
  refreshBrainChip();
  if (settings.provider === "gemini" || settings.provider === "claude" || settings.provider === "openai") {
    brain.preloadOllama(); // nạp sẵn não 7B làm dự phòng
    return;
  }
  if (settings.provider === "ollama") {
    brain.preloadOllama();
    return;
  }
  if (settings.provider === "local" && !settings.ollamaChecked) {
    const models = await brain.detectOllama();
    const wanted = settings.models.ollama || DEFAULT_MODELS.ollama;
    const found = models.find((name) => name === wanted) || models.find((name) => name.startsWith("qwen")) || models[0];
    if (found) {
      settings.provider = "ollama";
      settings.models.ollama = found;
      settings.ollamaChecked = true;
      saveSettings(settings);
      addSystemNote(`🧠 Phát hiện Ollama trên máy — MTD dùng não ${found} để trò chuyện.`);
      refreshBrainChip();
      brain.preloadOllama();
      return;
    }
  }
  startLocalBrain();
}

refreshBrainChip();
refreshFaceList();
initBrain();

// Tải bộ hiểu ngôn ngữ (embedding + học máy) từ thư mục models/ — không cần mạng.
nlp
  .load()
  .then(() => addSystemNote(`🧬 Bộ hiểu ngôn ngữ học máy sẵn sàng — hiểu lệnh theo nghĩa, đoán cảm xúc, trí nhớ dài hạn (${memory.items.length} ký ức).`))
  .catch((err) => {
    console.warn("[MTD] Không tải được bộ NLP:", err);
    addSystemNote(`⚠ Không tải được bộ hiểu ngôn ngữ học máy (${err.message}). MTD vẫn trò chuyện bằng từ khoá + não AI.`);
  });
setChip("#st-cam", "Camera: chờ khởi động", "info");
setChip("#st-voice", "Giọng: chờ khởi động", "info");
setChip("#st-mic", listener.supported ? "Micro: chờ khởi động" : "Micro: trình duyệt không hỗ trợ", listener.supported ? "info" : "bad");
updateHud();

// Cho phép mở console và gõ MTD.say("...") để thử nghiệm.
window.MTD = { say, robot, brain, sound, voice, stories: STORIES };
