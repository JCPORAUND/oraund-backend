/**
 * oraund-chat.js — Shared chatbot module for all oraund.com pages
 *
 * A single drop-in script that provides the full chatbot + consultation-request
 * experience. Replaces per-page inline JS so the 10 storefront pages can be
 * updated in one place (this file) and deployed via Railway/git, not Cafe24.
 *
 *   <script defer src="https://oraund-backend-production.up.railway.app/oraund-chat.js"></script>
 *
 * Responsibilities:
 *   - Session management (UUID stored in sessionStorage, survives refresh)
 *   - POST /api/chat with {message, history, sessionId}
 *   - POST /api/consult with transcript + lead info
 *   - Injects consultation modal HTML + CSS (once)
 *   - "위 대화 내용으로 상담 요청하기" CTA bar (appears after first AI reply)
 *   - ESC-to-close, click-outside-to-close
 *   - Overrides any page-level inline sendMessage/addMessage/addMsg
 *
 * Required DOM elements on the host page (kept consistent across all 10 pages):
 *   #aiPanel, #chatMessages, #chatInput, #sendBtn
 *   #aiWelcome (optional — hidden on first message)
 *
 * Idempotent: safe to load twice (CSS/modal injection is guarded).
 */
(function () {
  'use strict';

  if (window.__oraundChatLoaded) return;
  window.__oraundChatLoaded = true;

  // ====== Config ======
  const BACKEND_URL = 'https://oraund-backend-production.up.railway.app';
  const STORAGE_KEY = 'oraund_chat';
  const HISTORY_CAP = 40;

  // ====== State ======
  let messages = [];
  let chatSessionId = null;

  // Restore previous session from sessionStorage (survives refresh, clears on tab close)
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      chatSessionId = data.sessionId || null;
      messages = Array.isArray(data.messages) ? data.messages : [];
    }
  } catch (e) { /* storage may be disabled */ }

  function persistChat() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId: chatSessionId,
        messages: messages.slice(-HISTORY_CAP),
      }));
    } catch (e) { /* ignore */ }
  }

  // ====== CSS injection (idempotent) ======
  function injectStyles() {
    if (document.getElementById('oraund-chat-styles')) return;
    const css = `
      /* ========== Right-side docked panel (desktop) ==========
       * Host-page CSS makes #aiPanel a fullscreen overlay. We override it
       * to a narrow right-docked panel so the page behind stays visible
       * and scrollable. Mobile keeps the fullscreen layout (via default
       * host-page rules).
       */
      @media (min-width: 769px) {
        #aiPanel.ai-panel {
          left: auto !important;
          width: 420px !important;
          max-width: 92vw !important;
          border-left: 1px solid rgba(255,255,255,0.08);
          box-shadow: -12px 0 40px rgba(0,0,0,0.45);
          background: rgba(10,10,10,0.97) !important;
        }
        /* Un-center inner sections — the host sets max-width:680px + margin:auto,
         * which leaves awkward whitespace inside a 420px panel. */
        #aiPanel .ai-panel-messages,
        #aiPanel .ai-panel-input,
        #aiPanel .ai-panel-consult-bar {
          max-width: none !important;
        }
        /* Slightly tighter padding inside narrow panel */
        #aiPanel .ai-panel-messages { padding: 20px !important; }
        #aiPanel .ai-panel-input    { padding: 14px 20px 20px !important; }
        /* Welcome chips wrap to 2-col inside a narrow panel */
        #aiPanel .ai-wchip { max-width: 46% !important; }
        /* Host page sets body{overflow:hidden} on panel open to lock scroll.
         * In side-panel mode we want the page behind to stay scrollable. */
        body:has(#aiPanel.ai-panel.active) { overflow: auto !important; }
        /* The floating mini-chat button would overlap the docked panel */
        body:has(#aiPanel.ai-panel.active) .ai-mini-btn { display: none !important; }
      }

      /* ========== In-bubble page-navigation chips ==========
       * When AI reply contains [label](https://oraund.com/...) URLs we render
       * these as clickable chips below the bubble. Click → navigate host page,
       * chat state is preserved via sessionStorage and auto-reopens on arrival.
       */
      .chat-nav-actions {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chat-nav-btn {
        background: #0abab5;
        color: #000;
        border: none;
        border-radius: 10px;
        padding: 9px 14px;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.2s;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .chat-nav-btn:hover:not(:disabled) {
        background: #30d5cf;
        box-shadow: 0 2px 10px rgba(10,186,181,0.4);
      }
      .chat-nav-btn:disabled {
        background: rgba(10,186,181,0.18);
        color: rgba(255,255,255,0.55);
        cursor: default;
      }

      .ai-panel-consult-bar {
        display: none;
        max-width: 680px;
        margin: 0 auto;
        width: 100%;
        padding: 10px 24px 0;
        box-sizing: border-box;
      }
      .ai-panel-consult-bar.active { display: block; }
      .consult-cta {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 12px 16px;
        background: rgba(10,186,181,0.12);
        border: 1px solid rgba(10,186,181,0.35);
        border-radius: 12px;
        color: #30d5cf;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      .consult-cta:hover {
        background: rgba(10,186,181,0.2);
        border-color: #0abab5;
        color: #fff;
      }
      .consult-cta .arrow { transition: transform 0.2s; display: inline-block; }
      .consult-cta:hover .arrow { transform: translateX(3px); }

      .consult-modal {
        position: fixed;
        inset: 0;
        z-index: 1200;
        background: rgba(0,0,0,0.75);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .consult-modal.active { display: flex; }
      .consult-modal-content {
        background: #111;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 18px;
        width: 100%;
        max-width: 440px;
        max-height: 90vh;
        overflow-y: auto;
        padding: 28px;
        color: #fff;
        font-family: inherit;
        box-sizing: border-box;
      }
      .consult-modal-content h3 {
        font-size: 18px;
        font-weight: 700;
        margin: 0 0 6px;
        color: #fff;
      }
      .consult-modal-content .consult-sub {
        font-size: 13px;
        color: rgba(255,255,255,0.5);
        margin-bottom: 20px;
        line-height: 1.5;
      }
      .consult-form label {
        display: block;
        font-size: 12px;
        color: rgba(255,255,255,0.7);
        margin: 12px 0 6px;
      }
      .consult-form label .req { color: #30d5cf; }
      .consult-form input,
      .consult-form textarea {
        width: 100%;
        padding: 11px 14px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        color: #fff;
        font-size: 14px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.2s;
        box-sizing: border-box;
      }
      .consult-form input:focus,
      .consult-form textarea:focus { border-color: #0abab5; }
      .consult-form textarea { resize: vertical; min-height: 64px; }
      .consult-form .row-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .consult-hint {
        font-size: 11px;
        color: rgba(255,255,255,0.35);
        margin-top: 14px;
        line-height: 1.5;
      }
      .consult-actions {
        display: flex;
        gap: 8px;
        margin-top: 20px;
      }
      .consult-btn-submit,
      .consult-btn-cancel {
        flex: 1;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
      }
      .consult-btn-submit {
        background: #0abab5;
        color: #000;
      }
      .consult-btn-submit:hover { background: #30d5cf; }
      .consult-btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
      .consult-btn-cancel {
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.7);
        border: 1px solid rgba(255,255,255,0.1);
      }
      .consult-btn-cancel:hover { background: rgba(255,255,255,0.1); }
      .consult-status {
        font-size: 13px;
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        display: none;
        line-height: 1.5;
      }
      .consult-status.error {
        display: block;
        background: rgba(220,38,38,0.1);
        border: 1px solid rgba(220,38,38,0.3);
        color: #fca5a5;
      }
      .consult-status.success {
        display: block;
        background: rgba(10,186,181,0.1);
        border: 1px solid rgba(10,186,181,0.3);
        color: #30d5cf;
      }
      @media (max-width: 768px) {
        .consult-modal-content { padding: 22px; border-radius: 16px; }
        .consult-form .row-2 { grid-template-columns: 1fr; }
        .ai-panel-consult-bar { padding: 8px 16px 0; }
        .consult-cta { font-size: 12px; padding: 11px 14px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'oraund-chat-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ====== Modal + consult-bar injection (idempotent) ======
  function injectConsultModal() {
    if (document.getElementById('consultModal')) return;
    const modal = document.createElement('div');
    modal.className = 'consult-modal';
    modal.id = 'consultModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'consultTitle');
    modal.innerHTML = `
      <div class="consult-modal-content">
        <h3 id="consultTitle">상담 요청하기</h3>
        <p class="consult-sub">위 대화 내용을 담당자에게 전달해드립니다.<br>영업일 기준 1일 이내 연락드려요.</p>
        <form class="consult-form" id="consultForm">
          <div class="row-2">
            <div>
              <label for="consultName">성함</label>
              <input type="text" id="consultName" name="name" autocomplete="name" maxlength="40">
            </div>
            <div>
              <label for="consultCompany">회사/매장명</label>
              <input type="text" id="consultCompany" name="company" autocomplete="organization" maxlength="60">
            </div>
          </div>
          <div class="row-2">
            <div>
              <label for="consultPhone">연락처 <span class="req">*</span></label>
              <input type="tel" id="consultPhone" name="phone" autocomplete="tel" placeholder="010-1234-5678" maxlength="20">
            </div>
            <div>
              <label for="consultEmail">이메일 <span class="req">*</span></label>
              <input type="email" id="consultEmail" name="email" autocomplete="email" placeholder="you@example.com" maxlength="80">
            </div>
          </div>
          <label for="consultNotes">추가 요청사항 (선택)</label>
          <textarea id="consultNotes" name="notes" rows="3" maxlength="500" placeholder="예상 구매량, 납품 시기, 궁금한 점 등"></textarea>
          <p class="consult-hint">* 연락처(전화) 또는 이메일 중 하나는 필수입니다.<br>입력하신 정보는 상담 응대 목적으로만 사용됩니다.</p>
          <div class="consult-status" id="consultStatus"></div>
          <div class="consult-actions">
            <button type="button" class="consult-btn-cancel" id="consultBtnCancel">취소</button>
            <button type="submit" class="consult-btn-submit">상담 요청 보내기</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire events
    modal.querySelector('#consultBtnCancel').addEventListener('click', closeConsultModal);
    modal.querySelector('#consultForm').addEventListener('submit', submitConsult);
  }

  // ====== Panel DOM injection (Option A — widget drop-in) ======
  // Some host pages (order / checkout / wholesale / sample pages) don't include
  // the full chatbot DOM — just the `<script src=oraund-chat.js>` tag. This
  // function creates the entire panel UI (mini button, panel, welcome chips,
  // input row) + its CSS from scratch when missing, so the chat survives
  // cross-page navigation from the AI's CTA chips.
  //
  // Idempotent: if #aiPanel already exists we skip DOM creation (the host
  // page owns the UI); if #oraund-panel-styles exists we skip CSS injection.
  // Uses color literals rather than var(--primary) because target pages may
  // not define the design-token CSS variables.
  function injectAiPanel() {
    // If the host page already rendered #aiPanel (full index page), trust
    // its own CSS + DOM and just wire up mini-btn / window.openAiPanel fallbacks
    // if missing. No CSS or DOM injection needed.
    //
    // If #aiPanel is missing (order / checkout pages), inject both panel CSS
    // AND the panel DOM from scratch — this is Option A's core purpose.
    const panelAlreadyExists = !!document.getElementById('aiPanel');

    // If we're about to inject fresh, hide any legacy chat UI that the order /
    // wholesale pages ship with (short-form IDs #aiP, #aiFloatBar, etc.).
    // Those legacy widgets use incompatible IDs (#chatIn instead of #chatInput)
    // and inline sendMsg() that bypasses our shared state. Hiding them rather
    // than removing means any inline onclick handlers can still no-op safely.
    if (!panelAlreadyExists && !document.getElementById('oraund-legacy-hide')) {
      const hide = document.createElement('style');
      hide.id = 'oraund-legacy-hide';
      hide.textContent = `
        .ai-p, .ai-float-bar, #aiP, #aiFloatBar {
          display: none !important;
        }
      `;
      document.head.appendChild(hide);
    }

    if (!panelAlreadyExists && !document.getElementById('oraund-panel-styles')) {
      const style = document.createElement('style');
      style.id = 'oraund-panel-styles';
      style.textContent = `
        /* Injected by oraund-chat.js for pages lacking panel CSS.
         * Scoped via #aiPanel so it won't collide with host rules. */
        #aiPanel.ai-panel {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          z-index: 1100;
          display: none;
          flex-direction: column;
          background: rgba(0,0,0,0.92);
          backdrop-filter: blur(30px);
          -webkit-backdrop-filter: blur(30px);
          font-family: 'Pretendard Variable', 'Pretendard', 'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif;
        }
        #aiPanel.ai-panel.active { display: flex; }
        #aiPanel .ai-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 24px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        #aiPanel .ai-panel-brand { display: flex; align-items: center; gap: 10px; }
        #aiPanel .ai-panel-brand .icon {
          width: 32px; height: 32px; border-radius: 10px;
          background: linear-gradient(135deg, #0abab5, #089e99);
          display: flex; align-items: center; justify-content: center;
          font-size: 16px; color: #000;
        }
        #aiPanel .ai-panel-brand .name {
          font-family: 'Montserrat', sans-serif;
          font-size: 16px; font-weight: 700; letter-spacing: 2px; color: #fff;
        }
        #aiPanel .ai-panel-brand .sub {
          font-size: 11px; color: rgba(255,255,255,0.4); letter-spacing: 0.5px;
        }
        #aiPanel .ai-panel-close {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          width: 36px; height: 36px;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; color: #fff; font-size: 20px;
          transition: all 0.2s;
        }
        #aiPanel .ai-panel-close:hover { background: rgba(255,255,255,0.15); }
        #aiPanel .ai-panel-messages {
          flex: 1; overflow-y: auto;
          padding: 24px; max-width: 680px; margin: 0 auto; width: 100%;
        }
        #aiPanel .chat-bubble {
          max-width: 85%;
          padding: 14px 18px;
          border-radius: 18px;
          margin-bottom: 12px;
          line-height: 1.6;
          font-size: 14px;
          white-space: pre-line;
        }
        #aiPanel .chat-bubble.user {
          background: #0abab5; color: #000;
          margin-left: auto; font-weight: 500;
          border-bottom-right-radius: 4px;
        }
        #aiPanel .chat-bubble.assistant {
          background: rgba(255,255,255,0.06);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.08);
          border-bottom-left-radius: 4px;
        }
        #aiPanel .chat-bubble.typing { color: rgba(255,255,255,0.4); }
        #aiPanel .chat-bubble.typing::after {
          content: ''; display: inline-block;
          width: 4px; height: 4px;
          background: #0abab5; border-radius: 50%;
          margin-left: 6px;
          animation: oraund-blink 1s infinite;
        }
        @keyframes oraund-blink { 0%,100%{opacity:.2} 50%{opacity:1} }
        #aiPanel .ai-welcome { text-align: center; padding: 48px 20px 32px; }
        #aiPanel .ai-welcome h3 { font-size: 20px; font-weight: 600; color: #fff; margin: 0 0 8px; }
        #aiPanel .ai-welcome p {
          font-size: 14px; color: rgba(255,255,255,0.45);
          line-height: 1.6; margin: 0;
        }
        #aiPanel .ai-welcome-chips {
          display: flex; flex-wrap: wrap; gap: 8px;
          justify-content: center; margin-top: 24px;
        }
        #aiPanel .ai-wchip {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 12px 16px; font-size: 13px;
          color: rgba(255,255,255,0.65);
          cursor: pointer; transition: all 0.2s;
          text-align: left; max-width: 200px;
          font-family: inherit;
        }
        #aiPanel .ai-wchip:hover {
          background: rgba(10,186,181,0.1);
          border-color: rgba(10,186,181,0.3);
          color: #3dd4cb;
        }
        #aiPanel .ai-wchip .emoji { font-size: 18px; display: block; margin-bottom: 6px; }
        #aiPanel .ai-panel-input {
          padding: 16px 24px 24px;
          border-top: 1px solid rgba(255,255,255,0.06);
          max-width: 680px; margin: 0 auto; width: 100%;
        }
        #aiPanel .ai-input-row {
          display: flex; gap: 10px; align-items: center;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 14px;
          padding: 4px 6px 4px 18px;
          transition: border-color 0.3s;
        }
        #aiPanel .ai-input-row:focus-within { border-color: rgba(10,186,181,0.5); }
        #aiPanel .ai-input-row input {
          flex: 1; padding: 14px 0; border: none;
          background: transparent; color: #fff;
          font-size: 15px; font-family: inherit; outline: none;
        }
        #aiPanel .ai-input-row input::placeholder { color: rgba(255,255,255,0.3); }
        #aiPanel .ai-send {
          width: 40px; height: 40px; border-radius: 10px;
          border: none; background: #0abab5; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.2s; flex-shrink: 0;
        }
        #aiPanel .ai-send:hover { background: #3dd4cb; }
        #aiPanel .ai-send:disabled { opacity: 0.3; cursor: not-allowed; }

        /* Floating mini chat button */
        .ai-mini-btn.oraund-injected {
          position: fixed;
          bottom: 28px; right: 28px;
          width: 56px; height: 56px;
          border-radius: 50%;
          background: linear-gradient(135deg, #0abab5, #089e99);
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          z-index: 998;
          box-shadow: 0 4px 24px rgba(10,186,181,0.4);
          transition: all 0.25s cubic-bezier(0.4,0,0.2,1);
        }
        .ai-mini-btn.oraund-injected:hover {
          transform: scale(1.08);
          box-shadow: 0 6px 32px rgba(10,186,181,0.6);
        }
        .ai-mini-btn.oraund-injected .mini-icon {
          font-size: 22px; color: #000; font-weight: 700;
        }
        @media (max-width: 768px) {
          .ai-mini-btn.oraund-injected { bottom: 20px; right: 20px; width: 50px; height: 50px; }
          #aiPanel .ai-panel-messages { padding: 16px; }
          #aiPanel .ai-panel-input { padding: 12px 16px 20px; }
          #aiPanel .ai-welcome-chips { gap: 6px; }
          #aiPanel .ai-wchip { max-width: 48%; padding: 10px 12px; font-size: 12px; }
        }
      `;
      document.head.appendChild(style);
    }

    // 2. Inject panel DOM if missing.
    if (!panelAlreadyExists) {
      const panel = document.createElement('div');
      panel.className = 'ai-panel';
      panel.id = 'aiPanel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.innerHTML = `
        <div class="ai-panel-header">
          <div class="ai-panel-brand">
            <div class="icon">✦</div>
            <div>
              <div class="name">ORAUND AI</div>
              <div class="sub">커피 전문가 · Powered by Anthropic Claude</div>
            </div>
          </div>
          <button class="ai-panel-close" type="button" aria-label="닫기">×</button>
        </div>
        <div class="ai-panel-messages" id="chatMessages">
          <div class="ai-welcome" id="aiWelcome">
            <h3>무엇을 도와드릴까요?</h3>
            <p>오라운트의 AI 커피 전문가가 취향에 맞는<br>원두와 커피를 추천해드립니다.</p>
            <div class="ai-welcome-chips">
              <div class="ai-wchip" data-chip="고소하고 묵직한 원두 추천해줘" tabindex="0" role="button">
                <span class="emoji">🫘</span>고소하고 묵직한 원두 추천
              </div>
              <div class="ai-wchip" data-chip="산뜻하고 과일향 나는 원두 뭐 있어?" tabindex="0" role="button">
                <span class="emoji">🍊</span>산뜻한 과일향 원두
              </div>
              <div class="ai-wchip" data-chip="핸드드립 커피 맛있게 내리는 방법 알려줘" tabindex="0" role="button">
                <span class="emoji">💧</span>핸드드립 내리는 법
              </div>
              <div class="ai-wchip" data-chip="이지드립 세트 어떤 맛으로 시작하면 좋아?" tabindex="0" role="button">
                <span class="emoji">📦</span>이지드립 추천
              </div>
              <div class="ai-wchip" data-chip="카페인 적은 커피 찾고 있어" tabindex="0" role="button">
                <span class="emoji">🌙</span>카페인 적은 커피
              </div>
              <div class="ai-wchip" data-chip="선물용 커피 세트 뭐가 좋아?" tabindex="0" role="button">
                <span class="emoji">🎁</span>선물용 커피 세트
              </div>
            </div>
          </div>
        </div>
        <div class="ai-panel-input">
          <div class="ai-input-row">
            <input type="text" id="chatInput" placeholder="오라운트 AI에게 물어보세요..." aria-label="오라운트 AI에게 물어보세요...">
            <button class="ai-send" id="sendBtn" type="button" aria-label="메시지 전송">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(panel);

      // Wire up the controls (host HTML uses inline onclick; ours uses listeners)
      panel.querySelector('.ai-panel-close').addEventListener('click', () => {
        if (typeof window.closeAiPanel === 'function') window.closeAiPanel();
      });
      panel.querySelector('#sendBtn').addEventListener('click', () => sendMessage());
      const input = panel.querySelector('#chatInput');
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendMessage();
        }
      });
      // Welcome chips → send prompt. Relies on data-chip attribute we set above.
      panel.querySelectorAll('.ai-wchip[data-chip]').forEach((chip) => {
        const text = chip.getAttribute('data-chip');
        chip.addEventListener('click', () => sendMessage(text));
        chip.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            sendMessage(text);
          }
        });
      });
    }

    // 3. Floating mini button if missing — opens the panel on click.
    if (!document.querySelector('.ai-mini-btn')) {
      const miniBtn = document.createElement('button');
      miniBtn.className = 'ai-mini-btn oraund-injected';
      miniBtn.type = 'button';
      miniBtn.setAttribute('aria-label', 'AI 커피 상담');
      miniBtn.innerHTML = `<span class="mini-icon">✦</span>`;
      miniBtn.addEventListener('click', () => {
        if (typeof window.openAiPanel === 'function') window.openAiPanel();
      });
      document.body.appendChild(miniBtn);
    }

    // 4. Define panel open/close if host didn't. Host versions may set
    //    body.overflow='hidden' for fullscreen layout; ours keeps scrolling
    //    enabled since we dock to the right on desktop (see injectStyles).
    if (typeof window.openAiPanel !== 'function') {
      window.openAiPanel = function () {
        const p = document.getElementById('aiPanel');
        if (!p) return;
        p.classList.add('active');
        setTimeout(() => {
          const inp = document.getElementById('chatInput');
          if (inp) inp.focus();
        }, 300);
      };
    }
    if (typeof window.closeAiPanel !== 'function') {
      window.closeAiPanel = function () {
        const p = document.getElementById('aiPanel');
        if (!p) return;
        p.classList.remove('active');
        // Restore any scroll-lock host pages may have set
        document.body.style.overflow = '';
      };
    }
  }

  // Inject the consult-bar CTA inside #aiPanel (above .ai-panel-input)
  function injectConsultBar() {
    if (document.getElementById('consultBar')) return;
    const panel = document.getElementById('aiPanel');
    if (!panel) return;
    const bar = document.createElement('div');
    bar.className = 'ai-panel-consult-bar';
    bar.id = 'consultBar';
    bar.innerHTML = `
      <button class="consult-cta" type="button" id="consultBarBtn" aria-label="위 대화 내용으로 상담 요청하기">
        <span>💬 위 대화 내용으로 상담 요청하기</span>
        <span class="arrow">→</span>
      </button>
    `;
    // Insert before .ai-panel-input if present, else append
    const input = panel.querySelector('.ai-panel-input');
    if (input) panel.insertBefore(bar, input);
    else panel.appendChild(bar);

    bar.querySelector('#consultBarBtn').addEventListener('click', openConsultModal);
  }

  function updateConsultBarVisibility() {
    const bar = document.getElementById('consultBar');
    if (!bar) return;
    const hasAssistant = messages.some(m => m.role === 'assistant');
    bar.classList.toggle('active', hasAssistant);
  }

  // ====== Page-navigation helpers ======
  // AI replies sometimes include `[label](https://oraund.com/…)` URLs pointing
  // to product/wholesale pages. We render these as nav-chip buttons so the
  // user can jump to the page without leaving the chat.

  // Extract oraund.com links from AI text (markdown [label](url) + bare URLs)
  function extractOraundLinks(text) {
    if (!text) return [];
    const out = [];
    const md = /\[([^\]\n]+)\]\((https?:\/\/(?:www\.)?oraund\.com\/[^\s)]+)\)/g;
    let m;
    while ((m = md.exec(text)) !== null) {
      out.push({ label: m[1].trim(), url: m[2] });
    }
    // Also catch bare URLs not wrapped in markdown
    const bare = /(?<!\()https?:\/\/(?:www\.)?oraund\.com\/[^\s)]+/g;
    while ((m = bare.exec(text)) !== null) {
      const u = m[0].replace(/[.,]$/, '');
      if (!out.some(o => o.url === u)) out.push({ label: '페이지 열기', url: u });
    }
    return out;
  }

  // Strip markdown link syntax [label](url) from display text — keep just label
  function stripLinkMarkdown(text) {
    if (!text) return text;
    return text.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, '$1');
  }

  // Compare two URLs by pathname (host-insensitive — handles localhost rewrite)
  function isSameDestination(currentHref, targetUrl) {
    try {
      const a = new URL(currentHref);
      const b = new URL(targetUrl);
      return a.pathname === b.pathname;
    } catch (e) { return false; }
  }

  // Local-dev accommodation: when testing on localhost, rewrite oraund.com
  // URLs to same-origin so sessionStorage persists across the navigation.
  function rewriteForLocalhost(url) {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost')) {
      return url.replace(/^https?:\/\/(?:www\.)?oraund\.com/i, location.origin);
    }
    return url;
  }

  function navigateToPage(url) {
    try {
      sessionStorage.setItem(STORAGE_KEY + '_autoopen', '1');
    } catch (e) {}
    window.location.href = rewriteForLocalhost(url);
  }

  // Render the chip buttons below an assistant bubble
  function renderNavActions(bubbleEl, links) {
    if (!bubbleEl || !links || !links.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-nav-actions';
    links.forEach(({ label, url }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-nav-btn';
      const here = isSameDestination(location.href, rewriteForLocalhost(url));
      if (here) {
        btn.textContent = '✓ ' + label + ' (현재 페이지)';
        btn.disabled = true;
      } else {
        btn.textContent = '📄 ' + label + ' →';
        btn.addEventListener('click', () => navigateToPage(url));
      }
      wrap.appendChild(btn);
    });
    bubbleEl.appendChild(wrap);
  }

  // After navigation, re-open the panel automatically on arrival
  function maybeAutoOpenPanel() {
    try {
      if (sessionStorage.getItem(STORAGE_KEY + '_autoopen') !== '1') return;
      sessionStorage.removeItem(STORAGE_KEY + '_autoopen');
    } catch (e) { return; }
    // Let host page finish its own boot, then open panel + hide welcome
    setTimeout(() => {
      hideWelcome();
      if (typeof window.openAiPanel === 'function') {
        window.openAiPanel();
      } else {
        const panel = document.getElementById('aiPanel');
        if (panel) panel.classList.add('active');
      }
    }, 250);
  }

  // ====== UI helpers ======
  function getMessagesDiv() {
    return document.getElementById('chatMessages');
  }

  // Detect which bubble class the host page uses (.chat-bubble vs .ai-chat-bubble)
  function getBubbleClassBase() {
    // Prefer existing bubbles as the source of truth
    const existing = document.querySelector('.ai-chat-bubble, .chat-bubble');
    if (existing) {
      return existing.classList.contains('ai-chat-bubble') ? 'ai-chat-bubble' : 'chat-bubble';
    }
    // Fallback: look at stylesheet rules — default to chat-bubble
    return 'chat-bubble';
  }

  function appendBubble(role, content, extraCls) {
    const div = getMessagesDiv();
    if (!div) return null;
    const base = getBubbleClassBase();
    const b = document.createElement('div');
    b.className = `${base} ${role}` + (extraCls ? ' ' + extraCls : '');
    // AI replies: strip [label](url) markdown so only the label is visible,
    // then render nav-action chips below the bubble (handled by caller).
    b.textContent = role === 'assistant' ? stripLinkMarkdown(content) : content;
    div.appendChild(b);
    div.scrollTop = div.scrollHeight;
    return b;
  }

  function hideWelcome() {
    const welcome = document.getElementById('aiWelcome');
    if (welcome) welcome.style.display = 'none';
  }

  // Rebuild chat UI from restored messages (called after DOM ready)
  function restoreChatUI() {
    if (!messages.length) return;
    const div = getMessagesDiv();
    if (!div) return;
    // Clear any existing bubbles to avoid double-render if page also rendered them
    // (only clear children that are our bubble class; leave welcome untouched)
    const base = getBubbleClassBase();
    div.querySelectorAll('.' + base).forEach(n => n.remove());
    hideWelcome();
    for (const m of messages) {
      const b = document.createElement('div');
      b.className = `${base} ${m.role}`;
      b.textContent = m.role === 'assistant' ? stripLinkMarkdown(m.content) : m.content;
      if (m.role === 'assistant') {
        const links = extractOraundLinks(m.content);
        renderNavActions(b, links);
      }
      div.appendChild(b);
    }
    div.scrollTop = div.scrollHeight;
    updateConsultBarVisibility();
  }

  // ====== Public API — overrides any pre-existing inline funcs ======
  function addMessage(role, content) {
    messages.push({ role, content, ts: Date.now() });
    const bubble = appendBubble(role, content);
    if (role === 'assistant' && bubble) {
      const links = extractOraundLinks(content);
      renderNavActions(bubble, links);
    }
    persistChat();
    updateConsultBarVisibility();
  }

  async function sendMessage(explicitText) {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');

    // Accept explicit text from callers like chip buttons:
    //   sendMessage('산뜻한 과일향 원두')
    // Falls back to reading #chatInput.value for the normal send-button flow.
    let message;
    if (typeof explicitText === 'string' && explicitText.trim()) {
      message = explicitText.trim();
      if (input) input.value = '';
    } else {
      if (!input) return;
      message = input.value.trim();
      if (!message) return;
      input.value = '';
    }

    hideWelcome();
    if (sendBtn) sendBtn.disabled = true;

    addMessage('user', message);

    // Typing indicator
    const div = getMessagesDiv();
    let typing = null;
    if (div) {
      const base = getBubbleClassBase();
      typing = document.createElement('div');
      typing.className = `${base} assistant typing`;
      typing.id = 'typingBubble';
      typing.textContent = '생각하는 중';
      div.appendChild(typing);
      div.scrollTop = div.scrollHeight;
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: messages, sessionId: chatSessionId }),
      });
      if (!response.ok) throw new Error('서버 응답 오류');
      const data = await response.json();
      if (data.sessionId) {
        chatSessionId = data.sessionId;
        persistChat();
      }
      if (typing) typing.remove();
      addMessage('assistant', data.reply);
    } catch (err) {
      console.error('[oraund-chat] send error:', err);
      if (typing) typing.remove();
      addMessage('assistant', '죄송합니다. 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  }

  function openConsultModal() {
    injectConsultModal();
    const modal = document.getElementById('consultModal');
    if (!modal) return;
    modal.classList.add('active');
    const status = document.getElementById('consultStatus');
    if (status) {
      status.className = 'consult-status';
      status.textContent = '';
    }
    setTimeout(() => {
      const nameInput = document.getElementById('consultName');
      if (nameInput) nameInput.focus();
    }, 100);
  }

  function closeConsultModal() {
    const modal = document.getElementById('consultModal');
    if (modal) modal.classList.remove('active');
  }

  async function submitConsult(e) {
    if (e && e.preventDefault) e.preventDefault();
    const form = (e && e.target) || document.getElementById('consultForm');
    if (!form) return;
    const status = document.getElementById('consultStatus');
    const submitBtn = form.querySelector('.consult-btn-submit');

    const payload = {
      sessionId: chatSessionId,
      name:    form.elements['name'].value.trim(),
      phone:   form.elements['phone'].value.trim(),
      email:   form.elements['email'].value.trim(),
      company: form.elements['company'].value.trim(),
      notes:   form.elements['notes'].value.trim(),
      transcript: messages.map(m => ({
        role: m.role,
        content: m.content,
        ts: m.ts || Date.now(),
      })),
    };

    if (!payload.phone && !payload.email) {
      status.className = 'consult-status error';
      status.textContent = '연락처(전화) 또는 이메일 중 하나는 필수입니다.';
      return;
    }
    if (!payload.transcript.length) {
      status.className = 'consult-status error';
      status.textContent = '상담 요청할 대화 내용이 없습니다. 먼저 AI와 대화를 시작해주세요.';
      return;
    }
    if (!payload.sessionId) {
      status.className = 'consult-status error';
      status.textContent = '대화 세션이 비어있습니다. 새로고침 후 다시 시도해주세요.';
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = '전송중...';
    status.className = 'consult-status';
    status.textContent = '';

    try {
      const response = await fetch(`${BACKEND_URL}/api/consult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        status.className = 'consult-status success';
        status.textContent = '✓ 상담 요청이 접수되었습니다. 영업일 기준 1일 이내 연락드립니다.';
        form.reset();
        setTimeout(closeConsultModal, 2500);
      } else {
        throw new Error(data.error || '서버 응답 오류');
      }
    } catch (err) {
      console.error('[oraund-chat] consult error:', err);
      status.className = 'consult-status error';
      status.textContent = '전송 중 오류가 발생했습니다. 잠시 후 다시 시도하거나 info@oraund.com 으로 직접 연락해주세요.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  // ====== Global exports — override pre-existing inline functions ======
  // Both `addMessage` (new pages) and `addMsg` (legacy pages) route to same impl.
  window.sendMessage      = sendMessage;
  window.addMessage       = addMessage;
  window.addMsg           = addMessage;
  window.openConsultModal = openConsultModal;
  window.closeConsultModal = closeConsultModal;
  window.submitConsult    = submitConsult;

  // Welcome-screen chip buttons on the rendered HTML use onclick="askChip('...')".
  // The inline function isn't defined anywhere in our shared module, so chips
  // were silently no-op-ing. Route them into sendMessage(explicitText).
  window.askChip = (text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    return sendMessage(text);
  };

  // -- Header subtitle patch ---------------------------------------------
  // The rendered Cafe24 HTML says "커피 전문가 · Powered by AI" in the
  // AI panel header. Rewrite to attribute Claude specifically.
  function patchHeader() {
    // Scope: <div class="sub"> directly next to <div class="name">ORAUND AI</div>
    const subs = document.querySelectorAll('.ai-panel .sub, #aiPanel .sub, .sub');
    subs.forEach((el) => {
      if (el.__oraundHeaderPatched) return;
      const txt = (el.textContent || '').trim();
      if (/Powered by AI\b/i.test(txt) || /커피 전문가\s*·\s*Powered by AI/i.test(txt)) {
        el.textContent = '커피 전문가 · Powered by Anthropic Claude';
        el.__oraundHeaderPatched = true;
      }
    });
  }

  // -- Chip rewire -------------------------------------------------------
  // The rendered Cafe24 HTML has MALFORMED onclicks on the chip buttons —
  // the opening quote is missing: onclick="askChip(고소하고 묵직한 원두 추천해줘')"
  // That's a SyntaxError, so the browser compiles onclick to `null` and
  // clicks silently no-op even with window.askChip defined. We can't fix
  // the source HTML from here (it's rendered server-side by Cafe24), so
  // we rewire: strip the broken onclick and attach a real click listener.
  //
  // Regex tolerates both malformed `askChip(text')` and well-formed
  // `askChip('text')` / `askChip("text")` patterns, so this is a no-op
  // if someone fixes the HTML later.
  function rewireChips() {
    const chips = document.querySelectorAll('[onclick*="askChip"]');
    chips.forEach((chip) => {
      if (chip.__oraundWired) return;
      const attr = chip.getAttribute('onclick') || '';
      // Match askChip( ... ) and pull the inner text, tolerating missing quotes
      const m = attr.match(/askChip\s*\(\s*['"]?([^'")]*)['"]?\s*\)/);
      const text = m ? m[1].trim() : '';
      chip.removeAttribute('onclick');
      if (!text) return;
      chip.__oraundWired = true;
      chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        sendMessage(text);
      });
    });
  }

  // Also expose a namespaced object for explicit calls
  window.oraundChat = {
    send: sendMessage,
    addMessage,
    openConsult: openConsultModal,
    closeConsult: closeConsultModal,
    getSessionId: () => chatSessionId,
    getMessages: () => messages.slice(),
    reset: () => {
      messages = [];
      chatSessionId = null;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
      const div = getMessagesDiv();
      if (div) div.innerHTML = '';
      updateConsultBarVisibility();
    },
  };

  // ====== Boot ======
  function boot() {
    injectStyles();
    // injectAiPanel must run before injectConsultBar (which requires #aiPanel),
    // before restoreChatUI (which writes into #chatMessages), and before
    // maybeAutoOpenPanel (which calls openAiPanel).
    injectAiPanel();
    injectConsultModal();
    injectConsultBar();
    restoreChatUI();
    patchHeader();
    rewireChips();
    maybeAutoOpenPanel();

    // Chips and header can be re-rendered when the AI panel toggles or
    // when the welcome screen is shown/hidden. Observe body-level mutations
    // and re-run both. Idempotent via the __oraundWired / __oraundHeaderPatched flags.
    try {
      const mo = new MutationObserver(() => {
        patchHeader();
        rewireChips();
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['onclick'] });
    } catch (e) { /* older browser — boot-time rewire still happened */ }

    // Global listeners (attach once)
    // Click outside modal → close
    document.addEventListener('click', (e) => {
      const modal = document.getElementById('consultModal');
      if (modal && modal.classList.contains('active') && e.target === modal) {
        closeConsultModal();
      }
    });
    // ESC: close modal first, then AI panel
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const modal = document.getElementById('consultModal');
      if (modal && modal.classList.contains('active')) {
        closeConsultModal();
        return;
      }
      const panel = document.getElementById('aiPanel');
      if (panel && panel.classList.contains('active') && typeof window.closeAiPanel === 'function') {
        window.closeAiPanel();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
