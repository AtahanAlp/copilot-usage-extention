NAME=copilot-usage
DOMAIN=atahan.github.com
UUID=$(NAME)@$(DOMAIN)

.PHONY: all pack install clean

all: dist/extension.js

node_modules/.modules.yaml: package.json
	pnpm install

dist/extension.js dist/prefs.js: node_modules/.modules.yaml ambient.d.ts *.ts
	pnpm run build

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(UUID).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@cp -r schemas dist/
	@cp metadata.json dist/
	@cp stylesheet.css dist/
	@(cd dist && zip ../$(UUID).zip -9r .)

pack: $(UUID).zip

install: $(UUID).zip
	gnome-extensions install --force $(UUID).zip

clean:
	@rm -rf dist node_modules $(UUID).zip
