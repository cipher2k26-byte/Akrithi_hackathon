/* ════════════════════════════════════════════════
   VOICEEQUITY — SHARED JS
   db.js: Data layer, auth helpers, utilities
   Loaded on every page
════════════════════════════════════════════════ */
'use strict';

/* ── DATA LAYER ── */
const ADMIN_KEY = 'equity2024';
const hashP = p => { let h=5381; for(let i=0;i<p.length;i++) h=((h<<5)+h)^p.charCodeAt(i); return (h>>>0).toString(36); };

const DB = {
  users:     () => JSON.parse(localStorage.getItem('ve_users') || '{}'),
  saveUsers: u  => localStorage.setItem('ve_users', JSON.stringify(u)),
  ivs:       () => JSON.parse(localStorage.getItem('ve_ivs')   || '[]'),
  saveIvs:   iv => localStorage.setItem('ve_ivs', JSON.stringify(iv)),
  results:   () => JSON.parse(localStorage.getItem('ve_res')   || '[]'),
  saveRes:   r  => localStorage.setItem('ve_res', JSON.stringify(r)),
  sess:      () => JSON.parse(sessionStorage.getItem('ve_sess') || 'null'),
  setSess:   u  => sessionStorage.setItem('ve_sess', JSON.stringify(u)),
  clearSess: () => sessionStorage.removeItem('ve_sess'),
};

/* ── UTILITIES ── */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function scoreClass(s) {
  return s>=80?'score-great':s>=60?'score-good':s>=40?'score-ok':'score-poor';
}

function timeAgo(ts) {
  const d=Date.now()-ts, m=Math.floor(d/60000), h=Math.floor(m/60), days=Math.floor(h/24);
  if (d<60000) return 'just now';
  if (m<60)    return m+'m ago';
  if (h<24)    return h+'h ago';
  return days+'d ago';
}

/* ── TOAST ── */
let _toastTimer;
function toast(msg, type='info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'show ' + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ── CHIP SELECTOR ── */
function selChip(el, rowId, hiddenId) {
  document.querySelectorAll(`#${rowId} .chip`).forEach(c => c.classList.remove('sel'));
  el.classList.add('sel');
  $(hiddenId).value = el.dataset.v;
}

function resetChips(rowId, val, hiddenId) {
  document.querySelectorAll(`#${rowId} .chip`).forEach(c => {
    c.classList.remove('sel');
    if (c.dataset.v === val) c.classList.add('sel');
  });
  $(hiddenId).value = val;
}

/* ── SESSION GUARD ──
   Call on pages that require login.
   Returns the session user or redirects to auth.
── */
function requireSession(expectedRole) {
  const sess = DB.sess();
  if (!sess) { window.location.href = 'auth.html'; return null; }
  if (expectedRole && sess.role !== expectedRole) {
    // Wrong role — send to correct app
    window.location.href = sess.role === 'admin' ? 'admin.html' : 'candidate.html';
    return null;
  }
  return sess;
}

/* ── LOGOUT ── */
function doLogout() {
  DB.clearSess();
  window.location.href = 'index.html';
}

/* ── CLAUDE API ── */
async function callClaude(messages, system, maxTokens=400) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:maxTokens, system, messages })
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const d = await r.json();
  return d.content?.map(c=>c.text||'').join('') || '';
}

/* ── OFFLINE QUESTION BANK ── */
const QBANK = {
  technical:{
    junior:["Explain the difference between let, const and var.","What is a REST API and how does it work?","What is the difference between SQL and NoSQL?","What is a closure in JavaScript?","Explain what version control is and why it's important.","What is the difference between == and === ?","Explain what Docker containers are.","Describe the MVC architecture pattern."],
    mid:["How does database indexing work?","What are SOLID principles?","Explain microservices vs monolithic architecture.","How do you approach debugging a complex issue?","Describe your code review process.","What is the CAP theorem?","Explain event-driven architecture.","How do you handle database migrations in production?"],
    senior:["How would you design a URL shortener?","Design a real-time notification system for millions of users.","How do you handle technical debt at scale?","Explain consistent hashing and when to use it.","How would you approach a major production outage?","Design a distributed rate limiter.","Explain eventual vs strong consistency trade-offs.","How do you approach capacity planning?"]
  },
  behavioral:{
    junior:["Tell me about a time you learned something new quickly.","Describe a mistake you made and how you handled it.","How do you prioritize multiple tasks?","Tell me about a project you're proud of.","Describe a time you worked well in a team."],
    mid:["Tell me about a time you disagreed with your manager.","Describe delivering under a tight deadline.","Tell me about resolving a conflict with a colleague.","How do you handle ambiguity?","Describe influencing without authority."],
    senior:["Tell me about driving significant organisational change.","Describe making a decision with incomplete information.","What's the most complex project you've led end-to-end?","How have you developed other engineers?","Tell me about managing competing priorities across stakeholders."]
  },
  hr:{
    junior:["Why are you interested in this role?","Where do you see yourself in 5 years?","What are your greatest strengths?","What motivates you at work?","Why are you leaving your current job?"],
    mid:["What work environment do you thrive in?","How do you handle constructive feedback?","What does success look like in this role?","How do you stay current with industry trends?","Describe your ideal manager."],
    senior:["What impact do you want to have in this role?","How do you maintain work-life balance?","Why choose us over our competitors?","What are you looking for in your next company?","Describe your personal brand as a professional."]
  },
  mixed:{
    junior:["Tell me about yourself.","Why do you want to work here?","Describe a recent challenge you solved.","Where do you want to grow professionally?","What makes you a strong candidate for this role?"],
    mid:["Walk me through your most impactful project.","How do you handle technical disagreements?","Describe balancing technical debt versus new features.","What is your biggest professional accomplishment?","How do you mentor junior team members?"],
    senior:["How have you influenced technical direction across an organisation?","How do you build engineering culture?","Describe your approach to stakeholder management.","What is the hardest technical decision you've made?","How do you recruit and retain top talent?"]
  }
};
