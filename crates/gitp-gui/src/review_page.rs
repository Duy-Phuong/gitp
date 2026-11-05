//! The saved review page of a pull request, shown inside gitp: served on the
//! `gitp-review:` scheme to a sandboxed frame of the pull request view.
//!
//! The page brings its own scripts (a Markdown renderer and Mermaid, inline),
//! which the app's own policy would block in a frame of its document; served
//! from here, it gets a policy of its own: its inline scripts run, but it
//! fetches nothing and the frame's sandbox keeps it off the app. A small
//! bridge script added at the end talks to the view (`review-bridge.js`).

use std::borrow::Cow;
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::RepoState;

pub(crate) const SCHEME: &str = "gitp-review";

const BRIDGE: &str = include_str!("../webui/src/review-bridge.js");

// Inline scripts and styles only; Mermaid may lay out in a worker.
const PAGE_CSP: &str =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; \
     style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/// Answer `gitp-review://localhost/<number>`: the saved review page of pull
/// request `<number>` of the open repository, read off the main thread.
pub(crate) fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let number = request.uri().path().trim_matches('/').parse::<u64>().ok();
        let page = number
            .ok_or_else(|| "not a pull request number".to_string())
            .and_then(|n| page_of(&app.state::<RepoState>(), n));
        responder.respond(match page {
            Ok(html) => Response::builder()
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_SECURITY_POLICY, PAGE_CSP)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Cow::Owned(html.into_bytes()))
                .unwrap(),
            Err(why) => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(Cow::Owned(why.into_bytes()))
                .unwrap(),
        });
    });
}

/// The HTML page of pull request `number`'s saved review, with the bridge.
fn page_of(state: &RepoState, number: u64) -> Result<String, String> {
    let file = crate::gh::review_files_impl(state)?
        .into_iter()
        .find(|f| f.number == number)
        .ok_or_else(|| format!("#{number} has no saved review"))?;
    // The newest file may be the Markdown copy; the page is beside it.
    let path = PathBuf::from(&file.path).with_extension("html");
    let html = std::fs::read_to_string(&path)
        .map_err(|e| format!("can't read {}: {e}", path.display()))?;
    Ok(with_bridge(&html))
}

fn with_bridge(html: &str) -> String {
    let script = format!("<script>\n{BRIDGE}\n</script>\n");
    match html.rfind("</body>") {
        Some(at) => format!("{}{script}{}", &html[..at], &html[at..]),
        None => format!("{html}{script}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_runs_after_the_pages_own_scripts() {
        let out = with_bridge("<body><script>page()</script></body></html>");
        let page = out.find("page()").unwrap();
        let bridge = out.find("gitpReview").unwrap();
        assert!(
            page < bridge && bridge < out.find("</body>").unwrap(),
            "{out}"
        );
        assert!(with_bridge("<p>no body tag").contains("gitpReview"));
    }
}
