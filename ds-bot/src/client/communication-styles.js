export const communicationCSS = `
.bt-comm-frame{position:fixed;inset:0;z-index:60;display:grid;grid-template-columns:288px minmax(0,1fr);background:var(--bt-main);color:var(--bt-ink);font:13px/18px var(--bt-font);pointer-events:auto;opacity:1;transition:opacity .16s ease}
.bt-comm-frame[data-closing=true]{opacity:0;pointer-events:none}
.bt-comm-frame *{box-sizing:border-box}
.bt-comm-frame h2{font-size:15px;line-height:20px;margin:0;font-weight:600}
.bt-comm-frame h3{font-size:13px;margin:8px 0}
.bt-comm-frame p{margin:6px 0;overflow-wrap:anywhere}
.bt-comm-frame button{min-height:32px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:6px 10px;font:inherit;text-align:left;cursor:pointer;transition:background .12s}
.bt-comm-frame button:hover{background:var(--bt-hover)}
.bt-comm-frame button:disabled{opacity:.4;cursor:default}
.bt-comm-frame :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-comm-frame :is(input:not([type=checkbox]),textarea,select){width:100%;min-width:0;border:1px solid var(--bt-line);border-radius:8px;padding:8px;background:var(--bt-card);color:var(--bt-ink);font:13px/18px var(--bt-font)}
.bt-comm-frame textarea{resize:vertical;min-height:72px;max-height:180px;font-size:14px;line-height:22px}
.bt-comm-frame code{font:12px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;user-select:text}
.bt-comm-frame .bt-comm-primary{background:var(--bt-accent);border-color:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-comm-frame .bt-comm-primary:hover{background:color-mix(in srgb,var(--bt-accent) 88%,var(--bt-main))}
.bt-comm-nav{background:var(--bt-sidebar);border-right:1px solid var(--bt-line);padding:20px 16px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;min-height:0}
.bt-comm-nav-heading{display:flex;flex-direction:column;align-items:flex-start;gap:10px}
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
.bt-comm-conversation-name{min-width:0}
.bt-comm-unread{flex-shrink:0;min-width:18px;text-align:center;padding:1px 5px;border-radius:12px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
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
.bt-comm-log:empty{display:none}
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
.bt-comm-check input{width:16px;height:16px;flex-shrink:0;margin-top:1px}
.bt-comm-mentions{display:flex;gap:4px;flex-wrap:wrap}
.bt-comm-pending-text{white-space:pre-wrap}
.bt-comm-members{flex-shrink:0;max-height:32vh;overflow:auto;overscroll-behavior:contain;border:1px solid var(--bt-line);border-radius:12px;padding:8px 12px}
.bt-comm-members[open]{position:absolute;inset:0 0 0 auto;width:min(520px,100%);max-height:none;z-index:3;padding:20px 16px;background:var(--bt-card);border-radius:0;border-width:0 0 0 1px;box-shadow:-12px 0 40px color-mix(in srgb,var(--bt-ink) 8%,transparent)}
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
.bt-comm-main>.bt-comm-error{flex-shrink:0;font-size:12px;line-height:18px;margin:0}
.bt-comm-main footer{flex-shrink:0;border-top:1px solid var(--bt-line);padding-top:8px}
.bt-comm-main footer>button{background:var(--bt-accent);color:var(--bt-accent-ink);text-align:center;padding-inline:18px}
.bt-comm-main footer>.bt-comm-reference{margin-left:12px}
.bt-comm-main footer .bt-comm-field:has(select){max-width:420px}
.bt-comm-status-help{margin-top:8px;font-size:12px;color:var(--bt-ink-2);max-height:112px;overflow:auto}
.bt-comm-status-help summary{font-weight:400}
.bt-comm-body>div{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-comm-log article[data-self=true] .bt-comm-reference{color:inherit;opacity:.8}
.bt-comm-frame .bt-comm-mobile{display:none}
@media(max-width:760px){
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

.bt-comm-pairing-guide pre{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;background:var(--bt-sidebar);padding:12px;border:1px solid var(--bt-line);border-radius:8px}
.bt-comm-pairing-guide li{margin:8px 0}
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
.bt-comm-completion{max-height:220px;overflow:auto;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);padding:6px}
.bt-comm-completion button{display:block;width:100%;border-color:transparent}
.bt-comm-completion button[aria-selected=true]{background:var(--bt-active)}
.bt-comm-feedback{max-height:140px;overflow:auto;border-top:1px solid var(--bt-line);font-size:12px}
.bt-comm-feedback:empty{display:none}
.bt-comm-heading>.bt-comm-avatar{float:left;width:36px;height:36px}

.bt-comm-log article .bt-comm-quote{display:flex;flex-direction:column;gap:2px;width:100%;margin:6px 0;padding:6px 10px;border:0;border-left:2px solid var(--bt-line-2);border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:12px;line-height:16px}
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
.bt-comm-manual-guide{margin-top:16px;border-top:1px solid var(--bt-line);padding-top:8px}
.bt-comm-set-card{padding:12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}

.bt-comm-avatar[data-kind=human][data-avatar="0"]{background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));color:var(--bt-accent)}
.bt-comm-avatar[data-kind=human][data-avatar="1"]{background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));color:var(--bt-ink)}
.bt-comm-avatar[data-kind=human][data-avatar="2"]{background:color-mix(in srgb,var(--bt-star) 14%,var(--bt-card));color:var(--bt-ink)}
.bt-comm-avatar[data-kind=human][data-avatar="3"]{background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
`
