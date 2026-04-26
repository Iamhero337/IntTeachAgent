import os
import uuid
import json
import re
from typing import AsyncGenerator, Optional

from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

_client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))

MODEL = "gemini-2.5-flash-lite"   # ~1500 req/day on free tier

EXTRACTION_SYSTEM = (
    "You are a document analyzer. Extract structured data from job descriptions and resumes. "
    "Always output valid JSON only — no markdown, no explanation."
)

EXTRACTION_USER_TEMPLATE = """Analyze the job description and resume below.

JOB DESCRIPTION:
{jd_text}

RESUME:
{resume_text}

Output ONLY valid JSON (no other text, no code fences):
{{
  "required_skills": [
    {{"skill": "Python", "importance": "critical", "years_expected": 3}},
    {{"skill": "Docker", "importance": "high", "years_expected": 2}}
  ],
  "candidate_skills": [
    {{"skill": "Python", "years": 3, "context": "web development"}},
    {{"skill": "Docker", "years": 1, "context": "basic usage"}}
  ],
  "candidate_name": "Full name or Candidate",
  "candidate_summary": "Two-sentence professional summary of candidate background.",
  "role_title": "Job title from the JD"
}}

Rules:
- required_skills: technical skills, tools, frameworks, databases, cloud. Max 10, ordered by importance.
- candidate_skills: only skills explicitly mentioned in the resume.
- years_expected / years: 0 if not stated."""

ASSESSMENT_SYSTEM_TEMPLATE = """You are SkillSense, an expert technical assessor and career coach. \
You are conducting a focused conversational interview to measure a candidate's REAL proficiency.

## Role: {role_title}

## Skills to Assess ({skill_count} total, in order of importance)
{required_skills_str}

## Candidate: {candidate_name}
{candidate_summary}

## What They Claim
{candidate_skills_str}

## Interview Rules
1. Ask ONE question per message — never bundle multiple questions.
2. Probe real experience and practical understanding, not definitions.
3. After receiving an answer, ask ONE targeted follow-up if needed, then move on.
4. Be warm, professional, and encouraging throughout.
5. Work through ALL {skill_count} skills. Do not skip any.
6. Internal proficiency scale (never share scores mid-interview):
   1=Aware only | 2=Beginner | 3=Intermediate | 4=Advanced | 5=Expert

## Effective Question Patterns
- "Walk me through a real project where you used [skill] — what was the trickiest part?"
- "What's something about [skill] that catches most beginners off guard?"
- "How do you handle [common challenge] when working with [skill]?"
- "If you had to explain [key concept] to a junior dev, how would you approach it?"

## Integrity Signals
Each user message may end with a hidden bracketed `[Integrity: …]` note that the candidate cannot see. When you see signals like *paste detected*, *tab switched*, *answer too fast*, or *answer length suspicious*, do NOT accuse the candidate. Instead:
- Probe deeper with a follow-up that requires personal experience that can't be googled
- Ask "what would you NOT do" / failure-mode questions
- Lower your confidence when scoring that skill
- In the final plan, factor reduced confidence into the score

## After ALL {skill_count} Skills Are Assessed
Wrap up naturally, then output EXACTLY this structure (valid JSON between the markers):

---
Thank you, {candidate_name}! I've completed the assessment. Here's what I found:

[2-3 sentence honest summary of their profile, strengths, and biggest opportunity areas]

[PLAN_START]
{{
  "candidate_name": "{candidate_name}",
  "role": "{role_title}",
  "overall_fit_percentage": <realistic 0-100>,
  "skill_scores": {{
    "<skill>": <1-5>
  }},
  "strengths": ["<skills scored 4-5>"],
  "gaps": ["<skills scored 1-3>"],
  "learning_plan": [
    {{
      "skill": "<skill name>",
      "current_level": <1-5>,
      "target_level": <minimum needed>,
      "priority": "critical|high|medium",
      "time_estimate_weeks": <realistic integer>,
      "learning_path": "<specific step-by-step approach in 2-3 sentences>",
      "resources": [
        {{
          "title": "<real resource name>",
          "type": "course|book|docs|tutorial|project|video",
          "provider": "<Coursera/O'Reilly/YouTube/official/etc>",
          "estimated_hours": <integer>,
          "url_hint": "<search term or known URL>",
          "why_recommended": "<why this fits this specific candidate>"
        }}
      ],
      "adjacent_skills_unlocked": ["<skill easier to learn after this one>"],
      "practice_project": "<specific mini-project to build for hands-on practice>"
    }}
  ],
  "learning_timeline": "<honest X weeks/months to be job-ready>",
  "priority_focus": "<the single most impactful area to tackle first>",
  "encouragement": "<genuine, specific motivating note for this person>"
}}
[PLAN_END]"""


