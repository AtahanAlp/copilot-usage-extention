/* extension.ts
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

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface QuotaSnapshot {
  percent_remaining?: number;
  percentRemaining?: number;
}

interface QuotaSnapshots {
  premium_interactions?: QuotaSnapshot;
  premiumInteractions?: QuotaSnapshot;
  chat?: QuotaSnapshot;
}

interface CopilotUsageData {
  copilot_plan?: string;
  copilotPlan?: string;
  quota_snapshots?: QuotaSnapshots;
  quotaSnapshots?: QuotaSnapshots;
}

// ---------------------------------------------------------------------------
// Usage row result type
// ---------------------------------------------------------------------------

interface UsageRowResult {
  bar: St.Widget;
  percentLabel: St.Label;
  item: PopupMenu.PopupBaseMenuItem;
}

// ---------------------------------------------------------------------------
// Token discovery helpers
// ---------------------------------------------------------------------------

type TokenExtractor = (content: unknown) => string | null;

function readToken_hostsJson(content: unknown): string | null {
  const data = content as Record<
    string,
    { oauth_token?: string } | undefined
  > | null;
  return data?.["github.com"]?.oauth_token ?? null;
}

function readToken_appsJson(content: unknown): string | null {
  const data = content as Record<
    string,
    { oauth_token?: string } | undefined
  > | null;
  if (data == null) return null;
  for (const key of Object.keys(data)) {
    const t = data[key]?.oauth_token;
    if (t) return t;
  }
  return null;
}

/**
 * VS Code / newer Copilot extensions store tokens in oauth.json.
 * Structure: { "https://github.com/login/oauth": [{ "accessToken": "..." }] }
 */
function readToken_oauthJson(content: unknown): string | null {
  const data = content as Record<
    string,
    Array<{ accessToken?: string }> | undefined
  > | null;
  if (data == null) return null;
  for (const key of Object.keys(data)) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry?.accessToken) return entry.accessToken;
    }
  }
  return null;
}

/**
 * GitHub CLI stores tokens in a simple YAML – parse with a regex.
 * NOTE: newer gh versions store the token in the system keyring and omit
 * oauth_token from hosts.yml entirely. This parser handles the legacy case;
 * the preferred path is the `gh auth token` subprocess call.
 */
