// Общие утилиты для экрана ведущего и телефона игрока
window.PB = {
  // Префикс ID комнаты на публичном сигнальном сервере PeerJS
  PREFIX: 'hohmach-ru-v1-',
  CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  // По умолчанию PeerJS использует 0.peerjs.com + свои STUN/TURN
  peerOptions: { debug: 1 },

  makeCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += this.CODE_CHARS[(Math.random() * this.CODE_CHARS.length) | 0];
    return s;
  },

  // Кириллица, похожая на латиницу, превращается в латиницу (удобно с русской раскладкой)
  normalizeCode(s) {
    const map = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' };
    return String(s || '')
      .toUpperCase()
      .replace(/[АВЕКМНОРСТУХ]/g, (c) => map[c])
      .replace(/[^A-Z]/g, '')
      .slice(0, 4);
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  },

  plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  load(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
  },
  save(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ }
  },
};
