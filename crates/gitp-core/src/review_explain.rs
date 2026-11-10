//! Explain more on a finding of a saved review, done by gitp itself: the
//! finding's text for the explain command, and its answer added to the review
//! file as the review board adds one (review/_board/sync_file.py): a
//! `<details class="explain">` block at the end of the finding, in the `.md`
//! and in the Markdown the `.html` page embeds.
//!
//! Findings are numbered as the board numbers them: in the "Suggested
//! changes" section, one per `###` block, or one per `####` heading and
//! Severity line of a block that has them.

const EXPLAIN_OPEN: &str = "<details class=\"explain\"";
const EXPLAIN_CLOSE: &str = "</details>";
const SOURCE_OPEN: &str = "<script type=\"text/plain\" id=\"markdown-source\">";
const SOURCE_CLOSE: &str = "</script>";

/// One finding: where its `###` heading starts, and its text's span.
struct Span {
    heading: usize,
    start: usize,
    end: usize,
}

/// `md` with every explain block's bytes but its newlines as `x`: the same
/// length and offsets, and nothing inside an answer (its own `####`
/// headings) can look like a finding.
fn masked(md: &str) -> String {
    let mut bytes = md.as_bytes().to_vec();
    let mut from = 0;
    while let Some(at) = md[from..].find(EXPLAIN_OPEN) {
        let start = from + at;
        let end = md[start..]
            .find(EXPLAIN_CLOSE)
            .map_or(md.len(), |e| start + e + EXPLAIN_CLOSE.len());
        for b in &mut bytes[start..end] {
            if *b != b'\n' {
                *b = b'x';
            }
        }
        from = end;
    }
    String::from_utf8(bytes).unwrap_or_default()
}

/// Each line of `text` with its start and end (before the newline).
fn lines(text: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let mut at = 0;
    text.split_inclusive('\n').map(move |l| {
        let start = at;
        at += l.len();
        let line = l.trim_end_matches('\n');
        (start, start + line.len(), line)
    })
}

fn finding_spans(md: &str) -> Vec<Span> {
    let text = masked(md);
    let all: Vec<_> = lines(&text).collect();
    let Some(sec) = all.iter().position(|(_, _, l)| {
        let low = l.to_lowercase();
        l.starts_with("## ") && (low.contains("suggested") || low.contains("comments to paste"))
    }) else {
        return Vec::new();
    };
    let start = all[sec].1;
    let end = all[sec + 1..]
        .iter()
        .find(|(_, _, l)| l.starts_with("## "))
        .map_or(text.len(), |(s, _, _)| *s);
    let heads: Vec<_> = all
        .iter()
        .filter(|(s, _, l)| *s >= start && *s < end && l.starts_with("### ") && l.len() > 4)
        .collect();
    let mut spans = Vec::new();
    for (i, (h0, h1, _)) in heads.iter().enumerate() {
        let b0 = *h1;
        let b1 = heads.get(i + 1).map_or(end, |(s, _, _)| *s);
        let subs: Vec<usize> = all
            .iter()
            .filter(|(s, _, l)| {
                *s > b0 && *s < b1 && (l.starts_with("#### ") || l.starts_with("**Severity"))
            })
            .map(|(s, _, _)| *s)
            .collect();
        let bounds: Vec<usize> = if subs.is_empty() {
            vec![b0, b1]
        } else {
            subs.into_iter().chain([b1]).collect()
        };
        for w in bounds.windows(2) {
            let (s, e) = (w[0], w[1]);
            spans.push(Span {
                heading: *h0,
                start: s,
                end: s + text[s..e].trim_end().len(),
            });
        }
    }
    spans
}

/// The text of finding `n` (1 for f1) of the review Markdown `md`, from its
/// heading, with the answers it was given already; None when there is no
/// such finding.
pub(crate) fn finding_text(md: &str, n: usize) -> Option<String> {
    let s = finding_spans(md).into_iter().nth(n.checked_sub(1)?)?;
    let heading = &md[s.heading
        ..md[s.heading..]
            .find('\n')
            .map_or(md.len(), |e| s.heading + e)];
    let body = md[s.start..s.end].trim_start_matches('\n');
    Some(if s.start > s.heading + heading.len() + 1 {
        format!("{heading}\n\n{body}")
    } else {
        format!("{heading}\n{body}")
    })
}

/// `md` with `answer` added after finding `n`'s other answers, as "Explained
/// more <count>"; None when there is no such finding.
pub(crate) fn add_explanation(md: &str, n: usize, id: &str, answer: &str) -> Option<String> {
    let s = finding_spans(md).into_iter().nth(n.checked_sub(1)?)?;
    let count = md[s.start..s.end].matches(EXPLAIN_OPEN).count() + 1;
    // The review's own `##` sections stay its own, as the board keeps them.
    let body: Vec<String> = answer
        .trim_matches('\n')
        .lines()
        .map(|l| match l.strip_prefix("## ") {
            Some(rest) => format!("#### {rest}"),
            None => l.to_string(),
        })
        .collect();
    let block = format!(
        "\n\n<details class=\"explain\" data-id=\"{id}\">\n\
         <summary>Explained more {count} (from /explain-simply in gitp)</summary>\n\n\
         <!-- explain:start {id} -->\n{}\n<!-- explain:end -->\n\n</details>",
        body.join("\n")
    );
    Some(format!("{}{block}{}", &md[..s.end], &md[s.end..]))
}

