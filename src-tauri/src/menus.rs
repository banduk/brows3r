//! Native menu builder for brows3r.
//!
//! `build_menu` constructs the full application menu (File, Edit, View, Go,
//! Help) using Tauri 2's menu API.  Menu item IDs are namespaced with
//! `menu:` followed by the command path so the frontend event bridge can
//! map them directly to registered commands:
//!
//!   menu:file.new-folder  →  registry command "file.new-folder"
//!   menu:edit.copy        →  registry command "clipboard.copy"
//!   …
//!
//! The frontend registers a `menu-event` listener in `installMenuBridge` and
//! dispatches each incoming event to the command registry.
//!
//! OCP: adding a new menu item means adding one `MenuItem` + one command
//! registration on the frontend.  No other code needs to change.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Build the full application menu and return it.
///
/// Returns an error if any menu item or submenu cannot be constructed, which
/// would indicate a Tauri API contract violation (should not happen at
/// runtime).
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ------------------------------------------------------------------
    // File menu
    // ------------------------------------------------------------------

    let new_folder = MenuItem::with_id(
        app,
        "menu:file/new-folder",
        "New Folder",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    let open_item = MenuItem::with_id(app, "menu:file/open", "Open", true, Some("Return"))?;

    let save_item = MenuItem::with_id(app, "menu:file/save", "Save", true, Some("CmdOrCtrl+S"))?;

    let sep_file = PredefinedMenuItem::separator(app)?;

    let quit_item = PredefinedMenuItem::quit(app, Some("Quit brows3r"))?;

    let file_menu = Submenu::with_id_and_items(
        app,
        "menu:file",
        "File",
        true,
        &[&new_folder, &open_item, &save_item, &sep_file, &quit_item],
    )?;

    // ------------------------------------------------------------------
    // Edit menu
    // ------------------------------------------------------------------

    let undo_item = PredefinedMenuItem::undo(app, Some("Undo"))?;
    let redo_item = PredefinedMenuItem::redo(app, Some("Redo"))?;
    let sep_edit1 = PredefinedMenuItem::separator(app)?;
    let cut_item = PredefinedMenuItem::cut(app, Some("Cut"))?;
    let copy_item = PredefinedMenuItem::copy(app, Some("Copy"))?;
    let paste_item = PredefinedMenuItem::paste(app, Some("Paste"))?;
    let sep_edit2 = PredefinedMenuItem::separator(app)?;
    let select_all_item = PredefinedMenuItem::select_all(app, Some("Select All"))?;
    let sep_edit3 = PredefinedMenuItem::separator(app)?;

    let find_item = MenuItem::with_id(app, "menu:edit/find", "Find", true, Some("CmdOrCtrl+F"))?;

    let edit_menu = Submenu::with_id_and_items(
        app,
        "menu:edit",
        "Edit",
        true,
        &[
            &undo_item,
            &redo_item,
            &sep_edit1,
            &cut_item,
            &copy_item,
            &paste_item,
            &sep_edit2,
            &select_all_item,
            &sep_edit3,
            &find_item,
        ],
    )?;

    // ------------------------------------------------------------------
    // View menu
    // ------------------------------------------------------------------

    let view_details = MenuItem::with_id(
        app,
        "menu:view/mode/details",
        "Details",
        true,
        Some("CmdOrCtrl+1"),
    )?;
    let view_icon_grid = MenuItem::with_id(
        app,
        "menu:view/mode/icon-grid",
        "Icon Grid",
        true,
        Some("CmdOrCtrl+2"),
    )?;
    let view_gallery = MenuItem::with_id(
        app,
        "menu:view/mode/gallery",
        "Gallery",
        true,
        Some("CmdOrCtrl+3"),
    )?;
    let view_column = MenuItem::with_id(
        app,
        "menu:view/mode/column",
        "Column",
        true,
        Some("CmdOrCtrl+4"),
    )?;
    let view_tree = MenuItem::with_id(
        app,
        "menu:view/mode/tree",
        "Tree",
        true,
        Some("CmdOrCtrl+5"),
    )?;
    let view_flat_key = MenuItem::with_id(
        app,
        "menu:view/mode/flat-key",
        "Flat Key",
        true,
        Some("CmdOrCtrl+6"),
    )?;
    let view_dual_pane = MenuItem::with_id(
        app,
        "menu:view/mode/dual-pane",
        "Dual Pane",
        true,
        Some("CmdOrCtrl+7"),
    )?;

    let sep_view1 = PredefinedMenuItem::separator(app)?;

    let refresh_item = MenuItem::with_id(
        app,
        "menu:view/refresh",
        "Refresh",
        true,
        Some("CmdOrCtrl+R"),
    )?;

    let sep_view2 = PredefinedMenuItem::separator(app)?;

    let toggle_sidebar = MenuItem::with_id(
        app,
        "menu:view/toggle-sidebar",
        "Toggle Sidebar",
        true,
        None::<&str>,
    )?;

    let toggle_preview = MenuItem::with_id(
        app,
        "menu:view/toggle-preview",
        "Toggle Preview",
        true,
        None::<&str>,
    )?;

    let view_menu = Submenu::with_id_and_items(
        app,
        "menu:view",
        "View",
        true,
        &[
            &view_details,
            &view_icon_grid,
            &view_gallery,
            &view_column,
            &view_tree,
            &view_flat_key,
            &view_dual_pane,
            &sep_view1,
            &refresh_item,
            &sep_view2,
            &toggle_sidebar,
            &toggle_preview,
        ],
    )?;

    // ------------------------------------------------------------------
    // Go menu
    // ------------------------------------------------------------------

    let back_item = MenuItem::with_id(app, "menu:go/back", "Back", true, Some("CmdOrCtrl+["))?;

    let forward_item =
        MenuItem::with_id(app, "menu:go/forward", "Forward", true, Some("CmdOrCtrl+]"))?;

    let up_item = MenuItem::with_id(app, "menu:go/up", "Up", true, Some("CmdOrCtrl+Up"))?;

    let sep_go = PredefinedMenuItem::separator(app)?;

    let bookmarks_item =
        MenuItem::with_id(app, "menu:go/bookmarks", "Bookmarks", true, None::<&str>)?;

    let go_menu = Submenu::with_id_and_items(
        app,
        "menu:go",
        "Go",
        true,
        &[
            &back_item,
            &forward_item,
            &up_item,
            &sep_go,
            &bookmarks_item,
        ],
    )?;

    // ------------------------------------------------------------------
    // Help menu
    // ------------------------------------------------------------------

    let about_item =
        PredefinedMenuItem::about(app, Some("About brows3r"), Some(AboutMetadata::default()))?;

    let sep_help = PredefinedMenuItem::separator(app)?;

    let docs_item = MenuItem::with_id(app, "menu:help/docs", "Documentation", true, None::<&str>)?;

    let report_bug_item = MenuItem::with_id(
        app,
        "menu:help/report-bug",
        "Report a Bug",
        true,
        None::<&str>,
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        "menu:help",
        "Help",
        true,
        &[&about_item, &sep_help, &docs_item, &report_bug_item],
    )?;

    // ------------------------------------------------------------------
    // Assemble top-level menu
    // ------------------------------------------------------------------

    Menu::with_items(
        app,
        &[&file_menu, &edit_menu, &view_menu, &go_menu, &help_menu],
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // `build_menu` requires a real AppHandle which is not constructable in a
    // unit-test context without a full Tauri mock runtime.
    //
    // The smoke test here verifies the module-level public surface compiles and
    // that the function signature is stable. A full integration test requires
    // a Tauri test runtime (tracked as a follow-up); the CI build is the
    // primary gate for menu compilation correctness.

    #[test]
    fn build_menu_symbol_is_reachable() {
        // Verify the symbol resolves at link time — no runtime is needed.
        let _ = super::build_menu::<tauri::Wry>;
    }
}
