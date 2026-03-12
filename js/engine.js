/* ════════════════════════════════════════════════
   VOICEEQUITY — INTERVIEW ENGINE
   engine.js: Speech→Text→AI→Text→Speech loop
   Loaded only on interview.html
════════════════════════════════════════════════ */
'use strict';

/* ── State ── */
let ivActive     = false;
let ivBusy       = false;
let ivIv         = null;
let convoHistory = [];
let turnCount    = 0;
let maxTurns     = 18;

// Offline fallback state
let _offlineQs   = [];
let _offlineIdx  = 0;
let _followedUp  = false;

// Mic / SR state
let micGranted   = false;
let micStream    = null;
let recog        = null;
let srRunning    = false;
let micOn        = false;
let utterance    = '';
let srBaseline   = 0;
let silTimer     = null;
const SILENCE_MS = 2000;

// Audio viz state
let actx=null, analyser=null, vizRaf=null;

/* ════════════════════════════════════════════════
   START INTERVIEW
════════════════════════════════════════════════ */
async function startInterview() {
  // Load interview from sessionStorage (set by candidate.html before redirect)
  const ivJson = sessionStorage.getItem('ve_activeIv');
  if (!ivJson) { window.location.href = 'candidate.html'; return; }
  ivIv = JSON.parse(ivJson);

  const ok = await acquireMic();
  if (!ok) return;

  // Reset all state
  ivActive     = true;
  ivBusy       = false;
  convoHistory = [];
  turnCount    = 0;
  maxTurns     = ivIv.qCount * 3 + 4;
  utterance    = '';
  srBaseline   = 0;
  _offlineQs   = [];
  _offlineIdx  = 0;
  _followedUp  = false;

  $('irTitle').textContent     = ivIv.title;
  $('irProgFill').style.width  = '0%';
  $('irProgLabel').textContent = `0 / ${ivIv.qCount}`;
  $('irChat').innerHTML        = '';
  setStatus('Starting…', 'AI interviewer is initializing');

  await aiTurn(
    `Begin the interview. Greet the candidate warmly in one sentence then ask your first question. Be concise.`,
    true
  );
}

/* ════════════════════════════════════════════════
   AI TURN — core loop
════════════════════════════════════════════════ */
function buildSysPrompt() {
  const iv   = ivIv;
  const sess = DB.sess();
  const name = sess?.name?.split(' ')[0] || 'there';
  const jd   = iv.jd ? `\n\nJob Description:\n${iv.jd.slice(0,800)}` : '';
  return `You are a professional voice interviewer conducting a ${iv.difficulty}-level ${iv.type} interview for: ${iv.role || iv.title}.${jd}

RULES — follow strictly:
1. Ask exactly ${iv.qCount} questions total, one at a time.
2. After each answer: give ONE short follow-up if the answer was vague, OR move to the next question.
3. Max 1 follow-up per question then always move on.
4. Keep ALL responses to 1–3 sentences. This is spoken voice — be concise.
5. Do NOT score or give feedback during the interview.
6. Use the candidate's name (${name}) occasionally.
7. When all ${iv.qCount} questions are answered, close warmly and end with exactly: [END]`;
}

async function aiTurn(userText, isOpening=false) {
  if (!ivActive) return;
  ivBusy = true;
  setStatus('Thinking…', 'AI is responding');

  convoHistory.push({ role:'user', content:userText });

  // Safety ceiling
  const asTurns = convoHistory.filter(m=>m.role==='assistant').length;
  if (asTurns >= maxTurns) { ivBusy=false; endInterview(); return; }

  let reply  = '';
  let apiOk  = false;
  try {
    const r = await Promise.race([
      callClaude(convoHistory, buildSysPrompt(), 300),
      new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')), 5000))
    ]);
    reply = r;
    apiOk = !!reply.trim();
  } catch(e) { /* fall to offline */ }

  if (!apiOk) reply = offlineTurn(isOpening);

  convoHistory.push({ role:'assistant', content:reply });

  const isEnd    = reply.includes('[END]');
  const cleanMsg = reply.replace('[END]','').trim();

  addAIMsg(cleanMsg);

  // Update progress
  if (!isOpening) {
    turnCount++;
    const done = Math.min(turnCount, ivIv.qCount);
    $('irProgFill').style.width  = Math.round((done/ivIv.qCount)*100) + '%';
    $('irProgLabel').textContent = `${done} / ${ivIv.qCount}`;
  }

  if (isEnd) {
    ivBusy = false;
    speakTTS(cleanMsg, () => setTimeout(()=>endInterview(), 700));
    return;
  }

  ivBusy = false;
  speakTTS(cleanMsg, () => {
    if (ivActive && !ivBusy) {
      setStatus('Your turn', 'Speak your answer — mic is open');
      startListening();
    }
  });
}

