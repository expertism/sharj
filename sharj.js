// ==UserScript==
// @name            Sharj
// @description     Bulk delete your Discord messages with filters and rate-limit handling
// @version         1.2.0
// @author          expertism
// @match           https://*.discord.com/app
// @match           https://*.discord.com/channels/*
// @match           https://*.discord.com/login
// @license         MIT
// @namespace       https://github.com/expertism/sharj
// @icon            https://expertism.github.io/sharj/owo.png
// @grant           none
// ==/UserScript==
(function () {
    'use strict';
    const VERSION = "1.2.0";
    const DEFAULT_SEARCH_DELAY = 50;
    const DEFAULT_DELETE_DELAY = 50;
    const DEFAULT_BACKOFF_MS = 1000;
    const MAX_BACKOFF_MS = 60000;
    const BATCH_DELAY = 200;
    const COOLDOWN_MULT = 1.2;
    const PREFIX = '[SHARJ]';
    const routeRateLimits = new Map();

    function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

    function parseRetryMs(val) {
        if (val == null) return NaN;
        const n = Number(val);
        if (Number.isFinite(n)) return n < 1000 ? Math.ceil(n * 1000) : Math.ceil(n);
        const f = parseFloat(val);
        if (Number.isFinite(f)) return f < 1000 ? Math.ceil(f * 1000) : Math.ceil(f);
        return NaN;
    }

    async function getRetryMs(resp) {
        if (!resp || !resp.headers) return NaN;
        const headerCandidates = ['retry-after', 'x-ratelimit-reset-after', 'x-ratelimit-reset'];
        for (const h of headerCandidates) {
            const v = resp.headers.get(h);
            if (v) {
                const ms = parseRetryMs(v);
                if (Number.isFinite(ms)) return ms;
            }
        }
        try {
            const clone = resp.clone();
            const json = await clone.json();
            const candidate = json.retry_after ?? json.retry_after_ms;
            const ms = parseRetryMs(candidate);
            if (Number.isFinite(ms)) return ms;
        } catch (e) {
            console.warn(PREFIX, `Could not parse rate limit from response body: ${e.message}`);
        }
        return NaN;
    }

    async function safeFetch(url, opts = {}, attempt = 0) {
        const method = (opts.method || 'GET').toUpperCase();
        let routeKey;
        try { routeKey = method + ' ' + new URL(url, location.origin).pathname; } catch { routeKey = method + ' ' + url; }

        const now = Date.now();
        const globalBlock = routeRateLimits.get('__GLOBAL__') || 0;
        if (globalBlock > now) {
            console.warn(PREFIX, `Global rate limit active, waiting ${globalBlock - now}ms`);
            await delay(globalBlock - now);
        }
        const routeBlock = routeRateLimits.get(routeKey) || 0;
        if (routeBlock > now) {
            console.warn(PREFIX, `Route ${routeKey} rate-limited, waiting ${routeBlock - now}ms`);
            await delay(routeBlock - now);
        }

        try {
            const res = await fetch(url, opts);
            if (res && res.status === 429) {
                let retryMs = await getRetryMs(res);
                if (!Number.isFinite(retryMs)) retryMs = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
                const jitter = Math.round((Math.random() - 0.5) * 0.2 * retryMs);
                retryMs = Math.max(100, retryMs + jitter);
                const isGlobal = res.headers.get('x-ratelimit-global') === 'true' || !!res.headers.get('x-ratelimit-global');
                if (isGlobal) routeRateLimits.set('__GLOBAL__', Date.now() + retryMs);
                else routeRateLimits.set(routeKey, Date.now() + retryMs);
                console.warn(PREFIX, `429 received for ${method} ${url} — backing off ${retryMs}ms (attempt ${attempt})`);
                await delay(retryMs);
                return safeFetch(url, opts, attempt + 1);
            }
            if (res && res.status >= 500 && attempt < 3) {
                const backoff = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
                let apiMsg = '';
                try { apiMsg = (await res.clone().json()).message || ''; } catch (e) { }
                console.warn(PREFIX, `${res.status} ${apiMsg || 'Server error'} — retrying in ${backoff}ms`);
                await delay(backoff + Math.random() * 500);
                return safeFetch(url, opts, attempt + 1);
            }
            return res;
        } catch (e) {
            if (attempt < 3) {
                const backoff = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
                console.warn(PREFIX, `Network error (${e}). Retrying in ${backoff}ms`);
                await delay(backoff + Math.random() * 250);
                return safeFetch(url, opts, attempt + 1);
            }
            console.error(PREFIX, 'safeFetch final error', e);
            return null;
        }
    }

    async function findChannels(authToken, guildId, channelId) {
        const headers = { 'Authorization': authToken };
        const collected = [channelId];
        if (!guildId || guildId === '@me') return collected;
        try {
            const chInfo = await safeFetch(`https://discord.com/api/v10/channels/${channelId}`, { headers });
            if (chInfo && chInfo.ok) {
                const ch = await chInfo.json();
                const type = ch.type;
                if (type === 15 || type === 16) {
                    console.log(PREFIX, `Channel ${channelId} is a forum/media channel (type ${type}), fetching posts...`);
                    try {
                        const r = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=100`, { headers });
                        if (r && r.ok) {
                            const j = await r.json();
                            if (j && j.threads) collected.push(...j.threads.map(t => t.id));
                        }
                    } catch (e) {
                        console.warn(PREFIX, `Error fetching forum posts: ${e.message}`);
                    }
                    try {
                        const r = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/threads/search?archived=true&sort_by=last_message_time&sort_order=desc&limit=100`, { headers });
                        if (r && r.ok) {
                            const j = await r.json();
                            if (j && j.threads) collected.push(...j.threads.map(t => t.id));
                        }
                    } catch (e) {
                        console.warn(PREFIX, `Error fetching archived forum posts: ${e.message}`);
                    }
                }
                if (type === 2 || type === 13) {
                    console.log(PREFIX, `Channel ${channelId} is a voice/stage channel (type ${type}), will search directly`);
                }
            }
        } catch (e) {
            console.warn(PREFIX, `Error fetching channel info for ${channelId}: ${e.message}`);
        }
        try {
            const r = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/threads/active`, { headers });
            if (r && r.ok) {
                const j = await r.json();
                if (j && j.threads) collected.push(...j.threads.map(t => t.id));
            } else if (r && r.status !== 403 && r.status !== 404) {
                let apiMsg = '';
                try { apiMsg = (await r.clone().json()).message || ''; } catch (e) { }
                console.warn(PREFIX, `Failed to fetch active threads: ${r.status} ${apiMsg}`);
            }
        } catch (e) {
            console.warn(PREFIX, `Error fetching active threads for channel ${channelId}: ${e.message}`);
        }
        try {
            const r = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/threads/archived/public?limit=100`, { headers });
            if (r && r.ok) {
                const j = await r.json();
                if (j && j.threads) collected.push(...j.threads.map(t => t.id));
            } else if (r && r.status !== 403 && r.status !== 404) {
                let apiMsg = '';
                try { apiMsg = (await r.clone().json()).message || ''; } catch (e) { }
                console.warn(PREFIX, `Failed to fetch public archived threads: ${r.status} ${apiMsg}`);
            }
        } catch (e) {
            console.warn(PREFIX, `Error fetching public archived threads for channel ${channelId}: ${e.message}`);
        }
        try {
            const r = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/threads/archived/private?limit=100`, { headers });
            if (r && r.ok) {
                const j = await r.json();
                if (j && j.threads) collected.push(...j.threads.map(t => t.id));
            } else if (r && r.status !== 403 && r.status !== 404) {
                let apiMsg = '';
                try { apiMsg = (await r.clone().json()).message || ''; } catch (e) { }
                console.warn(PREFIX, `Failed to fetch private archived threads: ${r.status} ${apiMsg}`);
            }
        } catch (e) {
            console.warn(PREFIX, `Error fetching private archived threads for channel ${channelId}: ${e.message}`);
        }
        try {
            const r = await safeFetch(`https://discord.com/api/v10/guilds/${guildId}/threads/active`, { headers });
            if (r && r.ok) {
                const j = await r.json();
                if (j && j.threads) collected.push(...j.threads.filter(t => t.parent_id === channelId).map(t => t.id));
            }
        } catch (e) {
            console.warn(PREFIX, `Error fetching guild active threads: ${e.message}`);
        }
        console.log(PREFIX, `Found ${collected.length} channels/threads for ${channelId}`);
        return Array.from(new Set(collected));
    }

    var themeCss = `#sharj{--blurple:#5865F2;--blurple-hover:#4752C4;--danger:#ED4245;--success:#3BA55C;--glass-bg:#1a1b1e;--glass-bg-rgba:rgba(0,0,0,0.85);--glass-sidebar:rgba(20,20,25,0.9);--glass-border:rgba(255,255,255,0.15);--glass-shadow:0 8px 32px 0 rgba(0,0,0,0.6);--text-primary:#FFF;--text-secondary:#D0D0D0;--font-display:'Inter',system-ui,sans-serif;--input-bg:rgba(0,0,0,0.4)}@keyframes slideIn{from{opacity:0;transform:translateY(-20px) scale(0.98)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes neonPulse{0%{box-shadow:0 0 5px var(--blurple),0 0 10px var(--blurple)}50%{box-shadow:0 0 10px var(--blurple),0 0 20px var(--blurple)}100%{box-shadow:0 0 5px var(--blurple),0 0 10px var(--blurple)}}#sharj.browser{box-shadow:var(--glass-shadow)!important;border:1px solid var(--glass-border)!important;overflow:hidden;background-color:var(--glass-bg-rgba)!important;-webkit-backdrop-filter:blur(16px)!important;backdrop-filter:blur(16px)!important;border-radius:12px!important;animation:slideIn .3s cubic-bezier(.4,0,.2,1)}#sharj.container,#sharj .container{background-color:transparent!important;border-radius:8px;box-sizing:border-box;cursor:default;flex-direction:column}#sharj .header{background:linear-gradient(90deg,rgba(88,101,242,0.1),transparent)!important;border-bottom:1px solid var(--glass-border)!important;height:60px!important;align-items:center;min-height:60px!important;padding:0 20px;display:flex;color:var(--text-primary)!important;cursor:grab}#sharj .header .icon{color:var(--blurple)!important;margin-right:12px;flex-shrink:0;width:24;height:24;filter:drop-shadow(0 0 4px rgba(88,101,242,0.4));transition:transform .3s ease}#sharj .header .icon:hover{color:#fff!important;transform:scale(1.1) rotate(5deg)}#sharj .header h3{font-size:16px;line-height:20px;font-weight:700!important;font-family:var(--font-display)!important;color:#fff!important;flex-shrink:0;margin-right:16px;text-shadow:0 2px 4px rgba(0,0,0,0.3)}#sharj .spacer{flex-grow:1}#sharj .header .vert-divider{width:1px;height:24px;background-color:var(--glass-border)!important;margin-right:16px;flex-shrink:0}#sharj legend,#sharj label{color:var(--text-secondary)!important;font-size:11px;line-height:16px;font-weight:700!important;text-transform:uppercase;cursor:default;font-family:var(--font-display)!important;margin-bottom:8px;letter-spacing:.5px}#sharj .multiInput{display:flex;align-items:center;font-size:16px;box-sizing:border-box;width:100%;border-radius:6px!important;color:#fff!important;background-color:var(--input-bg)!important;border:1px solid var(--glass-border)!important;transition:all .2s ease-in-out}#sharj .multiInput :first-child{flex-grow:1}#sharj .multiInput button:last-child{margin-right:4px}#sharj .input{font-size:16px;width:100%;transition:all .2s ease-in-out;padding:10px;height:44px;background-color:var(--input-bg)!important;border:1px solid var(--glass-border)!important;border-radius:6px!important;box-sizing:border-box;color:#fff!important}#sharj fieldset{margin-top:16px;border:none}#sharj .input-wrapper{display:flex;align-items:center;font-size:16px;box-sizing:border-box;width:100%;border-radius:6px!important;color:#fff!important;background-color:var(--input-bg)!important;border:1px solid var(--glass-border)!important;transition:all .2s ease-in-out}#sharj input[type="text"],#sharj input[type="search"],#sharj input[type="password"],#sharj input[type="datetime-local"],#sharj input[type="number"],#sharj input[type="range"]{background-color:transparent!important;border:none!important;border-radius:0!important;box-sizing:border-box;color:#fff!important;font-size:16px;height:100%;padding:10px;width:100%}#sharj input:focus,#sharj .input-wrapper:focus-within,#sharj .multiInput:focus-within{border-color:var(--blurple)!important;box-shadow:0 0 0 2px rgba(88,101,242,0.25)!important;background-color:rgba(0,0,0,0.6)!important}#sharj .divider,#sharj hr{border:none;margin-bottom:24px;padding-bottom:4px;border-bottom:1px solid var(--glass-border)!important}#sharj .sectionDescription{margin-bottom:16px;color:var(--text-secondary)!important;font-size:14px;line-height:20px;font-weight:400}#sharj a{color:#00AFF4!important;text-decoration:none;font-weight:500}#sharj a:hover{text-decoration:underline}#sharj .btn,#sharj button{position:relative;display:flex;-webkit-box-pack:center;justify-content:center;-webkit-box-align:center;align-items:center;box-sizing:border-box;background:linear-gradient(135deg,var(--blurple),var(--blurple-hover))!important;border:none!important;border-radius:4px!important;font-size:14px;font-weight:600!important;line-height:16px;padding:2px 16px;user-select:none;width:60px;height:32px;min-width:60px;min-height:32px;color:#fff!important;transition:all .2s;opacity:1;box-shadow:0 2px 5px rgba(0,0,0,0.2)}#sharj button:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(88,101,242,0.4)!important;filter:brightness(1.1)}#sharj button:active{transform:translateY(0);box-shadow:none!important}#sharj button:disabled{opacity:.5;cursor:not-allowed;filter:grayscale(1)}#sharj .sizeMedium{width:96px;height:38px;min-width:96px;min-height:38px}#sharj .sizeMedium.icon{width:38px;min-width:38px;background:transparent!important;border:1px solid var(--glass-border)!important}#sharj .sizeMedium.icon:hover{background:rgba(255,255,255,0.1)!important}#sharj sup{vertical-align:top}#sharj .accent{background:linear-gradient(135deg,var(--blurple),var(--blurple-hover))!important;border:none!important}#sharj .danger{background:linear-gradient(135deg,var(--danger),#c03537)!important;border:none!important}#sharj .danger:hover{box-shadow:0 4px 12px rgba(237,66,69,0.4)!important}#sharj .positive{background:linear-gradient(135deg,var(--success),#2d7d46)!important}#sharj .info{font-size:12px;line-height:16px;padding:8px 10px;color:var(--text-secondary)!important}#sharj .scroll::-webkit-scrollbar{width:8px;height:8px}#sharj .scroll::-webkit-scrollbar-corner{background-color:transparent}#sharj .scroll::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid transparent;border-radius:4px;background-color:rgba(255,255,255,0.2)!important;min-height:40px}#sharj .scroll::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,0.3)!important}#sharj .scroll::-webkit-scrollbar-track{border-color:transparent!important;background-color:rgba(0,0,0,0.2)!important;border:2px solid transparent!important}#sharj progress{appearance:none;-webkit-appearance:none;height:8px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,0.1)!important}#sharj progress::-webkit-progress-bar{background-color:rgba(255,255,255,0.1)!important}#sharj progress::-webkit-progress-value{background:linear-gradient(90deg,var(--blurple),#00b0f4,var(--blurple))!important;background-size:200% 100%!important;animation:neonPulse 2s infinite linear;box-shadow:0 0 10px var(--blurple)}#sharj .log{margin-bottom:.25em;font-family:'Consolas',monospace;font-size:13px}#sharj .log-debug{color:#EEE!important}#sharj .log-info{color:#00b0f4!important}#sharj .log-verb{color:#aaa!important}#sharj .log-warn{color:#faa61a!important}#sharj .log-error{color:#f04747!important}#sharj .log-success{color:#43b581!important}#sharj *{color:#FFF!important;box-sizing:border-box}#sharj .col{display:flex;flex-direction:column}#sharj .row{display:flex;flex-direction:row;align-items:center}#sharj .mb1{margin-bottom:8px}#sharj.redact .priv{display:none!important}#sharj.redact x:not(:active){color:transparent!important;background-color:var(--primary-700)!important;cursor:default;user-select:none}#sharj.redact x:hover{position:relative}#sharj.redact x:hover::after{content:"Redacted information (Streamer mode: ON)";position:absolute;display:inline-block;top:-32px;left:-20px;padding:4px;width:150px;font-size:8pt;text-align:center;white-space:pre-wrap;background-color:var(--background-floating);-webkit-box-shadow:var(--elevation-high);box-shadow:var(--elevation-high);color:var(--text-default);border-radius:5px;pointer-events:none}#sharj.redact [priv]{-webkit-text-security:disc!important}#sharj :disabled{display:none}#sharj-btn{opacity:1!important;visibility:visible!important;z-index:9999!important}#sharj-btn:hover{color:var(--interactive-active)!important}`;
    var mainCss = `#sharj-btn{position:relative;width:auto;height:20px;margin:0 8px;cursor:pointer;color:var(--interactive-normal);flex:0 0 auto}#sharj-btn progress{position:absolute;top:20px;left:-2px;width:24px;height:10px;display:none}#sharj-btn.running{color:var(--button-danger-background)!important}#sharj-btn.running progress{display:block}#sharj{position:fixed;z-index:100;top:58px;right:10px;display:flex;flex-direction:column;width:800px;height:80vh;min-width:610px;max-width:100vw;min-height:448px;max-height:100vh;color:var(--text-normal);border-radius:4px;background-color:var(--background-secondary);box-shadow:var(--elevation-stroke),var(--elevation-high);will-change:top,left,width,height}#sharj .header .icon{cursor:pointer}#sharj .window-body{height:calc(100% - 48px)}#sharj .sidebar{overflow:hidden scroll;overflow-y:auto;width:270px;min-width:250px;height:100%;max-height:100%;padding:8px;background-color:var(--glass-sidebar)!important;border-right:1px solid var(--glass-border)!important}#sharj .sidebar legend,#sharj .sidebar label{display:block;width:100%}#sharj .main{display:flex;max-width:calc(100% - 250px);background-color:transparent!important;flex-grow:1}#sharj.hide-sidebar .sidebar{display:none}#sharj.hide-sidebar .main{max-width:100%}#sharj #logArea{font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;font-size:.75rem;overflow:auto;padding:10px;user-select:text;flex-grow:1;cursor:auto;background-color:rgba(0,0,0,0.3)!important;border:1px solid var(--glass-border)!important;border-radius:8px;margin:8px}#sharj .tbar{padding:8px;background-color:rgba(255,255,255,0.02)!important;border-bottom:1px solid var(--glass-border)!important}#sharj .tbar button{margin-right:4px;margin-bottom:4px}#sharj .footer{cursor:se-resize;padding-right:30px}#sharj .footer #progressPercent{padding:0 1em;font-size:small;color:var(--interactive-muted);flex-grow:1}.resize-handle{position:absolute;bottom:-15px;right:-15px;width:30px;height:30px;transform:rotate(-45deg);background:repeating-linear-gradient(0,var(--background-modifier-accent),var(--background-modifier-accent) 1px,transparent 2px,transparent 4px);cursor:nwse-resize}#sharj summary{font-size:16px;font-weight:500;line-height:20px;position:relative;overflow:hidden;margin-bottom:2px;padding:6px 10px;cursor:pointer;white-space:nowrap;text-overflow:ellipsis;color:var(--interactive-normal);border-radius:4px;flex-shrink:0}#sharj fieldset{padding-left:8px}#sharj legend a{float:right;text-transform:initial}#sharj progress{height:8px;margin-top:4px;flex-grow:1}#sharj .importJson{display:flex;flex-direction:row}#sharj .importJson button{margin-left:5px;width:fit-content}`;
    var dragCss = `[name^="grab-"]{position:absolute;--size:6px;--corner-size:16px;--offset:-1px;z-index:9}[name^="grab-"]:hover{background:rgba(128,128,128,0.1)}[name="grab-t"]{top:0;left:var(--corner-size);right:var(--corner-size);height:var(--size);margin-top:var(--offset);cursor:ns-resize}[name="grab-r"]{top:var(--corner-size);bottom:var(--corner-size);right:0;width:var(--size);margin-right:var(--offset);cursor:ew-resize}[name="grab-b"]{bottom:0;left:var(--corner-size);right:var(--corner-size);height:var(--size);margin-bottom:var(--offset);cursor:ns-resize}[name="grab-l"]{top:var(--corner-size);bottom:var(--corner-size);left:0;width:var(--size);margin-left:var(--offset);cursor:ew-resize}[name="grab-tl"]{top:0;left:0;width:var(--corner-size);height:var(--corner-size);margin-top:var(--offset);margin-left:var(--offset);cursor:nwse-resize}[name="grab-tr"]{top:0;right:0;width:var(--corner-size);height:var(--corner-size);margin-top:var(--offset);margin-right:var(--offset);cursor:nesw-resize}[name="grab-br"]{bottom:0;right:0;width:var(--corner-size);height:var(--corner-size);margin-bottom:var(--offset);margin-right:var(--offset);cursor:nwse-resize}[name="grab-bl"]{bottom:0;left:0;width:var(--corner-size);height:var(--corner-size);margin-bottom:var(--offset);margin-left:var(--offset);cursor:nesw-resize}`;
    var buttonHtml = (`
<div id="sharj-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages with sharj">
    <svg aria-hidden="false" width="20" height="20" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <progress></progress>
</div>
`);
    var sharjTemplate = (`
<div id="sharj" class="browser container redact" style="display:none;">
    <div class="header">
        <svg class="icon" aria-hidden="false" width="18" height="18" viewBox="0 0 24 24">
            <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
            <path fill="currentColor"
                d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z">
            </path>
        </svg>
        <h3>Sharj</h3>
        <div class="vert-divider"></div>
        <span>Purge messages</span>
        <div class="spacer"></div>
        <div id="hide" class="icon" aria-label="Close" role="button" tabindex="0">
            <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
                <path fill="currentColor"
                    d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z">
                </path>
            </svg>
        </div>
    </div>
    <div class="window-body" style="display: flex; flex-direction: row;">
        <div class="sidebar scroll">
            <details open>
                <summary>General</summary>
                <fieldset>
                    <legend>Author ID</legend>
                    <div class="multiInput">
                        <div class="input-wrapper">
                            <input class="input" id="authorId" type="text" priv>
                        </div>
                        <button id="getAuthor">me</button>
                    </div>
                </fieldset>
                <hr>
                <fieldset>
                    <legend>Server ID</legend>
                    <div class="multiInput">
                        <div class="input-wrapper">
                            <input class="input" id="guildId" type="text" priv>
                        </div>
                        <button id="getGuild">current</button>
                    </div>
                </fieldset>
                <fieldset>
                    <legend>Channel ID</legend>
                    <div class="multiInput mb1">
                        <div class="input-wrapper">
                            <input class="input" id="channelId" type="text" priv>
                        </div>
                        <button id="getChannel">current</button>
                    </div>

                </fieldset>
            </details>
            <hr>
            <details>
                <summary>Wipe Archive</summary>
                <fieldset>
                    <legend>Import index.json</legend>
                    <div class="input-wrapper">
                        <input type="file" id="importJsonInput" accept="application/json,.json" style="width:100%";>
                    </div>
                    <div class="sectionDescription">
                        
                    </div>
                </fieldset>
            </details>
            <hr>
            <details>
                <summary>Filter</summary>
                <fieldset>
                    <legend>Search</legend>
                    <div class="input-wrapper">
                        <input id="search" type="text" placeholder="Containing text" priv>
                    </div>
                    
                    <div class="sectionDescription">
                        <label><input id="hasLink" type="checkbox">has: link</label>
                    </div>
                    <div class="sectionDescription">
                        <label><input id="hasFile" type="checkbox">has: file</label>
                    </div>
                    <div class="sectionDescription">
                        <label><input id="includePinned" type="checkbox">Include pinned</label>
                    </div>
                </fieldset>
                <hr>
                <fieldset>
                    <legend>Pattern</legend>
                    
                    <div class="input-wrapper">
                        <span class="info">/</span>
                        <input id="pattern" type="text" placeholder="regular expression" priv>
                        <span class="info">/</span>
                    </div>
                </fieldset>
            </details>
            <hr>
            <details>
                <summary>Advanced settings</summary>
                <fieldset>
                    <legend>Authorization Token</legend>
                    <div class="multiInput">
                        <div class="input-wrapper">
                            <input class="input" id="token" type="text" autocomplete="dont" priv>
                        </div>
                        <button id="getToken">fill</button>
                    </div>
                </fieldset>
            </details>
            <hr>
            <div></div>
            
        </div>
        <div class="main col">
            <div class="tbar col">
                <div class="row">
                    <button id="toggleSidebar" class="sizeMedium icon">☰</button>
                    <button id="start" class="sizeMedium danger" style="width: 150px;" title="Start the deletion process">▶︎ Delete</button>
                    <button id="stop" class="sizeMedium" title="Stop the deletion process" disabled>🛑 Stop</button>
                    <button id="clear" class="sizeMedium">Clear log</button>
                    <label class="row" title="Hide sensitive information on your screen for taking screenshots">
                        <input id="redact" type="checkbox" checked> Streamer mode
                    </label>
                </div>
            </div>
            <pre id="logArea" class="logarea scroll">
                <div>Star <a href="{{HOME}}" target="_blank" rel="noopener noreferrer">this project</a> on GitHub!</div>
            </pre>
            <div class="tbar footer row">
                <div id="progressPercent"></div>
                <progress id="progressBar" style="display:none; width: 100%; height: 12px; margin: 0 10px;"></progress>
                <span class="spacer"></span>
                <label>
                    <input id="autoScroll" type="checkbox" checked> Auto scroll
                </label>
                <div class="resize-handle"></div>
            </div>
        </div>
    </div>
</div>
`);

    const log = {
        debug() { return logFn ? logFn('debug', arguments) : console.debug.apply(console, arguments); },
        info() { return logFn ? logFn('info', arguments) : console.info.apply(console, arguments); },
        verb() { return logFn ? logFn('verb', arguments) : console.log.apply(console, arguments); },
        warn() { return logFn ? logFn('warn', arguments) : console.warn.apply(console, arguments); },
        error() { return logFn ? logFn('error', arguments) : console.error.apply(console, arguments); },
        success() { return logFn ? logFn('success', arguments) : console.info.apply(console, arguments); },
    };

    var logFn;

    const setLogFn = (fn) => logFn = fn;

    const wait = ms => delay(ms);
    const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
    const escapeHTML = html => String(html).replace(/[&<"']/g, m => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;' })[m]);
    const redact = str => `<x>${escapeHTML(str)}</x>`;
    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const ask = msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
    const interpolate = (str, obj, removeMissing = false) => str.replace(/\{\{([\w_]+)\}\}/g, (m, key) => obj[key] || (removeMissing ? '' : m));

    class Core {
        options = {
            authToken: null,
            authorId: null,
            guildId: null,
            channelId: null,
            content: null,
            hasLink: null,
            hasFile: null,
            includePinned: null,
            pattern: null,
            searchDelay: DEFAULT_SEARCH_DELAY,
            deleteDelay: DEFAULT_DELETE_DELAY,
            maxAttempt: 2,
            confirm: true,
            _batchIndex: 0,
            _batchTotal: 0,
        };
        state = {
            running: false,
            delCount: 0,
            failCount: 0,
            grandTotal: 0,
            offset: 0,
            iterations: 0,
            _response: null,
            _toDelete: [],
            _skipped: [],
        };
        stats = {
            startTime: new Date(),
            throttledCount: 0,
            throttledTotalTime: 0,
            lastPing: null,
            avgPing: null,
            etr: 0,
        };
        onStart = undefined;
        onProgress = undefined;
        onStop = undefined;

        resetState() {
            this.state = {
                running: false,
                delCount: 0,
                failCount: 0,
                grandTotal: 0,
                offset: 0,
                iterations: 0,
                _response: null,
                _toDelete: [],
                _skipped: [],
            };
            this.options.confirm = true;
        }

        async runBatch(queue) {
            if (this.state.running) return log.error('Already running!');
            log.info(`Scanning ${queue.length} channels...`);
            this.state.running = true;
            this.stats.startTime = new Date();
            if (this.onStart) this.onStart(this.state, this.stats);
            this.options.confirm = false;
            let processed = 0;
            for (let i = 0; i < queue.length; i++) {
                if (!this.state.running) break;
                const job = queue[i];
                this.options = {
                    ...this.options,
                    ...job,
                    _batchIndex: i + 1,
                    _batchTotal: queue.length,
                };
                await this.runSingle();
                if (!this.state.running) break;
                if (this.state.delCount > 0) {
                    processed++;
                    log.info(`[${i + 1}/${queue.length}] Channel done. (${processed} total processed)`);
                } else {
                    log.info(`[${i + 1}/${queue.length}] No messages found.`);
                }
                this.state.delCount = 0;
                this.state.failCount = 0;
                this.state.grandTotal = 0;
                this.state.offset = 0;
                this.state.iterations = 0;
                this.state._response = null;
                this.state._toDelete = [];
                this.state._skipped = [];
                this.options.confirm = false;
                await wait(BATCH_DELAY);
            }
            log.info(`Batch finished. Processed ${processed} channels with messages.`);
            this.state.running = false;
            if (this.onStop) this.onStop(this.state, this.stats);
        }

        async runSingle() {
            let before = undefined;
            do {
                this.state.iterations++;
                log.verb('Fetching messages...');
                await this.search(before);
                if (this.state._response._skip) break;
                await this.filterMsgs();
                log.verb(
                    `Grand total: ${this.state.grandTotal}`,
                    `To delete: ${this.state._toDelete.length}`,
                    `Skipped: ${this.state._skipped.length}`
                );
                this.printStats();
                this.calcEtr();
                log.verb(`Estimated time remaining: ${msToHMS(this.stats.etr)}`);
                if (this.state._toDelete.length > 0) {
                    await this.deleteMsgs();
                    // Set before to the last message ID in this batch for next page
                    before = this.state._toDelete[this.state._toDelete.length - 1]?.id;
                } else if (this.state._skipped.length > 0) {
                    // If all messages were skipped, still paginate by last message
                    before = this.state._skipped[this.state._skipped.length - 1]?.id;
                    log.verb('Nothing to delete on this page, checking next...');
                } else {
                    log.verb('Ended because API returned empty page.');
                    break;
                }
                if (!before) {
                    log.verb('No more messages to paginate.');
                    break;
                }
                log.verb(`Waiting ${(this.options.searchDelay / 1000).toFixed(2)}s before next page...`);
                await wait(this.options.searchDelay);
            } while (this.state.running);
        }

        async run() {
            if (this.state.running) return log.error('Already running!');
            this.state.running = true;
            this.stats.startTime = new Date();
            log.success(`\nStarted at ${this.stats.startTime.toLocaleString()}`);
            if (this.onStart) this.onStart(this.state, this.stats);
            let before = undefined;
            do {
                this.state.iterations++;
                log.verb('Fetching messages...');
                await this.search(before);
                if (this.state._response._skip) {
                    this.state.running = false;
                    break;
                }
                await this.filterMsgs();
                log.verb(
                    `Grand total: ${this.state.grandTotal}`,
                    `To delete: ${this.state._toDelete.length}`,
                    `Skipped: ${this.state._skipped.length}`
                );
                this.printStats();
                this.calcEtr();
                log.verb(`Estimated time remaining: ${msToHMS(this.stats.etr)}`);
                if (this.state._toDelete.length > 0) {
                    if (await this.confirm() === false) {
                        this.state.running = false;
                        break;
                    }
                    await this.deleteMsgs();
                    before = this.state._toDelete[this.state._toDelete.length - 1]?.id;
                } else if (this.state._skipped.length > 0) {
                    before = this.state._skipped[this.state._skipped.length - 1]?.id;
                    log.verb('Nothing to delete on this page, checking next...');
                } else {
                    log.verb('Ended because API returned empty page.');
                    this.state.running = false;
                    break;
                }
                if (!before) {
                    log.verb('No more messages to paginate.');
                    break;
                }
                log.verb(`Waiting ${(this.options.searchDelay / 1000).toFixed(2)}s before next page...`);
                await wait(this.options.searchDelay);
            } while (this.state.running);
            this.stats.endTime = new Date();
            log.success(`Ended at ${this.stats.endTime.toLocaleString()}! Total time: ${msToHMS(this.stats.endTime.getTime() - this.stats.startTime.getTime())}`);
            this.printStats();
            log.debug(`Deleted ${this.state.delCount} messages, ${this.state.failCount} failed.\n`);
            if (this.onStop) this.onStop(this.state, this.stats);
        }

        stop() {
            this.state.running = false;
            if (this.onStop) this.onStop(this.state, this.stats);
        }

        calcEtr() {
            this.stats.etr = (this.options.searchDelay * Math.round(this.state.grandTotal / 25)) + ((this.options.deleteDelay + this.stats.avgPing) * this.state.grandTotal);
        }

        async confirm() {
            if (!this.options.confirm) return true;
            const preview = this.state._toDelete.map(m => `${m.author.display_name || m.author.username}: ${m.attachments.length ? '[ATTACHMENTS]' : m.content}`).join('\n');
            const answer = await ask(
                `Do you want to delete ~${this.state.grandTotal} messages? (Estimated time: ${msToHMS(this.stats.etr)})` +
                '(The actual number of messages may be less, depending if you\'re using filters to skip some messages)' +
                '\n\n---- Preview ----\n' +
                preview
            );
            if (!answer) {
                log.error('Aborted by you!');
                return false;
            }
            else {
                this.options.confirm = false;
                return true;
            }
        }

        async search(before) {
            const base = this.options.guildId === '@me'
                ? `https://discord.com/api/v10/channels/${this.options.channelId}/messages/`
                : `https://discord.com/api/v10/guilds/${this.options.guildId}/messages/`;
            const batchInfo = this.options._batchTotal ? `[${this.options._batchIndex}/${this.options._batchTotal}] ` : '';
            let resp;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    this.beforeRequest();
                    resp = await safeFetch(base + 'search?' + queryString([
                        ['author_id', this.options.authorId || undefined],
                        ['channel_id', (this.options.guildId !== '@me' ? this.options.channelId : undefined) || undefined],
                        ['sort_by', 'timestamp'],
                        ['sort_order', 'desc'],
                        ['before', before],
                        ['has', this.options.hasLink ? 'link' : undefined],
                        ['has', this.options.hasFile ? 'file' : undefined],
                        ['content', this.options.content || undefined],
                        ['include_nsfw', true],
                    ]), { headers: { 'Authorization': this.options.authToken } });
                    this.afterRequest();
                } catch (e) {
                    attempts++;
                    if (attempts < maxAttempts) {
                        await wait(DEFAULT_BACKOFF_MS * Math.pow(2, attempts - 1));
                        continue;
                    }
                    log.error(`${batchInfo}Search failed after ${maxAttempts} attempts`);
                    this.state._response = { messages: [], total_results: 0, _skip: true };
                    return this.state._response;
                }

                if (resp === null) {
                    log.error(`${batchInfo}Search failed (network)`);
                    this.state.running = false;
                    this.state._response = { messages: [], total_results: 0, _skip: true };
                    return this.state._response;
                }

                if (resp.status === 202) {
                    let w = DEFAULT_BACKOFF_MS;
                    let apiMsg = 'Indexing';
                    try {
                        const j = await resp.json();
                        w = j.retry_after * 1000 || w;
                        apiMsg = j.message || apiMsg;
                    } catch (e) { }
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += w;
                    log.warn(`${batchInfo}202 ${apiMsg} — waiting ${w}ms...`);
                    await wait(w);
                    continue;
                }

                if (resp.status === 429) {
                    let w = await getRetryMs(resp);
                    if (!Number.isFinite(w)) w = this.options.searchDelay || DEFAULT_BACKOFF_MS;
                    this.stats.throttledCount++;
                    this.stats.throttledTotalTime += w;
                    this.options.searchDelay = Math.max(Number(this.options.searchDelay) || 0, w);
                    log.warn(`${batchInfo}429 Rate limited — waiting ${w}ms, search delay now ${this.options.searchDelay}ms`);
                    this.printStats();
                    const cooldown = Math.ceil(w * COOLDOWN_MULT);
                    log.verb(`Cooling down for ${cooldown}ms...`);
                    await wait(cooldown);
                    continue;
                }

                if (resp.status === 401) {
                    let apiMsg = '';
                    try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                    log.error(`${batchInfo}401 ${apiMsg || 'Unauthorized'}`);
                    this.state.running = false;
                    this.state._response = { messages: [], total_results: 0 };
                    return this.state._response;
                }

                if (resp.status === 403) {
                    let apiMsg = '';
                    try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                    log.error(`${batchInfo}403 ${apiMsg || 'Missing Access'}`);
                    this.state._response = { messages: [], total_results: 0 };
                    return this.state._response;
                }

                if (resp.status === 404) {
                    let apiMsg = '';
                    try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                    log.error(`${batchInfo}404 ${apiMsg || 'Unknown Channel'}`);
                    this.state._response = { messages: [], total_results: 0 };
                    return this.state._response;
                }

                if (resp.status >= 400 && resp.status < 500) {
                    let apiMsg = '';
                    try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                    log.warn(`${batchInfo}${resp.status} ${apiMsg || 'Client error'} — skipping`);
                    this.state._response = { messages: [], total_results: 0 };
                    return this.state._response;
                }

                if (resp.status === 200) {
                    const data = await resp.json();
                    this.state._response = data;
                    return data;
                }

                let apiMsg = '';
                try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                log.warn(`${batchInfo}${resp.status} ${apiMsg || 'Unexpected response'}`);
                this.state._response = { messages: [], total_results: 0, _skip: true };
                return this.state._response;
            }
        }

        async filterMsgs() {
            const data = this.state._response;
            const total = data.total_results;
            if (total > this.state.grandTotal) this.state.grandTotal = total;
            const discoveredMessages = (Array.isArray(data.messages) ? data.messages.flat() : []).filter(Boolean);
            let messagesToDelete = discoveredMessages.filter(msg => msg && msg.id && msg.author);
            messagesToDelete = messagesToDelete.filter(msg => msg.type === 0 || (msg.type >= 6 && msg.type <= 21));
            messagesToDelete = messagesToDelete.filter(msg => msg.pinned ? this.options.includePinned : true);
            try {
                if (this.options.pattern) {
                    const regex = new RegExp(this.options.pattern, 'i');
                    messagesToDelete = messagesToDelete.filter(msg => regex.test(msg.content));
                }
            } catch (e) {
                log.warn('Ignoring RegExp because pattern is malformed!', e);
            }
            const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));
            this.state._toDelete = messagesToDelete;
            this.state._skipped = skippedMessages;
        }

        async deleteMsgs() {
            const msgs = this.state._toDelete;
            const maxAttempt = Number(this.options.maxAttempt) || 2;
            for (let i = 0, len = msgs.length; i < len; i++) {
                const message = msgs[i];
                if (!this.state.running) return log.error('Stopped by you!');
                const timestamp = new Date(message.timestamp).toLocaleString();
                const authorLabel = message.author ? (message.author.display_name || message.author.username) : 'Unknown';
                const contentPreview = (message.content || '').replace(/\n/g, '↵');
                const attachmentsPreview = message.attachments && message.attachments.length ? ' [ATTACHMENTS]' : '';
                log.debug(`[${i + 1}/${msgs.length}] <sup>${timestamp}</sup> <b>${redact(authorLabel)}</b>: <i>${redact(contentPreview)}</i>${attachmentsPreview}`, `<sup>{ID:${redact(message.id)}}</sup>`);
                let attempt = 0;
                let deleted = false;
                while (attempt < maxAttempt) {
                    const result = await this.deleteMessage(message);
                    if (result === 'RETRY') {
                        attempt++;
                        log.verb(`Retrying in ${this.options.deleteDelay}ms... (${attempt}/${maxAttempt})`);
                        await wait(this.options.deleteDelay);
                        continue;
                    }
                    if (result === 'OK') {
                        deleted = true;
                    } else if (result === 'FAILED' || result === 'FAIL_SKIP') {
                        log.warn(`Failed to delete message ID: ${message.id} (status: ${result})`);
                    }
                    break;
                }
                if (!deleted) {
                    log.warn(`Message not deleted: ${message.id}`);
                }
                this.calcEtr();
                if (this.onProgress) this.onProgress(this.state, this.stats);
                await wait(this.options.deleteDelay);
            }
        }

        async deleteMessage(message) {
            const url = `https://discord.com/api/v10/channels/${message.channel_id}/messages/${message.id}`;
            const batchInfo = this.options._batchTotal ? `[${this.options._batchIndex}/${this.options._batchTotal}] ` : '';
            let resp;
            try {
                this.beforeRequest();
                resp = await safeFetch(url, { method: 'DELETE', headers: { 'Authorization': this.options.authToken } });
                this.afterRequest();
            } catch (e) {
                log.error(`${batchInfo}Delete error: ${e.message}`);
                this.state.failCount++;
                return 'RETRY';
            }
            if (resp === null) {
                log.warn(`${batchInfo}Delete failed (network)`);
                return 'RETRY';
            }
            if (resp.ok) {
                this.state.delCount++;
                return 'OK';
            }
            const status = resp.status;
            if (status === 429) {
                let w = await getRetryMs(resp);
                if (!Number.isFinite(w)) w = Number(this.options.deleteDelay) || DEFAULT_BACKOFF_MS;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.options.deleteDelay = Math.max(Number(this.options.deleteDelay) || 0, w);
                log.warn(`${batchInfo}429 Rate limited — waiting ${w}ms, delete delay now ${this.options.deleteDelay}ms`);
                this.printStats();
                const cooldown = Math.ceil(w * COOLDOWN_MULT);
                log.verb(`Cooling down for ${cooldown}ms...`);
                await wait(cooldown);
                return 'RETRY';
            }
            if (status === 401) {
                let apiMsg = '';
                try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                log.error(`${batchInfo}401 ${apiMsg || 'Unauthorized'}`);
                this.state.running = false;
                this.state.failCount++;
                return 'FAILED';
            }
            if (status === 403) {
                let apiMsg = '';
                try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                log.error(`${batchInfo}403 ${apiMsg || 'Missing Permissions'}`);
                this.state.offset++;
                this.state.failCount++;
                return 'FAIL_SKIP';
            }
            if (status === 404) {
                let apiMsg = '';
                try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                log.warn(`${batchInfo}404 ${apiMsg || 'Unknown Message'}`);
                this.state.delCount++;
                return 'OK';
            }
            if (status === 400) {
                let msg = '';
                try { msg = (await resp.json()).message || ''; } catch (e) { }
                if (msg.includes('archived')) {
                    log.warn(`${batchInfo}400 ${msg}`);
                    this.state.offset++;
                    this.state.failCount++;
                    return 'FAIL_SKIP';
                }
                log.warn(`${batchInfo}400 ${msg || 'Bad Request'}`);
                this.state.offset++;
                this.state.failCount++;
                return 'FAIL_SKIP';
            }
            if (status >= 400 && status < 500) {
                let apiMsg = '';
                try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
                log.warn(`${batchInfo}${status} ${apiMsg || 'Client error'}`);
                this.state.offset++;
                this.state.failCount++;
                return 'FAIL_SKIP';
            }
            let apiMsg = '';
            try { apiMsg = (await resp.clone().json()).message || ''; } catch (e) { }
            log.error(`${batchInfo}${status} ${apiMsg || 'Server error'}`);
            this.state.failCount++;
            return 'FAILED';
        }

        #beforeTs = 0;

        beforeRequest() {
            this.#beforeTs = Date.now();
        }

        afterRequest() {
            this.stats.lastPing = (Date.now() - this.#beforeTs);
            this.stats.avgPing = this.stats.avgPing > 0 ? (this.stats.avgPing * 0.9) + (this.stats.lastPing * 0.1) : this.stats.lastPing;
        }

        printStats() {
            log.verb(
                `Delete delay: ${this.options.deleteDelay}ms, Search delay: ${this.options.searchDelay}ms`,
                `Last Ping: ${this.stats.lastPing}ms, Average Ping: ${this.stats.avgPing | 0}ms`,
            );
            log.verb(
                `Rate Limited: ${this.stats.throttledCount} times.`,
                `Total time throttled: ${msToHMS(this.stats.throttledTotalTime)}.`
            );
        }
    }

    const MOVE = 0;
    const RESIZE_T = 1;
    const RESIZE_B = 2;
    const RESIZE_L = 4;
    const RESIZE_R = 8;
    const RESIZE_TL = RESIZE_T + RESIZE_L;
    const RESIZE_TR = RESIZE_T + RESIZE_R;
    const RESIZE_BL = RESIZE_B + RESIZE_L;
    const RESIZE_BR = RESIZE_B + RESIZE_R;

    class DragResize {
        constructor({ elm, moveHandle, options }) {
            this.options = defaultArgs({
                enabledDrag: true,
                enabledResize: true,
                minWidth: 200,
                maxWidth: Infinity,
                minHeight: 100,
                maxHeight: Infinity,
                dragAllowX: true,
                dragAllowY: true,
                resizeAllowX: true,
                resizeAllowY: true,
                draggingClass: 'drag',
                useMouseEvents: true,
                useTouchEvents: true,
                createHandlers: true,
            }, options);
            Object.assign(this, options);
            options = undefined;
            elm.style.position = 'fixed';
            this.drag_m = new Draggable(elm, moveHandle, MOVE, this.options);
            if (this.options.createHandlers) {
                this.el_t = createElement('div', { name: 'grab-t' }, elm);
                this.drag_t = new Draggable(elm, this.el_t, RESIZE_T, this.options);
                this.el_r = createElement('div', { name: 'grab-r' }, elm);
                this.drag_r = new Draggable(elm, this.el_r, RESIZE_R, this.options);
                this.el_b = createElement('div', { name: 'grab-b' }, elm);
                this.drag_b = new Draggable(elm, this.el_b, RESIZE_B, this.options);
                this.el_l = createElement('div', { name: 'grab-l' }, elm);
                this.drag_l = new Draggable(elm, this.el_l, RESIZE_L, this.options);
                this.el_tl = createElement('div', { name: 'grab-tl' }, elm);
                this.drag_tl = new Draggable(elm, this.el_tl, RESIZE_TL, this.options);
                this.el_tr = createElement('div', { name: 'grab-tr' }, elm);
                this.drag_tr = new Draggable(elm, this.el_tr, RESIZE_TR, this.options);
                this.el_br = createElement('div', { name: 'grab-br' }, elm);
                this.drag_br = new Draggable(elm, this.el_br, RESIZE_BR, this.options);
                this.el_bl = createElement('div', { name: 'grab-bl' }, elm);
                this.drag_bl = new Draggable(elm, this.el_bl, RESIZE_BL, this.options);
            }
        }
    }

    class Draggable {
        constructor(targetElm, handleElm, op, options) {
            Object.assign(this, options);
            options = undefined;
            this._targetElm = targetElm;
            this._handleElm = handleElm;
            let vw = window.innerWidth;
            let vh = window.innerHeight;
            let initialX, initialY, initialT, initialL, initialW, initialH;
            const clamp = (value, min, max) => value < min ? min : value > max ? max : value;
            const moveOp = (x, y) => {
                const deltaX = (x - initialX);
                const deltaY = (y - initialY);
                const t = clamp(initialT + deltaY, 0, vh - initialH);
                const l = clamp(initialL + deltaX, 0, vw - initialW);
                this._targetElm.style.top = t + 'px';
                this._targetElm.style.left = l + 'px';
            };
            const resizeOp = (x, y) => {
                x = clamp(x, 0, vw);
                y = clamp(y, 0, vh);
                const deltaX = (x - initialX);
                const deltaY = (y - initialY);
                const resizeDirX = (op & RESIZE_L) ? -1 : 1;
                const resizeDirY = (op & RESIZE_T) ? -1 : 1;
                const deltaXMax = (this.maxWidth - initialW);
                const deltaXMin = (this.minWidth - initialW);
                const deltaYMax = (this.maxHeight - initialH);
                const deltaYMin = (this.minHeight - initialH);
                const t = initialT + clamp(deltaY * resizeDirY, deltaYMin, deltaYMax) * resizeDirY;
                const l = initialL + clamp(deltaX * resizeDirX, deltaXMin, deltaXMax) * resizeDirX;
                const w = initialW + clamp(deltaX * resizeDirX, deltaXMin, deltaXMax);
                const h = initialH + clamp(deltaY * resizeDirY, deltaYMin, deltaYMax);
                if (op & RESIZE_T) {
                    this._targetElm.style.top = t + 'px';
                    this._targetElm.style.height = h + 'px';
                }
                if (op & RESIZE_B) {
                    this._targetElm.style.height = h + 'px';
                }
                if (op & RESIZE_L) {
                    this._targetElm.style.left = l + 'px';
                    this._targetElm.style.width = w + 'px';
                }
                if (op & RESIZE_R) {
                    this._targetElm.style.width = w + 'px';
                }
            };
            let operation = op === MOVE ? moveOp : resizeOp;
            function dragStartHandler(e) {
                const touch = e.type === 'touchstart';
                if ((e.buttons === 1 || e.which === 1) || touch) {
                    e.preventDefault();
                    const x = touch ? e.touches[0].clientX : e.clientX;
                    const y = touch ? e.touches[0].clientY : e.clientY;
                    initialX = x;
                    initialY = y;
                    vw = window.innerWidth;
                    vh = window.innerHeight;
                    initialT = this._targetElm.offsetTop;
                    initialL = this._targetElm.offsetLeft;
                    initialW = this._targetElm.clientWidth;
                    initialH = this._targetElm.clientHeight;
                    if (this.useMouseEvents) {
                        document.addEventListener('mousemove', this._dragMoveHandler);
                        document.addEventListener('mouseup', this._dragEndHandler);
                    }
                    if (this.useTouchEvents) {
                        document.addEventListener('touchmove', this._dragMoveHandler, { passive: false });
                        document.addEventListener('touchend', this._dragEndHandler);
                    }
                    this._targetElm.classList.add(this.draggingClass);
                }
            }
            function dragMoveHandler(e) {
                e.preventDefault();
                let x, y;
                const touch = e.type === 'touchmove';
                if (touch) {
                    const t = e.touches[0];
                    x = t.clientX;
                    y = t.clientY;
                } else {
                    if ((e.buttons || e.which) !== 1) {
                        this._dragEndHandler();
                        return;
                    }
                    x = e.clientX;
                    y = e.clientY;
                }
                operation(x, y);
            }
            function dragEndHandler(e) {
                if (this.useMouseEvents) {
                    document.removeEventListener('mousemove', this._dragMoveHandler);
                    document.removeEventListener('mouseup', this._dragEndHandler);
                }
                if (this.useTouchEvents) {
                    document.removeEventListener('touchmove', this._dragMoveHandler);
                    document.removeEventListener('touchend', this._dragEndHandler);
                }
                this._targetElm.classList.remove(this.draggingClass);
            }
            this._dragStartHandler = dragStartHandler.bind(this);
            this._dragMoveHandler = dragMoveHandler.bind(this);
            this._dragEndHandler = dragEndHandler.bind(this);
            this.enable();
        }
        enable() {
            this.destroy();
            if (this.useMouseEvents) this._handleElm.addEventListener('mousedown', this._dragStartHandler);
            if (this.useTouchEvents) this._handleElm.addEventListener('touchstart', this._dragStartHandler, { passive: false });
        }
        destroy() {
            this._targetElm.classList.remove(this.draggingClass);
            if (this.useMouseEvents) {
                this._handleElm.removeEventListener('mousedown', this._dragStartHandler);
                document.removeEventListener('mousemove', this._dragMoveHandler);
                document.removeEventListener('mouseup', this._dragEndHandler);
            }
            if (this.useTouchEvents) {
                this._handleElm.removeEventListener('touchstart', this._dragStartHandler);
                document.removeEventListener('touchmove', this._dragMoveHandler);
                document.removeEventListener('touchend', this._dragEndHandler);
            }
        }
    }

    function createElement(tag = 'div', attrs, parent) {
        const elm = document.createElement(tag);
        if (attrs) Object.entries(attrs).forEach(([k, v]) => elm.setAttribute(k, v));
        if (parent) parent.appendChild(elm);
        return elm;
    }

    function defaultArgs(defaults, options) {
        function isObj(x) { return x !== null && typeof x === 'object'; }
        function hasOwn(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); }
        if (isObj(options)) for (let prop in defaults) {
            if (hasOwn(defaults, prop) && hasOwn(options, prop) && options[prop] !== undefined) {
                if (isObj(defaults[prop])) defaultArgs(defaults[prop], options[prop]);
                else defaults[prop] = options[prop];
            }
        }
        return defaults;
    }

    function createElm(html) {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    }

    function insertCss(css) {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    }

    function getToken() {
        window.dispatchEvent(new Event('beforeunload'));
        const LS = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
        try {
            return JSON.parse(LS.token);
        } catch {
            log.info('Could not automatically detect Authorization Token in local storage!');
            log.info('Attempting to grab token using webpack');
            return (window.webpackChunkdiscord_app.push([[''], {}, e => { window.m = []; for (let c in e.c) window.m.push(e.c[c]); }]), window.m).find(m => m?.exports?.default?.getToken !== void 0).exports.default.getToken();
        }
    }

    function getAuthorId() {
        const LS = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
        return JSON.parse(LS.user_id_cache);
    }

    function getGuildId() {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        if (m) return m[1];
        else alert('Could not find the Guild ID!\nPlease make sure you are on a Server or DM.');
    }

    function getChannelId() {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        if (m) return m[2];
        else alert('Could not find the Channel ID!\nPlease make sure you are on a Channel or DM.');
    }

    function fillToken() {
        try {
            return getToken();
        } catch (e) {
            log.error('Could not automatically detect Authorization Token!');
            log.info('Please make sure sharj is up to date');
            log.debug('Alternatively, you can try entering a Token manually in the "Advanced Settings" section.');
        }
        return '';
    }

    const HOME = 'https://github.com/expertism/sharj';

    const core = new Core();

    const ui = {
        sharjWindow: null,
        sharjBtn: null,
        logArea: null,
        autoScroll: null,
        progressMain: null,
        progressIcon: null,
        percent: null,
    };

    const $ = s => ui.sharjWindow.querySelector(s);

    function initUI() {
        insertCss(themeCss);
        insertCss(mainCss);
        insertCss(dragCss);
        const sharjUI = interpolate(sharjTemplate, {
            VERSION,
            HOME,
        });
        ui.sharjWindow = createElm(sharjUI);
        document.body.appendChild(ui.sharjWindow);
        new DragResize({ elm: ui.sharjWindow, moveHandle: $('.header') });
        ui.sharjBtn = createElm(buttonHtml);
        ui.sharjBtn.onclick = toggleWindow;
        function mountBtn() {
            const toolbar = document.querySelector('#app-mount [class*="-toolbar"]');
            if (toolbar) toolbar.appendChild(ui.sharjBtn);
        }
        mountBtn();
        const discordElm = document.querySelector('#app-mount');
        let observerThrottle = null;
        const observer = new MutationObserver((_mutationsList, _observer) => {
            if (observerThrottle) return;
            observerThrottle = setTimeout(() => {
                observerThrottle = null;
                if (!discordElm.contains(ui.sharjBtn)) mountBtn();
            }, 3000);
        });
        observer.observe(discordElm, { attributes: false, childList: true, subtree: true });
        function toggleWindow() {
            if (ui.sharjWindow.style.display !== 'none') {
                ui.sharjWindow.style.display = 'none';
                ui.sharjBtn.style.color = 'var(--interactive-normal)';
            }
            else {
                ui.sharjWindow.style.display = '';
                ui.sharjBtn.style.color = 'var(--interactive-active)';
            }
        }
        ui.logArea = $('#logArea');
        ui.autoScroll = $('#autoScroll');
        ui.progressMain = $('#progressBar');
        ui.progressIcon = ui.sharjBtn.querySelector('progress');
        ui.percent = $('#progressPercent');
        $('#hide').onclick = toggleWindow;
        $('#toggleSidebar').onclick = () => ui.sharjWindow.classList.toggle('hide-sidebar');
        $('button#start').onclick = startAction;
        $('button#stop').onclick = stopAction;
        $('button#clear').onclick = () => ui.logArea.innerHTML = '';
        $('button#getAuthor').onclick = () => $('input#authorId').value = getAuthorId();
        $('button#getGuild').onclick = () => {
            const guildId = $('input#guildId').value = getGuildId();
            if (guildId === '@me') $('input#channelId').value = getChannelId();
        };
        $('button#getChannel').onclick = () => {
            $('input#channelId').value = getChannelId();
            $('input#guildId').value = getGuildId();
        };
        $('#redact').onchange = () => {
            const b = ui.sharjWindow.classList.toggle('redact');
            if (b) alert('This mode will attempt to hide personal information, so you can screen share / take screenshots.\nAlways double check you are not sharing sensitive information!');
        };
        $('button#getToken').onclick = () => $('input#token').value = fillToken();
        const fileSelection = $('input#importJsonInput');
        fileSelection.onchange = async () => {
            const files = fileSelection.files;
            if (files.length === 0) return log.warn('No file selected.');
            const channelIdField = $('input#channelId');
            const guildIdField = $('input#guildId');
            guildIdField.value = '@me';
            $('input#authorId').value = getAuthorId();
            try {
                const file = files[0];
                const text = await file.text();
                const json = JSON.parse(text);
                const channelIds = Object.keys(json);
                channelIdField.value = channelIds.join(',');
                log.info(`Loaded ${channelIds.length} channels.`);
            } catch (e) {
                log.error('Error parsing file!', e);
            }
        };
        setLogFn(printLog);
        setupCore();
    }

    function printLog(type = '', args) {
        ui.logArea.insertAdjacentHTML('beforeend', `<div class="log log-${type}">${Array.from(args).map(o => typeof o === 'object' ? JSON.stringify(o, o instanceof Error && Object.getOwnPropertyNames(o)) : o).join('\t')}</div>`);
        if (ui.autoScroll.checked) ui.logArea.querySelector('div:last-child').scrollIntoView(false);
        if (type === 'error') console.error(PREFIX, ...Array.from(args));
    }

    function setupCore() {
        core.onStart = (state, stats) => {
            console.log(PREFIX, 'onStart', state, stats);
            $('#start').disabled = true;
            $('#stop').disabled = false;
            ui.sharjBtn.classList.add('running');
            ui.progressMain.style.display = 'block';
            ui.percent.style.display = 'block';
        };
        core.onProgress = (state, stats) => {
            let max = state.grandTotal;
            const value = state.delCount + state.failCount;
            max = Math.max(max, value, 0);
            const percent = value >= 0 && max ? Math.round(value / max * 100) + '%' : '';
            const elapsed = msToHMS(Date.now() - stats.startTime.getTime());
            const remaining = msToHMS(stats.etr);
            ui.percent.innerHTML = `${percent} (${value}/${max}) Elapsed: ${elapsed} Remaining: ${remaining}`;
            ui.progressIcon.value = value;
            ui.progressMain.value = value;
            if (max) {
                ui.progressIcon.setAttribute('max', max);
                ui.progressMain.setAttribute('max', max);
            } else {
                ui.progressIcon.removeAttribute('value');
                ui.progressMain.removeAttribute('value');
                ui.percent.innerHTML = '...';
            }
        };
        core.onStop = (state, stats) => {
            console.log(PREFIX, 'onStop', state, stats);
            $('#start').disabled = false;
            $('#stop').disabled = true;
            ui.sharjBtn.classList.remove('running');
            ui.progressMain.style.display = 'none';
            ui.percent.style.display = 'none';
        };
    }

    function isValidSnowflake(id) {
        return /^\d{17,20}$/.test(id);
    }

    function isValidToken(token) {
        return token && token.length >= 50 && /^[\w.-]+$/.test(token);
    }

    async function startAction() {
        console.log(PREFIX, 'startAction (expanded discovery)');
        const authorId = $('input#authorId').value.trim();
        const guildId = $('input#guildId').value.trim();
        const rawChannelIds = $('input#channelId').value.trim().split(/\s*,\s*/).filter(Boolean);
        const content = $('input#search').value.trim();
        const hasLink = $('input#hasLink').checked;
        const hasFile = $('input#hasFile').checked;
        const includePinned = $('input#includePinned').checked;
        const pattern = $('input#pattern').value;
        const authToken = $('input#token').value.trim() || fillToken();
        if (!authToken) return log.error('Authorization token is required! Click "fill" or enter manually.');
        if (!isValidToken(authToken)) return log.error('Invalid authorization token format!');
        if (!guildId) return log.error('You must fill the "Server ID" field!');
        if (guildId !== '@me' && !isValidSnowflake(guildId)) return log.error('Invalid Server ID format! Must be a valid Discord snowflake.');
        if (authorId && !isValidSnowflake(authorId)) return log.error('Invalid Author ID format! Must be a valid Discord snowflake.');
        if (rawChannelIds.length === 0) return log.error('You must fill the "Channel ID" field!');
        ui.logArea.innerHTML = '';
        core.resetState();
        core.options = {
            ...core.options,
            authToken,
            authorId,
            guildId,
            channelId: undefined,
            content,
            hasLink,
            hasFile,
            includePinned,
            pattern,
        };
        const expandedChannelIds = [];
        for (const ch of rawChannelIds) {
            try {
                const found = await findChannels(authToken, guildId, ch);
                if (found && found.length) expandedChannelIds.push(...found);
                else expandedChannelIds.push(ch);
            } catch (e) {
                log.warn('Channel discovery failed for', ch, e);
                expandedChannelIds.push(ch);
            }
        }
        const uniqueChannels = Array.from(new Set(expandedChannelIds));
        if (uniqueChannels.length > 1) {
            log.info(`Starting batch deletion on ${uniqueChannels.length} channels...`);
            const jobs = uniqueChannels.map(ch => ({
                guildId: guildId,
                channelId: ch,
            }));
            try {
                await core.runBatch(jobs);
            } catch (e) {
                log.error(`Batch run failed: ${e.message || e}`);
            }
        }
        else if (uniqueChannels.length === 1) {
            core.options.channelId = uniqueChannels[0];
            try {
                await core.run();
            } catch (e) {
                log.error(`Run failed: ${e.message || e}`);
                core.stop();
            }
        } else {
            log.warn('No valid channels to process. Check Channel ID input.');
        }
    }

    function stopAction() {
        console.log(PREFIX, 'stopAction');
        core.stop();
    }

    try {
        initUI();
    } catch (e) {
        console.error(PREFIX, 'Failed to initialize UI:', e);
        alert('Sharj failed to initialize. Check console for details.');
    }

    window.addEventListener('unhandledrejection', e => {
        try { log.error('Unhandled promise rejection', e.reason); } catch (e) { console.error(e); }
        e.preventDefault();
    });

    window.addEventListener('error', e => {
        try { log.error('Unhandled error', e.error || e.message); } catch (e) { console.error(e); }
    });
})();
