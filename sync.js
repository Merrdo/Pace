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

  var stat = { down: 0, up: 0 }, chKeys = [];
  function backup() {
    try {
      var cur = localStorage.getItem(APP_STORAGE_KEY) || '{}';
      if (!localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, cur);
      localStorage.setItem(BACKUP_KEY + '_son', cur);
    } catch (e) {}
  }
  // ---------- çekme ----------
  async function pull() {
    chKeys = [];
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
        meta.hashes[k] = hash(APP_STATE[k]); meta.times[k] = new Date().toISOString(); meta.dirty[k] = 1; changed = true; chKeys.push(k);
        return;
      }
      if (localNewer) return;                                      // yerel daha yeni: gönderilecek
      backup(); stat.down++;
      APP_STATE[k] = val; meta.hashes[k] = rh; meta.times[k] = row.updated_at; delete meta.dirty[k]; changed = true; chKeys.push(k);
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
      if ((ch && chKeys.some(function (k) { return k !== 'profile'; })) || imgs) {
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
    busy = false; ui();
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
        msg.textContent = 'sürüm 12 · bulutta ' + (q.data ? q.data.length : '?') + ' alan' + (q.error ? ' · HATA: ' + q.error.message : '') +
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
  var acss = '.acct-dot{width:11px;height:11px;border-radius:50%;flex:none;background:#8a8a8a;box-shadow:0 0 0 4px rgba(138,138,138,.2);transition:background .25s,box-shadow .25s}' +
    '.acct-dot[data-s=ok]{background:#2ecc71;box-shadow:0 0 0 4px rgba(46,204,113,.22)}' +
    '.acct-dot[data-s=busy]{background:#f5b301;box-shadow:0 0 0 4px rgba(245,179,1,.25);animation:acctPulse 1.1s ease-in-out infinite}' +
    '.acct-dot[data-s=err]{background:#e74c3c;box-shadow:0 0 0 4px rgba(231,76,60,.25)}' +
    '@keyframes acctPulse{50%{box-shadow:0 0 0 8px rgba(245,179,1,0)}}' +
    '#acctCard{padding:4px 0 2px}' +
    '.acct-box,.acct-tile,.acct-note{color:var(--theme-text,#121212);font-family:"Baloo 2","Space Grotesk",sans-serif}' +
    '.acct-box{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:20px;background:rgba(128,128,128,.13);border:1px solid rgba(128,128,128,.2)}' +
    '.acct-av{width:46px;height:46px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;font-weight:700}' +
    '.acct-av-off{background:rgba(128,128,128,.35)}' +
    '.acct-who{min-width:0;display:flex;flex-direction:column;gap:2px}.acct-who b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.acct-who span{font-size:13px;opacity:.65;overflow:hidden;text-overflow:ellipsis}' +
    '.acct-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}' +
    '.acct-tile{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:16px;background:rgba(128,128,128,.1);border:1px solid rgba(128,128,128,.16)}' +
    '.acct-tile div{display:flex;flex-direction:column;gap:1px;min-width:0}.acct-tile b{font-size:14px}.acct-tile span:not(.acct-dot){font-size:12.5px;opacity:.7}' +
    '.acct-note{margin:10px 2px 0;font-size:13px;line-height:1.4;opacity:.8}.acct-note.err{color:#e74c3c;opacity:1}' +
    '.acct-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.acct-actions button:disabled{opacity:.45}';
  var ast = document.createElement('style'); ast.textContent = acss; document.head.appendChild(ast);
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }


  var pcss = '.acct-click{cursor:pointer}.acct-chev{margin-left:auto;opacity:.5;flex:none}' +
    '.pf-av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background-size:cover;background-position:center;font-weight:700;flex:none;box-sizing:border-box}' +
    '#profOv{position:fixed;inset:0;z-index:2147483003;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.pf-card{width:100%;max-width:460px;max-height:92vh;max-height:92dvh;overflow-y:auto;box-sizing:border-box;padding:20px 22px 24px;border-radius:28px;background:var(--theme-bg,#0b0b0b);color:var(--theme-text,#121212);font-family:"Baloo 2","Space Grotesk",sans-serif;border:1px solid rgba(128,128,128,.28);box-shadow:0 24px 60px rgba(0,0,0,.5);touch-action:pan-y}' +
    '@media(max-width:600px){#profOv{padding:0;align-items:stretch}.pf-card{max-width:none;max-height:none;height:100%;border-radius:0;border:0;padding:calc(env(safe-area-inset-top,0px) + 14px) 18px calc(env(safe-area-inset-bottom,0px) + 22px)}}' +
    '.pf-top{display:grid;grid-template-columns:40px 1fr 40px;align-items:center;text-align:center;font-size:18px;margin-bottom:6px}' +
    '.pf-x{width:36px;height:36px;border-radius:50%;border:0;background:rgba(128,128,128,.18);color:inherit;font-size:15px}' +
    '.pf-hero{display:flex;justify-content:center;margin:14px 0 18px}.pf-hero .pf-av{box-shadow:0 0 0 4px rgba(128,128,128,.22)}' +
    '.pf-seg{display:flex;padding:4px;border-radius:999px;background:rgba(128,128,128,.16);gap:4px;margin-bottom:16px}' +
    '.pf-seg button{flex:1;padding:10px 0;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:15px}' +
    '.pf-seg button.on{background:var(--theme-text,#121212);color:var(--theme-bg,#fff)}' +
    '.pf-lbl{font-size:13px;opacity:.65;margin:14px 0 8px}' +
    '.pf-sws{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}.pf-sw{aspect-ratio:1;border-radius:50%;border:0;padding:0;position:relative}' +
    '.pf-sw.on{box-shadow:0 0 0 3px var(--theme-bg,#000),0 0 0 5px var(--theme-text,#fff)}' +
    '.pf-custom{background:conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);overflow:hidden}.pf-custom input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}' +
    '.pf-in{width:100%;box-sizing:border-box;padding:13px 14px;font:inherit;font-size:16px;border-radius:14px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit}' +
    '.pf-mail{margin:8px 2px 0;font-size:12.5px;opacity:.55}.pf-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}.pf-end{justify-content:flex-end;margin-top:22px}' +
    '.pf-save{background:var(--theme-text,#121212)!important;color:var(--theme-bg,#fff)!important}.pf-hint{margin:2px 0 12px;font-size:13px;opacity:.65;text-align:center}' +
    '.pf-crop{position:relative;margin:0 auto;overflow:hidden;border-radius:18px;background:#000;touch-action:none;cursor:grab}' +
    '.pf-crop img{position:absolute;max-width:none!important;max-height:none!important;transform-origin:center;user-select:none;-webkit-user-drag:none;pointer-events:none}' +
    '.pf-mask{position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 999px rgba(0,0,0,.62);border:2px solid rgba(255,255,255,.9);pointer-events:none}.pf-zoom{width:100%;margin:16px 0 0}';
  ast.textContent += pcss;

  // ---------- Profil (fotoğraf / harf logosu / rumuz) ----------
  var PALETTE = ['#E5484D', '#F76B15', '#F5B301', '#30A46C', '#12A594', '#0091FF', '#3E63DD', '#8E4EC6', '#D6409F', '#6E6E73', '#A18072', '#1F2937'];
  var draft = null, cropSt = null;
  function prof() { return (APP_STATE.profile && typeof APP_STATE.profile === 'object') ? APP_STATE.profile : {}; }
  function dispName(p) { p = p || prof(); return (p.name && p.name.trim()) || (email || '').split('@')[0] || 'Hesap'; }
  function pickColor(p) {
    if (p.color) return p.color;
    var h = 0, e = email || 'x'; for (var i = 0; i < e.length; i++) h = (h * 31 + e.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function textOn(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
    var n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 165 ? '#111' : '#fff';
  }
  function avatarHTML(size, p) {
    p = p || prof();
    var dim = 'width:' + size + 'px;height:' + size + 'px;';
    if (p.mode === 'photo' && p.photo) return '<span class="pf-av" style="' + dim + 'background-image:url(\'' + p.photo + '\')"></span>';
    var c = pickColor(p);
    return '<span class="pf-av" style="' + dim + 'background:' + c + ';color:' + textOn(c) + ';font-size:' + Math.round(size * 0.44) + 'px">' + esc(dispName(p).charAt(0).toLocaleUpperCase('tr-TR')) + '</span>';
  }
  function toast(m) { if (typeof showAppToast === 'function') showAppToast(m, 'error'); else alert(m); }
  function openProfile() {
    if (document.getElementById('profOv')) return;
    draft = Object.assign({ mode: 'letter' }, prof()); draft.name = dispName(draft); draft.color = pickColor(draft);
    var ov = document.createElement('div'); ov.id = 'profOv'; ov.innerHTML = '<div class="pf-card" id="profCard"></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', onProfClick);
    ov.addEventListener('change', function (e) {
      if (e.target.id === 'pfFile' && e.target.files && e.target.files[0]) { openCrop(e.target.files[0]); e.target.value = ''; }
      if (e.target.getAttribute('data-pf') === 'custom') { draft.color = e.target.value; draft.mode = 'letter'; renderProfile(); }
    });
    ov.addEventListener('input', function (e) {
      if (e.target.getAttribute('data-pf') === 'custom') { draft.color = e.target.value; draft.mode = 'letter'; var hr = ov.querySelector('.pf-hero'); if (hr) hr.innerHTML = avatarHTML(120, draft); }
    });
    renderProfile();
  }
  function closeProfile() { var o = document.getElementById('profOv'); if (o) o.remove(); if (cropSt) { try { URL.revokeObjectURL(cropSt.url); } catch (e) {} } draft = null; cropSt = null; }
  function keepName() { var ni = document.getElementById('pfName'); if (ni && draft) draft.name = ni.value; }
  function renderProfile() {
    var c = document.getElementById('profCard'); if (!c || !draft) return;
    keepName(); cropSt = null;
    var photo = draft.mode === 'photo', cur = String(draft.color).toLowerCase(), inPal = false;
    var sw = PALETTE.map(function (col) {
      var on = col.toLowerCase() === cur; if (on) inPal = true;
      return '<button type="button" class="pf-sw' + (on ? ' on' : '') + '" data-pf="color" data-v="' + col + '" style="background:' + col + '" aria-label="Renk ' + col + '"></button>';
    }).join('');
    var custom = '<label class="pf-sw pf-custom' + (!inPal ? ' on' : '') + '" aria-label="Özel renk"><input type="color" data-pf="custom" value="' + (/^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#3e63dd') + '"></label>';
    c.innerHTML = '<div class="pf-top"><button type="button" class="pf-x" data-pf="close" aria-label="Kapat">✕</button><b>Profil</b><span></span></div>' +
      '<div class="pf-hero">' + avatarHTML(120, draft) + '</div>' +
      '<div class="pf-seg"><button type="button" data-pf="mode" data-v="photo" class="' + (photo ? 'on' : '') + '">Fotoğraf</button><button type="button" data-pf="mode" data-v="letter" class="' + (!photo ? 'on' : '') + '">Harf logosu</button></div>' +
      (photo
        ? '<div class="pf-row"><button type="button" class="settings-outline-btn" data-pf="pick">' + (draft.photo ? 'Fotoğrafı değiştir' : 'Fotoğraf seç') + '</button>' + (draft.photo ? '<button type="button" class="settings-outline-btn" data-pf="rm">Kaldır</button>' : '') + '</div>'
        : '<div class="pf-lbl">Logo rengi</div><div class="pf-sws">' + sw + custom + '</div>') +
      '<div class="pf-lbl">Rumuz</div><input class="pf-in" id="pfName" maxlength="24" autocomplete="off" value="' + esc(draft.name) + '" placeholder="Rumuzun">' +
      '<div class="pf-mail">' + esc(email || '') + '</div>' +
      '<div class="pf-row pf-end"><button type="button" class="settings-outline-btn" data-pf="close">Vazgeç</button><button type="button" class="settings-outline-btn pf-save" data-pf="save">Kaydet</button></div>' +
      '<input type="file" id="pfFile" accept="image/*" hidden>';
  }
  function onProfClick(e) {
    var b = e.target.closest && e.target.closest('[data-pf]'); if (!b || !draft) return;
    var a = b.getAttribute('data-pf'), v = b.getAttribute('data-v');
    if (a === 'close') return closeProfile();
    if (a === 'mode') { keepName(); draft.mode = v; return renderProfile(); }
    if (a === 'color') { keepName(); draft.color = v; draft.mode = 'letter'; return renderProfile(); }
    if (a === 'pick') { keepName(); return document.getElementById('pfFile').click(); }
    if (a === 'rm') { keepName(); draft.photo = ''; return renderProfile(); }
    if (a === 'cropx') { if (cropSt) { try { URL.revokeObjectURL(cropSt.url); } catch (x) {} } return renderProfile(); }
    if (a === 'cropok') return cropDone();
    if (a === 'save') {
      keepName();
      var out = { name: (draft.name || '').trim().slice(0, 24), mode: (draft.mode === 'photo' && draft.photo) ? 'photo' : 'letter', color: draft.color, photo: draft.photo || '' };
      saveAppState({ profile: out }); closeProfile(); ui();
    }
  }
  // Kırpıcı: uygulamadaki fotoğraf kırpıcıyla aynı mantık (kapla, 1x–3x yakınlaştır, sürükle, iki parmakla büyüt),
  // fakat görünecek alan dairesel gösterilir.
  function openCrop(file) {
    keepName();
    var url = URL.createObjectURL(file), img = new Image();
    img.onerror = function () { URL.revokeObjectURL(url); toast('Bu görsel açılamadı. Başka bir fotoğraf dene.'); };
    img.onload = function () { startCrop(img, url); };
    img.src = url;
  }
  function startCrop(img, url) {
    var c = document.getElementById('profCard'); if (!c) return;
    var S = Math.max(200, Math.min(340, (c.clientWidth || 340) - 48));
    c.innerHTML = '<div class="pf-top"><button type="button" class="pf-x" data-pf="cropx" aria-label="Vazgeç">✕</button><b>Fotoğrafı ayarla</b><span></span></div>' +
      '<p class="pf-hint">Sürükle ve yakınlaştır. Dairenin içi profilinde görünecek alan.</p>' +
      '<div class="pf-crop" id="pfCrop" style="width:' + S + 'px;height:' + S + 'px"><img id="pfImg" alt=""><div class="pf-mask"></div></div>' +
      '<input type="range" id="pfZoom" class="pf-zoom" min="100" max="300" value="100" aria-label="Yakınlaştır">' +
      '<div class="pf-row pf-end"><button type="button" class="settings-outline-btn" data-pf="cropx">Vazgeç</button><button type="button" class="settings-outline-btn pf-save" data-pf="cropok">Uygula</button></div>';
    var el = document.getElementById('pfImg'), box = document.getElementById('pfCrop'), zoom = document.getElementById('pfZoom');
    var nw = img.naturalWidth, nh = img.naturalHeight, cover = S / Math.min(nw, nh);
    el.src = url; el.style.width = nw * cover + 'px'; el.style.height = nh * cover + 'px';
    el.style.left = (S - nw * cover) / 2 + 'px'; el.style.top = (S - nh * cover) / 2 + 'px';
    var st = cropSt = { img: img, url: url, S: S, nw: nw, nh: nh, cover: cover, z: 1, px: 0, py: 0 };
    function apply() {
      var mx = Math.max(0, (nw * cover * st.z - S) / 2), my = Math.max(0, (nh * cover * st.z - S) / 2);
      st.px = Math.min(Math.max(st.px, -mx), mx); st.py = Math.min(Math.max(st.py, -my), my);
      el.style.transform = 'translate(' + st.px + 'px,' + st.py + 'px) scale(' + st.z + ')'; zoom.value = Math.round(st.z * 100);
    }
    var ptrs = {}, pinch0 = 0, z0 = 1;
    box.addEventListener('pointerdown', function (e) {
      try { box.setPointerCapture(e.pointerId); } catch (x) {}
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(ptrs); if (ids.length === 2) { pinch0 = Math.hypot(ptrs[ids[0]].x - ptrs[ids[1]].x, ptrs[ids[0]].y - ptrs[ids[1]].y); z0 = st.z; }
    });
    box.addEventListener('pointermove', function (e) {
      var p = ptrs[e.pointerId]; if (!p) return;
      var ids = Object.keys(ptrs);
      if (ids.length >= 2) {
        ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
        var d = Math.hypot(ptrs[ids[0]].x - ptrs[ids[1]].x, ptrs[ids[0]].y - ptrs[ids[1]].y);
        if (pinch0) { st.z = Math.min(3, Math.max(1, z0 * d / pinch0)); apply(); }
      } else { st.px += e.clientX - p.x; st.py += e.clientY - p.y; ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; apply(); }
    });
    ['pointerup', 'pointercancel'].forEach(function (t) { box.addEventListener(t, function (e) { delete ptrs[e.pointerId]; pinch0 = 0; }); });
    box.addEventListener('wheel', function (e) { e.preventDefault(); st.z = Math.min(3, Math.max(1, st.z * (e.deltaY < 0 ? 1.08 : 0.93))); apply(); }, { passive: false });
    zoom.addEventListener('input', function () { st.z = Number(zoom.value) / 100; apply(); });
    apply();
  }
  function cropDone() {
    var st = cropSt; if (!st) return;
    var OUT = 256, eff = st.cover * st.z, il = (st.S - st.nw * eff) / 2 + st.px, it = (st.S - st.nh * eff) / 2 + st.py;
    var cv = document.createElement('canvas'); cv.width = cv.height = OUT;
    cv.getContext('2d').drawImage(st.img, -il / eff, -it / eff, st.S / eff, st.S / eff, 0, 0, OUT, OUT);
    draft.photo = cv.toDataURL('image/jpeg', 0.86); draft.mode = 'photo';
    try { URL.revokeObjectURL(st.url); } catch (x) {}
    renderProfile();
  }

  function mountAccount() {
    if (document.getElementById('acctSection')) return;
    var host = document.querySelector('#page-settings .settings-col-left') || document.querySelector('#page-settings .settings-page');
    if (!host) return;
    var sec = document.createElement('div'); sec.className = 'settings-section'; sec.id = 'acctSection';
    sec.innerHTML = '<span class="settings-section-label">Hesabım</span><div class="settings-card"><div id="acctCard"></div></div>';
    host.insertBefore(sec, host.firstChild);
    sec.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-acct]'); if (!b || b.disabled) return;
      var a = b.getAttribute('data-acct');
      if (a === 'profile') { if (authState === 'in' || authState === 'expired') openProfile(); else openModal(); }
      else if (a === 'sync') syncNow(false); else if (a === 'out') doSignOut(); else openModal();
    });
    var fb = document.getElementById('paceSyncBtn'); if (fb) fb.style.display = 'none';   // artık ayarlardan yönetiliyor
    ui();
  }
  function ui() {
    var card = document.getElementById('acctCard'); if (!card) return;
    var n = Object.keys(meta.dirty).length, sd, st, yd, yt, note = '', noteErr = false, btns = '';
    var B = function (a, t, pri) { return '<button type="button" class="settings-outline-btn" data-acct="' + a + '">' + t + '</button>'; };
    if (authState === 'in') { sd = 'ok'; st = 'Açık'; }
    else if (authState === 'expired') { sd = 'err'; st = 'Düştü'; }
    else { sd = 'off'; st = authState === 'unknown' ? 'Kontrol…' : 'Kapalı'; }
    if (authState === 'expired') { yd = 'err'; yt = 'Yedeklenmiyor' + (n ? ' · ' + n + ' bekliyor' : ''); note = 'Oturum düştü ama bu cihaz hâlâ bağlı görünüyor; değişiklikler yedeklenmiyor. Yeniden giriş yap.'; noteErr = true; }
    else if (authState !== 'in') { yd = 'off'; yt = 'Kapalı'; }
    else if (busy || syncState === 'busy') { yd = 'busy'; yt = 'Yedekleniyor…'; }
    else if (syncState === 'err') { yd = 'err'; yt = 'Yedeklenemedi'; note = 'Bağlantı gelince otomatik tekrar denenecek.'; noteErr = true; }
    else if (n) { yd = 'busy'; yt = n + ' değişiklik bekliyor'; }
    else { yd = 'ok'; yt = 'Yedeklendi' + (lastOk ? ' · ' + new Date(lastOk).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''); }
    var head;
    if (authState === 'in' || authState === 'expired') {
      head = '<div class="acct-box acct-click" data-acct="profile" role="button" tabindex="0">' + avatarHTML(46) + '<div class="acct-who"><b>' + esc(dispName()) + '</b><span>' + esc(email || '') + '</span></div>' +
        '<svg class="acct-chev" width="16" height="16" viewBox="0 0 24 24"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
    } else {
      head = '<div class="acct-box"><div class="acct-av acct-av-off"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg></div><div class="acct-who"><b>Giriş yapılmadı</b><span>Verilerini cihazlar arasında eşitlemek için giriş yap</span></div></div>';
    }
    if (authState === 'in') btns = B('sync', 'Şimdi yedekle') + B('out', 'Çıkış yap') + B('adv', 'Gelişmiş');
    else if (authState === 'expired') btns = B('in', 'Yeniden giriş yap');
    else btns = B('in', 'Giriş yap');
    card.innerHTML = head +
      '<div class="acct-tiles"><div class="acct-tile"><span class="acct-dot" data-s="' + sd + '"></span><div><b>Oturum</b><span>' + st + '</span></div></div>' +
      '<div class="acct-tile"><span class="acct-dot" data-s="' + yd + '"></span><div><b>Yedekleme</b><span>' + esc(yt) + '</span></div></div></div>' +
      (note ? '<p class="acct-note' + (noteErr ? ' err' : '') + '">' + note + '</p>' : '') +
      '<div class="acct-actions">' + btns + '</div>';
  }
  mountAccount();

  window.PaceSync = { syncNow: function () { return syncNow(false); } };
})();
