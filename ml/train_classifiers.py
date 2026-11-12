"""Huấn luyện 2 bộ phân loại cho MTD bằng học máy (machine learning).

Quy trình (pipeline):
    1. Deep learning: mô hình multilingual-e5-small (MIT) biến mỗi câu thành một vector 384 số
       ("embedding"). Câu cùng ý nghĩa -> vector gần nhau, kể cả khác ngôn ngữ (Anh <-> Việt).
    2. Machine learning: Logistic Regression (scikit-learn) học cách chia các vector đó thành nhóm:
       - Cảm xúc: học từ bộ GoEmotions của Google (58k câu tiếng Anh, Apache-2.0)
         + một ít câu tiếng Việt tự soạn  ->  vui / buồn / giận / lo lắng / ngạc nhiên / bình thường.
       - Ý định: học từ câu tiếng Việt tự soạn  ->  hát / kể chuyện / lộn vòng / đi sang trái / ...
    3. Xuất trọng số ra file JSON để trình duyệt chạy lại đúng phép tính đó (models/*.json).

Chạy:
    ml\\.venv\\Scripts\\python ml\\train_classifiers.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import StandardScaler
from tokenizers import Tokenizer

ML_DIR = Path(__file__).resolve().parent
CACHE_DIR = ML_DIR / "cache"  # bộ dữ liệu GoEmotions đã tải
DATA_DIR = ML_DIR / "data"
OUT_DIR = ML_DIR.parent / "models"

MODEL_ID = "Xenova/multilingual-e5-small"
# Dùng chung thư mục mô hình với trình duyệt -> embedding lúc huấn luyện và lúc chạy giống hệt nhau.
MODEL_DIR = OUT_DIR / MODEL_ID
PREFIX = "query: "  # mô hình e5 yêu cầu tiền tố này cho câu hỏi / phân loại
MAX_TOKENS = 128
MAX_PER_CLASS = 2500  # giới hạn số câu mỗi nhóm cảm xúc để dữ liệu cân bằng, huấn luyện nhanh
VI_WEIGHT = 8.0  # câu tiếng Việt tự soạn ít nhưng quan trọng -> tăng trọng số

# 28 nhãn của GoEmotions (theo đúng thứ tự trong bộ dữ liệu "simplified").
GO_LABELS = [
    "admiration", "amusement", "anger", "annoyance", "approval", "caring", "confusion",
    "curiosity", "desire", "disappointment", "disapproval", "disgust", "embarrassment",
    "excitement", "fear", "gratitude", "grief", "joy", "love", "nervousness", "optimism",
    "pride", "realization", "relief", "remorse", "sadness", "surprise", "neutral",
]

# Gộp 28 nhãn chi tiết thành 6 cảm xúc mà MTD dùng. Nhãn không có trong bảng thì bỏ qua.
GO_TO_MTD = {
    "joy": "happy", "amusement": "happy", "excitement": "happy", "love": "happy",
    "gratitude": "happy", "optimism": "happy", "pride": "happy", "relief": "happy",
    "sadness": "sad", "grief": "sad", "disappointment": "sad", "remorse": "sad",
    "anger": "angry", "annoyance": "angry", "disgust": "angry",
    "fear": "anxious", "nervousness": "anxious",
    "surprise": "surprised",
    "neutral": "neutral",
}
EMOTIONS = ["happy", "sad", "angry", "anxious", "surprised", "neutral"]


class Embedder:
    """Chạy mô hình ONNX đã lượng tử hoá (int8) — đúng file mà trình duyệt dùng qua Transformers.js."""

    def __init__(self) -> None:
        self.tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
        self.tokenizer.enable_truncation(MAX_TOKENS)
        self.tokenizer.enable_padding()
        self.session = ort.InferenceSession(
            str(MODEL_DIR / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"]
        )
        self.input_names = {i.name for i in self.session.get_inputs()}

    def embed(self, texts: list[str], batch_size: int = 64) -> np.ndarray:
        """Trả về ma trận (số câu, 384): mean pooling theo attention mask rồi chuẩn hoá độ dài = 1."""
        vectors = []
        for start in range(0, len(texts), batch_size):
            batch = [PREFIX + t for t in texts[start : start + batch_size]]
            encodings = self.tokenizer.encode_batch(batch)
            ids = np.array([e.ids for e in encodings], dtype=np.int64)
            mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            feeds = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.input_names:
                feeds["token_type_ids"] = np.zeros_like(ids)
            hidden = self.session.run(None, feeds)[0]  # (batch, số token, 384)
            # Mean pooling: lấy trung bình các token thật (bỏ qua token đệm).
            summed = (hidden * mask[:, :, None]).sum(axis=1)
            pooled = summed / mask.sum(axis=1, keepdims=True)
            vectors.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
        return np.vstack(vectors).astype(np.float32)


def load_go_emotions(split: str, max_per_class: int | None) -> tuple[list[str], list[str]]:
    """Đọc GoEmotions, chỉ giữ câu có đúng 1 nhãn và nhãn đó map được sang cảm xúc của MTD."""
    df = pd.read_parquet(CACHE_DIR / f"go_{split}.parquet")
    texts, labels = [], []
    counts: dict[str, int] = {}
    for text, label_ids in zip(df["text"], df["labels"]):
        if len(label_ids) != 1:
            continue
        mood = GO_TO_MTD.get(GO_LABELS[label_ids[0]])
        if mood is None or (max_per_class and counts.get(mood, 0) >= max_per_class):
            continue
        counts[mood] = counts.get(mood, 0) + 1
        texts.append(text)
        labels.append(mood)
    print(f"  GoEmotions [{split}]: {len(texts)} câu — {counts}")
    return texts, labels


def flatten(groups: dict[str, list[str]]) -> tuple[list[str], list[str]]:
    """{nhãn: [câu, ...]} -> (danh sách câu, danh sách nhãn)."""
    texts, labels = [], []
    for label, sentences in groups.items():
        texts += sentences
        labels += [label] * len(sentences)
    return texts, labels


def make_model(c: float) -> Pipeline:
    """StandardScaler + Logistic Regression.

    Các vector của e5 nằm rất sát nhau (mọi câu đều giống nhau ~0.8), nên cần chuẩn hoá từng chiều
    (trừ trung bình, chia độ lệch chuẩn) để mô hình phân biệt rõ hơn và tự tin hơn khi dự đoán.
    """
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, C=c, class_weight="balanced"))


def export_model(path: Path, model: Pipeline, metrics: dict, extra: dict | None = None) -> None:
    """Lưu trọng số ra JSON gọn nhẹ cho trình duyệt.

    Gộp bước chuẩn hoá vào trọng số:  w·((x - mean) / scale) + b  =  (w / scale)·x + (b - Σ w·mean / scale)
    nên trình duyệt chỉ cần tính W·x + b như một Logistic Regression bình thường.
    """
    scaler: StandardScaler = model[0]
    clf: LogisticRegression = model[-1]
    weights = clf.coef_ / scaler.scale_
    bias = clf.intercept_ - weights @ scaler.mean_
    data = {
        "embedding_model": MODEL_ID,
        "prefix": PREFIX,
        "classes": [str(c) for c in clf.classes_],
        "weights": np.round(weights, 5).tolist(),
        "bias": np.round(bias, 5).tolist(),
        "metrics": metrics,
        **(extra or {}),
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"  -> đã lưu {path.relative_to(ML_DIR.parent)} ({path.stat().st_size // 1024} KB)")


def train_emotion(embedder: Embedder) -> None:
    """Bộ phân loại cảm xúc: GoEmotions (tiếng Anh) + câu tiếng Việt tự soạn."""
    print("\n=== CẢM XÚC ===")
    vi = json.loads((DATA_DIR / "vi_emotions.json").read_text(encoding="utf-8"))
    en_texts, en_labels = load_go_emotions("train", MAX_PER_CLASS)
    en_test_texts, en_test_labels = load_go_emotions("test", 300)
    vi_texts, vi_labels = flatten(vi["train"])
    vi_test_texts, vi_test_labels = flatten(vi["test"])

    start = time.time()
    x_en = embedder.embed(en_texts)
    x_vi = embedder.embed(vi_texts)
    x_en_test = embedder.embed(en_test_texts)
    x_vi_test = embedder.embed(vi_test_texts)
    print(f"  Tạo embedding xong trong {time.time() - start:.0f} giây")

    # Thí nghiệm 1: chỉ học tiếng Anh -> thử trên tiếng Việt (kiểm tra khả năng "chuyển ngôn ngữ").
    only_en = make_model(0.05)
    only_en.fit(x_en, en_labels)
    acc_cross = accuracy_score(vi_test_labels, only_en.predict(x_vi_test))
    print(f"  [Chỉ học tiếng Anh] độ chính xác trên câu tiếng Việt: {acc_cross:.0%}")

    # Thí nghiệm 2: học tiếng Anh + câu tiếng Việt tự soạn (có trọng số cao hơn).
    x_all = np.vstack([x_en, x_vi])
    y_all = en_labels + vi_labels
    weights = np.array([1.0] * len(en_labels) + [VI_WEIGHT] * len(vi_labels))
    clf = make_model(0.05)  # C nhỏ = điều chuẩn mạnh, tránh học thuộc lòng dữ liệu tiếng Anh
    clf.fit(x_all, y_all, logisticregression__sample_weight=weights)
    acc_vi = accuracy_score(vi_test_labels, clf.predict(x_vi_test))
    acc_en = accuracy_score(en_test_labels, clf.predict(x_en_test))
    print(f"  [Anh + Việt] tiếng Việt: {acc_vi:.0%} | tiếng Anh (GoEmotions test): {acc_en:.0%}")
    print(classification_report(vi_test_labels, clf.predict(x_vi_test), zero_division=0))

    export_model(
        OUT_DIR / "emotion.json",
        clf,
        {"vi_test_accuracy": round(acc_vi, 3), "en_test_accuracy": round(acc_en, 3), "vi_cross_lingual_only_en": round(acc_cross, 3)},
        {"datasets": ["google-research-datasets/go_emotions (Apache-2.0)", "ml/data/vi_emotions.json (tự soạn)"]},
    )


def train_intent(embedder: Embedder) -> None:
    """Bộ phân loại ý định: hiểu câu nói theo NGHĨA thay vì chỉ dò từ khoá."""
    print("\n=== Ý ĐỊNH ===")
    data = json.loads((DATA_DIR / "vi_intents.json").read_text(encoding="utf-8"))
    train_texts, train_labels = flatten(data["train"])
    test_texts, test_labels = flatten(data["test"])
    x_train = embedder.embed(train_texts)
    x_test = embedder.embed(test_texts)

    clf = make_model(0.5)
    clf.fit(x_train, train_labels)
    proba = clf.predict_proba(x_test)
    predicted = clf.classes_[proba.argmax(axis=1)]
    confidence = proba.max(axis=1)
    acc = accuracy_score(test_labels, predicted)
    print(f"  Độ chính xác trên câu test: {acc:.0%}")

    # Chọn ngưỡng tin cậy: chỉ làm theo khi chắc chắn, tránh tự dưng lộn vòng khi người dùng đang tâm sự.
    chosen = 0.9
    for threshold in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        sure = confidence >= threshold
        wrong_action = sum(1 for p, t, s in zip(predicted, test_labels, sure) if s and p != t and p != "chat")
        print(f"  Ngưỡng {threshold}: tự tin {sure.mean():.0%} câu, hành động nhầm {wrong_action} câu")
        if wrong_action == 0 and threshold < chosen:
            chosen = threshold
    # Không có ngưỡng nào thấp hơn 0.5 đáng tin bằng: an toàn hơn là bỏ sót (vẫn còn não AI trò chuyện).
    chosen = max(chosen, 0.5)
    print(f"  => Chọn ngưỡng {chosen}")
    for text, p, t, c in zip(test_texts, predicted, test_labels, confidence):
        if p != t:
            print(f"    sai: '{text}' -> {p} ({c:.2f}), đúng là {t}")

    export_model(
        OUT_DIR / "intent.json",
        clf,
        {"test_accuracy": round(acc, 3)},
        {"threshold": chosen, "datasets": ["ml/data/vi_intents.json (tự soạn)"]},
    )


def main() -> None:
    """Huấn luyện cả hai bộ phân loại và xuất ra thư mục models/."""
    OUT_DIR.mkdir(exist_ok=True)
    embedder = Embedder()
    train_intent(embedder)
    train_emotion(embedder)


if __name__ == "__main__":
    main()
