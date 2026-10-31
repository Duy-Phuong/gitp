//! gitp desktop backend. Thin Tauri adapter over `gitp-core`, plus an embedded
//! PTY terminal. All git logic lives in `gitp-core`; this crate only translates
//! IPC calls and streams the terminal.
//!
//! Each command delegates to a plain `*_impl` function that takes `&RepoState`,
//! so the open→log→detail flow (including repo switching) is unit-testable
//! without a Tauri runtime. The commands are grouped by area into the modules
//! below (`state` holds the shared session state and caches); each module ends
//! with its Tauri command wrappers, which `run` registers.

mod activity;
mod askpass;
mod bisect;
mod branches;
mod code;
mod commits;
mod compare;
mod config;
mod conflict;
mod editor;
mod gh;
mod gitflow;
mod history;
mod lfs;
mod local_history;
mod local_workspaces;
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

/// How many async workers run command bodies.
///
/// A body holds its worker until it returns, so Tauri's default runtime — one
/// worker per CPU core — let a handful of slow commands (pushes, a first log
/// walk, waits on the workspace lock) take every worker, and every other
/// command, however quick, queued behind them. Idle workers cost only a parked
/// thread, so the pool is sized for bursts rather than for the cores.
const COMMAND_WORKERS: usize = 64;

/// The runtime Tauri dispatches command bodies to.
fn command_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(COMMAND_WORKERS)
        .enable_all()
        .build()
        .expect("failed to start the async runtime")
}

