from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json

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


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.post("/api/start")
async def start_session(request: StartRequest):
    if not request.jd_text.strip() or not request.resume_text.strip():
        raise HTTPException(status_code=400, detail="Both JD and Resume text are required.")
    try:
        result = await agent.start_session(request.jd_text, request.resume_text)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat")
async def chat_stream(request: ChatRequest):
    async def generate():
        try:
            async for chunk in agent.chat_stream(request.session_id, request.message):
                yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


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
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
