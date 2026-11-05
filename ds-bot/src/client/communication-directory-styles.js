export const communicationDirectoryCSS = `
.bt-comm-directory-list .bt-comm-directory-filters{display:flex;flex-wrap:wrap;gap:4px;padding:4px;margin:12px 0 4px;border-radius:10px;background:var(--bt-sidebar)}
.bt-comm-directory-list .bt-comm-directory-filters button{display:inline-flex;align-items:center;gap:6px;flex:1;justify-content:center;margin:0;padding:6px 10px;border:1px solid transparent;border-radius:8px;background:transparent;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-comm-directory-list .bt-comm-directory-filters button[aria-pressed=true]{background:var(--bt-card);border-color:var(--bt-line);color:var(--bt-ink)}
.bt-comm-directory-list>.bt-comm-contact-card{margin:0;padding:16px 0;border:0;border-bottom:1px solid var(--bt-line);border-radius:0;background:transparent}
.bt-comm-directory-list>.bt-comm-contact-card:last-of-type{border-bottom:0}
.bt-comm-directory-list .bt-comm-directory-person{gap:12px}
.bt-comm-directory-list .bt-comm-directory-headline{font-size:12px;line-height:16px;color:var(--bt-ink)}
.bt-comm-directory-list .bt-comm-directory-about{margin:8px 0 0 48px;min-width:0}
.bt-comm-directory-list .bt-comm-directory-about>summary{display:flex;align-items:center;gap:8px;width:fit-content;cursor:pointer;min-height:28px;padding:4px 0;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-comm-directory-list .bt-comm-directory-about[open]>summary{color:var(--bt-ink)}
.bt-comm-directory-list .bt-comm-directory-profile{min-width:0;margin:8px 0 12px}
.bt-comm-directory-list .bt-comm-directory-summary{margin:0 0 8px;font-size:13px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.bt-comm-directory-list .bt-comm-directory-skills{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}
.bt-comm-directory-list .bt-comm-directory-skills>li{padding:2px 8px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;line-height:16px;overflow-wrap:anywhere;max-width:100%}
.bt-comm-directory-list .bt-comm-contact-bots>.bt-comm-directory-bot{display:block;padding:12px 0;border-top:1px solid var(--bt-line)}
.bt-comm-directory-list .bt-comm-directory-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.bt-comm-directory-list .bt-comm-directory-bot>.bt-comm-directory-profile{margin-left:48px;margin-bottom:0}
.bt-comm-directory-list .bt-comm-contact-info{margin-left:48px;border:0;padding-top:0;margin-top:4px}
.bt-comm-directory-list .bt-comm-directory-bot-list>h3{font-size:12px;line-height:16px;color:var(--bt-ink-2);margin:0 0 8px}
@media(max-width:480px){.bt-comm-directory-list .bt-comm-directory-about,.bt-comm-directory-list .bt-comm-contact-info{margin-left:0}.bt-comm-directory-list .bt-comm-directory-bot>.bt-comm-directory-profile{margin-left:0}.bt-comm-directory-list .bt-comm-directory-filters button{padding:6px}.bt-comm-directory-list .bt-comm-directory-person{gap:8px}}
`
