# SkillSense — AI Skill Assessment & Personalised Learning Plan Agent

> A resume tells you what someone *claims* to know — not how well they actually know it.

SkillSense takes a Job Description and a candidate's resume, **conversationally assesses real proficiency** on each required skill, identifies gaps, and generates a **personalised learning plan** with curated resources and time estimates.

Built for [Catalyst Hackathon — Deccan AI](https://deccan.ai)

---

## Demo

| Step | What Happens |
|------|-------------|
| 1 | Paste a JD + Resume (or upload PDF) |
| 2 | Agent extracts required skills and candidate profile |
| 3 | Conversational interview — targeted questions per skill |
| 4 | Visual learning plan: skill scores, gap cards, curated resources, practice projects |
| 5 | Download the plan as JSON or print/save as PDF |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Vanilla JS)                      │
│  Setup Form → Chat Interface → Learning Plan Visualiser          │
│  SSE streaming for real-time token-by-token responses            │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────────────────────┐
│                   FastAPI Backend (Python)                        │
│                                                                   │
│  POST /api/start      ← JD text + Resume text                    │
│    └─ Claude Haiku  ← extract required skills + candidate info   │
│    └─ Claude Sonnet ← generate initial greeting                  │
│                                                                   │
│  POST /api/chat       ← user message                             │
│    └─ Claude Sonnet  (streaming) ← assessment conversation       │
│    └─ detects [PLAN_START]…[PLAN_END] → emits `plan` SSE event  │
│                                                                   │
│  POST /api/upload-pdf ← PDF bytes → pypdf → plain text           │
└────────────────────┬────────────────────────────────────────────┘
                     │ Anthropic Python SDK (async)
┌────────────────────▼────────────────────────────────────────────┐
│                   Anthropic API                                   │
│   claude-haiku-4-5   — fast skill/info extraction                │
│   claude-sonnet-4-6  — conversational assessment + plan gen      │
│   gemini-2.5-flash-lite — voice transcription (optional)         │
└─────────────────────────────────────────────────────────────────┘
```

### Scoring Logic

Each required skill is assessed through natural conversation:

- **Extraction phase** (Haiku): Parse JD → required skills with importance levels; parse resume → claimed skills with context.  
- **Assessment phase** (Sonnet): The agent asks 1 focused question + 1 follow-up per skill. Questions probe real scenarios and practical decisions — not definitions.  
- **Scoring** (internal, 1–5): `1=Aware` · `2=Beginner` · `3=Intermediate` · `4=Advanced` · `5=Expert`  
- **Gap threshold**: skills scored ≤ 3 that are marked `critical` or `high` importance feed into the learning plan.  
- **Adjacent skill mapping**: The plan identifies which skills become easier to acquire once a gap skill is learned, enabling efficient learning order recommendations.  
- **Overall fit %**: Weighted average of skill scores vs. target levels, considering importance weights from the JD.

---

## Local Setup

### Prerequisites
- Python 3.11+
- An [Anthropic API key](https://console.anthropic.com) (Claude Sonnet 4.6 + Haiku 4.5)
- *Optional:* a free [Gemini API key](https://aistudio.google.com) — only needed if you want voice/audio transcription

### Steps

```bash
# 1. Clone
git clone https://github.com/iamhero337/IntTeachAgent.git
cd IntTeachAgent

# 2. Create virtual environment
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Set your API keys
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...   (required)
#   GEMINI_API_KEY=AIza...         (optional — voice transcription only)

# 5. Run
python main.py
```

Visit **http://localhost:8000**

---

## Sample Inputs

Ready-to-use examples are in the [`samples/`](samples/) directory:

| File | Description |
|------|-------------|
| [`sample_jd.txt`](samples/sample_jd.txt) | Senior Full-Stack Engineer — FinTech (Python/React/AWS/Docker) |
| [`sample_resume.txt`](samples/sample_resume.txt) | Mid-level engineer with some gaps — realistic demo profile |

---

## Project Structure

```
IntTeachAgent/
├── main.py          # FastAPI app — routes, SSE streaming
├── agent.py         # Core agent logic (Anthropic async client)
├── utils.py         # PDF text extraction (pypdf)
├── requirements.txt
├── .env.example
├── static/
│   ├── index.html   # Single-page app
│   ├── style.css    # Dark-theme UI
│   └── app.js       # Chat, streaming, results renderer
└── samples/
    ├── sample_jd.txt
    └── sample_resume.txt
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI backbone | Claude Sonnet 4.6 (assessment + plan) + Claude Haiku 4.5 (extraction) |
| Voice transcription | Gemini 2.5 Flash-Lite (optional, audio → text) |
| Backend | FastAPI + uvicorn, Python 3.11 |
| Streaming | Server-Sent Events (SSE) via `StreamingResponse` |
| PDF parsing | pypdf |
| Frontend | Vanilla JS + CSS (no framework) |
| Hosting | Local / any ASGI-compatible host (Railway, Fly.io, Render) |

---

## Hackathon Submission
- **Event**: Catalyst — Deccan AI Hackathon
- **Deadline**: April 27, 2026, 1:00 AM IST
- **Repo access for review**: [hackathon@deccan.ai](mailto:hackathon@deccan.ai)