function readToken_ghYml(content: unknown): string | null {
  const match = (content as string).match(/oauth_token:\s*(\S+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Panel indicator
// ---------------------------------------------------------------------------

const CopilotUsageIndicator = GObject.registerClass(
  class CopilotUsageIndicator extends PanelMenu.Button {
    // ── Field declarations ────────────────────────────────────────────
    // IMPORTANT: Use `declare` (not `field!: Type`) for all fields that are
    // assigned in _init().  In GJS with GObject.registerClass, class-field
    // initialisers run *after* _init() returns.  A bare `field;` declaration
    // (what `field!: Type` compiles to) resets the field to `undefined` at
    // that point, wiping every value _init() wrote.  `declare` is type-only
    // and emits no JavaScript, so it never interferes with _init().
    declare private _settings: Gio.Settings;
    declare private _openPreferences: () => void;
    declare private _session: Soup.Session;
    private _menuState: string | null = null;
    private _timerId: number | null = null;
    private _settingsChangedId: number | null = null;
    // Becomes `false` via the class-field initialiser (runs after _init, which
    // is fine because _init never sets _destroyed).
    private _destroyed = false;

    // Panel widget
    declare private _panelLabel: St.Label;

    // Setup state items
    declare private _setupItem: PopupMenu.PopupBaseMenuItem;
    declare private _setupSep: PopupMenu.PopupSeparatorMenuItem;
    declare private _openSettingsItem: PopupMenu.PopupMenuItem;
    declare private _setupHeading: St.Label;
    declare private _setupBody: St.Label;

    // Usage state items
    declare private _planItem: PopupMenu.PopupBaseMenuItem;
    declare private _planLabel: St.Label;
    declare private _usageSep1: PopupMenu.PopupSeparatorMenuItem;
    declare private _usageSep2: PopupMenu.PopupSeparatorMenuItem;
    declare private _usageSep3: PopupMenu.PopupSeparatorMenuItem;
    declare private _premiumProgressBar: St.Widget;
    declare private _premiumPercent: St.Label;
    declare private _premiumPercentItem: PopupMenu.PopupBaseMenuItem;
    declare private _chatProgressBar: St.Widget;
    declare private _chatPercent: St.Label;
    declare private _chatPercentItem: PopupMenu.PopupBaseMenuItem;
    declare private _footerItem: PopupMenu.PopupBaseMenuItem;
    declare private _updatedLabel: St.Label;

    // Shared
    declare private _sharedSep: PopupMenu.PopupSeparatorMenuItem;

    // Convenience accessor that narrows the menu union to PopupMenu.PopupMenu
    private get _popupMenu(): PopupMenu.PopupMenu {
      return this.menu as PopupMenu.PopupMenu;
    }

    // @ts-expect-error - GObject _init takes different params than the base class TS signature
    _init(settings: Gio.Settings, openPreferences: () => void): void {
      super._init(0.0, "Copilot Usage Indicator");

      this._settings = settings;
      this._openPreferences = openPreferences;
      this._session = new Soup.Session();
      this._menuState = null;

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
      this._popupMenu.connect(
        "open-state-changed",
        (_menu: unknown, open: boolean): undefined => {
          if (open) this._refreshUsage();
          return undefined;
        },
      );

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

    private _buildMenu(): void {
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
      this._popupMenu.addMenuItem(this._setupItem);

      this._setupSep = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._setupSep);

      this._openSettingsItem = new PopupMenu.PopupMenuItem(_("Open Settings"));
      this._openSettingsItem.connect("activate", () => {
        this._openPreferences();
      });
      this._popupMenu.addMenuItem(this._openSettingsItem);

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
      this._popupMenu.addMenuItem(this._planItem);

      this._usageSep1 = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._usageSep1);

      // Premium Interactions row
      const premiumResult = this._addUsageRow("Premium Interactions");
      this._premiumProgressBar = premiumResult.bar;
      this._premiumPercent = premiumResult.percentLabel;
      this._premiumPercentItem = premiumResult.item;

      this._usageSep2 = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._usageSep2);

      // Chat row
      const chatResult = this._addUsageRow("Chat");
      this._chatProgressBar = chatResult.bar;
      this._chatPercent = chatResult.percentLabel;
      this._chatPercentItem = chatResult.item;

      this._usageSep3 = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._usageSep3);

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
      this._popupMenu.addMenuItem(this._footerItem);

      // === SHARED items ===============================================

      this._sharedSep = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._sharedSep);

      const refreshItem = new PopupMenu.PopupMenuItem(_("Refresh"));
      refreshItem.connect("activate", () => this._refreshUsage());
      this._popupMenu.addMenuItem(refreshItem);

      // Start in setup state until we know better
      this._setMenuState("setup");
    }

    /** Adds a titled progress-bar row and returns the bar, label and item. */
    private _addUsageRow(title: string): UsageRowResult {
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
      const percentLabel = new St.Label({
        text: "…",
        style_class: "copilot-percent-label",
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
      });
      header.add_child(percentLabel);
      section.add_child(header);

      const bg = new St.Widget({ style_class: "copilot-progress-bg" });
      const bar = new St.Widget({
        style_class: "copilot-progress-bar usage-low",
      });
      bg.add_child(bar);
      section.add_child(bg);

      item.add_child(section);
      this._popupMenu.addMenuItem(item);

      return { bar, percentLabel, item };
    }

    // ── State switching ───────────────────────────────────────────────

    private _setMenuState(state: string): void {
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

    private _refreshUsage(): void {
      this._panelLabel.set_text("…");
      this._resolveToken();
    }

    private async _resolveToken(): Promise<void> {
      const home = GLib.get_home_dir();

      // 1) GitHub CLI via subprocess – works even when gh stores the token in
      //    the system keyring (newer gh versions no longer write oauth_token to
      //    hosts.yml, so the file-based YAML parser below is a legacy fallback).
      {
        const token = await this._runSubprocessToken("gh", ["auth", "token"]);
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 2) GitHub CLI hosts.yml (legacy – older gh versions that wrote the
      //    token directly to the file)
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([home, ".config", "gh", "hosts.yml"]),
          readToken_ghYml,
          false,
        );
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 3) Copilot CLI / Neovim / Vim  ~/.config/github-copilot/hosts.json
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "hosts.json",
          ]),
          readToken_hostsJson,
          true,
        );
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 4) Copilot apps config  ~/.config/github-copilot/apps.json
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "apps.json",
          ]),
          readToken_appsJson,
          true,
        );
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 5) VS Code / newer Copilot extension  ~/.config/github-copilot/oauth.json
      {
        const token = await this._readFileToken(
          GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "oauth.json",
          ]),
          readToken_oauthJson,
          true,
        );
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 6) Manual token from extension settings
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
     * Spawns an external command and returns the first non-empty line of its
     * stdout, or null on any error (command not found, non-zero exit, etc.).
     */
    private _runSubprocessToken(
      argv0: string,
      args: string[],
    ): Promise<string | null> {
      return new Promise((resolve) => {
        try {
          const proc = Gio.Subprocess.new(
            [argv0, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE |
              Gio.SubprocessFlags.STDERR_SILENCE,
          );
          proc.communicate_utf8_async(
            null,
            null,
            (_proc: Gio.Subprocess | null, result: Gio.AsyncResult) => {
              try {
                const [, stdout] = proc.communicate_utf8_finish(result);
                const token = stdout?.trim() ?? null;
                resolve(token || null);
              } catch {
                resolve(null);
              }
            },
          );
        } catch {
          resolve(null);
        }
      });
    }

    /**
     * Reads a file and extracts a token via the provided extractor function.
     * Silently returns null on any error (file missing, parse failure, etc.).
     */
    private _readFileToken(
      filePath: string,
      extractFn: TokenExtractor,
      isJson: boolean,
    ): Promise<string | null> {
      return new Promise((resolve) => {
        const file = Gio.File.new_for_path(filePath);
        file.load_contents_async(
          null,
          (sourceObject: Gio.File | null, result: Gio.AsyncResult) => {
            if (!sourceObject) return resolve(null);
            try {
              const [, bytes] = sourceObject.load_contents_finish(result);
              const raw = new TextDecoder("utf-8").decode(bytes);
              const token = extractFn(isJson ? JSON.parse(raw) : raw);
              resolve(token ?? null);
            } catch {
              resolve(null);
            }
          },
        );
      });
    }

    // ── API fetch ─────────────────────────────────────────────────────

    private _fetchUsage(token: string): void {
      const API_URL = "https://api.github.com/copilot_internal/user";
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
        (sourceSession: Soup.Session | null, result: Gio.AsyncResult) => {
          if (!sourceSession) return;
          try {
            const bytes = sourceSession.send_and_read_finish(result);

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

            const raw = bytes.get_data();
            if (!raw) {
              this._showNetworkError("Empty response from API");
              return;
            }

            const data = JSON.parse(
              new TextDecoder("utf-8").decode(raw),
            ) as CopilotUsageData;
            this._updateUsageDisplay(data);
          } catch (e) {
            const err = e as Error;
            console.error("Copilot Usage: fetch error:", err.message);
            this._showNetworkError(err.message);
          }
        },
      );
    }

    // ── Display helpers ───────────────────────────────────────────────

    private _updateUsageDisplay(data: CopilotUsageData): void {
      console.log("Copilot Usage: raw API response →", JSON.stringify(data));

      const plan = data.copilot_plan ?? data.copilotPlan ?? null;
      const snapshots = data.quota_snapshots ?? data.quotaSnapshots ?? null;
      const premium =
        snapshots?.premium_interactions ??
        snapshots?.premiumInteractions ??
        null;
      const chat = snapshots?.chat ?? null;

      if (!plan && !premium && !chat) {
        console.warn(
          "Copilot Usage: response has no plan/quota fields.",
          "Token may lack Copilot permissions.",
          "Full response:",
          JSON.stringify(data),
        );
        this._showSetupState(
          "Copilot data unavailable",
          "The API returned a response but no usage data was found.\n\n" +
            "Your token may not have Copilot permissions.\n" +
            "Try: gh auth refresh -s read:user\nor add a fresh token in Settings.",
        );
        return;
      }

      this._setMenuState("usage");

      // Plan label
      this._planLabel.set_text(
        `Plan: ${plan ? this._formatPlan(plan) : "Unknown"}`,
      );

      const pctRemaining = (
        snap: QuotaSnapshot | null | undefined,
      ): number | null =>
        snap?.percent_remaining ?? snap?.percentRemaining ?? null;

      // Premium Interactions
      const premR = pctRemaining(premium);
      if (premR !== null) {
        const used = 100 - premR;
        this._premiumPercent.set_text(`${used.toFixed(1)} % used`);
        this._updateBar(this._premiumProgressBar, used);
      } else {
        this._premiumPercent.set_text("unlimited");
        this._updateBar(this._premiumProgressBar, 0);
      }

      // Chat
      const chatR = pctRemaining(chat);
      if (chatR !== null) {
        const used = 100 - chatR;
        this._chatPercent.set_text(`${used.toFixed(1)} % used`);
        this._updateBar(this._chatProgressBar, used);
      } else {
        this._chatPercent.set_text("unlimited");
        this._updateBar(this._chatProgressBar, 0);
      }

      // Panel label – prefer premium, fall back to chat
      const primaryUsed =
        premR !== null ? 100 - premR : chatR !== null ? 100 - chatR : null;
      this._panelLabel.set_text(
        primaryUsed !== null ? `${Math.round(primaryUsed)} %` : "Copilot",
      );

      this._updatedLabel.set_text(
        `Updated: ${new Date().toLocaleTimeString()}`,
      );
    }

    private _showSetupState(heading: string, body: string): void {
      this._setMenuState("setup");
      this._setupHeading.set_text(heading);
      this._setupBody.set_text(body);
      this._panelLabel.set_text("?");
    }

    private _showNetworkError(detail: string): void {
      this._panelLabel.set_text("!");
      if (this._updatedLabel) this._updatedLabel.set_text(`Error: ${detail}`);
    }

    private _formatPlan(raw: string): string {
      return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Progress bar ──────────────────────────────────────────────────

    private _updateBar(bar: St.Widget, pct: number): void {
      const MAX_PX = 220;
      bar.set_width(
        Math.round((Math.min(100, Math.max(0, pct)) / 100) * MAX_PX),
      );

      (
        ["usage-low", "usage-medium", "usage-high", "usage-critical"] as const
      ).forEach((c) => bar.remove_style_class_name(c));

      if (pct >= 90) bar.add_style_class_name("usage-critical");
      else if (pct >= 70) bar.add_style_class_name("usage-high");
      else if (pct >= 40) bar.add_style_class_name("usage-medium");
      else bar.add_style_class_name("usage-low");
    }

    // ── Timer ─────────────────────────────────────────────────────────

    private _startTimer(): void {
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

    private _stopTimer(): void {
      if (this._timerId !== null) {
        GLib.source_remove(this._timerId);
        this._timerId = null;
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────

    override destroy(): void {
      // Signal all in-flight async operations to bail out immediately.
      this._destroyed = true;
      this._stopTimer();
      if (this._settingsChangedId !== null) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
      if (this._session) {
        this._session.abort();
      }
      super.destroy();
    }
  },
);

// Type alias for instances of the registered indicator class
type CopilotUsageIndicatorInstance = InstanceType<typeof CopilotUsageIndicator>;

// ---------------------------------------------------------------------------

export default class CopilotUsageExtension extends Extension {
  private _indicator: CopilotUsageIndicatorInstance | null = null;
  private _settings: Gio.Settings | null = null;

  override enable(): void {
    this._settings = this.getSettings();
    // @ts-expect-error - GObject registered class constructor maps to _init
    this._indicator = new CopilotUsageIndicator(this._settings, () =>
      this.openPreferences(),
    ) as CopilotUsageIndicatorInstance;
    Main.panel.addToStatusArea(
      this.uuid,
      this._indicator as unknown as PanelMenu.Button,
    );
  }

  override disable(): void {
    this._indicator?.destroy();
    this._indicator = null;
    this._settings = null;
  }
}
