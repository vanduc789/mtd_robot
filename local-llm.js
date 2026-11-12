// local-llm.js — "Não cục bộ" của MTD: chạy một mô hình ngôn ngữ thật ngay trong trình duyệt bằng WebLLM (WebGPU).
// Không cần API key, không gửi dữ liệu ra ngoài. Lần đầu sẽ tải mô hình (~1–2 GB) rồi lưu vào bộ nhớ đệm của trình duyệt,
// những lần sau mở lên là dùng được ngay, kể cả khi mất mạng.

const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.79";

// Các mô hình gợi ý. Qwen2.5 nói tiếng Việt khá tốt trong nhóm mô hình nhỏ.
export const LOCAL_MODELS = [
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B — cân bằng (khuyên dùng, ~2 GB)" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B — nhẹ, nhanh (~1 GB)" },
  { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", label: "Qwen2.5 7B — thông minh nhất, cần GPU ≥ 6 GB (~5 GB)" },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B (~1.5 GB)" },
];

export function webgpuSupported() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** Card đồ họa không hỗ trợ số thực 16-bit thì dùng bản q4f32 tương ứng. */
async function pickVariant(modelId) {
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (adapter && !adapter.features.has("shader-f16")) return modelId.replace("q4f16_1", "q4f32_1");
  } catch {
    // giữ nguyên
  }
  return modelId;
}

export class LocalLLM {
  constructor() {
    this.engine = null;
    this.modelId = null;
    this.loading = null; // Promise đang tải
    this.status = "idle"; // idle | loading | ready | error | unsupported
    this.error = null;
    this.onProgress = () => {};
  }

  get ready() {
    return this.status === "ready";
  }

  /** Tải (hoặc đổi) mô hình. Gọi nhiều lần cùng model sẽ dùng chung một lần tải. */
  load(modelId) {
    if (!webgpuSupported()) {
      this.status = "unsupported";
      this.error = "Trình duyệt không hỗ trợ WebGPU";
      return Promise.reject(new Error(this.error));
    }
    if (this.modelId === modelId && (this.ready || this.loading)) return this.loading || Promise.resolve();

    this.status = "loading";
    this.loading = (async () => {
      try {
        const webllm = await import(/* @vite-ignore */ WEBLLM_URL);
        const variant = await pickVariant(modelId);
        const progress = (report) => this.onProgress(report.progress ?? 0, report.text || "");
        if (this.engine) {
          await this.engine.reload(variant);
        } else {
          this.engine = await webllm.CreateMLCEngine(variant, { initProgressCallback: progress });
        }
        this.modelId = modelId;
        this.status = "ready";
        this.onProgress(1, "Sẵn sàng");
      } catch (err) {
        this.status = "error";
        this.error = err.message || String(err);
        throw err;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Gọi một lần, không stream. `json = true` buộc mô hình trả về JSON hợp lệ. */
  async complete(messages, { json = false } = {}) {
    if (!this.ready) {
      if (this.loading) await this.loading;
      else throw new Error("Não cục bộ chưa được tải");
    }
    const reply = await this.engine.chat.completions.create({
      messages,
      temperature: 0.9,
      max_tokens: 600,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });
    return reply.choices[0]?.message?.content || "";
  }

  /**
   * Trò chuyện. `messages` theo định dạng OpenAI: [{ role: "system" | "user" | "assistant", content }].
   * `onToken(textSoFar)` được gọi liên tục để hiện chữ đang được viết ra.
   */
  async chat(messages, onToken = () => {}) {
    if (!this.ready) {
      if (this.loading) await this.loading;
      else throw new Error("Não cục bộ chưa được tải");
    }
    const stream = await this.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 400,
    });
    let text = "";
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content || "";
      onToken(text);
    }
    return text.trim();
  }
}
