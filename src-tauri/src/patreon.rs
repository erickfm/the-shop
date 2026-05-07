use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

const PATREON_LOGIN_URL: &str = "https://www.patreon.com/login";
const PATREON_BASE_URL: &str = "https://www.patreon.com";
const CURRENT_USER_ENDPOINT: &str = "https://www.patreon.com/api/current_user";
const LOGIN_WINDOW_LABEL: &str = "patreon-login";
const SESSION_COOKIE_NAME: &str = "session_id";
const POLL_INTERVAL_MS: u64 = 750;
const POLL_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatreonUser {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PatreonStatus {
    pub connected: bool,
    pub user: Option<PatreonUser>,
    pub last_verified_at: Option<i64>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn build_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("the-shop/0.1")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Other(format!("reqwest: {e}")))
}

pub fn load_session_cookie(db: &Db) -> AppResult<Option<String>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT session_cookie FROM patreon_session WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get::<_, String>(0)?))
        } else {
            Ok(None)
        }
    })
}

pub fn load_session_record(db: &Db) -> AppResult<Option<(String, PatreonUser, i64)>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT session_cookie, user_id, user_name, user_avatar_url, last_verified_at
             FROM patreon_session WHERE id = 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            let cookie: String = row.get(0)?;
            let user_id: Option<String> = row.get(1)?;
            let user_name: Option<String> = row.get(2)?;
            let avatar: Option<String> = row.get(3)?;
            let verified: i64 = row.get(4)?;
            let user = PatreonUser {
                id: user_id.unwrap_or_default(),
                name: user_name.unwrap_or_default(),
                avatar_url: avatar,
            };
            Ok(Some((cookie, user, verified)))
        } else {
            Ok(None)
        }
    })
}

pub fn save_session(db: &Db, cookie: &str, user: &PatreonUser) -> AppResult<()> {
    let now = now_secs();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO patreon_session
               (id, session_cookie, user_id, user_name, user_avatar_url, connected_at, last_verified_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               session_cookie = excluded.session_cookie,
               user_id = excluded.user_id,
               user_name = excluded.user_name,
               user_avatar_url = excluded.user_avatar_url,
               last_verified_at = excluded.last_verified_at",
            rusqlite::params![cookie, user.id, user.name, user.avatar_url, now],
        )?;
        Ok(())
    })
}

pub fn clear_session(db: &Db) -> AppResult<()> {
    db.with_conn(|c| {
        c.execute("DELETE FROM patreon_session WHERE id = 1", [])?;
        // Per-user gate state — drop with the session so reconnecting
        // as a different user gets a fresh viewable set.
        c.execute("DELETE FROM viewable_posts", [])?;
        c.execute("DELETE FROM patreon_memberships_cache", [])?;
        Ok(())
    })
}

pub async fn fetch_current_user(
    client: &reqwest::Client,
    session_cookie: &str,
) -> AppResult<Option<PatreonUser>> {
    let resp = client
        .get(CURRENT_USER_ENDPOINT)
        .header("Cookie", format!("{SESSION_COOKIE_NAME}={session_cookie}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("patreon http: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "patreon current_user: HTTP {status}"
        )));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("patreon json: {e}")))?;
    Ok(parse_current_user(&json))
}

fn parse_current_user(json: &serde_json::Value) -> Option<PatreonUser> {
    let data = json.get("data")?;
    let id = data.get("id")?.as_str()?.to_string();
    let attrs = data.get("attributes")?;
    let name = attrs
        .get("full_name")
        .and_then(|v| v.as_str())
        .or_else(|| attrs.get("first_name").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let avatar = attrs
        .get("image_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(PatreonUser {
        id,
        name,
        avatar_url: avatar,
    })
}

