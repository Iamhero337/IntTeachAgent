/* ── State ────────────────────────────────────────────────────────────── */
let sessionId = null;
let planData   = null;
let isSending  = false;
let currentBotBubble = null;

/* ── Integrity tracking (per-turn + cumulative) ────────────────────────── */
const integrity = {
  total: { pastes: 0, tabSwitches: 0, answerTimes: [] },
  turn:  resetTurn(),
};

function resetTurn() {
  return {
    pasted: false,
    tabSwitches: 0,
    voiceUsed: false,
    inputStartTime: null,
    charCount: 0,
  };
}

/* ── Voice input (MediaRecorder + backend Gemini transcription) ────────── */
let mediaRecorder = null;
let audioChunks   = [];
let recordStream  = null;
let isListening   = false;
let isTranscribing = false;

/* ── Screen helpers ──────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showLoader(msg = 'Analysing documents…') {
  document.querySelector('#loader p').textContent = msg;
  document.getElementById('loader').classList.add('active');
}

function hideLoader() {
  document.getElementById('loader').classList.remove('active');
}

function toast(msg, type = 'error') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

/* ── PDF upload ───────────────────────────────────────────────────────── */
function triggerPDFUpload() {
  document.getElementById('pdf-input').click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pdf-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    const fd = new FormData();
    fd.append('file', file);
    showLoader('Parsing PDF…');

    try {
      const res = await fetch('/api/upload-pdf', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json();
        toast(err.detail || 'PDF parse failed');
        return;
      }
      const data = await res.json();
      document.getElementById('resume-input').value = data.text;
      toast('Resume extracted from PDF', 'success');
    } catch {
      toast('Could not upload PDF');
    } finally {
      hideLoader();
      e.target.value = '';
    }
  });

  /* Auto-grow textarea + track first input time */
  const ta = document.getElementById('user-input');
  ta.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
    if (!integrity.turn.inputStartTime && this.value.trim().length > 0) {
      integrity.turn.inputStartTime = Date.now();
    }
    integrity.turn.charCount = this.value.length;
  });

  /* Track paste */
  ta.addEventListener('paste', () => {
    integrity.turn.pasted = true;
    integrity.total.pastes++;
    updateIntegrityPanel();
  });

  /* Track tab switches (mid-answer) */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && sessionId) {
      integrity.turn.tabSwitches++;
      integrity.total.tabSwitches++;
      updateIntegrityPanel();
    }
  });

  /* Enter to send (Shift+Enter = newline) */
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  /* Voice input check */
  initVoiceRecognition();
});

/* ── Integrity panel UI ─────────────────────────────────────────────── */
function updateIntegrityPanel() {
  const set = (id, val) => {
    const el = document.querySelector(`#${id} .int-value`);
    if (el) el.textContent = val;
  };
  set('int-pastes', integrity.total.pastes);
  set('int-tabs',   integrity.total.tabSwitches);
  const times = integrity.total.answerTimes;
  if (times.length) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    set('int-time', `${Math.round(avg)}s`);
  }

  /* Highlight rows with non-zero values */
  document.getElementById('int-pastes').classList.toggle('flagged', integrity.total.pastes > 0);
  document.getElementById('int-tabs').classList.toggle('flagged', integrity.total.tabSwitches > 0);
}

/* ── Voice input (records audio, backend transcribes via Gemini) ───── */
let voiceEnabled = false;

async function initVoiceRecognition() {
  const micBtn = document.getElementById('mic-btn');
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    micBtn.disabled = true;
    micBtn.title = 'Voice input not supported in this browser';
    micBtn.style.opacity = '0.4';
    return;
  }
  /* Check whether backend has voice transcription enabled */
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    voiceEnabled = !!data.voice_enabled;
    if (!voiceEnabled) {
      micBtn.disabled = true;
      micBtn.title = 'Voice input not configured (GEMINI_API_KEY not set on server)';
      micBtn.style.opacity = '0.35';
    }
  } catch {
    /* Health check failed — leave mic enabled, user will see error on click */
  }
}

