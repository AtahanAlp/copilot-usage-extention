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

const PROGRESS_STYLE_CLASSES = [
  "usage-low",
  "usage-medium",
  "usage-high",
  "usage-critical",
] as const;

const API_URL = "https://api.github.com/copilot_internal/user";

interface TokenSource {
  path: string;
  extract: TokenExtractor;
  isJson: boolean;
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
    declare private _extensionPath: string;
    declare private _session: Soup.Session;
    private _menuState: string | null = null;
    private _timerId: number | null = null;
    private _settingsChangedId: number | null = null;
    private _refreshIntervalChangedId: number | null = null;
    private _menuOpenChangedId: number | null = null;
    private _destroyed = false;
    private _refreshGeneration = 0;
    private _refreshInFlight = false;

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
    declare private _footerItem: PopupMenu.PopupBaseMenuItem;
    declare private _updatedLabel: St.Label;

    // Shared
    declare private _sharedSep: PopupMenu.PopupSeparatorMenuItem;
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
      this._menuOpenChangedId = this._popupMenu.connect(
        "open-state-changed",
        (_menu: unknown, open: boolean): undefined => {
          if (open) this._refreshUsage();
          return undefined;
        },
      );

      // Respond to settings changes
      this._settingsChangedId = this._settings.connect(
        "changed::github-token",
        () => this._refreshUsage(),
      );
      this._refreshIntervalChangedId = this._settings.connect(
        "changed::refresh-interval",
        () => this._startTimer(),
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
      this._buildUsageSection();

      // ── SHARED Settings item ────────────────────────────────────────
      this._sharedSep = new PopupMenu.PopupSeparatorMenuItem();
      this._popupMenu.addMenuItem(this._sharedSep);

      this._settingsItem = new PopupMenu.PopupMenuItem(_("Settings"));
      this._settingsItem.add_style_class_name("copilot-settings-item");
      (this._settingsItem as any).label.add_style_class_name(
        "copilot-settings-label",
      );
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

      return { bar, percentLabel, usedLabel, item };
    }

    private _buildUsageSection(): void {
      this._headerItem = this._createHeaderItem();
      this._popupMenu.addMenuItem(this._headerItem);

      this._premiumResult = this._addUsageRow("Premium Requests");
      this._chatResult = this._addUsageRow("Chat Messages");

      this._footerItem = this._createFooterItem();
      this._popupMenu.addMenuItem(this._footerItem);
    }

    private _createHeaderItem(): PopupMenu.PopupBaseMenuItem {
      const item = new PopupMenu.PopupBaseMenuItem({
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
      item.add_child(headerBox);

      return item;
    }

    private _createFooterItem(): PopupMenu.PopupBaseMenuItem {
      const item = new PopupMenu.PopupBaseMenuItem({
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
      footerBox.add_child(this._createRefreshButton());
      item.add_child(footerBox);

      return item;
    }

    private _createRefreshButton(): St.Button {
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
      return refreshBtn;
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
      }

      // Shared always visible
      this._sharedSep.visible = true;
      this._settingsItem.visible = true;
    }

    private _updateChatVisibility(plan: string | null): void {
      const isLimited =
        plan !== null && CHAT_LIMITED_PLANS.has(plan.toLowerCase());
      this._chatResult.item.visible = isLimited;
    }

    // ── Token resolution ──────────────────────────────────────────────

    private _refreshUsage(): void {
      if (this._destroyed || this._refreshInFlight) return;

      this._refreshInFlight = true;
      const generation = ++this._refreshGeneration;

      void this._resolveToken(generation).finally(() => {
        if (generation === this._refreshGeneration) {
          this._refreshInFlight = false;
        }
      });
    }

    private _isRefreshCurrent(generation: number): boolean {
      return !this._destroyed && generation === this._refreshGeneration;
    }

    private async _resolveToken(generation: number): Promise<void> {
      const token = await this._findToken(generation);
      if (!this._isRefreshCurrent(generation)) return;

      if (token) {
        this._fetchUsage(token, generation);
        return;
      }

      this._showSetupState(
        "GitHub Token Required",
        "No credentials found. Open Settings to add your token.",
      );
    }

    private async _findToken(generation: number): Promise<string | null> {
      const subprocessToken = await this._runSubprocessToken("gh", [
        "auth",
        "token",
      ]);
      if (!this._isRefreshCurrent(generation)) return null;
      if (subprocessToken) return subprocessToken;

      const fileToken = await this._findTokenInFiles(generation);
      if (!this._isRefreshCurrent(generation)) return null;
      if (fileToken) return fileToken;

      const settingsToken = this._settings.get_string("github-token").trim();
      return settingsToken || null;
    }

    private async _findTokenInFiles(
      generation: number,
    ): Promise<string | null> {
      const home = GLib.get_home_dir();
      const sources: TokenSource[] = [
        {
          path: GLib.build_filenamev([home, ".config", "gh", "hosts.yml"]),
          extract: readToken_ghYml,
          isJson: false,
        },
        {
          path: GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "hosts.json",
          ]),
          extract: readToken_hostsJson,
          isJson: true,
        },
        {
          path: GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "apps.json",
          ]),
          extract: readToken_appsJson,
          isJson: true,
        },
        {
          path: GLib.build_filenamev([
            home,
            ".config",
            "github-copilot",
            "oauth.json",
          ]),
          extract: readToken_oauthJson,
          isJson: true,
        },
      ];