#[tauri::command]
pub async fn patreon_connect(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let login_url = url::Url::parse(PATREON_LOGIN_URL)
        .map_err(|e| AppError::Other(format!("url: {e}")))?;

    // Use a real Chrome user agent so Patreon's third-party identity providers
    // (Google in particular) don't refuse the page as "embedded webview".
    // Google still detects WKWebView / WebKitGTK in many cases — when that
    // happens the user has to fall back to email/Apple. The UA bump catches
    // the cases where UA-only sniffing is the gate.
    let chrome_ua = match std::env::consts::OS {
        "macos" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "windows" => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        _ => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };

    WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(login_url))
        .title("Connect Patreon")
        .inner_size(900.0, 800.0)
        .user_agent(chrome_ua)
        .build()
        .map_err(|e| AppError::Other(format!("open patreon window: {e}")))?;

    let db = state.db.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        if let Err(e) = poll_for_session(&app_handle, &db).await {
            let _ = app_handle.emit("patreon-connect-error", e.to_string());
            if let Some(w) = app_handle.get_webview_window(LOGIN_WINDOW_LABEL) {
                let _ = w.close();
            }
        }
    });

    Ok(())
}

async fn poll_for_session(app: &AppHandle, db: &Arc<Db>) -> AppResult<()> {
    let client = build_client()?;
    let base = url::Url::parse(PATREON_BASE_URL)
        .map_err(|e| AppError::Other(format!("url: {e}")))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(POLL_TIMEOUT_SECS);

    loop {
        if std::time::Instant::now() >= deadline {
            return Err(AppError::Other("patreon login timed out".into()));
        }

        let win = match app.get_webview_window(LOGIN_WINDOW_LABEL) {
            Some(w) => w,
            None => return Err(AppError::Other("login window closed before session".into())),
        };

        let cookies = win
            .cookies_for_url(base.clone())
            .map_err(|e| AppError::Other(format!("cookies_for_url: {e}")))?;
        let session = cookies.iter().find(|c| c.name() == SESSION_COOKIE_NAME);

        if let Some(session) = session {
            let session_value = session.value().to_string();
            if let Some(user) = fetch_current_user(&client, &session_value).await? {
                save_session(db, &session_value, &user)?;
                let _ = win.close();
                let _ = app.emit("patreon-connected", &user);
                return Ok(());
            }
        }

        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

#[tauri::command]
pub async fn patreon_status(state: State<'_, AppState>) -> AppResult<PatreonStatus> {
    let record = load_session_record(&state.db)?;
    Ok(match record {
        None => PatreonStatus {
            connected: false,
            user: None,
            last_verified_at: None,
        },
        Some((_cookie, user, verified)) => PatreonStatus {
            connected: true,
            user: Some(user),
            last_verified_at: Some(verified),
        },
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserConnectResult {
    pub user: PatreonUser,
    pub browser: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserProbe {
    pub browser: String,
    pub has_session_cookie: bool,
    pub error: Option<String>,
}

/// Read patreon.com cookies from a single named browser's cookie store.
/// Returns the value of `session_id` if present, or None if missing/error.
fn read_session_from_browser(browser: &str) -> Result<Option<String>, String> {
    let domains = Some(vec!["patreon.com".to_string()]);
    let cookies = match browser {
        "firefox" => rookie::firefox(domains),
        "librewolf" => rookie::librewolf(domains),
        "chrome" => rookie::chrome(domains),
        "chromium" => rookie::chromium(domains),
        "brave" => rookie::brave(domains),
        "edge" => rookie::edge(domains),
        "opera" => rookie::opera(domains),
        "opera_gx" => rookie::opera_gx(domains),
        "vivaldi" => rookie::vivaldi(domains),
        #[cfg(target_os = "macos")]
        "safari" => rookie::safari(domains),
        _ => return Err(format!("unknown browser '{browser}'")),
    }
    .map_err(|e| e.to_string())?;
    Ok(cookies
        .into_iter()
        .find(|c| c.name == SESSION_COOKIE_NAME)
        .map(|c| c.value))
}

/// In-priority order of browsers we'll try when the user hasn't picked one.
/// Firefox first because it doesn't need OS keyring decryption (no prompt).
const BROWSER_PRIORITY: &[&str] = &[
    "firefox",
    "librewolf",
    "chrome",
    "chromium",
    "brave",
    "edge",
    "vivaldi",
    "opera",
    "opera_gx",
    #[cfg(target_os = "macos")]
    "safari",
];

#[tauri::command]
pub async fn detect_browsers_with_patreon() -> Vec<BrowserProbe> {
    let mut out = Vec::new();
    for &b in BROWSER_PRIORITY {
        match read_session_from_browser(b) {
            Ok(Some(_)) => out.push(BrowserProbe {
                browser: b.to_string(),
                has_session_cookie: true,
                error: None,
            }),
            Ok(None) => out.push(BrowserProbe {
                browser: b.to_string(),
                has_session_cookie: false,
                error: None,
            }),
            Err(e) => out.push(BrowserProbe {
                browser: b.to_string(),
                has_session_cookie: false,
                error: Some(e),
            }),
        }
    }
    out
}

/// Try each browser in priority order. First one that yields a valid Patreon
/// session wins. Errors from individual browsers (missing, locked, no profile)
/// are collected and surfaced only if *every* browser fails.
#[tauri::command]
pub async fn patreon_connect_via_browser(
    state: State<'_, AppState>,
    prefer_browser: Option<String>,
) -> AppResult<BrowserConnectResult> {
    let client = build_client()?;
    let mut errors: Vec<String> = Vec::new();
    let mut had_cookie_but_invalid = false;

    let order: Vec<&str> = if let Some(b) = prefer_browser.as_deref() {
        vec![b]
    } else {
        BROWSER_PRIORITY.to_vec()
    };

    for browser in order {
        match read_session_from_browser(browser) {
            Ok(Some(cookie_value)) => {
                match fetch_current_user(&client, &cookie_value).await {
                    Ok(Some(user)) => {
                        save_session(&state.db, &cookie_value, &user)?;
                        return Ok(BrowserConnectResult {
                            user,
                            browser: browser.to_string(),
                        });
                    }
                    Ok(None) => {
                        had_cookie_but_invalid = true;
                        errors.push(format!(
                            "{browser}: found a Patreon cookie but it didn't authenticate (expired or wrong account)"
                        ));
                    }
                    Err(e) => {
                        errors.push(format!("{browser}: validation HTTP error: {e}"));
                    }
                }
            }
            Ok(None) => {
                // No Patreon cookie in this browser — skip silently.
            }
            Err(e) => {
                errors.push(format!("{browser}: {e}"));
            }
        }
    }

    if had_cookie_but_invalid {
        return Err(AppError::Other(
            "found a Patreon cookie in your browser but it didn't authenticate — log into patreon.com again, then click Connect".into(),
        ));
    }
    if errors.is_empty() {
        return Err(AppError::Other(
            "no Patreon session found in any browser. Log into patreon.com in your normal browser, then click Connect again.".into(),
        ));
    }
    Err(AppError::Other(format!(
        "couldn't read browser cookies: {}",
        errors.join(" · ")
    )))
}

#[tauri::command]
pub async fn patreon_disconnect(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    clear_session(&state.db)?;
    if let Some(win) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

const MEMBERSHIPS_ENDPOINT: &str = "https://www.patreon.com/api/current_user?include=memberships,memberships.campaign,memberships.currently_entitled_tiers&fields[campaign]=name,url,avatar_photo_url,vanity&fields[member]=patron_status,currently_entitled_amount_cents,is_follower&fields[tier]=title,amount_cents";
const MEMBERSHIPS_TTL_SECS: i64 = 300;

#[derive(Debug, Clone, Serialize)]
pub struct BackedCreator {
    pub campaign_id: String,
    pub campaign_name: String,
    pub campaign_url: Option<String>,
    pub creator_avatar_url: Option<String>,
    pub patron_status: Option<String>,
    pub currently_entitled_amount_cents: i64,
    pub is_follower: bool,
    pub tier_titles: Vec<String>,
}

fn parse_memberships(json: &serde_json::Value) -> Vec<BackedCreator> {
    let included = json
        .get("included")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let campaigns: std::collections::HashMap<String, &serde_json::Value> = included
        .iter()
        .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("campaign"))
        .filter_map(|v| {
            let id = v.get("id")?.as_str()?.to_string();
            Some((id, v))
        })
        .collect();

    let tiers: std::collections::HashMap<String, &serde_json::Value> = included
        .iter()
        .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("tier"))
        .filter_map(|v| {
            let id = v.get("id")?.as_str()?.to_string();
            Some((id, v))
        })
        .collect();

    let members = included
        .iter()
        .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("member"));

    let mut out = Vec::new();
    for member in members {
        let attrs = match member.get("attributes") {
            Some(a) => a,
            None => continue,
        };
        let relationships = member.get("relationships");
        let campaign_id = relationships
            .and_then(|r| r.get("campaign"))
            .and_then(|c| c.get("data"))
            .and_then(|d| d.get("id"))
            .and_then(|i| i.as_str())
            .map(|s| s.to_string());
        let Some(campaign_id) = campaign_id else {
            continue;
        };
        let campaign = campaigns.get(&campaign_id);
        let campaign_attrs = campaign.and_then(|c| c.get("attributes"));
        let campaign_name = campaign_attrs
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("(unknown)")
            .to_string();
        let campaign_url = campaign_attrs
            .and_then(|a| a.get("url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let avatar = campaign_attrs
            .and_then(|a| a.get("avatar_photo_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let patron_status = attrs
            .get("patron_status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let amount_cents = attrs
            .get("currently_entitled_amount_cents")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let is_follower = attrs
            .get("is_follower")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let tier_ids: Vec<String> = relationships
            .and_then(|r| r.get("currently_entitled_tiers"))
            .and_then(|t| t.get("data"))
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let tier_titles: Vec<String> = tier_ids
            .iter()
            .filter_map(|tid| tiers.get(tid))
            .filter_map(|t| {
                t.get("attributes")
                    .and_then(|a| a.get("title"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();

        out.push(BackedCreator {
            campaign_id,
            campaign_name,
            campaign_url,
            creator_avatar_url: avatar,
            patron_status,
            currently_entitled_amount_cents: amount_cents,
            is_follower,
            tier_titles,
        });
    }
    out
}

fn read_memberships_cache(db: &Db) -> AppResult<Option<(String, i64)>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT json, fetched_at FROM patreon_memberships_cache WHERE id = 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        } else {
            Ok(None)
        }
    })
}

fn write_memberships_cache(db: &Db, json: &str) -> AppResult<()> {
    let now = now_secs();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO patreon_memberships_cache (id, json, fetched_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
            rusqlite::params![json, now],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub async fn list_backed_creators(
    state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> AppResult<Vec<BackedCreator>> {
    let force = force_refresh.unwrap_or(false);
    if !force {
        if let Some((cached_json, fetched_at)) = read_memberships_cache(&state.db)? {
            if now_secs() - fetched_at < MEMBERSHIPS_TTL_SECS {
                let json: serde_json::Value = serde_json::from_str(&cached_json)?;
                return Ok(parse_memberships(&json));
            }
        }
    }

    let cookie = load_session_cookie(&state.db)?
        .ok_or_else(|| AppError::Other("not connected to Patreon".into()))?;

    let client = build_client()?;
    let resp = client
        .get(MEMBERSHIPS_ENDPOINT)
        .header("Cookie", format!("{SESSION_COOKIE_NAME}={cookie}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("patreon http: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "patreon memberships: HTTP {}",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Other(format!("patreon body: {e}")))?;
    write_memberships_cache(&state.db, &body)?;
    let json: serde_json::Value = serde_json::from_str(&body)?;
    Ok(parse_memberships(&json))
}

/// Walk a creator's post timeline and collect every post id where
/// Patreon reports `current_user_can_view: true`. This is the
/// authoritative gate — Patreon's `current_user.memberships` hides
/// former patrons who still have entitled-through-period access, so
/// purely tier-based gating undercounts what the user can actually
/// install. Pages until exhausted; capped to avoid runaway calls
/// against creators with thousands of posts.
async fn fetch_viewable_posts_for_campaign(
    client: &reqwest::Client,
    session_cookie: &str,
    campaign_id: &str,
) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut next: Option<String> = Some(format!(
        "https://www.patreon.com/api/posts?filter[campaign_id]={campaign_id}\
         &fields[post]=current_user_can_view\
         &page[size]=40&sort=-published_at"
    ));
    let mut pages = 0u32;
    while let Some(url) = next.take() {
        if pages >= 50 {
            // Hard ceiling — 50 pages × 40 = 2000 posts is more than any
            // creator we ship has. Anything beyond is a runaway loop.
            break;
        }
        pages += 1;
        // Brief inter-page pacing to stay under Patreon's ~60 req/min/IP.
        // First page free; subsequent pages wait 250ms. Without this,
        // 13 creators × ~2-3 pages each fires ~30 requests in <2s and
        // routinely trips 429.
        if pages > 1 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        // Retry-on-429 with backoff. Patreon includes Retry-After
        // sometimes; honor it when present, otherwise pick a small
        // exponential.
        let mut attempt: u32 = 0;
        let resp = loop {
            let r = client
                .get(&url)
                .header("Cookie", format!("{SESSION_COOKIE_NAME}={session_cookie}"))
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| AppError::Other(format!("patreon http: {e}")))?;
            if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 3 {
                let secs = r
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .unwrap_or((1u64 << attempt).saturating_mul(3))
                    .clamp(2, 30);
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                attempt += 1;
                continue;
            }
            break r;
        };
        if !resp.status().is_success() {
            return Err(AppError::Other(format!(
                "patreon posts (campaign {campaign_id}): HTTP {}",
                resp.status()
            )));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(format!("patreon json: {e}")))?;
        if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
            for p in arr {
                let viewable = p
                    .pointer("/attributes/current_user_can_view")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if !viewable {
                    continue;
                }
                if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
                    out.push(id.to_string());
                }
            }
        }
        next = body
            .pointer("/links/next")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
    Ok(out)
}

fn write_viewable_posts(db: &Db, post_ids: &[String]) -> AppResult<()> {
    let now = now_secs();
    db.with_conn(|c| {
        let tx = c.unchecked_transaction()?;
        tx.execute("DELETE FROM viewable_posts", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO viewable_posts (patreon_post_id, fetched_at) \
                 VALUES (?1, ?2)",
            )?;
            for pid in post_ids {
                stmt.execute(rusqlite::params![pid, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn read_viewable_posts(db: &Db) -> AppResult<std::collections::HashSet<String>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT patreon_post_id FROM viewable_posts")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    })
}

/// Refresh the viewable-post set across every creator in the bundled
/// skin index. Called after Patreon connect and on browse mount; cheap
/// enough (~13 creators × few pages) that we don't bother with TTL
/// caching beyond the DB table itself.
#[tauri::command]
pub async fn refresh_viewable_posts(state: State<'_, AppState>) -> AppResult<usize> {
    let cookie = load_session_cookie(&state.db)?
        .ok_or_else(|| AppError::Other("not connected to Patreon".into()))?;
    // Pull campaign ids from the cached index — same source the rest of
    // the app uses to enumerate creators.
    let campaign_ids: Vec<String> = state.db.with_conn(|c| {
        let json: Option<String> = c
            .query_row(
                "SELECT json FROM skin_index_cache WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .ok();
        let mut ids: Vec<String> = Vec::new();
        if let Some(s) = json {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(arr) = v.get("creators").and_then(|c| c.as_array()) {
                    for c in arr {
                        if let Some(id) = c
                            .get("patreon_campaign_id")
                            .and_then(|v| v.as_str())
                        {
                            ids.push(id.to_string());
                        }
                    }
                }
            }
        }
        Ok(ids)
    })?;

    let client = build_client()?;
    let mut all_ids: Vec<String> = Vec::new();
    for cid in campaign_ids {
        match fetch_viewable_posts_for_campaign(&client, &cookie, &cid).await {
            Ok(mut ids) => all_ids.append(&mut ids),
            Err(e) => {
                // Don't fail the whole refresh on one bad campaign — log
                // and continue. The user still gets the gate corrected
                // for the creators that succeeded.
                eprintln!("viewable_posts: campaign {cid} failed: {e}");
            }
        }
    }
    let count = all_ids.len();
    write_viewable_posts(&state.db, &all_ids)?;
    Ok(count)
}
