/* ============================================================
   cms/edit-engine.js — 자가관리 편집 엔진
   · 정적 HTML 먼저 렌더 → DB 오버라이드만 덮기 (안 느림)
   · banns0104만 편집, 방문자 읽기전용
   · config 비면 localStorage 모의모드, 채우면 Firebase
   편집 영역: <… data-edit-root>  (그 안 모든 텍스트 편집)
   반복 항목 목록: <… data-edit-list="고유id">  (자식 항목 추가/삭제/순서)
   ============================================================ */
(function () {
  var CFG = window.CMS_CONFIG || {};
  var OWNER = (CFG.ownerEmail || "").toLowerCase();
  var FB = CFG.firebase || {};
  var LIVE = !!(FB.apiKey && FB.databaseURL);
  var DOC = (location.pathname.split("/").pop() || "index").replace(".html", "") || "index";
  var INLINE = { B:1,EM:1,I:1,STRONG:1,SPAN:1,A:1,BR:1,U:1,SUP:1,SUB:1,MARK:1,SMALL:1,svg:0 };

  var state = { editing:false, user:null, ov:{} };   // ov = overrides {eid:html, "list:id":[outerHTML...]}

  /* ---------- leaf-text 판정 ---------- */
  function isLeaf(el){
    if(!el.textContent || !el.textContent.trim()) return false;
    for(var i=0;i<el.children.length;i++){ if(!INLINE[el.children[i].tagName]) return false; }
    return true;
  }
  /* ---------- 모든 텍스트 자동 태깅 (최외곽 leaf만, 중첩 방지) ---------- */
  function tagText(){
    var roots = document.querySelectorAll("[data-edit-root]");
    var idx = 0;
    roots.forEach(function(root){
      var all = root.querySelectorAll("*"), chosen = [];
      all.forEach(function(el){
        if(el.closest("[data-no-edit]")) return;
        if(["SCRIPT","STYLE","SVG","PATH","IMG","BUTTON"].indexOf(el.tagName)>=0) return;
        if(!isLeaf(el)) return;
        // 이미 선택된 조상 안이면 skip (중첩 방지)
        for(var i=0;i<chosen.length;i++){ if(chosen[i].contains(el)) return; }
        chosen.push(el);
      });
      chosen.forEach(function(el){
        if(!el.hasAttribute("data-eid")) el.setAttribute("data-eid", DOC+":t"+(idx));
        idx++;
      });
    });
  }

  /* ---------- 목록(반복항목) 초기화 ---------- */
  function lists(){ return document.querySelectorAll("[data-edit-list]"); }
  function listItems(list){
    return [].slice.call(list.children).filter(function(n){ return n.nodeType===1 && !n.classList.contains("cms-add"); });
  }
  function listKey(list){ return "list:"+DOC+":"+list.getAttribute("data-edit-list"); }

  /* ---------- 오버라이드 적용 (안전: 정적 HTML은 절대 손상 안 됨) ---------- */
  function applyOverrides(){
    try {
      // 1) 목록 복원 — 유효한 배열일 때만. 아니면 정적 그대로 둠(날아가지 않음).
      lists().forEach(function(list){
        var arr = state.ov[listKey(list)];
        if(!Array.isArray(arr)) return;                  // 없거나 깨졌으면 정적 유지
        if(arr.some(function(x){ return typeof x!=="string"; })) return; // 형식 이상 → 무시
        if(arr.length===0) return;                       // 빈 배열도 무시(전체증발 방지)
        listItems(list).forEach(function(n){ n.remove(); });
        var addBtn = list.querySelector(".cms-add");
        arr.forEach(function(html){
          var tmp = document.createElement("div"); tmp.innerHTML = html;
          var node = tmp.firstElementChild; if(node){ addBtn ? list.insertBefore(node, addBtn) : list.appendChild(node); }
        });
      });
      // 2) 텍스트 재태깅 + 적용 (값이 문자열일 때만)
      tagText();
      document.querySelectorAll("[data-eid]").forEach(function(el){
        var v = state.ov[el.getAttribute("data-eid")];
        if(typeof v==="string" && v.length) el.innerHTML = v;
      });
      // 3) 갤러리(스크린샷) 복원 — 유효한 문자열 배열일 때만
      galTag();
      galleries().forEach(function(g){
        var arr = state.ov[galKey(g)];
        if(!Array.isArray(arr)) return;
        if(arr.some(function(x){ return typeof x!=="string"; })) return;
        if(arr.length===0) return;
        rebuildGallery(g, arr);
      });
      if(state.editing) decorate(true);
    } catch(err){ /* 어떤 경우에도 페이지 콘텐츠는 정적 그대로 살아있음 */ }
  }

  /* ---------- 저장소 (mock/live 캐시 분리 → 테스트 데이터가 실서비스로 안 샘) ---------- */
  var LSKEY = "cms_"+DOC+(LIVE?"_live":"_mock"), db=null;
  function loadCache(){ try{ return JSON.parse(localStorage.getItem(LSKEY)||"{}"); }catch(e){ return {}; } }
  function saveCache(){ try{ localStorage.setItem(LSKEY, JSON.stringify(state.ov)); }catch(e){} }
  function fbKey(k){ return k.replace(/[.#$\[\]\/]/g,"_"); }
  function persistKey(k){
    saveCache();
    if(LIVE && db && state.user){
      setSync("saving");
      var val = state.ov[k];
      db.ref("docs/"+DOC+"/"+fbKey(k)).set(val===undefined?null:val)
        .then(function(){ setSync("saved"); try{ db.ref("meta/lastEditedAt").set(Date.now()); db.ref("meta/lastEditedBy").set((state.user&&state.user.email)||""); }catch(e){} })
        .catch(function(){ setSync("connected"); toast("저장 실패 — 권한/네트워크 확인"); });
    }
  }
  function loadOverrides(){
    state.ov = loadCache(); applyOverrides();
    if(LIVE && db){
      db.ref("docs/"+DOC).once("value").then(function(s){
        var val = s.val();
        // RTDB가 비어도(null/{}) 정적 콘텐츠는 그대로 — 빈 값으로 덮지 않음
        if(val && typeof val==="object"){ state.ov = val; saveCache(); applyOverrides(); }
      }).catch(function(){ /* 네트워크 실패 시 캐시/정적 유지 */ });
    }
  }

  /* ---------- 갤러리(스크린샷) CRUD ---------- */
  function galleries(){
    var out=[], roots=document.querySelectorAll("[data-edit-root]");
    roots.forEach(function(r){ r.querySelectorAll(".plates").forEach(function(g){ out.push(g); }); });
    return out;
  }
  function galTag(){ galleries().forEach(function(g,i){ if(!g.hasAttribute("data-gid")) g.setAttribute("data-gid", DOC+":g"+i); }); }
  function galKey(g){ return "gal:"+g.getAttribute("data-gid"); }
  function galImgEls(g){ return [].slice.call(g.querySelectorAll("img")); }
  function galSrcs(g){ return galImgEls(g).map(function(im){ return im.getAttribute("src"); }); }
  function rebuildGallery(g, srcs){
    // strip pframe wrappers + controls, rebuild plain <img> list
    g.querySelectorAll(".cms-img-ctl,.cms-add").forEach(function(x){ x.remove(); });
    g.innerHTML = "";
    srcs.forEach(function(s){ var im=document.createElement("img"); im.src=s; im.loading="lazy"; g.appendChild(im); });
  }
  function saveGallery(g){
    state.ov[galKey(g)] = galSrcs(g);
    persistKey(galKey(g));
  }
  function resizeToDataURL(file, maxW, cb){
    var rd=new FileReader();
    rd.onload=function(){
      var img=new Image();
      img.onload=function(){
        var w=img.width,h=img.height, sc=Math.min(1, maxW/w);
        var cw=Math.round(w*sc), ch=Math.round(h*sc);
        var cv=document.createElement("canvas"); cv.width=cw; cv.height=ch;
        var cx=cv.getContext("2d"); cx.fillStyle="#fff"; cx.fillRect(0,0,cw,ch); cx.drawImage(img,0,0,cw,ch);
        cb(cv.toDataURL("image/jpeg", 0.78));
      };
      img.onerror=function(){ cb(null); };
      img.src=rd.result;
    };
    rd.readAsDataURL(file);
  }
  function addImages(g, files){
    var arr=[].slice.call(files).filter(function(f){ return /^image\//.test(f.type); });
    if(!arr.length) return;
    var done=0;
    setSync("saving");
    arr.forEach(function(f){
      resizeToDataURL(f, 1080, function(durl){
        if(durl){ var im=document.createElement("img"); im.src=durl; im.loading="lazy";
          var add=g.querySelector(".cms-add"); add? g.insertBefore(im, add): g.appendChild(im); }
        if(++done===arr.length){ decorate(true); saveGallery(g); toast(arr.length+"장 추가됨"); }
      });
    });
  }
  function attachImgCtl(g, img){
    var wrap=img.closest(".pframe")||img;
    if(getComputedStyle(wrap).position==="static") wrap.style.position="relative";
    var ctl=document.createElement("div"); ctl.className="cms-img-ctl cms-item-ctl";
    ctl.innerHTML='<button title="앞으로" data-a="l">←</button><button title="뒤로" data-a="r">→</button><button title="삭제" data-a="x">🗑</button>';
    ctl.addEventListener("click", function(e){
      var a=e.target.getAttribute("data-a"); if(!a) return; e.preventDefault(); e.stopPropagation();
      var unit=img.closest(".pframe")||img;
      if(a==="l"){ var p=unit.previousElementSibling; if(p) g.insertBefore(unit,p); }
      if(a==="r"){ var n=unit.nextElementSibling; if(n && !n.classList.contains("cms-add")) g.insertBefore(n,unit); }
      if(a==="x"){ if(confirm("이 스크린샷을 삭제할까요?")) unit.remove(); }
      saveGallery(g); decorate(true); toast("저장됨");
    });
    wrap.appendChild(ctl);
  }

  /* ---------- 편집 데코레이션 ---------- */
  function decorate(on){
    // 텍스트
    document.querySelectorAll("[data-eid]").forEach(function(el){
      if(on){ el.setAttribute("contenteditable","true"); el.addEventListener("blur",onBlur); el.addEventListener("keydown",onKey); }
      else  { el.removeAttribute("contenteditable"); el.removeEventListener("blur",onBlur); el.removeEventListener("keydown",onKey); }
    });
    // 목록 컨트롤
    lists().forEach(function(list){
      list.querySelectorAll(".cms-item-ctl").forEach(function(c){ c.remove(); });
      var add = list.querySelector(".cms-add"); if(add) add.remove();
      if(!on) return;
      listItems(list).forEach(function(item){ attachItemCtl(list,item); });
      var b = document.createElement("button");
      b.className = "cms-add"; b.type="button"; b.textContent = "＋ 항목 추가";
      b.addEventListener("click", function(){ addItem(list); });
      list.appendChild(b);
    });
    // 갤러리(스크린샷) 컨트롤
    galTag();
    galleries().forEach(function(g){
      g.querySelectorAll(".cms-img-ctl").forEach(function(c){ c.remove(); });
      var oldAdd=g.querySelector(".cms-add"); if(oldAdd) oldAdd.remove();
      if(!on) return;
      galImgEls(g).forEach(function(im){ attachImgCtl(g, im); });
      var add=document.createElement("button"); add.className="cms-add cms-add-img"; add.type="button"; add.textContent="＋ 스크린샷 추가";
      var inp=document.createElement("input"); inp.type="file"; inp.accept="image/*"; inp.multiple=true; inp.style.display="none";
      inp.addEventListener("change", function(){ addImages(g, inp.files); inp.value=""; });
      add.addEventListener("click", function(){ inp.click(); });
      g.appendChild(add); g.appendChild(inp);
    });
  }
  function attachItemCtl(list,item){
    if(getComputedStyle(item).position==="static") item.style.position="relative";
    var ctl = document.createElement("div");
    ctl.className = "cms-item-ctl";
    ctl.innerHTML = '<button title="위로" data-a="up">↑</button><button title="아래로" data-a="down">↓</button><button title="삭제" data-a="del">🗑</button>';
    ctl.addEventListener("click", function(e){
      var a = e.target.getAttribute("data-a"); if(!a) return;
      e.preventDefault(); e.stopPropagation();
      if(a==="up"){ var p=item.previousElementSibling; if(p && !p.classList.contains("cms-add")) list.insertBefore(item,p); }
      if(a==="down"){ var n=item.nextElementSibling; if(n && !n.classList.contains("cms-add")) list.insertBefore(n,item); }
      if(a==="del"){ if(confirm("이 항목을 삭제할까요?")) item.remove(); }
      saveList(list); decorate(true); toast("저장됨");
    });
    item.appendChild(ctl);
  }
  function cleanItem(node){
    var c = node.cloneNode(true);
    c.querySelectorAll(".cms-item-ctl").forEach(function(x){ x.remove(); });
    c.removeAttribute("contenteditable");
    c.querySelectorAll("[contenteditable]").forEach(function(x){ x.removeAttribute("contenteditable"); });
    c.querySelectorAll("[data-eid]").forEach(function(x){ x.removeAttribute("data-eid"); });
    return c.outerHTML;
  }
  function saveList(list){
    state.ov[listKey(list)] = listItems(list).map(cleanItem);
    persistKey(listKey(list));
  }
  function addItem(list){
    var items = listItems(list);
    var tmpl = items[items.length-1] || items[0];
    var node;
    if(tmpl){ node = tmpl.cloneNode(true); node.querySelectorAll(".cms-item-ctl").forEach(function(x){x.remove();}); node.querySelectorAll("[data-eid]").forEach(function(x){x.removeAttribute("data-eid");}); }
    else { node = document.createElement("div"); node.textContent="새 항목"; }
    var add = list.querySelector(".cms-add");
    add ? list.insertBefore(node,add) : list.appendChild(node);
    tagText();
    decorate(true);
    saveList(list);
    toast("항목 추가됨 — 내용을 수정하세요");
    var first = node.querySelector("[data-eid]"); if(first) first.focus();
  }

  function onKey(e){ if(e.key==="Enter" && !e.shiftKey && this.tagName!=="LI"){ e.preventDefault(); this.blur(); } }
  function onBlur(){
    var listEl = this.closest("[data-edit-list]");
    if(listEl){ saveList(listEl); }
    else { var eid=this.getAttribute("data-eid"); state.ov[eid]=this.innerHTML.trim(); persistKey(eid); }
    toast("저장됨");
  }

  /* ---------- 편집 토글 ---------- */
  function setEditing(on){
    state.editing = on;
    document.documentElement.classList.toggle("cms-editing", on);
    decorate(on);
    bar.querySelector(".cms-edit").textContent = on ? "✓ 편집 종료" : "✎ 편집 모드";
  }

  /* ---------- 인증 ---------- */
  function canEdit(e){ return e && e.toLowerCase()===OWNER; }
  function signIn(){
    if(!LIVE){ state.user={email:OWNER}; renderBar(); toast("모의 로그인 (이 브라우저에만 저장)"); return; }
    var p=new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(p).catch(function(e){ toast("로그인 실패: "+e.code); });
  }
  function signOut(){ if(state.editing) setEditing(false); if(!LIVE){ state.user=null; renderBar(); return; } firebase.auth().signOut(); }

  /* ---------- UI ---------- */
  var bar, toastT;
  function buildBar(){
    bar=document.createElement("div"); bar.id="cms-bar";
    bar.innerHTML='<span class="cms-brand">CMS</span><span class="cms-sync" title="동기화 상태"><i></i><b></b></span><button class="cms-login"></button><button class="cms-edit" hidden>✎ 편집 모드</button><span class="cms-mode"></span>';
    document.body.appendChild(bar);
    var st=document.createElement("style");
    st.textContent=
      '#cms-bar{position:fixed;bottom:0;left:0;right:0;z-index:99999;display:flex;gap:8px;align-items:center;justify-content:center;background:rgba(20,18,14,.94);color:#F4F1E8;padding:8px 12px;font:600 12px/1 Pretendard,sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,.18);backdrop-filter:blur(8px);}'+
      '@media print{#cms-bar{display:none!important;}}'+
      'html.cms-deck #cms-bar{top:18px;left:18px;right:auto;bottom:auto;width:auto;justify-content:flex-start;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,.3);}'+
      '#cms-bar button{font:inherit;color:#F4F1E8;background:transparent;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:7px 12px;cursor:pointer;}'+
      '#cms-bar button:hover{background:rgba(255,255,255,.14);}'+
      '#cms-bar .cms-brand{letter-spacing:.14em;opacity:.7;}#cms-bar .cms-mode{opacity:.55;font-weight:500;}'+
      '.cms-sync{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);font-weight:700;}'+
      '.cms-sync i{width:8px;height:8px;border-radius:50%;background:#8A8A8A;display:inline-block;transition:background .2s,box-shadow .2s;}'+
      '.cms-sync b{font-weight:700;opacity:.85;}'+
      '.cms-sync.on{background:rgba(30,90,64,.28);border-color:rgba(74,160,116,.6);}'+
      '.cms-sync.on i{background:#46C07A;box-shadow:0 0 0 0 rgba(70,192,122,.6);}'+
      '.cms-sync.saving i{background:#46C07A;animation:cmsPulse .8s ease-out infinite;}'+
      '@keyframes cmsPulse{0%{box-shadow:0 0 0 0 rgba(70,192,122,.65);}100%{box-shadow:0 0 0 7px rgba(70,192,122,0);}}'+
      '.cms-editing [data-eid]{outline:1px dashed rgba(30,90,64,.45);outline-offset:2px;cursor:text;border-radius:2px;}'+
      '.cms-editing [data-eid]:hover{background:rgba(30,90,64,.06);}'+
      '.cms-editing [data-eid]:focus{outline:2px solid #1E5A40;background:#fff;}'+
      '.cms-item-ctl{position:absolute;top:4px;right:4px;display:flex;gap:3px;z-index:50;}'+
      '.cms-item-ctl button{font:600 12px Pretendard,sans-serif;background:rgba(20,18,14,.85);color:#fff;border:none;border-radius:5px;width:26px;height:26px;cursor:pointer;line-height:1;}'+
      '.cms-item-ctl button:hover{background:#1E5A40;}'+
      '.cms-add{display:inline-flex;margin:14px 0;font:600 12px Pretendard,sans-serif;color:#1E5A40;background:transparent;border:1.5px dashed #1E5A40;border-radius:8px;padding:9px 16px;cursor:pointer;}'+
      '.cms-add:hover{background:rgba(30,90,64,.08);}'+
      '#cms-toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:99999;background:#1E5A40;color:#fff;padding:8px 16px;border-radius:999px;font:600 12px Pretendard,sans-serif;opacity:0;transition:opacity .2s;pointer-events:none;}#cms-toast.on{opacity:1;}'+
      '@media print{#cms-bar,#cms-toast,.cms-item-ctl,.cms-add{display:none!important;}}';
    document.head.appendChild(st);
    bar.querySelector(".cms-login").addEventListener("click",function(){ state.user?signOut():signIn(); });
    bar.querySelector(".cms-edit").addEventListener("click",function(){ setEditing(!state.editing); });
    renderBar();
    setSync(LIVE ? "offline" : "mock");
    if(DOC==="deck" || document.querySelector("deck-stage")) document.documentElement.classList.add("cms-deck");
  }
  function renderBar(){
    var login=bar.querySelector(".cms-login"), edit=bar.querySelector(".cms-edit"), mode=bar.querySelector(".cms-mode");
    mode.textContent = LIVE ? "" : "mock";
    if(state.user && canEdit(state.user.email)){ login.textContent="로그아웃"; edit.hidden=false; }
    else { login.textContent="편집 로그인"; edit.hidden=true; if(state.editing) setEditing(false); }
  }
  /* 동기화 상태 표시: 연결=초록, 저장중=맥박 */
  function setSync(stateName){
    var s=bar && bar.querySelector(".cms-sync"); if(!s) return;
    var label=s.querySelector("b");
    s.classList.remove("on","saving");
    if(stateName==="connected"){ s.classList.add("on"); label.textContent="동기화"; }
    else if(stateName==="saving"){ s.classList.add("on"); s.classList.add("saving"); label.textContent="저장…"; }
    else if(stateName==="saved"){ s.classList.add("on"); label.textContent="저장됨 ✓"; clearTimeout(setSync._t); setSync._t=setTimeout(function(){ if(state.connected) setSync("connected"); },1600); }
    else if(stateName==="mock"){ label.textContent="로컬 저장"; }
    else { label.textContent="오프라인"; }
  }
  function toast(m){ var t=document.getElementById("cms-toast"); if(!t){ t=document.createElement("div"); t.id="cms-toast"; document.body.appendChild(t);} t.textContent=m; t.classList.add("on"); clearTimeout(toastT); toastT=setTimeout(function(){ t.classList.remove("on"); },1400); }

  /* ---------- 부트 ---------- */
  function boot(){ loadOverrides(); buildBar();
    if(LIVE){
      var s=["app","auth","database"].map(function(m){ return "https://www.gstatic.com/firebasejs/10.12.2/firebase-"+m+"-compat.js"; });
      var i=0;(function next(){ if(i>=s.length){ initFb(); return; } var el=document.createElement("script"); el.src=s[i++]; el.onload=next; document.head.appendChild(el); })();
    }
  }
  function initFb(){
    firebase.initializeApp(FB); db=firebase.database(); loadOverrides();
    db.ref(".info/connected").on("value", function(s){
      state.connected = !!s.val();
      setSync(state.connected ? "connected" : "offline");
    });
    firebase.auth().onAuthStateChanged(function(u){ state.user=u?{email:u.email}:null; if(u&&!canEdit(u.email)) toast("편집 권한 없음: "+u.email); renderBar(); });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
})();
