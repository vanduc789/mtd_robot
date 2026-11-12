# 🤖 MTD — Robot bạn thân trên trình duyệt

**▶ Dùng thử online:** https://vanduc789.github.io/mtd_robot/ (dán key Gemini miễn phí của bạn vào ⚙ để MTD thông minh hơn — lấy tại https://aistudio.google.com/apikey)


MTD là một **robot cơ khí ảo** (thân kim loại, bảng mạch, khớp nối, màn hình LED trên mặt). Cậu không cần bấm nút nào:
MTD **thấy cậu qua camera thì tự chào**, **luôn lắng nghe** và **tự trả lời bằng giọng nói**.

## ✨ Tính năng

| Nhóm | Mô tả |
|---|---|
| 👁 Thị giác | MediaPipe Face Landmarker (qua CDN). Thấy mặt lần đầu → chào theo giờ. Vắng hơn 3 phút → ngủ gật. Quay lại → giật mình tỉnh dậy, mừng rỡ chào. Mắt LED liếc theo khuôn mặt cậu. |
| 😊 Cảm xúc kép | Đọc **nét mặt** (cười / buồn / mệt / **giận / ngạc nhiên / sợ**) + **lời nói** (vui, buồn, lo lắng, giận, cô đơn, mệt). Buồn/mệt/giận/sợ → MTD chuyển màu ấm, tim bay lên và hỏi thăm. |
| 🧑 Nhận mặt | Nhớ khuôn mặt **chủ nhân** (tên đặt trong `config.local.js` hoặc ⚙). Gặp **người lạ** → vẫy tay, giới thiệu "tớ là robot bạn thân của Đức", hỏi tên rồi **ghi nhớ khuôn mặt** người đó; lần sau gặp lại gọi đúng tên. Dùng [face-api](https://github.com/vladmandic/face-api) (MIT), dữ liệu khuôn mặt chỉ lưu trong trình duyệt. |
| 😳 Xấu hổ | Được khen (dễ thương, giỏi quá, yêu cậu...) → mắt `> <`, má đỏ ửng, cúi đầu gãi gáy ngượng ngùng. |
| 🛞 Di chuyển | Lăn bánh xích sang trái/phải (bánh quay, thân nghiêng theo quán tính), **tự đi theo khuôn mặt cậu**, tự đi dạo khi vắng người. Nhào lộn: **lộn vòng 3D**, lộn ngang kiểu bánh xe, xoay người, nhảy lên, chạy một vòng. |
| 🔫 Laze & biến hình | "Bắn laze": nạp năng lượng rồi bắn tia từ mắt quét dọc sàn (tia lửa + vết cháy). "Biến hình": đổi qua 3 dạng — **bình thường → chiến binh** (giáp đỏ, sừng, pháo tay bắn tia lớn) **→ xe đua** (bánh xe, đèn pha bắn laze, lửa ống xả) **→ mèo máy** (tai LED, ria, đuôi vẫy, đệm chân, tiếng meo — thiết kế riêng, không mô phỏng nhân vật có bản quyền) → bình thường. Có âm thanh lắp ráp, xoay tít, chớp sáng. |
| 🧬 Học máy (NLP) | Mô hình deep learning **multilingual-e5-small** chạy ngay trong trình duyệt (Transformers.js) biến câu nói thành vector. Hai bộ phân loại **Logistic Regression** huấn luyện bằng scikit-learn: **ý định** (hiểu cách nói khác, ví dụ "làm một cú santo trên không" → lộn vòng) và **cảm xúc** (học từ bộ GoEmotions 58k câu của Google). |
| 📚 RAG | **Trí nhớ dài hạn**: MTD lưu những điều cậu kể, lần sau tự tìm lại ký ức liên quan (theo nghĩa, không cần trùng chữ). **Tra cứu Wikipedia tiếng Việt** khi gặp câu hỏi kiến thức, đưa cho não AI tham khảo và ghi nguồn. |
| 🕺 Hip-hop | "Nhảy hip hop": beat boom-bap tự tổng hợp (kick, snare, hi-hat, bass) + vũ đạo 32 phách đúng nhịp (pop, lock, cross, flex, wave, drop, spin, freeze). |
| 👂 Nghe tiếng Việt | **PhoWhisper-small** (VinAI, tự lùi về bản base nếu chưa tải) chạy trong `server.py` bằng faster-whisper + **Silero VAD** trong trình duyệt phát hiện lúc cậu nói. Nghe tiếng Việt tốt hơn và không cần mạng. Mở bằng `start-mtd.bat`; không có thì tự dùng nhận dạng của trình duyệt. |
| 🎙 Giọng nói | Nghe liên tục (`SpeechRecognition`, `continuous`), tự **tạm ngưng nghe khi MTD đang nói/hát** để không tự nghe giọng mình, nói xong tự nghe lại. |
| 🎤 Kiểu hát | Mặc định hát **rõ lời bằng giọng tự nhiên** Hoài My / Nam Minh của Edge theo nhịp nhạc. Tuỳ chọn trong ⚙: hát đúng nốt bằng giọng AI Piper (giai điệu chuẩn hơn nhưng là giọng máy). |
| 🎶 Hát mọi bài | Yêu cầu bất kỳ ("hát bài về mùa thu", "hát cho tớ vui đi") → não AI **sáng tác lời mới**, MTD **tự phổ nhạc** (thang ngũ cung, có điệp khúc) rồi **hát thật**: từng chữ được tạo bằng giọng Piper, đo cao độ và chỉnh cho khớp nốt. Kèm nhạc đệm chiptune + karaoke. Với bài hát có thật, MTD không chép lời gốc (bản quyền) mà sáng tác bài cùng cảm hứng và đưa link nghe bản gốc trên YouTube. |
| 📖 Kể chuyện | Truyện cổ tích, chuyện vui, chuyện đêm khuya (tự sáng tác). |
| 🤝 Động tác | Ra lệnh: bắt tay, xoa đầu / chạm tay lên đầu, đập tay, vẫy tay, vỗ tay, giơ tay lên, chào kiểu quân đội, ôm, gật đầu, lắc đầu, nhảy, suy nghĩ. **Bấm vào đầu MTD** trên màn hình để xoa đầu nó. |
| 🪞 Bắt chước | Nói "bắt chước tớ": MTD soi gương theo cậu — nghiêng đầu, giơ hai tay (MediaPipe Pose), há miệng, nháy mắt, cười. Nói "thôi bắt chước" để tắt. |
| 🌙 Ru ngủ | Chế độ "Ngủ đông": màn hình siêu tối + bầu trời sao, tiếng mưa + hộp nhạc, giọng chậm và trầm. Nói "MTD dậy đi" để thoát. |
| 🧮 Tính toán | Đọc phép tính bằng tiếng Việt: "12 nhân 8", "căn bậc hai của 144", "giải phương trình x bình phương trừ 5x cộng 6 bằng 0". Mắt hiện ma trận số. |
| 🧠 Bộ não | Mặc định chạy **mô hình AI thật ngay trong trình duyệt** (Qwen2.5 qua WebLLM + WebGPU): hiểu và trò chuyện tự do về mọi chủ đề, **miễn phí, không cần API key**, không gửi dữ liệu ra ngoài. Lần đầu tải ~2 GB, sau đó dùng được cả khi mất mạng. Có thể chuyển sang **Ollama** (mô hình lớn hơn trên máy) hoặc **Claude / OpenAI / Gemini** (cần key). |
| 💬 Như người thật | Có tính cách, sở thích, quan điểm riêng; nhớ những gì cậu kể trong cuộc trò chuyện; tự ghi nhớ tên khi cậu nói "tớ tên là ...". Trong ⚙ có ô "Kể MTD nghe về cậu" để MTD hiểu cậu hơn. |

7 trạng thái biểu cảm: `idle`, `greeting`, `talking`, `singing`, `calculating`, `comforting`, `sleeping`.

## 🚀 Cách chạy

Camera và micro **chỉ hoạt động trên `localhost` hoặc HTTPS**, nên không mở trực tiếp file `index.html` được — cần một server nhỏ.

**Cách 0 — Nhấp đúp `start-mtd.bat` (khuyên dùng):** tự mở trình duyệt và bật PhoWhisper nghe tiếng Việt.

**Cách 1 — Python (có sẵn trong dự án học Python này):**

```powershell
cd projects\mtd-robot
ml\.venv\Scripts\python server.py   # có PhoWhisper
python server.py                    # không có PhoWhisper (dùng nhận dạng của trình duyệt)
```

`server.py` báo trình duyệt không giữ bản cũ, nên sửa code xong chỉ cần F5.

**Cách 2 — Node.js:**

```powershell
cd projects\mtd-robot
npm start          # chạy: npx serve -l 5500 .
```

Sau đó mở **http://localhost:5500** → nhấn bất kỳ đâu trên màn hình chờ → bấm **Cho phép** camera và micro.

> 💡 Nên dùng **Microsoft Edge** trên Windows: có sẵn giọng tiếng Việt tự nhiên (HoaiMy / NamMinh) và hỗ trợ nhận diện giọng nói.
> Chrome cũng nhận diện giọng nói tốt, nhưng có thể thiếu giọng đọc tiếng Việt — khi đó vào *Settings → Time & language → Speech* của Windows để cài gói giọng Tiếng Việt.
> Firefox **không hỗ trợ** nhận diện giọng nói → vẫn dùng ô chat được.

## 🧠 Chọn bộ não

| Bộ não | Ưu điểm | Cần gì |
|---|---|---|
| **AI cục bộ (mặc định)** | Miễn phí, riêng tư, chạy offline sau lần tải đầu | Edge/Chrome mới (WebGPU), GPU ~3 GB+. Máy có RTX 3050 4 GB → dùng **Qwen2.5 3B**. |
| **Ollama** | Mô hình lớn hơn (7B+) thông minh hơn, vẫn miễn phí | Cài [Ollama](https://ollama.com), chạy `ollama pull qwen2.5:7b` |
| **Claude / OpenAI / Gemini** | Thông minh nhất, nói tiếng Việt tự nhiên nhất | API key (trả phí theo lượt dùng) |

**Thứ tự dự phòng:** não chính (ví dụ Gemini) lỗi hoặc hết lượt miễn phí → tự chuyển sang **Ollama 7B trên máy** → cuối cùng mới dùng kịch bản có sẵn.

> Mô hình AI đã được huấn luyện sẵn trên lượng dữ liệu khổng lồ, nên **không cần tự lấy dataset để huấn luyện** — chỉ cần chọn mô hình. "Tính cách" của MTD nằm ở [system-prompt.js](system-prompt.js), sửa file này để đổi MTD thành một nhân vật khác.

## ⚙ Cài đặt ẩn

Bấm biểu tượng **⚙** góc trên phải, hoặc phím tắt **Ctrl + ,** / **Alt + S**:

- **Bộ não AI:** Ngoại tuyến / Claude / OpenAI / Gemini, kèm API key và tên model.
  - Claude mặc định dùng `claude-opus-5-5`, gọi thẳng từ trình duyệt (header `anthropic-dangerous-direct-browser-access`), `effort: low` để trả lời nhanh, và bật cơ chế *fallback* phía máy chủ nếu model từ chối một yêu cầu.
  - Tên model OpenAI / Gemini mặc định có thể cũ — sửa lại trong ô **Model** nếu báo lỗi.
- **Giọng đọc, tốc độ, cao độ**, nút **Nghe thử**, **Xoá lịch sử**.

> 🔒 API key lưu trong `localStorage` của trình duyệt và gửi thẳng tới nhà cung cấp. Chỉ dùng trên máy cá nhân.

## 🗣 Câu lệnh mẫu

| Nói | MTD sẽ |
|---|---|
| "Hát đi MTD" / "hát bài vũ trụ" | Hát kèm nhạc + karaoke |
| "Kể chuyện" / "kể chuyện cười" / "kể chuyện cổ tích" | Kể chuyện |
| "Ru tớ ngủ" / "tớ buồn ngủ" / "chúc ngủ ngon" | Vào chế độ Ngủ đông |
| "MTD dậy đi" | Thoát chế độ ngủ |
| "Dừng lại" | Dừng hát / dừng chế độ hiện tại |
| "Ra câu đố đi" | Đố vui, rồi chấm câu trả lời |
| "Tại sao bầu trời màu xanh?" | Giải thích khoa học |
| "Bây giờ là mấy giờ?" / "Hôm nay thứ mấy?" | Báo giờ, ngày |
| "Tớ đang buồn / lo lắng / cô đơn" | An ủi, động viên |
| "Nhảy hip hop đi" | Bật beat và nhảy theo nhịp (cuối bài có cú lộn vòng) |
| "Lộn vòng" / "Lộn ngang" / "Xoay vòng" / "Nhảy lên" | Nhào lộn |
| "Sang trái" / "Sang phải" / "Lại đây" / "Chạy một vòng" | Lăn bánh di chuyển |
| "Bắn laze" / "Biến hình" / "Biến thành xe đua" / "Chế độ chiến đấu" / "Trở lại bình thường" | Bắn laze, biến hình |
| "Lỗ đen là gì?" | Tra Wikipedia rồi giải thích, kèm link nguồn |
| "Nhớ mặt tớ" / "Quên khuôn mặt" | Quét lại khuôn mặt chủ nhân / xoá mọi khuôn mặt đã nhớ |
| "Cậu có nhận ra tớ không?" | Nói cậu là ai (chủ nhân, bạn hay người lạ) |
| "MTD dễ thương quá" | Đỏ mặt xấu hổ |

> Trong lúc MTD đang hát hoặc kể chuyện dài, micro tạm tắt để tránh tự nghe tiếng loa. Muốn ngắt ngay, gõ "dừng" vào ô chat.

## 📁 Cấu trúc

```
mtd-robot/
├── index.html         # Bố cục: màn hình chờ, sân khấu robot, khung chat, HUD camera, cài đặt
├── styles.css         # Giao diện Sci-Fi, 7 trạng thái robot, chế độ Ngủ đông
├── app.js             # Bộ điều phối: nối thị giác + giọng nói + bộ não + avatar
├── robot-avatar.js    # Robot SVG: mắt/miệng LED, tay, hiệu ứng tim / nốt nhạc / Zzz
├── vision.js          # Camera + MediaPipe: có mặt, vị trí mặt, cảm xúc khuôn mặt (+ dự phòng phát hiện chuyển động)
├── audio-voice.js     # Web Audio (nhạc, mưa, hộp nhạc), đọc tiếng Việt, nghe liên tục
├── brain.js           # Ý định, cảm xúc, máy tính, kho truyện/bài hát/câu đố, gọi AI
├── local-llm.js       # Não AI cục bộ chạy trong trình duyệt (WebLLM)
├── system-prompt.js   # System Prompt định hình tính cách MTD
├── package.json
└── tests/brain.test.js  # Kiểm thử bộ não: npm test
```

## 🎙 Giọng nói

Trong ⚙ → **Bộ đọc giọng nói**:
- **Tự động** (mặc định): có giọng *Microsoft HoaiMy/NamMinh Natural* của Edge thì dùng (tự nhiên nhất), không có thì dùng giọng AI Piper.
- **Giọng AI Piper**: chạy offline trong trình duyệt (~60 MB, tải một lần), miệng LED nhép theo âm lượng thật.
- **Giọng trình duyệt**: giọng có sẵn của hệ điều hành.

## 📜 Mã nguồn mở và giấy phép

| Thành phần | Giấy phép |
|---|---|
| [Piper TTS](https://github.com/rhasspy/piper) | MIT |
| [piper-tts-web](https://github.com/Mintplex-Labs/piper-tts-web) | MIT |
| Giọng `vi_VN-vais1000-medium` ([piper-voices](https://huggingface.co/rhasspy/piper-voices)), dữ liệu [VAIS-1000](https://ieee-dataport.org/documents/vais-1000-vietnamese-speech-synthesis-corpus) | CC BY 4.0 |
| [WebLLM](https://github.com/mlc-ai/web-llm) | Apache-2.0 |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) | Apache-2.0 |
| [face-api](https://github.com/vladmandic/face-api) (nhận diện khuôn mặt + biểu cảm) | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| Mô hình [PhoWhisper-small](https://huggingface.co/vinai/PhoWhisper-small) / [base](https://huggingface.co/vinai/PhoWhisper-base) (VinAI), bản CTranslate2 của [diepho](https://huggingface.co/diepho/PhoWhisper-small-ct2) | BSD-3-Clause / Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT |
| [vad-web](https://github.com/ricky0123/vad) + mô hình Silero VAD | ISC / MIT |
| Mô hình [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) (bản ONNX của [Xenova](https://huggingface.co/Xenova/multilingual-e5-small)) | MIT |
| Bộ dữ liệu [GoEmotions](https://huggingface.co/datasets/google-research-datasets/go_emotions) (Google) | Apache-2.0 |
| Nội dung [Wikipedia tiếng Việt](https://vi.wikipedia.org) (tra cứu trực tiếp, có ghi nguồn) | CC BY-SA 4.0 |
| scikit-learn, numpy, pandas, onnxruntime, tokenizers (chỉ dùng khi huấn luyện) | BSD / MIT / Apache-2.0 |
| Câu mẫu tiếng Việt trong `ml/data/` | Tự soạn cho dự án |

Bộ dữ liệu cảm xúc tiếng Việt UIT-VSMEC **không được dùng** vì không ghi rõ giấy phép.

## Huấn luyện lại bộ phân loại (học máy)

```powershell
cd projects\mtd-robot
python -m venv ml\.venv
ml\.venv\Scripts\pip install -r ml\requirements.txt
ml\.venv\Scripts\python ml\train_classifiers.py
```

Muốn MTD hiểu thêm lệnh mới: thêm câu mẫu vào `ml/data/vi_intents.json` rồi chạy lại. Kết quả lần huấn luyện gần nhất:

| Bộ phân loại | Dữ liệu | Kết quả trên câu test (không dùng khi học) |
|---|---|---|
| Ý định (15 nhóm) | ~170 câu tiếng Việt tự soạn | 100% đúng; ở ngưỡng 0.5 tự tin 96% số câu, 0 lần làm nhầm hành động |
| Cảm xúc (6 nhóm) | 10.653 câu GoEmotions + 70 câu tiếng Việt | 70% đúng với tiếng Việt (chỉ học tiếng Anh: 50%), 62% với tiếng Anh |

Ngưỡng trí nhớ dài hạn 0.90 được đo thực tế: câu liên quan có độ giống ≥ 0.91, câu không liên quan ≤ 0.89.
| [Ollama](https://github.com/ollama/ollama) | MIT |
| Mô hình Qwen2.5 3B (AI cục bộ) | Qwen Research License (dùng phi thương mại) |
| Mô hình Qwen2.5 1.5B / 7B | Apache-2.0 |

## 🧪 Kiểm thử

```powershell
npm test     # = node --test tests/
```

## 🛠 Gỡ lỗi nhanh

| Hiện tượng | Cách xử lý |
|---|---|
| MTD không nói | Kiểm tra âm lượng; mở ⚙ → Nghe thử; đổi sang Edge. |
| Không nghe được | Chip "Micro" phải xanh. Nếu "bị chặn quyền" → bấm biểu tượng 🔒 trên thanh địa chỉ để cho phép micro. Nhận diện giọng nói của Chrome/Edge cần Internet. |
| HUD ghi "Chế độ dự phòng" | Không tải được mô hình MediaPipe (mất mạng) → MTD vẫn phát hiện có người bằng chuyển động, nhưng không đọc được nét mặt. |
| Mắt không liếc theo | Ngồi đủ sáng, mặt nằm trong khung camera. |

## Chia sẻ link cho người khác xem

1. Tải `cloudflared-windows-amd64.exe` (Cloudflare, Apache-2.0) tại https://github.com/cloudflare/cloudflared/releases/latest, đổi tên thành `cloudflared.exe`, đặt vào `D:\cloudflared\`.
2. Nhấp đúp **`share-mtd.bat`** → copy dòng `https://....trycloudflare.com` và gửi cho bạn bè.
3. Đóng cửa sổ đó là link ngừng hoạt động. Mỗi lần chạy lại sẽ ra link mới.

Bảo vệ máy chủ nhân khi chia sẻ (đã kiểm thử cả các kiểu lách như `/CONFIG.LOCAL.JS`, `/%63onfig.local.js`, `../`):

| | Chủ nhân (máy này) | Người xem qua link |
|---|---|---|
| Key Gemini | Có | **Không bao giờ thấy** — hỏi Gemini qua cổng trung gian `/api/gemini` của server |
| Giới hạn hỏi Gemini | Không | 15 câu/phút, 200 câu/ngày mỗi người |
| File `ml/`, `tests/`, `.py`, `.bat`, `.md`, danh sách thư mục | Xem được | **Bị chặn (404)** |
| Não 7B Ollama | Có | Không (chỉ chạy trên máy chủ nhân) |
| Lịch sử chat, khuôn mặt, trí nhớ | Lưu trong trình duyệt của chủ nhân | Lưu trong trình duyệt của **chính người xem**, không lẫn với chủ nhân |

Server chỉ nhận kết nối từ chính máy này (`127.0.0.1`), máy khác trong cùng Wi-Fi không vào thẳng được.


## Giấy phép mã nguồn

Mã nguồn MTD: [MIT](LICENSE) © vanduc789 (Đức). Thư viện, mô hình và dữ liệu bên thứ ba giữ giấy phép riêng (bảng ở trên).