async function submitAnswer(ans) {
  if (!ivActive || ivBusy) return;
  stopListening();
  addUserMsg(ans);
  await aiTurn(ans);
}

/* ════════════════════════════════════════════════
   OFFLINE ENGINE (no API key needed)
════════════════════════════════════════════════ */
function offlineTurn(isOpening) {
  const iv   = ivIv;
  const sess = DB.sess();
  const name = sess?.name?.split(' ')[0] || 'there';
  const type = iv.type in QBANK ? iv.type : 'mixed';
  const diff = iv.difficulty in QBANK[type] ? iv.difficulty : 'mid';

  if (_offlineQs.length === 0) {
    const pool = [...(QBANK[type][diff] || QBANK.mixed.mid)];
    for (let i=pool.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [pool[i],pool[j]]=[pool[j],pool[i]];
    }
    _offlineQs  = pool.slice(0, iv.qCount);
    _offlineIdx = 0;
    _followedUp = false;
  }

  if (isOpening) {
    _offlineIdx = 0; _followedUp = false;
    return `Hi ${name}! Welcome to your ${iv.title} interview. Let's get started. ${_offlineQs[0]}`;
  }

  // Follow up only on very short answers (< 6 words)
  const lastAns  = convoHistory.filter(m=>m.role==='user').slice(-1)[0]?.content || '';
  const wordCount = lastAns.split(/\s+/).filter(Boolean).length;

  if (wordCount < 6 && !_followedUp && !lastAns.includes('[Skip')) {
    _followedUp = true;
    const fups = [
      "Could you tell me a bit more about that?",
      "Can you give me a specific example?",
      "Could you elaborate a little?",
    ];
    return fups[Math.floor(Math.random()*fups.length)];
  }

  _offlineIdx++;
  _followedUp = false;

  if (_offlineIdx >= _offlineQs.length) {
    return `Thank you ${name}, that was a great session! You've answered all ${iv.qCount} questions. Well done! [END]`;
  }

  const transitions = [
    "Got it, thanks. Let's move on —",
    "Understood. Next question —",
    "Good. Moving on —",
    "Thank you for that. Now,",
    "Alright, let's continue."
  ];
  const t = transitions[Math.floor(Math.random()*transitions.length)];
  return `${t} ${_offlineQs[_offlineIdx]}`;
}

/* ════════════════════════════════════════════════
   END & SCORE
════════════════════════════════════════════════ */
function endInterview() {
  if (!ivActive && !ivBusy) return;
  ivActive = false;
  stopListening(); stopTTS();
  addAIMsg('Scoring your answers — please wait a moment…');
  speakTTS('Scoring your answers, please wait.');
  scoreAndReport();
}

async function scoreAndReport() {
  // Extract Q&A pairs from history
  const qs=[], as=[];
  let expectAns = false;
  for (const m of convoHistory) {
    if (m.role==='assistant') {
      qs.push(m.content.replace('[END]','').trim());
      expectAns = true;
    } else if (m.role==='user' && expectAns && m.content.length>10) {
      as.push(m.content);
      expectAns = false;
    }
  }
  while (as.length < qs.length) as.push('[No answer]');

  const scores=[], feedbacks=[];
  for (let i=0;i<qs.length;i++) {
    try {
      const r = await callClaude(
        [{role:'user',content:`Evaluate this interview answer.\nQuestion: ${qs[i]}\nAnswer: ${as[i]}\nLevel: ${ivIv.difficulty} | Type: ${ivIv.type}\n\nRespond EXACTLY:\nSCORE: [0-100]\nFEEDBACK: [2-3 sentences: strengths, gaps, one tip]`}],
        'You are a senior interviewer giving honest concise evaluation.', 200
      );
      const sm=r.match(/SCORE:\s*(\d+)/i), fm=r.match(/FEEDBACK:\s*(.+)/is);
      scores.push(sm ? Math.min(100,Math.max(0,parseInt(sm[1]))) : 50);
      feedbacks.push(fm ? fm[1].trim() : 'Good attempt — keep practising.');
    } catch {
      const wc = (as[i]||'').split(/\s+/).filter(Boolean).length;
      scores.push(Math.min(70,Math.max(20,wc*3)));
      feedbacks.push('Answer recorded. Add a Claude API key for AI-powered detailed feedback.');
    }
  }

  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;

  // Save result
  const sess = DB.sess();
  const res = {
    id:        Date.now().toString(),
    userName:  sess?.name  || 'Guest',
    userEmail: sess?.email || 'guest@demo.com',
    ivTitle:   ivIv.title,
    ivId:      ivIv.id,
    type:      ivIv.type,
    difficulty:ivIv.difficulty,
    avgScore:  avg,
    scores,
    ts: Date.now()
  };
  const all = DB.results(); all.push(res); DB.saveRes(all);

  // Pass report data to report page via sessionStorage
  sessionStorage.setItem('ve_report', JSON.stringify({ qs, as, scores, feedbacks, avg, ivTitle:ivIv.title, ivType:ivIv.type, ivDiff:ivIv.difficulty, ivRole:ivIv.role||'General' }));
  window.location.href = 'report.html';
}

