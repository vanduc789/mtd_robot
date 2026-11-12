"""Server web nhỏ cho MTD.

1. Phục vụ file tĩnh kèm header "không lưu bộ nhớ đệm": sửa code xong chỉ cần F5 là thấy bản mới.
2. (Tuỳ chọn) Nhận dạng giọng nói tiếng Việt NGAY TRÊN MÁY bằng PhoWhisper (VinAI) + faster-whisper:
   trình duyệt gửi đoạn âm thanh tới POST /stt, server trả về văn bản.
   Cần cài: ml\\.venv\\Scripts\\pip install faster-whisper   và có thư mục models/PhoWhisper-small-ct2 (hoặc -base-ct2).
   Không có thì server vẫn chạy bình thường, MTD dùng nhận dạng giọng nói của trình duyệt.

Chạy:  start-mtd.bat                      (khuyên dùng — tự chọn đúng Python có PhoWhisper)
       python server.py                   (mặc định cổng 5500)
       python server.py 8000              (chọn cổng khác)
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_PORT = 5500
PROJECT_DIR = Path(__file__).resolve().parent
# Có GPU: dùng bản small (ít lỗi hơn) trên card đồ hoạ -> vừa chính xác vừa nhanh (~0,3 giây/câu).
# Chỉ có CPU: bản small mất ~2 giây/câu (quá chậm để trò chuyện) -> dùng bản base (~0,6 giây/câu).
SMALL_MODEL = PROJECT_DIR / "models" / "PhoWhisper-small-ct2"
BASE_MODEL = PROJECT_DIR / "models" / "PhoWhisper-base-ct2"
SAMPLE_RATE = 16000
MAX_AUDIO_SECONDS = 30

# Những từ hay gặp khi nói chuyện với MTD mà mô hình dễ nghe nhầm (tên riêng, từ mượn).
HOTWORDS = "MTD Đức robot laze biến hình mèo máy chiến binh xe đua hip hop nhảy lộn vòng hát kể chuyện"

# Whisper đôi khi "bịa" câu khi nghe tiếng ồn (học từ phụ đề video) -> bỏ qua các câu này.
HALLUCINATIONS = re.compile(
    r"subscribe|đăng ký (cho )?kênh|cảm ơn (các bạn|mọi người|quý vị) đã (theo dõi|xem|lắng nghe)"
    r"|hẹn gặp lại (các bạn|mọi người)|like và share|ghiền mì gõ|phụ đề (bởi|được)",
    re.IGNORECASE,
)


# ----------------------------------------------------------------------
# CHIA SẺ QUA INTERNET (Cloudflare Tunnel): bảo vệ máy chủ nhân
# ----------------------------------------------------------------------

# Người truy cập từ xa KHÔNG được xem các file/thư mục này (chứa key, code học máy, môi trường Python...).
REMOTE_BLOCKED_DIRS = ("ml", "tests")
REMOTE_BLOCKED_SUFFIXES = (".py", ".bat", ".md", ".txt", ".pyc", ".cfg")
CONFIG_FILE = PROJECT_DIR / "config.local.js"


def same_file(a: Path, b: Path) -> bool:
    """So sánh hai đường dẫn kiểu Windows: không phân biệt chữ hoa/thường, đã chuẩn hoá ".." và "."."""
    return os.path.normcase(str(a.resolve())) == os.path.normcase(str(b.resolve()))
GEMINI_LIMIT_PER_MINUTE = 15  # mỗi người xem từ xa: tối đa 15 câu hỏi/phút
GEMINI_LIMIT_PER_DAY = 200  # ...và 200 câu/ngày, để không ai dùng hết lượt miễn phí của chủ nhân


def read_gemini_config() -> tuple[str, str]:
    """Đọc key và tên mô hình Gemini trong config.local.js (chỉ server dùng, không gửi cho người xem từ xa)."""
    path = CONFIG_FILE
    if not path.exists():
        return "", ""
    text = path.read_text(encoding="utf-8")
    key = re.search(r'keys:\s*\{[^}]*gemini:\s*"([^"]+)"', text)
    model = re.search(r'models:\s*\{[^}]*gemini:\s*"([^"]+)"', text)
    return (key.group(1) if key else ""), (model.group(1) if model else "gemini-3.5-flash-lite")


class RateLimiter:
    """Đếm số lần gọi của từng người (theo địa chỉ IP) trong 1 phút và 1 ngày gần nhất."""

    def __init__(self, per_minute: int, per_day: int) -> None:
        self.per_minute = per_minute
        self.per_day = per_day
        self.calls: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, who: str) -> bool:
        now = time.time()
        with self.lock:
            calls = self.calls[who]
            while calls and now - calls[0] > 86400:
                calls.popleft()
            last_minute = sum(1 for t in calls if now - t < 60)
            if last_minute >= self.per_minute or len(calls) >= self.per_day:
                return False
            calls.append(now)
            return True


def add_cuda_dll_dirs() -> None:
    """Windows: cho Python tìm thấy các file .dll của CUDA (cuBLAS, cuDNN) cài bằng pip trong thư mục nvidia/."""
    if sys.platform != "win32":
        return
    try:
        import nvidia  # gói "nvidia-cublas-cu12", "nvidia-cudnn-cu12"
    except ImportError:
        return
    for root in nvidia.__path__:
        for bin_dir in Path(root).glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


def clean_transcript(text: str) -> str:
    """Làm sạch kết quả nhận dạng; trả về "" nếu là câu "bịa" hoặc không có chữ nào."""
    text = " ".join(text.split())
    if not any(ch.isalpha() for ch in text) or HALLUCINATIONS.search(text):
        return ""
    return text


class SpeechRecognizer:
    """Bọc mô hình PhoWhisper. Tải ở luồng nền để server khởi động ngay, không phải chờ."""

    def __init__(self) -> None:
        self.model_dir = BASE_MODEL
        self.device = "cpu"
        self.model = None
        self.status = "loading"  # loading | ready | unavailable
        self.reason = ""
        self.lock = threading.Lock()  # mô hình xử lý lần lượt từng câu
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self) -> None:
        try:
            from faster_whisper import WhisperModel  # chỉ cần khi dùng PhoWhisper
        except ImportError:
            self.status, self.reason = "unavailable", "chưa cài faster-whisper (chạy bằng start-mtd.bat)"
            return
        import numpy as np

        started = time.time()
        # 1) Thử GPU + bản small. Chạy thử 1 giây im lặng để chắc chắn đủ thư viện CUDA và bộ nhớ GPU.
        if (SMALL_MODEL / "model.bin").exists():
            try:
                add_cuda_dll_dirs()
                model = WhisperModel(str(SMALL_MODEL), device="cuda", compute_type="int8_float16")
                list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="vi")[0])
                self.model, self.model_dir, self.device = model, SMALL_MODEL, "GPU"
            except Exception as err:  # thiếu CUDA, hết bộ nhớ GPU... -> dùng CPU
                print(f"ℹ Không chạy được PhoWhisper trên GPU ({str(err)[:120]}) -> dùng CPU")
        # 2) Dự phòng: CPU + bản base (int8: nhẹ và nhanh, độ chính xác gần như không đổi).
        if self.model is None:
            if not (BASE_MODEL / "model.bin").exists():
                self.status, self.reason = "unavailable", f"thiếu mô hình {BASE_MODEL.name}"
                return
            self.model = WhisperModel(str(BASE_MODEL), device="cpu", compute_type="int8")
            self.model_dir, self.device = BASE_MODEL, "CPU"
        self.status = "ready"
        print(f"🎙 {self.model_dir.name} ({self.device}) sẵn sàng sau {time.time() - started:.1f} giây")

    def transcribe(self, audio) -> tuple[str, float]:
        """Âm thanh 16 kHz (mảng float32) -> (văn bản, số giây xử lý)."""
        import numpy as np

        started = time.time()
        # Whisper nhận dạng chữ đầu câu kém nếu âm thanh bắt đầu ngay lập tức -> đệm 0,3 giây im lặng hai đầu.
        pad = np.zeros(int(SAMPLE_RATE * 0.3), dtype=np.float32)
        audio = np.concatenate([pad, audio, pad])
        with self.lock:
            segments, _info = self.model.transcribe(
                audio,
                language="vi",
                beam_size=5,  # xét 5 phương án câu cùng lúc rồi chọn câu hợp lý nhất (chính xác hơn tham lam)
                condition_on_previous_text=False,
                without_timestamps=True,
                hotwords=HOTWORDS,  # gợi ý các từ riêng của MTD để mô hình nghe đúng hơn
            )
            text = " ".join(segment.text for segment in segments)
        return clean_transcript(text), time.time() - started


class MTDHandler(SimpleHTTPRequestHandler):
    """Phục vụ file tĩnh (không lưu đệm) + API nhận dạng giọng nói."""

    recognizer: SpeechRecognizer | None = None
    gemini_limiter = RateLimiter(GEMINI_LIMIT_PER_MINUTE, GEMINI_LIMIT_PER_DAY)

    # ---------------- người xem từ xa ----------------

    def is_remote(self) -> bool:
        """Yêu cầu đi qua Cloudflare Tunnel (có header Cf-Connecting-Ip) = người xem từ Internet."""
        return bool(self.headers.get("Cf-Connecting-Ip") or self.headers.get("X-Forwarded-For"))

    def client_id(self) -> str:
        return self.headers.get("Cf-Connecting-Ip") or self.client_address[0]

    def requested_file(self) -> Path:
        """File thật trên ổ đĩa mà URL trỏ tới (đã giải mã %xx, bỏ ?query, xử lý ".." như server sẽ làm)."""
        return Path(self.translate_path(self.path)).resolve()

    def remote_blocked(self) -> bool:
        """Kiểm tra trên ĐƯỜNG DẪN FILE THẬT, không so chuỗi URL — tránh bị lách bằng chữ hoa (/CONFIG.LOCAL.JS),
        mã hoá (/%63onfig.local.js) hay "../" (Windows không phân biệt chữ hoa/thường)."""
        target = self.requested_file()
        try:
            parts = [p.lower() for p in target.relative_to(PROJECT_DIR.resolve()).parts]
        except ValueError:
            # relative_to phân biệt chữ hoa/thường -> thử lại bằng chuỗi đã chuẩn hoá
            root = os.path.normcase(str(PROJECT_DIR.resolve()))
            full = os.path.normcase(str(target))
            if not full.startswith(root):
                return True  # nằm ngoài thư mục dự án
            parts = [p for p in full[len(root):].split(os.sep) if p]
        if not parts:
            return False  # trang chủ
        if parts[0] in REMOTE_BLOCKED_DIRS or any(p.startswith(".") for p in parts):
            return True
        if target.suffix.lower() in REMOTE_BLOCKED_SUFFIXES:
            return True
        return target.is_dir()  # không cho xem danh sách file trong thư mục

    def send_remote_config(self) -> None:
        """Người xem từ xa nhận cấu hình KHÔNG có key: não Gemini đi qua cổng trung gian /api/gemini."""
        _key, model = read_gemini_config()
        body = (
            "// Cấu hình cho người xem từ xa — không chứa API key.\n"
            f'export const MTD_CONFIG = {{ provider: "gemini", keys: {{ gemini: "server-proxy" }}, models: {{ gemini: "{model}" }} }};\n'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def guard_remote(self) -> bool:
        """Trả về True nếu đã tự trả lời (chặn hoặc gửi cấu hình riêng) cho người xem từ xa."""
        if not self.is_remote():
            return False
        if same_file(self.requested_file(), CONFIG_FILE):
            self.send_remote_config()
            return True
        if self.remote_blocked():
            self.send_error(404)
            return True
        return False

    def do_HEAD(self) -> None:
        if not self.guard_remote():
            super().do_HEAD()

    def proxy_gemini(self) -> None:
        """Chuyển câu hỏi tới Gemini bằng key của chủ nhân rồi chuyển câu trả lời (streaming) về trình duyệt."""
        if not self.gemini_limiter.allow(self.client_id()):
            return self.send_json({"error": {"message": "Hỏi nhanh quá rồi, đợi một chút nhé (giới hạn lượt dùng)."}}, 429)
        key, default_model = read_gemini_config()
        if not key:
            return self.send_json({"error": {"message": "Máy chủ chưa có key Gemini"}}, 503)
        model = self.path.partition("model=")[2] or default_model
        if not re.fullmatch(r"[\w.\-]+", model):
            return self.send_json({"error": {"message": "Tên mô hình không hợp lệ"}}, 400)
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 300_000:
            return self.send_json({"error": {"message": "Yêu cầu rỗng hoặc quá dài"}}, 400)
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
            data=self.rfile.read(length),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as err:
            body = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        except OSError as err:
            return self.send_json({"error": {"message": f"Không kết nối được Gemini: {err}"}}, 502)
        # Chuyển từng mẩu chữ ngay khi nhận được (không có Content-Length -> đóng kết nối khi xong).
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        with upstream:
            while chunk := upstream.read1(4096):
                self.wfile.write(chunk)
                self.wfile.flush()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def send_json(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.guard_remote():
            return
        if self.path == "/stt/status":
            rec = self.recognizer
            return self.send_json({
                "status": rec.status if rec else "unavailable",
                "reason": rec.reason if rec else "",
                "model": f"{rec.model_dir.name} ({rec.device})" if rec and rec.status == "ready" else "",
            })
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/api/gemini"):
            return self.proxy_gemini()
        if self.path != "/stt":
            return self.send_json({"error": "không có đường dẫn này"}, 404)
        rec = self.recognizer
        if not rec or rec.status != "ready":
            return self.send_json({"error": "PhoWhisper chưa sẵn sàng"}, 503)
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > SAMPLE_RATE * 4 * MAX_AUDIO_SECONDS:
            return self.send_json({"error": "đoạn âm thanh rỗng hoặc quá dài"}, 400)
        import numpy as np  # faster-whisper đã kéo theo numpy

        # Trình duyệt gửi thẳng mảng Float32Array (4 byte mỗi mẫu, 16 kHz).
        audio = np.frombuffer(self.rfile.read(length), dtype=np.float32)
        text, seconds = rec.transcribe(audio)
        print(f"🎙 \"{text}\" ({seconds * 1000:.0f} ms cho {len(audio) / SAMPLE_RATE:.1f} giây âm thanh)")
        self.send_json({"text": text, "ms": round(seconds * 1000)})

    def log_message(self, format: str, *args) -> None:
        # Chỉ in các yêu cầu lỗi cho đỡ rối mắt.
        if len(args) > 1 and str(args[1]).startswith(("4", "5")) and "favicon" not in str(args[0]):
            super().log_message(format, *args)


def main() -> None:
    """Khởi động server tại thư mục dự án."""
    # Console Windows có thể dùng bảng mã cp1252 (không có chữ tiếng Việt) -> chuyển sang UTF-8.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    MTDHandler.recognizer = SpeechRecognizer()
    handler = partial(MTDHandler, directory=str(PROJECT_DIR))
    # Chỉ nhận kết nối từ chính máy này (127.0.0.1): máy khác trong cùng mạng Wi-Fi không vào thẳng được.
    # Người xem từ xa đi qua Cloudflare Tunnel — cloudflared cũng chạy trên máy này nên vẫn kết nối được.
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"MTD đang chạy tại http://localhost:{port}  (Ctrl + C để dừng)")
        server.serve_forever()


if __name__ == "__main__":
    main()
