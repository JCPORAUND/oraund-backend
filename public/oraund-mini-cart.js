// oraund-mini-cart.js — 모든 오라운트 페이지에 공통으로 붙이는 장바구니 말풍선
//
// 자동 동작:
//   - nav 안의 <a href="cart.html"> 를 찾아 말풍선 팝오버 + 숫자 배지를 붙인다
//   - localStorage.oraund_cart 를 읽어 아이템 목록을 보여준다
//   - 아이콘 클릭 시 팝오버 토글 (장바구니 비어있으면 정상 링크 동작)
//   - 바깥 클릭/Escape 시 닫힘
//   - type === 'wholesale' 아이템이 있으면 4kg 이상 여부를 표시
//
// 페이지에서 장바구니에 담은 직후 호출하면 말풍선이 자동으로 3.5초간 열림:
//   window.oraundCartAdded({justAddedIdx: N, autoCloseMs: 3500})
//
// 장바구니 변경 콜백 — 호스트 페이지가 자체 UI를 갱신하고 싶다면:
//   window.oraundCartChanged = function(){ /* 예: 현재 페이지의 kg 힌트 갱신 */ }

(function(){
  'use strict';
  if(window.__oraundMiniCartInit)return;
  window.__oraundMiniCartInit=true;

  var CART_KEY='oraund_cart';
  var MIN_WHOLESALE_KG=4;

  function readCart(){try{return JSON.parse(localStorage.getItem(CART_KEY)||'[]')}catch(e){return[]}}
  function writeCart(c){localStorage.setItem(CART_KEY,JSON.stringify(c))}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function parseKg(s){var m=(s||'').match(/(\d+)\s*kg/i);return m?parseInt(m[1],10):0}

  function init(){
    var cartLink=document.querySelector('a[href="cart.html"]');
    if(!cartLink)return;
    if(cartLink.closest('.nav-cart-wrap'))return; // 이미 초기화됨

    // 1. 아이콘을 wrap div로 감싸기
    var wrap=document.createElement('div');
    wrap.className='nav-cart-wrap';
    wrap.id='navCartWrap';
    cartLink.parentNode.insertBefore(wrap,cartLink);
    wrap.appendChild(cartLink);
    cartLink.id='navCartIcon';

    // 2. 숫자 배지
    var badge=document.createElement('span');
    badge.className='nav-cart-badge';
    badge.id='navCartBadge';
    badge.textContent='0';
    cartLink.appendChild(badge);

    // 3. 팝오버
    var pop=document.createElement('div');
    pop.className='mini-cart';
    pop.id='miniCart';
    pop.setAttribute('role','dialog');
    pop.setAttribute('aria-label','장바구니 미리보기');
    pop.innerHTML=[
      '<div class="mc-head"><span class="mc-title">장바구니</span><span class="mc-count" id="miniCartCount">0개</span></div>',
      '<div class="mc-body" id="miniCartBody"><div class="mc-empty">아직 담은 것이 없어요</div></div>',
      '<div class="mc-foot" id="miniCartFoot" style="display:none">',
        '<div class="mc-tot-row"><span class="mc-tot-label">합계</span><span class="mc-tot-val" id="miniCartTotal">0원</span></div>',
        '<div class="mc-tot-kg" id="miniCartKg" style="display:none"></div>',
        '<button class="mc-cta" id="miniCartCta" onclick="location.href=\'cart.html\'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>장바구니 보기</button>',
      '</div>'
    ].join('');
    wrap.appendChild(pop);

    // 4. 스타일 주입
    injectStyles();

    // 5. 이벤트
    cartLink.addEventListener('click',toggleMiniCart);
    document.addEventListener('click',function(e){
      if(!pop.classList.contains('vis'))return;
      if(!wrap.contains(e.target))closeMiniCart();
    },true);
    document.addEventListener('keydown',function(e){if(e.key==='Escape')closeMiniCart()});
    window.addEventListener('storage',function(e){if(e.key===CART_KEY)renderMiniCart()});

    // 6. 첫 렌더
    renderMiniCart();
  }

  function injectStyles(){
    if(document.getElementById('oraundMiniCartStyles'))return;
    var st=document.createElement('style');
    st.id='oraundMiniCartStyles';
    st.textContent=CSS;
    document.head.appendChild(st);
  }

  var CSS=[
    ".nav-cart-wrap{position:relative;display:inline-flex}",
    ".nav-cart-badge{position:absolute;top:-4px;right:-6px;min-width:18px;height:18px;border-radius:9px;background:#0ABAB5;color:#000;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 5px;line-height:1;transform:scale(0);transition:transform .3s cubic-bezier(.34,1.56,.64,1);pointer-events:none;box-shadow:0 2px 8px rgba(10,186,181,0.4)}",
    ".nav-cart-badge.vis{transform:scale(1)}",
    ".nav-cart-badge.bump{animation:orMcBadgeBump .5s cubic-bezier(.34,1.56,.64,1)}",
    "@keyframes orMcBadgeBump{0%{transform:scale(1)}40%{transform:scale(1.4)}100%{transform:scale(1)}}",
    ".nav-cart-wrap .nav-icon-link.active svg{color:#0ABAB5}",
    ".mini-cart{position:absolute;top:calc(100% + 14px);right:-10px;width:280px;max-height:420px;z-index:120;background:#fff;border:1px solid #e8e8ed;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,0.22);display:flex;flex-direction:column;overflow:visible;transform-origin:top right;transform:scale(0.85) translateY(-10px);opacity:0;pointer-events:none;transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;font-family:'Pretendard','Pretendard Variable','Noto Sans KR',-apple-system,sans-serif;color:#1d1d1f}",
    ".mini-cart.vis{transform:scale(1) translateY(0);opacity:1;pointer-events:auto}",
    ".mini-cart::before,.mini-cart::after{content:'';position:absolute;top:-8px;right:16px;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent}",
    ".mini-cart::before{border-bottom:8px solid #e8e8ed;top:-9px}",
    ".mini-cart::after{border-bottom:8px solid #fff}",
    ".mc-head{padding:12px 14px;border-bottom:1px solid #e8e8ed;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:8px;border-radius:14px 14px 0 0;overflow:hidden;background:#fff}",
    ".mc-title{font-size:11px;font-weight:700;letter-spacing:1px;color:#0ABAB5;text-transform:uppercase}",
    ".mc-count{font-size:11px;color:#6e6e73;font-weight:600}",
    ".mc-body{overflow-y:auto;flex:1;min-height:0;max-height:240px;background:#fff}",
    ".mc-item{padding:10px 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border-bottom:1px solid rgba(0,0,0,0.04);background:#fff}",
    ".mc-item:last-child{border-bottom:none}",
    ".mc-item.just-added{animation:orMcItemIn .6s cubic-bezier(.4,0,.2,1)}",
    "@keyframes orMcItemIn{0%{background:rgba(10,186,181,0.22);transform:translateX(14px)}100%{background:#fff;transform:translateX(0)}}",
    ".mc-info{min-width:0;flex:1}",
    ".mc-name{font-size:13px;font-weight:700;line-height:1.3;color:#1d1d1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mc-meta{font-size:11px;color:#86868b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mc-right{display:flex;align-items:center;gap:6px;flex-shrink:0}",
    ".mc-price{font-size:12px;font-weight:700;color:#1d1d1f;white-space:nowrap}",
    ".mc-rm{background:none;border:none;color:#86868b;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:4px;transition:all .2s;font-family:inherit}",
    ".mc-rm:hover{color:#e53935;background:rgba(229,57,53,0.08)}",
    ".mc-foot{padding:12px 14px;border-top:1px solid #e8e8ed;flex-shrink:0;background:rgba(10,186,181,0.05);border-radius:0 0 14px 14px}",
    ".mc-tot-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}",
    ".mc-tot-label{font-size:11px;color:#6e6e73;font-weight:600}",
    ".mc-tot-val{font-size:15px;font-weight:700;color:#1d1d1f}",
    ".mc-tot-kg{font-size:11px;color:#86868b;margin-bottom:8px;text-align:right}",
    ".mc-tot-kg.warn{color:#d57a00;font-weight:600}",
    ".mc-tot-kg.ok{color:#0a9e00;font-weight:600}",
    ".mc-cta{width:100%;padding:10px;border:none;border-radius:10px;background:#0ABAB5;color:#fff;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-family:inherit}",
    ".mc-cta:hover{background:#089E99}",
    ".mc-cta:disabled{background:#aaa;cursor:not-allowed}",
    ".mc-cta svg{width:14px;height:14px}",
    ".mc-empty{padding:24px 16px;font-size:12px;color:#86868b;text-align:center;line-height:1.6;background:#fff}",
    "@media(max-width:900px){.mini-cart{width:260px}}",
    "@media(max-width:680px){.mini-cart{width:86vw;max-width:300px;right:-4px}}",
    "@media(max-width:480px){.mini-cart{right:auto;left:50%;transform:scale(0.85) translateX(-50%) translateY(-10px);transform-origin:top center}.mini-cart.vis{transform:scale(1) translateX(-50%) translateY(0)}.mini-cart::before,.mini-cart::after{right:auto;left:calc(50% - 8px)}}"
  ].join('');

  function renderMiniCart(justAddedIdx){
    var cart=readCart();
    var body=document.getElementById('miniCartBody');
    var foot=document.getElementById('miniCartFoot');
    var count=document.getElementById('miniCartCount');
    var totalEl=document.getElementById('miniCartTotal');
    var kgEl=document.getElementById('miniCartKg');
    var badge=document.getElementById('navCartBadge');
    if(!body||!badge)return;

    if(!cart.length){
      body.innerHTML='<div class="mc-empty">아직 담은 것이 없어요</div>';
      foot.style.display='none';
      count.textContent='0개';
      badge.textContent='0';
      badge.classList.remove('vis');
      return;
    }

    var totalPrice=0,wholesaleKg=0,hasWholesale=false;
    var html='';
    cart.forEach(function(item,idx){
      var lineQty=item.qty||1;
      var lineTotal=item.total!=null?item.total:(item.price||0)*lineQty;
      totalPrice+=lineTotal;
      if(item.type==='wholesale'){
        hasWholesale=true;
        wholesaleKg+=parseKg(item.size)*lineQty;
      }
      var metaParts=[];
      if(item.size)metaParts.push(item.size);
      if(item.packaging)metaParts.push(item.packaging);
      else if(item.grind&&item.grind!=='이지드립'&&item.grind!=='생두(미로스팅)')metaParts.push(item.grind);
      if(lineQty>1)metaParts.push('× '+lineQty);
      var added=(idx===justAddedIdx)?' just-added':'';
      html+='<div class="mc-item'+added+'">'
        +'<div class="mc-info"><div class="mc-name">'+esc(item.name||'상품')+'</div>'
        +'<div class="mc-meta">'+esc(metaParts.join(' · '))+'</div></div>'
        +'<div class="mc-right"><span class="mc-price">'+lineTotal.toLocaleString()+'원</span>'
        +'<button class="mc-rm" onclick="window.removeMiniCartItem('+idx+')" aria-label="제거" title="제거">×</button></div>'
        +'</div>';
    });
    body.innerHTML=html;
    foot.style.display='';
    count.textContent=cart.length+'개';
    totalEl.textContent=totalPrice.toLocaleString()+'원';

    // 대량주문 kg 체크 (wholesale 아이템이 있을 때만)
    if(hasWholesale){
      kgEl.style.display='';
      if(wholesaleKg>=MIN_WHOLESALE_KG){
        kgEl.className='mc-tot-kg ok';
        kgEl.textContent='✓ 대량주문 '+wholesaleKg+'kg · 주문 가능';
      }else{
        kgEl.className='mc-tot-kg warn';
        kgEl.textContent='대량주문 '+wholesaleKg+'kg · '+(MIN_WHOLESALE_KG-wholesaleKg)+'kg 더 필요';
      }
    }else{
      kgEl.style.display='none';
    }

    badge.textContent=String(cart.length);
    badge.classList.add('vis');
    if(justAddedIdx!=null){
      badge.classList.remove('bump');
      void badge.offsetWidth;
      badge.classList.add('bump');
    }
  }

  function openMiniCart(){
    var el=document.getElementById('miniCart');
    if(el)el.classList.add('vis');
    var link=document.getElementById('navCartIcon');
    if(link)link.classList.add('active');
  }
  function closeMiniCart(){
    var el=document.getElementById('miniCart');
    if(el)el.classList.remove('vis');
    var link=document.getElementById('navCartIcon');
    if(link)link.classList.remove('active');
  }
  function toggleMiniCart(e){
    var cart=readCart();
    if(!cart.length)return; // 비어있으면 기본 링크 동작 (cart.html로 이동)
    if(e){e.preventDefault();e.stopPropagation()}
    var el=document.getElementById('miniCart');
    if(el&&el.classList.contains('vis'))closeMiniCart();
    else openMiniCart();
  }
  function removeMiniCartItem(idx){
    var cart=readCart();
    if(idx<0||idx>=cart.length)return;
    cart.splice(idx,1);
    writeCart(cart);
    renderMiniCart();
    if(typeof window.oraundCartChanged==='function'){
      try{window.oraundCartChanged()}catch(err){}
    }
  }

  // === Public API ===
  window.renderMiniCart=renderMiniCart;
  window.openMiniCart=openMiniCart;
  window.closeMiniCart=closeMiniCart;
  window.toggleMiniCart=toggleMiniCart;
  window.removeMiniCartItem=removeMiniCartItem;

  // 호스트 페이지가 아이템 담은 직후 호출:
  //   window.oraundCartAdded()                          — 마지막 아이템 하이라이트, 3.5초 뒤 자동 닫힘
  //   window.oraundCartAdded({justAddedIdx:N})          — 특정 인덱스 하이라이트
  //   window.oraundCartAdded({autoCloseMs:5000})        — 자동 닫힘 시간 조정
  //   window.oraundCartAdded({autoCloseMs:0})           — 자동 닫힘 끄기
  window.oraundCartAdded=function(opts){
    opts=opts||{};
    var cart=readCart();
    var idx=opts.justAddedIdx!=null?opts.justAddedIdx:(cart.length-1);
    renderMiniCart(idx);
    openMiniCart();
    clearTimeout(window.__oraundMcCloseT);
    var ms=opts.autoCloseMs!=null?opts.autoCloseMs:3500;
    if(ms>0)window.__oraundMcCloseT=setTimeout(closeMiniCart,ms);
  };

  // === Bootstrap ===
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  }else{
    init();
  }
})();
