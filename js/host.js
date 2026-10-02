// Экран ведущего: хранит всё состояние игры и рассылает игрокам их «вид»
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const banner = $('#banner');
  const { esc, plural } = PB;

  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 8;
  const ROUNDS = 2;
  const T = { answer: 90, vote: 20, finalAnswer: 75, finalVote: 30 };
  const AVATARS = ['🦊', '🐸', '🐙', '🦄', '🐼', '🐯', '🦖', '🐧'];
  const COLORS = ['#ff5d8f', '#ffb703', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8c42', '#f15bb5', '#90e0ef'];

  const S = {
    phase: 'connecting',
    players: [], // {id, token, name, slot, avatar, color, score, conn, connected}
    round: 0,
    matchups: [], // {id, prompt, authors:[id,id], answers:{id:text}, votes:{voterId:authorId}, result}
    current: 0,
    deadline: 0,
    final: null, // {prompt, answers, votes, order, result}
  };

  let peer = null;
  let code = '';
  let timer = null;
  let nextId = 1;
  let pool = [];
  let lastKey = '';
  let tts = PB.load('pb-tts', '1') === '1';
  let netError = '';

  // ---------- утилиты ----------
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const drawPrompt = () => {
    if (!pool.length) pool = shuffle(PROMPTS.slice());
    return pool.pop();
  };
  const byId = (id) => S.players.find((p) => p.id === id);
  const online = () => S.players.filter((p) => p.connected);
  const vip = () => online()[0] || null;
  const timeLeft = () => (S.deadline ? Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000)) : 0);
  const clean = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  function after(sec, fn) {
    clearTimeout(timer);
    S.deadline = Date.now() + sec * 1000;
    timer = setTimeout(fn, sec * 1000);
  }
  function delay(ms, fn) {
    clearTimeout(timer);
    S.deadline = 0;
    timer = setTimeout(fn, ms);
  }

  // ---------- звук и озвучка ----------
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { /* без звука */ }
  }
  function tone(freq, start, dur, type = 'triangle', vol = 0.15) {
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audio.currentTime + start);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + start + dur);
    o.connect(g).connect(audio.destination);
    o.start(audio.currentTime + start);
    o.stop(audio.currentTime + start + dur);
  }
  function sfx(kind) {
    if (kind === 'join') { tone(660, 0, 0.12); tone(990, 0.08, 0.18); }
    if (kind === 'reveal') { tone(523, 0, 0.15); tone(659, 0.1, 0.15); tone(784, 0.2, 0.3); }
    if (kind === 'lash') { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.35, 'square', 0.08)); }
    if (kind === 'round') { tone(392, 0, 0.2, 'sawtooth', 0.07); tone(523, 0.18, 0.4, 'sawtooth', 0.07); }
  }
  function speak(text, queue = false) {
    if (!tts || !window.speechSynthesis) return;
    try {
      if (!queue) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/_{2,}/g, ' что-то '));
      u.lang = 'ru-RU';
      u.rate = 1.05;
      const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith('ru'));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) { /* нет озвучки */ }
  }

  // ---------- сеть ----------
  function createRoom() {
    code = PB.makeCode();
    S.phase = 'connecting';
    render();
    peer = new Peer(PB.PREFIX + code, PB.peerOptions);
    peer.on('open', () => {
      if (S.phase === 'connecting') S.phase = 'lobby';
      setNetError('');
      render();
    });
    peer.on('connection', onConnection);
    peer.on('disconnected', () => {
      setNetError('Связь с сервером комнат потеряна, переподключаемся… (игроки в игре не отвалятся)');
      setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
    });
    peer.on('error', (err) => {
      console.warn('peer error', err.type, err);
      if (err.type === 'unavailable-id' && S.phase === 'connecting') {
        peer.destroy();
        createRoom();
      } else if (err.type === 'browser-incompatible') {
        setNetError('Этот браузер не поддерживает WebRTC. Откройте в Chrome, Edge, Firefox или Safari.');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setNetError('Проблема с сетью (' + err.type + '), пробуем ещё раз…');
        setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 3000);
      }
    });
  }

  function setNetError(text) {
    netError = text;
    banner.textContent = text;
    banner.hidden = !text;
  }

  function onConnection(conn) {
    conn.on('data', (msg) => {
      try { onMessage(conn, msg); } catch (e) { console.error(e); }
    });
    conn.on('close', () => onClose(conn));
    conn.on('error', () => onClose(conn));
  }

  function onClose(conn) {
    const p = byId(conn.pid);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    p.connected = false;
    syncAll(); // VIP мог смениться
    checkProgress();
  }

  function send(p, msg) {
    const c = p.conn;
    if (c && c.open) {
      try { c.send(msg); } catch (e) { console.warn(e); }
    }
  }

  function syncAll() {
    for (const p of S.players) send(p, { type: 'view', view: viewFor(p) });
    render();
  }

  setInterval(() => S.players.forEach((p) => send(p, { type: 'ping' })), 3000);

  function onMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'join') return onJoin(conn, msg);
    const p = byId(conn.pid);
    if (!p || p.conn !== conn) return;
    switch (msg.type) {
      case 'answer': return onAnswer(p, msg);
      case 'vote': return onVote(p, msg);
      case 'start': if (p === vip() && S.phase === 'lobby') startGame(); return;
      case 'again': if (p === vip() && S.phase === 'end') backToLobby(); return;
    }
  }

  function onJoin(conn, msg) {
    const token = clean(msg.token, 64);
    let p = token && S.players.find((q) => q.token === token);
    if (p) {
      // переподключение того же игрока
      if (p.conn && p.conn !== conn) {
        const old = p.conn;
        old.pid = null;
        try { old.close(); } catch (e) { /* уже закрыто */ }
      }
      p.conn = conn;
      p.connected = true;
      conn.pid = p.id;
      send(p, { type: 'joined', name: p.name, avatar: p.avatar, color: p.color, code });
      syncAll();
      return;
    }

    const fail = (text) => {
      try { conn.send({ type: 'error', text }); } catch (e) { /* ignore */ }
      setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 500);
    };
    const name = clean(msg.name, 14);
    if (!name) return fail('Введите имя.');
    if (S.phase !== 'lobby') return fail('Игра уже идёт — дождитесь следующей.');
    if (S.players.length >= MAX_PLAYERS) return fail('Комната заполнена (максимум ' + MAX_PLAYERS + ').');
    if (S.players.some((q) => q.name.toLowerCase() === name.toLowerCase())) return fail('Это имя уже занято.');

    const used = S.players.map((q) => q.slot);
    const slot = [...Array(MAX_PLAYERS).keys()].find((i) => !used.includes(i));
    p = { id: 'p' + nextId++, token, name, slot, avatar: AVATARS[slot], color: COLORS[slot], score: 0, conn, connected: true };
    conn.pid = p.id;
    S.players.push(p);
    sfx('join');
    send(p, { type: 'joined', name: p.name, avatar: p.avatar, color: p.color, code });
    syncAll();
  }

  function kick(id) {
    const p = byId(id);
    if (!p) return;
    send(p, { type: 'kicked' });
    const c = p.conn;
    S.players = S.players.filter((q) => q !== p);
    if (c) {
      c.pid = null;
      setTimeout(() => { try { c.close(); } catch (e) { /* ignore */ } }, 300);
    }
    syncAll();
  }

  // ---------- ход игры ----------
  function startGame() {
    if (online().length < MIN_PLAYERS) return;
    unlockAudio();
    S.players = S.players.filter((p) => p.connected);
    S.players.forEach((p) => (p.score = 0));
    S.round = 0;
    nextRound();
  }

  function nextRound() {
    S.round++;
    if (S.round > ROUNDS) return startFinal();
    S.phase = 'intro';
    sfx('round');
    speak('Раунд ' + S.round + (S.round > 1 ? '. Очки удваиваются!' : '. Отвечайте смешнее соперника!'));
    delay(4000, beginAnswers);
    syncAll();
  }

  function beginAnswers() {
    const ps = shuffle(S.players.slice());
    const n = ps.length;
    // каждый вопрос получают двое, у каждого игрока по два вопроса
    S.matchups = ps.map((p, i) => ({
      id: i,
      prompt: drawPrompt(),
      authors: [p.id, ps[(i + 1) % n].id],
      answers: {},
      votes: {},
      result: null,
    }));
    S.phase = 'answer';
    after(T.answer, startVoting);
    syncAll();
  }

  const pendingFor = (p) => S.matchups.filter((m) => m.authors.includes(p.id) && !(p.id in m.answers));

  function onAnswer(p, msg) {
    const text = clean(msg.text) || '…';
    if (S.phase === 'answer') {
      const m = S.matchups[msg.mid];
      if (!m || !m.authors.includes(p.id) || p.id in m.answers) return;
      m.answers[p.id] = text;
    } else if (S.phase === 'final-answer') {
      if (p.id in S.final.answers) return;
      S.final.answers[p.id] = text;
    } else {
      return;
    }
    syncAll();
    checkProgress();
  }

  function startVoting() {
    S.current = 0;
    showMatchup();
  }

  // Вдвоём голосовать некому — тогда голосуют сами авторы, честно (можно и за соперника)
  const selfVote = () => S.players.length < 3;
  const votersFor = (m) => (selfVote() ? S.players.slice() : S.players.filter((p) => !m.authors.includes(p.id)));

  function showMatchup() {
    const m = S.matchups[S.current];
    if (!m) return showScores();
    const answered = m.authors.filter((a) => m.answers[a] != null);
    if (answered.length === 0) {
      S.current++;
      return showMatchup();
    }
    S.phase = 'vote';
    if (answered.length === 1) {
      delay(2500, revealMatchup); // голосовать не за что
    } else {
      after(T.vote, revealMatchup);
      speak(m.prompt);
      speak(m.answers[m.authors[0]], true);
      speak('или', true);
      speak(m.answers[m.authors[1]], true);
    }
    syncAll();
  }

  function onVote(p, msg) {
    if (S.phase === 'vote') {
      const m = S.matchups[S.current];
      if ((m.authors.includes(p.id) && !selfVote()) || p.id in m.votes) return;
      if (!m.authors.includes(msg.choice) || m.answers[msg.choice] == null) return;
      m.votes[p.id] = msg.choice;
    } else if (S.phase === 'final-vote') {
      const f = S.final;
      if (p.id in f.votes || (msg.choice === p.id && !selfVote()) || !f.order.includes(msg.choice)) return;
      f.votes[p.id] = msg.choice;
    } else {
      return;
    }
    syncAll();
    checkProgress();
  }

  function revealMatchup() {
    const m = S.matchups[S.current];
    const mult = S.round;
    const counts = {};
    m.authors.forEach((a) => (counts[a] = 0));
    Object.values(m.votes).forEach((a) => counts[a]++);
    const total = Object.keys(m.votes).length;
    const res = m.authors.map((a) => ({
      id: a,
      votes: counts[a],
      pct: total ? Math.round((counts[a] / total) * 100) : null,
      pts: counts[a] * 100 * mult,
      bonus: 0,
    }));
    const answered = m.authors.filter((a) => m.answers[a] != null);
    let winner = null;
    let lash = false;
    let note = '';
    if (answered.length === 1) {
      winner = answered[0];
      res.find((r) => r.id === winner).bonus = 250 * mult;
      note = 'Соперник промолчал — победа без боя!';
    } else if (res[0].votes !== res[1].votes) {
      const w = res[0].votes > res[1].votes ? res[0] : res[1];
      winner = w.id;
      w.bonus = 100 * mult;
      if (total >= 2 && w.votes === total) {
        lash = true;
        w.bonus += 250 * mult;
      }
    } else if (total > 0) {
      note = 'Ничья!';
    }
    res.forEach((r) => {
      const p = byId(r.id);
      if (p) p.score += r.pts + r.bonus;
    });
    m.result = { res, winner, lash, note };
    S.phase = 'reveal';
    sfx(lash ? 'lash' : 'reveal');
    if (lash) speak('Разнос!');
    delay(lash ? 8000 : 7000, () => {
      S.current++;
      showMatchup();
    });
    syncAll();
  }

  function showScores() {
    S.phase = 'scores';
    delay(7000, nextRound);
    syncAll();
  }

  function startFinal() {
    S.phase = 'final-intro';
    sfx('round');
    speak('Финальный раунд! Все отвечают на один вопрос.');
    delay(4500, () => {
      S.final = { prompt: drawPrompt(), answers: {}, votes: {}, order: [], result: null };
      S.phase = 'final-answer';
      after(T.finalAnswer, startFinalVote);
      speak(S.final.prompt);
      syncAll();
    });
    syncAll();
  }

  const finalVoters = () => (selfVote() ? S.players.slice() : S.players.filter((p) => S.final.order.some((id) => id !== p.id)));

  function startFinalVote() {
    const f = S.final;
    f.order = shuffle(Object.keys(f.answers));
    if (f.order.length < 2) return revealFinal();
    S.phase = 'final-vote';
    after(T.finalVote, revealFinal);
    speak(f.prompt);
    syncAll();
  }

  function revealFinal() {
    const f = S.final;
    const counts = {};
    f.order.forEach((id) => (counts[id] = 0));
    Object.values(f.votes).forEach((id) => counts[id]++);
    const res = f.order.map((id) => ({ id, votes: counts[id], pts: counts[id] * 300, bonus: 0 }));
    res.sort((a, b) => b.votes - a.votes);
    if (res.length === 1 || (res.length > 1 && res[0].votes > res[1].votes)) res[0].bonus = 500;
    res.forEach((r) => {
      const p = byId(r.id);
      if (p) p.score += r.pts + r.bonus;
    });
    f.result = res;
    S.phase = 'final-reveal';
    sfx('reveal');
    delay(Math.max(8000, res.length * 1500 + 4000), showEnd);
    syncAll();
  }

  function showEnd() {
    S.phase = 'end';
    S.deadline = 0;
    sfx('lash');
    const best = Math.max(...S.players.map((p) => p.score));
    const winners = S.players.filter((p) => p.score === best);
    speak('Победа! ' + winners.map((p) => p.name).join(' и '));
    syncAll();
  }

  function backToLobby() {
    clearTimeout(timer);
    S.players = S.players.filter((p) => p.connected);
    S.players.forEach((p) => (p.score = 0));
    S.phase = 'lobby';
    S.round = 0;
    S.deadline = 0;
    S.matchups = [];
    S.final = null;
    syncAll();
  }

  // Досрочно завершаем фазу, если все, кто в сети, уже сходили
  function checkProgress() {
    if (S.phase === 'answer') {
      const on = online();
      if (on.length && on.every((p) => pendingFor(p).length === 0)) startVoting();
    } else if (S.phase === 'vote') {
      const m = S.matchups[S.current];
      const vs = votersFor(m).filter((p) => p.connected);
      if (vs.length && vs.every((p) => p.id in m.votes)) revealMatchup();
    } else if (S.phase === 'final-answer') {
      const on = online();
      if (on.length && on.every((p) => p.id in S.final.answers)) startFinalVote();
    } else if (S.phase === 'final-vote') {
      const vs = finalVoters().filter((p) => p.connected);
      if (vs.length && vs.every((p) => p.id in S.final.votes)) revealFinal();
    }
  }

  // ---------- что видит каждый игрок ----------
  function viewFor(p) {
    const wait = (title, text) => ({ screen: 'wait', key: 'wait:' + S.phase + ':' + title + ':' + text, title, text });
    const isVip = p === vip();
    switch (S.phase) {
      case 'lobby': {
        const count = online().length;
        return { screen: 'lobby', key: 'lobby:' + isVip + ':' + count, vip: isVip, count, min: MIN_PLAYERS };
      }
      case 'intro':
        return wait('Раунд ' + S.round, 'Смотрите на главный экран!');
      case 'answer': {
        const pend = pendingFor(p);
        if (!pend.length) return wait('Готово! ✍️', 'Ждём остальных…');
        const total = S.matchups.filter((m) => m.authors.includes(p.id)).length;
        const m = pend[0];
        return {
          screen: 'answer', key: 'answer:' + S.round + ':' + m.id, mid: m.id, prompt: m.prompt,
          num: total - pend.length + 1, total, time: timeLeft(),
        };
      }
      case 'vote': {
        const m = S.matchups[S.current];
        if (m.authors.includes(p.id) && !selfVote()) return wait('Это ваш вопрос! 🙏', 'Остальные голосуют. Держите лицо.');
        if (p.id in m.votes) return wait('Голос принят 👍', 'Смотрите на экран.');
        const options = m.authors.filter((a) => m.answers[a] != null).map((a) => ({ id: a, text: m.answers[a] }));
        if (options.length < 2) return wait('Без боя', 'Один из игроков не ответил.');
        return { screen: 'vote', key: 'vote:' + S.round + ':' + S.current, prompt: m.prompt, options: shuffle(options), time: timeLeft(), honest: selfVote() };
      }
      case 'reveal':
        return wait('Смотрите на экран! 👀', '');
      case 'scores':
        return wait('Счёт', 'У вас ' + p.score + ' ' + plural(p.score, 'очко', 'очка', 'очков'));
      case 'final-intro':
        return wait('ФИНАЛ! 🔥', 'Один вопрос для всех. Очки ×3.');
      case 'final-answer':
        if (p.id in S.final.answers) return wait('Готово! ✍️', 'Ждём остальных…');
        return { screen: 'answer', key: 'final-answer', mid: 'final', prompt: S.final.prompt, num: 1, total: 1, time: timeLeft(), final: true };
      case 'final-vote': {
        const f = S.final;
        if (p.id in f.votes) return wait('Голос принят 👍', 'Смотрите на экран.');
        const options = f.order.filter((id) => selfVote() || id !== p.id).map((id) => ({ id, text: f.answers[id] }));
        if (!options.length) return wait('Ждём…', 'Другие голосуют.');
        return { screen: 'vote', key: 'final-vote', prompt: f.prompt, options, time: timeLeft(), final: true, honest: selfVote() };
      }
      case 'final-reveal':
        return wait('Итоги финала… 🥁', 'Смотрите на экран!');
      case 'end': {
        const sorted = [...S.players].sort((a, b) => b.score - a.score);
        const place = sorted.findIndex((q) => q.score === p.score) + 1;
        return { screen: 'end', key: 'end:' + isVip, place, score: p.score, vip: isVip };
      }
      default:
        return wait('Подождите…', '');
    }
  }

  // ---------- отрисовка главного экрана ----------
  const avatar = (p) => `<span class="av" style="--c:${p.color}">${p.avatar}</span>`;

  function topbar(label) {
    return `<div class="topbar">
      <div class="brand small">ХОХМАЧ</div>
      <div class="topbar-label">${label || ''}</div>
      <div class="roomcode">Комната <b>${code}</b></div>
      <div class="timer" id="timer" hidden></div>
    </div>`;
  }

  function chips(list, done) {
    return `<div class="chips">${list
      .map((p) => {
        const d = done(p);
        return `<div class="chip ${d ? 'done' : ''} ${p.connected ? '' : 'off'}" style="--c:${p.color}">${avatar(p)}<span>${esc(p.name)}</span>${d ? '<b>✓</b>' : ''}</div>`;
      })
      .join('')}</div>`;
  }

  function joinUrl() {
    const u = new URL('./', location.href);
    u.search = '?room=' + code;
    return u.href;
  }

  const screens = {
    connecting: () => `<div class="center">
      <div class="brand big">ХОХМАЧ</div>
      <div class="spinner"></div>
      <p class="muted">Создаём комнату…</p>
    </div>`,

    lobby: () => {
      const url = new URL('./', location.href);
      return `<div class="lobby">
        <div class="lobby-head">
          <div class="brand big wobble">ХОХМАЧ</div>
          <p class="tagline">Игра для компании: смешнее ответил — больше очков</p>
        </div>
        <div class="lobby-main">
          <div class="join-card">
            <div class="join-step">Откройте на телефоне</div>
            <div class="join-url">${esc(url.host + url.pathname)}</div>
            <div class="join-step">и введите код</div>
            <div class="room-code">${code}</div>
            <div class="qr-wrap"><div id="qr"></div><span>или наведите камеру</span></div>
          </div>
          <div class="lobby-side">
            <div id="status"></div>
            <div class="lobby-actions">
              <button class="btn big" data-action="start" id="startBtn">Начать игру</button>
              <label class="toggle"><input type="checkbox" data-action="tts" ${tts ? 'checked' : ''}> Озвучка вопросов</label>
            </div>
            <p class="hint">Нужно от ${MIN_PLAYERS} до ${MAX_PLAYERS} игроков (вдвоём голосуете сами — честно!). Первый вошедший — VIP: он тоже может запустить игру с телефона. Нажмите на игрока, чтобы выгнать.</p>
          </div>
        </div>
      </div>`;
    },

    intro: () => `<div class="center">
      <div class="round-title pop">Раунд ${S.round}</div>
      <p class="sub fade-in">${S.round === 1 ? 'Каждому — два вопроса. Ответьте смешнее соперника!' : 'Очки удваиваются! ×2'}</p>
    </div>`,

    answer: () => `<div class="screen">${topbar('Раунд ' + S.round)}
      <div class="center grow">
        <div class="phone-icon bounce">📱</div>
        <div class="big-text pop">Отвечайте на телефонах!</div>
        <p class="sub">У каждого по ${S.players.length > 2 ? 'два вопроса' : 'вопросу'}. Ваш ответ будет соревноваться с ответом другого игрока.</p>
        <div id="status"></div>
      </div>
    </div>`,

    vote: () => matchupHtml(false),
    reveal: () => matchupHtml(true),
    scores: () => leaderboard('Счёт после раунда ' + S.round),

    'final-intro': () => `<div class="center">
      <div class="round-title fire pop">ФИНАЛ</div>
      <p class="sub fade-in">Один вопрос для всех. Голос стоит 300 очков!</p>
    </div>`,

    'final-answer': () => `<div class="screen">${topbar('Финал')}
      <div class="center grow">
        <div class="prompt-box pop">${esc(S.final.prompt)}</div>
        <p class="sub">Все отвечают на этот вопрос на телефонах</p>
        <div id="status"></div>
      </div>
    </div>`,

    'final-vote': () => `<div class="screen">${topbar('Финал — голосование')}
      <div class="prompt-box pop">${esc(S.final.prompt)}</div>
      <div class="final-grid">${S.final.order
        .map((id, i) => `<div class="final-card pop" style="animation-delay:${i * 0.12}s"><span class="letter">${String.fromCharCode(65 + i)}</span>${esc(S.final.answers[id])}</div>`)
        .join('')}</div>
      <div id="status"></div>
    </div>`,

    'final-reveal': () => `<div class="screen">${topbar('Финал — итоги')}
      <div class="prompt-box">${esc(S.final.prompt)}</div>
      <div class="final-grid reveal">${S.final.result
        .map((r, i) => {
          const p = byId(r.id);
          if (!p) return '';
          return `<div class="final-card pop ${r.bonus ? 'win' : ''}" style="--c:${p.color};animation-delay:${(S.final.result.length - 1 - i) * 1.2}s">
            <div class="final-answer">${esc(S.final.answers[r.id])}</div>
            <div class="final-meta">${avatar(p)} <b>${esc(p.name)}</b>
              <span class="votes">${r.votes} ${plural(r.votes, 'голос', 'голоса', 'голосов')}</span>
              <span class="points">+${r.pts + r.bonus}</span></div>
          </div>`;
        })
        .join('')}</div>
    </div>`,

    end: () => {
      const sorted = [...S.players].sort((a, b) => b.score - a.score);
      const best = sorted.length ? sorted[0].score : 0;
      const winners = sorted.filter((p) => p.score === best);
      return `<div class="screen">${topbar('Конец игры')}
        <div class="winner pop">
          <div class="crown">👑</div>
          <div class="winner-avatars">${winners.map((p) => `<span class="av huge" style="--c:${p.color}">${p.avatar}</span>`).join('')}</div>
          <div class="winner-name">${winners.map((p) => esc(p.name)).join(' и ')}</div>
          <div class="sub">${winners.length > 1 ? 'делят победу' : 'главный хохмач вечера'} — ${best} ${plural(best, 'очко', 'очка', 'очков')}</div>
        </div>
        ${boardHtml(sorted)}
        <div class="center-row"><button class="btn big" data-action="again">Играть ещё раз</button></div>
        <div class="confetti" aria-hidden="true">${confetti()}</div>
      </div>`;
    },
  };

  function matchupHtml(reveal) {
    const m = S.matchups[S.current];
    const r = m.result;
    const sides = m.authors.map((a, i) => {
      const p = byId(a);
      const ans = m.answers[a];
      const rr = reveal && r ? r.res.find((x) => x.id === a) : null;
      const win = reveal && r && r.winner === a;
      const voters = reveal ? Object.entries(m.votes).filter(([, c]) => c === a).map(([v]) => byId(v)).filter(Boolean) : [];
      return `<div class="answer-card ${i ? 'right' : 'left'} ${win ? 'win' : ''} ${ans == null ? 'empty' : ''}" style="--c:${p ? p.color : '#888'}">
        <div class="answer-text">${ans == null ? '<i>нет ответа</i>' : esc(ans)}</div>
        ${rr && p ? `<div class="reveal-info">
            <div class="author pop" style="animation-delay:.2s">${avatar(p)} ${esc(p.name)}</div>
            <div class="voters">${voters.map((v, k) => `<span class="av small pop" style="--c:${v.color};animation-delay:${0.5 + k * 0.12}s">${v.avatar}</span>`).join('')}</div>
            <div class="votes pop" style="animation-delay:.4s">${rr.votes} ${plural(rr.votes, 'голос', 'голоса', 'голосов')}${rr.pct != null ? ' · ' + rr.pct + '%' : ''}</div>
            <div class="points pop" style="animation-delay:.9s">+${rr.pts + rr.bonus}</div>
          </div>` : ''}
      </div>`;
    });
    const voters = votersFor(m);
    return `<div class="screen">${topbar('Раунд ' + S.round + ' · битва ' + (S.current + 1) + '/' + S.matchups.length)}
      <div class="prompt-box pop">${esc(m.prompt)}</div>
      <div class="versus">${sides[0]}<div class="vs">VS</div>${sides[1]}</div>
      ${reveal && r && r.lash ? '<div class="lash-banner">РАЗНОС!</div>' : ''}
      ${reveal && r && r.note ? `<div class="note pop">${r.note}</div>` : ''}
      ${reveal ? '' : `<div class="vote-hint">Голосуйте на телефонах!</div><div id="status" data-voters="${voters.length}"></div>`}
    </div>`;
  }

  function boardHtml(sorted) {
    const max = Math.max(1, ...sorted.map((p) => p.score));
    return `<div class="board">${sorted
      .map(
        (p, i) => `<div class="board-row slide-in" style="--c:${p.color};--w:${Math.max(2, (p.score / max) * 100)}%;animation-delay:${i * 0.08}s">
          <span class="place">${i + 1}</span>${avatar(p)}<span class="name">${esc(p.name)}</span>
          <div class="bar"><div class="fill"></div></div><span class="score">${p.score}</span>
        </div>`
      )
      .join('')}</div>`;
  }

  function leaderboard(title) {
    const sorted = [...S.players].sort((a, b) => b.score - a.score);
    return `<div class="screen">${topbar()}<h1 class="title pop">${title}</h1>${boardHtml(sorted)}</div>`;
  }

  function confetti() {
    let s = '';
    for (let i = 0; i < 60; i++) {
      s += `<i style="left:${Math.random() * 100}%;background:${COLORS[i % COLORS.length]};animation-delay:${Math.random() * 3}s;animation-duration:${3 + Math.random() * 3}s"></i>`;
    }
    return s;
  }

  function statusHtml() {
    switch (S.phase) {
      case 'lobby': {
        const slots = [];
        for (let i = 0; i < MAX_PLAYERS; i++) {
          const p = S.players[i];
          slots.push(
            p
              ? `<button class="slot filled pop ${p.connected ? '' : 'off'}" style="--c:${p.color}" data-action="kick" data-id="${p.id}" title="Выгнать">
                  ${avatar(p)}<span class="slot-name">${esc(p.name)}</span>${p === vip() ? '<span class="vip">VIP</span>' : ''}
                </button>`
              : `<div class="slot empty"><span>${i < MIN_PLAYERS ? 'ждём игрока' : 'свободно'}</span></div>`
          );
        }
        return `<div class="slots">${slots.join('')}</div>`;
      }
      case 'answer':
        return chips(S.players, (p) => pendingFor(p).length === 0);
      case 'vote': {
        const m = S.matchups[S.current];
        return chips(votersFor(m), (p) => p.id in m.votes);
      }
      case 'final-answer':
        return chips(S.players, (p) => p.id in S.final.answers);
      case 'final-vote':
        return chips(finalVoters(), (p) => p.id in S.final.votes);
      default:
        return '';
    }
  }

  function render() {
    const key = S.phase + ':' + S.round + ':' + S.current;
    if (key !== lastKey) {
      lastKey = key;
      app.innerHTML = (screens[S.phase] || screens.connecting)();
      const qr = $('#qr');
      if (qr && window.QRCode) {
        new QRCode(qr, { text: joinUrl(), width: 160, height: 160, colorDark: '#1a0b2e', colorLight: '#ffffff' });
      }
    }
    const st = $('#status');
    if (st) st.innerHTML = statusHtml();
    const btn = $('#startBtn');
    if (btn) {
      const n = online().length;
      btn.disabled = n < MIN_PLAYERS;
      btn.textContent = n < MIN_PLAYERS ? `Нужно ещё ${MIN_PLAYERS - n}` : 'Начать игру';
    }
    tick();
  }

  function tick() {
    const el = $('#timer');
    if (!el) return;
    if (!S.deadline) {
      el.hidden = true;
      return;
    }
    const s = timeLeft();
    el.hidden = false;
    el.textContent = s;
    el.classList.toggle('low', s <= 10);
  }
  setInterval(tick, 250);

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'start') startGame();
    if (a === 'again') backToLobby();
    if (a === 'kick') {
      const p = byId(t.dataset.id);
      if (p && S.phase === 'lobby' && confirm(`Выгнать игрока «${p.name}»?`)) kick(p.id);
    }
  });
  app.addEventListener('change', (e) => {
    if (e.target.dataset.action === 'tts') {
      tts = e.target.checked;
      PB.save('pb-tts', tts ? '1' : '0');
      unlockAudio();
      if (tts) speak('Озвучка включена');
    }
  });
  document.addEventListener('click', unlockAudio, { once: true });
  window.addEventListener('beforeunload', (e) => {
    if (S.players.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  createRoom();
})();
