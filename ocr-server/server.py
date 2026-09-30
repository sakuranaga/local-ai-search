"""Lightweight OCR server powered by Surya v2.

Accepts image or PDF files and returns extracted text.
Uses llama.cpp (llama-server) as the VLM inference backend. Surya v2 does
not need torch on the GPU, so set TORCH_DEVICE=cpu on hosts where ROCm is
unstable.
"""

import os

_sentry_dsn = os.environ.get("SENTRY_DSN")
if _sentry_dsn:
    import sentry_sdk
    sentry_sdk.init(_sentry_dsn)

import html
import io
import logging
import re
import time
from contextlib import asynccontextmanager

import pypdfium2 as pdfium
from fastapi import FastAPI, File, UploadFile
from PIL import Image
from pydantic import BaseModel
from surya.inference import SuryaInferenceManager
from surya.recognition import RecognitionPredictor

logger = logging.getLogger("ocr-server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

rec_predictor: RecognitionPredictor | None = None
manager: SuryaInferenceManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global rec_predictor, manager
    logger.info("Starting Surya v2 inference backend...")
    # Start llama-server eagerly so startup failures surface immediately
    # instead of on the first OCR request.
    manager = SuryaInferenceManager(lazy=False)
    rec_predictor = RecognitionPredictor(manager)
    logger.info("Surya v2 ready (backend=%s).", manager.method)
    yield
    logger.info("Shutting down OCR server.")
    manager.stop()


app = FastAPI(title="OCR Server", lifespan=lifespan)


class OCRResult(BaseModel):
    text: str
    pages: int


def _images_from_pdf(data: bytes, dpi: int = 300) -> list[Image.Image]:
    """Render PDF pages to PIL images."""
    pdf = pdfium.PdfDocument(data)
    images = []
    scale = dpi / 72
    for page in pdf:
        bitmap = page.render(scale=scale)
        images.append(bitmap.to_pil())
    pdf.close()
    return images


_MAX_DIMENSION = 4000


def _limit_size(img: Image.Image) -> Image.Image:
    """Downscale image if either dimension exceeds _MAX_DIMENSION."""
    w, h = img.size
    if w <= _MAX_DIMENSION and h <= _MAX_DIMENSION:
        return img
    scale = min(_MAX_DIMENSION / w, _MAX_DIMENSION / h)
    new_w, new_h = int(w * scale), int(h * scale)
    logger.info("Resizing %dx%d → %dx%d", w, h, new_w, new_h)
    return img.resize((new_w, new_h), Image.LANCZOS)


def _ocr_images(images: list[Image.Image]) -> str:
    """Run Surya v2 OCR on a list of images and return combined text."""
    images = [_limit_size(img) for img in images]
    predictions = rec_predictor(images)
    parts: list[str] = []
    for page in predictions:
        lines = []
        for block in sorted(page.blocks, key=lambda b: b.reading_order):
            if block.skipped or block.error:
                continue
            text = html.unescape(re.sub(r"<[^>]+>", "", block.html)).strip()
            if text:
                lines.append(text)
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


@app.post("/ocr", response_model=OCRResult)
async def ocr(file: UploadFile = File(...)):
    """Accept an image or PDF and return OCR text."""
    data = await file.read()
    content_type = file.content_type or ""
    filename = (file.filename or "").lower()

    if content_type == "application/pdf" or filename.endswith(".pdf"):
        images = _images_from_pdf(data)
    else:
        images = [Image.open(io.BytesIO(data)).convert("RGB")]

    logger.info("OCR: processing %d page(s) from %s", len(images), file.filename)
    t0 = time.time()
    text = _ocr_images(images)
    elapsed = time.time() - t0
    logger.info("OCR: extracted %d chars in %.1fs", len(text), elapsed)

    return OCRResult(text=text, pages=len(images))


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": rec_predictor is not None}