def _to_gemini_messages(messages: list[dict]) -> list[types.Content]:
    """Convert OpenAI-style messages to Gemini Content list."""
    result = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        result.append(types.Content(role=role, parts=[types.Part(text=m["content"])]))
    return result


class SkillAssessmentAgent:
    def __init__(self) -> None:
        self.sessions: dict = {}

    async def start_session(self, jd_text: str, resume_text: str) -> dict:
        extraction = await self._extract_info(jd_text, resume_text)

        required_skills = extraction.get("required_skills", [])[:10]
        candidate_skills = extraction.get("candidate_skills", [])
        candidate_name = extraction.get("candidate_name", "Candidate")
        candidate_summary = extraction.get("candidate_summary", "Background not available.")
        role_title = extraction.get("role_title", "the position")

        required_skills_str = "\n".join(
            f"- {s['skill']} ({s.get('importance', 'required')})" for s in required_skills
        )
        candidate_skills_str = (
            "\n".join(
                f"- {s['skill']}: {s.get('years', '?')} yrs — {s.get('context', '')}"
                for s in candidate_skills
            )
            or "No specific skills listed in resume"
        )

        system_prompt = ASSESSMENT_SYSTEM_TEMPLATE.format(
            role_title=role_title,
            skill_count=len(required_skills),
            required_skills_str=required_skills_str,
            candidate_name=candidate_name,
            candidate_summary=candidate_summary,
            candidate_skills_str=candidate_skills_str,
        )

        init_response = await _client.aio.models.generate_content(
            model=MODEL,
            contents=[types.Content(role="user", parts=[types.Part(text="Please begin the assessment.")])],
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                max_output_tokens=600,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        initial_message = (init_response.text or "").strip()

        session_id = str(uuid.uuid4())
        self.sessions[session_id] = {
            "system_prompt": system_prompt,
            "messages": [
                {"role": "user", "content": "Please begin the assessment."},
                {"role": "assistant", "content": initial_message},
            ],
            "required_skills": required_skills,
            "candidate_info": extraction,
            "phase": "assessment",
            "learning_plan": None,
        }

        return {
            "session_id": session_id,
            "initial_message": initial_message,
            "required_skills": required_skills,
            "candidate_info": {
                "name": candidate_name,
                "role": role_title,
                "summary": candidate_summary,
            },
        }

    async def chat_stream(
        self,
        session_id: str,
        user_message: str,
        integrity: Optional[dict] = None,
    ) -> AsyncGenerator[dict, None]:
        if session_id not in self.sessions:
            yield {"type": "error", "content": "Session not found"}
            return

        session = self.sessions[session_id]

        augmented = self._with_integrity_note(user_message, integrity)
        session["messages"].append({"role": "user", "content": augmented})
        session["integrity_log"] = session.get("integrity_log", [])
        if integrity:
            session["integrity_log"].append(integrity)

        full_response = ""
        visible_buffer = ""
        plan_started = False
        MARKER = "[PLAN_START]"

        stream = await _client.aio.models.generate_content_stream(
            model=MODEL,
            contents=_to_gemini_messages(session["messages"]),
            config=types.GenerateContentConfig(
                system_instruction=session["system_prompt"],
                max_output_tokens=4096,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )

        async for chunk in stream:
            text = chunk.text or ""
            if not text:
                continue

            full_response += text

            if plan_started:
                continue

            visible_buffer += text

            if MARKER in visible_buffer:
                idx = visible_buffer.index(MARKER)
                pre = visible_buffer[:idx].rstrip()
                if pre:
                    yield {"type": "text", "content": pre}
                plan_started = True
                visible_buffer = ""
                yield {"type": "generating_plan"}
                continue

            if len(visible_buffer) > len(MARKER):
                emit = visible_buffer[: -len(MARKER)]
                visible_buffer = visible_buffer[-len(MARKER):]
                yield {"type": "text", "content": emit}

        if not plan_started and visible_buffer:
            yield {"type": "text", "content": visible_buffer}

        session["messages"].append({"role": "assistant", "content": full_response})

        if MARKER in full_response and "[PLAN_END]" in full_response:
            plan = self._extract_plan(full_response)
            if plan:
                session["learning_plan"] = plan
                session["phase"] = "complete"
                yield {"type": "plan", "content": plan}

    def _with_integrity_note(self, user_message: str, integrity: Optional[dict]) -> str:
        if not integrity:
            return user_message
        notes = []
        if integrity.get("pasted"):
            notes.append("answer was pasted from clipboard")
        if integrity.get("tab_switches", 0) > 0:
            notes.append(f"tab switched away {integrity['tab_switches']}x while typing")
        rt = integrity.get("response_time_seconds")
        chars = integrity.get("char_count", 0)
        if isinstance(rt, (int, float)):
            if rt < 8 and chars > 200:
                notes.append(f"answer typed in {rt:.0f}s — suspiciously fast for {chars} chars")
            elif rt > 180:
                notes.append(f"took {rt:.0f}s to answer (deliberation, not necessarily a flag)")
        if integrity.get("voice_used"):
            notes.append("answer was dictated via voice")
        if not notes:
            return user_message
        return f"{user_message}\n\n[Integrity: {'; '.join(notes)}]"

    async def _extract_info(self, jd_text: str, resume_text: str) -> dict:
        prompt = EXTRACTION_USER_TEMPLATE.format(
            jd_text=jd_text[:4000], resume_text=resume_text[:4000]
        )
        response = await _client.aio.models.generate_content(
            model=MODEL,
            contents=[types.Content(role="user", parts=[types.Part(text=prompt)])],
            config=types.GenerateContentConfig(
                system_instruction=EXTRACTION_SYSTEM,
                max_output_tokens=1500,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        raw = (response.text or "").strip()
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start : end + 1]
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
        return {
            "required_skills": [{"skill": "General Technical Skills", "importance": "required"}],
            "candidate_skills": [],
            "candidate_name": "Candidate",
            "candidate_summary": "Candidate background could not be parsed.",
            "role_title": "the position",
        }

    def _extract_plan(self, text: str) -> Optional[dict]:
        match = re.search(r"\[PLAN_START\](.*?)\[PLAN_END\]", text, re.DOTALL)
        if not match:
            return None
        json_text = match.group(1).strip()
        json_text = re.sub(r"^```(?:json)?\s*", "", json_text)
        json_text = re.sub(r"\s*```$", "", json_text).strip()
        try:
            return json.loads(json_text)
        except json.JSONDecodeError:
            json_text = re.sub(r",\s*([}\]])", r"\1", json_text)
            try:
                return json.loads(json_text)
            except Exception:
                return None

    def get_session(self, session_id: str) -> Optional[dict]:
        session = self.sessions.get(session_id)
        if not session:
            return None
        return {
            "session_id": session_id,
            "phase": session["phase"],
            "required_skills": session["required_skills"],
            "learning_plan": session["learning_plan"],
            "message_count": len(session["messages"]),
        }
