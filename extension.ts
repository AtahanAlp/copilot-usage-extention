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
  bgBar: St.Widget;
  percentLabel: St.Label;
  usedLabel: St.Label;
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
// Plans that have a hard monthly cap on Chat messages (currently only "free").
// All paid plans (pro, pro+, business, enterprise, …) get unlimited chat.
// ---------------------------------------------------------------------------
const CHAT_LIMITED_PLANS = new Set(["free", "copilot_free", "copilot-free"]);

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
    declare private _extensionPath: string;
    declare private _session: Soup.Session;
    private _menuState: string | null = null;
    private _timerId: number | null = null;
    private _settingsChangedId: number | null = null;
    private _destroyed = false;

    // Panel widget
    declare private _panelIcon: St.Icon;
    declare private _warningDot: St.Widget;

    // Setup state items
    declare private _setupItem: PopupMenu.PopupBaseMenuItem;
    declare private _setupSep: PopupMenu.PopupSeparatorMenuItem;
    declare private _openSettingsItem: PopupMenu.PopupMenuItem;
    declare private _setupHeading: St.Label;
    declare private _setupBody: St.Label;

    // Usage state items
    declare private _headerItem: PopupMenu.PopupBaseMenuItem;
    declare private _planLabel: St.Label;
    declare private _premiumResult: UsageRowResult;
    declare private _chatResult: UsageRowResult;
    declare private _chatSep: PopupMenu.PopupSeparatorMenuItem;
    declare private _footerItem: PopupMenu.PopupBaseMenuItem;
    declare private _updatedLabel: St.Label;

    // Shared
    declare private _settingsItem: PopupMenu.PopupMenuItem;

    private get _popupMenu(): PopupMenu.PopupMenu {
      return this.menu as PopupMenu.PopupMenu;
    }

    // @ts-expect-error - GObject _init takes different params than the base class TS signature
    _init(
      settings: Gio.Settings,
      openPreferences: () => void,
      extensionPath: string,
    ): void {
      super._init(0.0, "Copilot Usage Indicator");

      this._settings = settings;
      this._openPreferences = openPreferences;
      this._extensionPath = extensionPath;
      this._session = new Soup.Session();
      this._menuState = null;

      // ── Panel widget ──────────────────────────────────────────────
      const box = new St.BoxLayout({
        style_class: "panel-status-menu-box",
        y_align: Clutter.ActorAlign.CENTER,
      });

      const iconFile = Gio.File.new_for_path(
        GLib.build_filenamev([
          this._extensionPath,
          "icons",
          "copilot-icon-symbolic.svg",
        ]),
      );
      const gicon = Gio.FileIcon.new(iconFile);
      this._panelIcon = new St.Icon({
        gicon,
        icon_size: 16,
        style_class: "system-status-icon copilot-panel-icon",
      });
      box.add_child(this._panelIcon);

      // Small warning dot – shown for error/setup states
      this._warningDot = new St.Widget({
        style_class: "copilot-warning-dot",
        visible: false,
      });
      box.add_child(this._warningDot);

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
      // ── SETUP STATE ────────────────────────────────────────────────

      this._setupItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const setupBox = new St.BoxLayout({
        style_class: "copilot-setup-box",
        vertical: true,
      });

      this._setupHeading = new St.Label({
        text: "GitHub Token Required",
        style_class: "copilot-setup-heading",
      });
      setupBox.add_child(this._setupHeading);

      this._setupBody = new St.Label({
        text: "No credentials found. Open Settings to add your token.",
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

      // ── USAGE STATE ────────────────────────────────────────────────

      // Header row: "Copilot Usage" title + plan badge
      this._headerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const headerBox = new St.BoxLayout({
        style_class: "copilot-header-box",
        vertical: false,
      });
      const headerTitle = new St.Label({
        text: "Copilot Usage",
        style_class: "copilot-header-title",
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      this._planLabel = new St.Label({
        text: "",
        style_class: "copilot-plan-badge",
        y_align: Clutter.ActorAlign.CENTER,
      });
      headerBox.add_child(headerTitle);
      headerBox.add_child(this._planLabel);
      this._headerItem.add_child(headerBox);
      this._popupMenu.addMenuItem(this._headerItem);

      // Premium Requests row
      this._premiumResult = this._addUsageRow("Premium Requests");

      // Chat row (only shown for free plan)
      this._chatSep = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._chatSep);
      this._chatResult = this._addUsageRow("Chat Messages");

      // Footer row: timestamp + inline refresh button
      this._footerItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const footerBox = new St.BoxLayout({
        style_class: "copilot-footer-box",
        vertical: false,
      });
      this._updatedLabel = new St.Label({
        text: "Not yet refreshed",
        style_class: "copilot-updated-label",
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      footerBox.add_child(this._updatedLabel);

      // Inline refresh icon button
      const refreshBtn = new St.Button({
        style_class: "copilot-refresh-btn",
        child: new St.Icon({
          icon_name: "view-refresh-symbolic",
          style_class: "copilot-refresh-icon",
        }),
        reactive: true,
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      refreshBtn.connect("clicked", () => this._refreshUsage());
      footerBox.add_child(refreshBtn);
      this._footerItem.add_child(footerBox);
      this._popupMenu.addMenuItem(this._footerItem);

      // ── SHARED Settings item ────────────────────────────────────────

      this._settingsItem = new PopupMenu.PopupMenuItem(_("Settings"));
      this._settingsItem.add_style_class_name("copilot-settings-item");
      this._settingsItem.connect("activate", () => this._openPreferences());
      this._popupMenu.addMenuItem(this._settingsItem);

      // Start in setup state until we know better
      this._setMenuState("setup");
    }

    /**
     * Adds a titled progress-bar row and returns handles to its dynamic parts.
     * Layout:
     *   [ Title label            used-label ]
     *   [ ████████░░░░░░░░░░░░  percent-label ]
     */
    private _addUsageRow(title: string): UsageRowResult {
      const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      const section = new St.BoxLayout({
        style_class: "copilot-usage-section",
        vertical: true,
      });

      // Header row: title + used absolute label
      const header = new St.BoxLayout({
        style_class: "copilot-row-header",
        vertical: false,
      });
      header.add_child(
        new St.Label({ text: title, style_class: "copilot-section-title" }),
      );
      const usedLabel = new St.Label({
        text: "",
        style_class: "copilot-used-label",
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      });
      header.add_child(usedLabel);
      section.add_child(header);

      // Progress bar track
      const bg = new St.Widget({ style_class: "copilot-progress-bg" });
      const bar = new St.Widget({
        style_class: "copilot-progress-bar usage-low",
      });
      bg.add_child(bar);
      section.add_child(bg);

      // Sub-footer: "X% used" left, "Y remaining" right
      const subFooter = new St.BoxLayout({
        style_class: "copilot-row-subfooter",
        vertical: false,
      });
      const percentLabel = new St.Label({
        text: "",
        style_class: "copilot-percent-label",
        x_expand: true,
      });
      subFooter.add_child(percentLabel);
      section.add_child(subFooter);

      item.add_child(section);
      this._popupMenu.addMenuItem(item);

      return { bar, bgBar: bg, percentLabel, usedLabel, item };
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
      this._headerItem.visible = !isSetup;
      this._premiumResult.item.visible = !isSetup;
      this._footerItem.visible = !isSetup;

      // Chat row visibility controlled separately by _updateChatVisibility()
      // Default hidden; shown only when plan is free
      if (isSetup) {
        this._chatResult.item.visible = false;
        this._chatSep.visible = false;
      }

      // Shared always visible
      this._settingsItem.visible = true;
    }

    private _updateChatVisibility(plan: string | null): void {
      const isLimited =
        plan !== null && CHAT_LIMITED_PLANS.has(plan.toLowerCase());
      this._chatResult.item.visible = isLimited;
      this._chatSep.visible = isLimited;
    }

    // ── Token resolution ──────────────────────────────────────────────

    private _refreshUsage(): void {
      this._resolveToken();
    }

    private async _resolveToken(): Promise<void> {
      const home = GLib.get_home_dir();

      // 1) GitHub CLI via subprocess
      {
        const token = await this._runSubprocessToken("gh", ["auth", "token"]);
        if (this._destroyed) return;
        if (token) return this._fetchUsage(token);
      }

      // 2) GitHub CLI hosts.yml (legacy)
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
        "GitHub Token Required",
        "No credentials found. Open Settings to add your token.",
      );
    }

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
                "Token Invalid or Expired",
                "The stored token was rejected. Update it in Settings.",
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
          "Full response:",
          JSON.stringify(data),
        );
        this._showSetupState(
          "Copilot Data Unavailable",
          "API returned no usage data. Your token may lack Copilot permissions.",
        );
        return;
      }

      this._setMenuState("usage");

      // Plan badge
      this._planLabel.set_text(plan ? this._formatPlan(plan) : "");

      // Decide chat visibility based on plan
      this._updateChatVisibility(plan);

      const pctRemaining = (
        snap: QuotaSnapshot | null | undefined,
      ): number | null =>
        snap?.percent_remaining ?? snap?.percentRemaining ?? null;

      // Premium Requests
      const premR = pctRemaining(premium);
      if (premR !== null) {
        const used = 100 - premR;
        this._updateBar(this._premiumResult.bar, used);
        this._premiumResult.usedLabel.set_text(`${Math.round(used)}%`);
        this._premiumResult.percentLabel.set_text(
          `${premR.toFixed(0)}% remaining`,
        );
      } else {
        this._updateBar(this._premiumResult.bar, 0);
        this._premiumResult.usedLabel.set_text("unlimited");
        this._premiumResult.percentLabel.set_text("");
      }

      // Chat (only rendered when plan is free, but update values always)
      const chatR = pctRemaining(chat);
      if (chatR !== null) {
        const used = 100 - chatR;
        this._updateBar(this._chatResult.bar, used);
        this._chatResult.usedLabel.set_text(`${Math.round(used)}%`);
        this._chatResult.percentLabel.set_text(
          `${chatR.toFixed(0)}% remaining`,
        );
      } else {
        this._updateBar(this._chatResult.bar, 0);
        this._chatResult.usedLabel.set_text("unlimited");
        this._chatResult.percentLabel.set_text("");
      }

      // Panel icon — use warning dot only when premium is nearly exhausted
      if (premR !== null && premR <= 10) {
        this._warningDot.visible = true;
        this._warningDot.add_style_class_name(
          premR <= 0 ? "dot-critical" : "dot-high",
        );
      } else {
        this._warningDot.visible = false;
        this._warningDot.remove_style_class_name("dot-critical");
        this._warningDot.remove_style_class_name("dot-high");
      }

      // Timestamp – HH:MM only
      const now = new Date();
      const hh = now.getHours().toString().padStart(2, "0");
      const mm = now.getMinutes().toString().padStart(2, "0");
      this._updatedLabel.set_text(`Updated ${hh}:${mm}`);
    }

    private _showSetupState(heading: string, body: string): void {
      this._setMenuState("setup");
      this._setupHeading.set_text(heading);
      this._setupBody.set_text(body);
      this._warningDot.visible = true;
      this._warningDot.remove_style_class_name("dot-critical");
      this._warningDot.add_style_class_name("dot-high");
    }

    private _showNetworkError(detail: string): void {
      if (this._updatedLabel) this._updatedLabel.set_text(`Error: ${detail}`);
      this._warningDot.visible = true;
      this._warningDot.remove_style_class_name("dot-critical");
      this._warningDot.add_style_class_name("dot-high");
    }

    private _formatPlan(raw: string): string {
      return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Progress bar ──────────────────────────────────────────────────

    private _updateBar(bar: St.Widget, pct: number): void {
      // The bar width is calculated as a fraction of the track's allocated
      // width. We defer to CSS min-width on the bg to determine the base size,
      // and use a style property here so it scales correctly.
      const clampedPct = Math.min(100, Math.max(0, pct));

      // Write the fill percentage as a custom CSS-driven width via inline style.
      // We use a fixed pixel base matching .copilot-progress-bg min-width (260px)
      // minus the horizontal padding (8px each side) = 244px track width.
      const TRACK_PX = 244;
      bar.set_width(Math.round((clampedPct / 100) * TRACK_PX));

      (
        ["usage-low", "usage-medium", "usage-high", "usage-critical"] as const
      ).forEach((c) => bar.remove_style_class_name(c));

      if (clampedPct >= 90) bar.add_style_class_name("usage-critical");
      else if (clampedPct >= 70) bar.add_style_class_name("usage-high");
      else if (clampedPct >= 40) bar.add_style_class_name("usage-medium");
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

type CopilotUsageIndicatorInstance = InstanceType<typeof CopilotUsageIndicator>;

export default class CopilotUsageExtension extends Extension {
  private _indicator: CopilotUsageIndicatorInstance | null = null;
  private _settings: Gio.Settings | null = null;

  override enable(): void {
    this._settings = this.getSettings();
    this._indicator = new CopilotUsageIndicator(
      // @ts-expect-error - GObject registered class constructor maps to _init
      this._settings,
      () => this.openPreferences(),
      this.path,
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
