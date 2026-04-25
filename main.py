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


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "api_key_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "active_sessions": len(agent.sessions),
    }


def _friendly_error(e: Exception) -> tuple[int, str]:
    msg = str(e)
    if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "quota" in msg.lower():
        return 429, (
            "The Gemini free tier daily quota has been hit. "
            "Either wait for the daily reset or enable billing in Google AI Studio "
            "(very cheap — pennies per assessment)."
        )
    if "401" in msg or "API key" in msg.lower() or "permission" in msg.lower():
        return 401, "Invalid or missing GEMINI_API_KEY. Check your environment variable."
    return 500, msg


@app.post("/api/start")
async def start_session(request: StartRequest):
    if not request.jd_text.strip() or not request.resume_text.strip():
        raise HTTPException(status_code=400, detail="Both JD and Resume text are required.")
    try:
        result = await agent.start_session(request.jd_text, request.resume_text)
        return result
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
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file")
        from google.genai import types
        from agent import _client, FAST_MODEL
        mime = audio.content_type or "audio/webm"
        response = await _client.aio.models.generate_content(
            model=FAST_MODEL,
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
        code, friendly = _friendly_error(e)
        raise HTTPException(status_code=code, detail=friendly)


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
    reload = os.environ.get("RAILWAY_ENVIRONMENT") is None
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=reload)
