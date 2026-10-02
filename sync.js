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
  // E-postadaki şifre sıfırlama bağlantısıyla mı açıldık? (Supabase adres çubuğundaki #...type=recovery'yi okur)
  var recMode = /type=recovery/.test(location.hash), holdSync = false, recKnown = false, linkErr = /error_code=|error=access_denied/.test(location.hash), emailLink = /type=email_change/.test(location.hash), pendingEmail = '';

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
  recKnown = !!meta.uid;   // bu tarayıcı daha önce bir hesaba bağlı mıydı?
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
    if (m.indexOf('different from the old') > -1 || m.indexOf('same_password') > -1) return 'Yeni şifre eskisiyle aynı olamaz.';
    if (m.indexOf('only request this after') > -1 || m.indexOf('security purposes') > -1) return 'Güvenlik için biraz bekleyip tekrar dene.';
    if (m.indexOf('weak') > -1 || m.indexOf('pwned') > -1) return 'Bu şifre kolay tahmin edilebilir. Başka bir şifre dene.';
    if (m.indexOf('session') > -1 && m.indexOf('missing') > -1) return 'Oturum bulunamadı. Yeniden giriş yap.';
    if (m.indexOf('already been registered') > -1 || m.indexOf('email_exists') > -1) return 'Bu e-posta başka bir hesapta kayıtlı.';
    if ((m.indexOf('email address') > -1 && m.indexOf('invalid') > -1) || m.indexOf('email_address_invalid') > -1) return 'Geçerli bir e-posta adresi gir.';
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

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && pendingEmail && uid) sb.auth.refreshSession().catch(function () {});   // başka sekmede/cihazda onaylandıysa yeni adres gelsin
  });
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
    setStatus('Bağlandı'); closeModal(); finishAuth();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('pace-sync-' + id).on('postgres_changes',
      { event: '*', schema: 'public', table: 'sync_records', filter: 'user_id=eq.' + id },
      function (p) { if (p.new && p.new.device_id === getOrCreateDeviceId()) return; schedule(600); }).subscribe();
    if (recMode) holdSync = true; else syncNow(true);   // sıfırlama ekranı açıkken sayfa yenilenmesin
  }
  sb.auth.onAuthStateChange(function (ev, session) {
    if (session) {
      var prevMail = email; email = session.user.email || email; pendingEmail = session.user.new_email || '';
      if (prevMail && prevMail !== email) pcToast('E-posta adresin güncellendi.');
      else if (emailLink && ev !== 'INITIAL_SESSION') { pcToast('E-posta adresin güncellendi.'); }
      if (emailLink && ev !== 'INITIAL_SESSION') { emailLink = false; try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
      ui();
    }
    if (ev === 'PASSWORD_RECOVERY') setTimeout(openRecovery, 0);
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
  function openModal() { if (!uid) return openAuth(); modalOpen = true; var ov = document.createElement('div'); ov.id = 'paceSyncOv'; ov.innerHTML = '<div id="paceSyncCard"></div>'; document.body.appendChild(ov);
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
        msg.textContent = 'sürüm ' + APP_VER + ' · bulutta ' + (q.data ? q.data.length : '?') + ' alan' + (q.error ? ' · HATA: ' + q.error.message : '') +
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


  // ---------- Görünüm: yazı tipi, Ayarlar > Hesabım, Profil, yan panel logosu (sürüm 15) ----------
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
.ac-hero::before{content:"";position:absolute;width:190px;height:190px;right:-60px;top:-80px;border-radius:50%;background:var(--pc);opacity:.2;filter:blur(44px);pointer-events:none}
.ac-av{position:relative;flex:none;width:68px;height:68px;padding:0;border:0;border-radius:50%;background:none;cursor:zoom-in;transition:transform .4s cubic-bezier(.34,1.56,.64,1)}
.ac-av.off{cursor:default}.ac-av:not(.off):hover{transform:scale(1.06)}.ac-av:not(.off):active{transform:scale(.94)}
.ac-av .pf-av{box-shadow:0 0 0 3px var(--theme-bg,#fff),0 0 0 5px color-mix(in srgb,var(--pc) 65%,transparent),0 8px 20px rgba(0,0,0,.25)}
.ac-st{position:absolute;right:-1px;bottom:-1px;width:18px;height:18px;border-radius:50%;border:3px solid var(--theme-bg,#fff);background:var(--sc,#8a8a8a)}
.ac-who b{font-size:20px;font-weight:700;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-who span{font-size:13px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-hero{position:relative;display:flex;align-items:center;gap:15px;padding:18px 46px 18px 18px;border-radius:26px;overflow:hidden;cursor:pointer;background:linear-gradient(135deg,color-mix(in srgb,var(--pc) 24%,transparent),color-mix(in srgb,var(--pc) 5%,transparent) 75%),rgba(128,128,128,.07);border:1px solid color-mix(in srgb,var(--pc) 32%,rgba(128,128,128,.18));transition:transform .4s cubic-bezier(.34,1.56,.64,1),border-color .3s;-webkit-tap-highlight-color:transparent}
.ac-hero:hover{border-color:color-mix(in srgb,var(--pc) 55%,rgba(128,128,128,.2))}.ac-hero:active{transform:scale(.99)}.ac-hero:focus-visible{outline:2px solid var(--pc);outline-offset:2px}
.ac-hero.static{cursor:default;padding:18px}.ac-hero.static:active{transform:none}
.ac-who{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left}
.ac-top{display:flex;justify-content:flex-end;margin:0 6px 9px;min-height:22px}
.ac-chip{--sc:#8a8a8a;display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;white-space:nowrap}
.ac-chip[data-s=err]{color:#e5484d}
.ac-ci{display:grid;place-items:center;width:20px;height:20px;border-radius:50%}
.ac-ci svg{color:var(--sc);overflow:visible}
@keyframes acUp{0%{transform:translateY(5px);opacity:0}30%,70%{opacity:1}100%{transform:translateY(-4px);opacity:0}}
@keyframes acBob{50%{transform:translateY(-1.5px)}}
@keyframes acShim{from{background-position:200% 0}to{background-position:-100% 0}}
@keyframes acCk{from{stroke-dashoffset:12}to{stroke-dashoffset:0}}
@keyframes acPopI{0%{transform:scale(.6)}55%{transform:scale(1.28)}100%{transform:scale(1)}}
@keyframes acHalo{from{box-shadow:0 0 0 0 rgba(46,204,113,.5)}to{box-shadow:0 0 0 12px rgba(46,204,113,0)}}
.ac-chip .up{opacity:0}.ac-chip .ck{stroke-dasharray:12;stroke-dashoffset:0}
.ac-chip[data-s=busy] .ac-ci svg{animation:acBob 1.4s ease-in-out infinite}
.ac-chip[data-s=busy] .up{animation:acUp 1.1s ease-in-out infinite}
.ac-chip[data-s=busy] .ac-ct{color:transparent;-webkit-background-clip:text;background-clip:text;background-size:250% 100%;background-image:linear-gradient(90deg,var(--theme-text,#fff) 38%,rgba(128,128,128,.4) 50%,var(--theme-text,#fff) 62%);animation:acShim 1.7s linear infinite}
.ac-chip.fresh .ac-ci{animation:acHalo .9s ease-out both;animation-delay:var(--ad,0s)}
.ac-chip.fresh .ac-ci svg{animation:acPopI .6s cubic-bezier(.34,1.56,.64,1) both;animation-delay:var(--ad,0s)}
.ac-chip.fresh .ck{animation:acCk .45s ease both;animation-delay:calc(var(--ad,0s) + .12s)}
.ac-chip.fresh .ac-ct{animation:pfFade .6s ease both;animation-delay:var(--ad,0s)}
.ac-notch{position:absolute;right:15px;top:50%;margin-top:-8px;width:16px;height:16px;display:grid;place-items:center;opacity:.5;transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .25s}
.ac-hero:hover .ac-notch{transform:translateX(3px);opacity:.9}.ac-hero:active .ac-notch{transform:translateX(5px)}
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
.pf-hero{position:relative;width:var(--hs,128px);height:var(--hs,128px);margin:16px auto 24px}
.pf-ring{position:absolute;inset:-10px;border-radius:50%;background:conic-gradient(from 0deg,var(--pc),transparent 38%,color-mix(in srgb,var(--pc) 50%,#fff) 68%,var(--pc));filter:blur(13px);animation:pfBreathe 5s ease-in-out infinite}
.pf-hav{position:relative;display:block;width:var(--hs,128px);height:var(--hs,128px);padding:0;border:0;border-radius:50%;background:none;cursor:zoom-in;transition:transform .45s cubic-bezier(.34,1.56,.64,1)}
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
@media(min-width:601px){.pf-card{--hs:104px;padding:16px 22px 20px}.pf-hero{margin:12px auto 20px}.pf-seg{margin-bottom:14px}.pf-lbl{margin:12px 0 6px}.pf-actions{margin-top:18px}.pf-sws{gap:8px}.pf-tile{padding:14px 8px}}
@media(min-width:601px) and (min-height:680px){.pf-card{overflow:hidden;max-height:none}}
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
  function hs() { return (window.matchMedia && matchMedia('(min-width:601px)').matches) ? 104 : 128; }
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
    ov.addEventListener('pointerdown', function (e) { ov._dn = e.target === ov; });
    ov.addEventListener('click', function (e) { if (e.target === ov && ov._dn) closeProfile(); });
    ov.addEventListener('click', onProfClick);
    ov.addEventListener('submit', function (e) { e.preventDefault(); pwSubmit(); });
    ov.addEventListener('change', function (e) {
      if (!draft) return;
      if ((e.target.id === 'pfFile' || e.target.id === 'pfCam') && e.target.files && e.target.files[0]) { openCrop(e.target.files[0]); e.target.value = ''; }
      if (e.target.getAttribute('data-pf') === 'custom') setColor(e.target.value);
    });
    ov.addEventListener('input', function (e) {
      if (!draft) return;
      pwInput(e);
      if (e.target.getAttribute('data-pf') === 'custom') setColor(e.target.value);
      if (e.target.id === 'pfName') { draft.name = e.target.value; if (draft.mode !== 'photo' || !draft.photo) { var hv = ov.querySelector('.pf-hav'); if (hv) hv.innerHTML = avatarHTML(hs(), draft); } }
    });
    renderProfile();
  }
  function closeProfile() {
    var o = document.getElementById('profOv');
    if (cropSt) { try { URL.revokeObjectURL(cropSt.url); } catch (e) {} }
    draft = null; cropSt = null; pwSt = null;
    if (!o) return;
    o.id = 'profOutgoing'; o.classList.add('pf-out'); setTimeout(function () { o.remove(); }, 320);
  }
  function keepName() { var ni = document.getElementById('pfName'); if (ni && draft) draft.name = ni.value; }
  function setColor(col) {
    var c = document.getElementById('profCard'); if (!c || !draft) return;
    draft.color = col; draft.mode = 'letter'; c.style.setProperty('--pc', col);
    var hv = c.querySelector('.pf-hav'); if (hv) hv.innerHTML = avatarHTML(hs(), draft);
    var hit = false;
    c.querySelectorAll('.pf-sw[data-v]').forEach(function (s) { var on = s.getAttribute('data-v').toLowerCase() === String(col).toLowerCase(); if (on) hit = true; s.classList.toggle('on', on); });
    var cu = c.querySelector('.pf-custom'); if (cu) cu.classList.toggle('on', !hit);
  }
  function heroHTML() {
    return '<div class="pf-ring"></div><button type="button" class="pf-hav" data-pf="view" aria-label="Profil resmini büyüt">' + avatarHTML(hs(), draft) + '</button>' +
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
      (authState === 'in' ? '<button type="button" class="pf-pwrow" data-pf="pw"><span class="pf-pwi">' + ic(IM.lock, 19) + '</span><span class="pf-pwt">Şifreyi değiştir</span><span class="pf-pwc">' + ic(PWI.chev, 16) + '</span></button>' +
        '<button type="button" class="pf-pwrow" data-pf="pwem"><span class="pf-pwi">' + ic(IM.mail, 19) + '</span><span class="pf-pwt">E-postayı değiştir</span><span class="pf-pwc">' + ic(PWI.chev, 16) + '</span></button>' +
        (pendingEmail ? '<div class="pf-pend"><span>Onay bekleniyor: <b>' + esc(pendingEmail) + '</b></span><button type="button" data-pf="pwresend">Tekrar gönder</button></div>' : '') : '') +
      '<div class="pf-actions"><button type="button" class="pf-btn" data-pf="close">Vazgeç</button><button type="button" class="pf-btn pri" data-pf="save">Kaydet</button></div>' +
      '<input type="file" id="pfFile" accept="image/*" hidden><input type="file" id="pfCam" accept="image/*" capture="user" hidden>';
  }
  function onProfClick(e) {
    var b = e.target.closest && e.target.closest('[data-pf]'); if (!b || !draft) return;
    var a = b.getAttribute('data-pf'), v = b.getAttribute('data-v');
    if (a.indexOf('pw') === 0) return pwClick(a, b);
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

  // ---------- Şifre değiştir (Profil içinde, sürüm 16) ----------
  var PWS = document.createElement('style'); PWS.id = 'pacePwCss';
  PWS.textContent = `
.pf-x{display:grid;place-items:center;padding:0;line-height:1}.pf-x svg{display:block}
@keyframes pwIn{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
.pf-pwrow{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;margin-top:12px;padding:11px 14px;border-radius:18px;border:1px solid rgba(128,128,128,.24);background:rgba(128,128,128,.08);color:inherit;font-size:15px;font-weight:600;text-align:left;cursor:pointer;transition:transform .3s cubic-bezier(.34,1.56,.64,1),background .25s,border-color .25s}
.pf-pwrow:hover{background:rgba(128,128,128,.14);border-color:color-mix(in srgb,var(--pc) 45%,rgba(128,128,128,.24))}.pf-pwrow:active{transform:scale(.98)}
.pf-pwi{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:11px;color:var(--pc);background:color-mix(in srgb,var(--pc) 22%,transparent);transition:transform .45s cubic-bezier(.34,1.56,.64,1)}
.pf-pwrow:hover .pf-pwi{transform:rotate(-8deg) scale(1.08)}
.pf-pwt{flex:1}.pf-pwc{display:grid;opacity:.45;transition:transform .4s cubic-bezier(.34,1.56,.64,1)}.pf-pwrow:hover .pf-pwc{transform:translateX(3px)}
.pw-hero{display:grid;place-items:center;margin:14px 0 14px}
.pw-ico{position:relative;width:76px;height:76px;border-radius:26px;display:grid;place-items:center;color:var(--pc);background:color-mix(in srgb,var(--pc) 20%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pc) 35%,transparent),0 12px 30px color-mix(in srgb,var(--pc) 25%,transparent);transition:background .5s,color .5s}
.pw-ico.pop{animation:pfPop .6s cubic-bezier(.34,1.56,.64,1)}
.pw-ico.ok{color:#fff;background:linear-gradient(140deg,#2ecc71,#12a594);box-shadow:0 14px 36px rgba(46,204,113,.4);animation:pfPop .6s cubic-bezier(.34,1.56,.64,1),acHalo 1.1s .35s ease-out both}
.pw-ico.ok path{stroke-dasharray:30;stroke-dashoffset:30;animation:paDraw .6s .25s ease forwards}
.pw-steps{display:flex;gap:6px;max-width:180px;margin:0 auto 18px}
.pw-steps i{position:relative;flex:1;height:5px;border-radius:5px;background:rgba(128,128,128,.25);overflow:hidden}
.pw-steps i::after{content:"";position:absolute;inset:0;border-radius:5px;background:var(--pc);transform:scaleX(0);transform-origin:left;transition:transform .7s cubic-bezier(.22,1,.36,1)}
.pw-steps i.on::after{transform:none}
#pwBody>*{animation:pwIn .55s cubic-bezier(.22,1,.36,1) both}
#pwBody>*:nth-child(2){animation-delay:.06s}#pwBody>*:nth-child(3){animation-delay:.12s}
#pwBody.shake{animation:paShake .5s ease}
.pw-t{margin:0;font-size:21px;font-weight:800;text-align:center}
.pw-s{margin:6px 0 18px;font-size:14px;line-height:1.35;opacity:.68;text-align:center}
.pw-f{position:relative;display:block;margin-bottom:12px}
.pw-f input{width:100%;box-sizing:border-box;height:56px;padding:22px 48px 6px 48px;font-size:16px;border-radius:18px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;transition:border-color .25s,box-shadow .25s,background .25s}
.pw-f input:focus{outline:0;border-color:var(--pc);background:rgba(128,128,128,.14);box-shadow:0 0 0 4px color-mix(in srgb,var(--pc) 22%,transparent)}
.pw-f.bad input{border-color:#e5484d;box-shadow:0 0 0 4px rgba(229,72,77,.18)}
.pw-fi{position:absolute;left:16px;top:18px;opacity:.55;pointer-events:none;transition:opacity .25s,color .25s}
.pw-f:focus-within .pw-fi{opacity:1;color:var(--pc)}
.pw-fl{position:absolute;left:48px;top:17px;font-size:16px;opacity:.55;pointer-events:none;transform-origin:left top;transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .25s}
.pw-f input:focus+.pw-fl,.pw-f input:not(:placeholder-shown)+.pw-fl{transform:translateY(-12px) scale(.74);opacity:.7}
.pw-eye{position:absolute;right:8px;top:8px;width:40px;height:40px;border:0;border-radius:50%;background:none;color:inherit;opacity:.55;display:grid;place-items:center;cursor:pointer;transition:opacity .25s,background .25s}
.pw-eye:hover{opacity:1;background:rgba(128,128,128,.14)}
.pw-msg{min-height:20px;margin:2px 2px 10px;font-size:13.5px;line-height:1.35;color:#e5484d;opacity:0;transform:translateY(-4px);transition:opacity .3s,transform .3s}
.pw-msg.show{opacity:1;transform:none}.pw-msg.ok{color:#30a46c}.pw-msg.info{color:inherit}.pw-msg.show.info{opacity:.7}
.pw-go{position:relative;display:block;width:100%;height:54px;border:0;border-radius:999px;background:var(--theme-text,#121212);color:var(--theme-bg,#fff);font-size:16px;font-weight:700;cursor:pointer;overflow:hidden;transition:transform .3s cubic-bezier(.34,1.56,.64,1),opacity .25s}
.pw-go:active{transform:scale(.97)}
.pw-go .l{display:inline-block;transition:opacity .25s,transform .3s}
.pw-go .s{position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid currentColor;border-right-color:transparent;opacity:0;transition:opacity .25s}
.pw-go.ld{pointer-events:none}.pw-go.ld .l{opacity:0;transform:translateY(8px)}.pw-go.ld .s{opacity:1;animation:paSpin .8s linear infinite}
.pw-link{display:block;margin:10px auto 0;padding:6px 10px;border:0;background:none;color:var(--pc);font-size:14px;font-weight:700;cursor:pointer;transition:opacity .25s}
.pw-link:disabled{opacity:.5}
@media(min-width:601px) and (min-height:680px) and (max-height:780px){.pf-card{overflow-y:auto;max-height:94dvh}}
.pf-pend{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 4px 0;font-size:12.5px;opacity:.9}
.pf-pend b{font-weight:700;word-break:break-all}
.pf-pend button{flex:none;border:0;background:none;color:var(--pc);font-size:12.5px;font-weight:700;cursor:pointer;padding:4px;white-space:nowrap}
.pf-pend button:disabled{opacity:.5}
@keyframes pcT{0%{opacity:0;transform:translate(-50%,-16px)}10%,86%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,-10px)}}
#pcToast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);z-index:2147483020;max-width:calc(100% - 32px);box-sizing:border-box;padding:11px 18px;border-radius:999px;background:var(--theme-text,#121212);color:var(--theme-bg,#fff);font-size:14.5px;font-weight:600;text-align:center;box-shadow:0 12px 30px rgba(0,0,0,.3);animation:pcT 3.4s ease both;pointer-events:none}
@media (prefers-reduced-motion:reduce){#pcToast{animation-duration:3.4s}}
@media (prefers-reduced-motion:reduce){#pwBody,#pwBody>*,.pw-ico,.pw-ico *,.pw-steps i::after{animation:none!important;transition:none!important}.pw-ico.ok path{stroke-dashoffset:0}}
`;
  document.head.appendChild(PWS);

  var pwSt = null;
  var PWI = {
    unlock: '<rect x="5" y="11" width="14" height="9.5" rx="2.6"/><path d="M8 11V8a4 4 0 017.6-1.6"/><path d="M12 15v2"/>',
    back: '<path d="M15.5 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>'
  };
  function pwEl(id) { return document.getElementById(id); }
  function pwAlive() { return !!(pwSt && pwEl('pwBody') && pwEl('profCard')); }
  function pwScore(v) {
    var s = 0; if (v.length >= 6) s++; if (v.length >= 10) s++;
    if (/[A-ZÇĞİÖŞÜ]/.test(v) && /[a-zçğıöşü]/.test(v)) s++;
    if (/\d/.test(v) && /[^A-Za-z0-9ÇĞİÖŞÜçğıöşü]/.test(v)) s++;
    return v ? s : 0;
  }
  function paintMeter(box, v) {
    if (!box) return;
    var s = pwScore(v), cols = ['#e5484d', '#f76b15', '#f5b301', '#30a46c'], names = ['', 'Zayıf', 'Orta', 'İyi', 'Güçlü'];
    box.querySelectorAll('i').forEach(function (b, i) { b.style.background = i < s ? cols[Math.max(0, s - 1)] : ''; });
    var t = box.querySelector('span'); if (t) t.textContent = names[s];
  }
  function pwField(id, label, ac, icon) {
    return '<label class="pw-f"><span class="pw-fi">' + ic(icon, 20) + '</span><input id="' + id + '" type="password" autocomplete="' + ac + '" autocapitalize="none" spellcheck="false" placeholder=" "><span class="pw-fl">' + label + '</span>' +
      '<button type="button" class="pw-eye" data-pf="pweye" aria-label="Şifreyi göster">' + ic(pwEye, 20) + '</button></label>';
  }
  function pwMsg(t, kind) {
    var m = pwEl('pwMsg'); if (!m) return;
    if (t) m.textContent = t;
    m.className = 'pw-msg' + (t ? ' show ' + (kind || 'err') : '');
  }
  function pwErr(t, els) {
    pwMsg(t, 'err');
    var b = pwEl('pwBody'); if (b) { b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }
    [].concat(els || []).forEach(function (el) { var f = el && el.closest && el.closest('.pw-f'); if (f) f.classList.add('bad'); });
  }
  function pwBusy(on) { if (pwSt) pwSt.busy = on; var g = pwEl('pwGo'); if (g) g.classList.toggle('ld', !!on); }

  function openPw(kind) {
    var c = pwEl('profCard'); if (!c || !draft) return;
    keepName(); cropSt = null; pwSt = { kind: kind || 'pw', step: 1, busy: false, old: '', newMail: '' };
    enter(c); c.scrollTop = 0;
    c.innerHTML = '<div class="pf-top"><button type="button" class="pf-x" data-pf="pwback" aria-label="Geri">' + ic(PWI.back, 18) + '</button><b>' + (kind === 'em' ? 'E-postayı değiştir' : 'Şifreyi değiştir') + '</b><span></span></div>' +
      '<div class="pw-hero"><div class="pw-ico" id="pwIco"></div></div><div class="pw-steps" id="pwSteps"><i></i><i></i></div><div id="pwBody"></div>';
    renderPwStep();
  }
  function renderPwStep() {
    var P = pwSt, body = pwEl('pwBody'); if (!P || !body) return;
    if (P.kind === 'em' && P.step > 1) return renderEmStep();
    var s = P.step, html = '', un = '<input type="text" autocomplete="username" value="' + esc(email || '') + '" tabindex="-1" aria-hidden="true" style="display:none">';
    var ico = pwEl('pwIco'); ico.className = 'pw-ico'; ico.innerHTML = ic(s === 1 ? IM.lock : (s === 2 ? PWI.unlock : IC.ok), 34);
    void ico.offsetWidth; ico.classList.add(s === 3 ? 'ok' : 'pop');
    var stp = pwEl('pwSteps'); void stp.offsetWidth;
    stp.querySelectorAll('i').forEach(function (b, i) { b.classList.toggle('on', i < Math.min(s, 2)); });
    if (s === 1) {
      html = '<h4 class="pw-t">Önce mevcut şifreni gir</h4><p class="pw-s">Güvenliğin için işlemi senin yaptığını doğruluyoruz.</p>' +
        '<form id="pwForm" novalidate>' + un + pwField('pwOld', 'Mevcut şifre', 'current-password', IM.lock) +
        '<p class="pw-msg" id="pwMsg" role="alert"></p>' +
        '<button type="submit" class="pw-go" id="pwGo"><span class="l">Devam</span><span class="s"></span></button>' +
        '<button type="button" class="pw-link" data-pf="pwforgot">Şifreni mi unuttun?</button></form>';
    } else if (s === 2) {
      html = '<h4 class="pw-t">Yeni şifreni belirle</h4><p class="pw-s">En az 6 karakter olsun. Eski şifrenle aynı olamaz.</p>' +
        '<form id="pwForm" novalidate>' + un + pwField('pwNew', 'Yeni şifre', 'new-password', IM.lock) +
        '<div class="pa-meter" id="pwMeter"><i></i><i></i><i></i><i></i><span></span></div>' +
        pwField('pwNew2', 'Yeni şifre (tekrar)', 'new-password', IM.lock2) +
        '<p class="pw-msg" id="pwMsg" role="alert"></p>' +
        '<button type="submit" class="pw-go" id="pwGo"><span class="l">Şifreyi güncelle</span><span class="s"></span></button></form>';
    } else {
      html = '<h4 class="pw-t">Şifren güncellendi</h4><p class="pw-s">Bir sonraki girişte yeni şifreni kullan.</p>' +
        '<button type="button" class="pw-go" data-pf="pwback"><span class="l">Tamam</span></button>';
    }
    body.innerHTML = html;
    if (s < 3 && !(window.matchMedia && matchMedia('(pointer:coarse)').matches)) setTimeout(function () { var f = pwEl(s === 1 ? 'pwOld' : 'pwNew'); if (f) f.focus(); }, 380);
  }
  function pwClick(a, b) {
    if (a === 'pw') return openPw('pw');
    if (a === 'pwem') return openPw('em');
    if (a === 'pwresend') return pwResend(b);
    if (a === 'pwback') { if (pwSt) pwSt.old = ''; pwSt = null; var c = pwEl('profCard'); if (c) c.scrollTop = 0; return renderProfile(); }
    if (a === 'pweye') {
      var inp = b.parentNode.querySelector('input'), show = inp.type === 'password';
      inp.type = show ? 'text' : 'password'; b.innerHTML = ic(show ? pwEyeOff : pwEye, 20); b.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
      return;
    }
    if (a === 'pwforgot') return pwForgot(b);
  }
  function pwInput(e) {
    if (!pwSt) return; var t = e.target;
    var f = t.closest && t.closest('.pw-f'); if (f) f.classList.remove('bad');
    if (t.id === 'pwNew') paintMeter(pwEl('pwMeter'), t.value);
    var m = pwEl('pwMsg'); if (m && m.classList.contains('show') && !pwSt.busy) m.classList.remove('show');
  }
  function pcToast(t) {
    var o = document.getElementById('pcToast'); if (o) o.remove();
    var d = document.createElement('div'); d.id = 'pcToast'; d.setAttribute('role', 'status'); d.textContent = t; document.body.appendChild(d);
    setTimeout(function () { if (d.isConnected) d.remove(); }, 3500);
  }
  function renderEmStep() {
    var P = pwSt, body = pwEl('pwBody'); if (!P || !body) return;
    var s = P.step, html = '';
    var ico = pwEl('pwIco'); ico.className = 'pw-ico'; ico.innerHTML = ic(IM.mail, 34); void ico.offsetWidth; ico.classList.add('pop');
    var stp = pwEl('pwSteps'); void stp.offsetWidth;
    stp.querySelectorAll('i').forEach(function (b, i) { b.classList.toggle('on', i < Math.min(s, 2)); });
    if (s === 2) {
      html = '<h4 class="pw-t">Yeni e-posta adresin</h4><p class="pw-s">Doğrulama bağlantısını bu adrese göndereceğiz. Şu anki adresin: <b>' + esc(email || '') + '</b></p>' +
        '<form id="pwForm" novalidate><label class="pw-f"><span class="pw-fi">' + ic(IM.mail, 20) + '</span><input id="pwMail" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder=" "><span class="pw-fl">Yeni e-posta</span></label>' +
        '<p class="pw-msg" id="pwMsg" role="alert"></p>' +
        '<button type="submit" class="pw-go" id="pwGo"><span class="l">Bağlantı gönder</span><span class="s"></span></button></form>';
    } else if (P.immediate) {
      html = '<h4 class="pw-t">E-postan güncellendi</h4><p class="pw-s">Artık <b>' + esc(P.newMail) + '</b> adresiyle giriş yapabilirsin.</p><button type="button" class="pw-go" data-pf="pwback"><span class="l">Tamam</span></button>';
    } else {
      html = '<h4 class="pw-t">Bağlantıyı gönderdik</h4><p class="pw-s"><b>' + esc(P.newMail) + '</b> adresine bir doğrulama bağlantısı gönderdik. Bağlantıya dokunana kadar eski e-postanla giriş yapmaya devam edersin.</p><button type="button" class="pw-go" data-pf="pwback"><span class="l">Tamam</span></button>';
    }
    body.innerHTML = html;
    if (s === 2 && !(window.matchMedia && matchMedia('(pointer:coarse)').matches)) setTimeout(function () { var f = pwEl('pwMail'); if (f) f.focus(); }, 380);
  }
  async function emSubmit() {
    var P = pwSt, f = pwEl('pwMail'); if (!P || !f) return;
    var v = f.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { pwErr('Geçerli bir e-posta adresi gir.', f); f.focus(); return; }
    if (v.toLowerCase() === (email || '').toLowerCase()) { pwErr('Bu zaten şu anki e-posta adresin.', f); f.focus(); return; }
    pwBusy(true); pwMsg('');
    try {
      var r = await sb.auth.updateUser({ email: v }, { emailRedirectTo: new URL('./', location.href).href });
      if (r.error) throw r.error;
      var u = r.data && r.data.user;
      P.newMail = v; P.step = 3; P.busy = false;
      if (u && u.email && u.email.toLowerCase() === v.toLowerCase()) { P.immediate = true; email = u.email; pendingEmail = ''; ui(); }   // projede e-posta doğrulaması kapalıysa anında değişir
      else pendingEmail = (u && u.new_email) || v;
      if (pwAlive()) renderEmStep();
    } catch (err) { if (pwAlive()) pwErr(trErr(err), f); }
    pwBusy(false);
  }
  async function pwResend(b) {
    if (!pendingEmail || b.disabled) return; b.disabled = true;
    try {
      var r = await sb.auth.resend({ type: 'email_change', email: pendingEmail, options: { emailRedirectTo: new URL('./', location.href).href } });
      if (r.error) throw r.error;
      pcToast('Doğrulama bağlantısı tekrar gönderildi.');
    } catch (err) { pcToast(trErr(err)); }
    b.disabled = false;
  }
  async function pwForgot(b) {
    var P = pwSt; if (!P || P.busy) return;
    if (!email) { pwErr('Hesap e-postası bulunamadı.'); return; }
    P.busy = true; b.disabled = true; pwMsg('Gönderiliyor…', 'info');
    try {
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: new URL('./', location.href).href });
      if (r.error) throw r.error;
      if (pwAlive()) pwMsg('Sıfırlama bağlantısı ' + email + ' adresine gönderildi.', 'ok');
    } catch (err) { if (pwAlive()) pwErr(trErr(err)); }
    P.busy = false; b.disabled = false;
  }
  async function pwSubmit() {
    var P = pwSt; if (!P || P.busy) return;
    if (P.step === 1) {
      var old = pwEl('pwOld'); if (!old) return;
      if (!old.value) { pwErr('Mevcut şifreni gir.', old); old.focus(); return; }
      if (authState !== 'in' || !email) { pwErr('Oturum düşmüş görünüyor. Çıkış yapıp yeniden giriş yap.', old); return; }
      pwBusy(true); pwMsg('');
      try {
        var r = await sb.auth.signInWithPassword({ email: email, password: old.value });   // eski şifre doğrulaması
        if (r.error) throw r.error;
        P.old = old.value; P.step = 2; P.busy = false;
        if (pwAlive()) renderPwStep();
      } catch (err) {
        var low = ((err && err.message) || '').toLowerCase();
        if (pwAlive()) pwErr(low.indexOf('invalid login') > -1 ? 'Mevcut şifre hatalı.' : trErr(err), old);
      }
      pwBusy(false);
    } else if (P.step === 2) {
      if (P.kind === 'em') return emSubmit();
      var n1 = pwEl('pwNew'), n2 = pwEl('pwNew2'); if (!n1 || !n2) return;
      if (n1.value.length < 6) { pwErr('Şifre en az 6 karakter olmalı.', n1); n1.focus(); return; }
      if (n1.value !== n2.value) { pwErr('Şifreler birbiriyle aynı değil.', [n1, n2]); n2.focus(); return; }
      if (n1.value === P.old) { pwErr('Yeni şifre eskisiyle aynı olamaz.', n1); n1.focus(); return; }
      pwBusy(true); pwMsg('');
      try {
        var r2 = await sb.auth.updateUser({ password: n1.value });
        if (r2.error) throw r2.error;
        P.old = ''; P.step = 3; P.busy = false;
        if (pwAlive()) renderPwStep();
      } catch (err2) { if (pwAlive()) pwErr(trErr(err2), n1); }
      pwBusy(false);
    }
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
    sec.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('ac-hero')) { e.preventDefault(); if (signedIn()) openProfile(); } });
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
  var prevYd = '', okAt = 0;
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
      if (authState === 'in') { if (prevYd === 'busy' && yd === 'ok') okAt = Date.now(); prevYd = yd; }
      var fresh = yd === 'ok' && authState === 'in' && Date.now() - okAt < 2200, cx = IC.cloud;
      cx += yd === 'busy' ? '<g class="up"><path d="M12 16.6v-5.2M9.8 13.5l2.2-2.2 2.2 2.2"/></g>' : (yd === 'err' ? '<path d="M12 10.6v3M12 16v.1"/>' : '<path class="ck" d="M9.2 13.2l2.1 2.1 3.7-4"/>');
      var chipHTML = '<div class="ac-top"><span class="ac-chip' + (fresh ? ' fresh' : '') + '" data-s="' + yd + '" style="--sc:' + SC[yd] + (fresh ? ';--ad:-' + ((Date.now() - okAt) / 1000).toFixed(2) + 's' : '') + '"><span class="ac-ci">' + ic(cx, 18) + '</span><span class="ac-ct">' + esc(yt) + '</span></span></div>';
      html = chipHTML + '<div class="ac-hero" data-acct="profile" role="button" tabindex="0" aria-label="Profili düzenle" style="--pc:' + pc + '">' +
        '<button type="button" class="ac-av" data-acct="view" aria-label="Profil resmini büyüt" style="--sc:' + SC[sd] + '">' + avatarHTML(68) + '<span class="ac-st" title="Oturum: ' + st + '"></span></button>' +
        '<div class="ac-who"><b>' + esc(dispName()) + '</b><span>' + esc(email || '') + '</span></div>' +
        '<span class="ac-notch" aria-hidden="true">' + ic('<path d="M9 5l7 7-7 7"/>', 16) + '</span></div>' +
        (note ? '<p class="ac-note' + (noteErr ? ' err' : '') + '">' + note + '</p>' : '') +
        (authState === 'in'
          ? '<div class="ac-actions col"><button type="button" class="ac-btn pri" data-acct="sync"' + (syncing ? ' disabled' : '') + '>' + ic(IC.sync, 18, syncing ? 'ac-spin' : '') + (syncing ? 'Yedekleniyor…' : 'Şimdi yedekle') + '</button>' +
            '<button type="button" class="ac-btn sec" data-acct="adv">' + ic(IC.adv, 18) + 'Gelişmiş</button><button type="button" class="ac-btn sec dng" data-acct="out">' + ic(IC.out, 18) + 'Çıkış yap</button></div>'
          : '<div class="ac-actions"><button type="button" class="ac-btn pri" data-acct="in">Yeniden giriş yap</button></div>');
    } else {
      var unk = authState === 'unknown';
      html = '<div class="ac-hero static" style="--pc:#8a8a8a"><div class="ac-av off"><span class="pf-ph">' + ic(IC.user, 28) + '</span></div><div class="ac-who"><b>' + (unk ? 'Hesap kontrol ediliyor…' : 'Giriş yapılmadı') + '</b><span>' + (unk ? 'Bir saniye' : 'Verilerini tüm cihazlarında güvende tut') + '</span></div></div>' +
        (unk ? '' : '<ul class="ac-perks"><li>' + ic(IC.ok, 16) + 'Cihazlar arasında otomatik eşitleme</li><li>' + ic(IC.ok, 16) + 'Fotoğraflar ve ayarlar dahil yedekleme</li><li>' + ic(IC.ok, 16) + 'Cihaz değiştirsen bile her şey seninle</li></ul>' +
          '<div class="ac-actions"><button type="button" class="ac-btn pri" data-acct="in">Giriş yap</button></div>');
    }
    var first = !card.getAttribute('data-d') && authState !== 'unknown';
    if (first) { card.setAttribute('data-d', '1'); card.classList.add('ac-first'); clearTimeout(card._t); card._t = setTimeout(function () { card.classList.remove('ac-first'); }, 1100); }
    card.innerHTML = html;
  }

  // ---------- Giriş yap / Kayıt ol sayfası ----------
  var AU = document.createElement('style'); AU.id = 'paceAuthCss';
  AU.textContent = `
@keyframes paShake{20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
@keyframes paOrb1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(70px,50px) scale(1.18)}}
@keyframes paOrb2{0%,100%{transform:translate(0,0) scale(1.1)}50%{transform:translate(-80px,-40px) scale(.92)}}
@keyframes paOrb3{0%,100%{transform:translate(0,0)}50%{transform:translate(50px,-70px) scale(1.15)}}
@keyframes paSpin{to{transform:rotate(360deg)}}
@keyframes paDraw{to{stroke-dashoffset:0}}
@keyframes paRing{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
#paAuth{position:fixed;inset:0;z-index:2147483005;display:flex;padding:16px;overflow-y:auto;overscroll-behavior:contain;background:var(--theme-bg,#0b0b0b);color:var(--theme-text,#121212);animation:pfFade .5s ease both}
#paAuth.out{animation:pfFadeOut .38s ease both;pointer-events:none}
.pa-bg{position:fixed;inset:0;overflow:hidden;pointer-events:none}
.pa-bg i{position:absolute;border-radius:50%;filter:blur(80px);opacity:.34;will-change:transform}
.pa-bg i:nth-child(1){width:46vmax;height:46vmax;left:-14vmax;top:-18vmax;background:var(--accent-color,#6ec1ff);animation:paOrb1 22s ease-in-out infinite}
.pa-bg i:nth-child(2){width:40vmax;height:40vmax;right:-14vmax;top:12vmax;background:#8e4ec6;opacity:.26;animation:paOrb2 26s ease-in-out infinite}
.pa-bg i:nth-child(3){width:34vmax;height:34vmax;left:18vmax;bottom:-20vmax;background:#12a594;opacity:.24;animation:paOrb3 30s ease-in-out infinite}
.pa-card{position:relative;width:100%;max-width:420px;margin:auto;box-sizing:border-box;padding:30px 26px 24px;border-radius:34px;background:color-mix(in srgb,var(--theme-bg,#0b0b0b) 70%,transparent);-webkit-backdrop-filter:blur(26px) saturate(1.3);backdrop-filter:blur(26px) saturate(1.3);border:1px solid rgba(128,128,128,.26);box-shadow:0 30px 80px rgba(0,0,0,.4);animation:pfCardIn .85s cubic-bezier(.22,1,.36,1) both;overflow:hidden}
#paAuth.out .pa-card{animation:pfCardOut .34s cubic-bezier(.5,0,.75,0) both}
.pa-card.shake{animation:paShake .5s ease}
.pa-in>.pa-x,.pa-in>.pa-brand,.pa-in>.pa-head,.pa-in>.pa-seg,.pa-in>form,.pa-in>.pa-foot{animation:pfUp .7s cubic-bezier(.22,1,.36,1) both}
.pa-in>.pa-brand{animation-delay:.08s}.pa-in>.pa-head{animation-delay:.14s}.pa-in>.pa-seg{animation-delay:.2s}.pa-in>form{animation-delay:.26s}.pa-in>.pa-foot{animation-delay:.32s}
.pa-x{position:absolute;top:16px;right:16px;width:38px;height:38px;border-radius:50%;border:0;background:rgba(128,128,128,.16);color:inherit;font-size:15px;cursor:pointer;transition:transform .25s,background .25s}
.pa-x:hover{background:rgba(128,128,128,.26)}.pa-x:active{transform:scale(.9)}
.pa-brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.pa-mark{width:50px;height:50px;border-radius:17px;display:grid;place-items:center;color:#fff;background:linear-gradient(140deg,var(--accent-color,#6ec1ff),#3e63dd);box-shadow:0 10px 26px color-mix(in srgb,var(--accent-color,#6ec1ff) 45%,transparent)}
.pa-brand b{font-size:32px;font-weight:700;letter-spacing:-.01em;line-height:1;-webkit-text-stroke:.4px currentColor}
img.pa-mark{display:block;object-fit:cover;border-radius:23%;background:none;box-shadow:0 10px 26px rgba(0,0,0,.3)}.pa-mark.f{font-size:26px;font-weight:800}
.pa-head h2{margin:0;font-size:28px;line-height:1.1;font-weight:800;letter-spacing:-.01em}
.pa-head p{margin:6px 0 0;font-size:14.5px;opacity:.68;line-height:1.35}
.pa-head{transition:opacity .22s ease,transform .22s ease}.pa-head.sw{opacity:0;transform:translateY(6px)}
.pa-seg{position:relative;display:grid;grid-template-columns:1fr 1fr;padding:4px;margin:20px 0 18px;border-radius:999px;background:rgba(128,128,128,.16)}
.pa-seg i{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:999px;background:var(--theme-text,#121212);transform:translateX(calc(var(--pos,0) * 100%));transition:transform .55s cubic-bezier(.34,1.25,.64,1)}
.pa-seg button{position:relative;z-index:1;padding:11px 0;border:0;background:transparent;color:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:color .35s ease}
.pa-seg button.on{color:var(--theme-bg,#fff)}
.pa-f{position:relative;display:block;margin-bottom:12px}
.pa-f input{width:100%;box-sizing:border-box;height:58px;padding:22px 48px 6px 48px;font-size:16px;border-radius:18px;border:1px solid rgba(128,128,128,.34);background:rgba(128,128,128,.1);color:inherit;transition:border-color .25s,box-shadow .25s,background .25s}
.pa-f input:focus{outline:0;border-color:var(--accent-color,#6ec1ff);background:rgba(128,128,128,.14);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent-color,#6ec1ff) 22%,transparent)}
.pa-f.bad input{border-color:#e5484d;box-shadow:0 0 0 4px rgba(229,72,77,.18)}
.pa-fi{position:absolute;left:16px;top:18px;opacity:.55;pointer-events:none;transition:opacity .25s,color .25s}
.pa-f:focus-within .pa-fi{opacity:1;color:var(--accent-color,#6ec1ff)}
.pa-fl{position:absolute;left:48px;top:18px;font-size:16px;opacity:.55;pointer-events:none;transform-origin:left top;transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .25s}
.pa-f input:focus+.pa-fl,.pa-f input:not(:placeholder-shown)+.pa-fl{transform:translateY(-12px) scale(.74);opacity:.7}
.pa-eye{position:absolute;right:8px;top:9px;width:40px;height:40px;border:0;border-radius:50%;background:none;color:inherit;opacity:.55;display:grid;place-items:center;cursor:pointer;transition:opacity .25s,background .25s}
.pa-eye:hover{opacity:1;background:rgba(128,128,128,.14)}
.pa-xp{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .6s cubic-bezier(.22,1,.36,1),opacity .4s ease}
.pa-xp>div{min-height:0;overflow:hidden}
#paAuth[data-m=up] .pa-xp{grid-template-rows:1fr;opacity:1}
.pa-meter{display:flex;align-items:center;gap:6px;margin:-2px 2px 12px}
.pa-meter i{flex:1;height:5px;border-radius:5px;background:rgba(128,128,128,.25);transition:background .35s}
.pa-meter span{flex:none;min-width:44px;text-align:right;font-size:12.5px;opacity:.7}
.pa-msg{min-height:20px;margin:4px 2px 10px;font-size:13.5px;line-height:1.35;color:#e5484d;opacity:0;transform:translateY(-4px);transition:opacity .3s,transform .3s}
.pa-msg.show{opacity:1;transform:none}
.pa-go{position:relative;width:100%;height:56px;border:0;border-radius:999px;background:var(--theme-text,#121212);color:var(--theme-bg,#fff);font-size:17px;font-weight:700;cursor:pointer;overflow:hidden;transition:transform .3s cubic-bezier(.34,1.56,.64,1),opacity .25s,box-shadow .3s;box-shadow:0 12px 30px rgba(0,0,0,.28)}
.pa-go:hover{transform:translateY(-1px)}.pa-go:active{transform:scale(.97)}
.pa-go .l{display:inline-block;transition:opacity .25s,transform .3s}
.pa-go .s{position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid currentColor;border-right-color:transparent;opacity:0;transition:opacity .25s}
.pa-go.ld{pointer-events:none}.pa-go.ld .l{opacity:0;transform:translateY(8px)}.pa-go.ld .s{opacity:1;animation:paSpin .8s linear infinite}
.pa-foot{margin:16px 0 0;text-align:center;font-size:14.5px;opacity:.8}
.pa-foot button{border:0;background:none;color:var(--accent-color,#6ec1ff);font-size:14.5px;font-weight:700;cursor:pointer;padding:4px 2px}
.pa-st{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;text-align:center;background:color-mix(in srgb,var(--theme-bg,#0b0b0b) 88%,transparent);opacity:0;pointer-events:none;transition:opacity .45s ease}
.pa-card.st .pa-st{opacity:1;pointer-events:auto}
.pa-st>*{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .6s cubic-bezier(.22,1,.36,1)}
.pa-card.st .pa-st>*{opacity:1;transform:none}.pa-card.st .pa-st>*:nth-child(2){transition-delay:.12s}.pa-card.st .pa-st>*:nth-child(3){transition-delay:.2s}.pa-card.st .pa-st>*:nth-child(4){transition-delay:.28s}
.pa-ring{width:84px;height:84px;border-radius:50%;display:grid;place-items:center;color:#fff;background:linear-gradient(140deg,#2ecc71,#12a594);box-shadow:0 14px 36px rgba(46,204,113,.4)}
.pa-card.st .pa-ring{animation:paRing .7s cubic-bezier(.34,1.56,.64,1) both}
.pa-ring path{stroke-dasharray:30;stroke-dashoffset:30}.pa-card.st .pa-ring path{animation:paDraw .6s .3s ease forwards}
.pa-st h3{margin:4px 0 0;font-size:24px;font-weight:800}.pa-st p{margin:0;font-size:14.5px;opacity:.72;line-height:1.4;max-width:300px}
.pa-st .pa-go{width:auto;padding:0 28px;height:50px;margin-top:6px}
.pa-card.st .pa-x{opacity:0;pointer-events:none}
@media(max-width:600px){#paAuth{padding:0}.pa-card{max-width:none;min-height:100%;margin:0;border-radius:0;border:0;box-shadow:none;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;padding:calc(env(safe-area-inset-top,0px) + 56px) 22px calc(env(safe-area-inset-bottom,0px) + 22px);display:flex;flex-direction:column;justify-content:center}.pa-x{top:calc(env(safe-area-inset-top,0px) + 14px)}}
@media (prefers-reduced-motion:reduce){#paAuth *,#paAuth{animation:none!important;transition:none!important}.pa-st>*{opacity:1;transform:none}}
`;
  document.head.appendChild(AU);

  var A = null;   // açık giriş sayfasının durumu
  var pwEye = '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  var pwEyeOff = '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.6 9.6 0 0112 6c6.4 0 10 6 10 6a17 17 0 01-3.2 3.9M6.6 7.6A16.6 16.6 0 002 12s3.6 6 10 6c1.5 0 2.8-.3 4-.8"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>';
  var IM = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3.5 7.5l8.5 6 8.5-6"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.6"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    lock2: '<rect x="5" y="11" width="14" height="9.5" rx="2.6"/><path d="M8 11V8a4 4 0 018 0v3"/><path d="M12 15v2"/>'
  };
  function openAuth(mode) {
    if (document.getElementById('paAuth')) return;
    var ov = document.createElement('div'); ov.id = 'paAuth'; ov.setAttribute('data-m', 'in');
    ov.innerHTML = '<div class="pa-bg"><i></i><i></i><i></i></div>' +
      '<div class="pa-card pa-in" role="dialog" aria-modal="true" aria-labelledby="paT">' +
      '<button type="button" class="pa-x" data-pa="close" aria-label="Kapat">✕</button>' +
      '<div class="pa-brand"><img class="pa-mark" src="icons/apple-touch-icon.png" alt="" width="50" height="50"><b>Pace</b></div>' +
      '<div class="pa-head" id="paHead"><h2 id="paT"></h2><p id="paS"></p></div>' +
      '<div class="pa-seg" id="paSeg"><i></i><button type="button" data-pa="tab" data-v="in">Giriş yap</button><button type="button" data-pa="tab" data-v="up">Kayıt ol</button></div>' +
      '<form id="paForm" novalidate>' +
        '<label class="pa-f"><span class="pa-fi">' + ic(IM.mail, 20) + '</span><input id="paEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder=" "><span class="pa-fl">E-posta</span></label>' +
        '<div class="pa-gr pa-pwwrap"><div>' + '<label class="pa-f"><span class="pa-fi">' + ic(IM.lock, 20) + '</span><input id="paPass" type="password" autocomplete="current-password" placeholder=" "><span class="pa-fl">Şifre</span>' +
          '<button type="button" class="pa-eye" data-pa="eye" aria-label="Şifreyi göster">' + ic(pwEye, 20) + '</button></label>' +
        '</div></div><div class="pa-gr pa-fgt"><div><button type="button" class="pa-link" data-pa="forgot">Şifreni mi unuttun?</button></div></div>' +
        '<div class="pa-xp"><div>' +
          '<div class="pa-meter" id="paMeter"><i></i><i></i><i></i><i></i><span id="paMeterT"></span></div>' +
          '<label class="pa-f"><span class="pa-fi">' + ic(IM.lock2, 20) + '</span><input id="paPass2" type="password" autocomplete="new-password" placeholder=" "><span class="pa-fl">Şifre tekrar</span></label>' +
        '</div></div>' +
        '<p class="pa-msg" id="paMsg" role="alert"></p>' +
        '<button type="submit" class="pa-go" id="paGo"><span class="l" id="paGoT">Giriş yap</span><span class="s"></span></button>' +
      '</form>' +
      '<p class="pa-foot" id="paFoot"></p>' +
      '<div class="pa-st" id="paSt"></div></div>';
    document.body.appendChild(ov);
    var lg = ov.querySelector('img.pa-mark'); if (lg) lg.addEventListener('error', function () { var f = document.createElement('span'); f.className = 'pa-mark f'; f.textContent = 'P'; lg.replaceWith(f); });
    A = { ov: ov, card: ov.querySelector('.pa-card'), mode: null, busy: false, done: false };
    setTimeout(function () { A && A.card.classList.remove('pa-in'); }, 1200);
    var touch = window.matchMedia && matchMedia('(pointer:coarse)').matches;
    authMode(mode || 'in', true);
    ov.addEventListener('click', function (e) {
      if (e.target === ov) return closeAuth();
      var b = e.target.closest && e.target.closest('[data-pa]'); if (!b) return;
      var a = b.getAttribute('data-pa');
      if (a === 'close') closeAuth();
      else if (a === 'tab') authMode(b.getAttribute('data-v'));
      else if (a === 'forgot') authMode('fg');
      else if (a === 'eye') {
        var p = document.getElementById('paPass'), p2 = document.getElementById('paPass2'), show = p.type === 'password';
        p.type = p2.type = show ? 'text' : 'password'; b.innerHTML = ic(show ? pwEyeOff : pwEye, 20); b.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
      }
    });
    ov.addEventListener('input', function (e) {
      var f = e.target.closest && e.target.closest('.pa-f'); if (f) f.classList.remove('bad');
      if (e.target.id === 'paPass') meter(e.target.value);
      var m = document.getElementById('paMsg'); if (m && m.classList.contains('show') && !A.busy) m.classList.remove('show');
    });
    document.getElementById('paForm').addEventListener('submit', authSubmit);
    if (!touch) setTimeout(function () { var el = document.getElementById('paEmail'); if (el) el.focus(); }, 450);
  }
  function authMode(m, instant) {
    if (!A || A.mode === m) return;
    var up = m === 'up', fg = m === 'fg', ov = A.ov;
    var set = function () {
      document.getElementById('paT').textContent = fg ? 'Şifreni mi unuttun?' : (up ? 'Hesap oluştur' : 'Tekrar hoş geldin');
      document.getElementById('paS').textContent = fg ? 'E-postanı gir, şifreni yenilemen için sana bir bağlantı gönderelim.' : up ? 'Birkaç saniyede hazır; verilerin tüm cihazlarında seninle olsun.' : 'Verilerine ulaşmak ve cihazların arasında eşitlemek için giriş yap.';
      document.getElementById('paGoT').textContent = fg ? 'Bağlantı gönder' : up ? 'Kayıt ol' : 'Giriş yap';
      document.getElementById('paFoot').innerHTML = fg ? 'Hatırladın mı? <button type="button" data-pa="tab" data-v="in">Giriş yap</button>' : up ? 'Zaten hesabın var mı? <button type="button" data-pa="tab" data-v="in">Giriş yap</button>' : 'Hesabın yok mu? <button type="button" data-pa="tab" data-v="up">Kayıt ol</button>';
      document.getElementById('paPass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    };
    A.mode = m; ov.setAttribute('data-m', m);
    var xp = ov.querySelector('.pa-xp'); if (xp) xp.inert = !up;
    var pwr = ov.querySelector('.pa-pwwrap'), fgt = ov.querySelector('.pa-fgt'); if (pwr) pwr.inert = fg; if (fgt) fgt.inert = m !== 'in';
    var seg = document.getElementById('paSeg'); seg.style.setProperty('--pos', up ? 1 : 0);
    seg.inert = fg;
    seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === (fg ? 'in' : m)); });
    var msg = document.getElementById('paMsg'); msg.classList.remove('show');
    ov.querySelectorAll('.pa-f.bad').forEach(function (f) { f.classList.remove('bad'); });
    if (instant) return set();
    var hd = document.getElementById('paHead'); hd.classList.add('sw');
    setTimeout(function () { if (!A) return; set(); hd.classList.remove('sw'); }, 200);
  }
  function meter(v) {
    var s = 0; if (v.length >= 6) s++; if (v.length >= 10) s++; if (/[A-ZÇĞİÖŞÜ]/.test(v) && /[a-zçğıöşü]/.test(v)) s++; if (/\d/.test(v) && /[^A-Za-z0-9ÇĞİÖŞÜçğıöşü]/.test(v)) s++;
    if (!v) s = 0;
    var cols = ['#e5484d', '#f76b15', '#f5b301', '#30a46c'], names = ['', 'Zayıf', 'Orta', 'İyi', 'Güçlü'];
    var bars = document.querySelectorAll('#paMeter i');
    bars.forEach(function (b, i) { b.style.background = i < s ? cols[Math.max(0, s - 1)] : ''; });
    document.getElementById('paMeterT').textContent = names[s];
  }
  function authMsg(t, bad) {
    var m = document.getElementById('paMsg'); if (!m) return;
    m.textContent = t; m.classList.add('show');
    if (bad) { A.card.classList.remove('shake'); void A.card.offsetWidth; A.card.classList.add('shake'); (bad.forEach ? bad : [bad]).forEach(function (el) { if (el) el.closest('.pa-f').classList.add('bad'); }); }
  }
  async function authSubmit(e) {
    e.preventDefault(); if (!A || A.busy || A.done) return;
    var em = document.getElementById('paEmail'), pw = document.getElementById('paPass'), pw2 = document.getElementById('paPass2'), go = document.getElementById('paGo');
    var up = A.mode === 'up', ev = em.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ev)) { authMsg('Geçerli bir e-posta adresi gir.', em); em.focus(); return; }
    if (A.mode === 'fg') return authForgot(ev, em, go);
    if (pw.value.length < 6) { authMsg('Şifre en az 6 karakter olmalı.', pw); pw.focus(); return; }
    if (up && pw.value !== pw2.value) { authMsg('Şifreler birbiriyle aynı değil.', [pw, pw2]); pw2.focus(); return; }
    A.busy = true; go.classList.add('ld'); document.getElementById('paMsg').classList.remove('show');
    try {
      if (!up) { var r = await sb.auth.signInWithPassword({ email: ev, password: pw.value }); if (r.error) throw r.error; finishAuth(); }
      else {
        var r2 = await sb.auth.signUp({ email: ev, password: pw.value, options: { emailRedirectTo: new URL('./', location.href).href } });
        if (r2.error) throw r2.error;
        if (r2.data.session) finishAuth(); else authState_verify(ev);
      }
    } catch (err) { if (A) authMsg(trErr(err), [em, pw]); }
    if (A) { A.busy = false; go.classList.remove('ld'); }
  }
  function authShow(html) { if (!A) return; var st = document.getElementById('paSt'); st.innerHTML = html; A.card.classList.add('st'); }
  function finishAuth() {   // giriş başarılı: kısa bir onay animasyonu, sonra kapan
    if (!A || A.done) return; A.done = true;
    authShow('<div class="pa-ring"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h3>Hoş geldin</h3><p>Verilerin eşitleniyor…</p>');
    setTimeout(closeAuth, 1250);
  }
  function authState_verify(addr, reset) {
    authShow('<div class="pa-ring" style="background:linear-gradient(140deg,var(--accent-color,#6ec1ff),#3e63dd);box-shadow:0 14px 36px rgba(62,99,221,.4)">' + ic(IM.mail, 38) + '</div><h3>' + (reset ? 'Bağlantı yolda' : 'E-postanı kontrol et') + '</h3><p>' + (reset ? 'Bu adres kayıtlıysa ' + esc(addr) + ' adresine şifreni sıfırlama bağlantısı gönderdik. Bağlantıya dokunup yeni şifreni belirle.' : esc(addr) + ' adresine bir doğrulama bağlantısı gönderdik. Bağlantıya dokunduktan sonra buradan giriş yap.') + '</p><button type="button" class="pa-go" data-pa="back">Giriş yap’a dön</button>');
    document.getElementById('paSt').onclick = function (e) {
      if (e.target.closest && e.target.closest('[data-pa=back]')) { A.card.classList.remove('st'); authMode('in'); }
    };
  }
  function closeAuth() {
    if (!A) return; var ov = A.ov; A = null;
    ov.classList.add('out'); setTimeout(function () { ov.remove(); }, 400);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && A && !document.getElementById('profOv')) closeAuth(); });

  // ---------- Şifremi unuttum + yeni şifre belirleme (sürüm 16) ----------
  var AUX = document.createElement('style'); AUX.id = 'paceAuthCss2';
  AUX.textContent = `
.pa-gr{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .55s cubic-bezier(.22,1,.36,1),opacity .35s ease}
.pa-gr>div{min-height:0;overflow:hidden;margin:-5px;padding:5px}
#paAuth:not([data-m=fg]) .pa-pwwrap,#paAuth[data-m=in] .pa-fgt{grid-template-rows:1fr;opacity:1}
.pa-cancel{display:block;margin:12px auto 0;padding:8px 16px;border:0;background:none;color:inherit;opacity:.7;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .25s}.pa-cancel:hover{opacity:1}
.pa-link{display:block;margin:-4px 2px 8px auto;padding:4px 2px;border:0;background:none;color:var(--accent-color,#6ec1ff);font-size:14px;font-weight:700;cursor:pointer}
.pa-seg{max-height:60px;transition:max-height .5s cubic-bezier(.22,1,.36,1),margin .5s cubic-bezier(.22,1,.36,1),padding .5s,opacity .35s}
#paAuth[data-m=fg] .pa-seg{max-height:0;margin:6px 0 8px;padding:0 4px;opacity:0;overflow:hidden;pointer-events:none}
@media (prefers-reduced-motion:reduce){.pa-gr,.pa-seg{transition:none!important}}
`;
  document.head.appendChild(AUX);

  async function authForgot(ev, em, go) {
    A.busy = true; go.classList.add('ld'); document.getElementById('paMsg').classList.remove('show');
    try {
      var r = await sb.auth.resetPasswordForEmail(ev, { redirectTo: new URL('./', location.href).href });
      if (r.error) throw r.error;
      authState_verify(ev, true);
    } catch (err) { if (A) authMsg(trErr(err), em); }
    if (A) { A.busy = false; go.classList.remove('ld'); }
  }

  // E-postadaki sıfırlama bağlantısına dokununca açılır
  var R = null;
  function openRecovery() {
    if (R) return;
    var ex = document.getElementById('paAuth'); if (ex) { ex.remove(); A = null; }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    function fld(id, label, icon, eye) {
      return '<label class="pa-f"><span class="pa-fi">' + ic(icon, 20) + '</span><input id="' + id + '" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false" placeholder=" "><span class="pa-fl">' + label + '</span>' +
        (eye ? '<button type="button" class="pa-eye" data-rc="eye" aria-label="Şifreyi göster">' + ic(pwEye, 20) + '</button>' : '') + '</label>';
    }
    var ov = document.createElement('div'); ov.id = 'paAuth'; ov.setAttribute('data-m', 'rc');
    ov.innerHTML = '<div class="pa-bg"><i></i><i></i><i></i></div>' +
      '<div class="pa-card pa-in" role="dialog" aria-modal="true" aria-labelledby="rcT">' +
      '<div class="pa-brand"><img class="pa-mark" src="icons/apple-touch-icon.png" alt="" width="50" height="50"><b>Pace</b></div>' +
      '<div class="pa-head"><h2 id="rcT">Yeni şifre belirle</h2><p>Hesabın için yeni bir şifre seç. Bundan sonra tüm cihazlarında bu şifreyle giriş yapacaksın.</p></div>' +
      '<form id="rcForm" novalidate style="margin-top:22px"><input type="text" autocomplete="username" tabindex="-1" aria-hidden="true" style="display:none">' +
        fld('rcP1', 'Yeni şifre', IM.lock, true) +
        '<div class="pa-meter" id="rcMeter"><i></i><i></i><i></i><i></i><span></span></div>' +
        fld('rcP2', 'Yeni şifre (tekrar)', IM.lock2, false) +
        '<p class="pa-msg" id="rcMsg" role="alert"></p>' +
        '<button type="submit" class="pa-go" id="rcGo"><span class="l">Şifreyi kaydet</span><span class="s"></span></button>' +
        '<button type="button" class="pa-cancel" data-rc="cancel">Vazgeç</button>' +
      '</form><div class="pa-st" id="rcSt"></div></div>';
    document.body.appendChild(ov);
    var lg = ov.querySelector('img.pa-mark'); if (lg) lg.addEventListener('error', function () { var f = document.createElement('span'); f.className = 'pa-mark f'; f.textContent = 'P'; lg.replaceWith(f); });
    R = { ov: ov, card: ov.querySelector('.pa-card'), busy: false, done: false };
    setTimeout(function () { R && R.card.classList.remove('pa-in'); }, 1200);
    ov.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-rc]'); if (!b) return;
      var a = b.getAttribute('data-rc');
      if (a === 'cancel') rcCancel();
      else if (a === 'eye') {
        var p1 = document.getElementById('rcP1'), p2 = document.getElementById('rcP2'), show = p1.type === 'password';
        p1.type = p2.type = show ? 'text' : 'password'; b.innerHTML = ic(show ? pwEyeOff : pwEye, 20); b.setAttribute('aria-label', show ? 'Şifreyi gizle' : 'Şifreyi göster');
      }
    });
    ov.addEventListener('input', function (e) {
      var f = e.target.closest && e.target.closest('.pa-f'); if (f) f.classList.remove('bad');
      if (e.target.id === 'rcP1') paintMeter(document.getElementById('rcMeter'), e.target.value);
      var m = document.getElementById('rcMsg'); if (m && m.classList.contains('show') && R && !R.busy) m.classList.remove('show');
    });
    document.getElementById('rcForm').addEventListener('submit', rcSubmit);
    if (!(window.matchMedia && matchMedia('(pointer:coarse)').matches)) setTimeout(function () { var el = document.getElementById('rcP1'); if (el) el.focus(); }, 450);
  }
  function rcErr(t, els) {
    var m = document.getElementById('rcMsg'); if (!m || !R) return;
    m.textContent = t; m.classList.add('show');
    R.card.classList.remove('shake'); void R.card.offsetWidth; R.card.classList.add('shake');
    [].concat(els || []).forEach(function (el) { var f = el && el.closest && el.closest('.pa-f'); if (f) f.classList.add('bad'); });
  }
  async function rcSubmit(e) {
    e.preventDefault(); if (!R || R.busy || R.done) return;
    var p1 = document.getElementById('rcP1'), p2 = document.getElementById('rcP2'), go = document.getElementById('rcGo');
    if (p1.value.length < 6) { rcErr('Şifre en az 6 karakter olmalı.', p1); p1.focus(); return; }
    if (p1.value !== p2.value) { rcErr('Şifreler birbiriyle aynı değil.', [p1, p2]); p2.focus(); return; }
    R.busy = true; go.classList.add('ld'); document.getElementById('rcMsg').classList.remove('show');
    try {
      var r = await sb.auth.updateUser({ password: p1.value });
      if (r.error) throw r.error;
      R.done = true;
      document.getElementById('rcSt').innerHTML = '<div class="pa-ring"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h3>Şifren güncellendi</h3><p>Bundan sonra yeni şifrenle giriş yapabilirsin.</p>';
      R.card.classList.add('st');
      setTimeout(closeRecovery, 2200);
    } catch (err) { if (R) rcErr(trErr(err), p1); }
    if (R) { R.busy = false; go.classList.remove('ld'); }
  }
  // Vazgeç: bu tarayıcı daha önce hesaba bağlı değilse (başka tarayıcı / misafir) açılan oturum da kapatılır.
  async function rcCancel() {
    if (!R || R.busy) return; R.busy = true;
    if (!recKnown) {
      meta.signedOut = true; try { saveMeta(); await sb.auth.signOut(); } catch (e) {}
      try { localStorage.removeItem(META_KEY); } catch (e) {}
    }
    try { window.close(); } catch (e) {}   // bağlantıdan açılan sekmelerde çoğu tarayıcı kapatmaya izin vermez; o durumda bilgi ekranı kalır
    setTimeout(function () {
      if (!R) return;
      document.getElementById('rcSt').innerHTML = '<div class="pa-ring" style="background:rgba(128,128,128,.25);box-shadow:none;color:var(--theme-text,#fff)">' + ic(IM.lock, 38) + '</div><h3>İptal edildi</h3><p>Şifren değişmedi. Bu sekmeyi kapatabilirsin.</p>';
      R.card.classList.add('st');
    }, 200);
  }
  function closeRecovery() {
    if (!R) return; var ov = R.ov; R = null;
    ov.classList.add('out'); setTimeout(function () { ov.remove(); }, 400);
    recMode = false;
    if (holdSync) { holdSync = false; syncNow(true); }
  }

  // Süresi dolmuş / kullanılmış e-posta bağlantısı: giriş sayfasını "şifremi unuttum" modunda aç
  if (linkErr) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) { pcToast('Bağlantının süresi dolmuş ya da daha önce kullanılmış.'); return; }
      openAuth('fg');
      setTimeout(function () { if (A) authMsg('Bağlantının süresi dolmuş ya da daha önce kullanılmış. E-postanı gir, yeni bir bağlantı gönderelim.'); }, 500);
    });
  }

  // ---------- Sürüm denetimi: yeni sürüm bildirimi + Ayarlar'da güncelleme düğmesi ----------
  // Bu dosyanın sürümü, index.html'deki "sync.js?v=N" numarasıdır; sunucudaki version.json ile karşılaştırılır.
  var APP_VER = (function () {
    try {
      var el = document.currentScript || [].slice.call(document.scripts).filter(function (x) { return /sync\.js/.test(x.src); }).pop();
      var m = /[?&]v=(\d+)/.exec((el && el.src) || ''); if (m) return parseInt(m[1], 10);
    } catch (e) {}
    return 0;
  })();
  var upd = { state: 'unknown', latest: 0, at: 0, ok: 0, busy: false, applying: false };
  var UPI = { dl: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>' };

  var UST = document.createElement('style'); UST.id = 'paceUpdCss';
  UST.textContent = `
@keyframes pcUIn{from{opacity:0;transform:translate(-50%,-26px) scale(.95)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
@keyframes pcUOut{to{opacity:0;transform:translate(-50%,-18px) scale(.97)}}
@keyframes pcDot{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}100%{box-shadow:0 0 0 11px rgba(229,72,77,0)}}
@keyframes pcBob{50%{transform:translateY(2px)}}
#pcUpd{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);z-index:2147483002;width:calc(100% - 24px);max-width:430px;box-sizing:border-box;display:flex;align-items:center;gap:11px;padding:11px 10px 11px 12px;border-radius:22px;background:color-mix(in srgb,var(--theme-bg,#111) 84%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.3);backdrop-filter:blur(18px) saturate(1.3);color:var(--theme-text,#fff);border:1px solid rgba(128,128,128,.32);box-shadow:0 16px 44px rgba(0,0,0,.38);animation:pcUIn .65s cubic-bezier(.22,1,.36,1) both}
#pcUpd.out{animation:pcUOut .3s ease both;pointer-events:none}
.pcu-i{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:13px;color:#fff;background:linear-gradient(140deg,#f76b15,#e5484d);box-shadow:0 6px 16px rgba(229,72,77,.4)}
.pcu-i svg{animation:pcBob 1.8s ease-in-out infinite}
.pcu-t{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2;text-align:left}
.pcu-t b{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcu-t span{font-size:12.5px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcu-go{flex:none;padding:10px 15px;border:0;border-radius:999px;background:var(--theme-text,#fff);color:var(--theme-bg,#000);font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .25s}
.pcu-go:active{transform:scale(.95)}.pcu-go:disabled{opacity:.6}
.pcu-x{flex:none;display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:rgba(128,128,128,.18);color:inherit;font-size:13px;line-height:1;cursor:pointer}
.upd-row{display:flex;align-items:center;gap:13px;animation:pfFade .45s ease both}
.upd-dot{flex:none;width:13px;height:13px;border-radius:50%;background:var(--c,#8a8a8a);transition:background .4s}
.upd-row[data-s=new] .upd-dot{animation:pcDot 1.5s ease-out infinite}
.upd-row[data-s=checking] .upd-dot,.upd-row[data-s=busy] .upd-dot{animation:acPulse 1s ease-in-out infinite}
.upd-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left}
.upd-tx b{font-size:17px;font-weight:700;line-height:1.2}.upd-tx span{font-size:13px;opacity:.65;line-height:1.3}
.upd-b{flex:1}
.upd-b[data-s=new]{background:#e5484d;color:#fff;border-color:transparent;box-shadow:0 8px 22px rgba(229,72,77,.35)}
.upd-b[data-s=ok]{background:color-mix(in srgb,#2ecc71 16%,transparent);border-color:color-mix(in srgb,#2ecc71 55%,transparent)}
@media (prefers-reduced-motion:reduce){#pcUpd,.upd-row,.upd-dot,.pcu-i svg{animation:none!important}}
`;
  document.head.appendChild(UST);

  function updUi() {
    var card = document.getElementById('updCard'); if (!card) return;
    var s = upd.applying ? 'busy' : upd.state;
    var C = { 'new': '#e5484d', ok: '#2ecc71', err: '#8a8a8a', unknown: '#8a8a8a', checking: '#f5b301', busy: '#f5b301' };
    var v = APP_VER ? 'Sürüm ' + APP_VER : 'Sürüm bilinmiyor';
    var t, sub, label, icon = IC.sync, act = 'check', spin = false;
    if (s === 'new') { t = 'Yeni sürüm mevcut'; sub = v + ' → ' + upd.latest + ' · verilerin korunur'; label = 'Şimdi güncelle'; icon = UPI.dl; act = 'apply'; }
    else if (s === 'ok') { t = 'Uygulama güncel'; sub = v + ' · son denetim ' + new Date(upd.ok).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); label = 'Güncellemeleri denetle'; }
    else if (s === 'checking') { t = 'Denetleniyor…'; sub = v; label = 'Denetleniyor…'; spin = true; }
    else if (s === 'busy') { t = 'Güncelleniyor…'; sub = 'Verilerin korunuyor, sayfa yenilenecek.'; label = 'Güncelleniyor…'; spin = true; act = 'none'; }
    else if (s === 'err') { t = 'Denetlenemedi'; sub = 'Bağlantını kontrol edip tekrar dene.'; label = 'Tekrar dene'; }
    else { t = 'Güncelleme'; sub = v; label = 'Güncellemeleri denetle'; }
    card.innerHTML = '<div class="upd-row" data-s="' + s + '" style="--c:' + C[s] + '"><span class="upd-dot"></span><div class="upd-tx"><b>' + t + '</b><span>' + esc(sub) + '</span></div></div>' +
      '<div class="ac-actions"><button type="button" class="ac-btn upd-b" data-s="' + s + '" data-upd="' + act + '"' + (spin ? ' disabled' : '') + '>' + ic(icon, 18, spin ? 'ac-spin' : '') + label + '</button></div>';
  }
  function showUpdBanner() {
    if (document.getElementById('pcUpd') || upd.applying) return;
    try { if (sessionStorage.getItem('pace_upd_dis') === String(upd.latest)) return; } catch (e) {}
    var b = document.createElement('div'); b.id = 'pcUpd'; b.setAttribute('role', 'status');
    b.innerHTML = '<span class="pcu-i">' + ic(UPI.dl, 20) + '</span><span class="pcu-t"><b>Yeni sürüm mevcut</b><span>Sürüm ' + upd.latest + ' hazır · verilerin korunur</span></span>' +
      '<button type="button" class="pcu-go" data-u="go">Güncelle</button><button type="button" class="pcu-x" data-u="x" aria-label="Sonra">✕</button>';
    document.body.appendChild(b);
    b.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-u]'); if (!t) return;
      if (t.getAttribute('data-u') === 'go') applyUpdate(); else hideUpdBanner(true);
    });
  }
  function hideUpdBanner(dismiss) {
    var b = document.getElementById('pcUpd'); if (!b) return;
    if (dismiss) { try { sessionStorage.setItem('pace_upd_dis', String(upd.latest)); } catch (e) {} }
    b.classList.add('out'); setTimeout(function () { b.remove(); }, 320);
  }
  async function checkUpdate(manual) {
    if (!APP_VER || upd.busy || upd.applying) { if (manual && !APP_VER) pcToast('Sürüm bilgisi okunamadı.'); return; }
    if (!manual && Date.now() - upd.at < 20000) return;
    upd.busy = true; upd.at = Date.now();
    var prev = upd.state; if (manual) { upd.state = 'checking'; updUi(); }
    try {
      var r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var j = await r.json(), n = parseInt(j && j.v, 10); if (!n) throw new Error('bad');
      upd.latest = n; upd.ok = Date.now(); upd.state = n > APP_VER ? 'new' : 'ok';
    } catch (e) { upd.state = (prev === 'new') ? 'new' : 'err'; }
    upd.busy = false; updUi();
    if (upd.state === 'new') showUpdBanner();
    else if (manual) pcToast(upd.state === 'ok' ? 'En güncel sürümü kullanıyorsun.' : 'Denetlenemedi. Bağlantını kontrol et.');
  }
  // Güncelle: bekleyen değişiklikleri buluta gönder, yalnızca uygulama önbelleğini temizle (veriye dokunmaz), sayfayı yenile.
  async function applyUpdate() {
    if (upd.applying) return; upd.applying = true; updUi();
    var gb = document.querySelector('#pcUpd .pcu-go'); if (gb) { gb.disabled = true; gb.textContent = 'Güncelleniyor…'; }
    try { if (uid) { try { scan(); } catch (e) {} await Promise.race([syncNow(false), new Promise(function (r) { setTimeout(r, 6000); })]); } } catch (e) {}
    try { if (window.caches) { var ks = await caches.keys(); await Promise.all(ks.map(function (k) { return caches.delete(k); })); } } catch (e) {}
    try { await Promise.all(['./', 'index.html', 'service-worker.js'].map(function (u) { return fetch(u, { cache: 'reload' }).catch(function () {}); })); } catch (e) {}   // tarayıcı HTTP önbelleğini de tazele
    try { if (navigator.serviceWorker) { var rg = await navigator.serviceWorker.getRegistration(); if (rg) await rg.update(); } } catch (e) {}
    location.reload();
  }
  function mountUpdate() {
    if (document.getElementById('updSection')) return;
    var acct = document.getElementById('acctSection');
    var host = acct ? acct.parentNode : (document.querySelector('#page-settings .settings-col-left') || document.querySelector('#page-settings .settings-page'));
    if (!host) return;
    var sec = document.createElement('div'); sec.className = 'settings-section'; sec.id = 'updSection';
    sec.innerHTML = '<span class="settings-section-label">Uygulama sürümü</span><div class="settings-card"><div id="updCard" class="ac"></div></div>';
    host.insertBefore(sec, acct ? acct.nextSibling : host.firstChild);
    sec.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-upd]'); if (!b || b.disabled) return;
      var a = b.getAttribute('data-upd');
      if (a === 'apply') applyUpdate(); else if (a === 'check') checkUpdate(true);
    });
    updUi();
  }
  if (APP_VER) {
    setTimeout(function () { checkUpdate(false); }, 2500);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkUpdate(false); });
    window.addEventListener('online', function () { checkUpdate(false); });
    setInterval(function () { if (document.visibilityState === 'visible') checkUpdate(false); }, 600000);
  }

  mountAccount();
  mountSide();
  mountUpdate();

  window.PaceSync = { syncNow: function () { return syncNow(false); } };
})();
