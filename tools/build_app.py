#!/usr/bin/env python3
"""Inline app/style.css, app/lib.js and app/app.js into one publishable HTML page: app/dist/10dreamjobs.html."""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent / "app"
tpl = (root / "template.html").read_text(encoding="utf8")
# lib.js ends with a CommonJS export for tests; the guard makes it inert in the browser.
out = (tpl.replace("/*STYLE*/", (root / "style.css").read_text(encoding="utf8"))
          .replace("/*LIB*/", (root / "lib.js").read_text(encoding="utf8").replace("</script>", "<\\/script>"))
          .replace("/*APP*/", (root / "app.js").read_text(encoding="utf8").replace("</script>", "<\\/script>")))
dist = root / "dist"
dist.mkdir(exist_ok=True)
(dist / "10dreamjobs.html").write_text(out, encoding="utf8")
print(f"built {dist / '10dreamjobs.html'} ({len(out):,} bytes)")