/// Build and run the desktop app.
pub fn run() {
    let runtime = command_runtime();
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RepoState::default())
        .manage(TerminalState::default())
        .manage(local_workspaces::WorkspaceOps::default())
        .manage(gh::GhLoginState::default())
        .setup(|app| {
            // Repository watchers push changes on disk to the frontend (see
            // `watch`); they need the app handle to emit, which exists only now.
            let handle = app.handle().clone();
            let code_handle = app.handle().clone();
            let sink: ChangeSink = Arc::new(move |change| {
                // A working-tree change also arms that repository's local
                // history snapshot (see `local_history`), and feeds the Code
                // tab's index when that tab has opened the repository.
                if change.kinds.contains(&"worktree") {
                    local_history::note_change(&change.path);
                    code::feed_index(&code_handle, &change);
                }
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
            workspace::init_repository,
            workspace::list_repos,
            workspace::activate_repo,
            workspace::close_repo,
            workspace::move_repo,
            history::get_log_page,
            history::search_log,
            history::log_index_of,
            history::get_commit_detail,
            history::get_commit_file_diff,
            history::get_file_content,
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
            branches::stash_and_switch,
            branches::create_branch,
            commits::checkout_commit,
            branches::create_branch_at,
            tags::create_tag_at,
            tags::annotate_tag,
            history::history_fingerprint,
            tags::tag_detail,
            tags::push_tag,
            tags::delete_tag,
            tags::delete_remote_tag,
            tags::remote_tag_exists,
            commits::cherry_pick,
            commits::cherry_pick_plan,
            commits::continue_cherry_pick_plan,
            commits::revert,
            commits::reset,
            commits::save_commits_patch,
            rebase::rebase_onto,
            branches::rename_branch,
            branches::rename_remote_branch,
            branches::create_backup_branch,
            branches::delete_branch,
            branches::delete_remote_branch,
            branches::remote_branch_exists,
            branches::merge_branch,
            branches::merge_preview,
            branches::squash_message,
            gitflow::gitflow_config,
            gitflow::gitflow_init,
            gitflow::gitflow_start,
            gitflow::gitflow_finish,
            remote::push_branch,
            remote::push_branch_to,
            remote::fetch_branch,
            remote::fetch_all,
            remote::perform_maintenance,
            remote::fetch_remote,
            remote::list_remotes,
            remote::add_remote,
            remote::set_remote_url,
            remote::rename_remote,
            remote::remove_remote,
            branches::gone_branches,
            branches::delete_branches,
            remote::fetch_and_update_branch,
            branches::fast_forward_branch,
            branches::fast_forward_branch_to,
            branches::set_upstream,
            branches::unset_upstream,
            remote::create_pull_request,
            gh::gh_account,
            gh::gh_repo,
            gh::gh_pull_requests,
            gh::gh_pull_request,
            gh::gh_pull_request_files,
            gh::gh_checkout_pull_request,
            gh::gh_checkout_pull_request_worktree,
            gh::gh_comment,
            gh::gh_review,
            gh::gh_repo_settings,
            gh::gh_pull_request_draft,
            gh::gh_create_pull_request,
            gh::gh_merge_pull_request,
            gh::gh_reply,
            gh::gh_line_comment,
            gh::gh_review_with_comments,
            gh::read_review_file,
            gh::gh_generate_review,
            gh::gh_login_start,
            gh::gh_login_wait,
            gh::gh_login_cancel,
            gh::gh_logout,
            gh::open_github_url,
            remote::cancel_network_op,
            remote::clone_repository,
            local_workspaces::workspace_repo_summary,
            local_workspaces::workspace_scan_folder,
            local_workspaces::workspace_with_worktrees,
            local_workspaces::workspace_fetch,
            local_workspaces::workspace_pull,
            local_workspaces::cancel_workspace_ops,
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
            staging::restore_files_from_commit,
            staging::revert_commit_hunk,
            stash::stash_files,
            staging::save_files_patch,
            staging::save_all_changes_patch,
            staging::apply_patch,
            staging::add_to_gitignore,
            staging::untrack_files,
            os::reveal_path,
            os::reveal_folder,
            workspace::workspace_snapshot,
            os::open_in_editor,
            os::list_editors,
            os::open_repo_in_editor,
            editor::read_text_file,
            editor::write_text_file,
            editor::create_file,
            editor::delete_file,
            editor::list_work_files,
            code::code_open_workspace,
            code::code_refresh,
            code::code_read_file,
            code::code_write_file,
            code::code_definition,
            code::code_references,
            code::code_callers,
            code::code_callees,
            code::code_file_symbols,
            code::code_search,
            os::open_difftool,
            os::open_mergetool,
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
            config::unset_config,
            config::list_hooks,
            config::set_hook_enabled,
            config::open_hook,
            config::get_global_identity,
            config::set_global_identity,
            config::apply_local_identity,
            config::restore_local_identity,
            reflog::get_reflog,
            activity::get_activity_log,
            local_history::local_history,
            local_history::local_history_versions,
            local_history::local_history_file,
            local_history::local_history_restore,
            local_history::local_history_snapshot,
            local_history::local_history_clear,
            local_history::local_history_set_enabled,
            activity::clear_activity_log,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            bisect::bisect_status,
            bisect::bisect_start,
            bisect::bisect_mark,
            bisect::bisect_reset,
            history::get_commit_signature,
            staging::get_signing_config,
            staging::get_commit_template,
            worktrees::list_worktrees,
            worktrees::worktree_summaries,
            worktrees::worktree_unsaved_work,
            worktrees::add_worktree,
            worktrees::move_worktree,
            worktrees::remove_worktree,
            worktrees::lock_worktree,
            worktrees::unlock_worktree,
            worktrees::prune_worktrees,
            worktrees::stale_worktrees,
            submodules::list_submodules,
            submodules::update_submodules,
            submodules::sync_submodules,
            submodules::add_submodule,
            submodules::set_submodule_url,
            submodules::remove_submodule,
            lfs::lfs_status,
            lfs::lfs_track,
            lfs::lfs_untrack,
            lfs::lfs_install,
            lfs::lfs_fetch,
            lfs::lfs_pull,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitp");
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    // Every command body is synchronous and runs on an async worker, so a slow
    // one (a push, a full log walk, a wait on the workspace lock) holds its
    // worker until it returns. More slow commands than the default runtime
    // has workers must still leave a quick one free to run.
    #[test]
    fn slow_commands_leave_a_worker_for_a_quick_one() {
        let runtime = super::command_runtime();
        let busy = std::thread::available_parallelism().map_or(8, |n| n.get()) + 1;
        assert!(busy < super::COMMAND_WORKERS);
        for _ in 0..busy {
            runtime.spawn(async { std::thread::sleep(Duration::from_millis(1500)) });
        }
        let (tx, rx) = mpsc::channel();
        runtime.spawn(async move { tx.send(()) });
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_ok(),
            "{busy} slow commands held every worker"
        );
        runtime.shutdown_background();
    }
}
