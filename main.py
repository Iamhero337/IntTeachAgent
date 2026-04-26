import json
import os
import sys

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

if not os.environ.get("GEMINI_API_KEY"):
    print(
        "\n  ERROR: GEMINI_API_KEY is not set.\n"
        "  Create a .env file (copy .env.example) and add your key from https://aistudio.google.com\n",
        file=sys.stderr,
    )
    sys.exit(1)

from agent import SkillAssessmentAgent
from utils import extract_text_from_pdf

# Gemini client reused for voice transcription
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
_gemini = None
try:
    from google import genai as _genai
    _gemini = _genai.Client(api_key=GEMINI_KEY)
except Exception as e:
    print(f"  WARNING: Could not initialise Gemini client for voice: {e}", file=sys.stderr)

app = FastAPI(title="SkillSense – AI Skill Assessment Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = SkillAssessmentAgent()


class StartRequest(BaseModel):
    jd_text: str
    resume_text: str


class ChatRequest(BaseModel):
    session_id: str
    message: str
    integrity: dict | None = None


def _friendly_error(e: Exception) -> tuple[int, str]:
    msg = str(e)
    low = msg.lower()
    if "429" in msg or "rate" in low or "quota" in low or "resource_exhausted" in low:
        return 429, (
            "API rate limit hit. If this is your Anthropic key, you may have run out of credits "
            "— top up at console.anthropic.com. If the limit clears in a minute, just try again."
        )
    if "401" in msg or "invalid api key" in low or "authentication" in low or "permission" in low:
        return 401, "Invalid or missing API key. Check ANTHROPIC_API_KEY in your environment."
    if "overloaded" in low or "503" in msg:
        return 503, "Anthropic is temporarily overloaded. Please retry in a few seconds."
    return 500, msg


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "gemini_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "voice_enabled": _gemini is not None,
        "active_sessions": len(agent.sessions),
    }


@app.post("/api/start")
async def start_session(request: StartRequest):
    if not request.jd_text.strip() or not request.resume_text.strip():
        raise HTTPException(status_code=400, detail="Both JD and Resume text are required.")
    try:
        return await agent.start_session(request.jd_text, request.resume_text)
    except Exception as e:
        code, friendly = _friendly_error(e)
        raise HTTPException(status_code=code, detail=friendly)


@app.post("/api/chat")
async def chat_stream(request: ChatRequest):
    async def generate():
        try:
            async for chunk in agent.chat_stream(
                request.session_id, request.message, request.integrity
            ):
                yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as e:
            _, friendly = _friendly_error(e)
            yield f"data: {json.dumps({'type': 'error', 'content': friendly})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    if _gemini is None:
        raise HTTPException(status_code=503, detail="Voice transcription unavailable.")
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")
        from google.genai import types
        mime = audio.content_type or "audio/webm"
        response = await _gemini.aio.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=mime),
                "Transcribe this audio verbatim. Output only the transcript — no preamble, no explanation, no quotes.",
            ],
            config=types.GenerateContentConfig(
                max_output_tokens=2000,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        text = (response.text or "").strip()
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")
    try:
        content = await file.read()
        text = extract_text_from_pdf(content)
        if not text.strip():
            raise HTTPException(status_code=400, detail="Could not extract text from this PDF.")
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF parse error: {e}")


@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    data = agent.get_session(session_id)
    if not data:
        raise HTTPException(status_code=404, detail="Session not found.")
    return data


app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    reload = os.environ.get("RAILWAY_ENVIRONMENT") is None and os.environ.get("RENDER") is None
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=reload)