      for (const source of sources) {
        const token = await this._readFileToken(
          source.path,
          source.extract,
          source.isJson,
        );
        if (!this._isRefreshCurrent(generation)) return null;
        if (token) return token;
      }

      return null;
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

    private _fetchUsage(token: string, generation: number): void {
      if (!this._isRefreshCurrent(generation)) return;

      const message = this._createApiMessage(token);

      this._session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null,
        (sourceSession: Soup.Session | null, result: Gio.AsyncResult) => {
          if (!sourceSession || !this._isRefreshCurrent(generation)) return;
          try {
            const bytes = sourceSession.send_and_read_finish(result);
            if (!this._isRefreshCurrent(generation)) return;

            const networkError = this._getResponseError(message, bytes);
            if (networkError) {
              networkError();
              return;
            }

            const data = this._parseUsageResponse(bytes);
            if (data) this._updateUsageDisplay(data);
          } catch (e) {
            if (!this._isRefreshCurrent(generation)) return;
            const err = e as Error;
            this._showNetworkError(err.message);
          }
        },
      );
    }

    private _createApiMessage(token: string): Soup.Message {
      const message = Soup.Message.new("GET", API_URL);
      const h = message.request_headers;
      h.append("Authorization", `token ${token}`);
      h.append("Accept", "application/json");
      h.append("Editor-Version", "vscode/1.96.2");
      h.append("Editor-Plugin-Version", "copilot-chat/0.26.7");
      h.append("User-Agent", "GitHubCopilotChat/0.26.7");
      h.append("X-Github-Api-Version", "2025-04-01");
      return message;
    }

    private _getResponseError(
      message: Soup.Message,
      bytes: GLib.Bytes,
    ): (() => void) | null {
      if (message.status_code === 401 || message.status_code === 403) {
        return () =>
          this._showSetupState(
            "Token Invalid or Expired",
            "The stored token was rejected. Update it in Settings.",
          );
      }

      if (message.status_code !== 200) {
        return () => this._showNetworkError(`HTTP ${message.status_code}`);
      }

      if (!bytes.get_data()) {
        return () => this._showNetworkError("Empty response from API");
      }

      return null;
    }

    private _parseUsageResponse(bytes: GLib.Bytes): CopilotUsageData | null {
      const raw = bytes.get_data();
      if (!raw) return null;

      return JSON.parse(
        new TextDecoder("utf-8").decode(raw),
      ) as CopilotUsageData;
    }

    // ── Display helpers ───────────────────────────────────────────────

    private _updateUsageDisplay(data: CopilotUsageData): void {
      const plan = data.copilot_plan ?? data.copilotPlan ?? null;
      const snapshots = data.quota_snapshots ?? data.quotaSnapshots ?? null;
      const premium =
        snapshots?.premium_interactions ??
        snapshots?.premiumInteractions ??
        null;
      const chat = snapshots?.chat ?? null;

      if (!plan && !premium && !chat) {
        this._showSetupState(
          "Copilot Data Unavailable",
          "API returned no usage data. Your token may lack Copilot permissions.",
        );
        return;
      }

      this._setMenuState("usage");
      this._planLabel.set_text(plan ? this._formatPlan(plan) : "");
      this._updateChatVisibility(plan);

      const premR = this._percentRemaining(premium);
      const chatR = this._percentRemaining(chat);

      this._updateUsageRow(this._premiumResult, premR);
      this._updateUsageRow(this._chatResult, chatR);
      this._updateWarningIndicator(premR);
      this._updatedLabel.set_text(this._getUpdatedTimestamp());
    }

    private _percentRemaining(
      snap: QuotaSnapshot | null | undefined,
    ): number | null {
      return snap?.percent_remaining ?? snap?.percentRemaining ?? null;
    }

    private _updateUsageRow(
      row: UsageRowResult,
      remaining: number | null,
    ): void {
      if (remaining !== null) {
        const used = 100 - remaining;
        this._updateBar(row.bar, used);
        row.usedLabel.set_text(`${used.toFixed(1)}%`);
        row.percentLabel.set_text(`${remaining.toFixed(1)}% remaining`);
        return;
      }

      this._updateBar(row.bar, 0);
      row.usedLabel.set_text("unlimited");
      row.percentLabel.set_text("");
    }

    private _updateWarningIndicator(remaining: number | null): void {
      this._warningDot.remove_style_class_name("dot-critical");
      this._warningDot.remove_style_class_name("dot-high");

      if (remaining !== null && remaining <= 10) {
        this._warningDot.visible = true;
        this._warningDot.add_style_class_name(
          remaining <= 0 ? "dot-critical" : "dot-high",
        );
        return;
      }

      this._warningDot.visible = false;
    }

    private _getUpdatedTimestamp(): string {
      const now = new Date();
      const hh = now.getHours().toString().padStart(2, "0");
      const mm = now.getMinutes().toString().padStart(2, "0");
      return `Updated ${hh}:${mm}`;
    }

    private _showSetupState(heading: string, body: string): void {
      this._setMenuState("setup");
      this._setupHeading.set_text(heading);
      this._setupBody.set_text(body);
      this._setWarningState("dot-high");
    }

    private _showNetworkError(detail: string): void {
      if (this._updatedLabel) this._updatedLabel.set_text(`Error: ${detail}`);
      this._setWarningState("dot-high");
    }

    private _setWarningState(styleClass: "dot-high" | "dot-critical"): void {
      this._warningDot.visible = true;
      this._warningDot.remove_style_class_name("dot-critical");
      this._warningDot.remove_style_class_name("dot-high");
      this._warningDot.add_style_class_name(styleClass);
    }

    private _formatPlan(raw: string): string {
      return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Progress bar ──────────────────────────────────────────────────

    private _updateBar(bar: St.Widget, pct: number): void {
      const clampedPct = Math.min(100, Math.max(0, pct));
      bar.set_style(`width: ${clampedPct}%;`);

      PROGRESS_STYLE_CLASSES.forEach((c) => bar.remove_style_class_name(c));

      if (clampedPct >= 85) bar.add_style_class_name("usage-critical");
      else if (clampedPct >= 60) bar.add_style_class_name("usage-high");
      else if (clampedPct >= 30) bar.add_style_class_name("usage-medium");
      else bar.add_style_class_name("usage-low");
    }

    // ── Timer ─────────────────────────────────────────────────────────

    private _startTimer(): void {
      this._stopTimer();
      const interval = this._settings.get_int("refresh-interval");
      if (interval < 30) return;
      this._timerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          if (this._destroyed) return GLib.SOURCE_REMOVE;
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
      this._refreshGeneration++;

      if (this._menuOpenChangedId !== null) {
        this._popupMenu.disconnect(this._menuOpenChangedId);
        this._menuOpenChangedId = null;
      }
      if (this._settingsChangedId !== null) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
      }
      if (this._refreshIntervalChangedId !== null) {
        this._settings.disconnect(this._refreshIntervalChangedId);
        this._refreshIntervalChangedId = null;
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
