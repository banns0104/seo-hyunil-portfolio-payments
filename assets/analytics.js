/* ============================================================
   analytics.js — 채용 문서 전용 행동 분석 (GA4)
   설계: 이력서·경력기술서·포트폴리오·덱의 "어디서 이탈했나 /
        무엇을 봤나 / 얼마나 깊이 봤나"를 한 곳에서 추적.
   GA4 measurement ID는 각 페이지 <head>의 gtag로 이미 로드됨.
   이 파일은 그 위에 커스텀 이벤트만 얹는다. (중복 로드 안전)
   ============================================================ */
(function () {
  if (window.__omAnalyticsLoaded) return;
  window.__omAnalyticsLoaded = true;

  // gtag이 아직 없으면 큐로 받아둠 (스크립트 순서 안전장치)
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  var send = function (name, params) {
    try { gtag('event', name, params || {}); } catch (e) {}
  };

  // ?ref=... 유입 꼬리표 → 모든 이벤트에 동봉 (누구에게 보낸 링크가 열렸나)
  var ref = new URLSearchParams(location.search).get('ref') || '(direct)';
  // 문서 종류 자동 판별
  var path = (location.pathname.split('/').pop() || 'index').replace('.html','');
  var docMap = {
    'index':'portfolio', 'portfolio':'portfolio', 'portfolio-print':'portfolio',
    'resume':'resume', 'resume-print':'resume',
    'career-statement':'career', 'career-statement-print':'career',
    'portfolio-deck':'deck', 'portfolio-deck-print':'deck'
  };
  var doc = docMap[path] || path;

  function base(extra){
    var o = { doc_type: doc, ref_tag: ref };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }

  /* ───────── 1. 진입 + 체류 마일스톤 (active time = idle 제외) ───────── */
  var t0 = Date.now();
  var activeMs = 0, lastTick = Date.now(), idle = false, idleAt = Date.now();
  // 마우스/스크롤/키 입력이 없으면 idle 처리 → '진짜 읽은 시간' 측정
  ['mousemove','scroll','keydown','click','touchstart'].forEach(function(ev){
    window.addEventListener(ev, function(){ idleAt = Date.now(); if(idle){ idle=false; lastTick=Date.now(); } }, {passive:true});
  });
  var keyActions = 0;     // pdf/email/gallery 등 '의지' 행동 카운트
  var t0pageVisible = Date.now();
  function tickActive(){
    var now = Date.now();
    if (document.visibilityState === 'visible' && !idle) activeMs += now - lastTick;
    lastTick = now;
    if (now - idleAt > 15000) idle = true;   // 15초 무입력 → idle
  }
  send('doc_view', base());                         // 어떤 문서를, 어떤 ref로 열었나
  var marks = [10,30,60,120,180,300], mi = 0;
  var dwellTimer = setInterval(function(){
    tickActive();
    var s = Math.round(activeMs/1000);
    while (mi < marks.length && s >= marks[mi]) {
      send('dwell', base({ seconds: marks[mi] }));   // active 10s/30s/1m/2m/3m/5m 도달
      mi++;
    }
    if (mi >= marks.length) clearInterval(dwellTimer);
  }, 1000);

  /* ───────── 2. 스크롤 깊이 (이탈 지점 파악의 핵심) ───────── */
  var depths = [25,50,75,90,100], di = 0, maxPct = 0;
  function scrollPct(){
    var d = document.documentElement, b = document.body;
    var sh = Math.max(d.scrollHeight, b.scrollHeight);
    var st = window.scrollY || d.scrollTop;
    var vh = window.innerHeight;
    if (sh <= vh) return 100;
    return Math.min(100, Math.round((st + vh) / sh * 100));
  }
  var scrollRAF = false;
  function onScroll(){
    if (scrollRAF) return; scrollRAF = true;
    requestAnimationFrame(function(){
      scrollRAF = false;
      var p = scrollPct();
      if (p > maxPct) maxPct = p;
      while (di < depths.length && p >= depths[di]) {
        send('scroll_depth', base({ percent: depths[di] }));
        di++;
      }
    });
  }
  window.addEventListener('scroll', onScroll, { passive:true });

  /* ───────── 3. 섹션/케이스 가시성 (무엇을 실제로 봤나) ───────── */
  // 각 섹션이 화면에 들어오면 1회 기록 → "어느 챕터까지 보고 닫았나"
  function watchSections(){
    var nodes = document.querySelectorAll('[data-section], section[id], .case[id], .arch h4, [data-screen-label]');
    if (!('IntersectionObserver' in window) || !nodes.length) return;
    var seen = {};
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        var el = en.target;
        var name = el.getAttribute('data-section')
                || el.getAttribute('id')
                || el.getAttribute('data-screen-label')
                || (el.textContent||'').trim().slice(0,40);
        if (!name || seen[name]) return;
        seen[name] = 1;
        send('section_view', base({ section: name }));
        io.unobserve(el);
      });
    }, { threshold: 0.4 });
    nodes.forEach(function(n){ io.observe(n); });
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', watchSections);
  else watchSections();

  /* ───────── 4. 클릭 추적 (버튼·링크·이미지·표지) ───────── */
  document.addEventListener('click', function(e){
    var a = e.target.closest('a, button, .gcover, .plates img, [data-cta]');
    if (!a) return;
    var label, kind;

    if (a.matches('.plates img')) {
      kind = 'screenshot';
      label = a.getAttribute('alt') || a.getAttribute('src') || 'image';
    } else if (a.matches('.gcover')) {
      kind = 'gallery_open';
      var t = a.querySelector('.gc-title');
      label = t ? t.textContent.trim() : 'gallery';
    } else if (a.tagName === 'A') {
      var href = a.getAttribute('href') || '';
      label = (a.textContent || '').trim().slice(0,40) || href;
      if (/\.pdf(\?|$)/i.test(href)) kind = 'pdf_download';
      else if (/-print\.html/i.test(href)) kind = 'pdf_view';
      else if (/^mailto:/i.test(href)) kind = 'email';
      else if (/^https?:/i.test(href) && href.indexOf(location.host) < 0) kind = 'external_link';
      else if (href.charAt(0) === '#') kind = 'anchor_nav';
      else if (/\.html/i.test(href)) kind = 'doc_link';
      else kind = 'link';
    } else {
      kind = 'button';
      label = (a.textContent || a.getAttribute('aria-label') || 'button').trim().slice(0,40);
    }
    send('cta_click', base({ click_kind: kind, label: label }));
    // 채용 결정에 강한 '의지 행동'은 별도 가중
    if (kind === 'pdf_download' || kind === 'email' || kind === 'gallery_open' || kind === 'doc_link') {
      keyActions++;
      send('intent_action', base({ click_kind: kind, label: label }));
    }
  }, true);

  /* ───────── 5. 덱 슬라이드 추적 (deck 전용) ───────── */
  if (doc.indexOf('deck') >= 0) {
    var lastSlide = -1;
    setInterval(function(){
      var ds = document.querySelector('deck-stage');
      if (!ds) return;
      // 활성 슬라이드 index 추정
      var secs = [].slice.call(ds.querySelectorAll('section'));
      var idx = secs.findIndex(function(s){ return s.hasAttribute('data-deck-active'); });
      if (idx < 0) {
        // hash 기반 fallback (?#3 등)
        var m = location.hash.match(/(\d+)/); idx = m ? (+m[1]-1) : 0;
      }
      if (idx !== lastSlide && idx >= 0) {
        lastSlide = idx;
        var lbl = secs[idx] ? (secs[idx].getAttribute('data-label')||('slide '+(idx+1))) : ('slide '+(idx+1));
        send('slide_view', base({ slide_index: idx+1, slide_label: lbl }));
      }
    }, 1200);
  }

  /* ───────── 6. 이탈 시 최종 스냅샷 + 참여도 점수 ───────── */
  // engagement_score: 스크롤깊이(0~40) + active체류(0~40) + 의지행동(0~20) = 0~100
  function engagementScore(){
    var depthPts = Math.round(maxPct * 0.4);                 // 100% → 40
    var secs = Math.round(activeMs/1000);
    var timePts = Math.min(40, Math.round(secs/180*40));     // 3분 → 40
    var actPts  = Math.min(20, keyActions * 7);              // 행동 3개 → 20
    return Math.min(100, depthPts + timePts + actPts);
  }
  function exitSnapshot(){
    if (window.__omExitSent) return; window.__omExitSent = true;
    tickActive();
    var secs = Math.round(activeMs/1000);
    var score = engagementScore();
    // 한눈에 등급: hot(70+) / warm(40~69) / cold(<40)
    var tier = score >= 70 ? 'hot' : (score >= 40 ? 'warm' : 'cold');
    send('doc_exit', base({
      max_scroll: maxPct,
      active_seconds: secs,
      key_actions: keyActions,
      engagement_score: score,
      engagement_tier: tier
    }));
  }
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') exitSnapshot();
  });
  window.addEventListener('pagehide', exitSnapshot);
})();
