// Телефон игрока: подключается к ведущему и показывает то, что тот прислал
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const banner = $('#banner');
  const { esc, plural } = PB;

  // ?t=2 — отдельный игрок в той же вкладке браузера (удобно тестировать на одном компьютере)
  const tokenKey = 'pb-token' + (new URLSearchParams(location.search).get('t') || '');
  let token = PB.load(tokenKey, '');
  if (!token) {
    token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    PB.save(tokenKey, token);
  }

  let peer = null;
  let conn = null;
  let code = '';
  let name = PB.load('pb-name', '');
  let me = null;
  let joined = false;
  let lastMsg = 0;
  let lastAttempt = 0;
  let viewKey = '';
  let deadline = 0;
  let joinTimeout = null;

  // ---------- сессия (чтобы пережить перезагрузку страницы) ----------
  function saveSession() {
    try { sessionStorage.setItem('pb-session', JSON.stringify({ code, name })); } catch (e) { /* ignore */ }
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem('pb-session') || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    try { sessionStorage.removeItem('pb-session'); } catch (e) { /* ignore */ }
  }

  // ---------- сеть ----------
  function cleanup() {
    const p = peer;
    peer = null;
    conn = null;
    if (p) { try { p.destroy(); } catch (e) { /* ignore */ } }
  }

  const MAX_TRIES = 5;
  const NET_HELP = 'Проверьте интернет. Если вы на мобильном интернете или с VPN — попробуйте Wi-Fi или выключите VPN.';

  // Первое подключение: при сбое пробуем ещё несколько раз, а не сдаёмся сразу
  function retryOrFail(attempt, text) {
    if (joined) return;
    if (attempt < MAX_TRIES) {
      cleanup();
      showConnecting(`Не получилось, пробуем ещё раз… (попытка ${attempt + 1} из ${MAX_TRIES})`);
      clearTimeout(joinTimeout);
      joinTimeout = setTimeout(() => connect(attempt + 1), 1500 * attempt);
    } else {
      fail(text);
    }
  }

  function connect(attempt = 1) {
    lastAttempt = Date.now();
    cleanup();
    if (joined) setNet('Переподключаемся…');
    const pr = (peer = new Peer(PB.peerOptions));
    pr.on('open', () => {
      if (pr !== peer) return;
      const c = (conn = pr.connect(PB.PREFIX + code, { reliable: true }));
      c.on('open', () => {
        if (c !== conn) return;
        lastMsg = Date.now();
        c.send({ type: 'join', name, token });
      });
      c.on('data', (m) => {
        if (c !== conn) return;
        lastMsg = Date.now();
        onMsg(m);
      });
      c.on('close', () => {
        if (c !== conn) return;
        conn = null;
        if (joined) setNet('Связь потеряна, переподключаемся…');
      });
      c.on('error', () => { /* обработает watchdog */ });
    });
    pr.on('error', (err) => {
      if (pr !== peer) return;
      console.warn('peer error', err.type, err);
      if (joined) {
        setNet('Связь потеряна, переподключаемся…');
        return;
      }
      if (err.type === 'browser-incompatible') fail('Браузер не поддерживает WebRTC. Откройте сайт в Chrome или Safari.');
      else if (err.type === 'peer-unavailable') retryOrFail(Math.max(attempt, MAX_TRIES - 1), `Комната ${code} не найдена. Проверьте код — или ведущий закрыл игру.`);
      else retryOrFail(attempt, 'Не удалось связаться с сервером комнат (' + err.type + '). ' + NET_HELP);
    });
    if (!joined) {
      clearTimeout(joinTimeout);
      joinTimeout = setTimeout(() => {
        if (!joined && pr === peer) retryOrFail(attempt, 'Не удалось подключиться к комнате. ' + NET_HELP);
      }, 15000);
    }
  }

  function send(msg) {
    if (conn && conn.open) {
      try { conn.send(msg); return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  function setNet(text) {
    banner.textContent = text;
    banner.hidden = !text;
  }

  // Следим за связью: телефоны любят засыпать и рвать соединение
  setInterval(() => {
    if (!joined) return;
    const stale = !conn || !conn.open || Date.now() - lastMsg > 10000;
    if (stale && Date.now() - lastAttempt > 5000) connect();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && joined && (!conn || !conn.open || Date.now() - lastMsg > 6000)) connect();
  });

  function onMsg(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'joined':
        clearTimeout(joinTimeout);
        joined = true;
        me = m;
        saveSession();
        setNet('');
        viewKey = ''; // перерисовать всё после переподключения
        break;
      case 'view':
        setNet('');
        onView(m.view);
        break;
      case 'error':
        if (!joined) fail(m.text);
        break;
      case 'kicked':
        leave('Ведущий удалил вас из комнаты.');
        break;
    }
  }

  function fail(text) {
    clearTimeout(joinTimeout);
    cleanup();
    joined = false;
    clearSession();
    showJoin(text);
  }

  function leave(text) {
    joined = false;
    clearSession();
    cleanup();
    setNet('');
    showJoin(text || '');
  }

  // ---------- экраны ----------
  function header() {
    if (!me) return '';
    return `<div class="p-header" style="--c:${me.color}">
      <span class="av">${me.avatar}</span><b>${esc(me.name)}</b>
      <span class="p-code">${esc(code)}</span>
      <button class="link" data-action="leave">выйти</button>
    </div>`;
  }

  function showJoin(error) {
    viewKey = '';
    me = null;
    const params = new URLSearchParams(location.search);
    const prefill = PB.normalizeCode(params.get('room') || code);
    app.innerHTML = `<div class="p-screen join">
      <div class="brand big wobble">ХОХМАЧ</div>
      <p class="tagline">Игра для компании</p>
      <form id="joinForm" class="join-form" autocomplete="off">
        <label>Код комнаты
          <input id="codeIn" class="code-input" maxlength="4" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="ABCD" value="${esc(prefill)}" required>
        </label>
        <label>Ваше имя
          <input id="nameIn" maxlength="14" placeholder="Как вас называть?" value="${esc(name)}" required>
        </label>
        ${error ? `<div class="error">${esc(error)}</div>` : ''}
        <button class="btn big" type="submit">Войти в игру</button>
      </form>
      <div class="host-link">
        <p>Хотите провести игру? Откройте на компьютере или телевизоре:</p>
        <a class="btn ghost" href="host.html">Создать комнату 📺</a>
      </div>
    </div>`;
    const codeIn = $('#codeIn');
    codeIn.addEventListener('input', () => {
      const v = PB.normalizeCode(codeIn.value);
      if (codeIn.value !== v) codeIn.value = v;
    });
    $('#joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      code = PB.normalizeCode(codeIn.value);
      name = $('#nameIn').value.replace(/\s+/g, ' ').trim().slice(0, 14);
      if (code.length !== 4) return showJoin('Код комнаты — 4 буквы.');
      if (!name) return showJoin('Введите имя.');
      PB.save('pb-name', name);
      showConnecting();
      connect();
    });
    (prefill.length === 4 ? $('#nameIn') : codeIn).focus();
  }

  function showConnecting(note) {
    viewKey = '';
    app.innerHTML = `<div class="p-screen center"><div class="spinner"></div><p class="muted">Подключаемся к комнате ${esc(code)}…</p>${note ? `<p class="muted">${esc(note)}</p>` : ''}</div>`;
  }

  function onView(v) {
    deadline = v.time != null ? Date.now() + v.time * 1000 : 0;
    if (v.key !== viewKey) {
      viewKey = v.key;
      draw(v);
    }
    tick();
  }

  const timerHtml = () => `<div class="p-timer" id="ptimer"></div>`;

  function draw(v) {
    let body = '';
    switch (v.screen) {
      case 'lobby':
        body = `<div class="p-screen center">
          <div class="av huge pop" style="--c:${me.color}">${me.avatar}</div>
          <h2>Вы в игре!</h2>
          ${v.vip
            ? `<p class="vip-tag">⭐ Вы VIP ⭐</p>
               <p class="muted">${v.count} ${plural(v.count, 'игрок', 'игрока', 'игроков')} в комнате</p>
               <button class="btn big" data-action="start" ${v.count < v.min ? 'disabled' : ''}>
                 ${v.count < v.min ? 'Нужно ещё ' + (v.min - v.count) : 'Все в сборе — начать!'}
               </button>`
            : `<p class="muted">Ждём, пока VIP начнёт игру…</p>`}
        </div>`;
        break;

      case 'wait':
        body = `<div class="p-screen center">
          <h2 class="pop">${esc(v.title)}</h2>
          ${v.text ? `<p class="muted">${esc(v.text)}</p>` : ''}
          <div class="av huge float" style="--c:${me.color}">${me.avatar}</div>
        </div>`;
        break;

      case 'answer':
        body = `<div class="p-screen">
          <div class="p-row"><span class="muted">${v.final ? 'Финальный вопрос' : `Вопрос ${v.num} из ${v.total}`}</span>${timerHtml()}</div>
          <div class="p-prompt pop">${esc(v.prompt)}</div>
          <form id="ansForm" autocomplete="off">
            <textarea id="ansIn" maxlength="80" rows="3" placeholder="Ваш ответ…"></textarea>
            <div class="p-row"><button type="button" class="link" data-action="safety">🎲 ответ наугад</button><span class="muted" id="cnt">0/80</span></div>
            <button class="btn big" type="submit">Отправить</button>
          </form>
        </div>`;
        break;

      case 'vote':
        body = `<div class="p-screen">
          <div class="p-row"><span class="muted">${v.final ? 'Какой ответ лучший?' : 'Что смешнее?'}</span>${timerHtml()}</div>
          <div class="p-prompt small">${esc(v.prompt)}</div>
          ${v.honest ? '<p class="honest">Вас двое — голосуйте честно, можно и за соперника 😇</p>' : ''}
          <div class="options">${v.options
            .map((o, i) => `<button class="option pop" style="animation-delay:${i * 0.06}s" data-action="vote" data-id="${esc(o.id)}">${esc(o.text)}</button>`)
            .join('')}</div>
        </div>`;
        break;

      case 'end':
        if (v.fresh) {
          body = `<div class="p-screen center">
            <div class="av huge pop" style="--c:${me.color}">${me.avatar}</div>
            <h2>Вы в комнате!</h2>
            <p class="muted">Сыграете в следующей игре — ждём, пока VIP её запустит.</p>
            ${v.vip ? '<button class="btn big" data-action="again">Новая игра</button>' : ''}
          </div>`;
          break;
        }
        body = `<div class="p-screen center">
          <div class="big-emoji pop">${v.place === 1 ? '🏆' : v.place === 2 ? '🥈' : v.place === 3 ? '🥉' : '🎉'}</div>
          <h2>${v.place}-е место</h2>
          <p class="muted">${v.score} ${plural(v.score, 'очко', 'очка', 'очков')}</p>
          ${v.vip ? '<button class="btn big" data-action="again">Играть ещё раз</button>' : '<p class="muted">VIP может начать новую игру</p>'}
        </div>`;
        break;
    }
    app.innerHTML = header() + body;

    const ta = $('#ansIn');
    if (ta) {
      const cnt = $('#cnt');
      ta.addEventListener('input', () => (cnt.textContent = ta.value.length + '/80'));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          $('#ansForm').requestSubmit();
        }
      });
      $('#ansForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const text = ta.value.replace(/\s+/g, ' ').trim();
        if (!text) {
          ta.focus();
          return;
        }
        if (send({ type: 'answer', mid: v.mid, text })) {
          app.querySelector('#ansForm button[type=submit]').disabled = true;
          app.querySelector('#ansForm button[type=submit]').textContent = 'Отправляем…';
        }
      });
      setTimeout(() => ta.focus(), 50);
    }
  }

  function tick() {
    const el = $('#ptimer');
    if (!el) return;
    if (!deadline) {
      el.hidden = true;
      return;
    }
    const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.hidden = false;
    el.textContent = s;
    el.classList.toggle('low', s <= 10);
  }
  setInterval(tick, 250);

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'start') send({ type: 'start' });
    if (a === 'again') send({ type: 'again' });
    if (a === 'leave' && confirm('Выйти из игры?')) leave('');
    if (a === 'safety') {
      const ta = $('#ansIn');
      ta.value = SAFETY[(Math.random() * SAFETY.length) | 0];
      ta.dispatchEvent(new Event('input'));
    }
    if (a === 'vote') {
      if (send({ type: 'vote', choice: t.dataset.id })) {
        app.querySelectorAll('.option').forEach((b) => (b.disabled = true));
        t.classList.add('picked');
      }
    }
  });

  // ---------- старт ----------
  const sess = loadSession();
  const urlRoom = PB.normalizeCode(new URLSearchParams(location.search).get('room'));
  if (sess && sess.code && sess.name && (!urlRoom || urlRoom === sess.code)) {
    code = sess.code;
    name = sess.name;
    showConnecting();
    connect();
  } else {
    showJoin('');
  }
})();
