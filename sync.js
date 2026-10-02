/* Pace bulut eşitleme - 1. parça: giriş/kayıt + APP_STATE (ayarlar, görevler, kayıtlar)
   Yerel-öncelikli: önce cihaza yazar, sonra arka planda Supabase ile alan-alan birleştirir. */
(function () {
  'use strict';
  var SUPABASE_URL = 'https://gkoqucyaxgphswlrzqsd.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_vooRR4tCBcpl1Cpn7arj1g_wAQB6ByB';
  var META_KEY = 'pace_sync_meta_v1';
  var BACKUP_KEY = 'pace_pre_sync_backup_v1';
  var SKIP = { updatedAt: 1, schemaVersion: 1, page: 1, _paceEpoch: 1 };          // cihaza özel alanlar
  var UNION = { stopwatchLogs: 1, stopwatchSubjectLogs: 1 };       // çakışmada anahtar bazlı birleştirilir

  if (!window.supabase || typeof APP_STATE === 'undefined' || typeof saveAppState === 'undefined') {
    console.warn('Pace eşitleme devre dışı: kütüphane veya uygulama durumu bulunamadı.');
    return;
  }
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true }, global: { fetch: function (u, o) { o = o || {}; o.cache = 'no-store'; return fetch(u, o); } } });
  function nc() { return '_nc' + Date.now() + Math.random().toString(36).slice(2, 6); }   // her okuma isteği benzersiz: eski önbellek yanıtı dönmesin
  var authState = 'unknown', email = '', syncState = 'idle', lastOk = 0;
  var uid = null, busy = false, again = false, pushT = null, channel = null;
  var status = 'Giriş yapılmadı', statusErr = false, modalOpen = false;

  // ---------- yardımcılar ----------
  function ts(x) { return Date.parse(x) || 0; }
  function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function hash(v) {
    var s = JSON.stringify(v) || '', h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h + ':' + s.length;
  }
  function loadMeta() {
    try { var m = JSON.parse(localStorage.getItem(META_KEY)); if (m) return m; } catch (e) {}
    return { uid: null, lastPull: null, times: {}, hashes: {}, dirty: {} };
  }
  function rnd() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function newMeta(u) { return { uid: u || null, epoch: rnd(), lastPull: null, times: {}, hashes: {}, dirty: {}, imgUp: {}, linked: false }; }
  var meta = loadMeta(); meta.imgUp = meta.imgUp || {};
  // Uygulamanın "Sıfırla" düğmesi yalnızca kendi verisini siler; eşitleme kaydı (imleç, özetler) kalırsa
  // cihaz "güncel" sanılır ve buluttan hiçbir şey inmez. Sıfırlanmış cihaz burada tespit edilip yeniden bağlanır.
  function wasWiped() {
    var hk = Object.keys(meta.hashes); if (!hk.length) return false;
    var miss = hk.filter(function (k) { return !(k in APP_STATE); }).length;
    return miss > 0 && (miss >= Math.ceil(hk.length / 2) || (meta.epoch && !APP_STATE._paceEpoch));
  }
  function stampEpoch() {
    if (!meta.epoch) meta.epoch = rnd();
    if (APP_STATE._paceEpoch !== meta.epoch) { APP_STATE._paceEpoch = meta.epoch; try { persistState(); } catch (e) {} }
  }
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }
  function persistState() { localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(APP_STATE)); }
  function trErr(e) {
    var m = ((e && e.message) || '').toLowerCase();
    if (m.indexOf('invalid login') > -1) return 'E-posta veya şifre hatalı.';
    if (m.indexOf('not confirmed') > -1) return 'E-posta henüz doğrulanmadı. Gelen kutundaki bağlantıya dokun.';
    if (m.indexOf('already registered') > -1) return 'Bu e-posta zaten kayıtlı, giriş yap.';
    if (m.indexOf('password') > -1) return 'Şifre en az 6 karakter olmalı.';
    if (m.indexOf('rate limit') > -1) return 'Çok fazla deneme. Biraz sonra tekrar dene.';
    return 'Hata: ' + ((e && e.message) || 'bilinmiyor');
  }

  // ---------- yerel değişiklik tespiti ----------
  // Kullanıcı ekrana dokunmadan önce uygulamanın kendiliğinden yaptığı düzenlemeler (açılışta
  // varsayılan alan ekleme, yeniden hesaplama vb.) gerçek değişiklik sayılmaz: buluta gönderilmez,
  // diğer cihazda gereksiz "Yenile" çıkarmaz. Yalnızca hesaba bağlı cihazda geçerli.
  var userActed = false;
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { userActed = true; }, { capture: true, passive: true });
  });
  function scan() {
    var now = new Date().toISOString(), changed = false, absorb = !!meta.linked && !userActed;
    Object.keys(APP_STATE).forEach(function (k) {
      if (SKIP[k]) return;
      var hs = hash(APP_STATE[k]);
      if (meta.hashes[k] !== hs) {
        var known = Object.prototype.hasOwnProperty.call(meta.hashes, k);
        if (absorb && known) { meta.hashes[k] = hs; changed = true; return; }   // sessizce kabul et, gönderme
        meta.times[k] = known ? now : (meta.linked ? now : '1970-01-01T00:00:01.000Z');
        meta.hashes[k] = hs; meta.dirty[k] = 1; changed = true;
      }
    });
    if (changed) { saveMeta(); ui(); }
    return changed && Object.keys(meta.dirty).length > 0;
  }

  var stat = { down: 0, up: 0 };
  function backup() {
    try {
      var cur = localStorage.getItem(APP_STORAGE_KEY) || '{}';
      if (!localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, cur);
      localStorage.setItem(BACKUP_KEY + '_son', cur);
    } catch (e) {}
  }
  // ---------- çekme ----------
  async function pull() {
    // İmleç yerine: önce hafif liste (id + updated_at), sonra yalnızca bu cihazdakinden yeni olanların verisi
    var m = await sb.from('sync_records').select('id,updated_at').eq('kind', 'state').neq('id', nc());
    if (m.error) throw m.error;
    var need = (m.data || []).filter(function (x) { return !SKIP[x.id] && (!meta.linked || ts(x.updated_at) > ts(meta.times[x.id])); })
      .map(function (x) { return x.id; });
    var rows = [], changed = false;
    if (need.length) {
      var d = await sb.from('sync_records').select('*').eq('kind', 'state').in('id', need).neq('id', nc());
      if (d.error) throw d.error;
      rows = d.data || [];
    }
    rows.forEach(function (row) {
      var k = row.id; if (SKIP[k] || row.deleted) return;
      var val = row.data && row.data.v, rh = hash(val);
      var localNewer = meta.linked && meta.dirty[k] && ts(meta.times[k]) > ts(row.updated_at);
      if (rh === meta.hashes[k]) { meta.times[k] = row.updated_at; delete meta.dirty[k]; return; }
      if (UNION[k] && meta.dirty[k] && isObj(val) && isObj(APP_STATE[k])) {
        backup(); stat.down++;
        APP_STATE[k] = localNewer ? Object.assign({}, val, APP_STATE[k]) : Object.assign({}, APP_STATE[k], val);
        meta.hashes[k] = hash(APP_STATE[k]); meta.times[k] = new Date().toISOString(); meta.dirty[k] = 1; changed = true;
        return;
      }
      if (localNewer) return;                                      // yerel daha yeni: gönderilecek
      backup(); stat.down++;
      APP_STATE[k] = val; meta.hashes[k] = rh; meta.times[k] = row.updated_at; delete meta.dirty[k]; changed = true;
    });
    saveMeta();
    if (changed) persistState();
    return changed;
  }

  // ---------- gönderme ----------
  async function push() {
    var keys = Object.keys(meta.dirty); if (!keys.length) return;
    var sent = {}, dev = getOrCreateDeviceId(); stat.up = keys.length;
    var rows = keys.map(function (k) {
      sent[k] = meta.times[k];
      return { user_id: uid, kind: 'state', id: k, data: { v: APP_STATE[k] === undefined ? null : APP_STATE[k] }, updated_at: meta.times[k], deleted: false, device_id: dev };
    });
    var r = await sb.from('sync_records').upsert(rows, { onConflict: 'user_id,kind,id' });
    if (r.error) throw r.error;
    keys.forEach(function (k) { if (meta.times[k] === sent[k]) delete meta.dirty[k]; });
    saveMeta();
  }


  // ---------- görseller (IndexedDB 'takvimim_images_v1' <-> Storage 'images/<uid>/<id>') ----------
  var imgDbP = null;
  function imgDb() {
    return imgDbP || (imgDbP = new Promise(function (res) {
      try {
        var r = indexedDB.open('takvimim_images_v1', 1);
        r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains('images')) r.result.createObjectStore('images'); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    }));
  }
  function idbReq(db, mode, fn) {
    return new Promise(function (res, rej) {
      var t = db.transaction('images', mode), q = fn(t.objectStore('images'));
      t.oncomplete = function () { res(q && q.result); }; t.onerror = function () { rej(t.error); };
    });
  }
  function imageRefs() {
    var m = JSON.stringify(APP_STATE).match(/idb:\/\/[\w-]+/g) || [], seen = {};
    return m.map(function (x) { return x.slice(6); }).filter(function (id) { return seen[id] ? false : (seen[id] = true); });
  }
  async function uploadImages() {
    var db = await imgDb(); if (!db) return;
    var local = {}; (await idbReq(db, 'readonly', function (s) { return s.getAllKeys(); }) || []).forEach(function (k) { local[k] = 1; });
    var todo = imageRefs().filter(function (id) { return local[id] && !meta.imgUp[id]; });
    for (var i = 0; i < todo.length; i++) {
      setStatus('Görseller yükleniyor (' + (i + 1) + '/' + todo.length + ')');
      var blob = await idbReq(db, 'readonly', function (s) { return s.get(todo[i]); });
      if (!blob) continue;
      var r = await sb.storage.from('images').upload(uid + '/' + todo[i], blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      if (r.error && !(String(r.error.statusCode) === '409' || /already exists|duplicate/i.test(r.error.message || ''))) throw r.error;
      meta.imgUp[todo[i]] = 1; saveMeta();
    }
  }
  async function downloadImages() {
    var db = await imgDb(); if (!db) return false;
    var local = {}; (await idbReq(db, 'readonly', function (s) { return s.getAllKeys(); }) || []).forEach(function (k) { local[k] = 1; });
    var todo = imageRefs().filter(function (id) { return !local[id]; }), got = 0;
    for (var i = 0; i < todo.length; i++) {
      setStatus('Görseller indiriliyor (' + (i + 1) + '/' + todo.length + ')');
      var r = await sb.storage.from('images').download(uid + '/' + todo[i]);
      if (r.error || !r.data) continue;                         // henüz yüklenmemiş olabilir: sonraki eşitlemede denenir
      await idbReq(db, 'readwrite', function (s) { return s.put(r.data, todo[i]); });
      meta.imgUp[todo[i]] = 1; got++;
    }
    if (got) saveMeta();
    return got > 0;
  }

  async function syncNow(startup) {
    if (!uid) return;
    if (busy) { again = true; return; }
    busy = true; syncState = 'busy'; stat = { down: 0, up: 0 }; setStatus('Eşitleniyor…');
    try {
      scan();
      var ch = await pull();
      await uploadImages();                  // dosyalar, kayıttan ÖNCE yüklenir
      await push();
      meta.linked = true; saveMeta();
      var imgs = await downloadImages();
      if (ch || imgs) {
        if (startup && !sessionStorage.getItem('pace_sync_rl')) { sessionStorage.setItem('pace_sync_rl', '1'); location.reload(); return; }
        showBanner();
      } else if (startup) sessionStorage.removeItem('pace_sync_rl');
      syncState = 'ok'; lastOk = Date.now();
      setStatus('Eşitlendi · ' + new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + ' · ↓' + stat.down + ' ↑' + stat.up);
    } catch (e) {
      console.warn('Eşitleme hatası:', e); syncState = 'err';
      if (/jwt|token|not authenticated|401/i.test((e && (e.message || e.code)) + '')) authState = 'expired';
      setStatus('Eşitlenemedi (çevrimdışı olabilir)', true);
    }
    busy = false;
    if (again) { again = false; schedule(300); }
  }
  function schedule(ms) { clearTimeout(pushT); pushT = setTimeout(function () { syncNow(false); }, ms || 1500); }

  window.addEventListener('app-state-saved', function () { if (uid && scan()) schedule(1500); });
  window.addEventListener('online', function () { schedule(500); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(300); else if (uid && scan()) syncNow(false); });

  // ---------- oturum ----------
  async function start(session) {
    var id = session.user.id;
    if (uid === id) return;
    if (meta.uid && meta.uid !== id) {
      if (!confirm('Bu cihazdaki veriler başka bir hesaba ait. Bu hesabın verisiyle değiştirilsin mi? (Cihazdaki veri önce yedeklenir)')) { meta.signedOut = true; saveMeta(); await sb.auth.signOut(); return; }
      try { localStorage.setItem(BACKUP_KEY, localStorage.getItem(APP_STORAGE_KEY) || '{}'); } catch (e) {}
      localStorage.removeItem(APP_STORAGE_KEY); localStorage.removeItem(META_KEY);
      sessionStorage.setItem('pace_sync_rl', '1'); location.reload(); return;
    }
    if (wasWiped()) { meta = newMeta(id); sessionStorage.removeItem('pace_sync_rl'); }   // sıfırlanmış cihaz: bulut kazanır
    uid = id; meta.uid = id; meta.signedOut = false; authState = 'in'; email = session.user.email || ''; stampEpoch(); saveMeta();
    setStatus('Bağlandı'); closeModal();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('pace-sync-' + id).on('postgres_changes',
      { event: '*', schema: 'public', table: 'sync_records', filter: 'user_id=eq.' + id },
      function (p) { if (p.new && p.new.device_id === getOrCreateDeviceId()) return; schedule(600); }).subscribe();
    syncNow(true);
  }
  sb.auth.onAuthStateChange(function (ev, session) {
    if (session) email = session.user.email || email;
    if (session && (ev === 'INITIAL_SESSION' || ev === 'SIGNED_IN')) setTimeout(function () { start(session); }, 0);
    if (!session && (ev === 'INITIAL_SESSION' || ev === 'SIGNED_OUT')) {
      uid = null; if (channel) { sb.removeChannel(channel); channel = null; }
      authState = (meta.uid && !meta.signedOut) ? 'expired' : 'out';   // kullanıcı çıkmadıysa: oturum kendiliğinden düştü
      setStatus(authState === 'expired' ? 'Oturum düştü' : 'Giriş yapılmadı', authState === 'expired');
    }
  });
  async function doSignOut() { meta.signedOut = true; saveMeta(); await sb.auth.signOut(); }

  // ---------- arayüz ----------
  var css = '#paceSyncBtn{position:fixed;left:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);z-index:2147483000;width:36px;height:36px;border-radius:50%;border:1px solid rgba(128,128,128,.4);background:rgba(250,250,250,.92);color:#333;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 8px rgba(0,0,0,.2)}' +
    '#paceSyncDot{position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;background:#999;border:1.5px solid #fff}' +
    '#paceSyncOv{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;touch-action:auto}' +
    '#paceSyncCard{background:#fff;color:#222;width:100%;max-width:340px;border-radius:16px;padding:18px;font:15px/1.4 -apple-system,system-ui,sans-serif}' +
    '#paceSyncCard h3{margin:0 0 4px;font-size:17px}#paceSyncCard p{margin:0 0 12px;color:#666;font-size:13px}' +
    '#paceSyncCard input{width:100%;box-sizing:border-box;padding:11px;font-size:16px;border:1px solid #ccc;border-radius:10px;margin-bottom:8px;background:#fff;color:#222}' +
    '#paceSyncCard button{width:100%;padding:11px;font-size:15px;border-radius:10px;border:1px solid #ccc;background:#f4f4f4;color:#222;margin-top:6px}' +
    '#paceSyncCard button.pri{background:#222;color:#fff;border-color:#222}' +
    '#paceSyncMsg{min-height:18px;font-size:13px;color:#c0392b;margin-top:6px}' +
    '#paceSyncBanner{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;transform:translateX(-50%);z-index:2147483002;background:#222;color:#fff;border-radius:12px;padding:10px 14px;font:14px -apple-system,system-ui,sans-serif;display:flex;gap:12px;align-items:center;box-shadow:0 4px 14px rgba(0,0,0,.3)}' +
    '#paceSyncBanner button{background:#fff;color:#222;border:0;border-radius:8px;padding:6px 10px;font-size:14px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.id = 'paceSyncBtn'; btn.setAttribute('aria-label', 'Bulut eşitleme');
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 18H7a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/></svg><span id="paceSyncDot"></span>';
  document.body.appendChild(btn);
  btn.addEventListener('click', openModal);

  function setStatus(t, err) {
    status = t; statusErr = !!err;
    var d = document.getElementById('paceSyncDot');
    if (d) d.style.background = !uid ? '#999' : (statusErr ? '#e74c3c' : '#2ecc71');
    if (modalOpen) render();
    ui();
  }
  function openModal() { modalOpen = true; var ov = document.createElement('div'); ov.id = 'paceSyncOv'; ov.innerHTML = '<div id="paceSyncCard"></div>'; document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); }); render(); }
  function closeModal() { modalOpen = false; var ov = document.getElementById('paceSyncOv'); if (ov) ov.remove(); }
  function showBanner() {
    if (document.getElementById('paceSyncBanner')) return;
    var b = document.createElement('div'); b.id = 'paceSyncBanner';
    b.innerHTML = '<span>Başka cihazdan güncelleme geldi</span><button>Yenile</button>';
    b.querySelector('button').onclick = function () { location.reload(); };
    document.body.appendChild(b);
  }
  function render() {
    var c = document.getElementById('paceSyncCard'); if (!c) return;
    if (uid) {
      c.innerHTML = '<h3>Bulut eşitleme</h3><p>' + status + '</p><button class="pri" data-a="sync">Şimdi eşitle</button><button data-a="re">Buluttan yeniden yükle</button><button data-a="dx">Teşhis</button><button data-a="out">Çıkış yap</button><button data-a="close">Kapat</button><div id="paceSyncMsg" style="color:#444;word-break:break-all"></div>';
    } else {
      c.innerHTML = '<h3>Giriş yap</h3><p>Verilerin cihazların arasında eşitlensin.</p><input id="psEmail" type="email" placeholder="E-posta" autocomplete="email"><input id="psPass" type="password" placeholder="Şifre (en az 6 karakter)" autocomplete="current-password"><button class="pri" data-a="in">Giriş yap</button><button data-a="up">Kayıt ol</button><div id="paceSyncMsg"></div>';
    }
    c.onclick = async function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a'); if (!a) return;
      var msg = document.getElementById('paceSyncMsg');
      if (a === 'close') return closeModal();
      if (a === 'sync') return syncNow(false);
      if (a === 're') {
        if (!confirm('Bu cihazdaki veri, buluttaki veriyle değiştirilecek (önce yedeklenir). Devam edilsin mi?')) return;
        backup(); meta = newMeta(uid); stampEpoch(); saveMeta(); sessionStorage.removeItem('pace_sync_rl'); closeModal(); return syncNow(true);
      }
      if (a === 'dx') {
        msg.textContent = 'Kontrol ediliyor…';
        var q = await sb.from('sync_records').select('id,updated_at,device_id').eq('kind', 'state').neq('id', nc());
        msg.textContent = 'sürüm 9 · bulutta ' + (q.data ? q.data.length : '?') + ' alan' + (q.error ? ' · HATA: ' + q.error.message : '') +
          ' · bu cihazda ' + Object.keys(APP_STATE).length + ' alan · imleç ' + (meta.lastPull || 'yok') + ' · bağlı ' + !!meta.linked +
          ' · ' + (q.data || []).map(function (x) { return x.id + '@' + String(x.updated_at).slice(5, 16); }).join(', ');
        return;
      }
      if (a === 'out') return doSignOut();
      var em = document.getElementById('psEmail').value.trim(), pw = document.getElementById('psPass').value;
      if (!em || pw.length < 6) { msg.textContent = 'E-posta ve en az 6 karakterli şifre gir.'; return; }
      msg.style.color = '#666'; msg.textContent = 'Bekleniyor…';
      try {
        if (a === 'in') { var r = await sb.auth.signInWithPassword({ email: em, password: pw }); if (r.error) throw r.error; }
        else {
          var r2 = await sb.auth.signUp({ email: em, password: pw, options: { emailRedirectTo: new URL('./', location.href).href } });
          if (r2.error) throw r2.error;
          if (!r2.data.session) { msg.textContent = 'Doğrulama e-postası gönderildi. Bağlantıya dokunduktan sonra buradan giriş yap.'; }
        }
      } catch (err) { msg.style.color = '#c0392b'; msg.textContent = trErr(err); }
    };
  }


  // ---------- Ayarlar > Hesabım ----------
  var acss = '.acct-dot{width:12px;height:12px;border-radius:50%;flex:none;background:#8a8a8a;box-shadow:0 0 0 4px rgba(138,138,138,.2);transition:background .25s,box-shadow .25s}' +
    '.acct-dot[data-s=ok]{background:#2ecc71;box-shadow:0 0 0 4px rgba(46,204,113,.22)}' +
    '.acct-dot[data-s=busy]{background:#f5b301;box-shadow:0 0 0 4px rgba(245,179,1,.25);animation:acctPulse 1.1s ease-in-out infinite}' +
    '.acct-dot[data-s=err]{background:#e74c3c;box-shadow:0 0 0 4px rgba(231,76,60,.25)}' +
    '@keyframes acctPulse{50%{box-shadow:0 0 0 8px rgba(245,179,1,0)}}' +
    '#acctSection .settings-row-link{width:100%;text-align:left}#acctSection button:disabled{opacity:.45}';
  var ast = document.createElement('style'); ast.textContent = acss; document.head.appendChild(ast);

  function mountAccount() {
    if (document.getElementById('acctSection')) return;
    var host = document.querySelector('#page-settings .settings-col-left') || document.querySelector('#page-settings .settings-page');
    if (!host) return;
    var sec = document.createElement('div'); sec.className = 'settings-section'; sec.id = 'acctSection';
    var row = function (t, d, id) { return '<div class="settings-row"><div class="settings-row-text"><span class="settings-row-title">' + t + '</span><span class="settings-row-desc" id="' + id + 'Desc"></span></div><span class="acct-dot" id="' + id + 'Dot"></span></div>'; };
    var btnRow = function (id, t) { return '<button type="button" class="settings-row settings-row-link" id="' + id + '"><div class="settings-row-text"><span class="settings-row-title">' + t + '</span></div></button>'; };
    sec.innerHTML = '<span class="settings-section-label">Hesabım</span><div class="settings-card">' +
      row('Oturum', '', 'acctSess') + '<div class="settings-divider"></div>' + row('Yedekleme', '', 'acctSync') +
      '<div class="settings-divider"></div>' + btnRow('acctSyncBtn', 'Şimdi yedekle') +
      '<div class="settings-divider"></div>' + btnRow('acctAuthBtn', 'Giriş yap') +
      '<div class="settings-divider"></div>' + btnRow('acctAdvBtn', 'Gelişmiş (teşhis, buluttan yükle)') + '</div>';
    host.insertBefore(sec, host.firstChild);
    document.getElementById('paceSyncBtn').style.display = 'none';    // artık ayarlardan yönetiliyor
    document.getElementById('acctSyncBtn').onclick = function () { syncNow(false); };
    document.getElementById('acctAuthBtn').onclick = function () { if (authState === 'in') doSignOut(); else openModal(); };
    document.getElementById('acctAdvBtn').onclick = function () { if (authState === 'in') openModal(); else openModal(); };
    ui();
  }
  function ui() {
    var g = function (i) { return document.getElementById(i); };
    if (!g('acctSection')) return;
    var n = Object.keys(meta.dirty).length, sess, sd, sy, sc;
    if (authState === 'in') { sess = 'Giriş yapıldı' + (email ? ' · ' + email : ''); sd = 'ok'; }
    else if (authState === 'expired') { sess = 'Oturum düştü · bu cihaz hâlâ bağlı görünüyor ama yedeklenmiyor'; sd = 'err'; }
    else { sess = authState === 'unknown' ? 'Kontrol ediliyor…' : 'Giriş yapılmadı'; sd = 'off'; }
    if (authState === 'expired') { sy = 'Yedeklenmiyor' + (n ? ' · ' + n + ' değişiklik bekliyor' : ''); sc = 'err'; }
    else if (authState !== 'in') { sy = 'Kapalı'; sc = 'off'; }
    else if (busy || syncState === 'busy') { sy = 'Yedekleniyor…'; sc = 'busy'; }
    else if (syncState === 'err') { sy = 'Yedeklenemedi · bağlantı gelince tekrar denenecek'; sc = 'err'; }
    else if (n) { sy = n + ' değişiklik yedeklenecek'; sc = 'busy'; }
    else { sy = 'Yedeklendi' + (lastOk ? ' · ' + new Date(lastOk).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''); sc = 'ok'; }
    g('acctSessDesc').textContent = sess; g('acctSessDot').setAttribute('data-s', sd);
    g('acctSyncDesc').textContent = sy; g('acctSyncDot').setAttribute('data-s', sc);
    g('acctSyncBtn').disabled = authState !== 'in';
    g('acctAuthBtn').querySelector('.settings-row-title').textContent = authState === 'in' ? 'Çıkış yap' : (authState === 'expired' ? 'Yeniden giriş yap' : 'Giriş yap');
  }
  mountAccount();

  window.PaceSync = { syncNow: function () { return syncNow(false); } };
})();
