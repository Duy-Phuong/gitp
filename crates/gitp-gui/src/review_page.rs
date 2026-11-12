//! The saved review page of a pull request, shown inside gitp: served on the
//! `gitp-review:` scheme to a sandboxed frame of the pull request view.
//!
//! The page brings its own scripts (a Markdown renderer and Mermaid, inline),
//! which the app's own policy would block in a frame of its document; served
//! from here, it gets a policy of its own: its inline scripts run, but it
//! fetches nothing and the frame's sandbox keeps it off the app. A small
//! bridge script added at the end talks to the view (`review-bridge.js`).
//!
//! A page made without its libraries inline (the review skill's thin page)
//! loads `marked` and Mermaid from jsDelivr, which that policy refuses: gitp
//! serves its own copies at `lib/marked.js` and `lib/mermaid.js` instead and
//! points the page's script tags there, so the page renders offline too.

use std::borrow::Cow;
use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::RepoState;

pub(crate) const SCHEME: &str = "gitp-review";

const BRIDGE: &str = include_str!("../webui/src/review-bridge.js");

// gitp's copies of the libraries a thin page loads from jsDelivr.
const MARKED: &str = include_str!("../webui/node_modules/marked/lib/marked.umd.js");
const MERMAID: &str = include_str!("../webui/node_modules/mermaid/dist/mermaid.min.js");

/// The jsDelivr packages gitp has a copy of: the package's path prefix and
/// where gitp serves it, relative to the page.
const LIBRARIES: [(&str, &str); 2] = [
    ("https://cdn.jsdelivr.net/npm/marked", "lib/marked.js"),
    ("https://cdn.jsdelivr.net/npm/mermaid", "lib/mermaid.js"),
];

// Inline scripts and styles, and gitp's own copies of the libraries (on
// macOS the scheme's URL, elsewhere its localhost one); Mermaid may lay out
// in a worker.
const PAGE_CSP: &str =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: gitp-review: http://gitp-review.localhost; \
     worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/// Answer `gitp-review://localhost/<number>`: the saved review page of pull
/// request `<number>` of the open repository, read off the main thread.
pub(crate) fn serve<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let path = request.uri().path().trim_matches('/');
        let library = match path {
            "lib/marked.js" => Some(MARKED),
            "lib/mermaid.js" => Some(MERMAID),
            _ => None,
        };
        if let Some(js) = library {
            responder.respond(
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
                    .body(Cow::Borrowed(js.as_bytes()))
                    .unwrap(),
            );
            return;
        }
        let number = path.parse::<u64>().ok();
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
    Ok(with_bridge(&with_local_libraries(&html)))
}

/// `html` with each `<script src>` of a jsDelivr package gitp has a copy of
/// pointed at that copy.
fn with_local_libraries(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("<script") {
        let Some(end) = rest[at..].find('>').map(|e| at + e + 1) else {
            break;
        };
        let tag = &rest[at..end];
        let local = LIBRARIES.iter().find_map(|(cdn, local)| {
            let src = tag.find(&format!("src=\"{cdn}"))? + 5;
            let len = tag[src..].find('"')?;
            Some((src, src + len, *local))
        });
        out.push_str(&rest[..at]);
        match local {
            Some((s, e, local)) => out.push_str(&format!("{}{local}{}", &tag[..s], &tag[e..])),
            None => out.push_str(tag),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
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
    fn a_thin_page_gets_gitps_copies_of_its_libraries() {
        let page = "<script type=\"text/plain\" id=\"markdown-source\">x</script>\n\
            <script src=\"https://cdn.jsdelivr.net/npm/marked/marked.min.js\"></script>\n\
            <script defer src=\"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js\"></script>\n\
            <script src=\"https://cdn.jsdelivr.net/npm/other/x.js\"></script>\n\
            <script>marked.parse(s)</script>";
        let out = with_local_libraries(page);
        assert!(
            out.contains("<script src=\"lib/marked.js\"></script>"),
            "{out}"
        );
        assert!(
            out.contains("<script defer src=\"lib/mermaid.js\"></script>"),
            "{out}"
        );
        // Only the packages gitp has; everything else as it was.
        assert!(out.contains("npm/other/x.js"));
        assert!(out.contains("<script type=\"text/plain\" id=\"markdown-source\">x</script>"));
        assert!(out.ends_with("<script>marked.parse(s)</script>"));
        assert_eq!(
            with_local_libraries("<p>no scripts</p>"),
            "<p>no scripts</p>"
        );
        // The copies are the browser builds the page expects.
        assert!(MARKED.contains("marked") && MARKED.len() > 10_000);
        assert!(MERMAID.contains("mermaid") && MERMAID.len() > 1_000_000);
    }

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
