/* prefs.ts
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class CopilotUsagePreferences extends ExtensionPreferences {
  private _settings?: Gio.Settings;

  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    this._settings = this.getSettings();
    const settings = this._settings;

    window.set_default_size(620, 540);

    const page = new Adw.PreferencesPage({
      title: _("Copilot Usage"),
      icon_name: "preferences-system-symbolic",
    });
    window.add(page);

    // ── Token group ──────────────────────────────────────────────────

    const tokenGroup = new Adw.PreferencesGroup({
      title: _("GitHub Token"),
      description: _(
        "Required to fetch your Copilot monthly usage from the GitHub API.",
      ),
    });
    page.add(tokenGroup);

    const tokenRow = new Adw.PasswordEntryRow({
      title: _("GitHub OAuth Token"),
      show_apply_button: true,
    });
    tokenRow.set_text(settings.get_string("github-token"));
    tokenRow.connect("apply", () => {
      settings.set_string("github-token", tokenRow.get_text().trim());
    });
    tokenGroup.add(tokenRow);

    // ── How-to group ─────────────────────────────────────────────────

    const howtoGroup = new Adw.PreferencesGroup({
      title: _("How to get your token"),
    });
    page.add(howtoGroup);

    // Option A – GitHub CLI
    const cliRow = new Adw.ActionRow({
      title: _("Option A — GitHub CLI (recommended)"),
      subtitle: _("Run these two commands in a terminal:"),
    });
    howtoGroup.add(cliRow);

    const cliBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 4,
      margin_top: 4,
      margin_bottom: 12,
      margin_start: 12,
      margin_end: 12,
    });

    for (const cmd of ["gh auth login", "gh auth token"]) {
      const label = new Gtk.Label({
        label: cmd,
        xalign: 0,
        selectable: true,
        css_classes: ["monospace", "dim-label"],
      });
      cliBox.append(label);
    }

    const cliInstallLabel = new Gtk.Label({
      label:
        'Install GitHub CLI from: <a href="https://cli.github.com">cli.github.com</a>',
      use_markup: true,
      xalign: 0,
      margin_top: 4,
      css_classes: ["caption", "dim-label"],
    });
    cliBox.append(cliInstallLabel);

    howtoGroup.add(this._wrapInRow(cliBox));

    // Option B – Personal Access Token
    const patRow = new Adw.ActionRow({
      title: _("Option B — Personal Access Token"),
      subtitle: _(
        "Create a classic token at github.com/settings/tokens with the read:user scope.",
      ),
    });

    const openPatButton = new Gtk.Button({
      label: _("Open GitHub Token Settings"),
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"],
    });
    openPatButton.connect("clicked", () => {
      Gio.AppInfo.launch_default_for_uri(
        "https://github.com/settings/tokens/new?scopes=read%3Auser&description=GNOME+Copilot+Usage",
        null,
      );
    });
    patRow.add_suffix(openPatButton);
    patRow.set_activatable_widget(openPatButton);
    howtoGroup.add(patRow);

    // ── Auto-discovery note ──────────────────────────────────────────

    const discoveryGroup = new Adw.PreferencesGroup({
      title: _("Automatic Token Discovery"),
      description:
        _(
          "If a token is found automatically, you do not need to enter one above. " +
            "The extension checks these locations on startup:",
        ),
    });
    page.add(discoveryGroup);

    const paths: [string, string][] = [
      [_("GitHub CLI"), "~/.config/gh/hosts.yml"],
      [_("Copilot CLI / Neovim / Vim"), "~/.config/github-copilot/hosts.json"],
      [_("Copilot apps config"), "~/.config/github-copilot/apps.json"],
    ];

    for (const [source, path] of paths) {
      const row = new Adw.ActionRow({ title: source });
      const pathLabel = new Gtk.Label({
        label: path,
        valign: Gtk.Align.CENTER,
        css_classes: ["monospace", "dim-label", "caption"],
      });
      row.add_suffix(pathLabel);
      discoveryGroup.add(row);
    }

    // ── Refresh interval ─────────────────────────────────────────────

    const refreshGroup = new Adw.PreferencesGroup({ title: _("General") });
    page.add(refreshGroup);

    const refreshRow = new Adw.SpinRow({
      title: _("Auto-refresh Interval"),
      subtitle: _("How often to refresh usage data (seconds). 0 = never."),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 3600,
        step_increment: 30,
        page_increment: 60,
        value: settings.get_int("refresh-interval"),
      }),
    });
    settings.bind(
      "refresh-interval",
      refreshRow,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    refreshGroup.add(refreshRow);

    return Promise.resolve();
  }

  /** Wraps an arbitrary widget in a non-interactive PreferencesRow. */
  private _wrapInRow(widget: Gtk.Widget): Adw.PreferencesRow {
    const row = new Adw.PreferencesRow({
      activatable: false,
      focusable: false,
    });
    row.set_child(widget);
    return row;
  }
}