/* ════════════════════════════════════════════════
   MIC / SPEECH RECOGNITION
════════════════════════════════════════════════ */
async function acquireMic() {
  if (micGranted) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio:true});
    setupViz(micStream);
    buildSR();
    micGranted = true;
    return true;
  } catch(e) {
    toast('Microphone access denied. Please allow mic in browser settings.', 'error');
    return false;
  }
}

function buildSR() {
  const SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRC || recog) return;
  recog = new SRC();
  recog.lang='en-US'; recog.continuous=true; recog.interimResults=true; recog.maxAlternatives=1;
  recog.onstart  = () => { srRunning=true; };
  recog.onresult = e => {
    let newFin='', interim='';
    for (let i=srBaseline;i<e.results.length;i++) {
      if (e.results[i].isFinal) newFin += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    if (newFin) utterance += newFin;
    const disp = (utterance + interim).trim();

    // Voice commands
    const chunk  = (newFin+interim).toLowerCase().trim();
    const cWords = chunk.split(/\s+/).filter(Boolean).length;
    if (cWords<=8 && /\b(repeat|say that again|please repeat|say it again)\b/.test(chunk)) {
      srBaseline=e.results.length; utterance='';
      clearSil(); stopListening(); repeatLast(); return;
    }
    if (cWords<=5 && /\b(skip|pass|move on|next)\b/.test(chunk)) {
      srBaseline=e.results.length; utterance='';
      clearSil(); stopListening(); skipCurrent(); return;
    }

    setLiveText(disp || 'Listening…', true);
    if (newFin.trim()) { srBaseline=e.results.length; armSilence(); }
    else clearSil();
  };
  recog.onerror = e => {
    srRunning=false;
    if (e.error==='not-allowed') { toast('Mic blocked.','error'); stopListening(); }
    else if (micOn) setTimeout(srResume, 300);
  };
  recog.onend = () => { srRunning=false; if (micOn) setTimeout(srResume, 80); };
}

function srResume() { if (!recog||srRunning||!micOn) return; try{recog.start();}catch(_){} }
function srPause()  { srRunning=false; try{recog&&recog.stop();}catch(_){} }

function startListening() {
  if (!micGranted||micOn) return;
  micOn=true; utterance=''; srBaseline=0;
  $('micBtn').classList.add('active');
  $('orbWrap').classList.add('active');
  $('liveDot').classList.remove('off');
  setLiveText('Listening…', true);
  showWaveform(); srResume();
}

function stopListening() {
  micOn=false; srPause(); clearSil();
  $('micBtn').classList.remove('active');
  $('orbWrap').classList.remove('active');
  $('liveDot').classList.add('off');
  setLiveText('Waiting…', false);
  hideWaveform();
}

function toggleMic() {
  if (!ivActive) { toast('Interview not active','info'); return; }
  if (ivBusy)    { toast('AI is speaking — wait a moment','info'); return; }
  micOn ? stopListening() : startListening();
}

function armSilence() {
  clearSil();
  if (!utterance.trim()) return;
  setStatus('Auto-sending…','Silence detected');
  silTimer = setTimeout(() => {
    clearSil();
    const ans = utterance.trim();
    if (ans) submitAnswer(ans);
  }, SILENCE_MS);
}
function clearSil() {
  clearTimeout(silTimer); silTimer=null;
  if (micOn) setStatus('Listening','Speak your answer clearly');
}

function repeatLast() {
  const msgs = $('irChat').querySelectorAll('.msg-row.ai-row');
  const last  = msgs[msgs.length-1];
  if (!last) return;
  const txt = last.querySelector('.msg-bubble')?.textContent || '';
  stopListening();
  addAIMsg('🔁 '+txt);
  speakTTS(txt, ()=>{ if(ivActive&&!ivBusy){ setStatus('Your turn','Speak your answer'); startListening(); } });
}

