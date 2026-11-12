export const communicationCSS = `
.bt-comm-presence{position:absolute;right:0;bottom:0;width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3);box-shadow:0 0 0 1.5px var(--bt-main);z-index:1}
.bt-comm-presence[data-bot-status=online]{background:var(--bt-green)}
.bt-comm-presence[data-bot-status=working]{background:var(--bt-danger)}

.bt-comm-participant-owner>p{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-comm-participant-owner small{color:var(--bt-ink-2)}
.bt-comm-participant-profile{padding:8px 0}
.bt-comm-participant-summary{white-space:pre-wrap}
.bt-comm-archive-notice{padding:0 24px;color:var(--bt-ink-2)}

.bt-comm-group-contact-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}
.bt-comm-group-contact .bt-comm-check{padding-left:28px;min-width:0}.bt-comm-choice-name{min-width:0;overflow-wrap:anywhere}
.bt-comm-invitations>button{display:flex;align-items:center;justify-content:space-between;width:100%;margin:4px 0}
.bt-comm-invitation-details dd{margin:4px 0 12px;overflow-wrap:anywhere}
.bt-comm-invitation-details li{margin:8px 0}
.bt-comm-invitation-details li code{display:block;color:var(--bt-ink-2)}


.bt-comm-attachments{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;max-width:100%}
.bt-comm-attachment{display:flex;flex-direction:column;gap:4px;max-width:240px;min-width:0}
.bt-comm-attachment img{max-width:100%;max-height:220px;object-fit:contain;border-radius:12px}
.bt-comm-attachment button{display:flex;align-items:center;gap:8px;max-width:100%;border:1px solid var(--bt-line-2);border-radius:12px;padding:8px;background:var(--bt-card);color:var(--bt-ink)}
.bt-comm-attachment button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-comm-attachment button small{flex:none;color:var(--bt-ink-3)}
.bt-comm-attach-picker{display:grid;place-items:center;cursor:pointer;width:30px;height:30px;flex:none;position:relative}
.bt-comm-attach-picker svg{width:18px;height:18px}
.bt-comm-attach-picker input{position:absolute;width:100%;height:100%;opacity:0;cursor:pointer}
.bt-comm-attachment-drafts{display:flex;flex-wrap:wrap;gap:6px;max-width:100%;font-size:12px}
.bt-comm-attachment-drafts>span{display:inline-flex;align-items:center;gap:4px;max-width:220px;overflow:hidden;word-break:break-all}
.bt-comm-attachment-drafts button{padding:2px;border:0;background:none;color:inherit}
.bt-comm-attachment-drafts svg{width:14px;height:14px}
.bt-comm-nav-heading .bt-comm-settings-icon{position:relative;width:32px;height:32px;padding:6px;display:grid;place-items:center;flex:none;background:none;border-color:transparent}
.bt-comm-request-badge{position:absolute;top:-4px;right:-4px;display:flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:10px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--bt-sidebar);pointer-events:none}
.bt-comm-nav-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:8px}
.bt-comm-nav-footer{flex:none;padding-top:8px;border-top:.5px solid var(--bt-line)}
.bt-comm-nav-footer>.bt-comm-back{width:100%}
.bt-comm-personal-settings>section{margin-top:16px;padding-top:12px;border-top:1px solid var(--bt-line)}
.bt-comm-personal-settings>section>button{margin:6px 8px 6px 0}
.bt-comm-thread-log{--reply-step:18px;min-width:0}
.bt-comm-thread-log ol{list-style:none;margin:0;padding:0;min-width:0}
.bt-comm-thread-log li{position:relative;min-width:0;padding-top:10px}
.bt-comm-thread-log .bt-comm-thread-branches>li{padding-left:var(--reply-step)}
.bt-comm-thread-branches>li::before{content:'';position:absolute;left:0;top:0;bottom:0;border-left:1px solid var(--bt-line-2);pointer-events:none}
.bt-comm-thread-branches>li:last-child::before{bottom:auto;height:34px}
.bt-comm-thread-branches>li::after{content:'';position:absolute;left:0;top:34px;width:var(--reply-step);border-top:1px solid var(--bt-line-2);pointer-events:none}
.bt-comm-thread-log .bt-comm-thread-branches>li[data-thread-deep=true]{padding-left:0}
.bt-comm-thread-branches>li[data-thread-deep=true]::before,.bt-comm-thread-branches>li[data-thread-deep=true]::after{display:none}
.bt-comm-thread-log article{position:relative;margin:0;padding:12px 16px;border-left:2px solid var(--bt-line-2);border-radius:12px;background:var(--bt-bubble);font-size:14px;line-height:24px;overflow-wrap:anywhere;min-width:0}
@media(max-width:600px){.bt-comm-thread-log{--reply-step:12px}.bt-comm-thread-log article{padding:10px}}
.bt-comm-thread-log article[data-thread-selected=true]{border-left-color:var(--bt-accent)}
.bt-comm-thread-parent{font-size:12px;line-height:16px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-comm-frame{position:fixed;inset:0;z-index:60;display:grid;grid-template-columns:min(var(--bt-comm-left-width,288px),calc(100vw - 420px)) minmax(0,1fr);background:var(--bt-main);color:var(--bt-ink);font:13px/18px var(--bt-font);pointer-events:auto;opacity:1;transition:opacity .16s ease}
.bt-comm-frame[data-closing=true]{opacity:0;pointer-events:none}
.bt-comm-frame *{box-sizing:border-box}
.bt-comm-frame h2{font-size:15px;line-height:20px;margin:0;font-weight:600}
.bt-comm-frame h3{font-size:13px;margin:8px 0}
.bt-comm-frame p{margin:6px 0;overflow-wrap:anywhere}
.bt-comm-frame button{min-height:32px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:6px 10px;font:inherit;text-align:left;cursor:pointer;touch-action:manipulation;transition:background-color .12s,color .12s,border-color .12s,opacity .12s,scale var(--bt-tap-duration,0ms) var(--bt-tap-easing,linear)}
.bt-comm-frame button:hover:not(:disabled):not([aria-disabled=true]){background:var(--bt-hover)}
.bt-comm-frame button:disabled{opacity:.4;cursor:default}
.bt-comm-frame :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-comm-frame :is(input:not([type=checkbox]):not([type=radio]),textarea,select){width:100%;min-width:0;border:1px solid var(--bt-line);border-radius:8px;padding:8px;background:var(--bt-card);color:var(--bt-ink);font:13px/18px var(--bt-font)}
.bt-comm-frame textarea{resize:vertical;min-height:72px;max-height:180px;font-size:14px;line-height:22px}
.bt-comm-frame code{font:12px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;user-select:text}
.bt-comm-frame .bt-comm-primary{background:var(--bt-accent);border-color:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-comm-frame .bt-comm-primary:hover{background:color-mix(in srgb,var(--bt-accent) 88%,var(--bt-main))}
.bt-comm-nav{position:relative;background:var(--bt-sidebar);border-right:1px solid var(--bt-line);padding:20px 16px;overflow:hidden;display:flex;flex-direction:column;gap:12px;min-height:0}
.bt-comm-nav-heading{display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
.bt-comm-frame .bt-comm-back{border-color:transparent;background:transparent;padding:4px 0;font-size:12px;color:var(--bt-ink-2)}
.bt-comm-connection{padding:12px;border:1px solid var(--bt-line);background:var(--bt-card);border-radius:12px}
.bt-comm-connection-label{display:flex;align-items:center;gap:8px;font-weight:500}
.bt-comm-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--bt-ink-3)}
.bt-comm-connection-label[data-connected=true] .bt-comm-dot{background:var(--bt-green)}
.bt-comm-connection>button{margin-top:6px;font-size:12px;min-height:28px}
.bt-comm-frame .bt-comm-identity summary{font-size:12px;color:var(--bt-ink-2)}
.bt-comm-start-actions{display:flex;gap:8px;flex-wrap:wrap}
.bt-comm-nav>.bt-comm-start-actions>button{flex:1;text-align:center}
.bt-comm-section-title{display:flex;justify-content:space-between;gap:8px;color:var(--bt-ink-2);font-size:12px;font-weight:500;margin-top:4px}
.bt-comm-nav nav{display:flex;flex-direction:column;gap:4px}
.bt-comm-nav nav button{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border-color:transparent;background:transparent;overflow-wrap:anywhere}
.bt-comm-nav nav button[aria-pressed=true]{background:var(--bt-active);border-color:var(--bt-line);font-weight:500}
.bt-comm-conversation-body{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.bt-comm-conversation-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:18px}
.bt-comm-conversation-preview{min-height:16px;line-height:16px;color:var(--bt-ink-2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-comm-nav nav .bt-comm-conversation-row{padding:8px;border-radius:10px;gap:10px;min-height:56px;justify-content:flex-start}
.bt-comm-nav nav .bt-comm-conversation-row[aria-pressed=true]{border-color:transparent}
.bt-comm-conversation-row>.bt-comm-avatar{margin-right:0}
.bt-comm-room-avatar{position:relative;display:inline-block;flex:none}
.bt-comm-room-avatar:not(.bt-comm-room-empty)>span{position:absolute;display:flex}
.bt-comm-room-avatar .bt-comm-avatar{margin:0}
.bt-comm-room-empty{display:grid;place-items:center;border-radius:12px;background:var(--bt-bubble);color:var(--bt-ink-2)}
.bt-comm-room-more{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:9px}
.bt-comm-toast{position:fixed;top:16px;right:24px;z-index:9;max-width:min(440px,calc(100vw - 32px));display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:0 8px 28px color-mix(in srgb,var(--bt-ink) 12%,transparent);font-size:12px;line-height:18px}
.bt-comm-toast>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-comm-toast>button{flex:none;font-size:12px;min-height:28px}
.bt-comm-activity>section{padding:10px 0;border-bottom:1px solid var(--bt-line)}
.bt-comm-admin-link small{display:block;font-size:11px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-comm-unread{flex:none;min-width:20px;padding:1px 6px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);margin-left:auto;text-align:center;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}
.bt-comm-frame summary{cursor:pointer;min-height:28px;padding:4px 0;font-weight:500}
.bt-comm-nav details>button{width:100%;margin:4px 0;overflow-wrap:anywhere}
.bt-comm-frame .bt-comm-contact{text-align:left;font-size:12px;line-height:18px}
.bt-comm-main{position:relative;min-width:0;min-height:0;display:flex;flex-direction:column;padding:20px 24px 16px;gap:12px}
.bt-comm-main header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-shrink:0}
.bt-comm-heading{flex:1;min-width:0;overflow-wrap:anywhere}
.bt-comm-main header>button{flex-shrink:0;font-size:12px}
.bt-comm-main header p{margin:4px 0 0}
.bt-comm-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;padding:24px;max-width:560px;margin:auto;color:var(--bt-ink-2)}
.bt-comm-empty h2{color:var(--bt-ink)}
.bt-comm-empty p{max-width:420px;margin:0;line-height:22px}
.bt-comm-empty-symbol{width:56px;height:56px;display:grid;place-items:center;border-radius:18px;background:var(--bt-bubble);color:var(--bt-ink-2);font-size:22px;line-height:34px}
.bt-comm-log{flex:1;min-height:80px;overflow:auto;overscroll-behavior:contain;padding:8px 0;scrollbar-gutter:stable}
.bt-comm-log:empty{display:block}
.bt-comm-log article{max-width:min(880px,90%);padding:12px 16px;border-radius:18px;background:var(--bt-bubble);margin:12px 0;overflow-wrap:anywhere;font-size:14px;line-height:24px}
.bt-comm-log article[data-self=true]{margin-left:auto;background:var(--bt-user);color:var(--bt-user-ink)}
.bt-comm-log article[data-failed=true]{outline:1px solid var(--bt-danger);outline-offset:2px}
.bt-comm-log article[data-referenced=true]{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-comm-log strong{font-size:12px;line-height:16px;font-weight:500}
.bt-comm-message-actions{display:flex;gap:12px;align-items:center;font-size:11px;line-height:16px;margin-top:8px}
.bt-comm-message-actions button{min-height:28px;padding:3px 8px;font-size:12px}
.bt-comm-reference,.bt-comm-event{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-comm-field{display:flex;flex-direction:column;gap:6px;margin:8px 0;font-size:12px;line-height:16px}
.bt-comm-check{display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.bt-comm-check input{flex:0 0 16px;width:16px;height:16px;flex-shrink:0;margin-top:1px}
.bt-comm-recipient-preview{display:flex;align-items:center;flex-wrap:nowrap;gap:4px 8px;max-height:108px;overflow:auto;margin-bottom:6px;font-size:12px;color:var(--bt-ink-2)}
.bt-comm-recipient-heading{flex:none}

.bt-comm-recipient-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;padding:2px 6px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-comm-recipient-chip>span:not(.bt-comm-avatar){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-comm-recipient-chip small{flex:none;color:var(--bt-ink-3)}
.bt-comm-mentions{display:flex;gap:4px;flex-wrap:wrap}
.bt-comm-pending-text{white-space:pre-wrap}
.bt-comm-members{flex-shrink:0;max-height:32vh;overflow:auto;overscroll-behavior:contain;border:1px solid var(--bt-line);border-radius:12px;padding:8px 12px}
.bt-comm-members[open]{position:absolute;inset:0 0 0 auto;width:min(var(--bt-comm-right-width,520px),100%);max-height:none;z-index:3;padding:20px 16px;background:var(--bt-card);border-radius:0;border-width:0 0 0 1px;box-shadow:-12px 0 40px color-mix(in srgb,var(--bt-ink) 8%,transparent)}
.bt-comm-members[open]>summary{padding-right:180px;min-height:36px;color:var(--bt-ink);font-size:14px;line-height:22px}
.bt-comm-settings-actions{position:sticky;top:0;z-index:1;display:flex;justify-content:flex-end;gap:8px;background:var(--bt-card);padding:4px 0;margin-top:-44px;margin-bottom:12px;max-width:max-content;margin-left:auto}
.bt-comm-settings-actions button[data-dirty=true]{color:var(--bt-danger);border-color:var(--bt-danger)}
.bt-comm-members>summary{color:var(--bt-ink-2)}
.bt-comm-members>.bt-comm-person{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--bt-line)}
.bt-comm-person>span:first-child{flex:1 1 200px;overflow-wrap:anywhere;font-weight:500}
.bt-comm-role{font-size:11px;line-height:16px;padding:2px 6px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-comm-person label{display:flex;flex-direction:column;gap:4px;min-width:120px;max-width:100%;flex:1 1 140px;font-size:12px;line-height:16px}
.bt-comm-person button{flex:0 1 auto;font-size:12px}
.bt-comm-members>.bt-comm-field{max-width:480px}
.bt-comm-members>button{margin:4px 8px 4px 0}
.bt-comm-frame .bt-comm-danger,.bt-comm-error{color:var(--bt-danger)}
.bt-comm-main footer{flex-shrink:0;border-top:1px solid var(--bt-line);padding-top:8px}
.bt-comm-main footer>button{background:var(--bt-accent);color:var(--bt-accent-ink);text-align:center;padding-inline:18px}
.bt-comm-main footer>.bt-comm-reference{margin-left:12px}
.bt-comm-main footer .bt-comm-field:has(select){max-width:420px}
.bt-comm-body>div,.bt-comm-body>div>div{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-comm-log article[data-self=true] .bt-comm-reference{color:inherit;opacity:.8}
.bt-comm-frame .bt-comm-mobile{display:none}
@media(max-width:760px){
  .bt-comm-resize{display:none!important}
  .bt-comm-frame{grid-template-columns:minmax(0,1fr)}
  .bt-comm-nav{border-right:0;padding:16px;gap:12px}
  .bt-comm-main{padding:12px;gap:10px}
  .bt-comm-frame[data-browse=true] .bt-comm-main{display:none}
  .bt-comm-frame[data-browse=false] .bt-comm-nav{display:none}
  .bt-comm-frame .bt-comm-mobile{display:block}
  .bt-comm-nav-heading{flex-direction:row;align-items:center;justify-content:space-between}
  .bt-comm-frame[data-setup=true] .bt-comm-main{display:flex}
  .bt-comm-frame[data-setup=true] .bt-comm-nav{display:none}
  .bt-comm-main header{flex-wrap:wrap;gap:8px}
  .bt-comm-heading{flex-basis:calc(100% - 130px);order:1}
  .bt-comm-main header>button:last-child{order:2}
  .bt-comm-main header>.bt-comm-mobile{flex-basis:auto}
  .bt-comm-log article{max-width:96%;padding:10px 12px}
  .bt-comm-main footer>.bt-comm-reference{display:block;margin:8px 0 0}
  .bt-comm-person>span:first-child{flex-basis:70%}
  .bt-comm-main footer textarea{max-height:120px}
}
@media(prefers-reduced-motion:reduce){.bt-comm-frame{transition:none}}

.bt-comm-avatar{width:28px;height:28px;flex:0 0 28px;display:inline-grid;place-items:center;border-radius:50%;background:var(--bt-bubble);color:var(--bt-ink);font:500 11px/16px var(--bt-font);vertical-align:middle;margin-right:8px}
.bt-comm-avatar::before{content:attr(data-initials)}
.bt-comm-avatar[data-avatar="1"]{background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-comm-avatar[data-avatar="2"]{border:1px solid var(--bt-line-2)}
.bt-comm-avatar[data-avatar="3"]{background:var(--bt-sidebar);border:1px solid var(--bt-line)}
.bt-comm-person-label{display:inline-flex;align-items:center;overflow-wrap:anywhere}
.bt-comm-modal-backdrop{position:absolute;inset:0;z-index:8;background:color-mix(in srgb,var(--bt-ink) 25%,transparent);display:grid;place-items:center;padding:24px}
.bt-comm-modal{width:min(560px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:24px;border-radius:16px;border:.5px solid var(--bt-line-2);background:var(--bt-card);box-shadow:0 12px 40px color-mix(in srgb,var(--bt-ink) 15%,transparent)}
.bt-comm-modal>button{margin:8px 8px 0 0}
.bt-comm-address{border-top:1px solid var(--bt-line);padding:8px 0}
.bt-comm-address button,.bt-comm-participant-picker>button{display:block;width:100%;margin:4px 0}
.bt-comm-mention-person{display:flex;align-items:center;gap:6px;min-width:0;text-align:left}
.bt-comm-mention-person .bt-comm-avatar{flex:none}
.bt-comm-mention-name,.bt-comm-mention-owner{overflow-wrap:anywhere;min-width:0}
.bt-comm-mention-owner{color:var(--bt-ink-2)}
.bt-comm-activation{display:flex;align-items:center;flex-wrap:nowrap;gap:4px 6px;font-size:11px;line-height:18px;color:var(--bt-ink-2);margin-top:4px;min-width:0}
.bt-comm-log article>.bt-comm-activation{grid-column:2;grid-row:3;padding:0 10px}
.bt-comm-bot-list{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex:0 1 auto}
.bt-comm-bot-chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:130px}
.bt-comm-bot-chip>span:last-child{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;min-width:0}
.bt-comm-bot-chip .bt-comm-avatar{flex-shrink:0}
.bt-comm-frame .bt-comm-bot-more{flex:none;min-height:24px;font-size:11px;line-height:18px;padding:2px 4px;background:none;border:0;color:var(--bt-ink-2);white-space:nowrap}
.bt-comm-bot-popover{box-sizing:border-box;position:fixed;z-index:50;overflow:auto;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);box-shadow:0 8px 28px color-mix(in srgb,var(--bt-ink) 18%,transparent);font-size:13px}
.bt-comm-bot-popover header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-comm-bot-popover ul{list-style:none;margin:8px 0 0;padding:0}
.bt-comm-bot-popover li{display:flex;align-items:center;gap:8px;padding:6px 0;overflow-wrap:anywhere}
.bt-comm-bot-popover li>span:last-child{min-width:0}
.bt-comm-bot-popover small{display:block;color:var(--bt-ink-2)}
.bt-comm-completion{max-height:220px;overflow:auto;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);padding:6px}
.bt-comm-completion button{display:block;width:100%;border-color:transparent}
.bt-comm-completion button[aria-selected=true]{background:var(--bt-active)}
.bt-comm-heading>.bt-comm-avatar{float:left;width:36px;height:36px}

.bt-comm-log article .bt-comm-quote{display:flex;flex-direction:column;gap:2px;width:100%;margin:6px 0;padding:6px 10px;border:0;border-left:2px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:6px;background:var(--bt-tag-bg);color:inherit;font-size:12px;line-height:16px}
/* Own bubbles can invert the page palette. Keep quoted text on that bubble's surface. */
.bt-comm-log article[data-self=true] .bt-comm-quote,.bt-comm-frame .bt-comm-log article[data-self=true] .bt-comm-quote:is(:hover,:active){background:transparent}
.bt-comm-frame .bt-comm-log article .bt-comm-quote:disabled{opacity:1}
.bt-comm-quote-author{font-weight:500}
.bt-comm-quote-text{overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.bt-comm-kind-icon{display:inline-block;margin-left:5px;font-size:11px;color:var(--bt-ink-3)}
.bt-comm-kind-icon::before{content:attr(data-symbol)}

.bt-comm-avatar>img{display:block;object-fit:cover;border-radius:50%;max-width:100%;max-height:100%}
.bt-comm-avatar:has(.bt-mark)::before,.bt-comm-avatar[data-has-image=true]::before{content:none}
.bt-comm-profile button{margin:8px 8px 0 0}
.bt-comm-profile button[data-dirty=true]{color:var(--bt-danger);border-color:var(--bt-danger)}
.bt-comm-profile-preview>img{object-fit:cover;border-radius:50%}

.bt-comm-onboarding button,.bt-comm-contact-manager button{margin:6px 8px 6px 0}
.bt-comm-admin-link{display:inline-block;margin:6px 8px 6px 0;color:var(--bt-accent)}
.bt-comm-storage-note{border:1px solid var(--bt-line);border-radius:8px;padding:10px;font-size:12px;line-height:18px}
.bt-comm-bot-choices{border:1px solid var(--bt-line);border-radius:8px;margin:12px 0;padding:8px 12px;min-width:0}
.bt-comm-bot-choices legend{font-size:12px;color:var(--bt-ink-2)}
.bt-comm-user-code{font:500 15px/20px ui-monospace,SFMono-Regular,monospace;user-select:all}
.bt-comm-set-card{padding:12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}

.bt-comm-avatar[data-kind=human][data-avatar="0"]{background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));color:var(--bt-accent)}
.bt-comm-avatar[data-kind=human][data-avatar="1"]{background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));color:var(--bt-ink)}
.bt-comm-avatar[data-kind=human][data-avatar="2"]{background:color-mix(in srgb,var(--bt-star) 14%,var(--bt-card));color:var(--bt-ink)}
.bt-comm-avatar[data-kind=human][data-avatar="3"]{background:var(--bt-tag-bg);color:var(--bt-tag-ink)}

.bt-comm-body .bt-comm-inline-mention{display:inline-flex;align-items:baseline;vertical-align:baseline;max-width:100%;min-height:0;padding:0 1px;border:0;background:none;color:var(--bt-accent);font:inherit;line-height:inherit;cursor:pointer;border-radius:6px;white-space:nowrap;text-decoration:none}
.bt-comm-mention-targets .bt-comm-inline-mention{margin-inline-end:6px}
.bt-comm-inline-mention-content{display:inline-flex;align-items:baseline;vertical-align:baseline;gap:3px;font:inherit;line-height:inherit}
.bt-comm-mention-label{font:inherit;line-height:inherit}
.bt-comm-inline-mention .bt-comm-avatar{flex:none;align-self:center;margin:0}
.bt-comm-inline-mention>svg{display:none}
.bt-comm-body .bt-comm-inline-mention:hover{text-decoration:underline}
.bt-comm-body .bt-comm-inline-mention:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-comm-work-started{display:flex;align-items:center;min-height:24px;margin:2px 0;padding-inline-start:40px;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-comm-work-started>button,.bt-comm-work-started>span{display:inline-flex;align-items:center;gap:4px;padding:4px 6px;border:0;border-radius:6px;background:none;color:inherit;font:inherit}
.bt-comm-work-started>button{cursor:pointer}
.bt-comm-work-started>button:hover{background:var(--bt-hover)}

/* Match the local sidebar, centered HeaderPill, transcript and compact composer.
   Remote identities and the independent receiving-policy panel stay explicit. */
.bt-comm-frame{grid-template-columns:min(var(--bt-comm-left-width,280px),calc(100vw - 420px)) minmax(0,1fr)}
.bt-comm-nav{padding:12px;gap:8px;border-right:.5px solid var(--bt-line-2)}
.bt-comm-nav-heading{height:36px;padding-inline:4px}
.bt-comm-nav-heading>h2{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.bt-comm-nav-actions{display:flex;align-items:center;gap:2px;flex:none}
.bt-comm-new-menu{position:relative}
.bt-comm-create-menu{position:absolute;top:calc(100% + 6px);right:0;width:200px;z-index:7;padding:5px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:0 6px 24px color-mix(in srgb,var(--bt-ink) 12%,transparent)}
.bt-comm-frame .bt-comm-create-menu>button{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:8px 10px;border:0;background:none;border-radius:8px}
.bt-comm-frame .bt-comm-create-menu>button:hover{background:var(--bt-hover)}
.bt-comm-frame[data-collapsed=true]{grid-template-columns:minmax(0,1fr)}
.bt-comm-frame[data-collapsed=true]>.bt-comm-nav{display:none}
.bt-comm-frame[data-collapsed=true]>.bt-comm-main{display:flex}
.bt-comm-search input{font-size:14px}
.bt-comm-search [role=listbox]{max-height:min(480px,55dvh);overflow:auto;padding:4px 0}
.bt-comm-frame .bt-comm-search [role=option]{display:flex;align-items:center;gap:10px;width:100%;min-height:49px;padding:8px;border:0;background:none}
.bt-comm-frame .bt-comm-search [role=option][aria-selected=true]{background:var(--bt-active)}
.bt-comm-search [role=option]>span:last-child{display:flex;flex-direction:column;gap:3px;min-width:0}
.bt-comm-search [role=option] :is(strong,small){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-comm-search [role=option] strong{font-size:13px;font-weight:500}
.bt-comm-search [role=option] small{font-size:12px;color:var(--bt-ink-2)}
.bt-comm-frame .bt-comm-back{padding:6px 8px;border-radius:10px;background:var(--bt-hover);text-align:center}
.bt-comm-connection{border:0;background:none;padding:0 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-comm-connection-label{flex:1;font-size:11px;color:var(--bt-ink-2);font-weight:400}
.bt-comm-connection-line{width:100%;min-width:0;display:flex;align-items:center;gap:6px}
.bt-comm-connection-line>.bt-comm-connection-label{min-width:0;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
.bt-comm-connection-line>[data-communication-versions]{min-width:0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink-2)}
.bt-comm-connection[data-compact=true]{flex-wrap:nowrap;min-height:20px}
.bt-comm-connection[data-compact=false]>.bt-comm-connection-line{flex-wrap:wrap}
.bt-comm-connection-details{display:none}
.bt-comm-connection>[data-communication-versions],.bt-comm-connection>[role=status]{flex-basis:100%;min-width:0}
.bt-comm-connection>button{padding:2px 6px;min-height:24px;margin:0;border:0;background:none;color:var(--bt-ink-2);font-size:11px}
.bt-comm-start-actions>button{display:inline-flex;justify-content:center;align-items:center;gap:5px}
.bt-comm-nav>.bt-comm-start-actions>button{border:0;background:none;font-size:12px;min-height:36px;padding:6px}
.bt-comm-nav>.bt-comm-start-actions>button:hover{background:var(--bt-hover)}
.bt-comm-section-title{padding:4px 8px;font-size:11px}
.bt-comm-nav nav .bt-comm-conversation-row{min-height:54px;gap:8px;border:0}
.bt-comm-nav nav .bt-comm-conversation-row[aria-pressed=true]{background:var(--bt-active)}
.bt-comm-main{padding:10px 0 16px;gap:0}
.bt-comm-main>header{position:relative;min-height:42px;padding:0 16px;gap:6px}
.bt-comm-heading.bt-head{height:42px;flex:1;min-width:0;justify-content:center;padding-left:70px}
.bt-comm-frame .bt-comm-title-pill{display:inline-flex;align-items:center;gap:8px;height:40px;min-height:40px;max-width:100%;padding:7px 12px 7px 7px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);box-shadow:0 2px 8px -1px color-mix(in srgb,var(--bt-ink) 6%,transparent);pointer-events:auto}
.bt-comm-title-pill h2{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-comm-title-pill>span:last-child{color:var(--bt-ink-3)}
.bt-comm-main>header>.bt-comm-icon-button{width:32px;height:32px;min-height:32px;padding:7px;border:0;background:none;display:grid;place-items:center;color:var(--bt-ink-2)}
.bt-comm-members:not([open]){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);padding:0;border:0}
.bt-comm-members[open]{z-index:4;width:min(var(--bt-comm-right-width,400px),100%)}
@media(min-width:1280px){.bt-comm-main:has(.bt-comm-members[open]){padding-right:var(--bt-comm-right-width,400px)}}
.bt-comm-log{padding:32px max(24px,calc((100% - 960px)/2));scrollbar-gutter:stable;scroll-padding:24px}
.bt-comm-log article{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:8px;row-gap:4px;max-width:100%;width:fit-content;min-width:100px;padding:0;margin:18px 0;background:none;border-radius:12px}
.bt-comm-log article>:is(.bt-comm-avatar,.bt-comm-avatar-button){grid-column:1;grid-row:2;align-self:end;margin:0}
.bt-comm-log article>strong{grid-column:2;grid-row:1;display:flex;align-items:center;gap:3px;padding:0 10px;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-comm-log article>.bt-comm-message-bubble{grid-column:2;grid-row:2;min-width:0;padding:7px 12px;border-radius:18px;background:var(--bt-bubble);overflow-wrap:anywhere}
.bt-comm-body p{margin:0}
.bt-comm-log article[data-self=true]{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:85%;background:none;color:var(--bt-ink)}
.bt-comm-log article[data-self=true]>.bt-comm-avatar,.bt-comm-log article[data-self=true]>strong{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.bt-comm-log article[data-self=true]>.bt-comm-message-bubble,.bt-comm-log article[data-self=true]>.bt-comm-pending-text{background:var(--bt-user);color:var(--bt-user-ink);border-radius:18px;padding:7px 12px;min-width:0;max-width:100%}
.bt-comm-log article[data-self=true]>.bt-comm-reference{color:var(--bt-ink-2)}
.bt-comm-message-actions{grid-column:2;grid-row:4;justify-content:flex-start;gap:6px;min-height:24px;margin:0;padding-inline:6px;color:var(--bt-ink-3)}
.bt-comm-message-actions button{border:0;background:none;min-height:24px;padding:2px 5px;color:var(--bt-ink-2);opacity:0;transition:opacity .12s}
.bt-comm-log article:is(:hover,:focus-within) .bt-comm-message-actions button{opacity:1}
.bt-comm-main>footer{margin-top:auto;position:relative;flex-shrink:0;width:calc(100% - 48px);max-width:960px;align-self:center;padding:8px 44px 8px 10px;border:.5px solid var(--bt-line-2);border-radius:22px;background:var(--bt-main);box-shadow:0 1px 4px color-mix(in srgb,var(--bt-ink) 4%,transparent)}
.bt-comm-main footer .bt-comm-compose-field{margin:0;display:block}
.bt-comm-frame .bt-comm-main footer .bt-comm-compose-field textarea{border:0;background:none;min-height:96px;max-height:240px;padding:0;font-size:14px;line-height:24px;resize:vertical;border-radius:0}
.bt-comm-frame footer textarea:focus-visible{outline:0}
.bt-comm-frame footer:focus-within{border-color:var(--bt-ink-3)}
.bt-comm-main footer>.bt-comm-send{position:absolute;right:8px;bottom:8px;width:32px;height:32px;min-height:32px;border:0;border-radius:50%;padding:8px;display:grid;place-items:center;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-comm-completion{position:absolute;bottom:calc(100% + 8px);left:0;width:min(420px,100%);box-shadow:0 4px 20px color-mix(in srgb,var(--bt-ink) 10%,transparent)}
.bt-comm-message-actions .bt-tool{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border-radius:8px}
.bt-comm-message-actions .bt-tool svg{width:16px;height:16px}
.bt-comm-message-actions .bt-tool:hover{background:var(--bt-hover)}
.bt-comm-thread article:is(:hover,:focus-within) .bt-comm-message-actions button{opacity:1}
.bt-comm-frame button:active:not(:disabled):not([aria-disabled=true]){background:var(--bt-active);scale:.96}
.bt-comm-frame button[aria-pressed=true]:hover:not(:disabled),.bt-comm-frame button[aria-expanded=true]:hover:not(:disabled){background:var(--bt-active)}
.bt-comm-frame button:is(:disabled,[aria-disabled=true]){cursor:default;scale:1;opacity:.4}
.bt-comm-frame button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-comm-thread-backdrop{background:transparent;display:block}
.bt-comm-thread-popover{position:fixed;width:min(880px,calc(100vw - 32px));height:min(800px,calc(100dvh - 32px));max-height:calc(100dvh - 16px);padding:16px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 32px color-mix(in srgb,var(--bt-ink) 16%,transparent)}
.bt-comm-thread-popover>.bt-comm-thread-close{position:absolute;right:8px;top:8px;width:28px;height:28px;min-height:28px;padding:6px;margin:0;border:0;background:transparent;display:grid;place-items:center}
.bt-comm-thread-close svg{width:16px;height:16px}
.bt-comm-thread-popover>.bt-comm-thread-heading{padding-right:32px;flex-shrink:0}
.bt-comm-thread-popover>.bt-comm-thread{overflow:auto;min-height:80px;flex:1}
.bt-comm-thread-composer{position:relative;border-top:1px solid var(--bt-line);padding-top:8px;flex-shrink:0}
.bt-comm-frame .bt-comm-thread-composer textarea[rows]{resize:vertical;box-sizing:border-box;min-height:110px;max-height:240px;padding:6px 44px 6px 8px;font-size:14px;line-height:24px}
.bt-comm-thread-composer>.bt-comm-send{position:absolute;right:6px;bottom:6px;width:32px;height:32px;padding:8px;border:0;border-radius:50%;display:grid;place-items:center;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-comm-thread-composer .bt-comm-completion{z-index:2}
.bt-comm-thread-send-error{font-size:12px;color:var(--bt-danger);padding-right:36px}
.bt-comm-frame .bt-comm-danger:hover:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card))}
.bt-comm-frame .bt-comm-danger:active:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 18%,var(--bt-card))}
.bt-comm-frame :is(.bt-comm-primary,.bt-comm-send):hover:not(:disabled){background:color-mix(in srgb,var(--bt-accent) 88%,var(--bt-main));color:var(--bt-accent-ink)}
.bt-comm-frame :is(.bt-comm-primary,.bt-comm-send):active:not(:disabled){background:color-mix(in srgb,var(--bt-accent) 76%,var(--bt-main))}
@media(prefers-reduced-motion:reduce){.bt-comm-frame button{transition:none}.bt-comm-frame button:active:not(:disabled){scale:1}}
@media(hover:none){.bt-comm-message-actions button{opacity:1}}
@media(pointer:coarse){.bt-comm-message-actions .bt-tool{width:40px;height:40px;min-height:40px;padding:11px}}
@media(max-width:760px){
 .bt-comm-frame{grid-template-columns:minmax(0,1fr)}
 .bt-comm-nav{padding:12px}
 .bt-comm-main{padding:8px 0 12px}
 .bt-comm-main>header{padding:0 8px;flex-wrap:nowrap}
 .bt-comm-heading.bt-head{padding-left:0;flex-basis:auto;order:0}
 .bt-comm-title-pill h2{font-size:13px}
 .bt-comm-log{padding:20px 12px}
 .bt-comm-main>footer{width:calc(100% - 24px)}
 .bt-comm-message-actions button{opacity:1}
 .bt-comm-log article[data-self=true]{max-width:94%}
}

.bt-comm-modal-head{position:sticky;top:-24px;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-24px -24px 16px;padding:16px 24px;border-bottom:1px solid var(--bt-line);background:var(--bt-card)}
.bt-comm-modal-head h2{min-width:0;overflow-wrap:anywhere}
.bt-comm-modal-actions{display:flex;align-items:center;gap:6px;flex:none}
.bt-comm-frame .bt-comm-modal-actions>button{display:inline-flex;align-items:center;gap:4px;margin:0;min-height:32px;padding:6px 8px}
.bt-comm-modal-actions svg{width:16px;height:16px}
.bt-comm-contacts-modal{width:min(680px,100%)}
.bt-comm-directory-heading{display:flex;align-items:center;gap:8px}
.bt-comm-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;padding:2px 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-comm-contact-card{min-width:0;margin:12px 0;padding:12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-main)}
.bt-comm-contact-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-comm-directory-person{display:inline-flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere}
.bt-comm-directory-person>.bt-comm-avatar{margin:0;flex:none}
.bt-comm-directory-person>span:last-child{display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-comm-directory-person strong{font-size:13px;line-height:18px;font-weight:500}
.bt-comm-directory-person small{font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-comm-contact-card h4{font-size:12px;line-height:16px;font-weight:500;margin:16px 0 8px;color:var(--bt-ink-2)}
.bt-comm-contact-bots{list-style:none;margin:0;padding:0}
.bt-comm-contact-bots>li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;min-width:0}
.bt-comm-frame .bt-comm-contact-card button{margin:0;flex:none;font-size:12px;line-height:16px}
.bt-comm-contact-info{margin-top:12px;padding-top:8px;border-top:1px solid var(--bt-line)}
.bt-comm-contact-info summary{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-comm-contact-info dl{display:grid;grid-template-columns:minmax(80px,1fr) minmax(0,2fr);gap:8px;font-size:12px;line-height:16px}
.bt-comm-contact-info dt{color:var(--bt-ink-2)}
.bt-comm-contact-info dd{margin:0;overflow-wrap:anywhere}
.bt-comm-bot-identities{list-style:none;padding:0;font-size:12px;line-height:16px;overflow-wrap:anywhere}
.bt-comm-bot-identities li{margin:8px 0}
.bt-comm-contact-section{margin-top:12px;padding:8px 0;border-top:1px solid var(--bt-line)}
.bt-comm-contact-section>summary{padding:6px 0;min-height:32px;font-size:13px;line-height:18px;font-weight:500;cursor:pointer}
.bt-comm-contact-section>summary .bt-comm-count{margin-left:8px}
.bt-comm-contact-info>summary{min-height:28px;padding:6px 0;cursor:pointer}
@media(max-width:600px){
 .bt-comm-modal-backdrop{padding:12px}
 .bt-comm-modal{padding:16px;max-height:calc(100dvh - 24px)}
 .bt-comm-modal-head{top:-16px;margin:-16px -16px 12px;padding:12px 16px;gap:8px}
 .bt-comm-modal-actions{gap:4px}
 .bt-comm-contact-info dl{grid-template-columns:minmax(0,1fr)}
 .bt-comm-contact-info dd{margin-bottom:4px}
 .bt-comm-thread-popover{max-height:calc(100dvh - 16px)}
}

.bt-comm-frame.bt-comm-dialog-layer{box-sizing:border-box;inset:0;margin:0;padding:24px;width:100%;height:100%;max-width:none;max-height:none;border:0;z-index:80;grid-template-columns:minmax(0,1fr);place-items:center;background:color-mix(in srgb,var(--bt-ink) 25%,transparent)}
.bt-comm-dialog-layer::backdrop{background:transparent}
.bt-comm-operation-dialog{display:flex;flex-direction:column;padding:0;max-height:calc(100dvh - 48px);overflow:hidden;animation:bt-comm-operation-enter var(--bt-pop-duration) var(--bt-pop-easing)}
.bt-comm-operation-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border-bottom:1px solid var(--bt-line);flex:none}
.bt-comm-operation-heading button{display:grid;place-items:center;border:0;padding:6px;flex:none}
.bt-comm-operation-heading svg{width:18px;height:18px}
.bt-comm-operation-body{overflow:auto;min-height:0;padding:16px 24px;overscroll-behavior:contain}
.bt-comm-operation-footer{flex:none;padding:12px 24px;border-top:1px solid var(--bt-line);background:var(--bt-card)}
.bt-comm-operation-buttons{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-comm-frame .bt-comm-operation-footer button{margin:0}
.bt-comm-dialog-layer[data-closing=true] .bt-comm-operation-dialog{animation:bt-comm-operation-exit .16s ease both}
.bt-comm-archive-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.bt-comm-archive-row>.bt-comm-conversation-row{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.bt-comm-archive-row>button:last-child{flex:none}
.bt-comm-archive-entry{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
@keyframes bt-comm-operation-enter{from{transform:translateY(12px) scale(.96);opacity:0}to{transform:none;opacity:1}}
@keyframes bt-comm-operation-exit{to{opacity:0}}
@media(max-width:600px){.bt-comm-frame.bt-comm-dialog-layer{padding:12px}.bt-comm-operation-dialog{max-height:calc(100dvh - 24px)}.bt-comm-operation-heading,.bt-comm-operation-body,.bt-comm-operation-footer{padding:12px 16px}}
@media(prefers-reduced-motion:reduce){.bt-comm-operation-dialog,.bt-comm-dialog-layer[data-closing=true] .bt-comm-operation-dialog{animation:none}}

.bt-comm-frame .bt-comm-avatar-button{padding:0;border:0;background:transparent;flex:none;min-width:28px;min-height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}.bt-comm-avatar-button .bt-comm-avatar{margin:0}
.bt-comm-history-result{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;margin:8px 0}
.bt-comm-history-result-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--bt-ink-2);font-size:12px;min-width:0}
.bt-comm-history-result-meta strong{color:var(--bt-ink);overflow-wrap:anywhere}
.bt-comm-history-excerpt{white-space:pre-wrap;overflow-wrap:anywhere;line-height:22px}
.bt-comm-history-excerpt mark{background:color-mix(in srgb,var(--bt-accent) 18%,var(--bt-card));color:inherit;border-radius:4px}
.bt-comm-history-pages{display:flex;justify-content:space-between;gap:8px;margin-top:12px}
.bt-comm-history-status{position:sticky;top:0;height:0;margin:0;z-index:1;pointer-events:none;text-align:center;color:var(--bt-ink-2);font-size:12px}
.bt-comm-resize{position:absolute;top:0;bottom:0;width:12px;cursor:col-resize;touch-action:none;z-index:5;outline-offset:-3px}
.bt-comm-resize::after{content:'';position:absolute;top:0;bottom:0;width:2px;background:transparent}
.bt-comm-resize:hover::after,.bt-comm-resize:focus-visible::after{background:var(--bt-accent)}
.bt-comm-resize-left{right:0}.bt-comm-resize-left::after{right:0}.bt-comm-resize-right{left:0}.bt-comm-resize-right::after{left:0}
.bt-comm-profile-section>summary{list-style-position:inside}
.bt-comm-profile-section>summary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:6px}
.bt-comm-profile-section>button{margin:6px 8px 6px 0}
.bt-comm-member-contact{margin:8px 0}
.bt-comm-member-bots{margin-left:24px;padding-left:12px;border-left:1px solid var(--bt-line)}
 .bt-comm-member-row{display:flex;align-items:center;gap:8px;min-height:44px;border-bottom:1px solid var(--bt-line);min-width:0;padding:6px 0}
.bt-comm-member-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.bt-comm-member-name .bt-comm-person-label{display:flex;min-width:0;overflow:hidden;white-space:nowrap}
.bt-comm-member-name .bt-comm-avatar{flex:none}
.bt-comm-member-actions{display:flex;align-items:center;gap:4px;flex:none}
.bt-comm-frame .bt-comm-member-actions select{width:auto;max-width:88px;padding:4px 2px;min-height:28px;font-size:11px}
.bt-comm-member-actions .bt-comm-role{font-size:11px;color:var(--bt-ink-2);max-width:76px}
.bt-comm-frame .bt-comm-member-icon{display:grid;place-items:center;width:28px;min-height:28px;height:28px;padding:4px;border:0;background:none;font-size:18px}
.bt-comm-member-icon svg{width:14px;height:14px}
.bt-comm-members[open]{padding:0;overflow:hidden}
.bt-comm-members[open]>summary{display:none}
.bt-comm-members-panel{position:absolute;inset:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-height:0;overflow:hidden;container:communication-members / inline-size}
.bt-comm-members-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px;border-bottom:1px solid var(--bt-line);flex:none}
.bt-comm-members-heading h2{font-size:13px}
.bt-comm-members-heading button{display:grid;place-items:center;width:28px;padding:4px;border:0}
.bt-comm-members-heading svg{width:16px;height:16px}
.bt-comm-members-body{padding:12px 16px;overflow:auto;min-height:0;flex:1;overscroll-behavior:contain}
.bt-comm-members-footer{flex:none;padding:12px;border-top:1px solid var(--bt-line)}
.bt-comm-members-footer .bt-comm-operation-buttons{gap:4px}
.bt-comm-members-footer button{font-size:12px}
.bt-comm-save-status{font-size:11px;color:var(--bt-ink-2);flex:1;min-width:90px}
@container communication-members (max-width:360px){.bt-comm-member-row{flex-wrap:wrap}.bt-comm-member-name{flex-basis:100%}.bt-comm-member-actions{max-width:100%;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}.bt-comm-frame .bt-comm-member-actions select{max-width:76px}}
@media(max-width:600px){.bt-comm-members-body{padding:8px}.bt-comm-member-bots{margin-left:12px;padding-left:6px}.bt-comm-member-actions select{max-width:80px}}

`