/// The Markdown a review page embeds: where it starts and ends, and its text.
fn embedded(html: &str) -> Option<(usize, usize, String)> {
    let open = html.find(SOURCE_OPEN)? + SOURCE_OPEN.len();
    let start = open + usize::from(html[open..].starts_with('\n'));
    let end = start + html[start..].find(SOURCE_CLOSE)?;
    Some((
        start,
        end,
        html[start..end].replace("<\\/script", "</script"),
    ))
}

/// The review Markdown of a review page, or None when it embeds none.
pub(crate) fn page_markdown(html: &str) -> Option<String> {
    embedded(html).map(|(_, _, md)| md)
}

/// The review page `html` with `answer` added to finding `n` of the Markdown
/// it embeds; None when it embeds none or has no such finding.
pub(crate) fn add_explanation_to_page(
    html: &str,
    n: usize,
    id: &str,
    answer: &str,
) -> Option<String> {
    let (start, end, md) = embedded(html)?;
    let new = add_explanation(&md, n, id, answer)?.replace("</script", "<\\/script");
    Some(format!("{}{new}{}", &html[..start], &html[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW: &str = "# PR Review\n\n## Summary\n\n### `a.ts:1`\nnot a finding\n\n\
## Suggested Changes & Comment Proposals\n\n\
### `src/retry.ts:12`\n\n**Severity:** 🟡 minor\n\n**Explained simply:**\n\nNo limit.\n\n\
**Comment to paste:**\n\n<!-- copy:start -->\nAdd a limit.\n<!-- copy:end -->\n\n\
### `src/check.ts:40`\n\n**Severity:** 🟢 nit\n\n**Comment to paste:**\n\nLog it.\n\n\
## Final Verdict\n\nOK\n";

    #[test]
    fn findings_are_numbered_as_the_board_numbers_them() {
        assert_eq!(finding_spans(REVIEW).len(), 2);
        let f1 = finding_text(REVIEW, 1).unwrap();
        assert!(
            f1.starts_with("### `src/retry.ts:12`\n\n**Severity:** 🟡 minor"),
            "{f1}"
        );
        assert!(f1.ends_with("<!-- copy:end -->"), "{f1}");
        assert!(finding_text(REVIEW, 2).unwrap().ends_with("Log it."));
        assert!(finding_text(REVIEW, 3).is_none());
        assert!(finding_text(REVIEW, 0).is_none());
        // A block of two findings, each with its own heading and Severity line.
        let two =
            "## Suggested changes\n### Two\n#### `a.ts:1`\n**Severity:** nit\nx\n### `c.ts:3`\ny\n";
        assert_eq!(finding_spans(two).len(), 3);
    }

    #[test]
    fn answers_go_at_the_end_of_their_finding_and_count_up() {
        let once = add_explanation(REVIEW, 1, "gitp_1", "## Why\nEach try waits.\n").unwrap();
        let block = "<!-- copy:end -->\n\n<details class=\"explain\" data-id=\"gitp_1\">\n\
<summary>Explained more 1 (from /explain-simply in gitp)</summary>\n\n\
<!-- explain:start gitp_1 -->\n#### Why\nEach try waits.\n<!-- explain:end -->\n\n</details>\n\n### `src/check.ts:40`";
        assert!(once.contains(block), "{once}");
        // The answer's own heading neither ends the finding nor makes one.
        let twice = add_explanation(&once, 1, "gitp_2", "#### Again\n**Severity** of it").unwrap();
        assert_eq!(finding_spans(&twice).len(), 2);
        assert!(
            twice.contains("<summary>Explained more 2 (from /explain-simply in gitp)</summary>")
        );
        assert!(twice.find("gitp_1").unwrap() < twice.find("gitp_2").unwrap());
        assert!(twice.find("gitp_2").unwrap() < twice.find("### `src/check.ts:40`").unwrap());
        // The next finding's text has none of them, and keeps its number.
        assert!(!finding_text(&twice, 2).unwrap().contains("explain"));
        assert!(finding_text(&twice, 1)
            .unwrap()
            .contains("Explained more 2"));
        // The last finding: before the next section.
        let last = add_explanation(REVIEW, 2, "gitp_3", "Late.").unwrap();
        assert!(last.contains("Log it.\n\n<details class=\"explain\" data-id=\"gitp_3\">"));
        assert!(last.find("gitp_3").unwrap() < last.find("## Final Verdict").unwrap());
        assert!(add_explanation(REVIEW, 9, "x", "y").is_none());
    }

    #[test]
    fn a_review_page_gets_the_answer_in_the_markdown_it_embeds() {
        let md = REVIEW.replace("Log it.", "Log it.\n<script>x</script>");
        let page = format!(
            "<html><script>let a = 1;</script>{SOURCE_OPEN}\n{}</script></html>",
            md.replace("</script", "<\\/script")
        );
        assert_eq!(page_markdown(&page).unwrap(), md);
        let out = add_explanation_to_page(&page, 2, "gitp_9", "A `</script>` in it.").unwrap();
        assert!(out.starts_with("<html><script>let a = 1;</script>"));
        assert!(out.ends_with("</script></html>"));
        let back = page_markdown(&out).unwrap();
        assert!(back.contains("A `</script>` in it."), "{back}");
        assert_eq!(
            back,
            add_explanation(&md, 2, "gitp_9", "A `</script>` in it.").unwrap()
        );
        assert!(add_explanation_to_page("<html>no review</html>", 1, "x", "y").is_none());
    }
}