function skipCurrent() {
  if (!ivActive||ivBusy) return;
  stopListening(); clearSil();
  utterance=''; srBaseline=0;
  addUserMsg('[Skipped — moving on]');
  aiTurn("I'd like to skip this question please.");
}

/* ════════════════════════════════════════════════
   AUDIO VISUALIZER
════════════════════════════════════════════════ */
function setupViz(stream) {
  actx     = new (window.AudioContext||window.webkitAudioContext)();
  analyser = actx.createAnalyser();
  analyser.fftSize=256; analyser.smoothingTimeConstant=.8;
  actx.createMediaStreamSource(stream).connect(analyser);
  const wc = $('waveform');
  const resize = () => {
    const r = wc.getBoundingClientRect();
    wc.width=r.width*devicePixelRatio; wc.height=r.height*devicePixelRatio;
  };
  resize(); window.addEventListener('resize', resize);
}

function drawWave() {
  const wc = $('waveform');
  if (!analyser||!wc) return;
  vizRaf = requestAnimationFrame(drawWave);
  const ctx2 = wc.getContext('2d');
  const W=wc.width/devicePixelRatio, H=wc.height/devicePixelRatio;
  const d = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(d);
  ctx2.clearRect(0,0,wc.width,wc.height);
  const bars=48, bw=W/bars-1, step=Math.floor(d.length/bars);
  for(let i=0;i<bars;i++){
    const v=d[i*step]/255, h=Math.max(2,v*H*.9);
    ctx2.fillStyle=v>.5?`rgba(245,166,35,${.4+v*.6})`:`rgba(0,212,255,${.25+v*.6})`;
    ctx2.beginPath(); ctx2.roundRect(i*(bw+1),(H-h)/2,bw,h,1.5); ctx2.fill();
  }
}
function showWaveform(){ $('waveform').classList.add('on'); if(!vizRaf)drawWave(); }
function hideWaveform(){
  $('waveform').classList.remove('on');
  cancelAnimationFrame(vizRaf); vizRaf=null;
  const wc=$('waveform'); if(wc) wc.getContext('2d').clearRect(0,0,wc.width,wc.height);
}

/* ════════════════════════════════════════════════
   TTS
════════════════════════════════════════════════ */
function speakTTS(text, onDone) {
  if (!window.speechSynthesis) { onDone?.(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_`#\[\]]/g,'').trim());
  u.rate=1.0; u.pitch=1; u.volume=1;
  const voices = speechSynthesis.getVoices()||[];
  const v = voices.find(v=>v.lang.startsWith('en')&&/Google|Samantha|Natural/i.test(v.name))
         || voices.find(v=>v.lang.startsWith('en'));
  if (v) u.voice=v;
  setStatus('AI speaking…','🔊 Listen carefully');
  u.onend = u.onerror = () => { onDone?.(); };
  speechSynthesis.speak(u);
}
function stopTTS() { window.speechSynthesis?.cancel(); }
window.speechSynthesis?.addEventListener('voiceschanged', ()=>{});

/* ════════════════════════════════════════════════
   CHAT UI
════════════════════════════════════════════════ */
function addAIMsg(text) {
  const c=$('irChat'), d=document.createElement('div');
  d.className='msg-row ai-row';
  d.innerHTML=`<div class="msg-avatar ai-avatar">AI</div><div class="msg-content"><div class="msg-who">Interviewer</div><div class="msg-bubble ai-bubble">${esc(text)}</div></div>`;
  // Remove typing indicator
  c.querySelector('.typing-row')?.remove();
  c.appendChild(d); c.scrollTop=c.scrollHeight;
}
function addUserMsg(text) {
  const c=$('irChat'), d=document.createElement('div');
  d.className='msg-row user-row';
  d.innerHTML=`<div class="msg-avatar user-avatar">U</div><div class="msg-content"><div class="msg-who">You</div><div class="msg-bubble user-bubble">${esc(text)}</div></div>`;
  c.appendChild(d); c.scrollTop=c.scrollHeight;
}

/* ── STATUS ── */
function setStatus(main, sub) {
  const m=$('irStatusMain'), s=$('irStatusSub');
  if(m) m.textContent=main;
  if(s) s.textContent=sub;
}
function setLiveText(t, active) {
  const el=$('liveText'), tr=$('liveTranscript');
  if(el) el.textContent = t.length>120?'…'+t.slice(-120):t;
  if(tr) tr.classList.toggle('listening',active);
}