async function toggleMic() {
  if (isTranscribing) return;
  if (isListening) {
    stopMic();
    return;
  }

  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Microphone access denied. Allow mic in browser settings.', 'error');
    return;
  }

  /* Pick a MIME the browser can record */
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';

  try {
    mediaRecorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
  } catch {
    toast('Could not start recorder', 'error');
    recordStream.getTracks().forEach(t => t.stop());
    return;
  }

  audioChunks = [];
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = handleRecordingStop;

  mediaRecorder.start();
  isListening = true;
  document.getElementById('mic-btn').classList.add('listening');
  document.getElementById('mic-btn').textContent = '⏹';
  document.getElementById('mic-btn').title = 'Click to stop and transcribe';
}

function stopMic() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isListening = false;
}

async function handleRecordingStop() {
  recordStream && recordStream.getTracks().forEach(t => t.stop());

  const micBtn = document.getElementById('mic-btn');
  micBtn.classList.remove('listening');
  micBtn.classList.add('transcribing');
  micBtn.textContent = '…';
  micBtn.title = 'Transcribing…';
  isTranscribing = true;

  const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  if (blob.size < 500) {
    toast('Recording too short — try again', 'error');
    resetMicButton();
    return;
  }

  try {
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || 'Transcription failed', 'error');
    } else {
      const data = await res.json();
      const ta = document.getElementById('user-input');
      const sep = ta.value && !ta.value.endsWith(' ') ? ' ' : '';
      ta.value = ta.value + sep + (data.text || '');
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      integrity.turn.voiceUsed = true;
    }
  } catch {
    toast('Network error during transcription', 'error');
  } finally {
    resetMicButton();
  }
}

function resetMicButton() {
  isTranscribing = false;
  const micBtn = document.getElementById('mic-btn');
  micBtn.classList.remove('listening', 'transcribing');
  micBtn.textContent = '🎤';
  micBtn.title = 'Voice input (records, then transcribes via Gemini)';
}

/* ── Start Assessment ─────────────────────────────────────────────────── */
async function startAssessment() {
  const jd     = document.getElementById('jd-input').value.trim();
  const resume = document.getElementById('resume-input').value.trim();

  if (!jd)     { toast('Please paste a Job Description');    return; }
  if (!resume) { toast('Please paste or upload your Resume'); return; }

  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  showLoader('Analysing JD & Resume…');

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jd_text: jd, resume_text: resume }),
    });

    if (!res.ok) {
      const err = await res.json();
      toast(err.detail || 'Failed to start session');
      return;
    }

    const data = await res.json();
    sessionId = data.session_id;

    /* Populate sidebar */
    populateSidebar(data.candidate_info, data.required_skills);

    /* Show initial message */
    document.getElementById('messages').innerHTML = '';
    appendBotMessage(data.initial_message);

    showScreen('assessment-screen');
    document.getElementById('user-input').focus();
  } catch (err) {
    toast('Connection error. Is the server running?');
  } finally {
    hideLoader();
    btn.disabled = false;
  }
}

/* ── Sidebar ─────────────────────────────────────────────────────────── */
function populateSidebar(info, skills) {
  document.getElementById('cand-name').textContent    = info.name;
  document.getElementById('cand-role').textContent    = info.role;
  document.getElementById('cand-summary').textContent = info.summary;

  const list = document.getElementById('skills-list');
  list.innerHTML = '';
  skills.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'skill-item';
    item.dataset.index = i;
    item.dataset.skill = s.skill;
    item.innerHTML = `
      <span class="skill-dot"></span>
      <span class="skill-name">${s.skill}</span>
      <span class="skill-score"></span>
    `;
    list.appendChild(item);
  });
}

function markSkillAssessed(skillName, score) {
  const items = document.querySelectorAll('.skill-item');
  items.forEach(el => {
    if (el.dataset.skill.toLowerCase() === skillName.toLowerCase()) {
      el.classList.add('assessed');
      el.classList.remove('current');
      el.querySelector('.skill-score').textContent = `${score}/5`;
    }
  });
}

/* ── Chat ─────────────────────────────────────────────────────────────── */
function appendBotMessage(text) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message bot';
  div.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  msgs.appendChild(div);
  scrollToBottom();
  return div.querySelector('.bubble');
}

