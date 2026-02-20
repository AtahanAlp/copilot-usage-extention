/* extension.js
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Soup from "gi://Soup";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

const API_URL = "https://api.github.com/copilot_internal/user";

// ---------------------------------------------------------------------------
// Token discovery helpers
// Each entry: [label, filePath(home-relative parts), extractFn]
// ---------------------------------------------------------------------------

function readToken_hostsJson(json) {
  return json?.["github.com"]?.oauth_token ?? null;
}

function readToken_appsJson(json) {
  for (const key of Object.keys(json ?? {})) {
    const t = json[key]?.oauth_token;
    if (t) return t;
  }
  return null;
}

/** GitHub CLI stores tokens in a simple YAML – parse with a regex. */
function readToken_ghYml(raw) {
  const match = raw.match(/oauth_token:\s*(\S+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------

const CopilotUsageIndicator = GObject.registerClass(
  class CopilotUsageIndicator extends PanelMenu.Button {
    _init(settings, openPreferences) {
      super._init(0.0, "Copilot Usage Indicator");

      this._settings = settings;
      this._openPreferences = openPreferences;
      this._session = new Soup.Session();
      this._menuState = null; // 'setup' | 'usage'

      // ── Panel widget ──────────────────────────────────────────────
      const box = new St.BoxLayout({ style_class: "panel-status-menu-box" });

      box.add_child(
        new St.Icon({
          icon_name: "system-run-symbolic",
          style_class: "system-status-icon",
        }),
      );

      this._panelLabel = new St.Label({
        text: "…",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "copilot-panel-label",
      });
      box.add_child(this._panelLabel);
      this.add_child(box);

      // ── Build menu ────────────────────────────────────────────────
      this._buildMenu();

      // Re-fetch every time the menu is opened
      this.menu.connect("open-state-changed", (_menu, open) => {
        if (open) this._refreshUsage();
      });

      // Respond to manual token being saved in prefs
      this._settingsChangedId = this._settings.connect(
        "changed::github-token",
        () => this._refreshUsage(),
      );

      // Auto-refresh timer
      this._startTimer();
      this._refreshUsage();
    }

    // ── Menu construction ─────────────────────────────────────────────

    _buildMenu() {
      // === SETUP STATE items ==========================================

      this._setupItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const setupBox = new St.BoxLayout({
        style_class: "copilot-setup-box",
        vertical: true,
      });

      const setupIconRow = new St.BoxLayout({
        vertical: false,
        style_class: "copilot-setup-icon-row",
      });
      setupIconRow.add_child(
        new St.Icon({
          icon_name: "dialog-password-symbolic",
          style_class: "copilot-setup-icon",
          icon_size: 32,
        }),
      );
      setupBox.add_child(setupIconRow);

      this._setupHeading = new St.Label({
        text: "GitHub Token Required",
        style_class: "copilot-setup-heading",
      });
      setupBox.add_child(this._setupHeading);

      this._setupBody = new St.Label({
        text: "No Copilot credentials were found on this system.\nOpen Settings to add your GitHub token.",
        style_class: "copilot-setup-body",
      });
      this._setupBody.clutter_text.set_line_wrap(true);
      setupBox.add_child(this._setupBody);

      this._setupItem.add_child(setupBox);
      this.menu.addMenuItem(this._setupItem);

      this._setupSep = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._setupSep);

      this._openSettingsItem = new PopupMenu.PopupMenuItem(_("Open Settings"));
      this._openSettingsItem.connect("activate", () => {
        this._openPreferences();
      });
      this.menu.addMenuItem(this._openSettingsItem);

      // === USAGE STATE items ==========================================

      // Plan row
      this._planItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const planBox = new St.BoxLayout({
        style_class: "copilot-plan-box",
        vertical: false,
      });
      planBox.add_child(
        new St.Icon({
          icon_name: "avatar-default-symbolic",
          style_class: "copilot-plan-icon",
          icon_size: 14,
        }),
      );
      this._planLabel = new St.Label({
        text: "Plan: …",
        style_class: "copilot-plan-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
      planBox.add_child(this._planLabel);
      this._planItem.add_child(planBox);
      this.menu.addMenuItem(this._planItem);

      this._usageSep1 = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._usageSep1);

      // Premium Interactions row
      this._premiumProgressBar = this._addUsageRow(
        "Premium Interactions",
        "_premiumPercent",
      );

      this._usageSep2 = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._usageSep2);

      // Chat row
      this._chatProgressBar = this._addUsageRow("Chat", "_chatPercent");

      this._usageSep3 = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._usageSep3);

      // Footer (always visible when in usage state)
      this._footerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      this._updatedLabel = new St.Label({
        text: "Not yet refreshed",
        style_class: "copilot-updated-label",
      });
      this._footerItem.add_child(this._updatedLabel);
      this.menu.addMenuItem(this._footerItem);

      // === SHARED items ===============================================

      this._sharedSep = new PopupMenu.PopupSeparatorMenuItem();
      this.menu.addMenuItem(this._sharedSep);

      const refreshItem = new PopupMenu.PopupMenuItem(_("Refresh"));
      refreshItem.connect("activate", () => this._refreshUsage());
      this.menu.addMenuItem(refreshItem);

      // Start in setup state until we know better
      this._setMenuState("setup");
    }

    /** Adds a titled progress-bar row; stores the percent label at this[prop]. */
    _addUsageRow(title, percentProp) {
      const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const section = new St.BoxLayout({
        style_class: "copilot-usage-section",
        vertical: true,
      });

      const header = new St.BoxLayout({ vertical: false });
      header.add_child(
        new St.Label({ text: title, style_class: "copilot-section-title" }),
      );
      const pct = new St.Label({
        text: "…",
        style_class: "copilot-percent-label",
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
      });
      this[percentProp] = pct;
      header.add_child(pct);
      section.add_child(header);

      const bg = new St.Widget({ style_class: "copilot-progress-bg" });
      const bar = new St.Widget({
        style_class: "copilot-progress-bar usage-low",
      });
      bg.add_child(bar);
      section.add_child(bg);

      item.add_child(section);
      this.menu.addMenuItem(item);

      // Keep a reference on the item so we can show/hide it
      const propItem = `${percentProp}Item`;
      this[propItem] = item;

      return bar;
    }

    // ── State switching ───────────────────────────────────────────────

    _setMenuState(state) {
      if (this._menuState === state) return;
      this._menuState = state;

      const isSetup = state === "setup";

      // Setup items
      this._setupItem.visible = isSetup;
      this._setupSep.visible = isSetup;
      this._openSettingsItem.visible = isSetup;

      // Usage items
      this._planItem.visible = !isSetup;
      this._usageSep1.visible = !isSetup;
      this._premiumPercentItem.visible = !isSetup;
      this._usageSep2.visible = !isSetup;
      this._chatPercentItem.visible = !isSetup;
      this._usageSep3.visible = !isSetup;
      this._footerItem.visible = !isSetup;

      // Shared separator always visible
      this._sharedSep.visible = true;
    }

    // ── Token resolution ──────────────────────────────────────────────

    _refreshUsage() {
      this._panelLabel.set_text("…");
      this._resolveToken();
    }

    async _resolveToken() {
      const home = GLib.get_home_dir();

      // 1) GitHub CLI  ~/.config/gh/hosts.yml
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([home, ".config", "gh", "hosts.yml"]),
          readToken_ghYml,
          /* isJson */ false,
        );
        if (token) return this._fetchUsage(token);
      }

      // 2) Copilot CLI / Neovim / Vim  ~/.config/github-copilot/hosts.json
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "hosts.json",
          ]),
          readToken_hostsJson,
          /* isJson */ true,
        );
        if (token) return this._fetchUsage(token);
      }

      // 3) Copilot apps config  ~/.config/github-copilot/apps.json
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "apps.json",
          ]),
          readToken_appsJson,
          /* isJson */ true,
        );
        if (token) return this._fetchUsage(token);
      }

      // 4) Manual token from extension settings
      {
        const token = this._settings.get_string("github-token").trim();
        if (token) return this._fetchUsage(token);
      }

      // Nothing found – show setup UI
      this._showSetupState(
        "No Copilot credentials found",
        "The extension checked for GitHub CLI, Copilot CLI,\nand Neovim/Vim plugin tokens but found nothing.\n\nOpen Settings to add your GitHub token manually.",
      );
    }

    /**
     * Returns a Promise<string|null> – reads the file and extracts a token.
     * Silently returns null on any error (file missing, parse failure, etc.).
     */
    _readFileToken(filePath, extractFn, isJson) {
      return new Promise((resolve) => {
        const file = Gio.File.new_for_path(filePath);
        file.load_contents_async(null, (_f, result) => {
          try {
            const [, bytes] = _f.load_contents_finish(result);
            const raw = new TextDecoder("utf-8").decode(bytes);
            const token = extractFn(isJson ? JSON.parse(raw) : raw);
            resolve(token ?? null);
          } catch {
            resolve(null);
          }
        });
      });
    }

    // ── API fetch ─────────────────────────────────────────────────────

    _fetchUsage(token) {
      const message = Soup.Message.new("GET", API_URL);
      const h = message.request_headers;
      h.append("Authorization", `token ${token}`);
      h.append("Accept", "application/json");
      h.append("Editor-Version", "vscode/1.96.2");
      h.append("Editor-Plugin-Version", "copilot-chat/0.26.7");
      h.append("User-Agent", "GitHubCopilotChat/0.26.7");
      h.append("X-Github-Api-Version", "2025-04-01");

      this._session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null,
        (_session, result) => {
          try {
            const bytes = _session.send_and_read_finish(result);

            if (message.status_code === 401 || message.status_code === 403) {
              this._showSetupState(
                "Token invalid or expired",
                "The stored GitHub token was rejected by the API.\nPlease update your token in Settings.",
              );
              return;
            }

            if (message.status_code !== 200) {
              this._showNetworkError(`HTTP ${message.status_code}`);
              return;
            }

            const data = JSON.parse(
              new TextDecoder("utf-8").decode(bytes.get_data()),
            );
            this._updateUsageDisplay(data);
          } catch (e) {
            console.error("Copilot Usage: fetch error:", e.message);
            this._showNetworkError(e.message);
          }
        },
      );
    }

    // ── Display helpers ───────────────────────────────────────────────

    _updateUsageDisplay(data) {
      this._setMenuState("usage");

      // Plan
      const plan = data.copilotPlan ?? "unknown";
      this._planLabel.set_text(`Plan: ${this._formatPlan(plan)}`);

      // Premium Interactions
      const premium = data.quotaSnapshots?.premiumInteractions;
      if (premium != null) {
        const used = 100 - (premium.percentRemaining ?? 100);
        this._premiumPercent.set_text(`${used.toFixed(1)} % used`);
        this._updateBar(this._premiumProgressBar, used);
      } else {
        this._premiumPercent.set_text("unlimited");
        this._updateBar(this._premiumProgressBar, 0);
      }

      // Chat
      const chat = data.quotaSnapshots?.chat;
      if (chat != null) {
        const used = 100 - (chat.percentRemaining ?? 100);
        this._chatPercent.set_text(`${used.toFixed(1)} % used`);
        this._updateBar(this._chatProgressBar, used);
      } else {
        this._chatPercent.set_text("unlimited");
        this._updateBar(this._chatProgressBar, 0);
      }

      // Panel label
      const premiumUsed =
        premium != null ? 100 - (premium.percentRemaining ?? 100) : null;
      const chatUsed =
        chat != null ? 100 - (chat.percentRemaining ?? 100) : null;
      const primary = premiumUsed ?? chatUsed;
      this._panelLabel.set_text(
        primary != null ? `${Math.round(primary)} %` : "Copilot",
      );

      // Timestamp
      this._updatedLabel.set_text(
        `Updated: ${new Date().toLocaleTimeString()}`,
      );
    }

    _showSetupState(heading, body) {
      this._setMenuState("setup");
      this._setupHeading.set_text(heading);
      this._setupBody.set_text(body);
      this._panelLabel.set_text("?");
    }

    _showNetworkError(detail) {
      // Keep usage state visible (stale data is still useful) but update footer
      this._panelLabel.set_text("!");
      if (this._updatedLabel) this._updatedLabel.set_text(`Error: ${detail}`);
    }

    _formatPlan(raw) {
      return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Progress bar ──────────────────────────────────────────────────

    _updateBar(bar, pct) {
      const MAX_PX = 220;
      bar.set_width(
        Math.round((Math.min(100, Math.max(0, pct)) / 100) * MAX_PX),
      );

      ["usage-low", "usage-medium", "usage-high", "usage-critical"].forEach(
        (c) => bar.remove_style_class_name(c),
      );

      if (pct >= 90) bar.add_style_class_name("usage-critical");
      else if (pct >= 70) bar.add_style_class_name("usage-high");
      else if (pct >= 40) bar.add_style_class_name("usage-medium");
      else bar.add_style_class_name("usage-low");
    }

    // ── Timer ─────────────────────────────────────────────────────────

    _startTimer() {
      this._stopTimer();
      const interval = this._settings.get_int("refresh-interval");
      if (interval <= 0) return;
      this._timerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          this._refreshUsage();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }

    _stopTimer() {
      if (this._timerId) {
        GLib.source_remove(this._timerId);
        this._timerId = null;
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────

    destroy() {
      this._stopTimer();
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
      if (this._session) {
        this._session.abort();
        this._session = null;
      }
      super.destroy();
    }
  },
);

// ---------------------------------------------------------------------------

export default class CopilotUsageExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._indicator = new CopilotUsageIndicator(this._settings, () =>
      this.openPreferences(),
    );
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
    this._settings = null;
  }
}
