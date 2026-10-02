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
        msg.textContent = 'sürüm 13 · bulutta ' + (q.data ? q.data.length : '?') + ' alan' + (q.error ? ' · HATA: ' + q.error.message : '') +
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


  // ---------- Görünüm: yazı tipi, Ayarlar > Hesabım, Profil, yan panel logosu (sürüm 13) ----------
  var ST = document.createElement('style'); ST.id = 'paceAcctCss';
  var stag = '';
  for (var si = 1; si <= 9; si++) stag += '.pf-first>:nth-child(' + si + '),.ac-first>:nth-child(' + si + '){animation-delay:' + (si * 0.06).toFixed(2) + 's}';
  ST.textContent = `
html *,html *::before,html *::after{font-family:"Baloo 2",sans-serif!important}
@keyframes pfFade{from{opacity:0}to{opacity:1}}
@keyframes pfFadeOut{to{opacity:0}}
@keyframes pfUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes pfPop{0%{transform:scale(.86)}60%{transform:scale(1.04)}100%{transform:scale(1)}}
@keyframes pfCardIn{from{opacity:0;transform:translateY(34px) scale(.95)}to{opacity:1;transform:none}}
@keyframes pfCardOut{to{opacity:0;transform:translateY(22px) scale(.97)}}
@keyframes pfSheetIn{from{transform:translateY(100%)}to{transform:none}}
@keyframes pfSheetOut{to{transform:translateY(100%)}}
@keyframes pfBreathe{0%,100%{opacity:.4}50%{opacity:.75}}
@keyframes acSpin{to{transform:rotate(360deg)}}
@keyframes acPulse{50%{opacity:.45}}
.pf-first>*,.ac-first>*{animation:pfUp .65s cubic-bezier(.22,1,.36,1) both}
${stag}

/* ---- avatar ortak ---- */
.pf-av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background-size:cover;background-position:center;font-weight:700;flex:none;box-sizing:border-box}
.pf-ph{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:rgba(128,128,128,.22);color:var(--theme-text,#121212)}

/* ---- Hesabım kartı ---- */
.ac{color:var(--theme-text,#121212)}
.ac-hero{position:relative;display:flex;align-items:center;gap:15px;padding:18px;border-radius:26px;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--pc) 24%,transparent),color-mix(in srgb,var(--pc) 5%,transparent) 75%),rgba(128,128,128,.07);border:1px solid color-mix(in srgb,var(--pc) 32%,rgba(128,128,128,.18))}
.ac-hero::before{content:"";position:absolute;width:190px;height:190px;right:-60px;top:-80px;border-radius:50%;background:var(--pc);opacity:.2;filter:blur(44px);pointer-events:none}
.ac-av{position:relative;flex:none;width:68px;height:68px;padding:0;border:0;border-radius:50%;background:none;cursor:zoom-in;transition:transform .4s cubic-bezier(.34,1.56,.64,1)}
.ac-av.off{cursor:default}.ac-av:not(.off):hover{transform:scale(1.06)}.ac-av:not(.off):active{transform:scale(.94)}
.ac-av .pf-av{box-shadow:0 0 0 3px var(--theme-bg,#fff),0 0 0 5px color-mix(in srgb,var(--pc) 65%,transparent),0 8px 20px rgba(0,0,0,.25)}
.ac-st{position:absolute;right:-1px;bottom:-1px;width:18px;height:18px;border-radius:50%;border:3px solid var(--theme-bg,#fff);background:var(--sc,#8a8a8a)}
.ac-st[data-s=busy]{animation:acPulse 1.1s ease-in-out infinite}
.ac-who{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left;border:0;background:none;color:inherit;padding:4px 0;cursor:pointer}
.ac-who.static{cursor:default}
.ac-who b{font-size:20px;font-weight:700;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-who span{font-size:13px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-edit{position:relative;flex:none;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;border:1px solid rgba(128,128,128,.32);background:rgba(128,128,128,.12);color:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:transform .25s,background .25s}
.ac-edit:active{transform:scale(.95)}
.ac-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.ac-tile{--sc:#8a8a8a;display:flex;align-items:center;gap:11px;padding:12px;min-width:0;border-radius:20px;background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.16)}
.ac-tile[data-s=ok]{--sc:#2ecc71}.ac-tile[data-s=busy]{--sc:#f5b301}.ac-tile[data-s=err]{--sc:#e74c3c}
.ac-ic{width:40px;height:40px;border-radius:13px;flex:none;display:grid;place-items:center;background:color-mix(in srgb,var(--sc) 18%,transparent);color:var(--sc)}
.ac-tile[data-s=busy] .ac-ic{animation:acPulse 1.1s ease-in-out infinite}
.ac-tile div{display:flex;flex-direction:column;min-width:0}.ac-tile b{font-size:14.5px;line-height:1.2}.ac-tile span{font-size:12.5px;opacity:.7;line-height:1.25}
.ac-note{margin:12px 2px 0;font-size:13px;line-height:1.4;opacity:.8}.ac-note.err{color:#e5484d;opacity:1}
.ac-perks{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:9px}
.ac-perks li{display:flex;align-items:center;gap:10px;font-size:14px;opacity:.85}
.ac-perks svg{flex:none;color:#2ecc71}
.ac-actions{display:flex;gap:10px;margin-top:14px}
.ac-btn,.pf-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:13px 18px;border-radius:999px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.08);color:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:transform .25s cubic-bezier(.34,1.56,.64,1),background .25s,opacity .25s}
.ac-btn:active,.pf-btn:active{transform:scale(.96)}.ac-btn:disabled{opacity:.55;cursor:default}
.ac-btn.sec{flex:1}.ac-btn.pri,.pf-btn.pri{background:var(--theme-text,#121212);color:var(--theme-bg,#fff);border-color:transparent}
.ac-btn.pri{flex:1}.ac-btn.dng{color:#e5484d}
.ac-actions.col{flex-wrap:wrap}.ac-actions.col .pri{flex:1 1 100%}
.ac-spin{animation:acSpin 1s linear infinite}

/* ---- Yan panel logosu (yalnızca büyük ekran) ---- */
.pf-side{display:none}
@media (min-width:768px) and (min-height:600px){
.pf-side{display:block;position:absolute;top:calc(24px + env(safe-area-inset-top,0px));left:50%;margin-left:-24px;width:48px;height:48px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;z-index:2;-webkit-tap-highlight-color:transparent;transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .3s}
.pf-side:hover{transform:scale(1.09)}.pf-side:active{transform:scale(.93)}
.pf-side .pf-av{box-shadow:0 0 0 2px var(--theme-bg,#fff),0 0 0 3.5px color-mix(in srgb,var(--theme-text,#111) 30%,transparent),0 6px 16px rgba(0,0,0,.22)}
body.is-qhavuz-test-open .pf-side{opacity:.35;pointer-events:none}}

/* ---- Büyük profil resmi ---- */
#pfView{position:fixed;inset:0;z-index:2147483010;display:flex;align-items:center;justify-content:center;cursor:zoom-out}
.pv-bg{position:absolute;inset:0;background:rgba(0,0,0,.74);-webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);animation:pfFade .45s ease both}
.pv-stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;max-width:100%}
.pv-av{will-change:transform}
.pv-av .pf-av{box-shadow:0 0 0 4px rgba(255,255,255,.92),0 0 0 11px rgba(255,255,255,.12),0 34px 90px rgba(0,0,0,.6)}
.pv-meta{text-align:center;color:#fff;animation:pfUp .65s .2s cubic-bezier(.22,1,.36,1) both}
.pv-meta b{display:block;font-size:27px;font-weight:700}.pv-meta span{display:block;opacity:.7;font-size:14px;margin-top:2px}
.pv-edit{margin-top:18px;padding:12px 24px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.13);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.pv-x{position:absolute;top:calc(env(safe-area-inset-top,0px) + 16px);right:16px;width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:17px;cursor:pointer;animation:pfFade .5s .15s both}
#pfView.out .pv-bg{animation:pfFadeOut .32s ease both}
#pfView.out .pv-meta,#pfView.out .pv-x{animation:pfFadeOut .2s both}

/* ---- Profil düzenleme ---- */
.pf-ov{position:fixed;inset:0;z-index:2147483003;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);animation:pfFade .4s ease both}
.pf-ov.pf-out{animation:pfFadeOut .3s ease both;pointer-events:none}
.pf-card{--pc:#3e63dd;position:relative;width:100%;max-width:460px;max-height:92vh;max-height:92dvh;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;padding:18px 22px 24px;border-radius:32px;background:var(--theme-bg,#0b0b0b);color:var(--theme-text,#121212);border:1px solid rgba(128,128,128,.25);box-shadow:0 30px 80px rgba(0,0,0,.5);animation:pfCardIn .7s cubic-bezier(.22,1,.36,1) both}
.pf-ov.pf-out .pf-card{animation:pfCardOut .3s cubic-bezier(.5,0,.75,0) both}
.pf-card::before{content:"";position:absolute;left:50%;top:-90px;width:340px;height:260px;margin-left:-170px;background:var(--pc);opacity:.22;filter:blur(70px);pointer-events:none;transition:background .6s ease}
.pf-card>*{position:relative}
@media(max-width:600px){.pf-ov{padding:0;align-items:flex-end}.pf-card{max-width:none;max-height:94vh;max-height:94dvh;border-radius:32px 32px 0 0;border-bottom:0;padding:18px 20px calc(env(safe-area-inset-bottom,0px) + 22px);animation:pfSheetIn .6s cubic-bezier(.22,1,.36,1) both}.pf-ov.pf-out .pf-card{animation:pfSheetOut .32s cubic-bezier(.5,0,.75,0) both}}
.pf-top{display:grid;grid-template-columns:40px 1fr 40px;align-items:center;text-align:center;font-size:19px;font-weight:700}
.pf-x{width:38px;height:38px;border-radius:50%;border:0;background:rgba(128,128,128,.18);color:inherit;font-size:15px;cursor:pointer;transition:transform .25s,background .25s}.pf-x:active{transform:scale(.9)}
.pf-hero{position:relative;width:128px;height:128px;margin:18px auto 26px}
.pf-ring{position:absolute;inset:-10px;border-radius:50%;background:conic-gradient(from 0deg,var(--pc),transparent 38%,color-mix(in srgb,var(--pc) 50%,#fff) 68%,var(--pc));filter:blur(13px);animation:pfBreathe 5s ease-in-out infinite}
.pf-hav{position:relative;display:block;width:128px;height:128px;padding:0;border:0;border-radius:50%;background:none;cursor:zoom-in;transition:transform .45s cubic-bezier(.34,1.56,.64,1)}
.pf-hav:active{transform:scale(.96)}
.pf-hav .pf-av{box-shadow:0 0 0 4px var(--theme-bg,#000),0 0 0 6px color-mix(in srgb,var(--pc) 70%,transparent),0 14px 34px rgba(0,0,0,.3)}
.pf-pop .pf-hav{animation:pfPop .6s cubic-bezier(.34,1.56,.64,1)}
.pf-badge{position:absolute;right:-3px;bottom:-3px;width:42px;height:42px;padding:0;border-radius:50%;border:3px solid var(--theme-bg,#000);background:var(--theme-text,#fff);color:var(--theme-bg,#000);display:grid;place-items:center;cursor:pointer;transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.pf-badge:hover{transform:scale(1.1)}.pf-badge:active{transform:scale(.9)}
.pf-seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:999px;background:rgba(128,128,128,.16);margin-bottom:18px}
.pf-seg i{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:999px;background:var(--theme-text,#121212);transform:translateX(calc(var(--pos,0) * 100%));transition:transform .5s cubic-bezier(.34,1.25,.64,1)}
.pf-seg button{position:relative;z-index:1;padding:11px 0;border:0;background:transparent;color:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:color .3s ease}
.pf-seg button.on{color:var(--theme-bg,#fff)}
#pfDyn>*{animation:pfUp .5s cubic-bezier(.22,1,.36,1) both}
.pf-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}.pf-tiles.one{grid-template-columns:1fr}
.pf-tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:18px 8px;border-radius:22px;border:1px solid rgba(128,128,128,.24);background:rgba(128,128,128,.08);color:inherit;font-size:14.5px;font-weight:600;cursor:pointer;transition:transform .3s cubic-bezier(.34,1.56,.64,1),background .25s}
.pf-tile:hover{background:rgba(128,128,128,.14)}.pf-tile:active{transform:scale(.95)}
.pf-rm{display:block;margin:12px auto 0;padding:6px 12px;border:0;background:none;color:#e5484d;font-size:14px;font-weight:600;cursor:pointer}
.pf-lbl{font-size:13px;opacity:.65;margin:16px 0 8px}#pfDyn .pf-lbl:first-child{margin-top:2px}
.pf-sws{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}
.pf-sw{aspect-ratio:1;border-radius:50%;border:0;padding:0;position:relative;cursor:pointer;transition:transform .3s cubic-bezier(.34,1.56,.64,1),box-shadow .25s}
.pf-sw:hover{transform:scale(1.1)}.pf-sw:active{transform:scale(.92)}
.pf-sw.on{box-shadow:0 0 0 3px var(--theme-bg,#000),0 0 0 5px var(--theme-text,#fff);transform:scale(1.06)}
.pf-custom{background:conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);overflow:hidden}.pf-custom input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}
.pf-in{width:100%;box-sizing:border-box;padding:13px 15px;font-size:16px;border-radius:16px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;transition:border-color .25s,box-shadow .25s}
.pf-in:focus{outline:0;border-color:var(--pc);box-shadow:0 0 0 4px color-mix(in srgb,var(--pc) 22%,transparent)}
.pf-mail{margin:8px 2px 0;font-size:12.5px;opacity:.55}
.pf-actions{display:flex;gap:10px;margin-top:24px}.pf-actions .pf-btn{flex:1}.pf-actions .pri{flex:1.6}
.pf-hint{margin:6px 0 14px;font-size:13px;opacity:.65;text-align:center}
.pf-crop{position:relative;margin:0 auto;overflow:hidden;border-radius:20px;background:#000;touch-action:none;cursor:grab}
.pf-crop img{position:absolute;max-width:none!important;max-height:none!important;transform-origin:center;user-select:none;-webkit-user-drag:none;pointer-events:none}
.pf-mask{position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 999px rgba(0,0,0,.62);border:2px solid rgba(255,255,255,.9);pointer-events:none}
.pf-zoom{width:100%;margin:18px 0 0;accent-color:var(--theme-text,#121212)}
.pf-end{justify-content:flex-end}
@media (prefers-reduced-motion:reduce){.pf-ov *,.pf-ov,.pv-bg,.pv-meta,.pv-x,.ac *,.pf-side{animation:none!important;transition:none!important}}
`;
  document.head.appendChild(ST);

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var IC = {
    img: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
    cam: '<path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13" r="3.6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2.2 2.2L15 10.5"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0117.8 8.6 4.7 4.7 0 0117 18z"/>',
    sync: '<path d="M4 12a8 8 0 0113.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 01-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
    adv: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    out: '<path d="M9 4H6a2 2 0 00-2 2v12a2 2 0 002 2h3"/><path d="M16 8l4 4-4 4M20 12H9"/>',
    pen: '<path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z"/>',
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>'
  };
  function ic(d, s, cls) { s = s || 20; return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }

  // ---------- Profil verisi (fotoğraf / harf logosu / rumuz) ----------
  var PALETTE = ['#E5484D', '#F76B15', '#F5B301', '#30A46C', '#12A594', '#0091FF', '#3E63DD', '#8E4EC6', '#D6409F', '#6E6E73', '#A18072', '#1F2937'];
  var draft = null, cropSt = null, onKey = null;
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
  function signedIn() { return authState === 'in' || authState === 'expired'; }

  // ---------- Büyük profil resmi (tıklanan yerden büyüyerek açılır) ----------
  function openViewer(src, p) {
    if (document.getElementById('pfView')) return;
    p = p || prof();
    var L = Math.round(Math.min(innerWidth * 0.8, innerHeight * 0.5, 420));
    var canEdit = signedIn() && !document.getElementById('profOv');
    var ov = document.createElement('div'); ov.id = 'pfView'; ov._src = src;
    ov.innerHTML = '<div class="pv-bg"></div><button type="button" class="pv-x" data-pv="x" aria-label="Kapat">✕</button>' +
      '<div class="pv-stage"><div class="pv-av" id="pvAv">' + avatarHTML(L, p) + '</div><div class="pv-meta"><b>' + esc(dispName(p)) + '</b><span>' + esc(email || '') + '</span>' +
      (canEdit ? '<button type="button" class="pv-edit" data-pv="edit">Profili düzenle</button>' : '') + '</div></div>';
    document.body.appendChild(ov);
    var av = document.getElementById('pvAv');
    var ease = 'cubic-bezier(.22,1,.36,1)';
    if (av.animate) {
      var from = src && src.getBoundingClientRect ? src.getBoundingClientRect() : null, to = av.getBoundingClientRect();
      if (from && from.width) av.animate([{ transform: 'translate(' + (from.left + from.width / 2 - to.left - to.width / 2) + 'px,' + (from.top + from.height / 2 - to.top - to.height / 2) + 'px) scale(' + (from.width / to.width) + ')' }, { transform: 'none' }], { duration: 600, easing: ease });
      else av.animate([{ opacity: 0, transform: 'scale(.88)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: ease });
    }
    ov.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-pv=edit]')) { closeViewer(); setTimeout(openProfile, 260); } else closeViewer();
    });
  }
  function closeViewer() {
    var ov = document.getElementById('pfView'); if (!ov || ov.classList.contains('out')) return;
    ov.classList.add('out');
    var av = document.getElementById('pvAv'), src = ov._src;
    if (av && av.animate) {
      var to = av.getBoundingClientRect(), from = src && src.isConnected && src.getBoundingClientRect ? src.getBoundingClientRect() : null;
      if (from && from.width) av.animate([{ transform: 'none' }, { transform: 'translate(' + (from.left + from.width / 2 - to.left - to.width / 2) + 'px,' + (from.top + from.height / 2 - to.top - to.height / 2) + 'px) scale(' + (from.width / to.width) + ')' }], { duration: 380, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' });
      else av.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.92)' }], { duration: 300, fill: 'forwards' });
    }
    setTimeout(function () { ov.remove(); }, 380);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('pfView')) closeViewer(); else if (document.getElementById('profOv')) closeProfile();
  });

  // ---------- Profil düzenleme sayfası ----------
  function enter(c) { c.classList.add('pf-first'); clearTimeout(c._t); c._t = setTimeout(function () { c.classList.remove('pf-first'); }, 1100); }
  function openProfile() {
    if (document.getElementById('profOv')) return;
    draft = Object.assign({ mode: 'letter' }, prof()); draft.name = dispName(draft); draft.color = pickColor(draft);
    var ov = document.createElement('div'); ov.id = 'profOv'; ov.className = 'pf-ov'; ov.innerHTML = '<div class="pf-card" id="profCard"></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', onProfClick);
    ov.addEventListener('change', function (e) {
      if (!draft) return;
      if ((e.target.id === 'pfFile' || e.target.id === 'pfCam') && e.target.files && e.target.files[0]) { openCrop(e.target.files[0]); e.target.value = ''; }
      if (e.target.getAttribute('data-pf') === 'custom') setColor(e.target.value);
    });
    ov.addEventListener('input', function (e) {
      if (!draft) return;
      if (e.target.getAttribute('data-pf') === 'custom') setColor(e.target.value);
      if (e.target.id === 'pfName') { draft.name = e.target.value; if (draft.mode !== 'photo' || !draft.photo) { var hv = ov.querySelector('.pf-hav'); if (hv) hv.innerHTML = avatarHTML(128, draft); } }
    });
    renderProfile();
  }
  function closeProfile() {
    var o = document.getElementById('profOv');
    if (cropSt) { try { URL.revokeObjectURL(cropSt.url); } catch (e) {} }
    draft = null; cropSt = null;
    if (!o) return;
    o.id = 'profOutgoing'; o.classList.add('pf-out'); setTimeout(function () { o.remove(); }, 320);
  }
  function keepName() { var ni = document.getElementById('pfName'); if (ni && draft) draft.name = ni.value; }
  function setColor(col) {
    var c = document.getElementById('profCard'); if (!c || !draft) return;
    draft.color = col; draft.mode = 'letter'; c.style.setProperty('--pc', col);
    var hv = c.querySelector('.pf-hav'); if (hv) hv.innerHTML = avatarHTML(128, draft);
    var hit = false;
    c.querySelectorAll('.pf-sw[data-v]').forEach(function (s) { var on = s.getAttribute('data-v').toLowerCase() === String(col).toLowerCase(); if (on) hit = true; s.classList.toggle('on', on); });
    var cu = c.querySelector('.pf-custom'); if (cu) cu.classList.toggle('on', !hit);
  }
  function heroHTML() {
    return '<div class="pf-ring"></div><button type="button" class="pf-hav" data-pf="view" aria-label="Profil resmini büyüt">' + avatarHTML(128, draft) + '</button>' +
      '<button type="button" class="pf-badge" data-pf="pick" aria-label="Galeriden fotoğraf seç">' + ic(IC.img, 20) + '</button>';
  }
  function dynHTML() {
    if (draft.mode === 'photo') {
      var touch = window.matchMedia && matchMedia('(pointer:coarse)').matches;
      return '<div class="pf-tiles' + (touch ? '' : ' one') + '"><button type="button" class="pf-tile" data-pf="pick">' + ic(IC.img, 26) + '<span>Galeriden seç</span></button>' +
        (touch ? '<button type="button" class="pf-tile" data-pf="cam">' + ic(IC.cam, 26) + '<span>Fotoğraf çek</span></button>' : '') + '</div>' +
        (draft.photo ? '<button type="button" class="pf-rm" data-pf="rm">Fotoğrafı kaldır</button>' : '');
    }
    var cur = String(draft.color).toLowerCase(), inPal = false;
    var sw = PALETTE.map(function (col) {
      var on = col.toLowerCase() === cur; if (on) inPal = true;
      return '<button type="button" class="pf-sw' + (on ? ' on' : '') + '" data-pf="color" data-v="' + col + '" style="background:' + col + '" aria-label="Renk ' + col + '"></button>';
    }).join('');
    var custom = '<label class="pf-sw pf-custom' + (!inPal ? ' on' : '') + '" aria-label="Özel renk"><input type="color" data-pf="custom" value="' + (/^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#3e63dd') + '"></label>';
    return '<div class="pf-lbl">Logo rengi</div><div class="pf-sws">' + sw + custom + '</div>';
  }
  function renderProfile() {
    var c = document.getElementById('profCard'); if (!c || !draft) return;
    cropSt = null; c.style.setProperty('--pc', draft.color);
    var photo = draft.mode === 'photo', dyn = document.getElementById('pfDyn');
    if (dyn) {   // kısmi güncelleme: yazı kutusu ve düğmeler yerinde kalır, yalnızca değişen kısım yumuşakça yenilenir
      var h = document.getElementById('pfHero'); h.innerHTML = heroHTML(); h.classList.remove('pf-pop'); void h.offsetWidth; h.classList.add('pf-pop');
      c.querySelectorAll('.pf-seg button').forEach(function (b) { b.classList.toggle('on', (b.getAttribute('data-v') === 'photo') === photo); });
      c.querySelector('.pf-seg').style.setProperty('--pos', photo ? 0 : 1);
      dyn.innerHTML = dynHTML(); return;
    }
    enter(c);
    c.innerHTML = '<div class="pf-top"><button type="button" class="pf-x" data-pf="close" aria-label="Kapat">✕</button><b>Profil</b><span></span></div>' +
      '<div class="pf-hero" id="pfHero">' + heroHTML() + '</div>' +
      '<div class="pf-seg" style="--pos:' + (photo ? 0 : 1) + '"><i></i><button type="button" data-pf="mode" data-v="photo" class="' + (photo ? 'on' : '') + '">Fotoğraf</button><button type="button" data-pf="mode" data-v="letter" class="' + (!photo ? 'on' : '') + '">Harf logosu</button></div>' +
      '<div id="pfDyn">' + dynHTML() + '</div>' +
      '<div><div class="pf-lbl">Rumuz</div><input class="pf-in" id="pfName" maxlength="24" autocomplete="off" value="' + esc(draft.name) + '" placeholder="Rumuzun"><div class="pf-mail">' + esc(email || '') + '</div></div>' +
      '<div class="pf-actions"><button type="button" class="pf-btn" data-pf="close">Vazgeç</button><button type="button" class="pf-btn pri" data-pf="save">Kaydet</button></div>' +
      '<input type="file" id="pfFile" accept="image/*" hidden><input type="file" id="pfCam" accept="image/*" capture="user" hidden>';
  }
  function onProfClick(e) {
    var b = e.target.closest && e.target.closest('[data-pf]'); if (!b || !draft) return;
    var a = b.getAttribute('data-pf'), v = b.getAttribute('data-v');
    if (a === 'close') return closeProfile();
    if (a === 'view') { keepName(); return openViewer(b, draft); }
    if (a === 'mode') { if (draft.mode === v) return; draft.mode = v; return renderProfile(); }
    if (a === 'color') return setColor(v);
    if (a === 'pick') return document.getElementById('pfFile').click();
    if (a === 'cam') return document.getElementById('pfCam').click();
    if (a === 'rm') { draft.photo = ''; return renderProfile(); }
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
    enter(c);
    var S = Math.max(200, Math.min(340, (c.clientWidth || 340) - 48));
    c.innerHTML = '<div class="pf-top"><button type="button" class="pf-x" data-pf="cropx" aria-label="Vazgeç">✕</button><b>Fotoğrafı ayarla</b><span></span></div>' +
      '<p class="pf-hint">Sürükle ve yakınlaştır. Dairenin içi profilinde görünecek alan.</p>' +
      '<div class="pf-crop" id="pfCrop" style="width:' + S + 'px;height:' + S + 'px"><img id="pfImg" alt=""><div class="pf-mask"></div></div>' +
      '<input type="range" id="pfZoom" class="pf-zoom" min="100" max="300" value="100" aria-label="Yakınlaştır">' +
      '<div class="pf-actions pf-end"><button type="button" class="pf-btn" data-pf="cropx">Vazgeç</button><button type="button" class="pf-btn pri" data-pf="cropok">Uygula</button></div>';
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
    var OUT = 512, eff = st.cover * st.z, il = (st.S - st.nw * eff) / 2 + st.px, it = (st.S - st.nh * eff) / 2 + st.py;
    var cv = document.createElement('canvas'); cv.width = cv.height = OUT;
    var cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(st.img, -il / eff, -it / eff, st.S / eff, st.S / eff, 0, 0, OUT, OUT);
    draft.photo = cv.toDataURL('image/jpeg', 0.88); draft.mode = 'photo';
    try { URL.revokeObjectURL(st.url); } catch (x) {}
    renderProfile();
  }

  // ---------- Ayarlar > Hesabım ----------
  function mountAccount() {
    if (document.getElementById('acctSection')) return;
    var host = document.querySelector('#page-settings .settings-col-left') || document.querySelector('#page-settings .settings-page');
    if (!host) return;
    var sec = document.createElement('div'); sec.className = 'settings-section'; sec.id = 'acctSection';
    sec.innerHTML = '<span class="settings-section-label">Hesabım</span><div class="settings-card"><div id="acctCard" class="ac"></div></div>';
    host.insertBefore(sec, host.firstChild);
    sec.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-acct]'); if (!b || b.disabled) return;
      var a = b.getAttribute('data-acct');
      if (a === 'view') { if (signedIn()) openViewer(b); }
      else if (a === 'profile') { if (signedIn()) openProfile(); else openModal(); }
      else if (a === 'sync') syncNow(false); else if (a === 'out') doSignOut(); else openModal();
    });
    var fb = document.getElementById('paceSyncBtn'); if (fb) fb.style.display = 'none';   // artık ayarlardan yönetiliyor
    ui();
  }
  // ---------- Yan panelin en üstündeki profil logosu ----------
  function mountSide() {
    var nav = document.getElementById('sidebarNav'); if (!nav || document.getElementById('pfSide')) return;
    var b = document.createElement('button'); b.type = 'button'; b.id = 'pfSide'; b.className = 'pf-side';
    nav.insertBefore(b, nav.firstChild);
    b.addEventListener('click', function () { if (signedIn()) openViewer(b); else openModal(); });
    refreshSide();
  }
  function refreshSide() {
    var b = document.getElementById('pfSide'); if (!b) return;
    var h = signedIn() ? avatarHTML(48) : '<span class="pf-ph">' + ic(IC.user, 22) + '</span>';
    b.setAttribute('aria-label', signedIn() ? 'Profil resmini büyüt' : 'Giriş yap');
    if (b._h !== h) { b.innerHTML = h; b._h = h; }
  }
  function ui() {
    refreshSide();
    var card = document.getElementById('acctCard'); if (!card) return;
    var n = Object.keys(meta.dirty).length, sd, st, yd, yt, note = '', noteErr = false;
    if (authState === 'in') { sd = 'ok'; st = 'Açık'; }
    else if (authState === 'expired') { sd = 'err'; st = 'Düştü'; }
    else { sd = 'off'; st = authState === 'unknown' ? 'Kontrol…' : 'Kapalı'; }
    if (authState === 'expired') { yd = 'err'; yt = 'Yedeklenmiyor' + (n ? ' · ' + n + ' bekliyor' : ''); note = 'Oturum düştü ama bu cihaz hâlâ bağlı görünüyor; değişiklikler yedeklenmiyor. Yeniden giriş yap.'; noteErr = true; }
    else if (authState !== 'in') { yd = 'off'; yt = 'Kapalı'; }
    else if (busy || syncState === 'busy') { yd = 'busy'; yt = 'Yedekleniyor…'; }
    else if (syncState === 'err') { yd = 'err'; yt = 'Yedeklenemedi'; note = 'Bağlantı gelince otomatik tekrar denenecek.'; noteErr = true; }
    else if (n) { yd = 'busy'; yt = n + ' değişiklik bekliyor'; }
    else { yd = 'ok'; yt = 'Yedeklendi' + (lastOk ? ' · ' + new Date(lastOk).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : ''); }
    var SC = { ok: '#2ecc71', busy: '#f5b301', err: '#e74c3c', off: '#8a8a8a' };
    var html;
    if (signedIn()) {
      var pc = pickColor(prof()), syncing = yd === 'busy' && authState === 'in';
      html = '<div class="ac-hero" style="--pc:' + pc + '"><button type="button" class="ac-av" data-acct="view" aria-label="Profil resmini büyüt" style="--sc:' + SC[sd] + '">' + avatarHTML(68) + '<span class="ac-st" data-s="' + sd + '"></span></button>' +
        '<button type="button" class="ac-who" data-acct="profile"><b>' + esc(dispName()) + '</b><span>' + esc(email || '') + '</span></button>' +
        '<button type="button" class="ac-edit" data-acct="profile">' + ic(IC.pen, 15) + 'Düzenle</button></div>' +
        '<div class="ac-grid"><div class="ac-tile" data-s="' + sd + '"><span class="ac-ic">' + ic(IC.shield, 20) + '</span><div><b>Oturum</b><span>' + st + '</span></div></div>' +
        '<div class="ac-tile" data-s="' + yd + '"><span class="ac-ic">' + ic(IC.cloud, 20) + '</span><div><b>Yedekleme</b><span>' + esc(yt) + '</span></div></div></div>' +
        (note ? '<p class="ac-note' + (noteErr ? ' err' : '') + '">' + note + '</p>' : '') +
        (authState === 'in'
          ? '<div class="ac-actions col"><button type="button" class="ac-btn pri" data-acct="sync"' + (syncing ? ' disabled' : '') + '>' + ic(IC.sync, 18, syncing ? 'ac-spin' : '') + (syncing ? 'Yedekleniyor…' : 'Şimdi yedekle') + '</button>' +
            '<button type="button" class="ac-btn sec" data-acct="adv">' + ic(IC.adv, 18) + 'Gelişmiş</button><button type="button" class="ac-btn sec dng" data-acct="out">' + ic(IC.out, 18) + 'Çıkış yap</button></div>'
          : '<div class="ac-actions"><button type="button" class="ac-btn pri" data-acct="in">Yeniden giriş yap</button></div>');
    } else {
      var unk = authState === 'unknown';
      html = '<div class="ac-hero" style="--pc:#8a8a8a"><div class="ac-av off"><span class="pf-ph">' + ic(IC.user, 28) + '</span></div><div class="ac-who static"><b>' + (unk ? 'Hesap kontrol ediliyor…' : 'Giriş yapılmadı') + '</b><span>' + (unk ? 'Bir saniye' : 'Verilerini tüm cihazlarında güvende tut') + '</span></div></div>' +
        (unk ? '' : '<ul class="ac-perks"><li>' + ic(IC.ok, 16) + 'Cihazlar arasında otomatik eşitleme</li><li>' + ic(IC.ok, 16) + 'Fotoğraflar ve ayarlar dahil yedekleme</li><li>' + ic(IC.ok, 16) + 'Cihaz değiştirsen bile her şey seninle</li></ul>' +
          '<div class="ac-actions"><button type="button" class="ac-btn pri" data-acct="in">Giriş yap</button></div>');
    }
    var first = !card.getAttribute('data-d') && authState !== 'unknown';
    if (first) { card.setAttribute('data-d', '1'); card.classList.add('ac-first'); clearTimeout(card._t); card._t = setTimeout(function () { card.classList.remove('ac-first'); }, 1100); }
    card.innerHTML = html;
  }
  mountAccount();
  mountSide();

  window.PaceSync = { syncNow: function () { return syncNow(false); } };
})();