function appendUserMessage(text) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `
    <div class="avatar">👤</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  msgs.appendChild(div);
  scrollToBottom();
}

function showTypingIndicator() {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message bot';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  msgs.appendChild(div);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function scrollToBottom() {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

/* ── Send message ─────────────────────────────────────────────────────── */
async function sendMessage() {
  if (isSending || !sessionId) return;

  const input = document.getElementById('user-input');
  const msg   = input.value.trim();
  if (!msg) return;

  /* Capture integrity for THIS turn before resetting */
  const t = integrity.turn;
  const responseSeconds = t.inputStartTime
    ? (Date.now() - t.inputStartTime) / 1000
    : null;
  if (responseSeconds != null) integrity.total.answerTimes.push(responseSeconds);
  updateIntegrityPanel();

  const integrityPayload = {
    pasted:                t.pasted,
    tab_switches:          t.tabSwitches,
    voice_used:            t.voiceUsed,
    response_time_seconds: responseSeconds,
    char_count:            msg.length,
  };
  integrity.turn = resetTurn();

  if (isListening) stopMic();
  input.value = '';
  input.style.height = 'auto';
  isSending = true;
  document.getElementById('send-btn').disabled = true;

  appendUserMessage(msg);
  showTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        message: msg,
        integrity: integrityPayload,
      }),
    });

    if (!res.ok) {
      removeTypingIndicator();
      toast('Server error. Try again.');
      return;
    }

    removeTypingIndicator();
    currentBotBubble = appendBotMessage('');
    currentBotBubble.innerHTML = '';

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') break;

        try {
          const chunk = JSON.parse(raw);

          if (chunk.type === 'text') {
            currentBotBubble.innerHTML += escapeHtml(chunk.content)
              .replace(/\n/g, '<br>');
            scrollToBottom();
          }

          if (chunk.type === 'generating_plan') {
            showGeneratingPlanIndicator();
          }

          if (chunk.type === 'plan') {
            removeGeneratingPlanIndicator();
            planData = chunk.content;
            showPlanReadyBanner();
            updateSidebarScores(planData);
          }

          if (chunk.type === 'error') {
            toast(chunk.content);
          }
        } catch { /* partial JSON, ignore */ }
      }
    }
  } catch (err) {
    removeTypingIndicator();
    toast('Connection lost. Please try again.');
  } finally {
    isSending = false;
    document.getElementById('send-btn').disabled = false;
    currentBotBubble = null;
    scrollToBottom();
  }
}

function showGeneratingPlanIndicator() {
  if (document.getElementById('gen-plan-indicator')) return;
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.id = 'gen-plan-indicator';
  div.className = 'gen-plan-indicator';
  div.innerHTML = `
    <div class="spinner-small"></div>
    <span>Building your personalised learning plan…</span>
  `;
  msgs.appendChild(div);
  scrollToBottom();
}

function removeGeneratingPlanIndicator() {
  const el = document.getElementById('gen-plan-indicator');
  if (el) el.remove();
}

function showPlanReadyBanner() {
  const msgs = document.getElementById('messages');
  if (document.getElementById('plan-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'plan-banner';
  banner.className = 'plan-ready-banner';
  banner.innerHTML = `
    <p>✨ Assessment complete — your personalised learning plan is ready.</p>
    <button id="view-plan-btn" onclick="viewPlan()">View Learning Plan →</button>
  `;
  msgs.appendChild(banner);
  scrollToBottom();
}

function updateSidebarScores(plan) {
  if (!plan.skill_scores) return;
  Object.entries(plan.skill_scores).forEach(([skill, score]) => {
    markSkillAssessed(skill, score);
  });
}

/* ── Results screen ───────────────────────────────────────────────────── */
function viewPlan() {
  if (!planData) return;
  renderResults(planData);
  showScreen('results-screen');
}

function backToChat() {
  showScreen('assessment-screen');
}

function backToSetup() {
  sessionId = null;
  planData   = null;
  isSending  = false;
  integrity.total = { pastes: 0, tabSwitches: 0, answerTimes: [] };
  integrity.turn  = resetTurn();
  updateIntegrityPanel();
  document.getElementById('messages').innerHTML = '';
  document.getElementById('skills-list').innerHTML = '';
  document.getElementById('results-container').innerHTML = '';
  document.getElementById('send-btn').disabled = false;
  showScreen('setup-screen');
}

/* ── Render learning plan ─────────────────────────────────────────────── */
function renderResults(plan) {
  const container = document.getElementById('results-container');
  container.innerHTML = '';

  /* Header */
  const header = document.createElement('div');
  header.className = 'results-header';
  header.innerHTML = `
    <div class="results-toolbar no-print">
      <button class="btn-back" onclick="backToChat()">← Back to Chat</button>
      <div style="display:flex;gap:8px">
        <button class="btn-back" onclick="downloadPlan()" title="Download as JSON">⬇ Download</button>
        <button class="btn-back" onclick="window.print()" title="Print or save as PDF">🖨 Print</button>
        <button class="btn-back" onclick="backToSetup()">New Assessment</button>
      </div>
    </div>
    <h2>Your Learning Plan</h2>
    <p>${escapeHtml(plan.candidate_name || 'Candidate')} — ${escapeHtml(plan.role || '')}</p>
  `;
  container.appendChild(header);

  /* Overview card */
  const overviewCard = document.createElement('div');
  overviewCard.className = 'overview-grid';

  const fitPct = plan.overall_fit_percentage || 0;
  const circumference = 2 * Math.PI * 50;
  const offset = circumference * (1 - fitPct / 100);

  overviewCard.innerHTML = `
    <div class="fit-score-wrap">
      <div class="fit-score-circle">
        <svg viewBox="0 0 120 120" width="120" height="120">
          <circle class="track" cx="60" cy="60" r="50"/>
          <circle class="fill" cx="60" cy="60" r="50"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${circumference}"
            id="fit-fill"
            stroke="${fitPct >= 70 ? '#10b981' : fitPct >= 45 ? '#f59e0b' : '#ef4444'}"/>
        </svg>
        <div class="fit-score-label">
          <span class="pct" id="fit-pct">0%</span>
          <span class="lbl">Fit Score</span>
        </div>
      </div>
    </div>
    <div>
      <div class="skill-bars" id="skill-bars"></div>
    </div>
  `;
  container.appendChild(overviewCard);

  /* Animate fit score */
  requestAnimationFrame(() => {
    document.getElementById('fit-fill').style.strokeDashoffset = offset;
    animateCounter('fit-pct', 0, fitPct, 900, v => v + '%');
  });

  /* Skill bars */
  const barsContainer = document.getElementById('skill-bars');
  if (plan.skill_scores) {
    Object.entries(plan.skill_scores).forEach(([skill, score]) => {
      const pct = (score / 5) * 100;
      const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--teal)' : score >= 2 ? 'var(--amber)' : 'var(--red)';
      const row = document.createElement('div');
      row.className = 'skill-bar-row';
      row.innerHTML = `
        <span class="skill-bar-label">${escapeHtml(skill)}</span>
        <div class="skill-bar-track">
          <div class="skill-bar-fill" style="width:0%;background:${color}" data-pct="${pct}"></div>
        </div>
        <span class="skill-bar-score" style="color:${color}">${score}/5</span>
      `;
      barsContainer.appendChild(row);
    });
    requestAnimationFrame(() => {
      document.querySelectorAll('.skill-bar-fill').forEach(el => {
        el.style.width = el.dataset.pct + '%';
      });
    });
  }

  /* Strengths & Gaps */
  if (plan.strengths?.length || plan.gaps?.length) {
    const tagSection = document.createElement('div');
    tagSection.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div class="section-title">💪 Strengths</div>
          <div class="tags">
            ${(plan.strengths || []).map(s => `<span class="tag green">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>
        <div>
          <div class="section-title">📈 Gaps to Address</div>
          <div class="tags">
            ${(plan.gaps || []).map(s => `<span class="tag red">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
    container.appendChild(tagSection);
  }

  /* Learning plan cards */
  if (plan.learning_plan?.length) {
    const planSection = document.createElement('div');
    planSection.innerHTML = `<div class="section-title">🗺️ Personalised Learning Path</div>`;

    const cards = document.createElement('div');
    cards.className = 'plan-cards';

    plan.learning_plan.forEach((item, idx) => {
      cards.appendChild(buildPlanCard(item, idx));
    });

    planSection.appendChild(cards);
    container.appendChild(planSection);
  }

  /* Timeline footer */
  if (plan.learning_timeline || plan.encouragement) {
    const footer = document.createElement('div');
    footer.className = 'timeline-card';
    footer.innerHTML = `
      ${plan.learning_timeline ? `<div class="headline">⏱ ${escapeHtml(plan.learning_timeline)}</div>` : ''}
      ${plan.priority_focus ? `<div class="focus">🎯 <span><strong>Start here:</strong> ${escapeHtml(plan.priority_focus)}</span></div>` : ''}
      ${plan.encouragement ? `<div class="encourage">${escapeHtml(plan.encouragement)}</div>` : ''}
    `;
    container.appendChild(footer);
  }
}

function buildPlanCard(item, idx) {
  const card = document.createElement('div');
  card.className = 'plan-card';

  const resourceIcons = { course: '🎓', book: '📚', docs: '📖', tutorial: '💻', project: '🔨', video: '▶️' };

  const resourcesHtml = (item.resources || []).map(r => `
    <div class="resource-item">
      <div class="resource-icon">${resourceIcons[r.type] || '🔗'}</div>
      <div class="resource-info">
        <div class="resource-title">${escapeHtml(r.title)}</div>
        <div class="resource-meta">${escapeHtml(r.provider || '')} · ${r.estimated_hours || '?'}h · ${escapeHtml(r.url_hint || '')}</div>
        ${r.why_recommended ? `<div class="resource-why">${escapeHtml(r.why_recommended)}</div>` : ''}
      </div>
    </div>
  `).join('');

  const adjacentHtml = (item.adjacent_skills_unlocked || [])
    .map(s => `<span class="adjacent-tag">${escapeHtml(s)}</span>`).join('');

  card.innerHTML = `
    <div class="plan-card-header" onclick="toggleCard(this)">
      <div class="left">
        <span class="priority-badge ${item.priority || 'medium'}">${item.priority || 'medium'}</span>
        <span class="skill-title">${escapeHtml(item.skill)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:16px">
        <div class="level-arrow">
          <span class="lvl">Lv ${item.current_level}</span>
          →
          <span class="lvl target">Lv ${item.target_level}</span>
        </div>
        <div class="meta-item" style="font-size:0.8rem">
          🕐 <strong>${item.time_estimate_weeks}w</strong>
        </div>
        <span style="color:var(--muted);font-size:0.9rem" class="chevron">▼</span>
      </div>
    </div>
    <div class="plan-card-body ${idx !== 0 ? 'collapsed' : ''}">
      ${item.learning_path ? `
        <div>
          <div class="subsection-title">Learning Path</div>
          <div class="learning-path-text">${escapeHtml(item.learning_path)}</div>
        </div>` : ''}

      ${item.resources?.length ? `
        <div>
          <div class="subsection-title">Resources (${item.resources.length})</div>
          <div class="resources-list">${resourcesHtml}</div>
        </div>` : ''}

      ${item.practice_project ? `
        <div>
          <div class="subsection-title">Practice Project</div>
          <div class="practice-box">🔨 <span>${escapeHtml(item.practice_project)}</span></div>
        </div>` : ''}

      ${adjacentHtml ? `
        <div>
          <div class="subsection-title">Unlocks These Skills Next</div>
          <div class="adjacent-list">${adjacentHtml}</div>
        </div>` : ''}
    </div>
  `;

  return card;
}

function toggleCard(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.chevron');
  body.classList.toggle('collapsed');
  chevron.textContent = body.classList.contains('collapsed') ? '▼' : '▲';
}

/* ── Export ──────────────────────────────────────────────────────────── */
function downloadPlan() {
  if (!planData) return;
  const blob = new Blob([JSON.stringify(planData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (planData.candidate_name || 'candidate').replace(/\s+/g, '_').toLowerCase();
  a.href = url;
  a.download = `learning_plan_${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Plan downloaded', 'success');
}

/* ── Mobile sidebar toggle ──────────────────────────────────────────── */
function toggleSidebar() {
  document.querySelector('.sidebar').classList.toggle('open');
}

/* ── Counter animation ───────────────────────────────────────────────── */
function animateCounter(elId, from, to, duration, fmt) {
  const el = document.getElementById(elId);
  if (!el) return;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
