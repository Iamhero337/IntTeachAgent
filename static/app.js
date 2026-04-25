/* ── State ────────────────────────────────────────────────────────────── */
let sessionId = null;
let planData   = null;
let isSending  = false;
let currentBotBubble = null;

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

  /* Auto-grow textarea */
  document.getElementById('user-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  });

  /* Enter to send (Shift+Enter = newline) */
  document.getElementById('user-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
});

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
  return text
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
      body: JSON.stringify({ session_id: sessionId, message: msg }),
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

          if (chunk.type === 'plan') {
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

function showPlanReadyBanner() {
  const msgs = document.getElementById('messages');
  if (document.getElementById('plan-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'plan-banner';
  banner.className = 'plan-ready-banner';
  banner.innerHTML = `
    <p>Assessment complete! Your personalised learning plan is ready.</p>
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <button class="btn-back" onclick="backToChat()">← Back to Chat</button>
      <button class="btn-back" onclick="backToSetup()">New Assessment</button>
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
