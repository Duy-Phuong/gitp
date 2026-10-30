//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this crate only translates
//! IPC calls and streams the terminal.
//!
//! Each command delegates to a plain `*_impl` function that takes `&RepoState`,
//! so the open→log→detail flow (including repo switching) is unit-testable
//! without a Tauri runtime. The commands are grouped by area into the modules
//! below (`state` holds the shared session state and caches); each module ends
//! with its Tauri command wrappers, which `run` registers.

mod askpass;
mod bisect;
mod branches;
mod commits;
mod compare;
mod config;
mod conflict;
mod history;
mod os;
mod rebase;
mod reflog;
mod remote;
mod staging;
mod stash;
mod state;
mod submodules;
mod tags;
mod template;
pub mod terminal;
#[cfg(test)]
mod test_support;
mod undo;
mod watch;
mod workspace;
mod worktrees;

use std::sync::Arc;

use state::RepoState;
use tauri::{Emitter, Manager};
use terminal::TerminalState;
use watch::{ChangeSink, REPO_CHANGED_EVENT};

// --- Tauri command wrappers -------------------------------------------------
//
// Every wrapper is `command(async)`, not a plain `command`. A plain synchronous
// Tauri command runs *inline on the main thread* — the thread driving the
// webview — so a `git status` (~110ms on a large repo), a log walk (~200ms),
// or, worst of all, a push over the network froze the whole window for its
// duration. `(async)` dispatches the same synchronous body onto the async
// runtime's thread pool instead, so the UI keeps painting and scrolling while
// git works. The bodies stay synchronous; only where they run changes.

/// Build and run the desktop app.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepoState::default())
        .manage(TerminalState::default())
        .setup(|app| {
            // Repository watchers push changes on disk to the frontend (see
            // `watch`); they need the app handle to emit, which exists only now.
            let handle = app.handle().clone();
            let sink: ChangeSink = Arc::new(move |change| {
                let _ = handle.emit(REPO_CHANGED_EVENT, change);
            });
            app.state::<RepoState>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .on_change = Some(sink);
            // Network ops report progress through the same handle.
            let handle = app.handle().clone();
            app.state::<RepoState>().1.set_emitter(move |event| {
                let _ = handle.emit("git-progress", event);
            });
            // ... and ask for missing credentials in a dialog, which needs the
            // helper script on disk (it asks through osascript, so macOS only).
            #[cfg(target_os = "macos")]
            if let Some(path) = askpass::prepare(&app.path().app_data_dir()?) {
                app.state::<RepoState>().1.set_askpass(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::open_repo,
            workspace::list_repos,
            workspace::activate_repo,
            workspace::close_repo,
            history::get_log_page,
            history::search_log,
            history::log_index_of,
            history::get_commit_detail,
            history::get_commit_file_diff,
            compare::compare_revs,
            compare::get_compare_file_diff,
            history::get_refs,
            staging::get_working_changes,
            staging::get_status,
            staging::get_status_summary,
            staging::get_file_diff,
            staging::stage,
            staging::unstage,
            staging::stage_hunk,
            staging::unstage_hunk,
            staging::discard_hunk,
            staging::stage_lines,
            staging::unstage_lines,
            staging::discard_lines,
            staging::stage_all,
            staging::unstage_all,
            undo::undo_state,
            undo::undo,
            undo::redo,
            staging::commit_changes,
            branches::checkout_branch,
            branches::checkout_remote,
            branches::create_branch,
            commits::checkout_commit,
            branches::create_branch_at,
            tags::create_tag_at,
            history::history_fingerprint,
            tags::tag_detail,
            tags::push_tag,
            tags::delete_tag,
            tags::delete_remote_tag,
            tags::remote_tag_exists,
            commits::cherry_pick,
            commits::revert,
            commits::reset,
            rebase::rebase_onto,
            branches::rename_branch,
            branches::rename_remote_branch,
            branches::create_backup_branch,
            branches::delete_branch,
            branches::delete_remote_branch,
            branches::remote_branch_exists,
            branches::merge_branch,
            remote::push_branch,
            remote::fetch_branch,
            remote::fetch_all,
            remote::fetch_remote,
            branches::gone_branches,
            branches::delete_branches,
            remote::fetch_and_update_branch,
            branches::fast_forward_branch,
            branches::set_upstream,
            branches::unset_upstream,
            remote::create_pull_request,
            remote::cancel_network_op,
            rebase::get_rebase_todo,
            rebase::interactive_rebase,
            rebase::rebase_status,
            rebase::rebase_continue,
            rebase::rebase_skip,
            rebase::rebase_abort,
            remote::pull,
            remote::push,
            remote::push_force,
            stash::stash,
            stash::stash_pop,
            stash::stash_apply,
            stash::stash_drop,
            stash::stash_rename,
            stash::save_stash_patch,
            staging::discard_files,
            stash::stash_files,
            staging::save_files_patch,
            staging::add_to_gitignore,
            staging::untrack_files,
            os::reveal_path,
            workspace::workspace_snapshot,
            os::open_in_editor,
            config::read_dotfile,
            config::write_dotfile,
            config::export_config_template,
            config::apply_config_template,
            conflict::conflict_status,
            conflict::conflict_sides,
            conflict::resolve_conflict,
            conflict::resolve_conflict_side,
            conflict::abort_conflict,
            conflict::finish_conflict,
            history::get_commit_tree,
            history::get_blame,
            history::get_file_history,
            config::get_config,
            config::set_config,
            reflog::get_reflog,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            bisect::bisect_status,
            bisect::bisect_start,
            bisect::bisect_mark,
            bisect::bisect_reset,
            history::get_commit_signature,
            staging::get_signing_config,
            worktrees::list_worktrees,
            worktrees::add_worktree,
            worktrees::remove_worktree,
            worktrees::lock_worktree,
            worktrees::unlock_worktree,
            worktrees::prune_worktrees,
            submodules::list_submodules,
            submodules::update_submodules,
            submodules::sync_submodules,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitp");
}
