NAME    = copilot-usage
DOMAIN  = atahan.github.com
UUID    = $(NAME)@$(DOMAIN)

EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
STAGING = /tmp/$(UUID)-staging

.PHONY: all pack install clean

# ── Default: just compile ─────────────────────────────────────────────────────

all: dist/extension.js

# ── Dependencies ──────────────────────────────────────────────────────────────

node_modules/.modules.yaml: package.json
	pnpm install

dist/extension.js dist/prefs.js: node_modules/.modules.yaml ambient.d.ts *.ts
	pnpm run build

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

# ── Pack: create a distributable zip via a /tmp staging dir ──────────────────
# Staging in /tmp means the project source tree is NEVER touched by zip/unzip.

$(UUID).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@echo "  STAGE   $(STAGING)"
	@rm -rf   $(STAGING)
	@mkdir -p $(STAGING)/schemas
	@cp dist/extension.js dist/prefs.js            $(STAGING)/
	@cp metadata.json stylesheet.css               $(STAGING)/
	@cp schemas/*.xml                              $(STAGING)/schemas/
	@cp schemas/gschemas.compiled                  $(STAGING)/schemas/
	@(cd $(STAGING) && zip -9r $(CURDIR)/$(UUID).zip .)
	@rm -rf $(STAGING)
	@echo "  ZIP     $(UUID).zip"

pack: $(UUID).zip

# ── Install: copy files directly, never call gnome-extensions install ─────────
# Direct copy = no zip round-trip, no gnome-extensions --force wiping things.

install: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@echo "  INSTALL $(EXT_DIR)"
	@mkdir -p $(EXT_DIR)/schemas
	@cp dist/extension.js dist/prefs.js            $(EXT_DIR)/
	@cp metadata.json stylesheet.css               $(EXT_DIR)/
	@cp schemas/*.xml                              $(EXT_DIR)/schemas/
	@glib-compile-schemas                          $(EXT_DIR)/schemas/
	@echo "  DONE    restart GNOME Shell to pick up changes"
	@echo "          (Alt+F2 → r  on X11, or log out/in on Wayland)"

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	@rm -rf dist node_modules $(UUID).zip
	@echo "  CLEAN   done"
